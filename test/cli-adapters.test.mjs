import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, State } from '../lib/state.mjs';
import { MuseCli } from '../lib/muse-cli.mjs';
import { GbotCli, approvalCard } from '../lib/gbot.mjs';
import { ClaudeCli } from '../lib/claude-cli.mjs';
import { ClaudeObserver, claudeTool } from '../lib/claude-observer.mjs';
import { Fallback } from '../server.mjs';
import { Bridge } from '../lib/bridge.mjs';
import { DshWeb, dshTool } from '../lib/dsh.mjs';
import { compact as dshCompact } from '../dsh/relay.mjs';

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'relay-cli-test-'));
  const state = new State(join(dir, 'events.sqlite'));
  t.after(async () => {
    state.db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, state };
}

const replies = (state) => {
  const seen = [];
  state.on('event', (event) => { if (event.kind === 'reply') seen.push(event); });
  return seen;
};

/* ---------- Muse ---------- */

test('Muse: chats become sessions, a reply lands in its chat, and a new side chat starts', async (t) => {
  const { state } = await scratch(t);
  const calls = [];
  const chats = { main: [{ seq: 1, role: 'user', message_id: 'm1', text: '早' }, { seq: 2, role: 'assistant', message_id: 'm2', text: '早上好' }] };
  const run = async (binary, args) => {
    calls.push(args);
    if (args[0] === 'raw') return { ok: true, result: { sessions: [
      { session_id: 'main', title: '', is_primary: true, archived: false, can_send_messages: true, status: 'completed', updated_at_ms: 10, snippet: '早上好' },
      { session_id: 'side', title: '买菜', is_primary: false, archived: false, can_send_messages: true, status: 'completed', updated_at_ms: 5 },
      { session_id: 'old', title: '旧的', archived: true, updated_at_ms: 1 },
    ] } };
    if (args[0] === 'history') return chats[args[2]] ?? [];
    if (args[0] === 'send') {
      assert.deepEqual(args.slice(0, 6), ['send', '--thread', args[2], '--wait', '150', '--']);
      chats[args[2]] = [...(chats[args[2]] ?? []), { seq: 3, role: 'user', message_id: 'm3', text: args[6] }];
      return { sent: true };
    }
    if (args[0] === 'session-start') return { session_id: 'fresh' };
    throw new Error('unexpected ' + args.join(' '));
  };
  const muse = new MuseCli(state, { binary: 'muse-cli', run });
  await muse.discover();
  assert.equal(state.online.get('muse'), 'connected');
  assert.equal(state.get('muse', 'main').name, '主对话');
  assert.deepEqual(state.get('muse', 'side').capabilities, ['history', 'send']);
  assert.throws(() => state.get('muse', 'old'));
  assert.deepEqual((await muse.history('main')).map((row) => row.role), ['user', 'assistant']);

  const seen = replies(state);
  await muse.send('main', '-1 也行', 'c1');
  assert.equal(state.get('muse', 'main').status, 'running');
  chats.main.push({ seq: 4, role: 'assistant', message_id: 'm4', text: '好的' });
  await muse.discover();
  assert.equal(seen.at(-1).commandId, 'c1');
  assert.equal(seen.at(-1).text, '好的');
  assert.equal(state.get('muse', 'main').status, 'idle');

  const created = await muse.create('帮我订周五的餐厅');
  assert.equal(created.id, 'fresh');
  assert.equal(state.get('muse', 'fresh').status, 'running');
  assert.ok(calls.some((args) => args[0] === 'send' && args[2] === 'fresh'));
});

test('Muse: a failing command line marks Muse offline and read-only', async (t) => {
  const { state } = await scratch(t);
  let fail = false;
  const muse = new MuseCli(state, { run: async (binary, args) => {
    if (fail) throw new Error('exit 1');
    return { result: { sessions: [{ session_id: 'main', title: 'M', can_send_messages: true, status: 'completed', updated_at_ms: 1 }] } };
  } });
  await muse.discover();
  fail = true;
  muse.listedAt = 0;
  await muse.discover();
  assert.equal(muse.healthy, false);
  assert.equal(state.online.get('muse'), 'offline');
  assert.deepEqual(state.get('muse', 'main').capabilities, ['history']);
});

/* ---------- Grok ---------- */

const card = (status, extra = {}) => ({ kind: 'send-message', id: 'e9', seq: 9, timestampMs: 900,
  message: { type: 'local-tool-permission', ask: { status, requestId: 'r9', command: 'ls ~/Downloads', reason: '看下载目录', workingDirectory: '/Users/me', ...extra } } });

