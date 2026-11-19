import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import { configFromEnv, start } from '../server.mjs';
import { SpareGlasses, displayCommand, fitBytes, rowHeights, spokenText, wrap } from '../lib/spare.mjs';
import { ClaudeObserver } from '../lib/claude-observer.mjs';
import { State } from '../lib/state.mjs';

const root = new URL('../spare/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('app.json', root), 'utf8'));
const source = await readFile(new URL('main.ss', root), 'utf8');
const bytes = (value) => Buffer.byteLength(String(value));
// image(el, n) numbers the pictures in spare/assets/ by sorted file name, as the compiler does.
const assets = (await readdir(new URL('assets/', root))).filter((name) => name.endsWith('.png')).sort();

/* ---------- manifest ---------- */

test('manifest stays inside the documented lens, data-table and request limits', () => {
  assert.deepEqual(manifest.permissions, ['agent', 'microphone']);
  assert.ok(bytes(manifest.name) <= 23);
  assert.equal(manifest.ui.length, 45, 'seven agent icons, no status marks, a clock for 总管\'s page');
  const names = new Set(manifest.requests.map(({ name }) => name));
  for (const node of manifest.ui) {
    assert.ok(!names.has(node.id), node.id + ' is also a request name');
    assert.ok(node.x >= 0 && node.x + node.w <= 540, node.id + ' is wider than the lens');
    assert.ok(node.y >= 0 && node.y + node.h <= 195, node.id + ' is below y 195');
    if (node.type === 'text') assert.ok(node.size >= 12 && node.size <= 96 && bytes(node.text) <= 63);
  }
  const keys = new Set(['tx', 'st']); // what dictation returns
  for (const request of manifest.requests) {
    assert.ok(['agent', 'dictate'].includes(request.kind));
    if (request.kind !== 'agent') continue;
    // spare.cool/io/agent §15.1: relative path, letters, digits, - . _ ~ / ? = & and {arg}
    assert.match(request.path, /^(?!\/)(?:[A-Za-z0-9\-._~/?=&]|\{arg\})+$/);
    assert.doesNotMatch(request.path, /\.\./);
    if (request.voice) assert.equal(request.method, 'POST');
    for (const key of Object.keys(request.fields)) keys.add(key);
  }
  // The gateway's push writes what standby polls; those keys must already be in the table.
  for (const key of ['g', 'v', 'st', 'h', '_err']) assert.ok(keys.has(key), 'push key ' + key + ' is not declared');
  // The workshop build counts _err once more on top of a mapped one (build #25 refused 25).
  assert.ok(keys.size + 1 <= 24, 'glasses data table holds 24 keys, manifest uses ' + (keys.size + 1));
  assert.ok([...source.matchAll(/^(?:persist )?var \w+/gm)].length <= 64, 'SpareScript allows 64 globals');
  // spac refused 64 (build #31): it counts one of its own, so the script gets 63.
  assert.ok([...source.matchAll(/^(?:fn|on) \w+/gm)].length <= 63, 'spac allows 63 functions, events included');
  assert.equal(new Set(manifest.ui.filter(({ type }) => type === 'image').map(({ src }) => src)).size > 0, true);
});

/* ---------- glasses script, run with stubbed built-ins ---------- */

// The simulator fills an outline-only rect once its brightness or opacity changes at run time.
const outlines = new Set(manifest.ui.filter((node) => node.type === 'rect' && node.border > 0).map(({ id }) => id));

function glasses() {
  const view = new Map(manifest.ui.map((node) => [node.id, { text: node.text ?? '', shown: !node.hidden, gray: node.gray,
    x: node.x, y: node.y, w: node.w, h: node.h }]));
  const ids = Object.fromEntries(manifest.ui.map(({ id }, index) => [id, index]));
  const requestIds = Object.fromEntries(manifest.requests.map(({ name }, index) => [name, 100 + index]));
  const requestNames = Object.fromEntries(Object.entries(requestIds).map(([name, id]) => [id, name]));
  const sent = [];
  const timers = new Map();
  const runtime = { clock: 10000, online: true, record: {}, seq: 0, phoneAt: -Infinity, slid: [], faded: [], battery: 90 };
  const element = (id) => {
    const name = manifest.ui[id]?.id;
    assert.ok(name, 'unknown element ' + id);
    return view.get(name);
  };
  const notOutline = (id, what) => assert.ok(!outlines.has(manifest.ui[id].id), what + ' on outline ' + manifest.ui[id].id);
  const subBytes = (text, start, length) => {
    const buffer = Buffer.from(String(text));
    let from = Math.max(0, start);
    while (from < buffer.length && (buffer[from] & 0xc0) === 0x80) from++;
    let to = Math.min(buffer.length, from + length);
    while (to > from && to < buffer.length && (buffer[to] & 0xc0) === 0x80) to--;
    return buffer.subarray(from, to).toString();
  };
  let calls = 0;
  const ui = (fn) => (...args) => { calls++; return fn(...args); };
  const mock = {
    ...ids, ...requestIds,
    text: ui((id, value) => {
      assert.equal(manifest.ui[id].type, 'text', 'text() on ' + manifest.ui[id].id);
      assert.ok(bytes(value) <= 63, 'text over 63 bytes: ' + value);
      element(id).text = String(value);
    }),
    show: ui((id, on) => { element(id).shown = !!on; }),
    gray: ui((id, value) => { notOutline(id, 'gray()'); element(id).gray = value; }),
    move: ui((id, x, y) => { Object.assign(element(id), { x, y }); }),
    size: ui((id, w, h) => {
      assert.ok(element(id).x + w <= 540 && element(id).y + h <= 195, manifest.ui[id].id + ' leaves the lens');
      Object.assign(element(id), { w, h });
    }),
    image: ui((id, n) => {
      assert.equal(manifest.ui[id].type, 'image', 'image() on ' + manifest.ui[id].id);
      assert.ok(Number.isInteger(n) && n >= 0 && n < assets.length, 'no picture ' + n);
      element(id).img = n;
    }),
    anim_opa: (id, from, to, ms) => { notOutline(id, 'anim_opa()'); assert.ok(ms <= 2000); runtime.faded.push(manifest.ui[id].id); },
    anim_scale: (id, from, to, ms) => { notOutline(id, 'anim_scale()'); assert.ok(ms <= 2000); },
    anim_x: (id, from, to, ms) => { assert.ok(ms <= 2000); runtime.slid.push(manifest.ui[id].id); },
    data: (key) => String(runtime.record[key] ?? ''),
    connected: () => runtime.online,
    now: () => runtime.clock,
    clock: () => Math.floor(runtime.clock / 60000) % 1440,
    seconds: () => Math.floor(runtime.clock / 1000) % 60,
    battery: () => runtime.battery,
    pad: (value, n) => String(Math.trunc(value)).padStart(n, '0'),
    request: (id, arg) => {
      if (!runtime.online) return 0;
      assert.ok(bytes(arg) <= 10, 'argument over 10 bytes: ' + arg);
      if (requestNames[id] !== 'q_mic') {
        assert.ok(runtime.clock - runtime.phoneAt >= 1000, 'two requests within a second');
        runtime.phoneAt = runtime.clock;
      }
      const seq = ++runtime.seq;
      sent.push({ name: requestNames[id], arg: String(arg), at: runtime.clock, seq });
      return seq;
    },
    timer: (id, ms, repeat) => {
      assert.ok(id >= 0 && id <= 3 && (ms === 0 || ms >= 100), 'timer ' + id + ' at ' + ms + ' ms');
      if (ms > 0) timers.set(id, { ms, repeat, due: runtime.clock + ms }); else timers.delete(id);
    },
    num: (value) => Number.parseInt(value, 10) || 0,
    str: (value) => String(value),
    len: (value) => bytes(value),
    sub: subBytes,
    max: Math.max, min: Math.min, clamp: (x, low, high) => Math.max(low, Math.min(x, high)),
  };
  // Translate SpareScript's few differences from JavaScript; firmware compilation is checked by spac and the cloud build.
  const script = source.replace(/\bpersist var\b/g, 'var').replace(/\bfn /g, 'function ')
    .replace(/^on (\w+)\(/gm, 'function event_$1(');
  runInNewContext(script, mock, { timeout: 500 });
  // Every event must stay under the firmware's 256 interface calls.
  for (const name of Object.keys(mock).filter((key) => key.startsWith('event_'))) {
    const handler = mock[name];
    mock[name] = (...args) => { calls = 0; handler(...args); assert.ok(calls <= 256, name + ' made ' + calls + ' interface calls'); };
  }
  const shown = (id) => (view.get(id).shown ? view.get(id).text : null);
  const node = (id) => view.get(id);
  // A reply answers the newest request unless a sequence number says otherwise (0 is the gateway's push).
  // A spoken message goes out from the phone only when the recording ends, so the phone's once-a-second limit
  // counts it as late as its reply.
  // The phone keeps one data table and a reply overwrites only the keys it carries: a failure carries _err alone,
  // an answer the keys its request maps in fields (a missing path reads as ''), a push (0) its values as they are.
  const reply = (record, seq = sent.at(-1).seq) => {
    const asked = sent.find((row) => row.seq === seq);
    if (asked?.name === 'q_say') runtime.phoneAt = runtime.clock;
    const fields = manifest.requests.find(({ name }) => name === asked?.name)?.fields;
    const written = record._err ? { _err: record._err }
      : fields ? Object.fromEntries(Object.entries(fields).map(([key, path]) => [key, record[path] ?? ''])) : record;
    runtime.record = { ...runtime.record, ...written };
    mock.event_data(seq);
  };
  // Time passes and the timers that fall due fire in order.
  const advance = (ms) => {
    const end = runtime.clock + ms;
    for (;;) {
      let next = null;
      for (const entry of timers) if (entry[1].due <= end && (!next || entry[1].due < next[1].due)) next = entry;
      if (!next) break;
      const [id, timer] = next;
      runtime.clock = Math.max(runtime.clock, timer.due);
      if (timer.repeat) timer.due += timer.ms; else timers.delete(id);
      mock.event_timer(id);
    }
    runtime.clock = end;
  };
  const lines = () => ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'e1', 'e2'].filter((id) => view.get(id).shown)
    .map((id) => view.get(id)).sort((a, b) => a.y - b.y).map(({ text }) => text);
  const options = () => ['po1', 'po2', 'po3', 'po4'].map((id) => shown(id)).filter((text) => text !== null);
  return { mock, sent, timers, runtime, shown, node, reply, advance, lines, options, last: () => sent.at(-1),
    sentOf: (name) => sent.findLast((row) => row.name === name),
    crown: (d) => mock.event_crown(d), click: () => mock.event_click() };
}

// The gateway sends 总管 first, then each agent relay setup enabled: g three characters each (glyph, state, busy),
// v two (version). These fixtures were written for five fixed agents with 总管 last; rail() and ver() move them over.
const rail = (old) => (old.slice(10, 12) || 'o0') + [0, 1, 2, 3, 4].map((i) => i + (old.slice(i * 2, i * 2 + 2) || 'o0')).join('');
const ver = (old) => { const v = old.padEnd(12, '0'); return v.slice(10, 12) + v.slice(0, 10) + v.slice(12); };

const idle = { g: rail('i0r1i0o0o0'), v: ver('000000000000'), k: '', h: '' };
// What the gateway pushes for a standby view: the attention code goes in st, and _err is cleared.
const pushed = ({ k = '', ...rest }) => ({ ...rest, st: k, _err: '' });
const codexLines = { d1: 'c先看一下现有的部署脚本。', d2: 'a脚本在scripts/deploy.sh，先跑测试再推镜像。', d3: 'b有两处要改：',
  d4: 'a•把镜像标签从latest换成提交号', d5: 'a•推之前先检查集群连接', d6: 'v把镜像标签换成提交号，然后跑一遍', d7: 'c好，我先改标签。',
  d8: 'j改完了', d9: 'a标签现在用git短提交号，测试全部通过。', d10: 'b要不要顺便把旧的latest标签删掉？', d11: 'a这一步会影响还在用它的服务。',
  d12: 'r顺便把README也更新一下' };
const codexPage = { g: rail('r1r1i0o0o0'), v: ver('a1000000000'), k: '', h: 'relay部署脚本', i: 'wqr012004000a001', ...codexLines };
const blank = Object.fromEntries(Array.from({ length: 16 }, (_, k) => ['d' + (k + 1), '']));

const newRow = { d1: '+n----新建会话', d9: '单击选 Agent，说话开新会话' };
const codexDir = { ...blank, h: '最近的会话', i: 'D002000000', ...newRow, d2: '0ra001relay部署脚本 · 在跑', d10: '先看一下现有的部署脚本。' };

/** Codex's session, opened the way the wearer does: a click for the directory, past 新建会话, a click on its row. */
function intoCodex(g) {
  g.mock.event_open();
  g.reply(idle);
  g.advance(1200);
  g.click();
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_dir', '0']);
  g.reply(codexDir, g.last().seq);
  g.crown(1);
  g.click();
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_lens', 'c0sa001']);
  g.reply({ ...blank, ...codexPage });
  g.advance(600);
}

const zgPage = { g: rail('i0r1i0o0o0i0'), v: ver('000000000000'), k: '', h: '总管 · 2 件事 · 上下文 12%', i: 'wdi005002000zg00', ...blank,
  d1: 'v现在都在干嘛', d2: 'a· 读 Codex·relay部署脚本', d3: 'a└ Claude · 眼镜胶囊 · 运行中', d4: 'cCodex 在改部署脚本，Claude 空闲。',
  d5: 'a— 已压缩 · 前 2 小时记成 5 行摘要 —' };

const newDir = { ...blank, h: '最近的会话', i: 'D001000000', ...newRow };
const hint = '到 Mac 上运行 relay setup';

test('the capsule holds the enabled agents in order, seven at most', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply({ ...idle, g: 'i0' + '0i0' + '1i0' + '2i0' + '3i0' + '4i0' + '6o0' + '7o0', v: '0'.repeat(16) });
  assert.deepEqual([g.node('cap').w, g.node('cap').x], [286, 270 - 143], 'seven agents, still centred');
  assert.ok(g.node('a6').shown);
  assert.deepEqual([g.node('a5').img, g.node('a6').img], [25, 31], 'Hermes and Antigravity, dim');
  g.reply(pushed({ ...idle, g: 'i0' + '0i0' + '1i0' + '4r1', v: '0'.repeat(10) }), 0);
  assert.deepEqual([g.node('cap').w, g.node('cap').x], [150, 270 - 75], 'three agents');
  for (const id of ['a3', 'a4', 'a5', 'a6']) assert.equal(g.node(id).shown, false, id + ' has no agent');
  assert.deepEqual([g.node('a2').img, g.node('a2').x], [27, 270 - 75 + 42 + 2 * 34], 'DeepSeek, working, in the third slot');
  g.advance(1200);
  g.click();
  g.advance(1100);
  g.reply({ ...newDir, i: 'D002000000', d2: '4ra001dsh 会话 · 在跑', d10: '在读代码' }, g.last().seq);
  g.crown(1);
  g.click();
  assert.deepEqual([g.mock.ag, g.node('sel').x], [4, 43 + 2 * 34], 'DeepSeek\'s page frames the third slot');
  assert.equal(g.node('hdr').x, 64 + 3 * 34, 'the title starts right of a three-agent capsule');
  assert.ok(g.node('hdr').x + g.node('hdr').w <= 540);
});

test('a waiting agent blinks, a working one is bright, an idle one dim', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply({ ...idle, g: rail('w1r1i0o0o0') });
  assert.deepEqual(['a0', 'a1', 'a2'].map((id) => g.node(id).img), [0, 1, 6]);
  g.runtime.faded.length = 0;
  g.advance(2000);
  assert.deepEqual(g.runtime.faded.filter((id) => /^a\d$/.test(id)), ['a0', 'a0'], 'Codex waits: its icon dips once a second');
  g.crown(-1);
  g.advance(1000);
  assert.equal(g.mock.view, 4);
  g.runtime.faded.length = 0;
  g.advance(3000);
  assert.deepEqual(g.runtime.faded, [], 'blank: nothing blinks');
});

