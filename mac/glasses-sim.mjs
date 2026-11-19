#!/usr/bin/env node
// Terminal stand-in for the glasses: runs the real Relay glasses app (spare/app.json + spare/main.ss) against the
// live gateway, the same way the Spare phone app does (spare.cool/io/agent §15–18), and draws the 540 × 220 lens
// as a picture in the terminal (kitty graphics protocol: Ghostty, kitty, WezTerm). Speech is typed instead.
//
//   node mac/glasses-sim.mjs                      interactive, needs Ghostty / kitty / WezTerm
//   node mac/glasses-sim.mjs --base https://relay.example.com
//   node mac/glasses-sim.mjs --script "wait:2000,click,wait:1500,down" --out /tmp/frames   headless, saves PNGs
//   (shot:name in a script also saves the current frame as name.png)
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const args = process.argv.slice(2);
const option = (name, fallback = null) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? args[i + 1] : fallback;
};
const manifest = JSON.parse(readFileSync(join(root, 'spare', 'app.json'), 'utf8'));
const source = readFileSync(join(root, 'spare', 'main.ss'), 'utf8');
const appId = option('app', 'dev.spare18.relay'); // the id the published app has; the gateway pushes to this id
const base = option('base', 'http://127.0.0.1:4488').replace(/\/+$/, '');
const token = process.env.PANEL_NOVA_TOKEN ?? envFile().PANEL_NOVA_TOKEN;
const device = 'sd-sim' + randomBytes(5).toString('hex');
const script = option('script');
const outDir = option('out');
const headless = script !== null;

