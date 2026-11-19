import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ModelError, openCode, readKey } from '../lib/zongguan/model.mjs';
import { ZongguanStore } from '../lib/zongguan/store.mjs';
import { ZongguanTools, toolSpecs } from '../lib/zongguan/tools.mjs';
import { State } from '../lib/state.mjs';
import { Zongguan } from '../lib/zongguan/agent.mjs';
import { setTimeout as delay } from 'node:timers/promises';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-zongguan-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** A store on a fresh database that also has the gateway's setting table. */
async function storeFor(t) {
  const dir = await tempDir(t);
  const db = new DatabaseSync(join(dir, 'events.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  t.after(() => db.close());
  return { store: new ZongguanStore(db, join(dir, 'zongguan.md')), db, dir };
}

/* ---------- model ---------- */

test('openCode posts chat completions with the key and tools and returns the message and prompt tokens', async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '好' } }], usage: { prompt_tokens: 1234 } }));
  };
  const client = openCode({ key: 'k-secret', model: 'deepseek-v4.1-flash', effort: 'high', session: 'ses_abc', fetch });
  const out = await client.complete({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ type: 'function', function: { name: 'x', parameters: {} } }],
  });
  assert.equal(seen[0].url, 'https://opencode.ai/inference/go/openai/v1/chat/completions');
  assert.equal(seen[0].init.headers.authorization, 'Bearer k-secret');
  // OpenCode Go asks clients to name themselves and send one stable session id per conversation.
  assert.match(seen[0].init.headers['user-agent'], /^relay-zongguan\//);
  assert.equal(seen[0].init.headers['x-opencode-session'], 'ses_abc');
  const body = JSON.parse(seen[0].init.body);
  assert.equal(body.model, 'deepseek-v4.1-flash');
  assert.equal(body.reasoning_effort, 'high');
  assert.equal(body.tools.length, 1);
  assert.deepEqual(out, { message: { role: 'assistant', content: '好' }, promptTokens: 1234 });
});

test('a failed model call throws ModelError with the status and never the key', async () => {
  const client = openCode({ key: 'k-secret', model: 'm', fetch: async () => new Response('{"error":"bad key k-secret"}', { status: 401 }) });
  const error = await client.complete({ messages: [], tools: [] }).catch((e) => e);
  assert.ok(error instanceof ModelError);
  assert.equal(error.status, 401);
  assert.doesNotMatch(error.message, /k-secret/);
});

test('readKey takes the keychain item first and falls back to PANEL_OPENCODE_KEY', async () => {
  const calls = [];
  const run = async (file, args) => { calls.push([file, ...args]); return 'from-keychain\n'; };
  assert.equal(await readKey({ env: { PANEL_OPENCODE_KEY: 'from-env' }, run }), 'from-keychain');
  assert.deepEqual(calls[0], ['/usr/bin/security', 'find-generic-password', '-s', 'relay-opencode', '-a', 'opencode', '-w']);
  assert.equal(await readKey({ env: { PANEL_OPENCODE_KEY: 'from-env' }, run: async () => { throw new Error('none'); } }), 'from-env');
  assert.equal(await readKey({ env: {}, run: async () => { throw new Error('none'); } }), null);
});

/* ---------- store ---------- */

test('store keeps messages in order and compacts everything up to a seq into a summary and a marker', async (t) => {
  const { store } = await storeFor(t);
  store.append({ role: 'user', content: 'a' }, { turn: 1, kind: 'chat' });
  store.append({ role: 'assistant', content: 'b' }, { turn: 1, kind: 'chat' });
  const third = store.append({ role: 'user', content: 'c' }, { turn: 2, kind: 'chat' });
  store.append({ role: 'assistant', content: 'd' }, { turn: 2, kind: 'chat' });
  store.compactUpTo(third, 'S', '— 已压缩 —');
  const rows = store.messages();
  assert.deepEqual(rows.map((row) => row.kind), ['summary', 'marker', 'chat']);
  assert.equal(rows[0].message.role, 'user');
  assert.ok(rows[0].message.content.startsWith('[之前对话的摘要]'));
  assert.equal(rows[1].message.content, '— 已压缩 —');
  assert.equal(rows[2].message.content, 'd');
});

test('store keeps one OpenCode session id across restarts', async (t) => {
  const { store, db, dir } = await storeFor(t);
  const id = store.session();
  assert.match(id, /^ses_[0-9a-f]{32}$/);
  assert.equal(store.session(), id);
  assert.equal(new ZongguanStore(db, join(dir, 'zongguan.md')).session(), id);
});

test('store gives every dangling tool call a synthetic result after a restart', async (t) => {
  const { store, db, dir } = await storeFor(t);
  store.append({ role: 'assistant', content: null, tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'list_sessions', arguments: '{}' } },
    { id: 'c2', type: 'function', function: { name: 'list_sessions', arguments: '{}' } },
  ] }, { turn: 1, kind: 'chat' });
  store.append({ role: 'tool', tool_call_id: 'c1', content: 'ok' }, { turn: 1, kind: 'chat' });
  const again = new ZongguanStore(db, join(dir, 'zongguan.md'));
  assert.equal(again.repair(), 1);
  assert.deepEqual(again.messages().at(-1).message, { role: 'tool', tool_call_id: 'c2', content: '[中断]' });
  assert.equal(again.repair(), 0);
});

test('store elides read results from earlier turns only', async (t) => {
  const { store } = await storeFor(t);
  store.append({ role: 'tool', tool_call_id: 'r1', content: 'raw one' }, { turn: 1, kind: 'read' });
  store.append({ role: 'tool', tool_call_id: 'r2', content: 'raw two' }, { turn: 2, kind: 'read' });
  store.elideReads(2);
  const rows = store.messages();
  assert.equal(rows[0].message.content, '[已读，原文已省略]');
  assert.equal(rows[1].message.content, 'raw two');
});

test('ledger checks off a session\'s open tasks and instructions append as lines', async (t) => {
  const { store } = await storeFor(t);
  assert.equal(store.instructions(), '');
  store.addTask({ agent: 'codex', session: 's1', task: '跑测试' });
  store.addTask({ agent: 'codex', session: 's1', task: '修 lint' });
  store.addTask({ agent: 'claude', session: 's2', task: '看登录' });
  assert.equal(store.finishTasks('codex', 's1'), 2);
  assert.deepEqual(store.openTasks().map((task) => task.task), ['看登录']);
  store.addInstruction('DeepSeek 只做测试');
  assert.equal(store.instructions(), '- DeepSeek 只做测试\n');
  assert.equal(store.nextTurn(), 1);
  store.append({ role: 'user', content: 'x' }, { turn: 4, kind: 'chat' });
  assert.equal(store.nextTurn(), 5);
  store.setMeta('promptTokens', 12);
  assert.equal(store.meta('promptTokens'), 12);
  store.clear();
  assert.equal(store.messages().length, 0);
  assert.equal(store.openTasks().length, 1, 'clearing history keeps tasks');
});