test('with no agent enabled standby says to run relay setup', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply({ ...idle, g: 'o0', v: '00' });
  assert.equal(g.shown('hdr'), hint);
  assert.ok(['a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6'].every((id) => !g.node(id).shown), 'no agent icons');
  assert.ok(g.node('hub').shown, '总管 stays');
  g.advance(1200);
  g.click();
  g.advance(1100);
  g.reply(newDir, g.last().seq);
  assert.equal(g.shown('hdr'), hint, 'the directory says it too');
  g.click();
  assert.equal(g.mock.view, 2, 'nothing to start a session with');
});

test('new-session picking moves between enabled agents only', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply({ ...idle, g: 'i0' + '0i0' + '4i0', v: '000000' });
  g.advance(1200);
  g.click();
  g.advance(1100);
  g.reply(newDir, g.last().seq);
  g.click();
  assert.deepEqual([g.mock.view, g.mock.ag, g.node('sel').x], [3, 0, 43]);
  g.crown(-1);
  assert.deepEqual([g.mock.ag, g.node('sel').x], [4, 43 + 34], 'up one is DeepSeek, in the second slot');
  assert.match(g.shown('hdr'), /DeepSeek/);
  g.crown(-1);
  assert.equal(g.mock.ag, 4, 'no further');
  g.crown(1);
  assert.equal(g.mock.ag, 0);
  g.crown(1);
  assert.equal(g.mock.view, 0, 'down on the first goes back to standby');
});

test('on 总管\'s page the capsule keeps only agents running or waiting, and the time and battery take the room', () => {
  const g = glasses();
  const icons = () => ['a0', 'a1', 'a2', 'a3', 'a4'].map((id) => (g.node(id).shown ? g.node(id).x : null));
  const hhmm = () => {
    const m = Math.floor(g.runtime.clock / 60000) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  };
  const rails = rail('i0w1i0r0o0i0'); // Claude waits for you, Grok is running, the rest idle or off
  g.runtime.battery = 82;
  g.mock.event_open();
  g.reply({ ...idle, g: rails });
  g.advance(1200);
  assert.ok(icons().every((x) => x !== null), 'standby shows every enabled agent');
  assert.equal(g.node('clk').shown, false, 'and no clock');
  g.crown(1);
  g.advance(1100);
  g.reply({ ...zgPage, g: rails });
  g.advance(600);
  assert.deepEqual(icons(), [null, 48, null, 82, null], 'Claude and Grok, side by side');
  assert.equal(g.node('cap').w, 48 + 2 * 34, 'the capsule holds just the two');
  assert.equal(g.node('hdr').x, 64 + 2 * 34);
  assert.equal(g.shown('clk'), hhmm() + '  82%');
  assert.ok(g.node('hdr').x + g.node('hdr').w <= g.node('clk').x, 'the title stops before the clock');
  g.runtime.battery = 81;
  g.advance(60000);
  assert.equal(g.shown('clk'), hhmm() + '  81%', 'the clock and battery follow the minute');
  g.click();
  assert.equal(g.node('clk').shown, false, 'the recorder covers the header row');
  g.crown(1);
  g.advance(1100);
  g.reply({ ...zgPage, g: rails });
  g.advance(400);
  g.crown(1);
  g.advance(400);
  assert.equal(g.mock.view, 0);
  assert.equal(g.node('clk').shown, false, 'standby goes back to the full capsule');
  assert.ok(icons().every((x) => x !== null));
});

test('standby crown-down opens 总管; at its bottom a paused crown-down returns to standby', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply({ ...idle, g: rail('i0r1i0o0o0i0') });
  g.advance(1200);
  g.crown(1);
  assert.deepEqual([g.mock.view, g.mock.ag], [1, 5], 'the crown opens 总管, not Codex');
  assert.deepEqual([g.node('sel').shown, g.node('sel').x], [true, 9], 'the hub is outlined');
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_lens', 'z0']);
  g.reply(zgPage);
  g.advance(600);
  assert.equal(g.shown('hdr'), '总管 · 2 件事 · 上下文 12%');
  assert.deepEqual(g.lines(), ['└ Claude · 眼镜胶囊 · 运行中', 'Codex 在改部署脚本，Claude 空闲。', '— 已压缩 · 前 2 小时记成 5 行摘要 —'],
    'at 24 points the newest three lines fill the page');
  g.click();
  assert.equal(g.mock.rarg, 'zszg00', 'speech goes to 总管');
  g.crown(1);
  g.advance(1100);
  g.reply({ ...zgPage, i: 'wdi005002000zg00' });
  g.advance(400);
  g.crown(1);
  g.advance(400);
  assert.equal(g.mock.view, 0, 'the bottom of 总管 goes back to standby');
  assert.equal(g.node('sel').shown, false);
  assert.equal(g.node('cap').x, 161, 'standby centres the capsule again');
});

test('the hub lights for an unread report or a working 总管', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply({ ...idle, g: rail('i0r1i0o0o0w0') });
  assert.equal(g.node('hub').img, 29, 'an unread report');
  g.reply(pushed({ ...idle, g: rail('i0r1i0o0o0r0') }), 0);
  assert.equal(g.node('hub').img, 29, 'working');
  g.reply(pushed({ ...idle, g: rail('i0r1i0o0o0i0') }), 0);
  assert.equal(g.node('hub').img, 30, 'idle');
  g.reply(pushed({ ...idle, g: rail('i0r1i0o0o0o0') }), 0);
  assert.equal(g.node('hub').img, 30, 'off');
});

test('a page opened from an update card returns to standby at the bottom', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply(idle);
  g.advance(1200);
  g.reply(pushed({ ...idle, v: ver('000000000000' + '015') }), 0);
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_ask', 'u----0']);
  g.reply(codexCard);
  g.advance(300);
  g.click();
  g.advance(1100);
  assert.deepEqual([g.mock.view, g.last().arg], [1, 'c0scd34']);
  g.reply({ ...blank, ...codexPage, i: 'wqi012004000cd34' });
  g.advance(400);
  g.crown(1);
  g.advance(400);
  assert.equal(g.mock.view, 0, 'not on to Claude');
});

test('a report from 总管 grows a card framed on the hub', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply({ ...idle, g: rail('i0r1i0o0o0w0') });
  g.advance(1200);
  g.reply(pushed({ ...idle, g: rail('i0r1i0o0o0w0'), v: ver('000000000000' + '53') }), 0);
  g.advance(1100);
  g.reply({ ...blank, k: 'u5zg00', h: '总管 · 汇报', i: 'U13', d1: 'Codex 部署脚本改完了，测试全过。', d4: '总管：Codex 部署脚本改完了。' });
  g.advance(300);
  assert.deepEqual([g.node('sel').shown, g.node('sel').x], [true, 9 + 155], 'the hub is framed');
  g.click();
  g.advance(1100);
  assert.deepEqual([g.mock.ag, g.last().arg], [5, 'z0szg00'], 'a click opens 总管');
});

test('standby centres the status capsule; opening a session slides it top left with the newest line at the bottom', () => {
  const g = glasses();
  g.mock.event_open();
  assert.equal(g.last().name, 'q_now');
  g.reply(idle);
  assert.deepEqual([g.node('cap').x, g.node('cap').w], [161, 218], 'the capsule holds five agents and sits in the middle');
  assert.deepEqual(['a0', 'a1', 'a2', 'a3', 'a4'].map((id) => g.node(id).x), [0, 1, 2, 3, 4].map((i) => 48 + 155 + i * 34));
  assert.equal(g.node('a4').img, 28, 'DeepSeek offline: its dim icon');
  g.reply(pushed({ ...idle, g: rail('i0r1i0o0r1') }), 0);
  assert.equal(g.node('a4').img, 27, 'DeepSeek working: its bright icon');
  g.reply(pushed(idle), 0);
  assert.equal(g.mock.view, 0);
  g.advance(1200);
  g.runtime.slid.length = 0;
  g.click();
  for (const id of ['a0', 'a3', 'a4']) assert.ok(g.runtime.slid.includes(id), id + ' slides with the capsule');
  g.advance(1100);
  g.reply(codexDir, g.last().seq);
  g.crown(1);
  g.click();
  assert.equal(g.mock.view, 1);
  assert.equal(g.node('cap').x, 6, 'the page keeps it top left');
  g.advance(1100);
  g.reply({ ...blank, ...codexPage });
  g.advance(600);
  assert.equal(g.shown('hdr'), 'relay部署脚本');
  assert.ok(g.node('a0').shown && g.node('a4').shown, 'the five agents stay in the capsule');
  assert.ok(g.node('hdr').x >= g.node('cap').x + g.node('cap').w, 'the title starts right of the capsule');
  assert.equal(g.node('sel').x, 43, 'Codex is outlined');
  // A queued message of yours sits last, dim, inside an outline; the agent is still working.
  assert.equal(g.lines().at(-1), '顺便把README也更新一下');
  assert.equal(g.shown('dots'), '• • •');
  // The bottom edge is a line; while Codex works the microphone moves right and the running dots sit on the left.
  assert.ok(g.node('bl').shown && g.node('bl').h === 1 && g.node('bl').y > Math.max(...['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7']
    .map((id) => g.node(id)).filter((n) => n.shown).map((n) => n.y + n.h)));
  assert.ok(g.node('mic').shown && g.node('mic').img === 13 && g.node('mic').x === 506, 'a bright microphone, on the right');
  assert.ok(g.node('dots').y > g.node('bl').y);
  assert.equal(g.node('sb').shown, false, 'no scrollbar at the bottom');
  const queued = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7'].map((id) => g.node(id)).find((n) => n.shown && n.text === '顺便把README也更新一下');
  assert.equal(queued.gray, 130);
  assert.ok(g.node('u1').shown && g.node('u1').y < queued.y && g.node('u1').y + g.node('u1').h > queued.y + 18);
  g.crown(-1);
  g.advance(300);
  assert.ok([g.shown('e1'), g.shown('e2')].includes('改完了'), 'emphasis is bold, not bigger');
  assert.equal(manifest.ui.find(({ id }) => id === 'e1').size, manifest.ui.find(({ id }) => id === 'l1').size);
});

test('turning up only scrolls back; at the bottom a turn down leaves only after a pause', () => {
  const g = glasses();
  intoCodex(g);
  const bottom = g.lines();
  g.crown(-1);
  g.crown(-1);
  g.crown(-1);
  assert.equal(g.mock.view, 1, 'turning up never leaves the page');
  assert.ok(g.node('sb').shown && g.node('sb').x + g.node('sb').w <= 540 && g.node('sb').w <= 4, 'a thin scrollbar on the right');
  assert.ok(g.node('sb').y >= 42 && g.node('sb').y + g.node('sb').h <= 168);
  assert.notDeepEqual(g.lines(), bottom);
  // Three turns up went six lines; each turn down comes back two.
  g.crown(1);
  g.crown(1);
  g.crown(1);
  g.advance(200);
  assert.deepEqual(g.lines(), bottom, 'back at the newest line once the glide ends');
  g.crown(1);
  assert.equal(g.mock.view, 1, 'a turn that keeps going after reaching the bottom does not leave');
  g.advance(200);
  g.crown(1);
  assert.equal(g.mock.view, 1, 'neither does one 0.2 s later');
  g.advance(350);
  g.crown(1);
  assert.equal(g.mock.view, 2, 'after a pause the next turn goes back to the directory it came from');
});

test('turning up glides the page down over 0.2 s and fades in only the lines it brings in', () => {
  const g = glasses();
  intoCodex(g);
  const ids = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'e1', 'e2'];
  const where = () => Object.fromEntries(ids.filter((id) => g.node(id).shown).map((id) => [g.node(id).text, g.node(id).y]));
  const inside = (at) => Object.values(at).every((y) => y >= 40 && y + 30 <= 168);
  const faded = [];
  const fade = g.mock.anim_opa;
  g.mock.anim_opa = (id, from, to, ms) => { if (ids.includes(manifest.ui[id].id)) faded.push(g.node(manifest.ui[id].id).text); fade(id, from, to, ms); };
  const before = where();
  g.crown(-1);
  const first = where();
  g.advance(100);
  const second = where();
  g.advance(100);
  const end = where();
  assert.ok([first, second, end].every(inside), 'no line is drawn over the header or the bottom edge');
  const kept = Object.keys(before).filter((text) => text in first && text in second && text in end);
  assert.ok(kept.length > 0);
  for (const text of kept) {
    assert.ok(before[text] < first[text] && first[text] < second[text] && second[text] < end[text], text + ' moves down step by step');
  }
  const brought = Object.keys(end).filter((text) => !(text in before));
  assert.ok(brought.length > 0);
  assert.deepEqual([...new Set(faded)].sort(), brought.sort(), 'only the lines that slid in fade in');
  assert.equal(g.timers.has(0), false, 'the glide timer stops once the page is in place');
  g.advance(500);
  assert.deepEqual(where(), end, 'nothing moves after the glide');
  // Turning back down glides up to the newest line.
  faded.length = 0;
  g.crown(1);
  assert.ok(inside(where()));
  g.advance(200);
  assert.equal(g.lines().at(-1), '顺便把README也更新一下');
  assert.ok(faded.includes('顺便把README也更新一下'));
});

test('in history new lines show as a count at the bottom; a click there jumps down, a click at the bottom records', () => {
  const g = glasses();
  intoCodex(g);
  g.crown(-1);
  g.reply(pushed({ ...idle, g: rail('r1r1i0o0o0'), v: ver('a2000000000') }), 0);
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_lens', 'c2sa001'], 'the page stays on the session it shows');
  g.reply({ ...blank, ...codexPage, v: ver('a2000000000'), i: 'wqr014006000a001', d12: 'v顺便把README也更新一下',
    d13: 'cREADME已经更新。', d14: 'a部署说明里加了提交号标签的用法。' });
  assert.equal(g.shown('bt'), '2 条新消息');
  assert.equal(g.node('mic').shown, false, 'the count takes the microphone\'s place');
  assert.ok(!g.lines().includes('README已经更新。'), 'still where you were reading');
  const before = g.sent.length;
  g.click();
  assert.equal(g.sent.length, before, 'the click jumps down instead of recording');
  assert.equal(g.lines().at(-1), '部署说明里加了提交号标签的用法。');
  assert.equal(g.shown('bt'), null);
  assert.ok(g.node('mic').shown && !g.node('sb').shown);
  g.advance(1100);
  g.click();
  g.advance(1100);
  assert.equal(g.sentOf('q_say')?.arg, '-csa001', 'speech goes to the session on screen');
  assert.equal(g.shown('phd'), '说给 Codex · 这轮结束后发', 'Codex is busy, so it waits for the turn');
  g.advance(1100);
  g.click();
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_mic', 'end'], 'a second click ends the recording');
  g.reply({ st: 'held', h: '顺便跑一下测试' }, g.sentOf('q_say').seq);
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_act', '-csa001'], 'the gateway sends what it held');
  g.reply({ st: 'queued', h: '这轮结束后发' }, g.last().seq);
  assert.equal(g.shown('hdr'), '这轮结束后发');
  const sentAt = g.runtime.clock;
  g.advance(1100);
  assert.equal(g.last().name, 'q_lens', 'the page is read again after the send');
  assert.ok(g.last().at - sentAt >= 1000, 'not within a second of the spoken message');
});

