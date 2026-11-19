import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { configFromEnv, detectAgents, start, withAgents } from '../server.mjs';
import { paginate, plain } from '../lib/voice.mjs';

const panel = 'panel-test-secret-000000000000000';
const nova = 'nova-test-secret-0000000000000000';
const muse = 'muse-test-secret-0000000000000000';
const grok = 'grok-test-secret-0000000000000000';
const hookToken = 'hook-test-secret-0000000000000000';
const session = 'muse-personal-session';
const initial = {
  session, instance: 'muse-test-instance', name: 'Personal helper', status: 'idle',
  capabilities: ['history', 'send', 'approval'], events: [],
};

async function until(callback) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const value = await callback();
    if (value) return value;
    await delay(80);
  }
  throw new Error('Expected state did not arrive.');
}

function request(app, path, options = {}) {
  const { method = 'GET', token = panel, input, origin, cookie, cursor } = options;
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (input) headers['content-type'] = 'application/json';
  if (origin) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (cursor !== undefined) headers['last-event-id'] = String(cursor);
  return fetch('http://127.0.0.1:' + app.server.address().port + path, {
    method, headers, body: input ? JSON.stringify(input) : undefined,
    signal: AbortSignal.timeout(12000),
  });
}

async function fixture(t, options = {}, deps = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-panel-test-'));
  const config = configFromEnv({
    PANEL_PORT: '0', PANEL_TOKEN: panel, PANEL_NOVA_TOKEN: nova, PANEL_MUSE_BRIDGE_TOKEN: muse,
    PANEL_GROK_BRIDGE_TOKEN: grok, PANEL_CODEX_MODE: 'off', PANEL_DATA_DIR: dir, CLAUDE_CONFIG_DIR: dir,
    // Tests never reach the real keychain or OpenCode: 总管 is off unless a test injects a model.
    PANEL_ZONGGUAN: deps.model || deps.readKey ? 'on' : 'off',
    PANEL_AGENTS: 'codex,claude,muse,grok,dsh',
    ...options,
  });
  const app = await start(config, deps);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  return app;
}

const sync = (app, input = initial, token = muse) =>
  request(app, '/bridge/muse/sync', { method: 'POST', token, input });
const send = (app, text, nonce) =>
  request(app, '/api/sessions/muse/' + session + '/send', { method: 'POST', input: { text, nonce } });

test('gateway serves no web page, authenticates by scope, and requires same-origin writes', async (t) => {
  const app = await fixture(t);
  const document = await request(app, '/', { token: null });
  assert.doesNotMatch(document.headers.get('content-type') ?? '', /text\/html/, 'the web page is gone; the glasses are the interface');
  assert.match(document.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await request(app, '/api/fleet', { token: null })).status, 401);
  assert.equal((await request(app, '/api/fleet', { token: nova })).status, 401);
  assert.equal((await request(app, '/v1/models')).status, 401);
  assert.equal((await request(app, '/v1/models', { token: nova })).status, 200);
  assert.equal((await sync(app, initial, grok)).status, 401);
  const input = { token: panel };
  const rejected = await request(app, '/api/login', { method: 'POST', input, origin: 'https://unrelated.example' });
  assert.equal(rejected.status, 403);
  const login = await request(app, '/api/login', { method: 'POST', input });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly; SameSite=Strict/);
  assert.equal((await request(app, '/api/fleet', { token: null, cookie: cookie.split(';')[0] })).status, 200);
});

test('Claude hooks: only the hook token reports, and a prompt\'s card goes when Claude stops waiting', async (t) => {
  const app = await fixture(t, { PANEL_CLAUDE_HOOK_TOKEN: hookToken });
  const live = '55555555-5555-4555-8555-555555555555';
  const stop = { session_id: live, hook_event_name: 'Stop' };
  assert.equal((await request(app, '/hooks/claude', { method: 'POST', input: stop })).status, 401);
  assert.equal((await request(app, '/hooks/claude', { method: 'POST', input: stop, token: nova })).status, 401);
  const reported = await request(app, '/hooks/claude', { method: 'POST', input: stop, token: hookToken });
  assert.deepEqual([reported.status, await reported.json()], [200, {}]);
  assert.equal((await request(app, '/api/fleet', { token: hookToken })).status, 401, 'the hook token reads nothing');

  const waiting = new AbortController();
  const asked = fetch('http://127.0.0.1:' + app.server.address().port + '/hooks/claude', {
    method: 'POST', signal: waiting.signal,
    headers: { authorization: 'Bearer ' + hookToken, 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: live, hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }),
  }).catch(() => null);
  const card = await until(async () => (await (await request(app, '/api/fleet')).json()).attention.find((item) => item.session === live));
  assert.equal(card.command, 'rm -rf build');
  waiting.abort();
  await asked;
  await until(async () => !(await (await request(app, '/api/fleet')).json()).attention.length);
});