test('ledger keeps the user\'s words and push count, and migrates an old table without them', async (t) => {
  const dir = await tempDir(t);
  const db = new DatabaseSync(join(dir, 'events.sqlite'));
  t.after(() => db.close());
  db.exec('CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  db.exec('CREATE TABLE zg_task (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, session TEXT NOT NULL, task TEXT NOT NULL, at INTEGER NOT NULL, done_at INTEGER)');
  db.exec("INSERT INTO zg_task(agent, session, task, at) VALUES ('codex', 's1', '旧活', 1)");
  const store = new ZongguanStore(db, join(dir, 'zongguan.md'));
  assert.deepEqual(store.openTasks().map((task) => [task.task, task.said, task.pushes]), [['旧活', '', 0]]);
  store.addTask({ agent: 'codex', session: 's1', task: '新活', said: '做个新活', pushes: 1 });
  store.finishTasks('codex', 's1');
  assert.deepEqual([store.lastTask('codex', 's1').task, store.lastTask('codex', 's1').said, store.lastTask('codex', 's1').pushes], ['新活', '做个新活', 1]);
  assert.equal(store.lastTask('codex', 'nope'), null);
  new ZongguanStore(db, join(dir, 'zongguan.md'));
});

/* ---------- tools ---------- */

/** Tools over a real State with two sessions, and fakes that record what the gateway was asked to do. */
async function toolsFor(t) {
  const { store, dir } = await storeFor(t);
  const state = new State(join(dir, 'gateway.sqlite'));
  t.after(() => state.db.close());
  state.put('codex', 's1', { name: 'relay部署脚本', cwd: '/Users/me/relay', status: 'idle', capabilities: ['history', 'send', 'interrupt'] });
  state.put('claude', 's2', { name: '眼镜胶囊', cwd: '/Users/me/glasses', status: 'running', capabilities: ['history', 'send', 'interrupt'] });
  state.put('claude', 'h1', { name: 'helper', cwd: '/Users/me/.vibe-island/x', status: 'idle', capabilities: ['history', 'send'] });
  const calls = { submit: [], history: [], queue: [], create: [], control: [] };
  const tools = new ZongguanTools({
    state, store,
    submit: async (...args) => { calls.submit.push(args); return { turnId: 't1' }; },
    history: async (agent, id, options) => {
      calls.history.push([agent, id, options]);
      const rows = [{ role: 'user', text: '跑一下测试' }, { role: 'assistant', text: calls.reply ?? '测试 14 个过了 12 个。' }];
      return options?.tools ? [rows[0], { role: 'tool', text: '', tool: { type: 'commandExecution', command: 'npm test' } }, rows[1]] : rows;
    },
    queue: (...args) => { calls.queue.push(args); return { st: 'queued', h: '这轮结束后发' }; },
    create: async (...args) => { calls.create.push(args); return { id: 'new1' }; },
    canCreate: (agent) => agent !== 'grok',
    control: async (...args) => { calls.control.push(args); return { ok: true }; },
  });
  tools.agent = { compact: async () => { calls.compacted = true; }, clearHistory: () => {}, publishReport: (text) => { calls.report = text; },
    holdReport: (text) => { calls.held = text; } };
  return { tools, state, store, calls };
}

const userTurn = (id = 2, userAt = Date.now() + 10, said = '用户说的话') => ({ id, source: 'user', userAt, said });
const eventTurn = (id = 2, urgent = false) => ({ id, source: 'event', userAt: 0, urgent });

test('toolSpecs name exactly the dispatch tools and nothing that does work', () => {
  assert.deepEqual(toolSpecs.map((tool) => tool.function.name), ['list_sessions', 'read_session', 'send_to_session', 'start_session',
    'interrupt_session', 'answer_request', 'follow_up', 'recommend', 'track_session', 'drop_session', 'compact', 'clear_history', 'remember_instruction', 'report', 'show_card', 'offer_choices']);
});

test('read_session returns output text only unless include_tools is set', async (t) => {
  const { tools, calls } = await toolsFor(t);
  const plain = await tools.run('read_session', { agent: 'codex', id: 's1' }, userTurn());
  assert.equal(plain.kind, 'read');
  assert.match(plain.content, /你：跑一下测试/);
  assert.match(plain.content, /它：测试 14 个过了 12 个。/);
  assert.doesNotMatch(plain.content, /工具：/);
  assert.deepEqual(calls.history[0][2], { tools: false });
  const full = await tools.run('read_session', { agent: 'codex', id: 's1', include_tools: true }, userTurn());
  assert.match(full.content, /工具：运行 npm test/);
  assert.deepEqual(calls.history[1][2], { tools: true });
  assert.equal(plain.block.kind, 'tool');
  assert.match(plain.block.text, /^读 Codex·relay部署脚本/);
});

test('send_to_session sends to an idle session and records a task with the user\'s words', async (t) => {
  const { tools, store, calls } = await toolsFor(t);
  const out = await tools.run('send_to_session', { agent: 'codex', id: 's1', text: '跑一下测试' }, userTurn(2, Date.now() + 10, '跑下测试，顺便修 lint'));
  assert.equal(calls.submit.length, 1);
  assert.deepEqual(calls.submit[0].slice(0, 3), ['codex', 's1', '跑一下测试\n\n用户原话：「跑下测试，顺便修 lint」']);
  assert.equal(calls.submit[0][4], true, 'requireIdle');
  assert.deepEqual(store.openTasks().map((task) => [task.agent, task.session, task.task, task.said, task.pushes]),
    [['codex', 's1', '跑一下测试', '跑下测试，顺便修 lint', 0]]);
  assert.match(out.content, /已发/);
});

test('send_to_session is refused in a turn only session news started, and points to follow_up', async (t) => {
  const { tools, store, calls } = await toolsFor(t);
  const out = await tools.run('send_to_session', { agent: 'codex', id: 's1', text: '再跑一遍' }, eventTurn());
  assert.equal(calls.submit.length, 0);
  assert.equal(calls.queue.length, 0);
  assert.match(out.content, /follow_up/);
  assert.equal(store.openTasks().length, 0);
});

test('follow_up sends only quotes from the user\'s words, with the words, and only once per task', async (t) => {
  const { tools, store, calls } = await toolsFor(t);
  await tools.run('send_to_session', { agent: 'codex', id: 's1', text: '跑测试并修 lint' }, userTurn(2, Date.now() + 10, '跑下测试，顺便修 lint'));
  store.finishTasks('codex', 's1');
  const first = await tools.run('follow_up', { agent: 'codex', id: 's1', missing: ['顺便修 lint'] }, eventTurn(3));
  assert.equal(calls.submit.length, 2);
  assert.equal(calls.submit[1][2], '你说过：「顺便修 lint」，这条还没做，请补上。\n\n用户原话：「跑下测试，顺便修 lint」');
  assert.equal(calls.submit[1][4], true, 'requireIdle');
  assert.match(first.content, /已追/);
  assert.deepEqual(store.openTasks().map((task) => [task.said, task.pushes]), [['跑下测试，顺便修 lint', 1]]);
  assert.equal(first.block.text, '追问 Codex·relay部署脚本：顺便修 lint');
  store.finishTasks('codex', 's1');
  const second = await tools.run('follow_up', { agent: 'codex', id: 's1', missing: ['顺便修 lint'] }, eventTurn(4));
  assert.equal(calls.submit.length, 2, 'no second automatic push');
  assert.match(second.content, /已经自动追过一次了，问用户要不要再追/);
});

test('follow_up refuses quotes that are not in the user\'s words, a busy session, and a task without words', async (t) => {
  const { tools, store, calls } = await toolsFor(t);
  const none = await tools.run('follow_up', { agent: 'codex', id: 's1', missing: ['修 lint'] }, eventTurn());
  assert.match(none.content, /没有用户原话/);
  await tools.run('send_to_session', { agent: 'codex', id: 's1', text: '跑测试' }, userTurn(2, Date.now() + 10, '跑下测试，顺便修 lint'));
  store.finishTasks('codex', 's1');
  const made = await tools.run('follow_up', { agent: 'codex', id: 's1', missing: ['顺便把文档也改了'] }, eventTurn(3));
  assert.match(made.content, /用户原话里没有：顺便把文档也改了/);
  const spaced = await tools.run('follow_up', { agent: 'codex', id: 's1', missing: ['顺便修lint'] }, eventTurn(3));
  assert.match(spaced.content, /已追/, 'whitespace does not matter');
  const busy = await tools.run('follow_up', { agent: 'claude', id: 's2', missing: ['x'] }, eventTurn(4));
  assert.match(busy.content, /它正在忙/);
  assert.equal(calls.submit.length, 2);
});

test('send_to_session queues a note for a busy session and refuses a task', async (t) => {
  const { tools, store, calls } = await toolsFor(t);
  const note = await tools.run('send_to_session', { agent: 'claude', id: 's2', text: '顺便看下样式', mode: 'note' },
    userTurn(2, Date.now() + 10, '顺便看看样式吧'));
  assert.deepEqual(calls.queue[0], ['claude', 's2', '顺便看下样式\n\n用户原话：「顺便看看样式吧」',
    { origin: 'zongguan', said: '顺便看看样式吧' }], 'the queued note carries the words and who wrote it');
  assert.match(note.content, /这轮结束后发/);
  const task = await tools.run('send_to_session', { agent: 'claude', id: 's2', text: '换个方向' }, userTurn());
  assert.equal(calls.submit.length, 0);
  assert.match(task.content, /它正在忙：要打断先用 interrupt_session，或者用 mode=note 排队/);
  assert.equal(store.openTasks().length, 0);
});

test('send_to_session from a user turn ends with the user\'s own words and is stamped as 总管\'s', async (t) => {
  const { tools, calls } = await toolsFor(t);
  const stamped = [];
  tools.stamp = (agent, id, text, meta) => { stamped.push([agent, id, text, meta]); return text + '〔章〕'; };
  await tools.run('send_to_session', { agent: 'codex', id: 's1', text: '请重启网关，并把 0.9.1 放进 Spare App' },
    userTurn(2, Date.now() + 10, '重启吧。'));
  assert.equal(calls.submit[0][2], '请重启网关，并把 0.9.1 放进 Spare App\n\n用户原话：「重启吧。」〔章〕');
  assert.deepEqual(stamped[0][3], { origin: 'zongguan', said: '重启吧。' });
});

test('send_to_session on a vanished session explains instead of throwing', async (t) => {
  const { tools } = await toolsFor(t);
  const out = await tools.run('send_to_session', { agent: 'codex', id: 'gone', text: 'hi' }, userTurn());
  assert.match(out.content, /这个会话已经不在了，先 list_sessions/);
});

test('start and interrupt need a pending confirmation and a later user turn', async (t) => {
  const { tools, calls } = await toolsFor(t);
  const ask = await tools.run('interrupt_session', { agent: 'codex', id: 's1' }, userTurn(2, Date.now() - 1000));
  assert.match(ask.content, /需要用户点头/);
  assert.equal(ask.card.kind, 'confirm');
  const confirmId = ask.card.confirmId;
  assert.equal(calls.control.length, 0);
  const early = await tools.run('interrupt_session', { agent: 'codex', id: 's1', confirmed: true, confirm_id: confirmId }, userTurn(2, Date.now() - 1000));
  assert.match(early.content, /等用户说好再做/);
  const fromEvent = await tools.run('interrupt_session', { agent: 'codex', id: 's1', confirmed: true, confirm_id: confirmId }, eventTurn(3));
  assert.match(fromEvent.content, /等用户说好再做/);
  const other = await tools.run('interrupt_session', { agent: 'claude', id: 's2', confirmed: true, confirm_id: confirmId }, userTurn(3));
  assert.match(other.content, /等用户说好再做/);
  const done = await tools.run('interrupt_session', { agent: 'codex', id: 's1', confirmed: true, confirm_id: confirmId }, userTurn(3));
  assert.deepEqual(calls.control[0], ['codex', 's1', 'interrupt']);
  assert.match(done.content, /已打断/);
  assert.equal(tools.pending.size, 0);
  const start = await tools.run('start_session', { agent: 'claude', text: '看看登录那块' }, userTurn(4, Date.now() - 1000));
  assert.equal(start.card.kind, 'confirm');
  const ran = await tools.runConfirmed(start.card.confirmId);
  assert.deepEqual(calls.create[0], ['claude', '看看登录那块', {}]);
  assert.match(ran.content, /已开/);
  const grok = await tools.run('start_session', { agent: 'grok', text: 'x' }, userTurn());
  assert.match(grok.content, /不能新开/);
});

test('answer_request works only in a turn the user started', async (t) => {
  const { tools, state } = await toolsFor(t);
  const decisions = [];
  const id = state.addRequest('codex', 's1', { kind: 'approval', title: 'Run a command', description: 'rm -rf dist' }, async (decision) => { decisions.push(decision); });
  const refused = await tools.run('answer_request', { request_id: id, decision: 'allow' }, eventTurn());
  assert.match(refused.content, /只有用户开口后才能替他批准或回答/);
  assert.equal(decisions.length, 0);
  const allowed = await tools.run('answer_request', { request_id: id, decision: 'allow' }, userTurn());
  assert.deepEqual(decisions, [{ decision: 'accept' }]);
  assert.match(allowed.content, /已允许/);
  const q = state.addRequest('claude', 's2', { kind: 'input', title: 'Claude needs an answer', questions: [{ id: 'q1', text: '用哪个?', options: ['A', 'B'] }] }, async (decision) => { decisions.push(decision); });
  await tools.run('answer_request', { request_id: q, option: 2 }, userTurn());
  assert.deepEqual(decisions.at(-1), { answers: { q1: 'B' } });
});

test('recommend checks the choice, keeps the advice for the card and the prompt, and answering clears it', async (t) => {
  const { tools, state } = await toolsFor(t);
  const decisions = [];
  const id = state.addRequest('codex', 's1', { kind: 'approval', title: 'Run a command', description: 'npm test' }, async (value) => { decisions.push(value); });
  const q = state.addRequest('claude', 's2', { kind: 'input', title: 'Claude needs an answer', questions: [{ id: 'q1', text: '用哪个?', options: ['A', 'B'] }] }, async () => {});
  assert.match((await tools.run('recommend', { request_id: 'nope', decision: 'allow', reason: 'x' }, eventTurn())).content, /已经处理过了/);
  assert.match((await tools.run('recommend', { request_id: id, option: 1, reason: 'x' }, eventTurn())).content, /批准请求要给 decision/);
  assert.match((await tools.run('recommend', { request_id: q, decision: 'allow', reason: 'x' }, eventTurn())).content, /要给 option/);
  assert.match((await tools.run('recommend', { request_id: q, option: 3, reason: 'x' }, eventTurn())).content, /没有第 3 个选项/);
  assert.match((await tools.run('recommend', { request_id: id, decision: 'allow', reason: '  ' }, eventTurn())).content, /要写一句理由/);
  const made = await tools.run('recommend', { request_id: id, decision: 'allow', reason: '只跑测试，不改东西，也不联网，很安全的' }, eventTurn());
  assert.deepEqual(made.card, { kind: 'request', requestId: id });
  assert.deepEqual(tools.advice.get(id), { decision: 'allow', reason: '只跑测试，不改东西，也不联网' }, 'the reason keeps to 14 characters');
  assert.equal(made.block.text, '建议 允许：只跑测试，不改东西，也不联网…');
  await tools.run('recommend', { request_id: q, option: 2, reason: 'B 改动小' }, eventTurn());
  assert.equal(tools.adviceText(q), '选 2（B 改动小）');
  assert.equal(tools.adviceText(id), '允许（只跑测试，不改东西，也不联网）');
  await tools.run('answer_request', { request_id: id, decision: 'allow' }, userTurn());
  assert.deepEqual(decisions, [{ decision: 'accept' }]);
  assert.equal(tools.advice.has(id), false, 'answering clears the advice');
});

test('list_sessions shows waiting requests and hides helper sessions', async (t) => {
  const { tools, state } = await toolsFor(t);
  const id = state.addRequest('codex', 's1', { kind: 'approval', title: 'Run a command', description: 'rm -rf dist' }, async () => {});
  const out = await tools.run('list_sessions', {}, userTurn());
  assert.match(out.content, /Codex · relay部署脚本 · relay · 等你批准/, 'a waiting request shows as the status');
  assert.match(out.content, /Claude · 眼镜胶囊 · glasses · 运行中/);
  assert.ok(out.content.includes('等你批准 request=' + id + '：要运行命令'));
  assert.doesNotMatch(out.content, /helper/);
});

test('list_sessions says how long ago each session moved and can keep only the recent ones', async (t) => {
  const { tools, state } = await toolsFor(t);
  state.put('codex', 's1', { updatedAt: Date.now() - 5 * 60000 });
  state.put('claude', 's2', { updatedAt: Date.now() - 3 * 3600000 });
  const all = await tools.run('list_sessions', {}, userTurn());
  assert.match(all.content, /Codex · relay部署脚本 · relay · 空闲 · 5 分钟前/);
  assert.match(all.content, /Claude · 眼镜胶囊 · glasses · 运行中 · 3 小时前/);
  const recent = await tools.run('list_sessions', { since_minutes: 60 }, userTurn());
  assert.match(recent.content, /relay部署脚本/);
  assert.doesNotMatch(recent.content, /眼镜胶囊/);
  assert.match((await tools.run('list_sessions', { since_minutes: 1 }, userTurn())).content, /最近 1 分钟没有动过的会话/);
});

test('offer_choices hands 总管 two to five short options and leaves no line on the page', async (t) => {
  const { tools } = await toolsFor(t);
  let kept = null;
  tools.agent.setChoices = (options) => { kept = options; };
  const out = await tools.run('offer_choices', { options: [' 看看 Claude 在干嘛 ', '跟进宣传视频没结果的'] }, userTurn());
  assert.deepEqual(kept, ['看看 Claude 在干嘛', '跟进宣传视频没结果的']);
  assert.equal(out.block, null, 'preparing options is not something the user needs to see');
  assert.match((await tools.run('offer_choices', { options: ['只有一个'] }, userTurn())).content, /两到五个/);
});

test('report, remember_instruction and show_card reach the agent, the file and the page', async (t) => {
  const { tools, store, state, calls } = await toolsFor(t);
  await tools.run('report', { text: 'Codex 测试过了；Claude 等你批准' }, eventTurn(2, true));
  assert.equal(calls.report, 'Codex 测试过了；Claude 等你批准');
  const held = await tools.run('report', { text: 'Codex 做完了' }, eventTurn(3));
  assert.equal(calls.held, 'Codex 做完了', 'news that is not urgent is held');
  assert.equal(calls.report, 'Codex 测试过了；Claude 等你批准');
  assert.match(held.content, /一起报/);
  await tools.run('remember_instruction', { text: 'DeepSeek 只做测试' }, userTurn());
  assert.equal(store.instructions(), '- DeepSeek 只做测试\n');
  const id = state.addRequest('codex', 's1', { kind: 'approval', title: 'Run a command' }, async () => {});
  assert.deepEqual((await tools.run('show_card', { request_id: id }, userTurn())).card, { kind: 'request', requestId: id });
  const session = await tools.run('show_card', { agent: 'claude', id: 's2' }, userTurn());
  assert.deepEqual(session.block, { kind: 'detail', text: 'Claude · 眼镜胶囊 · 运行中' });
});

/* ---------- agent loop ---------- */

/** A turn Relay sent: the session is idle, gets a message through the gateway, then runs. */
function relayTurn(state, agent, id) {
  state.put(agent, id, { status: 'idle' });
  state.event('message.requested', agent, id);
  state.put(agent, id, { status: 'running' });
}


const reply = (content, promptTokens = 100) => ({ message: { role: 'assistant', content }, promptTokens });
const calling = (name, args = {}, id = 'call-' + name) => ({
  message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
  promptTokens: 100,
});

/** A model that answers from a script and records every request. A function entry can hold the answer back. */
function scripted(script) {
  const inputs = [];
  return {
    inputs,
    async complete(request) {
      inputs.push(request);
      const next = script.shift();
      if (typeof next === 'function') return next(request);
      if (next instanceof Error) throw next;
      return next ?? reply('好');
    },
  };
}

async function settled(zg) {
  for (let i = 0; i < 200; i++) {
    if (zg.view().status !== 'working' && !zg.busy) return;
    await delay(10);
  }
  throw new Error('总管 did not settle');
}

async function agentFor(t, script, options = {}) {
  const fixture = await toolsFor(t);
  const model = scripted(script);
  const zg = new Zongguan({ state: fixture.state, store: fixture.store, tools: fixture.tools, model, batchMs: 30, ...options });
  zg.watch();
  t.after(() => zg.close());
  return { ...fixture, model, zg };
}

test('a spoken request runs tools and ends with a short reply block', async (t) => {
  const { zg, model } = await agentFor(t, [calling('list_sessions'), reply('两个在跑，一个等你。')]);
  assert.deepEqual(await zg.hear('现在都在干嘛', 'glasses'), { st: 'sent', h: '总管收到' });
  await settled(zg);
  assert.deepEqual(zg.view().blocks.map((block) => block.kind), ['user', 'tool', 'reply']);
  assert.equal(zg.view().blocks[1].text, '看所有会话');
  assert.equal(zg.view().blocks[2].text, '两个在跑，一个等你。');
  assert.equal(zg.view().status, 'idle');
  assert.equal(model.inputs[0].messages[0].role, 'system');
  assert.match(model.inputs[0].messages[0].content, /总管/);
  assert.equal(model.inputs[1].messages.at(-1).role, 'tool', 'the tool result goes back to the model');
});

test('what 总管 forwards keeps the user\'s words and the prompt forbids adding meaning', async (t) => {
  const { zg, model, calls } = await agentFor(t, [
    calling('send_to_session', { agent: 'codex', id: 's1', text: '用户说：重启。请按你的方案重启网关并装眼镜。' }), reply('转给它了。')]);
  await zg.hear('重启吧。', 'glasses');
  await settled(zg);
  assert.match(calls.submit[0][2], /\n\n用户原话：「重启吧。」$/);
  assert.match(model.inputs[0].messages[0].content, /不加意思/);
});

test('speech during a turn is queued and answered right after', async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { zg, model } = await agentFor(t, [() => held.then(() => reply('第一件')), reply('第二件')]);
  await zg.hear('第一件事', 'glasses');
  await delay(20);
  assert.equal(zg.view().status, 'working');
  assert.deepEqual(await zg.hear('第二件事', 'glasses'), { st: 'queued', h: '总管收到，这件做完就办' });
  release();
  await settled(zg);
  assert.equal(model.inputs.length, 2);
  assert.equal(model.inputs[1].messages.at(-1).content, '第二件事');
  assert.deepEqual(zg.view().blocks.map((block) => block.text), ['第一件事', '第一件', '第二件事', '第二件']);
});