test('a long new reply shows from its first line; turning down reads on, and history you are reading stays put', () => {
  const g = glasses();
  intoCodex(g);
  assert.equal(g.lines().at(-1), '顺便把README也更新一下', 'a short newest message: the page sits at the bottom');
  // Codex answers with six paragraphs; the gateway says its first line is reached with the page 3 rows up.
  const long = { ...blank, ...codexPage, ...codexLines, d11: 'c一', d12: 'b二', d13: 'b三', d14: 'b四', d15: 'b五', d16: 'b六',
    v: ver('a2000000000'), i: 'wqi018005000a001003' };
  g.reply(pushed({ ...idle, g: rail('i1r1i0o0o0'), v: ver('a2000000000') }), 0);
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_lens', 'c0sa001']);
  g.reply(long);
  assert.deepEqual(g.lines(), ['一', '二', '三'], 'the reply starts at the top of the page');
  assert.equal(g.shown('bt'), null, 'no "new messages" capsule: this is the new message');
  g.advance(400);
  g.crown(1);
  g.advance(300);
  assert.equal(g.lines().at(-1), '五', 'each turn down reads on two lines');
  g.crown(1);
  g.advance(300);
  assert.equal(g.lines().at(-1), '六', 'turning down reads on to its end');

  // Reading history, a new reply does not pull the page away.
  g.crown(-1);
  g.advance(300);
  const reading = g.lines();
  g.reply(pushed({ ...idle, g: rail('i1r1i0o0o0'), v: ver('a3000000000') }), 0);
  g.advance(1100);
  // Two more lines come in at the bottom; everything else moves up two rows.
  const moved = Object.fromEntries(Array.from({ length: 14 }, (_, k) => ['d' + (k + 1), long['d' + (k + 3)]]));
  g.reply({ ...long, ...moved, d15: 'c七', d16: 'a八', v: ver('a3000000000'), i: 'wqi020006000a001000' });
  assert.deepEqual(g.lines(), reading);
  assert.equal(g.shown('bt'), '1 条新消息');
});

test('opening a session whose newest reply is long starts at that reply\'s first line', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply(idle);
  g.advance(1200);
  g.click();
  g.advance(1100);
  g.reply(codexDir, g.last().seq);
  g.crown(1);
  g.click();
  g.advance(1100);
  g.reply({ ...blank, ...codexPage, ...codexLines, d11: 'c一', d12: 'b二', d13: 'b三', d14: 'b四', d15: 'b五', d16: 'b六',
    i: 'wqi016005000a001003' });
  assert.deepEqual(g.lines(), ['一', '二', '三']);
  g.click();
  assert.equal(g.lines().at(-1), '六', 'a click goes to the end first, as it does whenever the page is not at the bottom');
});

test('while a session works the line left of the microphone says what it does; when it is done the microphone comes back', () => {
  const g = glasses();
  intoCodex(g);
  const action = '运行 npm test -- --grep 部署脚本…'; // the gateway keeps it to 44 bytes
  g.reply(pushed({ ...idle, g: rail('r1r1i0o0o0'), v: ver('a2000000000') }), 0);
  g.advance(1100);
  g.reply({ ...blank, ...codexPage, v: ver('a2000000000'), i: codexPage.i + '000' + action });
  assert.equal(g.shown('dots'), action);
  assert.equal(g.node('mic').x, 506);
  g.reply(pushed({ ...idle, g: rail('i1r1i0o0o0'), v: ver('a3000000000') }), 0);
  g.advance(1100);
  g.reply({ ...blank, ...codexPage, v: ver('a3000000000'), i: 'wqi012004000a001' });
  assert.equal(g.shown('dots'), null, 'nothing to say once it is done');
  assert.equal(g.node('mic').x + 10, 270, 'the microphone is back in the middle');
  g.crown(-1);
  assert.equal(g.shown('dots'), null);
});

const claudeCard = { ...blank, k: 'u1ab12', h: 'Claude · relay 网关', i: 'U212', d1: 'README已经更新，部署说明里加了标签用法，',
  d2: '另外顺手修了两个错别字。', d4: 'Claude：README已经更新。' };
const codexCard = { ...blank, k: 'u0cd34', h: 'Codex · 部署脚本', i: 'U115', d1: '测试全部通过。', d4: 'Codex：测试全部通过。' };

test('in standby an update grows a card under the capsule; the crown shows the next, a click opens its session', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply(idle);
  g.advance(1200);
  g.reply(pushed({ ...idle, v: ver('000000000000' + '112') }), 0);
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_ask', 'u----0'], 'words newer than what was seen ask for a card');
  g.reply(claudeCard);
  assert.deepEqual([g.node('pbox').shown, g.node('pbox').w, g.node('pbox').h], [true, 200, 34], 'the card starts at the capsule\'s size');
  g.advance(300);
  assert.deepEqual([g.node('pbox').x, g.node('pbox').y, g.node('pbox').w, g.node('pbox').h], [6, 44, 528, 112], 'two lines of text');
  assert.equal(g.shown('phd'), 'Claude · relay 网关 · 还有 1 条');
  assert.deepEqual([g.shown('pq1'), g.shown('pq2'), g.shown('pq3')], [claudeCard.d1, claudeCard.d2, null]);
  assert.equal(g.shown('dots'), '单击打开 · 转表冠看下一条');
  assert.deepEqual([g.node('cap').shown, g.node('cap').x], [true, 161], 'the capsule stays in the middle');
  assert.deepEqual([g.node('sel').shown, g.node('sel').x], [true, 43 + 155 + 34], 'Claude\'s icon is framed');

  g.crown(1);
  g.advance(300);
  assert.equal(g.node('pbox').shown, false, 'the crown puts the card away');
  assert.equal(g.mock.view, 0, 'and does not open a page');
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_ask', 'u----12'], 'the next one in the queue');
  g.reply(codexCard);
  g.advance(300);
  assert.equal(g.shown('phd'), 'Codex · 部署脚本');
  assert.equal(g.node('pbox').h, 88);
  assert.equal(g.shown('dots'), '单击打开 · 转表冠收起');

  g.click();
  assert.equal(g.node('pbox').shown, false);
  g.advance(1100);
  assert.deepEqual([g.mock.view, g.last().name, g.last().arg], [1, 'q_lens', 'c0scd34'], 'a click opens that session');
  assert.equal(g.mock.ucur, 15);
});

test('on a page an update from another session waits in the bottom capsule, opens on a click and folds away unread', () => {
  const g = glasses();
  intoCodex(g);
  g.reply(pushed({ ...idle, g: rail('r1r1i0o0o0'), v: ver('a10000000000' + '17') }), 0);
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_ask', 'ua0010'], 'the session on screen is left out');
  g.reply({ ...claudeCard, i: 'U17', d4: 'Claude：README已经更新。' });
  assert.equal(g.shown('bt'), 'Claude：README已经更新。');
  assert.equal(g.node('mic').shown, false);
  assert.equal(g.node('bc').w, Buffer.byteLength('Claude：README已经更新。') * 5 + 40, 'the capsule is as wide as its words');
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_lens', 'c0sa001'], 'the card took the page keys');
  g.reply({ ...blank, ...codexPage });
  assert.equal(g.shown('bt'), 'Claude：README已经更新。');

  g.click();
  g.advance(1100);
  assert.deepEqual([g.mock.ag, g.last().name, g.last().arg], [1, 'q_lens', 'k0sab12'], 'a click moves to that session');
  assert.equal(g.sentOf('q_say'), undefined, 'and does not record');
  const claudePage = { ...blank, g: rail('r1r1i0o0o0'), v: ver('a1000000000'), k: '', h: 'relay 网关', i: 'wqi002001000ab12',
    d1: 'v看看日志', d2: 'c日志里没有报错。' };
  g.reply(claudePage);
  assert.deepEqual(g.lines(), ['看看日志', '日志里没有报错。']);
  assert.equal(g.shown('hdr'), 'relay 网关', 'no "new session" notice for a move you asked for');
  assert.equal(g.shown('bt'), null);

  // An update you do not act on folds back into the microphone after six seconds.
  g.reply(pushed({ ...idle, g: rail('r1r1i0o0o0'), v: ver('a10000000000' + '09') }), 0);
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_ask', 'uab127']);
  g.reply({ ...codexCard, i: 'U19' });
  assert.equal(g.shown('bt'), 'Codex：测试全部通过。');
  g.advance(1100);
  g.reply(claudePage);
  g.advance(6000);
  assert.equal(g.shown('bt'), null);
  assert.ok(g.node('mic').shown);
  assert.equal(g.mock.ucur, 9);
  g.click();
  g.advance(1100);
  assert.equal(g.sentOf('q_say')?.arg, '-ksab12', 'a click records for the session on screen');
});

const dirPage = { ...blank, h: '最近的会话', i: 'D006000000', ...newRow, d2: '1wk001relay 网关 · 等你', d3: '0ia001部署脚本 · 2 小时前',
  d4: '3rg001日报 bot · 在跑', d5: '2im001调研 · 1 天前', d6: '0ic002旧项目 · 3 天前',
  d10: '要不要合并？', d11: '标签已经更新。', d12: '正在工作', d13: '找到三篇。', d14: '好的。' };

test('a click in standby opens the directory: every agent\'s sessions, newest first, picked with the crown', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply(idle);
  g.advance(1200);
  const openDirectory = () => {
    g.click();
    assert.equal(g.mock.view, 2);
    g.advance(1100);
    assert.equal(g.sentOf('q_dir')?.arg, '0');
    g.reply(dirPage, g.sentOf('q_dir').seq);
  };
  openDirectory();
  assert.equal(g.shown('hdr'), '最近的会话');
  assert.deepEqual(g.lines(), ['新建会话', '单击选 Agent，说话开新会话', 'relay 网关 · 等你', '部署脚本 · 2 小时前'],
    'three rows, the first one 新建会话 and chosen, with what it does');
  const row = (text) => ['l1', 'l2', 'l3', 'l4'].map((id) => g.node(id)).find((n) => n.shown && n.text === text);
  assert.equal(row('新建会话').gray, 255);
  assert.equal(row('relay 网关 · 等你').gray, 150);
  assert.deepEqual(['pi1', 'pi2', 'pi3'].map((id) => g.node(id).img), [13, 5, 4],
    '新建会话 ends with the microphone, each session with its agent, the chosen one bright');
  assert.ok(['u1', 'u2', 'u3'].every((id) => g.node(id).shown && g.node(id).y + g.node(id).h <= 195), 'every row in a box');
  assert.equal(g.node('u4').shown, false, 'no fourth row at the larger size');
  assert.equal(g.node('mic').shown, false, 'the directory is for picking, not talking');

  g.crown(1);
  assert.ok(g.lines().includes('要不要合并？'));
  g.crown(1); g.crown(1); g.crown(1); g.crown(1);
  assert.ok(g.lines().includes('旧项目 · 3 天前') && g.lines().includes('好的。'), 'the last row scrolls into view');
  assert.ok(g.node('sb').shown, 'with a scrollbar');
  assert.equal(g.sentOf('q_dir').arg, '0', 'moving inside the eight rows held asks for nothing');
  for (let k = 0; k < 5; k++) g.crown(-1);
  assert.equal(g.mock.view, 2, 'still on 新建会话');
  g.crown(-1);
  g.advance(300);
  assert.equal(g.mock.view, 0, 'turning up past the first row goes back to standby');
  assert.ok(g.lines().length === 0 && !g.node('u3').shown && !g.node('pi1').shown);

  // Open a session from the directory, then come back to it.
  g.advance(1100);
  openDirectory();
  g.crown(1); g.crown(1);
  g.click();
  assert.deepEqual([g.mock.view, g.mock.ag], [1, 0]);
  assert.equal(g.node('pi1').shown, false);
  g.advance(1100);
  assert.equal(g.sentOf('q_lens')?.arg, 'c0sa001', 'the page is the session picked, kept there');
  g.reply({ ...blank, ...codexPage }, g.sentOf('q_lens').seq);
  g.advance(400);
  g.crown(1);
  assert.equal(g.mock.view, 2, 'turning down at the bottom goes back to the directory, not to Claude');
  g.advance(1100);
  assert.equal(g.sentOf('q_dir').arg, 'sa001', 'landing on the session just read');
  g.reply({ ...dirPage, i: 'D006000002' }, g.sentOf('q_dir').seq);
  assert.equal(row('部署脚本 · 2 小时前').gray, 255);

  // Turning down from standby opens 总管, and the bottom of its page goes back to standby, not to the directory.
  g.crown(-1); g.crown(-1); g.crown(-1);
  g.advance(300);
  g.advance(1100);
  g.crown(1);
  assert.deepEqual([g.mock.view, g.mock.ag], [1, 5]);
  g.advance(1100);
  assert.equal(g.sentOf('q_lens').arg, 'z0');
  g.reply(zgPage, g.sentOf('q_lens').seq);
  g.advance(400);
  g.crown(1);
  g.advance(400);
  assert.equal(g.mock.view, 0);
});

test('one failed request does not stick: the next answer from the gateway clears the error', () => {
  // The Mac lost its network once; the phone wrote _err=net and kept it, so every later answer looked failed.
  const g = glasses();
  g.mock.event_open();
  g.reply({ _err: 'net' });
  assert.equal(g.shown('hdr'), '连不上 Mac，看网关和隧道');
  g.advance(5200);
  assert.equal(g.last().name, 'q_now', 'standby asks again');
  g.reply({ ...idle, _err: '' });
  assert.equal(g.node('a1').img, 1, 'Claude is running again, so its icon is bright');
  g.advance(1200);
  g.crown(1);
  g.advance(1100);
  g.reply({ ...blank, ...codexPage, _err: '' });
  assert.ok(g.lines().length > 0, 'the page shows its lines');
});

test('the directory\'s first row picks an agent to start a new session with a spoken message', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply(idle);
  g.advance(1200);
  const intoNew = () => {
    g.click();
    g.advance(1100);
    assert.equal(g.sentOf('q_dir')?.arg, '0');
    g.reply(dirPage, g.sentOf('q_dir').seq);
    assert.deepEqual([g.mock.dsel, g.node('pi1').img], [0, 13], '新建会话 is chosen when the directory opens');
    g.click();
  };
  intoNew();
  assert.equal(g.mock.view, 3);
  assert.equal(g.shown('hdr'), '单击说话 · 开新的 Codex 会话');
  assert.equal(g.node('sel').x, 43);
  assert.ok(g.node('mic').shown && g.node('mic').img === 13);
  assert.ok(!g.node('u1').shown && !g.node('pi1').shown && g.lines().length === 0, 'the directory is gone');
  g.crown(1);
  g.advance(300);
  assert.equal(g.mock.view, 0, 'turning back down on Codex returns to standby');

  g.advance(1100);
  intoNew();
  g.crown(-1);
  assert.equal(g.shown('hdr'), '单击说话 · 开新的 Claude 会话');
  g.crown(-1);
  assert.equal(g.shown('hdr'), '单击说话 · 开新的 Muse 子对话');
  g.crown(-1);
  assert.equal(g.shown('hdr'), 'Grok 暂不支持从眼镜新开');
  assert.equal(g.node('mic').img, 14);
  const before = g.sent.length;
  g.click();
  assert.equal(g.sent.length, before, 'Grok cannot start one, so nothing is recorded');
  g.advance(2300);
  g.crown(-1);
  assert.equal(g.shown('hdr'), '单击说话 · 开新的 DeepSeek 会话');
  assert.equal(g.node('mic').img, 13, 'DeepSeek can start one');
  assert.equal(g.node('sel').x, 43 + 4 * 34);
  g.crown(-1);
  assert.equal(g.mock.ag, 4, 'DeepSeek is the last one');
  g.crown(1);
  g.crown(1);
  g.advance(2300);
  g.click();
  g.advance(1100);
  assert.equal(g.sentOf('q_say')?.arg, '-mn');
  assert.equal(g.shown('phd'), '新开 Muse');
  g.advance(1100);
  g.click();
  g.advance(1100);
  g.reply({ st: 'held', h: '找一下' }, g.sentOf('q_say').seq);
  g.advance(1100);
  g.reply({ st: 'sent', h: '已开始新对话' }, g.sentOf('q_act').seq);
  assert.deepEqual([g.mock.view, g.mock.ag], [1, 2], 'the new conversation opens as Muse\'s page');
  g.advance(1100);
  assert.equal(g.sentOf('q_lens')?.arg, 'm0');
});