test('browser login survives gateway restart and is invalidated by panel key rotation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-login-test-'));
  const options = { PANEL_PORT: '0', PANEL_TOKEN: panel, PANEL_DATA_DIR: dir,
    PANEL_CODEX_MODE: 'off', CLAUDE_CONFIG_DIR: dir, PANEL_ZONGGUAN: 'off' };
  let app = await start(configFromEnv(options));
  try {
    const login = await request(app, '/api/login', { method: 'POST', input: { token: panel } });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const saved = app.state.db.prepare('SELECT digest FROM panel_login').get();
    assert.match(saved.digest, /^[a-f0-9]{64}$/);
    assert.notEqual(saved.digest, cookie.split('=')[1]);
    await app.close();

    app = await start(configFromEnv(options));
    assert.equal((await request(app, '/api/fleet', { token: null, cookie })).status, 200);
    await app.close();

    app = await start(configFromEnv({ ...options, PANEL_TOKEN: panel + '-rotated' }));
    assert.equal((await request(app, '/api/fleet', { token: null, cookie })).status, 401);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function eventHandshake(response) {
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  try {
    while (!text.includes('"kind":"ready"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel();
  }
  return text.trim().split('\n\n').map((frame) => {
    const fields = Object.fromEntries(frame.split('\n').map((line) => [
      line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2),
    ]));
    return { id: Number(fields.id), ...JSON.parse(fields.data) };
  });
}

test('event reconnect replays missed updates and resets a stale browser cursor', async (t) => {
  const app = await fixture(t);
  const first = await eventHandshake(await request(app, '/api/events'));
  const before = first.at(-1).id;
  app.state.event('activity', 'muse', session);
  app.state.event('attention', 'muse', session);
  const replay = await eventHandshake(await request(app, '/api/events', { cursor: before }));
  assert.deepEqual(replay.map(({ kind }) => kind), ['activity', 'attention', 'ready']);
  assert.deepEqual(replay.map(({ id }) => id), [before + 1, before + 2, before + 2]);

  // Simulate a client whose cursor was taken before the database was replaced.
  const latest = replay.at(-1).id;
  const reset = await eventHandshake(await request(app, '/api/events', { cursor: latest + 100 }));
  assert.deepEqual(reset, [{ kind: 'reset', id: latest, seq: latest }, { kind: 'ready', id: latest, seq: latest }]);

  for (let i = 0; i < 501; i++) app.state.event('activity', 'muse', session);
  const gap = await eventHandshake(await request(app, '/api/events', { cursor: latest }));
  assert.equal(gap.length, 2);
  assert.equal(gap[0].kind, 'reset');
  assert.equal(gap[1].id, latest + 501);
});

test('bridge binds commands to a session and never redelivers an unconfirmed command', async (t) => {
  const app = await fixture(t);
  assert.equal((await sync(app)).status, 200);
  assert.equal((await sync(app, { ...initial, instance: 'duplicate' })).status, 409);
  const nonce = randomUUID();
  const first = await send(app, 'Do a test', nonce);
  assert.equal(first.status, 202);
  assert.deepEqual(await first.json(), { commandId: nonce });
  assert.equal((await send(app, 'Different text', nonce)).status, 409);
  assert.equal((await send(app, 'Do a test', nonce)).status, 202);
  const dispatch = await (await sync(app)).json();
  assert.equal(dispatch.commands[0].text, 'Do a test');
  assert.equal(dispatch.commands[0].session, session);
  assert.deepEqual(await (await sync(app)).json(), { commands: [] });
  await sync(app, { ...initial, events: [{ id: nonce, type: 'ack', ok: true },
    { id: 'reply1', type: 'assistant', text: 'Test complete', commandId: nonce }] });
  const history = await request(app, '/api/sessions/muse/' + session + '/history').then((r) => r.json());
  assert.equal(history.history[0].text, 'Test complete');
  await sync(app, { ...initial, events: [{ id: 'sample-approval', type: 'approval', title: 'Check' }] });
  const { attention } = await request(app, '/api/fleet').then((r) => r.json());
  assert.equal(attention.length, 1);
  const decide = { method: 'POST', input: { decision: 'decline' } };
  assert.equal((await request(app, '/api/attention/' + attention[0].id, decide)).status, 200);
  assert.equal((await request(app, '/api/attention/' + attention[0].id, decide)).status, 409);
  const decision = await (await sync(app)).json();
  assert.equal(decision.commands[0].request, 'sample-approval');
  assert.equal(decision.commands[0].decision, 'decline');
  await sync(app, { ...initial, events: [{ id: 'partial-approval', type: 'approval',
    title: 'Incomplete details', approvalAllowed: false }] });
  const partial = app.state.snapshot().attention.find(({ title }) => title === 'Incomplete details');
  const path = '/api/attention/' + partial.id;
  assert.equal((await request(app, path, { method: 'POST', input: { decision: 'accept' } })).status, 409);
  assert.equal((await request(app, path, decide)).status, 200);
});

const say = (app, content) => request(app, '/v1/chat/completions', {
  method: 'POST', token: nova, input: { stream: true, messages: [{ role: 'user', content }] },
});
const spoken = async (app, content) => {
  const raw = await (await say(app, content)).text();
  const frames = raw.split('\n\n').filter(Boolean);
  const text = frames.filter((frame) => frame.startsWith('data: {')).map((frame) => JSON.parse(frame.slice(6)))
    .map((data) => data.choices?.[0]?.delta?.content ?? '').join('');
  const actions = frames.filter((frame) => frame.startsWith('event: spare.action'))
    .map((frame) => JSON.parse(frame.split('\ndata: ')[1]));
  assert.match(raw, /\[DONE\]/);
  return { text, actions };
};

test('voice drafts for a named agent, sends on the spoken command and reads back the correlated reply', async (t) => {
  const app = await fixture(t);
  await sync(app);
  assert.equal((await request(app, '/api/voice-target', {
    method: 'PUT', input: { agent: 'muse', id: session },
  })).status, 200);
  const draft = await spoken(app, '问Muse连接状态');
  assert.match(draft.text, /草稿给 Muse·Personal helper：连接状态/);
  assert.deepEqual(draft.actions.at(-1), { type: 'keep_listening', seconds: 60 });
  const completion = spoken(app, '发送。');
  const command = await until(async () => (await (await sync(app)).json()).commands?.[0]);
  assert.equal(command.text, '连接状态');
  await sync(app, { ...initial, events: [
    { id: 'unrelated', type: 'assistant', text: 'unrelated reply', commandId: randomUUID() },
    { id: 'matching', type: 'assistant', text: 'voice reply', commandId: command.id },
  ] });
  const voice = await completion;
  assert.match(voice.text, /已发送，回复中。/);
  assert.match(voice.text, /voice reply/);
  assert.doesNotMatch(voice.text, /unrelated reply/);
});

test('voice lists recent sessions a page at a time, locks one by number, keeps a draft and ends by voice', async (t) => {
  const app = await fixture(t);
  for (const [index, name] of ['周末计划', '阿里云服务器运维', '读书笔记', '旅行清单'].entries()) {
    await sync(app, { ...initial, session: 'muse-' + index, name, cwd: '/Users/me/p' + (index % 2), updatedAt: Date.now() - 1000 + index });
  }
  const first = await spoken(app, '最近对话');
  assert.equal(first.actions[0].type, 'show_card');
  assert.deepEqual(first.actions[0].rows, ['1 Muse·旅行清单', '2 Muse·读书笔记', '3 Muse·阿里云服务器运维']);
  assert.match(first.text, /说选择几，或下一页/);
  const second = await spoken(app, '下一页');
  assert.deepEqual(second.actions[0].rows, ['4 Muse·周末计划']);
  assert.match((await spoken(app, '选择二')).text, /这一页是 4，请说其中一个/, 'only numbers on the lens can be picked');
  await spoken(app, '最近对话');
  assert.match((await spoken(app, '选择二')).text, /已选 Muse·读书笔记/);
  assert.deepEqual(app.state.setting('voiceTarget'), { agent: 'muse', id: 'muse-2' });
  const noted = await spoken(app, '把第三章的要点整理一下');
  assert.match(noted.text, /记下了（1 段）/);
  assert.equal(noted.actions[0].title, '草稿');
  assert.match((await spoken(app, '当前对话')).text, /当前：Muse·读书笔记，草稿 1 段/);
  assert.match((await spoken(app, '取消')).text, /已取消/);
  await spoken(app, '再补一句');
  const bye = await spoken(app, '关闭');
  assert.match(bye.text, /草稿没发，已丢掉/);
  assert.deepEqual(bye.actions, [{ type: 'end_conversation' }]);

  const found = await spoken(app, '查找对话阿里云运维');
  assert.equal(found.actions[0].rows[0], '1 Muse·阿里云服务器运维');
  const projects = await spoken(app, '列出项目');
  assert.equal(projects.actions[0].rows.length, 2);
  const inProject = await spoken(app, '选择一');
  assert.ok(inProject.actions[0].rows.every((row) => /旅行清单|读书笔记|周末计划|阿里云/.test(row)));
});

const mcp = async (app, method, params, options = {}) => {
  const response = await request(app, options.path ?? '/mcp', { method: 'POST', token: options.token === undefined ? nova : options.token,
    input: { jsonrpc: '2.0', ...(options.notify ? {} : { id: 1 }), method, params } });
  return options.raw ? response : (await response.json());
};

test('Nova MCP tools list sessions, read replies a lens page at a time, and send only after confirmation', async (t) => {
  const app = await fixture(t);
  await sync(app, { ...initial, cwd: '/Users/me/relay-gateway', updatedAt: Date.now(), events: [
    { id: 'earlier', type: 'assistant', text: '## 结果\n- **测试**全部通过' },
  ] });
  await sync(app, { ...initial, session: 'muse-other', name: '读书笔记', updatedAt: Date.now() - 60000 });

  assert.equal((await mcp(app, 'ping', {}, { token: null, raw: true })).status, 401);
  assert.equal((await mcp(app, 'ping', {}, { token: panel, raw: true })).status, 401, 'the panel key is not the Nova key');
  assert.deepEqual((await mcp(app, 'ping', {}, { token: null, path: '/mcp/' + nova })).result, {}, 'token in the path for URL-only clients');
  assert.equal((await request(app, '/mcp', { token: nova })).status, 405);
  assert.equal((await mcp(app, 'notifications/initialized', {}, { notify: true, raw: true })).status, 202);

  const init = (await mcp(app, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'nova' } })).result;
  assert.equal(init.protocolVersion, '2025-06-18');
  assert.ok(init.capabilities.tools && init.capabilities.prompts);
  assert.match(init.instructions, /confirmed=true/);
  assert.match(init.instructions, /3 行/);
  assert.match(init.instructions, /确认发送。（回复中）/, 'the lens style from the voice desk is the model\'s template');

  const { tools } = (await mcp(app, 'tools/list', {})).result;
  assert.deepEqual(tools.map((tool) => tool.name), ['list_agents', 'read_reply', 'send_to_agent']);
  assert.match(tools[0].description, /用户提到 Codex、Claude、Agent/, 'each tool says when to use it, for hosts that drop the server instructions');
  assert.ok(tools.every((tool) => /^用户/.test(tool.description)));
  assert.ok(tools.every((tool) => !tool._meta), 'no embedded panel: Nova never loads one');

  const { prompts } = (await mcp(app, 'prompts/list', {})).result;
  assert.deepEqual(prompts.map((item) => item.name), ['ask_agent', 'agent_status']);
  const asked = (await mcp(app, 'prompts/get', { name: 'ask_agent', arguments: { request: '跑一下测试', agent: 'Muse' } })).result;
  assert.match(asked.messages[0].content.text, /交给 Muse Agent：跑一下测试/);
  assert.equal((await mcp(app, 'prompts/get', { name: 'ask_agent', arguments: {} })).error.code, -32602);

  const listed = (await mcp(app, 'tools/call', { name: 'list_agents', arguments: {} })).result;
  assert.deepEqual(listed.structuredContent.sessions.map((row) => row.label), ['Muse·Personal helper', 'Muse·读书笔记']);
  assert.match(listed.content[0].text, /^镜片：（最近 2 个）1\.Muse·Personal helper 空闲；2\.Muse·读书笔记 空闲。说选第几个。/);
  assert.match(listed.content[0].text, /1\. Muse·Personal helper（relay-gateway） — 空闲.*agent=muse id=muse-personal-session/);
  const found = (await mcp(app, 'tools/call', { name: 'list_agents', arguments: { query: '读书' } })).result;
  assert.deepEqual(found.structuredContent.sessions.map((row) => row.id), ['muse-other']);

  const read = (await mcp(app, 'tools/call', { name: 'read_reply', arguments: { agent: 'muse', id: session } })).result;
  assert.equal(read.structuredContent.reply, '结果\n测试全部通过');
  assert.match(read.content[0].text, /^镜片：（Muse·Personal helper）结果\n?测试全部通过/);
  assert.equal((await mcp(app, 'tools/call', { name: 'read_reply', arguments: { agent: 'muse', id: 'gone' } })).result.isError, true);

  const args = { agent: 'muse', id: session, text: '把 README 里的启动步骤更新一下，改完跑 npm test。' };
  const preview = (await mcp(app, 'tools/call', { name: 'send_to_agent', arguments: args })).result;
  assert.equal(preview.structuredContent.view, 'draft');
  assert.match(preview.content[0].text, /^镜片：（待确认）发给 Muse·Personal helper：把 README/);
  assert.match(preview.content[0].text, /还没有发送/);
  assert.deepEqual((await (await sync(app)).json()).commands ?? [], [], 'a preview sends nothing');

  const sending = mcp(app, 'tools/call', { name: 'send_to_agent', arguments: { ...args, confirmed: true, wait_seconds: 10 } });
  const command = await until(async () => (await (await sync(app)).json()).commands?.[0]);
  assert.equal(command.text, args.text);
  await sync(app, { ...initial, events: [
    { id: 'other', type: 'assistant', text: 'unrelated reply', commandId: randomUUID() },
    { id: 'answer', type: 'assistant', text: '已更新 README，测试通过。' + '启动步骤改成三步，先装依赖再配置令牌最后启动网关。'.repeat(3), commandId: command.id },
  ] });
  const sent = (await sending).result;
  assert.equal(sent.structuredContent.result, 'replied');
  assert.match(sent.content[0].text, /^镜片：（已回复 1\/\d）已更新 README，测试通过。.* 说下一页。/);
  assert.match(sent.content[0].text, /已发送。Muse·Personal helper 回复：\n已更新 README，测试通过。/);
  const second = (await mcp(app, 'tools/call', { name: 'read_reply', arguments: { agent: 'muse', id: session, page: 2 } })).result;
  assert.equal(second.structuredContent.page, 2);
  assert.match(second.content[0].text, /^镜片：（Muse·Personal helper 2\/\d）/);
  assert.doesNotMatch(sent.content[0].text, /unrelated/);

  await sync(app, { ...initial, status: 'running' });
  const busy = (await mcp(app, 'tools/call', { name: 'send_to_agent', arguments: { ...args, confirmed: true } })).result;
  assert.equal(busy.isError, true);
  assert.match(busy.content[0].text, /运行中，等它做完再发/);
  assert.equal((await mcp(app, 'tools/call', { name: 'nope', arguments: {} })).error.code, -32602);
  assert.equal((await mcp(app, 'nope/method', {})).error.code, -32601);
});