test('a model failure leaves one error block and the next speech works', async (t) => {
  const { zg } = await agentFor(t, [new Error('down'), reply('好了')]);
  await zg.hear('在吗', 'glasses');
  await settled(zg);
  assert.equal(zg.view().blocks.at(-1).kind, 'error');
  assert.equal(zg.view().status, 'idle');
  await zg.hear('再试一次', 'glasses');
  await settled(zg);
  assert.equal(zg.view().blocks.at(-1).text, '好了');
});

test('three sessions finishing within the batch window make one event turn and at most one report', async (t) => {
  const { zg, model, state } = await agentFor(t, [calling('report', { text: 'Codex 和 Claude 都做完了' }), reply('记下了')]);
  relayTurn(state, 'claude', 's2');
  state.event('message.requested', 'codex', 's3');
  state.put('codex', 's3', { name: '第三个', status: 'running', capabilities: ['history', 'send'] });
  state.event('message.requested', 'codex', 's1');
  state.put('codex', 's1', { status: 'running' });
  await delay(5);
  state.put('codex', 's1', { status: 'idle' });
  state.put('claude', 's2', { status: 'idle' });
  state.put('codex', 's3', { status: 'idle' });
  await delay(80);
  await settled(zg);
  assert.equal(model.inputs.length, 2, 'one event turn: the report call and the closing reply');
  const event = model.inputs[0].messages.at(-1).content;
  assert.equal(event.match(/Message Type: FINAL_ANSWER/g).length, 3);
  assert.match(event, /Sender: Codex·relay部署脚本 \(codex:s1\)/);
  assert.match(event, /Payload: 测试 14 个过了 12 个。/);
  assert.equal(zg.reports.length, 0, 'finished work is not urgent: the report waits');
  assert.deepEqual(zg.held, ['Codex 和 Claude 都做完了']);
  zg.markRead();
  assert.deepEqual(zg.reports.map((report) => report.text), ['Codex 和 Claude 都做完了'], 'opening 总管\'s page lets it out');
  assert.equal(zg.unread, false);
  assert.deepEqual(zg.held, []);
});