test('speech listens on through one pause and ends on the second; a click ends it at once, turning the crown cancels', () => {
  const start = () => {
    const g = glasses();
    g.mock.event_open();
    g.reply(idle);
    g.advance(1200);
    g.click();
    g.advance(1100);
    g.reply(dirPage, g.sentOf('q_dir').seq);
    g.click();
    g.advance(1100);
    g.click();
    g.advance(1100);
    return g;
  };
  const said = (g) => g.sent.filter((row) => row.name === 'q_say').length;
  const g = start();
  const first = g.sentOf('q_say');
  assert.equal(first.arg, '-cn', 'the first piece starts a fresh message');
  // The phone stops after a pause: the piece waits on the Mac and the glasses listen again.
  g.reply({ st: 'held', h: '先跑测试' }, first.seq);
  assert.equal(g.mock.rec, 3, 'still listening, nothing heard in this round yet');
  assert.equal(g.shown('pq1'), '先跑测试', 'what was heard so far stays on the lens');
  g.advance(1100);
  const second = g.sentOf('q_say');
  assert.equal(second.arg, '.cn', 'the next piece adds to it');
  assert.ok(second.seq > first.seq);
  // In the second round the phone may wait for speech; with nothing heard for about a second and a half the glasses end it.
  g.advance(1000);
  assert.equal(said(g), 2);
  assert.notDeepEqual([g.last().name, g.last().arg], ['q_mic', 'end'], 'not yet');
  g.advance(1000);
  assert.deepEqual([g.last().name, g.last().arg], ['q_mic', 'end'], 'the glasses end the silent round');
  // Nothing was said in it, so the Mac sends what it holds.
  g.reply({ _err: 'empty' }, second.seq);
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_act', '-cn']);
  assert.equal(said(g), 2);
  g.reply({ st: 'sent', h: '已开始新会话' }, g.last().seq);
  assert.equal(g.mock.rec, 0);
  assert.deepEqual([g.mock.view, g.mock.ag], [1, 0], 'the new session opens as Codex\'s page');

  // Speech in the second round keeps it going: the phone ends that round after its own pause.
  const k = start();
  k.reply({ st: 'held', h: '先跑测试' }, k.sentOf('q_say').seq);
  k.advance(1100);
  k.reply({ st: 'rec', tx: '再部署' }, 0);
  assert.equal(k.shown('pq1'), '再部署');
  k.advance(4000);
  assert.ok(!k.sent.some((row) => row.name === 'q_mic'), 'the glasses leave a round with speech to the phone');

  const c = start();
  c.click();
  c.advance(1100);
  assert.deepEqual([c.last().name, c.last().arg], ['q_mic', 'end'], 'a click ends the piece being heard');
  c.reply({ st: 'held', h: '先跑测试' }, c.sentOf('q_say').seq);
  c.advance(1100);
  assert.deepEqual([c.last().name, c.last().arg], ['q_act', '-cn'], 'and sends without listening again');
  assert.equal(said(c), 1);

  const b = start();
  b.reply({ st: 'held', h: '先跑测试' }, b.sentOf('q_say').seq);
  b.click();
  b.advance(1100);
  assert.deepEqual([b.last().name, b.last().arg], ['q_act', '-cn'], 'a click between two pieces sends at once');
  assert.equal(said(b), 1);

  const x = start();
  x.reply({ st: 'held', h: '先跑测试' }, x.sentOf('q_say').seq);
  x.crown(1);
  x.advance(1100);
  assert.deepEqual([x.last().name, x.last().arg], ['q_mic', 'stop']);
  assert.equal(x.mock.rec, 0);
  x.advance(3000);
  assert.equal(x.sent.filter((row) => row.name === 'q_say' || row.name === 'q_act').length, 1, 'nothing more is heard or sent');
});

const lit = (g) => manifest.ui.map(({ id }) => id).filter((id) => g.node(id).shown);

test('standby crown-up blanks the lens and stops every timer and request; crown-down comes back', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply(idle);
  g.advance(1200);
  g.crown(-1);
  assert.equal(g.mock.view, 4, 'not the new-session picker any more');
  g.advance(400);
  assert.deepEqual(lit(g), [], 'nothing is left on the lens');
  assert.deepEqual([g.last().name, g.last().arg], ['q_act', 'zz'], 'the gateway is told once to stop pushing');
  const count = g.sent.length;
  g.reply({ st: 'ok', h: '' }, g.last().seq);
  g.reply(pushed({ ...idle, g: rail('w1r1i0o0o0'), v: ver('a1000000000015'), k: 'y0ab12' }), 0);
  g.click();
  assert.deepEqual(lit(g), [], 'a push or a click draws nothing');
  assert.equal(g.mock.g, rail('i0r1i0o0o0'), 'the push is not even read');
  g.advance(10000);
  assert.equal(g.sent.length, count, 'no request for ten seconds');
  assert.equal(g.timers.size, 0, 'no timer running');

  g.crown(1);
  assert.equal(g.mock.view, 0);
  assert.deepEqual([g.node('cap').shown, g.node('cap').x, g.node('cap').w], [true, 161, 218], 'the capsule is back in the middle');
  assert.equal(g.last().name, 'q_now', 'and asks the gateway, which wakes it');
  assert.ok(g.timers.has(1), 'standby polls again');
  g.reply({ ...idle, g: rail('w1r1i0o0o0'), v: ver('a1000000000015'), k: 'y0ab12' }, g.last().seq);
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_ask', 'ab12'], 'what waited during the blank shows now');
});

test('from the blank lens crown-up opens 总管, and crown-down at its bottom goes back to blank', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply({ ...idle, g: rail('i0r1i0o0o0i0') });
  g.advance(1200);
  g.crown(-1);
  g.advance(1500);
  g.crown(-1);
  assert.deepEqual([g.mock.view, g.mock.ag, g.mock.dsel], [1, 5, -3]);
  assert.deepEqual([g.node('sel').shown, g.node('sel').x], [true, 9], 'the same 总管 page, its hub outlined');
  assert.deepEqual([g.last().name, g.last().arg], ['q_lens', 'z0']);
  g.reply(zgPage, g.last().seq);
  g.advance(600);
  assert.equal(g.shown('hdr'), '总管 · 2 件事 · 上下文 12%');
  // Talking to it, then cancelling, does not forget where it came from.
  g.click();
  g.crown(1);
  g.advance(1100);
  g.reply({ ...zgPage }, g.sentOf('q_lens')?.seq);
  g.advance(400);
  g.crown(1);
  assert.equal(g.mock.view, 4, 'the bottom of this 总管 goes back to the blank lens, not to standby');
  g.advance(1500);
  assert.deepEqual(lit(g), []);
  assert.deepEqual([g.last().name, g.last().arg], ['q_act', 'zz']);
  assert.equal(g.timers.size, 0);
  g.crown(1);
  assert.equal(g.mock.view, 0, 'and crown-down from there is standby');
});

test('turning in the directory slides the list over three frames', () => {
  const g = glasses();
  g.mock.event_open();
  g.reply(idle);
  g.advance(1200);
  g.click();
  g.advance(1100);
  g.reply(dirPage, g.sentOf('q_dir').seq);
  assert.ok(g.node('u1').y > 42, 'opening, the list starts a little low');
  assert.ok(g.node('u4').y + g.node('u4').h <= 195);
  g.advance(300);
  assert.equal(g.node('u1').y, 42, 'and slides up into place');
  g.crown(1);
  assert.ok(g.node('u1').y > 42, 'turning down, the rows start low');
  g.advance(100);
  assert.ok(g.node('u1').y > 42 && g.node('u1').y < 50, 'most of the way after one frame');
  g.advance(200);
  assert.equal(g.node('u1').y, 42, 'in place after three');
  g.crown(-1);
  assert.ok(g.node('u1').y < 42, 'turning up, they start high');
  g.advance(300);
  assert.equal(g.node('u1').y, 42);
});

const approval = { ...blank, k: 'y0ab12', h: 'Codex · 要运行命令', i: '011', d1: './scripts/deploy.sh --tag=8f3a2c1',
  d2: '推之前检查集群连接，然后推镜像。' };

test('an approval grows from the top capsule; reading history first folds it into the bottom capsule', () => {
  const g = glasses();
  intoCodex(g);
  g.reply(pushed({ ...idle, g: rail('w1r1i0o0o0'), v: ver('a1000000000'), k: 'y0ab12' }), 0);
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_ask', 'ab12']);
  g.reply(approval);
  assert.deepEqual([g.node('pbox').shown, g.node('pbox').w, g.node('pbox').h], [true, 200, 34], 'it starts at the capsule\'s size');
  assert.deepEqual(g.lines(), [], 'the outline shows nothing underneath');
  assert.equal(g.node('cap').shown, false, 'not even the top capsule');
  g.advance(300);
  assert.deepEqual([g.node('pbox').w, g.node('pbox').h], [528, 191], 'and grows to the whole lens');
  assert.deepEqual(g.options(), ['先看历史', '本会话都允许', '允许'], 'three rows fit under a two-line request');
  assert.equal(g.node('psl').y, 85, 'reading history first is selected, so a stray click approves nothing');
  assert.equal(g.node('po2').y - g.node('po1').y, 30, 'rows are 30 pixels apart');
  assert.ok(g.node('sb').shown, 'a bar says there is more');
  g.click();
  g.advance(300);
  assert.equal(g.node('pbox').shown, false);
  assert.ok(g.node('cap').shown, 'the top capsule is back');
  assert.equal(g.shown('bt'), 'Codex 问你 · 单击查看');
  g.click();
  g.advance(300);
  assert.deepEqual(g.options(), ['先看历史', '本会话都允许', '允许']);
  g.crown(1);
  g.crown(1);
  assert.equal(g.node('psl').y, 85 + 2 * 30);
  g.crown(1);
  assert.deepEqual(g.options(), ['本会话都允许', '允许', '拒绝'], 'the list scrolls to the last row');
  g.crown(-1);
  g.advance(1100);
  g.click();
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_act', 'ab12y']);
  g.reply({ st: 'ok', h: '已允许' });
  g.advance(300);
  assert.equal(g.node('pbox').shown, false);
  assert.equal(g.shown('hdr'), '已允许');
});

test('a choice question lists its options and a spoken answer; the crown cancels a recording', () => {
  const g = glasses();
  intoCodex(g);
  g.reply(pushed({ ...idle, g: rail('w1r1i0o0o0'), v: ver('a1000000000'), k: 'i0cd34' }), 0);
  g.advance(1100);
  g.reply({ ...blank, k: 'i0cd34', h: 'Codex · 部署环境', i: '301', d1: '先部署到哪个环境？', d4: '预发布环境', d5: '生产环境', d6: '只在本机跑' });
  g.advance(1100);
  const again = g.sentOf('q_lens');
  assert.ok(again.at > g.sentOf('q_ask').at, 'the reply took the page keys, so the page is read again');
  g.reply({ ...blank, ...codexPage, g: rail('w1r1i0o0o0'), k: 'i0cd34' }, again.seq);
  assert.equal(g.shown('pq1'), '先部署到哪个环境？');
  assert.deepEqual(g.options(), ['先看历史', '预发布环境', '生产环境', '只在本机跑']);
  for (let k = 0; k < 4; k++) g.crown(1);
  assert.deepEqual(g.options(), ['预发布环境', '生产环境', '只在本机跑', '说话回答'], 'the list scrolls to the last row');
  g.advance(1100);
  g.click();
  g.advance(1100);
  assert.equal(g.sentOf('q_say')?.arg, '-acd34');
  assert.equal(g.shown('phd'), '回答 Codex');
  assert.equal(g.node('sb').shown, false, 'the pop-up\'s scroll bar goes with it');
  assert.ok(g.lines().length > 0, 'the page shows under the recorder');
  g.crown(1);
  g.advance(1100);
  assert.deepEqual([g.last().name, g.last().arg], ['q_mic', 'stop']);
  assert.equal(g.mock.rec, 0);
});

test('a read-only page says so, a new session resets the page, and a missing Agent is explained', () => {
  const g = glasses();
  intoCodex(g);
  g.crown(-1);
  g.reply(pushed({ ...idle, g: rail('i1r1i0o0o0'), v: ver('a2000000000') }), 0);
  g.advance(1100);
  assert.equal(g.last().name, 'q_lens');
  g.reply({ ...blank, ...codexPage, v: ver('a2000000000'), i: 'wqi003002000b002', d1: 'v换个任务', d2: 'c好的。', d3: 'a先从哪开始？' });
  assert.equal(g.shown('hdr'), '换到新会话');
  assert.deepEqual(g.lines(), ['换个任务', '好的。', '先从哪开始？'], 'nothing from the old session is left');
  assert.equal(g.mock.off, 0);
  g.mock.fl = 'rdi'; // the same session, now open read-only
  g.advance(3000);
  g.click();
  assert.equal(g.shown('hdr'), '这个会话只能看');
  assert.equal(g.sent.filter((row) => row.name === 'q_say').length, 0);

  const lost = glasses();
  lost.mock.event_open();
  lost.reply({ _err: 'noagent' });
  assert.equal(lost.shown('hdr'), '没接 Agent：到 Spare App 开发者设置接入 Relay');
  assert.deepEqual([lost.node('cap').x, lost.node('cap').w], [6, 528], 'a standby notice widens the capsule from the left');
});

test('the packaged smoke scenario replays without a fault', async () => {
  // The cloud build runs spare/scenarios/*.txt and passes only with zero faults; replay it through the same stubs.
  const g = glasses();
  const lines = (await readFile(new URL('scenarios/smoke.txt', root), 'utf8')).split('\n').filter(Boolean);
  const shots = [];
  for (const line of lines) {
    const [command, ...rest] = line.split(' ');
    if (command === 'open') g.mock.event_open();
    else if (command === 'close') g.mock.event_close();
    else if (command === 'crown') g.crown(Number(rest[0]));
    else if (command === 'click') g.click();
    else if (command === 'tick') g.advance(Number(rest[0]));
    else if (command === 'connect') g.runtime.online = rest[0] === '1';
    else if (command === 'shot') shots.push([rest[0], g.mock.view + ':' + g.mock.pop]);
    else if (command === 'reply') g.reply(Object.fromEntries(rest.map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)])));
    else assert.fail('unknown scenario command ' + command);
  }
  const view = Object.fromEntries(shots);
  assert.deepEqual([view.standby, view.blank, view.zongguan, view.directory, view.codex, view.history, view.approval, view.minimized,
    view.restored], ['0:0', '4:0', '1:0', '2:0', '1:0', '1:0', '1:1', '1:2', '1:1'], 'each shot is taken on the screen it is named after');
});

/* ---------- gateway: the latest session of each agent, and what is said to it ---------- */