function envFile() {
  try {
    return Object.fromEntries(readFileSync(join(root, '.env'), 'utf8').split('\n')
      .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
  } catch { return {}; }
}

if (!token) { console.error('没找到眼镜令牌 PANEL_NOVA_TOKEN（.env 或环境变量）。'); process.exit(1); }
if (!headless && !process.stdout.isTTY) { console.error('要在终端里运行。'); process.exit(1); }
if (!headless && !/ghostty|kitty|wezterm/i.test((process.env.TERM_PROGRAM ?? '') + (process.env.TERM ?? '')) && !args.includes('--force')) {
  console.error('画面用 kitty 图像协议显示，请在 Ghostty、kitty 或 WezTerm 里运行（确定支持就加 --force）。');
  process.exit(1);
}

/* ---------- lens state ---------- */

const bytes = (value) => Buffer.byteLength(String(value));
const subBytes = (text, start, length) => {
  const buffer = Buffer.from(String(text));
  let from = Math.max(0, start);
  while (from < buffer.length && (buffer[from] & 0xc0) === 0x80) from++;
  let to = Math.min(buffer.length, from + length);
  while (to > from && to < buffer.length && (buffer[to] & 0xc0) === 0x80) to--;
  return buffer.subarray(from, to).toString();
};
const fit = (value) => subBytes(String(value ?? ''), 0, 63); // the lens keeps at most 63 bytes per value

const els = manifest.ui.map((node) => ({ ...node, text: node.text ?? '', hidden: !!node.hidden }));
const log = [];
const note = (line) => { log.push(new Date().toTimeString().slice(0, 8) + '  ' + line); if (log.length > 200) log.shift(); paint(); };
const state = { online: true, record: {}, seq: 0, lastSent: 0, gateway: '…', push: '…', notice: null, exited: false };
let calls = 0;
let typing = null; // { seq, request, arg, text } while the wearer "speaks"

/* ---------- the glasses app, with the firmware built-ins ---------- */

// image(el, n) picks the n-th picture in spare/assets/, numbered by sorted file name the way the compiler does.
const assets = readdirSync(join(root, 'spare', 'assets')).filter((name) => name.endsWith('.png')).sort();
const ids = Object.fromEntries(manifest.ui.map(({ id }, index) => [id, index]));
const requestIds = Object.fromEntries(manifest.requests.map(({ name }, index) => [name, 100 + index]));
const ui = (fn) => (...a) => { calls++; return fn(...a); };
const el = (id) => {
  if (!els[id]) throw new Error('没有这个界面元素：' + id);
  return els[id];
};
const timers = new Map();
const runtime = {
  ...ids, ...requestIds,
  text: ui((id, value) => {
    if (bytes(value) > 63) note('⚠ text 超过 63 字节被截断：' + manifest.ui[id].id);
    el(id).text = fit(value);
  }),
  show: ui((id, on) => { el(id).hidden = !on; }),
  gray: ui((id, value) => { el(id).gray = value; }),
  value: ui((id, value) => { el(id).value = Math.trunc(value); }), // SpareScript has 32-bit integers only
  move: ui((id, x, y) => { Object.assign(el(id), { x, y }); }),
  size: ui((id, w, h) => { Object.assign(el(id), { w, h }); }),
  image: ui((id, n) => {
    if (!assets[n]) note('⚠ 没有第 ' + n + ' 张图：' + manifest.ui[id].id);
    el(id).src = assets[n] ?? '';
  }),
  anim_x: ui((id, x) => { el(id).x = x; }),
  anim_opa: ui(() => {}),
  anim_scale: ui(() => {}),
  timer: (id, ms, repeat) => {
    clearTimeout(timers.get(id)?.handle);
    timers.delete(id);
    if (ms <= 0) return;
    const fire = () => {
      if (repeat) timers.set(id, { handle: setTimeout(fire, Math.max(100, ms)) });
      else timers.delete(id);
      dispatch('timer', id);
    };
    timers.set(id, { handle: setTimeout(fire, Math.max(100, ms)) });
  },
  now: () => Math.trunc(performance.now()),
  clock: () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); },
  seconds: () => new Date().getSeconds(),
  str: (v) => String(v),
  num: (v) => Number.parseInt(v, 10) || 0,
  len: (v) => bytes(v),
  sub: subBytes,
  pad: (v, n) => String(v).padStart(n, '0'),
  min: Math.min, max: Math.max, abs: Math.abs,
  clamp: (x, low, high) => Math.max(low, Math.min(x, high)),
  rand: (n) => Math.floor(Math.random() * n),
  data: (key) => String(state.record[key] ?? ''),
  connected: () => state.online,
  battery: () => 80,
  save: () => {},
  exit: () => quitApp('应用自己退出了'),
  request: (id, arg) => {
    if (!state.online) return 0;
    const request = manifest.requests[id - 100];
    if (!request) { note('⚠ 不认识的请求 ' + id); return 0; }
    if (bytes(arg) > 10) note('⚠ 请求参数超过 10 字节：' + request.name + ' ' + arg);
    const seq = ++state.seq;
    send(request, String(arg), seq);
    return seq;
  },
};
// SpareScript differs from JavaScript in only these spellings.
const translated = source.replace(/\bpersist var\b/g, 'var').replace(/\bfn /g, 'function ')
  .replace(/^on (\w+)\(/gm, 'function event_$1(');
runInNewContext(translated, runtime, { timeout: 500 });

function dispatch(event, ...a) {
  if (state.exited) return;
  const handler = runtime['event_' + event];
  if (typeof handler !== 'function') return;
  calls = 0;
  try {
    handler(...a);
  } catch (error) {
    note('✖ 应用出错（on ' + event + '）：' + error.message);
  }
  if (calls > 256) note('⚠ on ' + event + ' 调了 ' + calls + ' 次界面，固件上限 256，会显示「应用出错」');
  paint();
}

function quitApp(why) {
  dispatch('close');
  state.exited = true;
  for (const { handle } of timers.values()) clearTimeout(handle);
  timers.clear();
  note(why + '。按 o 重新打开');
}

/* ---------- the phone: agent requests, dictation, push ---------- */

const pick = (object, path) => path.split('.').reduce((v, key) => (v == null ? undefined : v[key]), object);
const headers = () => ({
  Authorization: 'Bearer ' + token, 'X-Spare-Protocol': '1', 'X-Spare-App': appId,
  'X-Spare-Device': device, 'X-Spare-Locale': 'zh-CN', Accept: 'application/json',
});

function reply(seq, record) {
  state.record = record;
  dispatch('data', seq);
}

async function send(request, arg, seq) {
  // The phone sends at most one request a second; the app is meant to pace itself, so a faster call is a bug to see.
  const gap = Date.now() - state.lastSent;
  if (gap < 1000) note('⚠ 两次请求只隔 ' + gap + ' ms（手机限 1 次/秒），这里延后发');
  state.lastSent = Math.max(Date.now(), state.lastSent + 1000);
  if (gap < 1000) await new Promise((r) => setTimeout(r, 1000 - gap));

  if (request.kind === 'dictate') {
    if (arg === 'end' || arg === 'stop') return finishTyping(arg === 'end', seq);
    return startTyping(request, arg, seq);
  }
  if (request.kind !== 'agent') return reply(seq, { _err: 'kind' });
  if (request.voice) return startTyping(request, arg, seq);
  return callAgent(request, arg, seq);
}

async function callAgent(request, arg, seq, text) {
  const path = request.path.replace('{arg}', encodeURIComponent(arg));
  const method = request.method ?? 'GET';
  const started = Date.now();
  let record;
  try {
    const res = await fetch(base + '/v1/spare/app/' + path, {
      method, signal: AbortSignal.timeout(10000),
      headers: { ...headers(), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
      body: method === 'POST'
        ? JSON.stringify({ app: appId, arg, time: new Date().toISOString(), ...(text !== undefined ? { text } : {}) })
        : undefined,
    });
    state.gateway = res.ok ? '已连接' : 'HTTP ' + res.status;
    if (res.status === 401 || res.status === 403) record = { _err: 'auth' };
    else if (!res.ok) record = { _err: 'net' };
    else {
      const body = await res.json();
      record = {};
      for (const [key, dotted] of Object.entries(request.fields ?? {})) {
        const v = pick(body, dotted);
        if (v !== undefined && v !== null) record[key] = fit(v);
      }
    }
  } catch (error) {
    state.gateway = '连不上';
    record = { _err: 'net' };
  }
  if (text !== undefined) record.tx = fit(text);
  note(method + ' ' + request.name + (arg ? ' ' + arg : '') + '  ' + (record._err ? '_err=' + record._err : 'ok')
    + '  ' + (Date.now() - started) + ' ms');
  reply(seq, record);
}

function startTyping(request, arg, seq) {
  if (typing) return reply(seq, { _err: 'busy' });
  typing = { request, arg, seq, text: '' };
  note('🎤 ' + (request.voice ? request.name + ' 开始听写' : '听写开始') + '：打字代替说话，回车结束，Esc 取消');
  reply(0, { st: 'rec', tx: '' });
}

function finishTyping(keep, endSeq) {
  const t = typing;
  if (!t) { if (endSeq) reply(endSeq, { _err: 'empty' }); return; }
  typing = null;
  if (!keep) { note('🎤 取消听写'); return reply(t.seq, { st: 'stopped' }); }
  if (!t.text.trim()) { note('🎤 什么都没听到'); return reply(t.seq, { _err: 'empty' }); }
  if (t.request.voice) return callAgent(t.request, t.arg, t.seq, t.text);
  return reply(t.seq, { st: 'done', tx: fit(t.text) });
}

function typed(text) {
  typing.text = text;
  reply(0, { st: 'rec', tx: fit(subBytes(text, Math.max(0, bytes(text) - 63), 63)) }); // the phone pushes the last 63 bytes heard
}

async function listen() {
  let delay = 2000;
  let last = '';
  for (;;) {
    try {
      const res = await fetch(base + '/v1/spare/events', {
        headers: { ...headers(), Accept: 'text/event-stream', ...(last ? { 'Last-Event-ID': last } : {}) },
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      state.push = '已连接'; delay = 2000; paint();
      let buffer = '';
      for await (const chunk of res.body) {
        buffer += Buffer.from(chunk).toString();
        let cut;
        while ((cut = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
          let event = '', data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += line.slice(5).trim();
            else if (line.startsWith('id:')) last = line.slice(3).trim();
          }
          if (event) pushed(event, data);
        }
      }
      throw new Error('连接断开');
    } catch (error) {
      state.push = '断开（' + error.message + '）'; paint();
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(60000, delay * 2);
    }
  }
}

function pushed(event, raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  if (event === 'spare.data') {
    if (data.app !== appId) return;
    const values = Object.fromEntries(Object.entries(data.values ?? {}).slice(0, 24).map(([k, v]) => [k, fit(v)]));
    note('⇣ 推送 spare.data ' + Object.keys(values).join(','));
    reply(0, values);
  } else if (event === 'spare.notify') {
    state.notice = { text: '眼镜通知  ' + String(data.title ?? '').slice(0, 20) + '：' + String(data.body ?? '').slice(0, 60), until: Date.now() + 6000 };
    note('⇣ ' + state.notice.text);
  } else if (event === 'spare.say') {
    state.notice = { text: 'Nova 说  ' + String(data.text ?? ''), until: Date.now() + 8000 };
    note('⇣ ' + state.notice.text);
  }
}

/* ---------- drawing ---------- */

const renderer = spawn('python3', ['-I', join(here, 'glasses-render.py')], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = [];
let rbuf = '';
renderer.stdout.on('data', (chunk) => {
  rbuf += chunk;
  let cut;
  while ((cut = rbuf.indexOf('\n')) >= 0) {
    const line = rbuf.slice(0, cut); rbuf = rbuf.slice(cut + 1);
    waiting.shift()?.(JSON.parse(line));
  }
});
const render = (scene) => new Promise((done) => { waiting.push(done); renderer.stdin.write(JSON.stringify(scene) + '\n'); });

let guide = true;
let frame = null; // last rendered result
let pending = false;
let frameNo = 0;
let cell = { w: 9, h: 18 };

function paint() {
  if (pending) return;
  pending = true;
  setTimeout(async () => {
    pending = false;
    frame = await render({ els, scale: 2, guide });
    if (frame.error) note('✖ 画图出错：' + frame.error);
    if (headless) {
      if (outDir) writeFileSync(join(outDir, String(++frameNo).padStart(3, '0') + '.png'), Buffer.from(frame.png ?? '', 'base64'));
      return;
    }
    screen();
  }, 30);
}

const VIEWS = ['静默', '你不在时', '说的话', '展开', '会话列表', '会话', '听写中', '说给会话', '选发给谁', '结果或提示'];

function screen() {
  const cols = Math.min(process.stdout.columns || 100, 120);
  const rows = Math.max(4, Math.round((cols * cell.w * 220) / 540 / cell.h));
  let out = '\x1b[?25l\x1b[H\x1b_Ga=d,d=i,i=1,q=2\x1b\\';
  const png = frame?.png ?? '';
  for (let i = 0; i < png.length; i += 4096) {
    const more = i + 4096 < png.length ? 1 : 0;
    const head = i === 0 ? 'a=T,f=100,i=1,p=1,q=2,C=1,c=' + cols + ',r=' + rows + ',' : '';
    out += '\x1b_G' + head + 'm=' + more + ';' + png.slice(i, i + 4096) + '\x1b\\';
  }
  const width = process.stdout.columns || 100;
  const line = (s = '') => '\x1b[2K' + s.slice(0, width * 2) + '\n';
  out += '\x1b[' + (rows + 1) + ';1H';
  const view = VIEWS[runtime.view] ?? String(runtime.view);
  out += line('\x1b[1m画面 ' + runtime.view + ' ' + view + '\x1b[0m   网关 ' + state.gateway + '   推送 ' + state.push
    + '   眼镜' + (state.online ? '连着手机' : '\x1b[31m断开手机\x1b[0m') + (state.exited ? '   \x1b[33m应用已退出\x1b[0m' : ''));
  out += line('\x1b[2m↑↓/←→/jk 转表冠  回车/空格 单击  x 双击(退出)  o 重新打开  n 断开/连上手机  g 裁切线  q 退出模拟器\x1b[0m');
  if (state.notice && state.notice.until > Date.now()) out += line('\x1b[7m ' + state.notice.text + ' \x1b[0m');
  else out += line();
  const over = frame?.overflow ?? [];
  out += line(over.length ? '\x1b[33m⚠ 字放不下被裁：' + over.join(', ') + '\x1b[0m' : '');
  if (typing) out += line('\x1b[36m🎤 ' + (runtime.who ? '说给 ' + runtime.who : '听写') + '：\x1b[0m' + typing.text + '▏  \x1b[2m回车结束  Esc 取消\x1b[0m');
  else out += line();
  const room = Math.max(0, (process.stdout.rows || 40) - rows - 6);
  for (const l of log.slice(-room)) out += line('\x1b[2m' + l + '\x1b[0m');
  out += '\x1b[J';
  process.stdout.write(out);
}

/* ---------- keys ---------- */

function key(k) {
  if (typing) {
    // Enter stands for the pause that ends dictation on its own; Tab is a real click (the app then ends it itself).
    if (k === '\r') return finishTyping(true);
    if (k === '\t') return dispatch('click');
    if (k === '\x1b') return finishTyping(false);
    if (k === '\x7f') return typed([...typing.text].slice(0, -1).join(''));
    if (!/^\x1b\[/.test(k) && !/[\x00-\x1f]/.test(k)) return typed(typing.text + k);
  }
  if (k === 'q' || k === '\x03') return shutdown();
  if (k === 'o' && state.exited) { state.exited = false; note('重新打开应用'); return dispatch('open'); }
  if (state.exited) return;
  if (k === '\x1b[A' || k === '\x1b[D' || k === 'k') return dispatch('crown', -1);
  if (k === '\x1b[B' || k === '\x1b[C' || k === 'j') return dispatch('crown', 1);
  if (k === '\r' || k === ' ') return dispatch('click');
  if (k === 'x') return quitApp('双击：退出应用');
  if (k === 'n') { state.online = !state.online; note(state.online ? '手机连上了' : '手机断开了（connected() 为假）'); return; }
  if (k === 'g') { guide = !guide; return paint(); }
}

function shutdown() {
  if (!headless) process.stdout.write('\x1b_Ga=d,d=i,i=1,q=2\x1b\\\x1b[?25h\x1b[?1049l');
  renderer.kill();
  process.exit(0);
}

async function cellSize() {
  // CSI 16 t asks the terminal for its cell size in pixels, so the picture keeps the lens's shape.
  return new Promise((done) => {
    const onData = (d) => {
      const m = String(d).match(/\x1b\[6;(\d+);(\d+)t/);
      if (m) cell = { h: Number(m[1]), w: Number(m[2]) };
      process.stdin.off('data', onData);
      done();
    };
    process.stdin.on('data', onData);
    process.stdout.write('\x1b[16t');
    setTimeout(() => { process.stdin.off('data', onData); done(); }, 300);
  });
}

/* ---------- start ---------- */

if (headless) {
  if (outDir) mkdirSync(outDir, { recursive: true });
  listen();
  dispatch('open');
  for (const step of script.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, value] = step.split(':');
    if (name === 'wait') await new Promise((r) => setTimeout(r, Number(value)));
    else if (name === 'type') typed(value);
    else if (name === 'shot' && outDir) { await new Promise((r) => setTimeout(r, 120)); writeFileSync(join(outDir, value + '.png'), Buffer.from(frame?.png ?? '', 'base64')); }
    else if (name === 'up') key('k');
    else if (name === 'down') key('j');
    else if (name === 'enter') key('\r');
    else key({ click: ' ', exit: 'x', open: 'o', net: 'n' }[name] ?? name);
  }
  await new Promise((r) => setTimeout(r, 400));
  for (const l of log) console.log(l);
  console.log('最后画面 ' + runtime.view + ' ' + (VIEWS[runtime.view] ?? '') + (frame?.overflow?.length ? '  字被裁：' + frame.overflow.join(', ') : ''));
  shutdown();
} else {
  process.stdout.write('\x1b[?1049h\x1b[2J');
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  await cellSize();
  process.stdin.on('data', (d) => {
    // Arrow keys arrive as one escape sequence; typed or pasted text may arrive several characters at once.
    const parts = String(d).match(/\x1b\[[0-9;]*[A-Za-z~]|\x1b|[\s\S]/gu) ?? [];
    if (typing && parts.every((p) => !p.startsWith('\x1b') && !/[\x00-\x1f\x7f]/.test(p))) return typed(typing.text + parts.join(''));
    for (const p of parts) key(p);
  });
  process.stdout.on('resize', () => paint());
  setInterval(() => { if (state.notice && state.notice.until < Date.now()) { state.notice = null; paint(); } }, 1000);
  listen();
  dispatch('open');
}