test('held reports go out together when the user speaks', async (t) => {
  const { zg, state } = await agentFor(t, [calling('report', { text: '✓ Codex：测试过了' }), reply('记下了'), reply('在')]);
  state.event('message.requested', 'codex', 's1');
  state.put('codex', 's1', { status: 'running' });
  await delay(5);
  state.put('codex', 's1', { status: 'idle' });
  await delay(80);
  await settled(zg);
  assert.equal(zg.reports.length, 0);
  await zg.hear('在吗', 'glasses');
  assert.deepEqual(zg.reports.map((report) => report.text), ['✓ Codex：测试过了']);
  assert.equal(zg.unread, true);
  await settled(zg);
});

test('an approval\'s report goes out at once and takes what was held along', async (t) => {
  const { zg, state } = await agentFor(t, [calling('report', { text: '✓ Codex：测试过了' }), reply('记下了'),
    calling('report', { text: '? Claude：要跑 rm' }), reply('等你批')]);
  state.event('message.requested', 'codex', 's1');
  state.put('codex', 's1', { status: 'running' });
  await delay(5);
  state.put('codex', 's1', { status: 'idle' });
  await delay(80);
  await settled(zg);
  state.addRequest('claude', 's2', { kind: 'approval', title: 'Run a command', command: 'rm -rf dist' }, async () => {});
  state.emit('event', { kind: 'attention', agent: 'claude', session: 's2' });
  await delay(80);
  await settled(zg);
  assert.deepEqual(zg.reports.map((report) => report.text), ['✓ Codex：测试过了；? Claude：要跑 rm']);
  assert.deepEqual(zg.held, []);
});