async function lensGateway(t, history = async () => [], extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-lens-test-'));
  const state = new State(join(dir, 'events.sqlite'));
  const sent = [];
  const glasses = new SpareGlasses(state, { history, submit: async (...args) => { sent.push(args.slice(0, 3)); }, ...extra });
  t.after(async () => {
    glasses.close();
    state.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { state, glasses, sent };
}

test('the rail lists 总管 then each enabled agent with its glyph, in relay setup\'s order', async (t) => {
  const { state, glasses } = await lensGateway(t, async () => [], { agents: ['dsh', 'codex'] });
  state.put('codex', 's1', { status: 'running', updatedAt: 1000, capabilities: ['history', 'send'] });
  state.put('claude', 'k1', { status: 'running', updatedAt: 2000, capabilities: ['history', 'send'] });
  const now = glasses.now();
  assert.equal(now.g, 'o0' + '4o0' + '0r1', '总管 off, DeepSeek offline, Codex working; Claude is not enabled');
  assert.equal(now.v.length, 2 + 2 * 2 + 1, 'versions for 总管 and two agents, then "0": nobody said anything yet');
  assert.equal(now.v.slice(2, 4), '00', 'DeepSeek has no session');
  assert.notEqual(now.v.slice(4, 6), '00', 'Codex does');
});

test('the lens reads only the newest session of an agent, and what you say to a busy Codex waits for the turn', async (t) => {
  const history = async (agent, id) => (id === 's2' ? [
    { id: 'u', role: 'user', text: '<system-reminder>skip</system-reminder>跑一遍测试', at: 1 },
    { id: 'a', role: 'assistant', text: '**全部通过**\n\n一共 44 个。', at: 2 },
  ] : []);
  const { state, glasses, sent } = await lensGateway(t, history);
  state.put('codex', 's1', { status: 'idle', updatedAt: 1000, capabilities: ['history', 'send'] });
  state.put('codex', 's2', { status: 'running', updatedAt: 2000, capabilities: ['history', 'send'] });
  state.put('codex', 'helper', { status: 'idle', updatedAt: 3000, cwd: '/Users/x/.vibe-island/run', capabilities: ['history', 'send'] });
  assert.equal(glasses.latest('codex').id, 's2', 'helper sessions do not count');

  const page = await glasses.page('c0');
  assert.equal(page.i.slice(0, 3), 'wqr', 'writable, queues, working');
  assert.deepEqual([page.d1, page.d2, page.d3], ['v跑一遍测试', 'j全部通过', 'b一共 44 个。'], 'your words, then a bold line and a plain one, a reply starting a new block');

  assert.deepEqual(await glasses.say('c', { text: '再补一个测试' }), { st: 'queued', h: '这轮结束后发' });
  assert.deepEqual(sent, [], 'nothing reaches Codex mid-turn');
  glasses.lensCache.clear();
  assert.equal((await glasses.page('c0')).d4, 'r再补一个测试', 'the queued line shows on the page');
  state.put('codex', 's2', { status: 'idle' });
  await delay(20);
  assert.deepEqual(sent, [['codex', 's2', '再补一个测试']], 'it goes out when the turn ends');

  state.put('muse', 'm1', { status: 'running', updatedAt: 1, capabilities: ['history', 'send'] });
  assert.equal((await glasses.say('m', { text: '在吗' })).st, 'sent', 'Muse takes it right away');
  state.put('grok', 'g1', { status: 'idle', updatedAt: 1, capabilities: ['history'] });
  assert.equal((await glasses.say('g', { text: '你好' })).st, 'ro');
  assert.equal((await glasses.page('g0')).i.slice(0, 2), 'rd');
});

test('a page says how far up the newest reply starts, so a long one reads from its first line', async (t) => {
  let rows = [
    { id: 'u', role: 'user', text: '讲讲', at: 1 },
    { id: 'a', role: 'assistant', text: '一\n\n二\n\n三\n\n四\n\n五\n\n六', at: 2 },
  ];
  const { state, glasses } = await lensGateway(t, async () => rows);
  state.put('muse', 'm1', { status: 'idle', updatedAt: 1, capabilities: ['history', 'send'] });
  const head = async () => { glasses.transcripts.clear(); glasses.lensCache.clear(); return (await glasses.page('m0')).i.slice(16, 19); };
  // Six lines up from the newest: 一 is 5 rows up. Rows 5 to 3 fill the 128 pixels (3×30 + 2 paragraph gaps of 5).
  assert.equal(await head(), '003');
  rows = [rows[0], { ...rows[1], text: '一\n\n二' }];
  assert.equal(await head(), '000', 'a reply that fits stays at the bottom');
  rows = [...rows, { id: 'u2', role: 'user', text: '好', at: 3 }];
  assert.equal(await head(), '000', 'the newest message is yours');
});

test('asleep, the gateway pushes nothing to the glasses until they ask again', async (t) => {
  const { state, glasses } = await lensGateway(t);
  state.set('spareApp', 'dev.test.relay');
  const sent = [];
  const emit = glasses.emit.bind(glasses);
  glasses.emit = (event, data, id) => { sent.push(event); return emit(event, data, id); };
  assert.deepEqual(await glasses.app('act', 'POST', new URLSearchParams('k=zz'), {}), { st: 'ok', h: '', _err: '' });
  state.put('muse', 'm1', { status: 'running', updatedAt: Date.now(), capabilities: ['history', 'send'] });
  state.addRequest('muse', 'm1', { kind: 'approval', title: 'Tool approval', approvalAllowed: true }, () => {});
  await delay(1300);
  assert.deepEqual(sent, [], 'no data and no notification while the lens is blank');
  await glasses.app('now', 'GET', new URLSearchParams(), {});
  state.put('muse', 'm1', { status: 'idle' });
  await delay(1300);
  assert.ok(sent.includes('spare.data'), 'any other request wakes it');
  assert.ok(!sent.includes('spare.notify'), 'the approval that came while asleep is not notified late');
});

test('the page stays on the session you read and speech goes to it', async (t) => {
  const { state, glasses, sent } = await lensGateway(t);
  state.put('muse', 'm1', { status: 'idle', updatedAt: 1000, capabilities: ['history', 'send'] });
  state.put('muse', 'm2', { status: 'idle', updatedAt: 500, capabilities: ['history', 'send'] });
  const first = await glasses.page('m0');
  const code = first.i.slice(12, 16);
  assert.equal(code, glasses.sessionCode('muse:m1'), 'it opens on the latest session');
  assert.equal(first.i.length, 19);
  const before = glasses.versions().slice(4, 6);

  state.put('muse', 'm2', { status: 'idle', updatedAt: Date.now() + 50 });
  assert.equal(glasses.latest('muse').id, 'm2');
  assert.equal(glasses.versions().slice(4, 6), before, 'the page keeps its version: the other session\'s words come as an update card');
  const kept = await glasses.page('m0s' + code);
  assert.equal(kept.i.slice(12, 16), code, 'the page stays on the session it shows');

  assert.equal((await glasses.say('ms' + code, { text: '接着说' })).st, 'sent');
  assert.deepEqual(sent.at(-1), ['muse', 'm1', '接着说'], 'speech goes to the session on screen, not the newer one');
  assert.deepEqual(await glasses.say('mszzzz', { text: '在吗' }), { st: 'gone', h: '这个会话已经不在了' });
  assert.equal(sent.length, 1, 'a session that is gone gets nothing, and nothing goes elsewhere');

  const moved = await glasses.page('m0x' + code);
  assert.equal(moved.i.slice(12, 16), glasses.sessionCode('muse:m2'), 'x moves to the agent\'s other session');

  state.addRequest('muse', 'm1', { kind: 'approval', title: 'Tool approval', approvalAllowed: true }, () => {});
  const ask = glasses.requestCode([...state.requests.values()].at(-1));
  assert.equal((await glasses.page('m0r' + ask.slice(2))).i.slice(12, 16), code, 'reading history from a popup shows the session asking');
});

test('speech in pieces waits on the Mac until the glasses say it is over, then goes out as one message', async (t) => {
  const { state, glasses, sent } = await lensGateway(t);
  state.put('muse', 'm1', { status: 'idle', updatedAt: 1000, capabilities: ['history', 'send'] });
  const code = glasses.sessionCode('muse:m1');
  assert.deepEqual(await glasses.say('-ms' + code, { text: '先跑测试' }), { st: 'held', h: '先跑测试' });
  assert.deepEqual(await glasses.say('.ms' + code, { text: '再部署' }), { st: 'held', h: '先跑测试，再部署' });
  assert.equal(sent.length, 0, 'nothing goes out while the wearer is still talking');
  assert.equal((await glasses.act('-ms' + code)).st, 'sent');
  assert.deepEqual(sent.at(-1), ['muse', 'm1', '先跑测试，再部署']);
  assert.deepEqual(await glasses.act('-ms' + code), { st: 'empty', h: '没听到内容' }, 'it goes out once');
  // A round that heard nothing, if the phone still posts it, ends the message instead of listening forever.
  await glasses.say('-ms' + code, { text: '先停一下' });
  assert.equal((await glasses.say('.ms' + code, { text: '' })).st, 'sent');
  assert.deepEqual(sent.at(-1), ['muse', 'm1', '先停一下']);
  // A new utterance starts over: what a cancelled one left behind is dropped.
  await glasses.say('-ms' + code, { text: '算了' });
  await glasses.say('-ms' + code, { text: '在吗' });
  await glasses.act('-ms' + code);
  assert.deepEqual(sent.at(-1), ['muse', 'm1', '在吗']);
  // The lens shows the end of a long utterance.
  const long = await glasses.say('-ms' + code, { text: '一二三四五六七八九十'.repeat(5) });
  assert.ok(bytes(long.h) <= 63 && long.h.endsWith('九十'), long.h);
});

test('a working session\'s page says what it does: the live tool, else the last tool call, else thinking', async (t) => {
  let rows = [{ id: 'u', role: 'user', text: '跑测试', at: 1 }];
  const { state, glasses } = await lensGateway(t, async () => rows);
  state.put('claude', 'k1', { status: 'running', updatedAt: 1, capabilities: ['history', 'send'] });
  const action = async () => { glasses.transcripts.clear(); glasses.lensCache.clear(); return (await glasses.page('k0')).i.slice(19); };
  assert.equal(await action(), '在想…');
  rows = [...rows, { id: 't', role: 'tool', tool: { type: 'dynamicToolCall', tool: 'Read', detail: 'spare.mjs' } }];
  assert.equal(await action(), '读 spare.mjs', 'the last tool call in the transcript');
  const before = glasses.versions();
  state.transient('action', 'claude', 'k1', { tool: { type: 'commandExecution',
    command: "/bin/zsh -lc 'npm test -- --test-name-pattern \"一个特别长的测试名字，长到一行放不下\"'" } });
  assert.notEqual(glasses.versions(), before, 'a live action makes the glasses read the page');
  const live = await action();
  assert.match(live, /^运行 npm test .*…$/, 'the live tool wins, cut with an ellipsis');
  assert.ok(Buffer.byteLength(live) <= 47);
  state.transient('action', 'claude', 'k1', { tool: null });
  state.put('claude', 'k1', { status: 'idle' });
  assert.equal(await action(), '', 'nothing once it is done');
});

test('update cards come one session at a time, oldest first, leaving out the session on screen', async (t) => {
  const { state, glasses } = await lensGateway(t);
  state.put('codex', 'c1', { name: '部署脚本', status: 'idle', updatedAt: 1, capabilities: ['history', 'send'] });
  state.put('claude', 'k1', { name: 'relay 网关', status: 'idle', updatedAt: 1, capabilities: ['history', 'send'] });
  state.put('codex', 'helper', { name: '摘要', status: 'idle', updatedAt: 1, cwd: '/Users/x/.vibe-island/run', capabilities: [] });
  const say = (key, text, kind = 'said') => glasses.add({ key, agent: key.split(':')[0], kind, text });
  const ask = (k) => glasses.app('ask', 'GET', new URLSearchParams({ k }));
  say('codex:c1', '先跑一遍测试。');
  say('claude:k1', '## 结论\n\nREADME 已经更新，部署说明里加了提交号标签的用法，另外顺手修了两个错别字，还把过时的截图换掉了，最后检查了一遍所有链接都能打开。');
  say('codex:c1', '测试全部通过。');
  say('codex:helper', '摘要');
  say('claude:k1', '你接着说', 'me');
  const newest = 3; // the helper's words and yours are not updates
  assert.equal(Number(glasses.now().v.slice(13)), newest, 'now carries the seq of the newest words, a helper\'s left out');

  const first = await ask('u----0');
  assert.equal(first.k, 'u1' + glasses.sessionCode('claude:k1'), 'Claude waited longest: Codex spoke again after it');
  assert.equal(first.i, 'U22', 'two sessions wait; this is item 2');
  assert.equal(first.h, 'Claude · relay 网关');
  assert.deepEqual([first.d1, first.d2 !== '', first.d3.endsWith('…')], ['结论', true, true], 'three lines, the rest cut');
  assert.match(first.d4, /^Claude：结论$/);
  for (const key of ['h', 'd1', 'd2', 'd3', 'd4']) assert.ok(Buffer.byteLength(first[key]) <= 63, key + ' over 63 bytes');

  const second = await ask('u----2');
  assert.deepEqual([second.k, second.i, second.d1], ['u0' + glasses.sessionCode('codex:c1'), 'U13', '测试全部通过。'],
    'then Codex, with its newest words only');
  const onScreen = await ask('u' + glasses.sessionCode('codex:c1') + '2');
  assert.deepEqual([onScreen.k, onScreen.i], ['', 'U0' + newest], 'the session on screen is no news; the glasses catch up');
  assert.equal((await ask('u----' + newest)).k, '', 'nothing after the newest');

  state.addRequest('codex', 'c1', { kind: 'approval', title: 'Run a command', command: 'ls', approvalAllowed: true }, () => {});
  await delay(5);
  state.addRequest('claude', 'k1', { kind: 'approval', title: 'Run a command', command: 'pwd', approvalAllowed: true }, () => {});
  const newestAsk = glasses.now().k;
  assert.equal(newestAsk[1], '1', 'the newest question of any session');
  assert.match((await ask(newestAsk.slice(2))).h, / · 还有 1 个$/, 'and how many more wait');
});

test('the directory lists every agent\'s sessions newest first, and speech can start a new session', async (t) => {
  const created = [];
  const { state, glasses } = await lensGateway(t, async () => [], {
    canCreate: (agent) => agent !== 'grok', create: async (agent, text) => { created.push([agent, text]); } });
  const now = Date.now();
  state.put('codex', 'c1', { name: '部署脚本', status: 'idle', updatedAt: now - 2 * 3600000, capabilities: ['history', 'send'] });
  state.put('grok', 'g1', { name: '日报 bot', status: 'running', updatedAt: now - 60000, capabilities: ['history', 'send'] });
  state.put('claude', 'k1', { name: '一个名字非常非常长的会话，长到一行放不下，后面还有很多字', status: 'idle', updatedAt: now - 5000,
    capabilities: ['history', 'send'] });
  state.put('codex', 'old', { name: '很久以前', status: 'idle', updatedAt: now - 20 * 86400000, capabilities: ['history'] });
  state.put('codex', 'helper', { name: '摘要', status: 'idle', updatedAt: now, cwd: '/Users/x/.vibe-island/run', capabilities: [] });
  state.addRequest('codex', 'c1', { kind: 'approval', title: 'Run a command', approvalAllowed: true }, () => {});

  const dir = await glasses.directory('0');
  assert.equal(dir.i, 'D004000000', '新建会话, then three sessions: no helper, nothing older than 14 days');
  assert.deepEqual([dir.d1, dir.d9], ['+n----新建会话', '单击选 Agent，说话开新会话'], 'the first row starts a new session');
  assert.deepEqual([dir.d2.slice(0, 2), dir.d3.slice(0, 2), dir.d4.slice(0, 2)], ['0w', '1i', '3r'],
    'newest first, a question counting as activity: Codex waits, Claude, then Grok running');
  assert.equal(dir.d2.slice(2, 6), glasses.sessionCode('codex:c1'));
  assert.match(dir.d2, /部署脚本 · 等你$/);
  assert.match(dir.d4, /日报 bot · 在跑$/);
  assert.match(dir.d3, / · 刚刚$/, 'a long name is cut, never the state');
  for (let k = 1; k <= 16; k++) assert.ok(Buffer.byteLength(dir['d' + k]) <= 63, 'd' + k + ' over 63 bytes');
  assert.equal(dir.d5, '');
  assert.equal((await glasses.directory('s' + glasses.sessionCode('grok:g1'))).i, 'D004000003', 'landing on a session by its code');

  assert.deepEqual(await glasses.say('cn', { text: '新开一个' }), { st: 'sent', h: '已开始新会话' });
  assert.deepEqual(await glasses.say('mn', { text: '另起一条' }), { st: 'sent', h: '已开始新对话' });
  assert.equal((await glasses.say('gn', { text: '你好' })).st, 'fail');
  assert.deepEqual(created, [['codex', '新开一个'], ['muse', '另起一条']]);
});

test('what an agent says mid-turn changes its page version, so the glasses read it before the turn ends', async (t) => {
  const { state, glasses } = await lensGateway(t);
  state.put('claude', 'k1', { status: 'running', updatedAt: 1, capabilities: ['history'] });
  const before = glasses.now().v;
  state.event('activity', 'claude', 'k1');
  const after = glasses.now().v;
  assert.notEqual(after.slice(4, 6), before.slice(4, 6), 'Claude\'s pair changes (after 总管\'s and Codex\'s)');
  assert.equal(after.slice(0, 4), before.slice(0, 4), 'the others stay');
  assert.equal((await glasses.page('k0')).v, after.slice(0, 12), 'the page carries the same versions');
});

test('a question from Claude Code is answered on the glasses by choosing an option or by saying it', async (t) => {
  const { state, glasses } = await lensGateway(t);
  const id = '66666666-6666-4666-8666-666666666666';
  state.put('claude', id, { status: 'running', updatedAt: 1, capabilities: ['history'], live: true });
  const observer = new ClaudeObserver(state, tmpdir(), { leases: new Map() }, null);
  const ask = (question, options) => observer.hook({ session_id: id, hook_event_name: 'PermissionRequest', tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question, header: '颜色', multiSelect: false, options: options.map((label) => ({ label })) }] } });
  const chosen = ask('选哪个颜色？', ['红', '绿', '蓝']);
  const code = glasses.requestCode(glasses.requestOf(glasses.latest('claude'))).slice(2);
  const view = glasses.askView(code);
  assert.deepEqual([view.h, view.d1, view.d4, view.d5, view.d6, view.i], ['Claude · 颜色', '选哪个颜色？', '红', '绿', '蓝', '301']);
  assert.deepEqual(await glasses.act(code + '3'), { st: 'ok', h: '已选：蓝' });
  assert.deepEqual((await chosen).hookSpecificOutput.decision.updatedInput.answers, { '选哪个颜色？': '蓝' });

  const spoken = ask('叫什么名字？', ['Relay', 'Lens']);
  const next = glasses.requestCode(glasses.requestOf(glasses.latest('claude'))).slice(2);
  assert.deepEqual(await glasses.say('a' + next, { text: '就叫 Halo' }), { st: 'ok', h: '已回答' });
  assert.deepEqual((await spoken).hookSpecificOutput.decision.updatedInput.answers, { '叫什么名字？': '就叫 Halo' });
});