test('spoken replies drop Markdown and fit the lens a page at a time', () => {
  assert.equal(plain('## 结论\n- **先**看 `npm test`\n```js\nx()\n```\n[文档](https://a.b)'), '结论\n先看 npm test\n（代码略）\n文档');
  const pages = paginate('第一句话比较短。' + '这是一段很长很长的说明，'.repeat(8) + '最后一句。');
  assert.ok(pages.length > 2);
  const width = (text) => [...text].reduce((sum, char) => sum + (/[\u2E80-\uFFEF]/u.test(char) ? 1 : 0.5), 0);
  for (const page of pages) assert.ok(width(page) <= 40, page);
  assert.equal(pages.join(''), plain('第一句话比较短。' + '这是一段很长很长的说明，'.repeat(8) + '最后一句。'));
});

test('voice commands and shortcuts are set in the panel and used by voice', async (t) => {
  const app = await fixture(t);
  await sync(app);
  const saved = await request(app, '/api/voice', { method: 'PUT', input: {
    words: { send: ['走你'] }, shortcuts: [{ phrase: '随便聊聊', agent: 'muse', id: session }] } });
  assert.equal(saved.status, 200);
  assert.equal((await request(app, '/api/voice', { method: 'PUT', input: { words: { send: ['x'.repeat(20)] } } })).status, 400);
  const settings = await (await request(app, '/api/voice')).json();
  assert.deepEqual(settings.words.send, ['走你']);
  assert.deepEqual(settings.words.cancel, ['取消', '取消发送', '算了'], 'unset commands keep their defaults');
  assert.match((await spoken(app, '随便聊聊。')).text, /已选 Muse·Personal helper/);
  await spoken(app, '今天的提醒');
  assert.match((await spoken(app, '发送')).text, /记下了（2 段）/, 'the default word no longer sends once replaced');
  const sending = spoken(app, '走你');
  const command = await until(async () => (await (await sync(app)).json()).commands?.[0]);
  assert.equal(command.text, '今天的提醒\n发送');
  await sync(app, { ...initial, events: [{ id: 'r1', type: 'assistant', text: '好的。', commandId: command.id }] });
  assert.match((await sending).text, /好的。/);
});