test('held reports go out by themselves after the window, and a long pile is shortened', async (t) => {
  const { zg } = await agentFor(t, [], { digestMs: 30 });
  zg.holdReport('✓ Codex：部署脚本改好了，测试也全过了');
  zg.holdReport('✓ Claude：眼镜胶囊的样式修好了');
  assert.equal(zg.reports.length, 0);
  await delay(60);
  assert.equal(zg.reports.length, 1);
  assert.equal(zg.reports[0].text, '2 件事：✓ Codex：部署脚本改好了，测试也全过了');
});

test('a finished turn checks off that session\'s open tasks', async (t) => {
  const { zg, store, state } = await agentFor(t, [reply('知道了')]);
  relayTurn(state, 'claude', 's2');
  store.addTask({ agent: 'claude', session: 's2', task: '修样式' });
  state.put('claude', 's2', { status: 'idle' });
  await delay(80);
  await settled(zg);
  assert.equal(store.openTasks().length, 0);
});

test('a finished session\'s news carries the user\'s words for the task, and says when it was pushed already', async (t) => {
  const { zg, store, state, model, calls } = await agentFor(t, [reply('对过了'), reply('对过了')]);
  relayTurn(state, 'claude', 's2');
  store.addTask({ agent: 'claude', session: 's2', task: '修样式', said: '把样式修了，顺便加个暗色' });
  state.put('claude', 's2', { status: 'idle' });
  await delay(80);
  await settled(zg);
  const first = model.inputs[0].messages.at(-1).content;
  assert.match(first, /Payload: 测试 14 个过了 12 个。\n派活时用户原话：「把样式修了，顺便加个暗色」$/);
  calls.reply = '暗色也加了。';
  store.addTask({ agent: 'claude', session: 's2', task: '追问：顺便加个暗色', said: '把样式修了，顺便加个暗色', pushes: 1 });
  state.event('message.requested', 'claude', 's2');
  state.put('claude', 's2', { status: 'running' });
  await delay(5);
  state.put('claude', 's2', { status: 'idle' });
  await delay(80);
  await settled(zg);
  assert.match(model.inputs[1].messages.at(-1).content, /派活时用户原话：「把样式修了，顺便加个暗色」（已经自动追过一次）$/);
  assert.match(model.inputs[0].messages[0].content, /follow_up/, 'the prompt says how to check and push');
});