test('an approval can allow the rest of a Codex session; other agents have no such mode', async (t) => {
  const { state, glasses } = await lensGateway(t);
  state.put('codex', 's1', { status: 'approval', updatedAt: 1, capabilities: ['history', 'send', 'approval'] });
  state.put('claude', 'k1', { status: 'approval', updatedAt: 1, capabilities: ['history', 'approval'] });
  const decisions = [];
  state.addRequest('codex', 's1', { kind: 'approval', title: 'Run a command', command: 'npm test' }, async (value) => { decisions.push(value); });
  state.addRequest('claude', 'k1', { kind: 'approval', title: 'Run a command', command: 'ls' }, async (value) => { decisions.push(value); });
  const codex = glasses.requestOf(glasses.latest('codex'));
  const claude = glasses.requestOf(glasses.latest('claude'));
  const codexId = glasses.requestCode(codex).slice(2);
  const ask = glasses.askView(codexId);
  assert.equal(ask.i, '011', 'no options, auto mode offered, allowed');
  assert.equal(glasses.askView(glasses.requestCode(claude).slice(2)).i, '001');
  assert.deepEqual(await glasses.act(glasses.requestCode(claude).slice(2) + 'a'), { st: 'fail', h: '这里没有自动模式' });
  assert.deepEqual(await glasses.act(codexId + 'a'), { st: 'ok', h: '本会话都允许' });
  assert.deepEqual(decisions, [{ decision: 'acceptForSession' }]);
  assert.deepEqual(await glasses.act(codexId + 'y'), { st: 'gone', h: '已经处理过了' });
});

test('every answer and push to the glasses carries an empty _err, so a failure before it does not stick', async (t) => {
  const { state, glasses } = await lensGateway(t);
  for (const [route, k] of [['now', ''], ['lens', 'c0'], ['top', ''], ['feed', '']]) {
    assert.equal((await glasses.app(route, 'GET', new URLSearchParams({ k })))._err, '', route);
  }
  state.set('spareApp', 'dev.spare18.relay');
  assert.equal(glasses.dataFrame().values._err, '');
  for (const request of manifest.requests.filter(({ kind }) => kind === 'agent')) {
    assert.equal(request.fields._err, '_err', request.name + ' writes _err from every answer');
  }
});

test('DeepSeek is the fifth agent: its column, its page, speech that waits for the turn, approvals without auto mode', async (t) => {
  let rows = [{ id: 'u1', role: 'user', text: '跑一下测试', at: 1000 }];
  const created = [];
  const { state, glasses, sent } = await lensGateway(t, async () => rows,
    { canCreate: () => true, create: async (agent, text) => { created.push([agent, text]); } });
  assert.equal(glasses.now().g.length, 17, '总管 first, then five agents of three characters each');
  assert.equal(glasses.versions().length, 12);
  assert.equal(glasses.now().g.slice(14, 17), '4o0', 'DeepSeek offline: dim, nothing running');
  assert.deepEqual(await glasses.say('d', { text: '在吗' }), { st: 'fail', h: '还没有会话' });

  state.put('dsh', 'd1', { name: '修部署', status: 'running', updatedAt: Date.now(), live: true, capabilities: ['history', 'send', 'interrupt'] });
  assert.equal(glasses.now().g.slice(15, 16), 'r');
  assert.equal((await glasses.page('d0')).i.slice(0, 3), 'wqr', 'writable, queues, working');
  state.put('dsh', 'd1', { name: '帮我检查一下部署脚本里镜像标签为什么总是latest然后修好它' });
  glasses.lensCache.clear();
  const title = (await glasses.page('d0')).h;
  assert.equal(wrap(title, 15, Infinity, 296).length, 1, 'the title fits the header right of the wider capsule: ' + title);
  assert.match(title, /…$/);
  assert.deepEqual(await glasses.say('d', { text: '接着做' }), { st: 'queued', h: '这轮结束后发' });
  assert.deepEqual(sent, [['dsh', 'd1', '接着做']], 'dsh queues it itself, so it goes out now');
  glasses.transcripts.clear(); glasses.lensCache.clear();
  assert.ok(Object.values(await glasses.page('d0')).includes('r接着做'), 'the waiting line shows on the page');
  rows = [...rows, { id: 'u2', role: 'user', text: '接着做', at: Date.now() + 1000 }];
  glasses.transcripts.clear(); glasses.lensCache.clear();
  assert.ok(!Object.values(await glasses.page('d0')).includes('r接着做'), 'once dsh logs it, the waiting line goes');

  state.addRequest('dsh', 'd1', { kind: 'approval', title: 'Run a command', command: 'rm -rf build', approvalAllowed: true }, () => {});
  const code = glasses.requestCode(glasses.requestOf(glasses.latest('dsh'))).slice(2);
  assert.equal(glasses.askView(code).i, '001', 'no options, no auto mode, allowed');
  assert.deepEqual(await glasses.act(code + 'a'), { st: 'fail', h: '这里没有自动模式' });

  const dir = await glasses.directory('0');
  assert.equal(dir.d2.slice(2, 6), glasses.sessionCode('dsh:d1'));
  assert.equal(dir.d2.slice(0, 1), '4', 'DeepSeek\'s glyph leads the row');
  assert.deepEqual(await glasses.say('dn', { text: '新开' }), { st: 'sent', h: '已开始新会话' });
  assert.deepEqual(created, [['dsh', '新开']]);
});

test('Hermes on the lens: its glyph, speech that waits for the turn, allow-for-session when Hermes offers it, clarify without speech', async (t) => {
  const { state, glasses, sent } = await lensGateway(t, async () => [], { agents: ['codex', 'hermes'] });
  assert.equal(glasses.now().g.length, 8);
  assert.equal(glasses.now().g.slice(5, 6), '6', 'Hermes in the second slot');
  state.put('hermes', 'h1', { name: '整理下载', status: 'running', updatedAt: Date.now(), live: true, capabilities: ['history', 'send', 'interrupt'] });
  assert.equal((await glasses.page('h0')).i.slice(0, 3), 'wqr', 'writable, queues, working');
  assert.deepEqual(await glasses.say('h', { text: '接着' }), { st: 'queued', h: '这轮结束后发' });
  assert.deepEqual(sent, [['hermes', 'h1', '接着']], 'the adapter queues it itself');

  const decisions = [];
  state.addRequest('hermes', 'h1', { kind: 'approval', title: 'Modify files', command: '/r/README.md', approvalAllowed: true,
    sessionAllowed: true }, async (value) => { decisions.push(value); });
  const code = glasses.requestCode(glasses.requestOf(glasses.latest('hermes'))).slice(2);
  assert.equal(glasses.askView(code).i, '011', 'allow for the session, as Hermes offered');
  assert.deepEqual(await glasses.act(code + 'a'), { st: 'ok', h: '本会话都允许' });
  assert.deepEqual(decisions, [{ decision: 'acceptForSession' }]);

  state.addRequest('hermes', 'h1', { kind: 'approval', title: 'Run a command', command: 'ls', approvalAllowed: true,
    sessionAllowed: false }, async () => {});
  const once = glasses.requestCode(glasses.requestOf(glasses.latest('hermes'))).slice(2);
  assert.equal(glasses.askView(once).i, '001');
  assert.deepEqual(await glasses.act(once + 'a'), { st: 'fail', h: '这里没有自动模式' });
  await glasses.act(once + 'n');

  state.addRequest('hermes', 'h1', { kind: 'input', title: 'Hermes needs an answer', spoken: false,
    questions: [{ id: 'q1', title: '', text: '用哪个分支？', multiple: false, options: ['main', 'dev'] }] }, async () => {});
  const question = glasses.requestCode(glasses.requestOf(glasses.latest('hermes'))).slice(2);
  assert.equal(glasses.askView(question).i, '200', 'two choices, no spoken answer');
});

/* ---------- text layout ---------- */

/* ---------- 总管 on the glasses ---------- */

class StubZongguan extends EventEmitter {
  constructor({ enabled = true } = {}) {
    super();
    this.enabled = enabled;
    this.reports = [];
    this.unread = false;
    this.heard = [];
    this.confirmed = [];
    this.read = 0;
    this.state = { status: enabled ? 'idle' : 'off', since: Date.now(), contextPct: 12, openTasks: 2, card: null, blocks: [
      { kind: 'user', text: '现在都在干嘛', at: 1 },
      { kind: 'tool', text: '读 Codex·relay部署脚本', at: 2 },
      { kind: 'detail', text: 'Claude · 眼镜胶囊 · 运行中', at: 3 },
      { kind: 'reply', text: 'Codex 在改部署脚本，Claude 空闲。', at: 4 },
      { kind: 'compacted', text: '— 已压缩 · 前 2 小时记成 5 行摘要 —', at: 5 },
      { kind: 'error', text: '总管出错了：OpenCode answered 500', at: 6 },
    ] };
  }
  view() { return this.state; }
  adviceFor(id) { return this.advice?.get(id) ?? null; }
  async hear(text, from) { this.heard.push([text, from]); return { st: 'sent', h: '总管收到' }; }
  async confirm(confirmId, yes) { this.confirmed.push([confirmId, yes]); return { st: 'ok', h: yes ? '好，去办了' : '不办了' }; }
  menu() { this.state = { ...this.state, card: { kind: 'choices', choiceId: 'm1', options: ['现在都在干嘛', '跟进今天没结果的', '不用了'] } }; return { st: 'ok', h: '选一个' }; }
  async choose(choiceId, n) { this.chosen = [...(this.chosen ?? []), [choiceId, n]]; return { st: 'sent', h: '总管收到' }; }
  markRead() { this.read += 1; this.unread = false; }
  publishReport(text) {
    this.reports = [...this.reports, { seq: (this.reports.at(-1)?.seq ?? 0) + 1, text, at: Date.now() }];
    this.unread = true;
    this.emit('change');
  }
}

test('the z page shows 总管\'s blocks as lens lines with its status in the header', async (t) => {
  const zongguan = new StubZongguan();
  const { glasses } = await lensGateway(t, undefined, { zongguan });
  const page = await glasses.page('z0');
  assert.equal(page.h, '总管 · 2 件事 · 上下文 12%');
  assert.equal(page.i.slice(0, 3), 'wdi', 'writable, takes speech at once, idle');
  assert.equal(page.i.slice(12, 16), 'zg00');
  const lines = Object.keys(page).filter((key) => /^d\d+$/.test(key)).map((key) => page[key]).filter(Boolean);
  assert.deepEqual(lines, ['v现在都在干嘛', 'cCodex 在改部署脚本，Claude 空闲。', 'a— 已压缩 · 前 2 小时记成 5 行摘要 —',
    'h✗ 总管出错了：OpenCode answered 500'], 'what 总管 looked at and sent is not shown');
  assert.equal(zongguan.read, 1, 'opening the page marks the reports read');

  zongguan.state = { ...zongguan.state, status: 'working', since: Date.now() - 3000 };
  const busy = await glasses.page('z0');
  assert.equal(busy.i[2], 'r');
  assert.match(busy.i.slice(19), /^整理中… \ds$/);

  const off = new StubZongguan({ enabled: false });
  const { glasses: dark } = await lensGateway(t, undefined, { zongguan: off });
  assert.equal((await dark.page('z0')).h, '总管没配好');
  assert.equal((await dark.page('z0')).i[2], 'o');
});

test('总管\'s page shows its replies whole and your words in one line, without what it looked at or sent', async (t) => {
  const zongguan = new StubZongguan();
  zongguan.state = { ...zongguan.state, blocks: [
    { kind: 'user', text: '和 Claude 说一下，总管说完话不要立马结束，然后让我自己按按钮结束，顺便把测试也看一下，再看看部署脚本', at: 1 },
    { kind: 'tool', text: '看所有会话', at: 2 },
    { kind: 'detail', text: 'Claude · 眼镜胶囊 · 运行中', at: 3 },
    { kind: 'reply', text: '✓ 网关重启好了：两轮听写和总管页一行结论都生效了，眼镜 App 不用重装。\n\n别的以后再说。', at: 4 },
  ] };
  const { glasses } = await lensGateway(t, undefined, { zongguan });
  const page = await glasses.page('z0');
  const lines = Object.keys(page).filter((key) => /^d\d+$/.test(key)).map((key) => page[key]).filter(Boolean);
  assert.equal(lines[0][0], 'v');
  assert.ok(lines[0].endsWith('…') && lines[1][0] !== 'u', 'your words take one line: ' + lines[0]);
  const reply = lines.slice(1).map((line) => line.slice(1)).join('').replace(/\s/g, '');
  assert.ok(reply.includes('眼镜App不用重装') && reply.includes('别的以后再说'), 'the reply shows whole: ' + reply);
  assert.ok(!lines.some((line) => line.includes('看所有会话') || line.includes('眼镜胶囊')));
});

test('speech on the z page goes to 总管', async (t) => {
  const zongguan = new StubZongguan();
  const { glasses } = await lensGateway(t, undefined, { zongguan });
  assert.deepEqual(await glasses.say('z', { text: '现在都在干嘛' }), { st: 'sent', h: '总管收到' });
  assert.deepEqual(await glasses.say('zszg00', { text: '再看看' }), { st: 'sent', h: '总管收到' });
  assert.deepEqual(zongguan.heard, [['现在都在干嘛', 'glasses'], ['再看看', 'glasses']]);
});