test('standard Codex App Server sends, streams, denies approval, and retains session history', {
  skip: !process.env.RELAY_TEST_CODEX_BIN,
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'relay-native-test-'));
  const home = join(root, 'codex');
  await mkdir(home);
  const calls = [];
  const mock = createServer(async (req, res) => {
    if (req.url !== '/responses') return res.writeHead(404).end();
    const buffers = [];
    for await (const data of req) buffers.push(data);
    calls.push(JSON.parse(Buffer.concat(buffers)));
    const number = calls.length;
    const response = { id: 'response-' + number };
    const item = { type: 'message', role: 'assistant', id: 'message-' + number };
    const send = (type, data) => res.write('event: ' + type + '\ndata: ' + JSON.stringify({ type, ...data }) + '\n\n');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    send('response.created', { response });
    if (number === 2) {
      send('response.output_item.done', { item: {
        type: 'function_call', name: 'exec_command', call_id: 'deny-me',
        arguments: JSON.stringify({ cmd: 'printf ignored', sandbox_permissions: 'require_escalated', justification: 'Test rejection.' }),
      } });
    } else {
      const text = number === 1 ? 'original answer' : 'native reply';
      send('response.output_item.added', { item: { ...item, content: [] } });
      send('response.output_text.delta', { delta: text, item_id: item.id, content_index: 0 });
      send('response.output_item.done', { item: { ...item, content: [{ type: 'output_text', text }] } });
    }
    send('response.completed', { response: { ...response, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } } });
    res.end();
  });
  mock.listen(0, '127.0.0.1');
  await once(mock, 'listening');
  await writeFile(join(home, 'config.toml'), 'model = "gpt-5.4"\nmodel_provider = "test"\n'
    + '[model_providers.test]\nname = "Isolated mock"\nwire_api = "responses"\n'
    + 'base_url = "http://127.0.0.1:' + mock.address().port + '"\n');
  const wrapper = join(root, 'codex-wrapper');
  await writeFile(wrapper, '#!/bin/sh\nexec env -i PATH="$PATH" HOME="$RELAY_TEST_ROOT" CODEX_HOME="$RELAY_TEST_HOME" "$RELAY_TEST_CODEX_BIN" "$@"\n',
    { mode: 0o700 });
  process.env.RELAY_TEST_ROOT = root;
  process.env.RELAY_TEST_HOME = home;
  const app = await fixture(t, { PANEL_CODEX_MODE: 'stdio', CODEX_BIN: wrapper });
  t.after(async () => {
    mock.closeAllConnections();
    mock.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const codex = app.state.adapters.get('codex');
  await until(() => app.state.online.get('codex') === 'connected');
  const { thread } = await codex.rpc('thread/start', { cwd: root, approvalPolicy: 'on-request', sandbox: 'read-only' });
  const events = [];
  app.state.on('event', (event) => events.push(event));
  const { turn: original } = await codex.rpc('turn/start', {
    threadId: thread.id, input: [{ type: 'text', text: 'original prompt' }],
  });
  await until(() => events.find((event) => event.kind === 'turn' && event.turnId === original.id));
  assert.equal((await request(app, '/api/voice-target', {
    method: 'PUT', input: { agent: 'codex', id: thread.id },
  })).status, 200);
  const completion = request(app, '/v1/chat/completions', {
    method: 'POST', token: nova,
    input: { stream: true, messages: [{ role: 'user', content: 'native follow-up' }] },
  });
  const approval = await until(() => app.state.snapshot().attention[0]);
  assert.match(approval.command, /printf ignored/);
  assert.equal((await request(app, '/api/attention/' + approval.id, {
    method: 'POST', input: { decision: 'decline' },
  })).status, 200);
  const response = await completion;
  assert.equal(response.status, 200);
  assert.match(await response.text(), /native reply/);
  const history = await request(app, '/api/sessions/codex/' + thread.id + '/history').then((r) => r.json());
  assert.deepEqual(history.history.map((item) => item.text),
    ['original prompt', 'original answer', 'native follow-up', 'native reply']);
  assert.match(JSON.stringify(calls[2].input.find((item) => item.call_id === 'deny-me' && item.type === 'function_call_output').output),
    /reject|denied|declined/i);
});