test('a session finishing again with the reply 总管 already heard is no news: its status only flapped', async (t) => {
  const { zg, state, model, calls } = await agentFor(t, [reply('知道了'), reply('知道了')]);
  const finish = async () => {
    relayTurn(state, 'claude', 's2');
    state.put('claude', 's2', { status: 'idle' });
    await delay(80);
    await settled(zg);
  };
  await finish();
  await finish();
  assert.equal(model.inputs.length, 1, 'the same reply a second time is dropped');
  calls.reply = '测试全过了。';
  await finish();
  assert.equal(model.inputs.length, 2);
  assert.match(model.inputs[1].messages.at(-1).content, /Payload: 测试全过了。$/);
});

test('a waiting request shows 总管\'s advice in the prompt, and 总管 hands it to the glasses', async (t) => {
  const { zg, state, model, tools } = await agentFor(t, [reply('好')]);
  const id = state.addRequest('codex', 's1', { kind: 'approval', title: 'Run a command', description: 'npm test' }, async () => {});
  tools.advice.set(id, { decision: 'allow', reason: '只跑测试' });
  assert.deepEqual(zg.adviceFor(id), { decision: 'allow', reason: '只跑测试' });
  assert.equal(zg.adviceFor('nope'), null);
  await zg.hear('好', 'glasses');
  await settled(zg);
  assert.ok(model.inputs[0].messages[0].content.includes('request=' + id + ' Codex：Run a command：npm test · 总管建议：允许（只跑测试）'));
  assert.match(model.inputs[0].messages[0].content, /recommend/, 'the prompt says when to recommend');
});

test('a turn the user runs on the computer brings 总管 no news; a turn Relay sent does, Claude Code included', async (t) => {
  const { zg, state, model } = await agentFor(t, [reply('知道了')], { stallMs: 20, stallEvery: 10 });
  state.put('claude', 's2', { status: 'idle' });
  state.put('codex', 's1', { status: 'running' });
  await delay(60);
  state.put('codex', 's1', { status: 'failed' });
  await delay(60);
  await settled(zg);
  assert.equal(model.inputs.length, 0, 'finished, stalled or failed on the computer: nothing');
  relayTurn(state, 'claude', 's2');
  state.put('claude', 's2', { status: 'idle' });
  await delay(80);
  await settled(zg);
  assert.equal(model.inputs.length, 1);
  assert.match(model.inputs[0].messages.at(-1).content, /Message Type: FINAL_ANSWER\nSender: Claude·眼镜胶囊/);
});

test('a message Relay sent behind the user\'s own running turn is reported for its own turn, not the user\'s', async (t) => {
  const { zg, state, model } = await agentFor(t, [reply('知道了')]);
  await delay(5);
  state.event('message.requested', 'claude', 's2');
  state.put('claude', 's2', { status: 'idle' });
  await delay(80);
  await settled(zg);
  assert.equal(model.inputs.length, 0, 'the turn that ends here began on the computer');
  await delay(5);
  state.put('claude', 's2', { status: 'running' });
  state.put('claude', 's2', { status: 'idle' });
  await delay(80);
  await settled(zg);
  assert.equal(model.inputs.length, 1, 'the queued message\'s own turn');
});

test('a session Relay started counts from its first turn, and Relay\'s stalls and failures still come', async (t) => {
  const { zg, state, model } = await agentFor(t, [reply('知道了'), reply('知道了')], { stallMs: 20, stallEvery: 10 });
  state.put('codex', 'n1', { name: '新的', status: 'running', capabilities: ['history', 'send'] });
  state.event('session.created', 'codex', 'n1');
  await delay(80);
  await settled(zg);
  assert.match(model.inputs[0].messages.at(-1).content, /Message Type: STALLED\nSender: Codex·新的/);
  state.put('codex', 'n1', { status: 'failed' });
  await delay(80);
  await settled(zg);
  assert.match(model.inputs[1].messages.at(-1).content, /Message Type: FAILED\nSender: Codex·新的/);
});