test('a card carries 总管\'s advice in its third line and stars the option, leaving the choices as they were', async (t) => {
  const zongguan = new StubZongguan();
  const { state, glasses } = await lensGateway(t, undefined, { zongguan });
  state.put('codex', 's1', { status: 'approval', updatedAt: 1, capabilities: ['history', 'send', 'approval'] });
  state.put('claude', 'k1', { status: 'input', updatedAt: 1, capabilities: ['history', 'send'] });
  const id = state.addRequest('codex', 's1', { kind: 'approval', title: 'Run a command', command: 'npm test',
    description: '先跑一遍单元测试，再跑一遍集成测试，最后把覆盖率报告写到 coverage 目录里，跑完告诉你结果' }, () => {});
  const q = state.addRequest('claude', 'k1', { kind: 'input', title: 'Claude needs an answer',
    questions: [{ id: 'q1', text: '用哪个?', options: ['A', 'B'] }] }, () => {});
  const plain = glasses.askView(glasses.requestCode(state.requests.get(id)).slice(2));
  assert.notEqual(plain.d3.slice(0, 3), '建议：');
  zongguan.advice = new Map([[id, { decision: 'allow', reason: '只跑测试' }], [q, { option: 2, reason: 'B 改动小' }]]);
  const ask = glasses.askView(glasses.requestCode(state.requests.get(id)).slice(2));
  assert.equal(ask.d1, plain.d1);
  assert.equal(ask.d2, plain.d2);
  assert.equal(ask.d3, '建议：允许 · 只跑测试');
  assert.equal(ask.i, plain.i, 'the choices stay as they were');
  const question = glasses.askView(glasses.requestCode(state.requests.get(q)).slice(2));
  assert.equal(question.d3, '建议：选 2 · B 改动小');
  assert.deepEqual([question.d4, question.d5], ['A', '★ B']);
  zongguan.enabled = false;
  assert.equal(glasses.askView(glasses.requestCode(state.requests.get(q)).slice(2)).d5, 'B', 'with 总管 off there is no advice');
});

test('a confirm card pops up on the z page and a click answers it', async (t) => {
  const zongguan = new StubZongguan();
  zongguan.state = { ...zongguan.state, card: { kind: 'confirm', confirmId: 'c1', text: '在 relay 新开 Codex 会话：跑测试' } };
  const { glasses } = await lensGateway(t, undefined, { zongguan });
  const page = await glasses.page('z0');
  assert.match(page.k, /^i5[0-9a-z]{4}$/, 'a choice from 总管');
  assert.equal(glasses.now().k, page.k, 'standby and pushes carry it, which is where the glasses read attention codes');
  const view = glasses.askView(page.k.slice(2));
  assert.equal(view.k, page.k);
  assert.equal(view.h, '总管 · 要你点头');
  assert.equal(view.d1, '在 relay 新开 Codex 会话：跑测试');
  assert.deepEqual([view.d4, view.d5, view.i], ['好', '不要', '200']);
  assert.deepEqual(await glasses.act(page.k.slice(2) + '1'), { st: 'ok', h: '好，去办了' });
  assert.deepEqual(await glasses.act(page.k.slice(2) + 'n'), { st: 'ok', h: '不办了' });
  assert.deepEqual(zongguan.confirmed, [['c1', true], ['c1', false]]);
});

test('clicking on the z page and saying nothing brings up 总管\'s options; a click picks one', async (t) => {
  const zongguan = new StubZongguan();
  const { glasses } = await lensGateway(t, undefined, { zongguan });
  assert.deepEqual(await glasses.say('-z', { text: '' }), { st: 'held', h: '' });
  assert.deepEqual(await glasses.say('.z', { text: '' }), { st: 'ok', h: '选一个' }, 'two empty rounds call the options up');
  assert.deepEqual(zongguan.heard, [], 'nothing was said to 总管');
  const page = await glasses.page('z0');
  assert.match(page.k, /^i5[0-9a-z]{4}$/);
  assert.equal(glasses.now().k, page.k);
  const view = glasses.askView(page.k.slice(2));
  assert.equal(view.h, '总管 · 选一件');
  assert.deepEqual([view.d4, view.d5, view.d6, view.d7, view.i], ['现在都在干嘛', '跟进今天没结果的', '不用了', '', '300'], 'no spoken answer');
  assert.deepEqual(await glasses.act(page.k.slice(2) + '2'), { st: 'sent', h: '总管收到' });
  assert.deepEqual(zongguan.chosen, [['m1', 2]]);
  assert.deepEqual(await glasses.act(page.k.slice(2) + 'y'), { st: 'fail', h: '选一项' });
  assert.deepEqual(await glasses.say('c', { text: '' }), { st: 'empty', h: '没听到内容' }, 'other pages are unchanged');
});

test('while 总管 is on, standby cards carry only its reports', async (t) => {
  const history = async () => [{ id: 'a1', role: 'assistant', text: '测试都过了。', at: Date.now() }];
  const zongguan = new StubZongguan();
  const { state, glasses } = await lensGateway(t, history, { zongguan });
  state.put('codex', 's1', { status: 'idle', updatedAt: Date.now(), capabilities: ['history', 'send'] });
  await glasses.refresh('codex:s1', 'last');
  assert.equal(glasses.now().h, '', 'a session\'s words make no card');
  assert.equal(glasses.card('u----0').k, '');
  zongguan.publishReport('Codex 部署脚本改完了，测试全过。');
  const now = glasses.now();
  assert.equal(now.h, 'Codex 部署脚本改完了，测试全过。');
  assert.equal(now.v[12], '5', 'the glyph of 总管');
  const card = glasses.card('u----0');
  assert.equal(card.k, 'u5zg00');
  assert.equal(card.h, '总管 · 汇报');
  assert.equal(glasses.card('uzg000').k, '', 'on its own page the report needs no card');
  assert.equal(glasses.now().g.slice(0, 2), 'w0', 'an unread report');
});

test('g and v carry 总管 first and, with five agents, the update seq at index 13', async (t) => {
  const history = async () => [{ id: 'a1', role: 'assistant', text: '好了。', at: Date.now() }];
  const { state, glasses } = await lensGateway(t, history);
  state.put('codex', 's1', { status: 'idle', updatedAt: Date.now(), capabilities: ['history', 'send'] });
  await glasses.refresh('codex:s1', 'last');
  const now = glasses.now();
  assert.equal(now.g.length, 17);
  assert.equal(now.g.slice(0, 2), 'o0', 'no 总管: dim');
  assert.equal(glasses.versions().length, 12);
  assert.equal(now.v[12], '0');
  assert.equal(Number(now.v.slice(13)), glasses.feedSeq);

  const zongguan = new StubZongguan();
  const { glasses: withZg } = await lensGateway(t, undefined, { zongguan });
  const before = withZg.versions().slice(0, 2);
  zongguan.state = { ...zongguan.state, blocks: [...zongguan.state.blocks, { kind: 'reply', text: '又一句', at: 7 }] };
  assert.notEqual(withZg.versions().slice(0, 2), before, '总管\'s page version moves with its view');
});

test('with 总管 off, cards work as before', async (t) => {
  const history = async () => [{ id: 'a1', role: 'assistant', text: '测试都过了。', at: Date.now() }];
  const zongguan = new StubZongguan({ enabled: false });
  const { state, glasses } = await lensGateway(t, history, { zongguan });
  state.put('codex', 's1', { status: 'idle', updatedAt: Date.now(), capabilities: ['history', 'send'] });
  await glasses.refresh('codex:s1', 'last');
  assert.equal(glasses.now().h, '测试都过了。');
  assert.equal(glasses.card('u----0').k, 'u0' + glasses.sessionCode('codex:s1'));
  assert.equal(glasses.now().g.slice(0, 2), 'o0');
});

test('wrapping keeps lines inside the lens, bytes inside 63, and punctuation off line starts', () => {
  const lines = wrap('这是一段很长的中文说明，用来检查换行时标点不会出现在行首，而且每一行都不超过镜片宽度。', 44);
  assert.ok(lines.length > 2);
  for (const line of lines) {
    assert.ok(bytes(line) <= 63);
    assert.doesNotMatch(line, /^[，。、]/);
  }
  const path = wrap('cd /Users/someone/projects/really-long-folder-name && npm run migrate', 30, 2);
  assert.equal(path.length, 2);
  assert.match(path[1], /…$/);
  assert.equal(fitBytes('一二三四五六七八九十一二三四五六七八九十一二三', 63), '一二三四五六七八九十一二三四五六七八九十一');
  // Seen on a live Codex approval: the shell wrapper filled the card line.
  assert.equal(displayCommand("/bin/zsh -lc 'touch relay-test.txt'"), 'touch relay-test.txt');
  assert.equal(displayCommand("/bin/zsh -lc 'echo '\\''hi'\\'' && ls'"), "echo 'hi' && ls");
  assert.equal(displayCommand('npm test'), 'npm test');
});

/* ---------- gateway endpoints ---------- */

const panel = 'panel-test-secret-000000000000000';
const nova = 'nova-test-secret-0000000000000000';
const muse = 'muse-test-secret-0000000000000000';
const session = 'muse-personal-session';
const initial = {
  session, instance: 'muse-test-instance', name: '整理本周日程', status: 'idle',
  capabilities: ['history', 'send', 'approval'], events: [],
};

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-spare-test-'));
  const app = await start(configFromEnv({
    PANEL_PORT: '0', PANEL_TOKEN: panel, PANEL_NOVA_TOKEN: nova, PANEL_MUSE_BRIDGE_TOKEN: muse,
    PANEL_CODEX_MODE: 'off', PANEL_DATA_DIR: dir, CLAUDE_CONFIG_DIR: dir, PANEL_ZONGGUAN: 'off',
    PANEL_AGENTS: 'codex,claude,muse,grok,dsh',
  }));
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return app;
}

function call(app, path, { method = 'GET', token = nova, input, headers = {}, signal } = {}) {
  const all = { ...headers };
  if (token) all.authorization = 'Bearer ' + token;
  if (method === 'POST') all['content-type'] = 'application/json';
  return fetch('http://127.0.0.1:' + app.server.address().port + path, {
    method, headers: all, signal: signal ?? AbortSignal.timeout(10000),
    body: method === 'POST' ? JSON.stringify({ app: 'dev.test.relay', arg: '', time: new Date().toISOString(), ...input }) : undefined,
  });
}
const sync = (app, input = initial) => fetch('http://127.0.0.1:' + app.server.address().port + '/bridge/muse/sync', {
  method: 'POST', headers: { authorization: 'Bearer ' + muse, 'content-type': 'application/json' }, body: JSON.stringify(input),
}).then((response) => response.json());
const glassesJson = async (app, path, options) => {
  const response = await call(app, '/v1/spare/app/' + path, options);
  assert.equal(response.status, 200);
  const value = await response.json();
  for (const [key, item] of Object.entries(value)) assert.ok(bytes(item) <= 63, key + ' over 63 bytes');
  // Every answer clears an error the phone kept from an earlier failure; the rest is what the route says.
  const { _err, ...rest } = value;
  assert.equal(_err, '', path + ' clears _err');
  return rest;
};

async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(10); }
  throw new Error('timed out');
}

test('what you say to Claude carries a receipt that the gateway and relay-receipt confirm', async (t) => {
  const app = await fixture(t);
  const got = [];
  const fake = (agent) => ({ send: async (id, text) => { got.push([agent, id, text]); return { ok: true }; } });
  // The real Claude observer marks sessions it cannot see as offline; a bridge lease makes it leave k1 alone.
  const bridge = app.state.adapters.get('claude');
  (bridge.leases ?? bridge.bridge.leases).set('k1', { instance: 'test', sent: new Set(), until: Date.now() + 60000 });
  app.state.adapters.set('claude', fake('claude'));
  app.state.adapters.set('muse', fake('muse'));
  app.state.put('claude', 'k1', { status: 'idle', updatedAt: Date.now(), capabilities: ['history', 'send'] });
  app.state.put('muse', 'm1', { status: 'idle', updatedAt: Date.now(), capabilities: ['history', 'send'] });
  const code = app.glasses.sessionCode('claude:k1');
  assert.equal((await glassesJson(app, 'say?k=ks' + code, { method: 'POST', input: { text: '重启吧。' } })).st, 'sent');
  await until(() => got.length === 1);
  const match = /^重启吧。\n\n〔Relay 回执 ([0-9a-z]{6})〕$/.exec(got[0][2]);
  assert.ok(match, 'Claude gets the words and a receipt: ' + got[0][2]);
  const receipt = await (await call(app, '/api/receipts/' + match[1], { token: panel })).json();
  assert.deepEqual([receipt.origin, receipt.said, receipt.text, receipt.agent, receipt.session], ['voice', '重启吧。', '重启吧。', 'claude', 'k1']);
  assert.equal((await call(app, '/api/receipts/zzzzzz', { token: panel })).status, 404);
  assert.equal((await call(app, '/api/receipts/' + match[1], { token: nova })).status, 401, 'the glasses token cannot read receipts');

  assert.equal((await glassesJson(app, 'say?k=ms' + app.glasses.sessionCode('muse:m1'), { method: 'POST', input: { text: '在吗' } })).st, 'sent');
  await until(() => got.length === 2);
  assert.equal(got[1][2], '在吗', 'only Claude Code gets receipts');
  assert.equal(spokenText(got[0][2]), '重启吧。', 'the lens hides the receipt line');

  const envDir = await mkdtemp(join(tmpdir(), 'relay-receipt-'));
  t.after(() => rm(envDir, { recursive: true, force: true }));
  const env = join(envDir, '.env');
  await writeFile(env, 'PANEL_PORT=' + app.server.address().port + '\nPANEL_TOKEN=' + panel + '\n');
  const script = new URL('../bin/relay-receipt.mjs', import.meta.url).pathname;
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [script, match[1]], { env: { ...process.env, RELAY_ENV: env } });
  assert.match(stdout, /^本人语音 · .+ · 发给 claude:k1$/m);
  assert.match(stdout, /^用户原话：「重启吧。」$/m);
  assert.match(stdout, /^发出的全文：\n重启吧。$/m);
  assert.doesNotMatch(stdout, new RegExp(panel), 'the token is never printed');
  const missing = await run(process.execPath, [script, 'zzzzzz'], { env: { ...process.env, RELAY_ENV: env } }).catch((error) => error);
  assert.equal(missing.code, 1);
  assert.match(missing.stdout, /没有这张回执/);
});

test('gateway refuses other tokens and answers the handshake', async (t) => {
  const app = await fixture(t);
  assert.equal((await call(app, '/v1/spare/agent', { token: panel })).status, 401);
  assert.equal((await call(app, '/v1/spare/app/top', { token: panel })).status, 401);
  const hello = await (await call(app, '/v1/spare/agent')).json();
  assert.deepEqual(hello.capabilities, ['streaming', 'actions', 'apps', 'events']);
  for (const old of ['home', 'inbox', 'list?k=m', 'page?k=1.0']) {
    assert.equal((await call(app, '/v1/spare/app/' + old)).status, 404, old + ' is gone with the old screens');
  }
});

test('an approval the computer only allows in part cannot be accepted from the glasses', async (t) => {
  const app = await fixture(t);
  await sync(app, { ...initial, events: [{ id: 'ask-2', type: 'approval', title: 'Check', approvalAllowed: false }] });
  app.glasses.syncAsks();
  const top = await glassesJson(app, 'top');
  assert.equal(top.k, 'y');
  assert.deepEqual(await glassesJson(app, 'answer?k=' + top.id + 'y', { method: 'POST' }), { st: 'fail', h: '这条要在电脑上批准' });
  assert.deepEqual((await sync(app)).commands, []);
  assert.equal((await call(app, '/v1/spare/app/answer?k=' + top.id + 'x', { method: 'POST' })).status, 400);
});