test('Claude Channel connects the gateway to the supplied native session and correlates a reply', async (t) => {
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const token = 'claude-test-secret-00000000000000';
  const app = await fixture(t, { PANEL_CLAUDE_BRIDGE_TOKEN: token });
  const id = randomUUID();
  const child = spawn(process.execPath, [new URL('../claude-channel.mjs', import.meta.url).pathname], {
    env: {
      ...process.env, PANEL_CLAUDE_SESSION: id, PANEL_CLAUDE_BRIDGE_TOKEN: token,
      PANEL_BRIDGE_URL: 'http://127.0.0.1:' + app.server.address().port,
    },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  t.after(() => { child.stdin.end(); child.kill(); });
  const frames = [];
  createInterface({ input: child.stdout }).on('line', (line) => frames.push(JSON.parse(line)));
  const send = (frame) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  const initialize = await until(() => frames.find((frame) => frame.id === 1));
  assert.ok(initialize.result.capabilities.experimental['claude/channel/permission']);
  send({ method: 'notifications/initialized' });
  await until(() => app.state.sessions.get('claude:' + id));
  const response = await request(app, '/api/sessions/claude/' + id + '/send', {
    method: 'POST', input: { text: 'Original Claude thread', nonce: randomUUID() },
  });
  assert.equal(response.status, 202);
  const { commandId } = await response.json();
  const channel = await until(() => frames.find((frame) => frame.method === 'notifications/claude/channel'));
  assert.equal(channel.params.meta.chat_id, commandId);
  assert.equal(channel.params.content, 'Original Claude thread');
  send({ id: 2, method: 'tools/call', params: { name: 'reply', arguments: {
    chat_id: commandId, text: 'Matched Claude reply',
  } } });
  await until(() => app.state.adapters.get('claude').history(id).find((row) => row.commandId === commandId));
  send({ method: 'notifications/claude/channel/permission_request', params: {
    request_id: 'abcde', tool_name: 'Bash', input_preview: 'echo sample',
  } });
  const approval = await until(() => app.state.snapshot().attention[0]);
  assert.equal(approval.agent, 'claude');
  assert.equal((await request(app, '/api/attention/' + approval.id, {
    method: 'POST', input: { decision: 'decline' },
  })).status, 200);
  const decision = await until(() => frames.find((frame) => frame.method === 'notifications/claude/channel/permission'));
  assert.deepEqual(decision.params, { request_id: 'abcde', behavior: 'deny' });
});

/* ---------- 总管 ---------- */

test('总管 answers through the panel API with an injected model', async (t) => {
  const asked = [];
  const model = { complete: async (request) => { asked.push(request); return { message: { role: 'assistant', content: '都在空闲。' }, promptTokens: 50 }; } };
  const app = await fixture(t, {}, { model });
  const sent = await request(app, '/api/zongguan/say', { method: 'POST', input: { text: '现在都在干嘛' } });
  assert.equal(sent.status, 202);
  assert.deepEqual(await sent.json(), { st: 'sent', h: '总管收到' });
  const view = await until(async () => {
    const body = await (await request(app, '/api/zongguan')).json();
    return body.blocks.at(-1)?.kind === 'reply' ? body : null;
  });
  assert.equal(view.blocks.at(-1).text, '都在空闲。');
  assert.equal(view.status, 'idle');
  assert.equal(asked.length, 1);
  assert.ok(app.zongguan, 'the app exposes 总管');
});

test('总管 is off without a key and the panel says so', async (t) => {
  const app = await fixture(t, {}, { readKey: async () => null });
  const view = await (await request(app, '/api/zongguan')).json();
  assert.equal(view.status, 'off');
  assert.equal(view.offText, '总管没配好：钥匙串里没有 relay-opencode');
  const sent = await request(app, '/api/zongguan/say', { method: 'POST', input: { text: '在吗' } });
  assert.deepEqual(await sent.json(), { st: 'off', h: '总管没配好：钥匙串里没有 relay-opencode' });
});

test('detectAgents finds each agent\'s command and marks the ones this version supports', async (t) => {
  const bin = await mkdtemp(join(tmpdir(), 'relay-detect-bin-'));
  const home = await mkdtemp(join(tmpdir(), 'relay-detect-home-'));
  t.after(() => Promise.all([rm(bin, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  for (const name of ['codex', 'dsh', 'hermes']) {
    await writeFile(join(bin, name), '#!/bin/sh\n');
    await chmod(join(bin, name), 0o755);
  }
  const found = Object.fromEntries(detectAgents({ PATH: bin, HOME: home }).map((row) => [row.key, row]));
  assert.deepEqual(Object.keys(found), ['codex', 'claude', 'muse', 'grok', 'dsh', 'hermes', 'antigravity']);
  assert.equal(found.codex.path, join(bin, 'codex'));
  assert.equal(found.dsh.path, join(bin, 'dsh'));
  assert.deepEqual([found.hermes.path, found.hermes.supported], [join(bin, 'hermes'), true], 'Hermes is found and can be enabled');
  assert.equal(found.antigravity.supported, false, 'Antigravity comes in the next version');
  assert.equal(found.claude.path, null, 'no claude command and no ~/.claude');
  assert.equal(found.antigravity.path, null);
  assert.equal(found.codex.name, 'Codex');
});

test('PANEL_AGENTS decides which agents run, in its order; unset runs none', () => {
  const base = { PANEL_PORT: '0', PANEL_TOKEN: panel, PANEL_CODEX_MODE: 'off' };
  assert.deepEqual(configFromEnv(base).agents, [], 'relay setup was never run');
  assert.deepEqual(configFromEnv({ ...base, PANEL_AGENTS: ' dsh, codex,hermes,antigravity,bogus,codex ' }).agents, ['dsh', 'codex', 'hermes']);
  assert.equal(configFromEnv({ ...base, HERMES_HOME: '/h' }).hermes.home, '/h');
  assert.equal(configFromEnv({ ...base, HOME: '/u' }).hermes.home, '/u/.hermes');
  assert.deepEqual(configFromEnv({ ...base, PANEL_AGENTS: '' }).agents, []);
});

test('withAgents replaces or appends only the PANEL_AGENTS line', () => {
  const env = 'PANEL_PORT=4488\nPANEL_TOKEN=abc_DEF-123\nPANEL_AGENTS=codex\n# note\n';
  assert.equal(withAgents(env, ['claude', 'dsh']), 'PANEL_PORT=4488\nPANEL_TOKEN=abc_DEF-123\nPANEL_AGENTS=claude,dsh\n# note\n');
  assert.equal(withAgents('PANEL_PORT=4488\nPANEL_TOKEN=x', ['codex']), 'PANEL_PORT=4488\nPANEL_TOKEN=x\nPANEL_AGENTS=codex\n');
  assert.equal(withAgents('PANEL_PORT=4488\n', []), 'PANEL_PORT=4488\nPANEL_AGENTS=\n');
  assert.equal(withAgents('', ['grok']), 'PANEL_AGENTS=grok\n');
});

test('a disabled agent gets no adapter and its hooks are refused', async (t) => {
  const app = await fixture(t, { PANEL_AGENTS: 'codex', PANEL_CLAUDE_HOOK_TOKEN: hookToken, PANEL_DSH_TOKEN: 'dsh-test-secret-00000000000000000' });
  assert.deepEqual([...app.state.adapters.keys()], ['codex']);
  const claude = await fetch('http://127.0.0.1:' + app.server.address().port + '/hooks/claude', { method: 'POST',
    headers: { authorization: 'Bearer ' + hookToken, 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: randomUUID(), prompt: 'hi', cwd: '/tmp' }) });
  assert.equal(claude.status, 404, 'Claude Code is not enabled');
  const dsh = await fetch('http://127.0.0.1:' + app.server.address().port + '/hooks/dsh', { method: 'POST',
    headers: { authorization: 'Bearer dsh-test-secret-00000000000000000', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(dsh.status, 404, 'DeepSeek is not enabled');
  assert.equal(app.state.sessions.size, 0);
});

test('enabling Hermes gives it an adapter that reads its own home and lists its sessions', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'relay-hermes-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const app = await fixture(t, { PANEL_AGENTS: 'hermes', HERMES_HOME: home });
  assert.deepEqual([...app.state.adapters.keys()], ['hermes']);
  assert.equal(app.state.adapters.get('hermes').home, home);
});

test('PANEL_ZONGGUAN_COMPACT_AT rejects junk', () => {
  const base = { PANEL_PORT: '0', PANEL_TOKEN: panel, PANEL_CODEX_MODE: 'off' };
  assert.throws(() => configFromEnv({ ...base, PANEL_ZONGGUAN_COMPACT_AT: 'abc' }), /PANEL_ZONGGUAN_COMPACT_AT/);
  assert.throws(() => configFromEnv({ ...base, PANEL_ZONGGUAN_COMPACT_AT: '500' }), /PANEL_ZONGGUAN_COMPACT_AT/);
  const config = configFromEnv(base);
  assert.deepEqual(config.zongguan, { enabled: true, model: 'deepseek-v4.1-flash', effort: 'high', compactAt: 300000 });
});

test('总管 calls OpenCode as itself, with one session id and high thinking', async (t) => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '在。' } }], usage: { prompt_tokens: 10 } }));
  };
  const app = await fixture(t, {}, { readKey: async () => 'k-test', fetch });
  for (const text of ['在吗', '还在吗']) {
    await request(app, '/api/zongguan/say', { method: 'POST', input: { text } });
    await until(() => seen.length >= (text === '在吗' ? 1 : 2));
  }
  assert.equal(seen[0].body.model, 'deepseek-v4.1-flash');
  assert.equal(seen[0].body.reasoning_effort, 'high');
  assert.match(seen[0].headers['user-agent'], /^relay-zongguan\//);
  assert.match(seen[0].headers['x-opencode-session'], /^ses_/);
  assert.equal(seen[1].headers['x-opencode-session'], seen[0].headers['x-opencode-session']);
});