test('Grok: an approval card becomes a request answered with "accept once"', async (t) => {
  const { state } = await scratch(t);
  const calls = [];
  let entries = [
    { kind: 'message', role: 'user', id: 'e1', seq: 1, content: '查一下', timestampMs: 100 },
    { kind: 'send-message', id: 'e2', seq: 2, timestampMs: 200, message: { type: 'text', content: '好的，我先看看' } },
    card('pending'),
  ];
  const run = async (binary, args) => {
    calls.push(args);
    if (args[0] === 'doctor') return { grokBotAppSession: { present: true, usable: true } };
    if (args[0] === 'bots') return [{ id: 'b1', name: 'Scout', kind: 'bot' }];
    if (args[0] === 'groups') return [{ id: 'g1', name: '家里', kind: 'group', hiddenFromSidebar: false }];
    if (args[0] === 'thread') return { transcript: { entries: args[1] === 'b1' ? entries : [] } };
    if (args[0] === 'approvals') {
      entries = [...entries.slice(0, 2), card('approved')];
      return { delivery: 'accepted' };
    }
    throw new Error('unexpected ' + args.join(' '));
  };
  const grok = new GbotCli(state, { run });
  await grok.discover();
  assert.equal(state.get('grok', 'b1').status, 'approval');
  assert.equal(state.get('grok', 'g1').group, true);
  const [request] = [...state.requests.values()];
  assert.equal(request.command, 'ls ~/Downloads');
  assert.equal(request.cwd, '/Users/me');
  assert.equal(request.approvalAllowed, true);

  const history = await grok.history('b1');
  assert.deepEqual(history.map((row) => row.role), ['user', 'assistant', 'tool']);
  assert.equal(history[2].tool.text, '要批准 ls ~/Downloads');

  await state.decide(request.id, { decision: 'accept' });
  const respond = calls.find((args) => args[0] === 'approvals');
  assert.deepEqual(respond, ['approvals', 'respond', '--target', 'b1', '--entry-id', 'e9', '--request-id', 'r9',
    '--decision', 'accept', '--json']);
  assert.equal(state.requests.size, 0);
  await grok.discover();
  assert.equal(state.get('grok', 'b1').status, 'idle');
  assert.equal(state.requests.size, 0);
});

test('Grok: a truncated card can only be declined, and a sent message waits for the bot', async (t) => {
  const { state } = await scratch(t);
  assert.equal(approvalCard(card('pending', { command: 'x'.repeat(3000) })).truncated, true);
  let entries = [card('pending', { command: 'x'.repeat(3000) })];
  const sent = [];
  const grok = new GbotCli(state, { run: async (binary, args) => {
    if (args[0] === 'doctor') return { grokBotAppSession: { present: true, usable: true } };
    if (args[0] === 'bots') return [{ id: 'b1', name: 'Scout' }];
    if (args[0] === 'groups') return [];
    if (args[0] === 'thread') return { transcript: { entries } };
    if (args[0] === 'send') {
      sent.push(args);
      return { delivery: 'accepted' };
    }
    throw new Error('unexpected');
  } });
  await grok.discover();
  const [request] = [...state.requests.values()];
  assert.equal(request.approvalAllowed, false);
  await assert.rejects(state.decide(request.id, { decision: 'accept' }), /Approve this one in Grok Bot/);

  entries = [];
  const seen = replies(state);
  await grok.send('b1', '-v 是什么意思', 'c7');
  assert.deepEqual(sent[0], ['send', 'b1', ' -v 是什么意思', '--json']);
  entries = [{ kind: 'send-message', id: 'e10', seq: 10, timestampMs: 1000, message: { type: 'text', content: '是详细输出' } }];
  grok.polledAt = 0;
  await grok.discover();
  assert.equal(seen.at(-1)?.commandId, 'c7');
  assert.equal(seen.at(-1)?.text, '是详细输出');
});

/* ---------- Claude ---------- */

function fakeClaude(script) {
  const runs = [];
  const spawn = (binary, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => { child.stdout.end(); };
    const run = { args, options, input: [], child };
    runs.push(run);
    const emit = (message) => child.stdout.write(JSON.stringify(message) + '\n');
    createInterface({ input: child.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      run.input.push(message);
      script(message, emit, run);
    });
    child.stdin.on('finish', () => child.stdout.end());
    child.stdout.on('end', () => setImmediate(() => child.emit('close', 0)));
    return child;
  };
  return { spawn, runs };
}

test('Claude: a closed session continues with an approval answered from the panel', async (t) => {
  const { dir, state } = await scratch(t);
  const { spawn, runs } = fakeClaude((message, emit, run) => {
    if (message.type === 'user') {
      emit({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5' });
      emit({ type: 'control_request', request_id: 'p1', request: { subtype: 'can_use_tool', tool_name: 'Bash',
        input: { command: 'npm test' }, description: 'Run the tests' } });
    }
    if (message.type === 'control_response' && message.response.request_id === 'p1') {
      run.decision = message.response.response;
      emit({ type: 'assistant', message: { content: [{ type: 'text', text: '测试都过了' }] } });
      emit({ type: 'result', subtype: 'success', is_error: false, result: '测试都过了' });
    }
  });
  state.put('claude', 's1', { cwd: dir, capabilities: ['history', 'send'], status: 'idle' });
  const claude = new ClaudeCli(state, { binary: 'claude', configDir: dir, spawn,
    bridge: { leases: new Map() }, observer: { isLive: () => false } });
  const seen = replies(state);
  await claude.send('s1', '跑一下测试', 'c1');
  assert.deepEqual(runs[0].args.slice(0, 3), ['-p', '--resume', 's1']);
  assert.ok(runs[0].args.includes('--permission-prompt-tool'));
  assert.equal(runs[0].options.cwd, dir);
  assert.equal(runs[0].options.env.CLAUDE_CONFIG_DIR, dir);
  await delay(20);
  assert.equal(state.get('claude', 's1').status, 'approval');
  assert.equal(state.get('claude', 's1').model, 'claude-opus-5-5');
  const [request] = [...state.requests.values()];
  assert.equal(request.title, 'Run a command');
  assert.equal(request.command, 'npm test');
  await state.decide(request.id, { decision: 'accept' });
  await delay(20);
  assert.deepEqual(runs[0].decision, { behavior: 'allow', updatedInput: { command: 'npm test' } });
  assert.equal(seen.at(-1).commandId, 'c1');
  assert.equal(seen.at(-1).text, '测试都过了');
  assert.equal(state.get('claude', 's1').status, 'idle');
  assert.equal(claude.active.size, 0);
});

test('Claude: open sessions are refused, a decline is passed on, and a new session reports its id', async (t) => {
  const { dir, state } = await scratch(t);
  const { spawn, runs } = fakeClaude((message, emit, run) => {
    if (message.type === 'user') {
      emit({ type: 'system', subtype: 'init', session_id: 'new1', model: 'claude-sonnet-5-5' });
      emit({ type: 'control_request', request_id: 'p2', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: dir + '/a.txt' } } });
      emit({ type: 'control_request', request_id: 'q1', request: { subtype: 'elicitation' } });
    }
    if (message.type === 'control_response' && message.response.request_id === 'q1') run.elicitation = message.response.subtype;
    if (message.type === 'control_response' && message.response.request_id === 'p2') {
      run.decision = message.response.response;
      emit({ type: 'result', subtype: 'success', is_error: false, result: '好，不写了' });
    }
  });
  state.put('claude', 'live1', { cwd: dir, capabilities: ['history'], status: 'running', updatedAt: 5 });
  // An open session without an inbox: the observer refuses, and nothing is started beside the open window.
  const observer = { isLive: (id) => id === 'live1', sendPeer: async () => { throw new ApiError(409, 'This session is open on the computer. Reply there.'); } };
  const claude = new ClaudeCli(state, { spawn, bridge: { leases: new Map() }, observer });
  await assert.rejects(claude.send('live1', 'hi'), /open on the computer/);
  assert.equal(runs.length, 0);

  const created = await claude.create('写个文件\n第二行');
  assert.equal(created.id, 'new1');
  assert.equal('CLAUDE_CONFIG_DIR' in runs[0].options.env, false, 'the default login is used unless a folder was configured');
  assert.ok(!runs[0].args.includes('--resume'));
  assert.equal(state.get('claude', 'new1').name, '写个文件');
  await delay(20);
  assert.equal(runs[0].elicitation, 'error');
  const [request] = [...state.requests.values()];
  assert.equal(request.title, 'Modify files');
  await state.decide(request.id, { decision: 'decline' });
  await delay(20);
  assert.equal(runs[0].decision.behavior, 'deny');
  assert.equal(state.get('claude', 'new1').status, 'idle');
});