test('speech stays a draft until confirmed, goes out whole, and starts a new session the same way', async (t) => {
  const app = await fixture(t);
  await sync(app);
  const sid = (await glassesJson(app, 'sessions?k=m0')).i.slice(0, 4);
  assert.equal((await glassesJson(app, 'talk?k=s' + sid, { method: 'POST', input: { text: '  ' } })).st, 'empty');
  const text = '帮我把周五下午的会挪到下周一上午，并且提醒参会的人这次改到线上开，会议链接用上次那个';
  const draft = await glassesJson(app, 'talk?k=s' + sid, { method: 'POST', input: { text } });
  assert.equal(draft.st, 'draft');
  assert.ok(draft.d1 && draft.d2);
  assert.deepEqual((await sync(app)).commands, [], 'nothing is sent before the wearer confirms');
  assert.equal((await glassesJson(app, 'deliver?k=' + draft.dk, { method: 'POST' })).st, 'sent');
  const message = (await sync(app)).commands.find((row) => row.type === 'message');
  assert.equal(message.text, text, 'the full sentence reaches the agent, not the 63-byte preview');
  assert.equal((await glassesJson(app, 'deliver?k=' + draft.dk, { method: 'POST' })).st, 'gone', 'a draft goes out once');

  assert.equal((await glassesJson(app, 'talk?k=nm', { method: 'POST', input: { text: '你好' } })).st, 'gone',
    'an agent that cannot start sessions refuses a new one');
  const created = [];
  app.glasses.canCreate = (agent) => agent === 'codex';
  app.glasses.create = async (agent, value) => { created.push([agent, value]); };
  const list = await glassesJson(app, 'sessions?k=c0');
  assert.deepEqual([list.n, list.i, list.d1], ['1', '----', '+0新会话']);
  const fresh = await glassesJson(app, 'talk?k=nc', { method: 'POST', input: { text: '给登录页加上记住我' } });
  assert.equal(fresh.h, 'Codex · 新会话');
  assert.deepEqual(created, [], 'a new session waits for the confirming click too');
  assert.equal((await glassesJson(app, 'deliver?k=' + fresh.dk, { method: 'POST' })).st, 'sent');
  assert.deepEqual(created, [['codex', '给登录页加上记住我']]);
});

test('a session started from the glasses or by 总管 is recorded as started by Relay', async (t) => {
  const app = await fixture(t);
  const events = [];
  app.state.on('event', (event) => { if (event.kind === 'session.created') events.push([event.agent, event.session]); });
  // Only create is stubbed: the adapter itself stays, so closing the gateway still closes it.
  const adapter = app.state.adapters.get('codex');
  const own = Object.hasOwn(adapter, 'create');
  const create = adapter.create;
  adapter.create = async () => ({ id: 'n9' });
  t.after(() => { if (own) adapter.create = create; else delete adapter.create; });
  assert.deepEqual(await app.glasses.create('codex', '给登录页加上记住我'), { id: 'n9' });
  assert.deepEqual(events, [['codex', 'n9']]);
});

async function readFrames(response, count) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const frames = () => text.split('\n\n').filter((frame) => frame.includes('event: ')).map((frame) => {
    const fields = Object.fromEntries(frame.split('\n').filter((line) => !line.startsWith(':'))
      .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
    return { id: fields.id, event: fields.event, data: JSON.parse(fields.data) };
  });
  while (frames().length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  await reader.cancel();
  return frames();
}

test('gateway pushes the silent view when it changes, and a notification for a new approval', async (t) => {
  const app = await fixture(t);
  await sync(app);
  await glassesJson(app, 'now', { headers: { 'x-spare-app': 'dev.test.relay' } });
  const stream = call(app, '/v1/spare/events', { signal: AbortSignal.timeout(8000) });
  await delay(200);
  await sync(app, { ...initial, events: [{ id: 'ask-3', type: 'approval', title: 'Run a command', command: 'git push' }] });
  const frames = await readFrames(await stream, 3);
  assert.equal(frames[0].event, 'spare.data');
  assert.equal(frames[0].data.app, 'dev.test.relay');
  const notify = frames.find((frame) => frame.event === 'spare.notify');
  assert.deepEqual(notify.data, { title: 'Muse', body: '要运行命令：git push' });
  const update = frames.slice(1).find((frame) => frame.event === 'spare.data');
  const now = await glassesJson(app, 'now');
  const { k: code, ...polled } = now;
  assert.deepEqual(update.data.values, { ...polled, st: code, _err: '' }, 'the push carries what standby polls, the code in st');
  // The newest approval of an agent's latest session: approval, Muse (2), and its id.
  assert.match(update.data.values.st, /^y2[0-9a-z]{4}$/);
  assert.equal(update.data.values.g[9], 'w', 'Muse waits for you');
  for (const value of Object.values(update.data.values)) assert.ok(bytes(value) <= 63);
});

test('gateway uses the iPhone push address only while no event stream is open', async (t) => {
  const app = await fixture(t);
  const pushes = [];
  app.glasses.send = async (url, options) => {
    pushes.push({ url, body: JSON.parse(options.body) });
    return new Response(null, { status: pushes.length === 1 ? 202 : 410 });
  };
  const address = 'https://cn.spare.cool/v1/agent-push/' + 'k'.repeat(43);
  await sync(app);
  await glassesJson(app, 'top', { headers: { 'x-spare-push': address, 'x-spare-device': 'sd-test' } });
  await glassesJson(app, 'top', { headers: { 'x-spare-push': 'https://attacker.example/v1/agent-push/' + 'k'.repeat(43),
    'x-spare-device': 'sd-other' } });
  assert.deepEqual(Object.keys(app.state.setting('sparePush')), ['sd-test']);
  await sync(app, { ...initial, events: [{ id: 'ask-4', type: 'approval', title: 'Modify files', description: '改 README' }] });
  await delay(1300);
  assert.equal(pushes.length, 1);
  assert.equal(pushes[0].url, address);
  assert.equal(pushes[0].body.event, 'spare.notify');
  assert.deepEqual(pushes[0].body.data, { title: 'Muse', body: '要改文件：改 README' });
  await app.glasses.pushRemote({ id: 'x', event: 'spare.notify', data: { title: 't', body: 'b' } });
  assert.deepEqual(app.state.setting('sparePush'), {}, 'a revoked address (410) is forgotten');
});

async function finishFixture(t, idle) {
  const app = await fixture(t);
  const pushes = [];
  app.glasses.send = async (url, options) => {
    pushes.push(JSON.parse(options.body));
    return new Response(null, { status: 202 });
  };
  app.glasses.idle = async () => idle;
  const rows = [{ id: 'u1', role: 'user', text: '查下周去杭州的高铁' }];
  app.glasses.history = async () => rows;
  await sync(app);
  await glassesJson(app, 'top', { headers: { 'x-spare-push': 'https://cn.spare.cool/v1/agent-push/' + 'k'.repeat(43),
    'x-spare-device': 'sd-test' } });
  return { app, pushes, rows };
}

test('gateway notifies when a turn finishes away from the Mac, with the first sentence of the reply', async (t) => {
  const { app, pushes, rows } = await finishFixture(t, Infinity);
  await sync(app, { ...initial, status: 'running' });
  rows.push({ id: 'a1', role: 'assistant', text: '周二上午有三班，最早 7:05。二等座还有票。' });
  await sync(app, { ...initial, status: 'idle' });
  await delay(300);
  assert.deepEqual(pushes.map((push) => push.data), [{ title: 'Muse · 整理本周日程', body: '周二上午有三班，最早 7:05。' }]);
  // The same reply is not sent twice when the session flips status again without saying anything new.
  await sync(app, { ...initial, status: 'running' });
  await sync(app, { ...initial, status: 'idle' });
  await delay(300);
  assert.equal(pushes.length, 1);
});

test('gateway says a failed turn failed, and stays quiet while someone is at the Mac', async (t) => {
  const { app, pushes } = await finishFixture(t, Infinity);
  await sync(app, { ...initial, status: 'running' });
  await sync(app, { ...initial, status: 'failed' });
  await delay(300);
  assert.deepEqual(pushes.map((push) => push.data), [{ title: 'Muse · 整理本周日程', body: '出错了' }]);

  const desk = await finishFixture(t, 1000);
  await sync(desk.app, { ...initial, status: 'running' });
  desk.rows.push({ id: 'a1', role: 'assistant', text: '好了。' });
  await sync(desk.app, { ...initial, status: 'idle' });
  await delay(300);
  assert.equal(desk.pushes.length, 0);
});

/* ---------- simple mode: the stream ---------- */

const key = 'muse:' + session;
const talkRows = [
  { id: 'u1', role: 'user', text: '整理一下下周的日程' },
  { id: 'a1', role: 'assistant', text: '先看一下日历。' },
  { id: 'a2', role: 'assistant', text: '周五下午和周一上午各有一个冲突。周五的会要挪到周一吗？' },
];

test('stream gathers what sessions said in order, marks a closing question as waiting, and answers it in two words', async (t) => {
  const app = await fixture(t);
  await sync(app);
  let rows = talkRows;
  app.glasses.history = async () => rows;
  await app.glasses.refresh(key, 'turn');
  const feed = await glassesJson(app, 'feed?k=e');
  assert.equal(feed.n, '4', 'three items and the microphone');
  const lines = [1, 2, 3, 4, 5, 6, 7, 8].map((k) => feed['d' + k]).filter(Boolean);
  assert.equal(lines[0], 'L2整理本周日程', 'the session is named once, where it starts');
  assert.match(lines[1], /^M2\d{3}整理一下下周的日程$/);
  assert.equal(lines[2], 'A2先看一下日历。');
  assert.equal(lines[3].slice(0, 2), 'Q2', 'the closing question waits for you');
  assert.equal(lines.at(-1), 'P0');
  assert.equal(feed.i.length, 16, 'four ids of four characters');
  assert.equal(feed.g, 'o0o0w1o0o0', 'Muse waits for you; the others are not connected in this test');
  assert.ok(Number(feed.y) >= 10);

  const top = await glassesJson(app, 'top');
  assert.deepEqual([top.k, top.w, top.d1, top.n], ['s', '2', '整理本周日程', '1']);
  assert.equal(top.h, '周五下午和周一上午各有一个冲突。');
  const id = feed.i.slice(8, 12);
  assert.equal(top.id, id);
  const opened = await glassesJson(app, 'item?k=' + id + '0');
  assert.deepEqual([opened.k, opened.a, opened.w, opened.n], ['s', '2', '1', '1']);
  assert.equal(opened.h, 'Muse · 整理本周日程');

  assert.deepEqual(await glassesJson(app, 'answer?k=' + id + 'y', { method: 'POST' }), { st: 'ok', h: '已回复：可以' });
  const message = (await sync(app)).commands.find((row) => row.type === 'message');
  assert.equal(message.text, '可以');
  rows = [...talkRows, { id: 'u2', role: 'user', text: '可以' }];
  await app.glasses.refresh(key);
  assert.equal((await glassesJson(app, 'top')).k, '', 'once you replied, nothing waits');
  assert.equal((await glassesJson(app, 'answer?k=' + id + 'n', { method: 'POST' })).st, 'gone');
  assert.equal((await call(app, '/v1/spare/app/answer?k=zz', { method: 'POST' })).status, 400);
});

test('stream turns approvals into items, scrolls a window of eight rows, and sits on the bottom edge at the end', async (t) => {
  const app = await fixture(t);
  await sync(app, { ...initial, events: [{ id: 'ask-9', type: 'approval', title: 'Run a command', command: 'git push' }] });
  app.glasses.history = async () => Array.from({ length: 12 }, (_, i) => ({ id: 'a' + i, role: 'assistant',
    text: '第 ' + i + ' 段：这是一段比较长的说明文字，用来把镜片上的两行都占满，看窗口怎么滚动。' }));
  await app.glasses.refresh(key, 'all');
  app.glasses.syncAsks();
  const end = await glassesJson(app, 'feed?k=e');
  const rows = (view) => [1, 2, 3, 4, 5, 6, 7, 8].map((k) => view['d' + k]).filter(Boolean);
  assert.ok(rows(end).length <= 8);
  assert.equal(rows(end).at(-1), 'P0');
  const used = rowHeights(rows(end)).reduce((a, b) => a + b, 0);
  assert.equal(Number(end.y) + used, 196, 'the newest rows end at the bottom of the lens');
  const top = await glassesJson(app, 'top');
  assert.equal(top.k, 'y');
  assert.equal(top.d2, '要运行命令：git push');
  const first = await glassesJson(app, 'feed?k=0');
  assert.equal(first.p, '0');
  assert.equal(first.y, '10');
  assert.equal(first.d1, 'L2整理本周日程');
  assert.deepEqual(await glassesJson(app, 'answer?k=' + top.id + 'y', { method: 'POST' }), { st: 'ok', h: '已批准' });
  const decision = (await sync(app)).commands.find((row) => row.type === 'decision');
  assert.deepEqual([decision.request, decision.decision], ['ask-9', 'accept']);
});

test('lists sessions, opens one, and sends speech to a session picked after speaking', async (t) => {
  const app = await fixture(t);
  await sync(app);
  app.glasses.history = async () => talkRows;
  const list = await glassesJson(app, 'sessions?k=m0');
  assert.equal(list.h, 'Muse · 1 个会话');
  assert.equal(list.d1, 'i2整理本周日程');
  assert.match(list.d5, /^\d{3}周五下午和周一上午各有一个冲突。$/);
  const sid = list.i.slice(0, 4);
  const one = await glassesJson(app, 'session?k=' + sid + '.0');
  assert.equal(one.h, 'Muse · 整理本周日程');
  assert.equal(one.w, '1');
  assert.ok(one.d1);

  const draft = await glassesJson(app, 'talk?k=', { method: 'POST', input: { text: '把周五的会挪到周一上午十点' } });
  assert.deepEqual([draft.st, draft.h], ['draft', '']);
  const pick = await glassesJson(app, 'targets?k=0');
  assert.deepEqual([pick.n, pick.i, pick.h, pick.id], ['1', '2s', '整理本周日程', 's' + sid]);
  assert.equal((await glassesJson(app, 'deliver?k=' + draft.dk, { method: 'POST' })).st, 'gone', 'a draft without a target waits');
  const sent = await glassesJson(app, 'deliver?k=' + draft.dk + '.' + pick.id, { method: 'POST' });
  assert.deepEqual(sent, { st: 'sent', h: '已发给 整理本周日程' });
  const message = (await sync(app)).commands.find((row) => row.type === 'message');
  assert.equal(message.text, '把周五的会挪到周一上午十点');

  const direct = await glassesJson(app, 'talk?k=s' + sid, { method: 'POST', input: { text: '好' } });
  assert.equal(direct.h, 'Muse · 整理本周日程');
  await glassesJson(app, 'discard?k=' + direct.dk, { method: 'POST' });
  assert.equal((await glassesJson(app, 'deliver?k=' + direct.dk, { method: 'POST' })).st, 'gone');
});

test('stream shows the last 30 items, plus an older one that still waits for you', async (t) => {
  const app = await fixture(t);
  await sync(app, { ...initial, events: [{ id: 'ask-5', type: 'approval', title: 'Run a command', command: 'npm test' }] });
  app.glasses.syncAsks();
  app.glasses.history = async () => Array.from({ length: 40 }, (_, i) => ({ id: 'c' + i, role: 'assistant', text: '第 ' + i + ' 段。' }));
  await app.glasses.refresh(key, 'all');
  const first = await glassesJson(app, 'feed?k=0');
  assert.equal(first.n, '32', 'the waiting approval, the last 30 lines and the microphone');
  assert.match(first.d2, /^Q2要运行命令：npm test/, 'the approval from before is still there to answer');
  assert.ok([1, 2, 3, 4, 5, 6, 7, 8].some((k) => first['d' + k].includes('第 10 段')), 'the oldest line shown is line 10');
  assert.ok(![1, 2, 3, 4, 5, 6, 7, 8].some((k) => first['d' + k].includes('第 9 段')));
});