test('track and drop only on the user\'s word; a tracked session is listed for 总管 and kept across restarts', async (t) => {
  const { zg, tools, store, state, model } = await agentFor(t, [reply('好')]);
  state.put('grok', 'g1', { name: '投资群', status: 'idle', capabilities: ['history'] });
  assert.match((await tools.run('track_session', { agent: 'grok', id: 'g1' }, eventTurn())).content, /用户开口/);
  assert.match((await tools.run('track_session', { agent: 'grok', id: 'gone' }, userTurn())).content, /不在了/);
  const on = await tools.run('track_session', { agent: 'grok', id: 'g1' }, userTurn());
  assert.match(on.content, /开始盯 Grok·投资群/);
  assert.equal(on.block.text, '盯 Grok·投资群');
  assert.deepEqual(zg.tracked, ['grok:g1']);
  await zg.hear('在吗', 'glasses');
  await settled(zg);
  assert.match(model.inputs[0].messages[0].content, /## 你在盯的会话\n- Grok·投资群（grok:g1）/);
  const again = new Zongguan({ state, store, tools, model: scripted([]) });
  assert.deepEqual(again.tracked, ['grok:g1'], 'kept across a restart');
  again.close();
  tools.agent = zg; // the second instance took the tools over
  const off = await tools.run('drop_session', { agent: 'grok', id: 'g1' }, userTurn());
  assert.match(off.content, /不盯 Grok·投资群 了/);
  assert.deepEqual(zg.tracked, []);
  assert.match((await tools.run('drop_session', { agent: 'grok', id: 'g1' }, userTurn())).content, /本来就没盯/);
});

test('a tracked session\'s new reply reaches 总管 once things are quiet, wherever it came from; after drop it does not', async (t) => {
  const { zg, tools, state, model } = await agentFor(t, [reply('知道了'), reply('知道了'), reply('知道了')], { quietMs: 30 });
  state.put('grok', 'g1', { name: '投资群', status: 'idle', updatedAt: 100, capabilities: ['history'] });
  state.put('codex', 's1', { updatedAt: 100 });
  let said = '旧的回复';
  tools.history = async () => [{ role: 'assistant', text: said }];
  await tools.run('track_session', { agent: 'grok', id: 'g1' }, userTurn());
  await tools.run('track_session', { agent: 'codex', id: 's1' }, userTurn());
  await tools.run('track_session', { agent: 'claude', id: 's2' }, userTurn());
  await delay(10);
  state.event('activity', 'grok', 'g1');
  await delay(80);
  await settled(zg);
  assert.equal(model.inputs.length, 0, 'the same reply as when tracking began: nothing new');
  said = '新回复：金价破 3000';
  state.event('activity', 'grok', 'g1');
  await delay(10);
  state.event('activity', 'grok', 'g1');
  await delay(80);
  await settled(zg);
  assert.equal(model.inputs.length, 1, 'one report after it went quiet');
  assert.match(model.inputs[0].messages.at(-1).content, /Message Type: NEW_REPLY\nSender: Grok·投资群 \(grok:g1\)\nPayload: 新回复：金价破 3000/);
  said = 'Codex 在电脑上改完了';
  state.put('codex', 's1', { updatedAt: 200 });
  await delay(80);
  await settled(zg);
  assert.match(model.inputs[1].messages.at(-1).content, /NEW_REPLY\nSender: Codex·relay部署脚本[\s\S]*Codex 在电脑上改完了/, 'Codex: its update time moved');
  said = 'Claude 在电脑上做完了';
  state.put('claude', 's2', { status: 'idle' });
  await delay(80);
  await settled(zg);
  assert.match(model.inputs[2].messages.at(-1).content, /FINAL_ANSWER\nSender: Claude·眼镜胶囊[\s\S]*Claude 在电脑上做完了/, 'a tracked Claude turn on the computer');
  assert.equal(model.inputs.length, 3);
  await delay(80);
  assert.equal(model.inputs.length, 3, 'the finished turn is not reported again as a new reply');
  await tools.run('drop_session', { agent: 'grok', id: 'g1' }, userTurn());
  said = '又一条';
  state.event('activity', 'grok', 'g1');
  await delay(80);
  await settled(zg);
  assert.equal(model.inputs.length, 3, 'dropped: nothing');
});

test('the common commands and the time of day are in 总管\'s prompt', async (t) => {
  const { zg, store, model } = await agentFor(t, [reply('在')], { now: () => new Date(2026, 10, 19, 9, 5).getTime() });
  writeFileSync(store.commandsPath, '- 现在都在干嘛\n\n跟进一下今天没结果的\n');
  await zg.hear('在吗');
  await settled(zg);
  const prompt = model.inputs[0].messages[0].content;
  assert.match(prompt, /## 常用指令\n- 现在都在干嘛\n- 跟进一下今天没结果的\n/);
  assert.match(prompt, /## 现在\n2026-11-19 09:05/);
  assert.match(prompt, /offer_choices/, 'the prompt says to prepare the next options');
});

test('an empty call brings up the options 总管 prepared as a card, and a pick reaches it as the user\'s words', async (t) => {
  const { zg, store, state, tools, model } = await agentFor(t, [
    calling('offer_choices', { options: ['看看 Claude 在干嘛', '跟进宣传视频没结果的'] }), reply('在'), reply('Claude 空闲')]);
  await zg.hear('在吗');
  await settled(zg);
  assert.equal(zg.view().card, null, 'options wait until they are called up');
  assert.deepEqual(zg.menu(), { st: 'ok', h: '选一个' });
  const card = zg.view().card;
  assert.equal(card.kind, 'choices');
  assert.deepEqual(card.options, ['看看 Claude 在干嘛', '跟进宣传视频没结果的', '不用了']);
  assert.deepEqual(await zg.choose(card.choiceId, 1), { st: 'sent', h: '总管收到' });
  await settled(zg);
  assert.equal(zg.view().card, null, 'a pick closes the card');
  assert.equal(model.inputs[2].messages.at(-1).content, '看看 Claude 在干嘛');
  assert.deepEqual(zg.view().blocks.filter((block) => block.kind === 'user').map((block) => block.text), ['在吗', '看看 Claude 在干嘛']);
  const again = new Zongguan({ state, store, tools, model: scripted([]) });
  t.after(() => again.close());
  assert.deepEqual(again.choices, ['看看 Claude 在干嘛', '跟进宣传视频没结果的'], 'kept across restarts');
});

test('with no options prepared the card lists the first common commands; 不用了 closes it without a turn', async (t) => {
  const { zg, store, model } = await agentFor(t, []);
  assert.deepEqual(zg.menu(), { st: 'empty', h: '没听到内容' }, 'nothing to offer: as before');
  writeFileSync(store.commandsPath, ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => '- 指令' + x).join('\n'));
  zg.menu();
  const card = zg.view().card;
  assert.deepEqual(card.options, ['指令a', '指令b', '指令c', '指令d', '指令e', '不用了']);
  assert.deepEqual(await zg.choose(card.choiceId, 6), { st: 'ok', h: '好' });
  assert.equal(zg.view().card, null);
  assert.deepEqual(await zg.choose(card.choiceId, 1), { st: 'gone', h: '已经处理过了' });
  await delay(20);
  assert.equal(model.inputs.length, 0, 'closing the card asks 总管 nothing');
});

test('prompt tokens at the threshold compact before the next turn and leave a compacted block', async (t) => {
  const { zg, store, model } = await agentFor(t, [reply('之前聊了部署。'), reply('好')]);
  store.append({ role: 'user', content: '早先的话' }, { turn: 1, kind: 'chat' });
  store.append({ role: 'assistant', content: '早先的回答' }, { turn: 1, kind: 'chat' });
  store.setMeta('promptTokens', 300000);
  await zg.hear('继续', 'glasses');
  await settled(zg);
  assert.equal(model.inputs[0].tools, undefined, 'the summary request has no tools');
  assert.equal(store.messages()[0].kind, 'summary');
  assert.match(store.messages()[0].message.content, /之前聊了部署。/);
  assert.ok(zg.view().blocks.some((block) => block.kind === 'compacted' && /^— 已压缩 · /.test(block.text)));
  assert.equal(model.inputs[1].messages.at(-1).content, '继续');
});

test('the compact tool compacts on request and keeps the current turn valid', async (t) => {
  const { zg, store, model } = await agentFor(t, [calling('compact'), reply('摘要'), reply('收好了')]);
  store.append({ role: 'user', content: '早先的话' }, { turn: 1, kind: 'chat' });
  store.append({ role: 'assistant', content: '早先的回答' }, { turn: 1, kind: 'chat' });
  await zg.hear('收一下', 'glasses');
  await settled(zg);
  const roles = store.messages().map((row) => row.kind + ':' + row.message.role);
  assert.deepEqual(roles, ['summary:user', 'marker:assistant', 'chat:user', 'chat:assistant', 'chat:tool', 'chat:assistant']);
  assert.equal(model.inputs[2].messages.at(-1).role, 'tool');
  assert.equal(zg.view().contextPct, 0);
});

test('read results from earlier turns are elided before the next turn', async (t) => {
  const { zg, store } = await agentFor(t, [calling('read_session', { agent: 'codex', id: 's1' }), reply('它过了 12 个'), reply('好')]);
  await zg.hear('codex 怎么样', 'glasses');
  await settled(zg);
  assert.match(store.messages().find((row) => row.kind === 'read').message.content, /测试 14 个过了 12 个/);
  await zg.hear('好的', 'glasses');
  await settled(zg);
  assert.equal(store.messages().find((row) => row.kind === 'read').message.content, '[已读，原文已省略]');
});

test('a confirm card answered with yes runs the pending action', async (t) => {
  const { zg, calls } = await agentFor(t, [calling('interrupt_session', { agent: 'codex', id: 's1' }), reply('要打断 Codex 吗？')]);
  await zg.hear('让 codex 停下', 'glasses');
  await settled(zg);
  const card = zg.view().card;
  assert.equal(card.kind, 'confirm');
  assert.deepEqual(await zg.confirm(card.confirmId, true), { st: 'ok', h: '已打断 Codex·relay部署脚本。' });
  assert.deepEqual(calls.control[0], ['codex', 's1', 'interrupt']);
  assert.equal(zg.view().card, null);
  assert.deepEqual(zg.view().blocks.slice(-2).map((block) => [block.kind, block.text]), [['user', '好'], ['reply', '已打断 Codex·relay部署脚本。']]);
  assert.deepEqual(await zg.confirm(card.confirmId, true), { st: 'gone', h: '已经处理过了' });
});

test('a card answer waits for the running turn, so its messages never split a tool call from its result', async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { zg, store, calls } = await agentFor(t, [calling('interrupt_session', { agent: 'codex', id: 's1' }), reply('要打断 Codex 吗？'),
    calling('list_sessions', {}, 'call-held'), () => held.then(() => reply('看完了')), reply('收到')]);
  await zg.hear('让 codex 停下', 'glasses');
  await settled(zg);
  const { confirmId } = zg.view().card;
  await zg.hear('顺便看看都在干嘛', 'glasses');
  await delay(30);
  assert.equal(zg.busy, true, 'a turn holds a tool call open');
  assert.deepEqual(await zg.confirm(confirmId, true), { st: 'queued', h: '总管收到' });
  assert.equal(calls.control.length, 0, 'nothing runs mid-turn');
  release();
  await settled(zg);
  assert.deepEqual(calls.control[0], ['codex', 's1', 'interrupt'], 'the card answer runs once the turn is over');
  const roles = store.messages().map((row) => row.message);
  for (const [i, message] of roles.entries()) {
    if (!message.tool_calls) continue;
    for (const [k, call] of message.tool_calls.entries()) assert.equal(roles[i + 1 + k]?.tool_call_id, call.id, 'every tool call is followed by its result');
  }
});

test('words spoken before 总管 asked are not a yes to its question', async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { zg, calls } = await agentFor(t, [
    () => held.then(() => calling('start_session', { agent: 'codex', text: '跑测试', cwd: '/tmp' })),
    reply('要开一个 Codex 会话跑测试吗？'),
    (request) => {
      const id = /confirm_id=([0-9a-f-]+)/.exec(request.messages[0].content)?.[1];
      return calling('start_session', { agent: 'codex', text: '跑测试', cwd: '/tmp', confirmed: true, confirm_id: id }, 'call-again');
    },
    reply('好'),
  ]);
  await zg.hear('帮我跑一下测试', 'glasses');
  await delay(20);
  await zg.hear('今天天气怎么样', 'glasses');
  release();
  await settled(zg);
  assert.equal(calls.create.length, 0, 'the earlier words were said before the question');
});

