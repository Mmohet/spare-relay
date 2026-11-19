import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { State } from '../lib/state.mjs';
import { HermesAcp, hermesTool } from '../lib/hermes.mjs';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, what, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await wait(10);
  }
  assert.fail('timed out waiting for ' + what);
}

/** A Hermes home with the three tables the adapter reads, in Hermes's own column names. */
async function hermesHome() {
  const home = await mkdtemp(join(tmpdir(), 'hermes-'));
  const db = new DatabaseSync(join(home, 'state.db'));
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT NOT NULL, title TEXT, display_name TEXT, cwd TEXT,
      parent_session_id TEXT, started_at REAL NOT NULL, last_activity_at REAL, archived INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT,
      tool_calls TEXT, tool_name TEXT, timestamp REAL NOT NULL, active INTEGER NOT NULL DEFAULT 1, display_kind TEXT);
    CREATE TABLE session_turn_leases (conversation_id TEXT PRIMARY KEY, holder TEXT NOT NULL, acquired_at REAL NOT NULL,
      expires_at REAL NOT NULL);
  `);
  const now = Date.now() / 1000;
  const session = db.prepare('INSERT INTO sessions (id, source, title, display_name, cwd, parent_session_id, started_at, last_activity_at, archived, hidden) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  session.run('local-a', 'local', '检查 Tailscale', null, '/Users/me', null, now - 900, now - 60, 0, 0);
  session.run('local-b', 'desktop', null, '写文书', '/Users/me/docs', null, now - 800, now - 30, 0, 0);
  session.run('sub-1', 'subagent', '子任务', null, '/Users/me', 'local-a', now - 700, now - 10, 0, 0);
  session.run('cron-1', 'cron', '定时', null, '/Users/me', null, now - 600, now - 5, 0, 0);
  session.run('local-old', 'local', '归档的', null, '/Users/me', null, now - 500, now - 20, 1, 0);
  db.prepare('INSERT INTO session_turn_leases VALUES (?, ?, ?, ?)').run('local-b', 'desktop', now - 5, now + 300);
  const message = db.prepare('INSERT INTO messages (session_id, role, content, tool_calls, timestamp, active, display_kind) VALUES (?, ?, ?, ?, ?, ?, ?)');
  message.run('local-a', 'user', '看看 tailscale 连上没', null, now - 200, 1, null);
  message.run('local-a', 'assistant', '', JSON.stringify([{ id: 'c1', type: 'function',
    function: { name: 'terminal', arguments: JSON.stringify({ command: 'tailscale status' }) } }]), now - 190, 1, null);
  message.run('local-a', 'tool', '100.64.0.1 mac', null, now - 185, 1, null);
  message.run('local-a', 'assistant', '连上了，两台设备在线。', null, now - 180, 1, null);
  message.run('local-a', 'assistant', '被撤回的', null, now - 170, 0, null);
  db.close();
  return home;
}

async function makeState() {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-state-'));
  return new State(join(dir, 'events.sqlite'));
}

test('hermesTool shows a command, a file change and a search like the other agents', () => {
  assert.deepEqual(hermesTool('terminal', '{"command":"ls -la"}'), { type: 'commandExecution', command: 'ls -la' });
  assert.deepEqual(hermesTool('patch', '{"path":"/a/b.md","old_string":"x"}'), { type: 'fileChange', files: 1, path: '/a/b.md' });
  assert.deepEqual(hermesTool('web_search', '{"query":"acp"}'), { type: 'webSearch', query: 'acp' });
  assert.deepEqual(hermesTool('read_file', '{"path":"/x/AGENTS.md"}'), { type: 'dynamicToolCall', tool: 'read_file', detail: 'AGENTS.md' });
  assert.deepEqual(hermesTool('todo', 'not json'), { type: 'dynamicToolCall', tool: 'todo', detail: '' });
});

test('discover lists the sessions you opened, newest first, and marks one Hermes is running', async () => {
  const state = await makeState();
  const hermes = new HermesAcp(state, { home: await hermesHome() });
  await hermes.discover();
  const listed = [...state.sessions.values()].filter((row) => row.agent === 'hermes').sort((a, b) => b.updatedAt - a.updatedAt);
  assert.deepEqual(listed.map((row) => row.id), ['local-b', 'local-a'], 'no subagent, cron or archived session');
  assert.deepEqual(listed.map((row) => row.name), ['写文书', '检查 Tailscale']);
  assert.deepEqual(listed.map((row) => row.status), ['running', 'idle'], 'a live turn lease means running');
  assert.equal(listed[1].cwd, '/Users/me');
  assert.deepEqual(listed[1].capabilities, ['history', 'send', 'interrupt']);
  assert.equal(state.online.get('hermes'), 'connected');
});

test('without a Hermes database only Hermes is offline', async () => {
  const state = await makeState();
  const home = await mkdtemp(join(tmpdir(), 'hermes-none-'));
  const hermes = new HermesAcp(state, { home });
  await hermes.discover();
  assert.equal(state.online.get('hermes'), 'unconfigured');
  assert.equal([...state.sessions.values()].length, 0);
});

test('history gives your words, the replies and each tool call as an action line', async () => {
  const state = await makeState();
  const hermes = new HermesAcp(state, { home: await hermesHome() });
  await hermes.discover();
  const rows = await hermes.history('local-a', { tools: true });
  assert.deepEqual(rows.map(({ role, text, tool }) => [role, text ?? tool.command]),
    [['user', '看看 tailscale 连上没'], ['tool', 'tailscale status'], ['assistant', '连上了，两台设备在线。']]);
  assert.deepEqual((await hermes.history('local-a')).map((row) => row.role), ['user', 'assistant'], 'without tools');
});

/*
 * A stand-in for `hermes acp`: it answers JSON-RPC on stdin/stdout the way Hermes does. What it does with a prompt
 * depends on the words: "approve" asks for an edit approval, "clarify" asks a question, "slow" waits for "go"
 * on a release file, "die" exits. It logs every request it gets, and every answer to its own requests, to FAKE_LOG.
 */
const fake = String.raw`
const fs = require('node:fs');
const log = (value) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(value) + '\n');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
let next = 1000;
const waiting = new Map();
const ask = (params) => new Promise((resolve) => { const id = next++; waiting.set(id, resolve); send({ jsonrpc: '2.0', id, method: 'session/request_permission', params }); });
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let at;
  while ((at = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (!message.method) { waiting.get(message.id)?.(message.result); waiting.delete(message.id); continue; }
    log({ method: message.method, params: message.params });
    handle(message);
  }
});
async function handle({ id, method, params }) {
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
  if (method === 'session/new') return send({ jsonrpc: '2.0', id, result: { sessionId: 'acp-new-1' } });
  if (method === 'session/load') {
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'old', title: 'terminal', rawInput: { command: 'old replay' } } } });
    return send({ jsonrpc: '2.0', id, result: {} });
  }
  if (method === 'session/cancel') return;
  if (method === 'session/prompt') {
    const text = params.prompt[0].text;
    const sid = params.sessionId;
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'terminal', kind: 'execute', rawInput: { command: 'echo hi' } } } });
    if (text.includes('die')) process.exit(3);
    if (text.includes('approve')) {
      const result = await ask({ sessionId: sid, toolCall: { toolCallId: 'edit-1', title: 'Edit README.md', kind: 'edit', rawInput: { path: '/r/README.md' } },
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'allow_session', kind: 'allow_always', name: 'Allow for session' }, { optionId: 'deny', kind: 'reject_once', name: 'Deny' }] });
      log({ answered: result });
    }
    if (text.includes('clarify')) {
      const result = await ask({ sessionId: sid, toolCall: { toolCallId: 'clarify-7', title: '用哪个分支？', kind: 'other', status: 'pending' },
        options: [{ optionId: 'choice-0', kind: 'allow_once', name: 'main' }, { optionId: 'choice-1', kind: 'allow_once', name: 'dev' }, { optionId: '__skip__', kind: 'reject_once', name: 'Skip' }] });
      log({ answered: result });
    }
    if (text.includes('slow')) while (!fs.existsSync(process.env.FAKE_RELEASE)) await new Promise((r) => setTimeout(r, 10));
    return send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'no ' + method } });
}
`;

async function withFake() {
  const dir = await mkdtemp(join(tmpdir(), 'hermes-fake-'));
  await mkdir(dir, { recursive: true });
  const log = join(dir, 'log.jsonl');
  const release = join(dir, 'release');
  const state = await makeState();
  const hermes = new HermesAcp(state, { home: await hermesHome(), command: process.execPath, args: ['-e', fake],
    env: { ...process.env, FAKE_LOG: log, FAKE_RELEASE: release } });
  await hermes.discover();
  const { readFile, writeFile } = await import('node:fs/promises');
  const seen = async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { state, hermes, seen, release: () => writeFile(release, 'go') };
}

test('saying something loads the old session once, then prompts it', async (t) => {
  const { state, hermes, seen } = await withFake();
  t.after(() => hermes.close());
  await hermes.send('local-a', '再看一次');
  await until(() => state.sessions.get('hermes:local-a').status === 'idle' && hermes.turning.get('local-a') === 'idle', 'the turn to end');
  await hermes.send('local-a', '谢谢');
  await wait(100);
  const methods = (await seen()).map((row) => row.method).filter(Boolean);
  assert.deepEqual(methods, ['initialize', 'session/load', 'session/prompt', 'session/prompt'], 'loaded once');
  const load = (await seen()).find((row) => row.method === 'session/load');
  assert.deepEqual(load.params, { sessionId: 'local-a', cwd: '/Users/me', mcpServers: [] });
  assert.equal(state.requests.size, 0, 'the replayed history raises no card');
});

test('a second message while Hermes works waits for the turn to end', async (t) => {
  const { hermes, seen, release } = await withFake();
  t.after(() => hermes.close());
  await hermes.send('local-a', 'slow 第一句');
  await until(() => hermes.turning.get('local-a') === 'running', 'the first turn');
  await hermes.send('local-a', '第二句');
  await wait(150);
  assert.equal((await seen()).filter((row) => row.method === 'session/prompt').length, 1, 'not sent while running');
  await release();
  await until(() => hermes.turning.get('local-a') === 'idle' && !hermes.queue.get('local-a')?.length, 'both turns');
  const prompts = (await seen()).filter((row) => row.method === 'session/prompt').map((row) => row.params.prompt[0].text);
  assert.deepEqual(prompts, ['slow 第一句', '第二句']);
});

test('a new session starts with session/new and is listed right away', async (t) => {
  const { state, hermes, seen } = await withFake();
  t.after(() => hermes.close());
  const { id } = await hermes.create('帮我整理下载文件夹', { cwd: '/Users/me/Downloads' });
  assert.equal(id, 'acp-new-1');
  assert.equal(state.sessions.get('hermes:acp-new-1').name, '帮我整理下载文件夹');
  await until(() => hermes.turning.get(id) === 'idle', 'the first turn');
  const methods = (await seen()).map((row) => row.method).filter(Boolean);
  assert.deepEqual(methods, ['initialize', 'session/new', 'session/prompt'], 'no load for a session it just made');
  assert.deepEqual((await seen()).find((row) => row.method === 'session/new').params, { cwd: '/Users/me/Downloads', mcpServers: [] });
  await hermes.discover();
  assert.ok(state.sessions.has('hermes:acp-new-1'), 'kept while Hermes has not written it to its database yet');
});

test('an edit approval becomes a card; allowing for the session answers allow_session', async (t) => {
  const { state, hermes, seen } = await withFake();
  t.after(() => hermes.close());
  await hermes.send('local-a', 'approve 改 README');
  await until(() => state.requests.size === 1, 'the card');
  const [card] = state.requests.values();
  assert.equal(card.kind, 'approval');
  assert.equal(card.agent, 'hermes');
  assert.equal(card.sessionAllowed, true, 'Hermes offered allow for session');
  assert.match(card.command, /README\.md/);
  assert.equal(state.sessions.get('hermes:local-a').status, 'approval');
  await state.decide(card.id, { decision: 'acceptForSession' });
  await until(() => hermes.turning.get('local-a') === 'idle', 'the turn');
  const answered = (await seen()).find((row) => row.answered);
  assert.deepEqual(answered.answered, { outcome: { outcome: 'selected', optionId: 'allow_session' } });
});

test('a clarify question becomes a single question with Hermes\'s choices, without a spoken answer', async (t) => {
  const { state, hermes, seen } = await withFake();
  t.after(() => hermes.close());
  await hermes.send('local-a', 'clarify 部署');
  await until(() => state.requests.size === 1, 'the card');
  const [card] = state.requests.values();
  assert.equal(card.kind, 'input');
  assert.equal(card.spoken, false);
  assert.deepEqual(card.questions.map(({ text, options }) => [text, options]), [['用哪个分支？', ['main', 'dev']]]);
  await assert.rejects(state.decide(card.id, { answers: { q1: '随便' } }), /options/);
  await state.decide(card.id, { answers: { q1: 'dev' } });
  await until(() => hermes.turning.get('local-a') === 'idle', 'the turn');
  assert.deepEqual((await seen()).find((row) => row.answered).answered, { outcome: { outcome: 'selected', optionId: 'choice-1' } });
});

test('when hermes acp exits its cards go and the next message starts it again', async (t) => {
  const { state, hermes, seen } = await withFake();
  t.after(() => hermes.close());
  await hermes.send('local-a', 'approve 改 README');
  await until(() => state.requests.size === 1, 'the card');
  hermes.child.kill();
  await until(() => hermes.turning.get('local-a') === 'failed', 'the failed turn');
  assert.equal(state.requests.size, 0, 'the card went with it');
  assert.notEqual(state.sessions.get('hermes:local-a').status, 'approval');
  await hermes.send('local-a', '还在吗');
  await until(() => hermes.turning.get('local-a') === 'idle', 'the next turn');
  const methods = (await seen()).map((row) => row.method).filter(Boolean);
  assert.deepEqual(methods, ['initialize', 'session/load', 'session/prompt', 'initialize', 'session/load', 'session/prompt']);
});

test('interrupt cancels the running turn', async (t) => {
  const { hermes, seen, release } = await withFake();
  t.after(() => hermes.close());
  await hermes.send('local-a', 'slow');
  await until(() => hermes.turning.get('local-a') === 'running', 'the turn');
  assert.deepEqual(await hermes.control('local-a', 'interrupt'), { ok: true });
  await wait(100);
  assert.deepEqual((await seen()).find((row) => row.method === 'session/cancel').params, { sessionId: 'local-a' });
  await release();
  await assert.rejects(hermes.control('local-a', 'fork'), /messages and interrupts/);
});