test('Claude observer: running sessions stay read-only, closed ones can be continued, tools and model are read', async (t) => {
  const { dir, state } = await scratch(t);
  const project = join(dir, 'projects', '-work');
  await mkdir(join(dir, 'sessions'), { recursive: true });
  await mkdir(project, { recursive: true });
  const live = '11111111-1111-4111-8111-111111111111';
  const closed = '22222222-2222-4222-8222-222222222222';
  await writeFile(join(dir, 'sessions', process.pid + '.json'), JSON.stringify({ pid: process.pid, sessionId: live, cwd: dir, status: 'busy', name: '开着的' }));
  const rows = [
    { type: 'user', uuid: 'u1', cwd: dir, timestamp: '2026-11-10T01:00:00Z', message: { content: '修一下登录' } },
    { type: 'assistant', uuid: 'a1', cwd: dir, effort: 'high', timestamp: '2026-11-10T01:00:05Z', message: { model: 'claude-opus-5-5', content: [
      { type: 'text', text: '先跑测试' }, { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } }, { type: 'tool_use', name: 'mcp__github__get_pr', input: {} }] } },
    { type: 'custom-title', customTitle: '登录修复' },
  ];
  await writeFile(join(project, closed + '.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  await writeFile(join(project, live + '.jsonl'), JSON.stringify(rows[0]) + '\n');
  const bridge = { leases: new Map(), history: () => [] };
  const observer = new ClaudeObserver(state, dir, bridge, { active: new Map() });
  await observer.discover();
  assert.deepEqual(state.get('claude', live).capabilities, ['history']);
  assert.equal(observer.isLive(live), true);
  const row = state.get('claude', closed);
  assert.equal(row.name, '登录修复');
  assert.deepEqual(row.capabilities, ['history', 'send']);
  assert.equal(row.model, 'claude-opus-5-5');
  const history = await observer.history(closed, { tools: true });
  assert.deepEqual(history.map((item) => item.role), ['user', 'tool', 'tool', 'assistant']);
  assert.deepEqual([history[1].tool.type, history[1].tool.command], ['commandExecution', 'npm test']);
  assert.deepEqual([history[2].tool.type, history[2].tool.server, history[2].tool.tool], ['mcpToolCall', 'github', 'get_pr']);
  assert.deepEqual((await observer.history(closed)).map((item) => item.role), ['user', 'assistant']);
  assert.deepEqual(claudeTool({ name: 'Edit', input: { file_path: '/a/b.ts' } }), { type: 'fileChange', files: 1, path: '/a/b.ts' });

  // Without the command line, closed sessions are listed for reading only.
  const { state: plain } = await scratch(t);
  await new ClaudeObserver(plain, dir, bridge, null).discover();
  assert.deepEqual(plain.get('claude', closed).capabilities, ['history']);
});

test('Claude observer: hooks report each turn, and a permission prompt waits for the glasses or Claude\'s window', async (t) => {
  const { dir, state } = await scratch(t);
  await mkdir(join(dir, 'sessions'), { recursive: true });
  const live = '33333333-3333-4333-8333-333333333333';
  const relayRun = '44444444-4444-4444-8444-444444444444';
  const registry = (status, at) => writeFile(join(dir, 'sessions', process.pid + '.json'),
    JSON.stringify({ pid: process.pid, sessionId: live, cwd: dir, status, statusUpdatedAt: at, name: '在跑的' }));
  await registry('busy', Date.now() - 60000);
  const observer = new ClaudeObserver(state, dir, { leases: new Map() }, { active: new Map([[relayRun, {}]]) });
  await observer.discover();
  const hook = (event, extra = {}, closed) => observer.hook({ session_id: live, hook_event_name: event, cwd: dir, ...extra }, closed);
  const status = () => state.get('claude', live).status;
  assert.equal(status(), 'running', 'the registry says busy');

  assert.deepEqual(await hook('Stop'), {});
  assert.equal(status(), 'idle', 'the Stop hook ends the turn before the registry notices');
  await observer.discover();
  assert.equal(status(), 'idle', 'an older registry entry does not undo it');
  await hook('UserPromptSubmit');
  assert.equal(status(), 'running');

  const bash = { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the tests' } };
  const approved = hook('PermissionRequest', bash);
  const [card] = state.requests.values();
  assert.deepEqual([card.session, card.title, card.command, card.description], [live, 'Run a command', 'npm test', 'Run the tests']);
  assert.equal(status(), 'approval');
  await state.decide(card.id, { decision: 'accept' });
  assert.deepEqual(await approved, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
  assert.equal(state.requests.size, 0);
  assert.equal(status(), 'running');

  const declined = hook('PermissionRequest', bash);
  await state.decide([...state.requests.keys()][0], { decision: 'decline' });
  assert.equal((await declined).hookSpecificOutput.decision.behavior, 'deny');

  // Answered in Claude's window: Claude Code stops waiting for the hook, and the card goes.
  let close;
  const answeredThere = hook('PermissionRequest', bash, new Promise((resolve) => { close = resolve; }));
  const [late] = state.requests.keys();
  close();
  assert.deepEqual(await answeredThere, {});
  assert.equal(state.requests.size, 0);
  await assert.rejects(state.decide(late, { decision: 'accept' }), /no longer available/);

  // The tool ran, so it was answered somewhere: the card for that call goes, another call's card stays.
  const other = hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm run lint' } });
  const ran = hook('PermissionRequest', bash);
  await hook('PostToolUse', bash);
  assert.deepEqual(await ran, {});
  assert.deepEqual([...state.requests.values()].map((item) => item.command), ['npm run lint']);
  await hook('Stop');
  assert.deepEqual(await other, {}, 'a finished turn leaves nothing waiting');
  assert.equal(status(), 'idle');

  await hook('UserPromptSubmit');
  await hook('StopFailure');
  assert.equal(status(), 'failed');
  await registry('idle', Date.now() + 5000);
  await observer.discover();
  assert.equal(status(), 'idle', 'a clearly later registry change wins');

  // A question: answered with a label (or your own words), keyed by Claude's question text.
  const questions = [{ question: 'Which database?', header: 'Database', multiSelect: false,
    options: [{ label: 'Postgres', description: 'relational' }, { label: 'SQLite', description: 'a file' }] },
  { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'Lint' }, { label: 'Tests' }] }];
  const answered = hook('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions } });
  const [asked] = state.requests.values();
  assert.deepEqual([asked.kind, asked.title, asked.questions.map((item) => [item.id, item.title, item.text, item.options, item.multiple])],
    ['input', 'Claude needs an answer', [['q1', 'Database', 'Which database?', ['Postgres', 'SQLite'], false],
      ['q2', 'Checks', 'Which checks?', ['Lint', 'Tests'], true]]]);
  assert.equal(status(), 'approval');
  await assert.rejects(state.decide(asked.id, { answers: { q1: 'SQLite' } }), /Answer each question/);
  await state.decide(asked.id, { answers: { q1: 'SQLite', q2: ['Lint', 'Tests'] } });
  assert.deepEqual((await answered).hookSpecificOutput.decision,
    { behavior: 'allow', updatedInput: { questions, answers: { 'Which database?': 'SQLite', 'Which checks?': 'Lint, Tests' } } });
  // Answered in Claude's window: Claude keeps the hook waiting, but the tool runs with the answers added.
  const answeredThereToo = hook('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions } });
  await hook('PostToolUse', { tool_name: 'AskUserQuestion', tool_input: { questions, answers: { 'Which database?': 'Postgres' } } });
  assert.deepEqual(await answeredThereToo, {});
  assert.equal(state.requests.size, 0);
  assert.deepEqual(await hook('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: {} }), {}, 'nothing to ask');
  assert.deepEqual(await hook('PermissionRequest', { tool_name: 'ExitPlanMode', tool_input: { plan: 'x' } }), {}, 'plans stay in Claude');
  assert.deepEqual(await observer.hook({ session_id: relayRun, hook_event_name: 'PermissionRequest', ...bash }), {},
    'a session Relay runs already asks through its own connection');
  assert.equal(state.requests.size, 0);
  await assert.rejects(observer.hook({ session_id: 'nope', hook_event_name: 'Stop' }), /Invalid Claude session/);
});

test('Claude observer: a session open on the computer takes a message through its own inbox, after the current turn', async (t) => {
  // Unix socket paths are short on macOS, so the session folder lives under /tmp.
  const dir = await mkdtemp('/tmp/rcp-');
  const { state } = await scratch(t);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'sessions'), { recursive: true });
  const live = '33333333-3333-4333-8333-333333333333';
  const sock = join(dir, 'in.sock');
  const received = [];
  const server = createServer((socket) => {
    let text = '';
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('end', () => received.push(...text.trim().split('\n').map((line) => JSON.parse(line))));
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  t.after(() => server.close());
  await writeFile(join(dir, 'sessions', process.pid + '.json'), JSON.stringify({
    pid: process.pid, sessionId: live, cwd: dir, status: 'busy', name: '开着的', messagingSocketPath: sock, peerProtocol: 1,
  }));
  const bridge = { leases: new Map(), history: () => [] };
  const observer = new ClaudeObserver(state, dir, bridge, { active: new Map() });
  await observer.discover();
  assert.deepEqual(state.get('claude', live).capabilities, ['history', 'send']);
  await assert.rejects(observer.sendPeer(live, '你好'), (error) => error instanceof ApiError && error.status === 409,
    'without its key file the session does not take messages');

  const token = '0123456789abcdef0123456789abcdef';
  await writeFile(join(dir, 'sessions', process.pid + '.' + 'a'.repeat(64) + '.key'), JSON.stringify({ peerToken: token }));
  assert.deepEqual(await observer.sendPeer(live, '顺便更新 README', 'cmd-1'), { commandId: 'cmd-1' });
  await delay(50);
  assert.deepEqual(received[0], { type: 'auth', token });
  assert.equal(received[1].type, 'user');
  assert.deepEqual(received[1].message, { role: 'user', content: '顺便更新 README' });
  assert.equal(received[1].priority, 'next', 'it waits for the current turn');

  // Without the command line configured the same session stays read-only.
  const { state: plain } = await scratch(t);
  await new ClaudeObserver(plain, dir, bridge, null).discover();
  assert.deepEqual(plain.get('claude', live).capabilities, ['history']);
});

/* ---------- fallback ---------- */

test('fallback: the desktop helper runs only while the command line fails, and keeps its own session', async () => {
  const log = [];
  const primary = { agent: 'muse', healthy: true, discover: async () => log.push('cli'),
    history: async () => 'cli', send: async () => 'cli', create: async () => ({ id: 'new' }) };
  const helper = { id: 'muse-main', discover: async () => log.push('helper'), history: async () => 'helper', send: async () => 'helper' };
  const adapter = new Fallback(primary, helper);
  await adapter.discover();
  assert.deepEqual(log, ['cli']);
  primary.healthy = false;
  await adapter.discover();
  assert.deepEqual(log, ['cli', 'cli', 'helper']);
  assert.equal(await adapter.history('muse-main'), 'helper');
  assert.equal(await adapter.send('abc', 'hi'), 'cli');
  assert.throws(() => adapter.create('hi'), /not answering/);
  assert.equal(typeof new Fallback({ agent: 'grok', discover: async () => {} }, null).create, 'undefined');
});

test('fallback: an idle bridge does not mark a command-line agent offline', async (t) => {
  const { state } = await scratch(t);
  const bridge = new Bridge(state, 'grok');
  state.connection('grok', 'connected');
  bridge.expire();
  assert.equal(state.online.get('grok'), 'connected');
  bridge.leases.set('s', { instance: 'i', sent: new Set(), until: Date.now() - 1 });
  state.put('grok', 's', { capabilities: ['history', 'send'] });
  bridge.expire();
  assert.equal(state.online.get('grok'), 'offline');
});

test('Muse: the reply comes straight from the waiting send, and a refused send is reported', async (t) => {
  const { state } = await scratch(t);
  let refuse = false;
  const muse = new MuseCli(state, { run: async (binary, args) => {
    if (args[0] === 'raw') return { result: { sessions: [{ session_id: 'side', title: 'S', can_send_messages: true, status: 'completed', updated_at_ms: 1 }] } };
    if (args[0] === 'history') return [];
    if (args[0] === 'send') {
      if (refuse) throw new Error('exit 2: not authenticated');
      return { sent: true, reply: { role: 'assistant', text: '收到' } };
    }
    throw new Error('unexpected');
  } });
  await muse.discover();
  const seen = replies(state);
  await muse.send('side', '测试', 'c9');
  await delay(10);
  assert.deepEqual([seen.at(-1)?.commandId, seen.at(-1)?.text], ['c9', '收到']);
  assert.equal(state.get('muse', 'side').status, 'idle');
  refuse = true;
  await assert.rejects(muse.send('side', '再试'), /did not accept/);
  assert.equal(muse.pending.size, 0);
});

test('Grok: without the Grok Bot app session the bots are read-only and the desktop helper takes over sending', async (t) => {
  const { state } = await scratch(t);
  let usable = false;
  const grok = new GbotCli(state, { run: async (binary, args) => {
    if (args[0] === 'doctor') return { grokBotAppSession: { present: usable, usable } };
    if (args[0] === 'bots') return [{ id: 'b1', name: 'Scout' }];
    if (args[0] === 'groups') return [];
    if (args[0] === 'thread') return { transcript: { entries: [] } };
    if (args[0] === 'send') throw new Error('exit 1: {"error":"sendPrompt failed: 502 A Sand box session may not make this request on this endpoint."}');
    throw new Error('unexpected');
  } });
  const helper = { id: 'grok-main', discovered: 0, discover: async () => { helper.discovered++; } };
  const adapter = new Fallback(grok, helper);
  await adapter.discover();
  assert.deepEqual(state.get('grok', 'b1').capabilities, ['history']);
  assert.equal(helper.discovered, 1, 'the helper runs while gbot cannot send');
  grok.gbotSends = true;
  await assert.rejects(grok.send('b1', 'hi'), /only lets its app send/);
  assert.equal(grok.canSend, false);
  usable = true;
  grok.checkedAt = 0;
  grok.polledAt = 0;
  await adapter.discover();
  assert.deepEqual(state.get('grok', 'b1').capabilities, ['history', 'send']);
  assert.equal(helper.discovered, 1);
});

test('Grok: an injected sender takes replies even when gbot cannot send', async (t) => {
  const { state } = await scratch(t);
  const sentByApp = [];
  const sender = { available: () => true, send: async (id, text, nonce) => { sentByApp.push([id, text, nonce]); return { delivery: 'server' }; } };
  const grok = new GbotCli(state, { sender, run: async (binary, args) => {
    if (args[0] === 'doctor') return { grokBotAppSession: { present: false, usable: false } };
    if (args[0] === 'bots') return [{ id: 'b1', name: 'Scout' }];
    if (args[0] === 'groups') return [];
    if (args[0] === 'thread') return { transcript: { entries: [{ id: 'e1', kind: 'send-message', seq: 4, message: { content: '在' } }] } };
    throw new Error('gbot ' + args[0] + ' should not run');
  } });
  const helper = { id: 'grok-main', discovered: 0, discover: async () => { helper.discovered++; } };
  const adapter = new Fallback(grok, helper);
  await adapter.discover();
  assert.deepEqual(state.get('grok', 'b1').capabilities, ['history', 'send']);
  assert.equal(helper.discovered, 0, 'no desktop helper needed');
  const { commandId } = await adapter.send('b1', '-v 看一下', 'c1');
  assert.equal(commandId, 'c1');
  assert.deepEqual(sentByApp, [['b1', '-v 看一下', 'c1']], 'sent as typed, without gbot\'s option workaround');
  assert.equal(state.get('grok', 'b1').status, 'running');
  await assert.rejects(adapter.send('b1', '又一句'), /still answering/);
});

test('Muse and Grok poll every minute while nobody is looking, and at full speed while someone is', async (t) => {
  const { state } = await scratch(t);
  let idle = true;
  const calls = { muse: 0, grok: 0 };
  const muse = new MuseCli(state, { binary: 'muse-cli', idle: () => idle, run: async (binary, args) => {
    if (args[0] === 'raw') { calls.muse += 1; return { ok: true, result: { sessions: [] } }; }
    return [];
  } });
  const grok = new GbotCli(state, { binary: 'gbot', idle: () => idle, run: async (binary, args) => {
    if (args[0] === 'thread') calls.grok += 1;
    if (args[0] === 'doctor') return { grokBotAppSession: { usable: true } };
    if (args[0] === 'bots') return [{ id: 'bot', name: 'Grok', kind: 'bot' }];
    if (args[0] === 'groups') return [];
    return { transcript: { entries: [] } };
  } });
  const both = () => Promise.all([muse.discover(), grok.discover()]);
  await both();
  assert.deepEqual(calls, { muse: 1, grok: 1 });
  // Past the busy-time spacing (8 s and 6 s) but inside a minute: nothing while idle.
  muse.listedAt = grok.polledAt = Date.now() - 10000;
  await both();
  assert.deepEqual(calls, { muse: 1, grok: 1 });
  idle = false;
  await both();
  assert.deepEqual(calls, { muse: 2, grok: 2 });
  idle = true;
  muse.listedAt = grok.polledAt = Date.now() - 61000;
  await both();
  assert.deepEqual(calls, { muse: 3, grok: 3 });
});

test('Codex: the app-server the gateway starts skips the remote plugin download', async (t) => {
  const { dir, state } = await scratch(t);
  const { Codex } = await import('../lib/codex.mjs');
  const argsFile = join(dir, 'args.txt');
  const fake = join(dir, 'codex');
  await writeFile(fake, '#!/bin/sh\nprintf "%s\\n" "$@" > "' + argsFile + '"\n', { mode: 0o755 });
  const codex = new Codex(state, { command: fake, mode: 'stdio' });
  await codex.connect();
  const { readFile } = await import('node:fs/promises');
  let args = '';
  for (let i = 0; i < 50 && !args; i++) { args = await readFile(argsFile, 'utf8').catch(() => ''); await delay(20); }
  assert.deepEqual(args.trim().split('\n'), ['app-server', '--listen', 'stdio://', '--disable', 'remote_plugin']);
});

/* ---------- DeepSeek Harness (dsh web through the Relay plugin) ---------- */

function dshPeer(routes) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    const { pathname, search } = new URL(url);
    calls.push({ method: init.method, path: pathname + search, auth: init.headers?.authorization, body: init.body && JSON.parse(init.body) });
    const value = await routes[init.method + ' ' + pathname]?.(init.body && JSON.parse(init.body), search);
    return { ok: value !== undefined, status: value !== undefined ? 200 : 404, json: async () => value ?? { error: 'unknown' } };
  };
  return { calls, fetcher };
}

const dshHello = { kind: 'hello', url: 'http://127.0.0.1:43210', secret: 'a'.repeat(32), pid: 4242 };

test('dsh lists the plugin\'s sessions and leaves subagents and blank ones out', async (t) => {
  const { state } = await scratch(t);
  const { calls, fetcher } = dshPeer({
    'GET /sessions': () => ({ sessions: [
      { id: 's1', updatedAt: 2000, running: true, blank: false, cwd: '/work/a', values: { title: '修网关' } },
      { id: 's2', updatedAt: 1000, running: false, blank: false, cwd: '/work/b', values: {} },
      { id: 'child', updatedAt: 3000, running: true, blank: false, parent: 's1', values: {} },
      { id: 'empty', updatedAt: 4000, running: false, blank: true, values: {} },
    ] }),
  });
  const dsh = new DshWeb(state, { fetch: fetcher });
  await dsh.discover();
  assert.equal(state.online.get('dsh'), 'unconfigured');
  await dsh.hook(dshHello);
  await delay(0);
  assert.equal(state.online.get('dsh'), 'connected');
  assert.equal(calls[0].auth, 'Bearer ' + 'a'.repeat(32));
  assert.deepEqual([...state.sessions.keys()].filter((key) => key.startsWith('dsh:')).sort(), ['dsh:s1', 'dsh:s2']);
  assert.equal(state.get('dsh', 's1').name, '修网关');
  assert.equal(state.get('dsh', 's1').status, 'running');
  assert.equal(state.get('dsh', 's2').name, '对话');
  assert.deepEqual(state.get('dsh', 's2').capabilities, ['history', 'send', 'interrupt']);
  await dsh.hook({ kind: 'bye', pid: 4242 });
  assert.equal(state.online.get('dsh'), 'offline');
  assert.equal(state.get('dsh', 's1').status, 'offline');
  await assert.rejects(dsh.send('s1', 'hi'), (error) => error instanceof ApiError && error.status === 503);
});

test('dsh events drive status and the live action; a turn that ends drops its cards', async (t) => {
  const { state } = await scratch(t);
  const { fetcher } = dshPeer({ 'GET /sessions': () => ({ sessions: [{ id: 's1', updatedAt: 1, running: false, blank: false, values: {} }] }) });
  const dsh = new DshWeb(state, { fetch: fetcher });
  await dsh.hook(dshHello);
  await delay(0);
  const actions = [];
  state.on('event', (event) => { if (event.kind === 'action') actions.push(event.tool); });
  await dsh.hook({ kind: 'event', session: 's1', type: 'turn/start', at: 10 });
  assert.equal(state.get('dsh', 's1').status, 'running');
  await dsh.hook({ kind: 'event', session: 's1', type: 'tool/call', callId: 'c1', name: 'bash', args: JSON.stringify({ command: 'npm test' }), at: 11 });
  assert.deepEqual(actions.at(-1), { type: 'commandExecution', command: 'npm test' });
  const asked = dsh.hook({ kind: 'ask', session: 's1', type: 'approval', toolName: 'bash', callId: 'c1', reason: 'run the tests' });
  assert.equal(state.get('dsh', 's1').status, 'approval');
  const [card] = [...state.requests.values()];
  assert.equal(card.title, 'Run a command');
  assert.equal(card.command, 'npm test');
  await dsh.hook({ kind: 'event', session: 's1', type: 'turn/end', reason: 'completed', at: 12 });
  assert.deepEqual(await Promise.race([asked, delay(50, 'held')]), 'held'); // the plugin's request stays open; dsh decides
  assert.equal(state.requests.size, 0);
  assert.equal(state.get('dsh', 's1').status, 'idle');
  assert.equal(actions.at(-1), null);
});

test('dsh approvals and questions answer from the panel, and close when dsh answers first', async (t) => {
  const { state } = await scratch(t);
  const { fetcher } = dshPeer({ 'GET /sessions': () => ({ sessions: [{ id: 's1', updatedAt: 1, running: true, blank: false, values: {} }] }) });
  const dsh = new DshWeb(state, { fetch: fetcher });
  await dsh.hook(dshHello);
  await delay(0);
  const approval = dsh.hook({ kind: 'ask', session: 's1', type: 'approval', toolName: 'write', callId: 'none' });
  await state.decide([...state.requests.keys()][0], { decision: 'accept' });
  assert.deepEqual(await approval, { answer: 'allowed-once' });
  const question = dsh.hook({ kind: 'ask', session: 's1', type: 'question', questions: [
    { id: 'pick', question: '用哪个库？', options: [{ label: 'zod' }, { label: 'valibot' }] },
    { id: 'name', question: '叫什么？', options: [{ label: 'relay' }] },
  ] });
  const [card] = [...state.requests.values()];
  assert.equal(card.kind, 'input');
  await assert.rejects(state.decide(card.id, { answers: { q1: 'zod' } }), /Answer each question/);
  await state.decide(card.id, { answers: { q1: 'zod', q2: '我自己起的名字' } });
  assert.deepEqual(await question, { answer: { answers: [{ id: 'pick', selected: ['zod'] }, { id: 'name', selected: [], custom: '我自己起的名字' }] } });
  let close;
  const gone = dsh.hook({ kind: 'ask', session: 's1', type: 'approval', toolName: 'bash' }, new Promise((resolve) => { close = resolve; }));
  const id = [...state.requests.keys()][0];
  close();
  assert.deepEqual(await gone, {});
  assert.equal(state.requests.size, 0);
  await assert.rejects(state.decide(id, { decision: 'accept' }), /no longer available/);
});

test('dsh reads history through the plugin and sends into the session\'s queue', async (t) => {
  const { state } = await scratch(t);
  const { calls, fetcher } = dshPeer({
    'GET /sessions': () => ({ sessions: [{ id: 's1', updatedAt: 1, running: false, blank: false, values: {} }] }),
    'GET /history': () => ({ events: [
      { type: 'user/message', id: 'u1', text: '跑一下测试', seq: 3, at: 100 },
      { type: 'tool/call', callId: 'c1', name: 'read', args: JSON.stringify({ path: '/work/a/server.mjs' }), seq: 4, at: 101 },
      { type: 'assistant/message', id: 'a1', text: '测试都过了', seq: 5, at: 102 },
      { type: 'assistant/message', id: 'a2', text: '  ', seq: 6, at: 103 },
    ] }),
    'POST /prompt': () => ({ accepted: true }),
    'POST /cancel': () => ({ accepted: true }),
  });
  const dsh = new DshWeb(state, { fetch: fetcher });
  await dsh.hook(dshHello);
  await delay(0);
  assert.deepEqual((await dsh.history('s1')).map((row) => [row.role, row.text]), [['user', '跑一下测试'], ['assistant', '测试都过了']]);
  assert.deepEqual((await dsh.history('s1', { tools: true }))[1].tool, { type: 'dynamicToolCall', tool: 'read', detail: 'server.mjs' });
  assert.equal(calls.filter((call) => call.path.startsWith('/history')).length, 1); // the second read came from the cache
  assert.deepEqual(await dsh.send('s1', '再跑一遍', 'n1'), { commandId: 'n1' });
  assert.deepEqual(calls.at(-1), { method: 'POST', path: '/prompt', auth: 'Bearer ' + 'a'.repeat(32), body: { id: 's1', text: '再跑一遍', requestId: 'n1' } });
  assert.equal(state.get('dsh', 's1').status, 'running');
  await dsh.control('s1', 'interrupt');
  assert.deepEqual(calls.at(-1).body, { id: 's1' });
  await assert.rejects(dsh.control('s1', 'steer'), /messages and interrupts only/);
});

test('dsh starts a new session with its first message', async (t) => {
  const { state } = await scratch(t);
  const created = [];
  const { calls, fetcher } = dshPeer({
    'GET /sessions': () => ({ sessions: created.map((id) => ({ id, updatedAt: 5, running: true, blank: false, values: {} })) }),
    'POST /create': () => ({ id: 'session-n' }),
  });
  const dsh = new DshWeb(state, { fetch: fetcher });
  await dsh.hook(dshHello);
  await delay(0);
  created.length = 0; // dsh still lists the new session as blank right after creating it
  assert.deepEqual(await dsh.create('你好'), { id: 'session-n' }, 'voice reads the id back');
  const posted = calls.find((call) => call.path === '/create');
  assert.equal(posted.body.text, '你好');
  assert.match(posted.body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(state.get('dsh', 'session-n').status, 'running', 'the new session is listed right away, before dsh lists it');
  assert.equal(state.get('dsh', 'session-n').name, '你好');
  assert.ok(state.get('dsh', 'session-n').capabilities.includes('send'));
  await assert.rejects(dsh.create('  '), (error) => error.status === 400);
  assert.equal(calls.filter((call) => call.path === '/create').length, 1, 'an empty message is not sent');
  await dsh.hook({ kind: 'bye', pid: 4242 });
  await assert.rejects(dsh.create('再来'), (error) => error.status === 503);
});

test('dsh tool calls and session events come out in the gateway\'s shapes', () => {
  assert.deepEqual(dshTool('terminal_send', JSON.stringify({ id: 't1', text: 'npm test' })), { type: 'commandExecution', command: 'npm test' });
  // The default "ptc" preset runs tools from a script; the line shows the first tool the script calls.
  const script = (code) => JSON.stringify({ code });
  assert.deepEqual(dshTool('run_code', script('const res = await tools.bash({ description: "Print hello", command: "echo \'hello from dsh\' && pwd" });\nreturn res;')),
    { type: 'commandExecution', command: "echo 'hello from dsh' && pwd" });
  assert.deepEqual(dshTool('run_code', script("await tools.write({ path: '/a/b/notes.md', content: x });")), { type: 'fileChange', files: 1, path: '/a/b/notes.md' });
  assert.deepEqual(dshTool('run_code', script('await tools.read({ path: `lib/dsh.mjs` });')), { type: 'dynamicToolCall', tool: 'read', detail: 'dsh.mjs' });
  assert.deepEqual(dshTool('run_code', JSON.stringify({ code: 'return 1 + 1', description: '算一下' })), { type: 'dynamicToolCall', tool: 'run_code', detail: '算一下' });
  assert.deepEqual(dshTool('edit', JSON.stringify({ path: '/a/b/lens.ss' })), { type: 'fileChange', files: 1, path: '/a/b/lens.ss' });
  assert.deepEqual(dshTool('apply_patch', JSON.stringify({ patch: '*** Begin Patch\n*** Update File: lib/x.mjs\n' })), { type: 'fileChange', files: 1, path: 'lib/x.mjs' });
  assert.deepEqual(dshTool('grep', JSON.stringify({ pattern: 'TODO' })), { type: 'dynamicToolCall', tool: 'grep', detail: 'TODO' });
  assert.deepEqual(dshTool('web_search', '{not json'), { type: 'webSearch', query: '' });
  assert.deepEqual(dshCompact({ type: 'assistant/message', data: { message: { id: 'm', content: [{ type: 'reasoning', text: 'x' }, { type: 'text', text: '好了' }] } } }),
    { type: 'assistant/message', id: 'm', text: '好了' });
  assert.deepEqual(dshCompact({ type: 'user/message', data: { id: 'u', role: 'user', content: [{ type: 'text', text: '你好' }] } }), { type: 'user/message', id: 'u', text: '你好' });
  assert.deepEqual(dshCompact({ type: 'user/message', data: { id: 'u', source: { kind: 'user', rpcId: 'r' }, content: [{ type: 'text', text: '你好' }] } }),
    { type: 'user/message', id: 'u', text: '你好' });
  for (const kind of ['runtime-context', 'skill-catalog', 'time-context']) {
    assert.equal(dshCompact({ type: 'user/message', data: { id: 'x', source: { kind }, content: [{ type: 'text', text: 'Current working directory' }] } }), null,
      kind + ' is dsh talking to the model, not the person');
  }
  assert.deepEqual(dshCompact({ type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } }), { type: 'turn/end', turn: 2, reason: 'completed' });
  assert.equal(dshCompact({ type: 'step/start', data: {} }), null);
});