test('session events that pile up during a turn become one batched turn with at most one report', async (t) => {
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { zg, state, model } = await agentFor(t, [() => held.then(() => reply('第一件')),
    calling('report', { text: '三个都做完了' }, 'r1'), calling('report', { text: '再说一遍' }, 'r2'), reply('好')], { batchMs: 5 });
  await zg.hear('盯着点', 'glasses');
  await delay(20);
  for (const id of ['s1', 'm1']) {
    state.event('message.requested', id === 's1' ? 'codex' : 'muse', id);
    state.put(id === 's1' ? 'codex' : 'muse', id, { status: 'running', updatedAt: Date.now(), capabilities: ['history', 'send'] });
  }
  await delay(20);
  state.put('codex', 's1', { status: 'idle' });
  await delay(30);
  state.put('muse', 'm1', { status: 'idle' });
  await delay(30);
  release();
  await settled(zg);
  const eventTurns = model.inputs.filter((input) => /Message Type: FINAL_ANSWER/.test(input.messages.at(-1).content ?? ''));
  assert.equal(eventTurns.length, 1, 'one turn for both');
  assert.match(eventTurns[0].messages.at(-1).content, /Codex[\s\S]*Muse|Muse[\s\S]*Codex/);
  assert.equal(zg.reports.length + zg.held.length, 1, 'one report per turn');
});

test('when the model fails on session events, standby still hears about it', async (t) => {
  const { zg, state } = await agentFor(t, [new ModelError(500, 'OpenCode answered 500')], { batchMs: 5 });
  state.event('message.requested', 'codex', 's1');
  state.put('codex', 's1', { status: 'running', updatedAt: Date.now(), capabilities: ['history', 'send'] });
  await delay(10);
  state.put('codex', 's1', { status: 'idle' });
  await delay(60);
  await settled(zg);
  assert.equal(zg.reports.length, 1);
  assert.match(zg.reports[0].text, /总管出错了/);
  assert.equal(zg.unread, true);
});

test('with no model 总管 is off and says how to configure it', async (t) => {
  const fixture = await toolsFor(t);
  const zg = new Zongguan({ state: fixture.state, store: fixture.store, tools: fixture.tools, model: null });
  assert.equal(zg.enabled, false);
  assert.deepEqual(await zg.hear('在吗', 'glasses'), { st: 'off', h: '总管没配好：钥匙串里没有 relay-opencode' });
  assert.equal(zg.view().status, 'off');
});
