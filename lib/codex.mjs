import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { ApiError, limitText, plainText } from './state.mjs';

const agent = 'codex';
const approvalKinds = new Set([
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'item/tool/requestUserInput',
]);
const statusOf = (status) => {
  if (status?.activeFlags?.includes('waitingOnApproval')) return 'approval';
  if (status?.activeFlags?.includes('waitingOnUserInput')) return 'input';
  return ({ active: 'running', idle: 'idle', notLoaded: 'inactive', systemError: 'failed' })[status?.type]
    ?? 'unknown';
};

// The fields of a tool-call item the glasses transcript needs (app-server ThreadItem variants).
function toolOf(item) {
  switch (item.type) {
    case 'commandExecution': return { type: item.type, command: limitText(item.command, 500), exitCode: item.exitCode ?? null };
    case 'fileChange': return { type: item.type, files: item.changes?.length ?? 0, path: limitText(item.changes?.[0]?.path, 300) };
    case 'mcpToolCall': return { type: item.type, server: limitText(item.server, 80), tool: limitText(item.tool, 80) };
    case 'dynamicToolCall': return { type: item.type, tool: limitText(item.tool, 80) };
    case 'webSearch': return { type: item.type, query: limitText(item.query, 200) };
    case 'imageView': return { type: item.type, path: limitText(item.path, 300) };
    case 'collabAgentToolCall': return { type: item.type };
    default: return null;
  }
}

export class Codex {
  constructor(state, options) {
    this.state = state;
    this.options = options;
    this.outstanding = new Map();
    this.nativeRequests = new Map();
    this.attached = new Map();
    this.turns = new Map();
    this.nextId = 0;
    this.ready = false;
  }

  async connect() {
    const { command, mode, socket } = this.options;
    if (mode === 'off' || this.child) return;
    // The remote plugin sync downloads tens of MB from chatgpt.com every time an app-server starts,
    // and this one starts with the gateway. Plugins installed on this Mac still load.
    const args = mode === 'stdio' ? ['app-server', '--listen', 'stdio://', '--disable', 'remote_plugin']
      : ['app-server', 'proxy', ...(socket ? ['--sock', socket] : [])];
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PANEL_')));
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child = child;
    child.stdin.on('error', () => {});
    child.on('error', () => this.disconnect(child));
    child.on('close', () => this.disconnect(child));
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (this.child !== child) return;
      try { this.receive(JSON.parse(line)); } catch { /* Ignore invalid protocol frames. */ }
    });
    try {
      await this.rpc('initialize', {
        clientInfo: { name: 'local-agent-panel', version: '0.1.0' }, capabilities: null,
      });
      this.write({ method: 'initialized' });
      this.ready = true;
      await this.discover();
      this.state.connection(agent, 'connected');
    } catch {
      child.kill();
      this.disconnect(child);
    }
  }

  disconnect(child) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = false;
    for (const call of this.outstanding.values()) call.reject(new ApiError(503, 'Codex App Server disconnected.'));
    this.outstanding.clear();
    for (const id of this.nativeRequests.values()) this.state.clearRequest(id);
    this.nativeRequests.clear();
    this.attached.clear();
    this.turns.clear();
    for (const row of this.state.sessions.values()) {
      if (row.agent === agent) this.state.put(agent, row.id, { status: 'offline', capabilities: [] });
    }
    this.state.connection(agent, 'offline');
  }

  close() {
    if (!this.child) return Promise.resolve();
    const child = this.child;
    this.disconnect(child);
    return new Promise((resolve) => {
      const soft = setTimeout(() => child.kill(), 1500);
      const hard = setTimeout(() => child.kill('SIGKILL'), 3500);
      child.once('close', () => {
        clearTimeout(soft);
        clearTimeout(hard);
        resolve();
      });
      child.stdin.end();
    });
  }

  write(frame) {
    if (!this.child?.stdin.writable) throw new ApiError(503, 'Codex App Server is unavailable.');
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
  }

  async rpc(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.outstanding.delete(id);
        reject(new ApiError(504, 'Codex did not confirm ' + method + '.'));
      }, 12000);
      const finish = (callback) => (value) => { clearTimeout(timer); callback(value); };
      this.outstanding.set(id, { resolve: finish(resolve), reject: finish(reject) });
      try { this.write({ id, method, params }); } catch (error) {
        this.outstanding.delete(id);
        finish(reject)(error);
      }
    });
  }

  thread(thread) {
    if (!thread?.id || thread.parentThreadId) return;
    this.state.put(agent, thread.id, {
      name: limitText(thread.name || thread.preview || 'Untitled Codex session', 110),
      cwd: limitText(thread.cwd, 500), status: statusOf(thread.status),
      updatedAt: (thread.updatedAt ?? 0) * 1000,
      capabilities: ['history', 'send', 'steer', 'interrupt', 'approval', 'input'],
    });
  }

  async discover() {
    if (!this.ready) return;
    const result = await this.rpc('thread/list', { limit: 35, sortKey: 'updated_at', useStateDbOnly: true });
    for (const thread of result.data) this.thread(thread);
  }

  async join(id) {
    if (this.attached.has(id)) return this.attached.get(id);
    const promise = this.rpc('thread/resume', { threadId: id, excludeTurns: true })
      .then(({ thread, model, reasoningEffort }) => {
        if (thread.id !== id) throw new ApiError(502, 'Codex returned a different session.');
        this.thread(thread);
        this.model(id, model, reasoningEffort);
      }).catch((error) => {
        this.attached.delete(id);
        throw error;
      });
    this.attached.set(id, promise);
    return promise;
  }

  /** Model and reasoning effort come only with a resumed or started thread; the glasses show them in the header. */
  model(id, model, effort) {
    if (!model || !this.state.sessions.has(agent + ':' + id)) return;
    this.state.put(agent, id, { model: limitText(model, 60), effort: typeof effort === 'string' ? effort : null });
  }

  /** Messages of a thread, oldest first. With `tools`, tool calls are included as `{ role: 'tool', tool }` rows. */
  async history(id, { tools = false } = {}) {
    // The default "summary" view leaves tool calls out; "full" carries every item, so it pages fewer turns.
    const limit = tools ? 10 : 25;
    const { data } = await this.rpc('thread/turns/list', { threadId: id, limit, sortDirection: 'desc',
      ...(tools ? { itemsView: 'full' } : {}) })
      .catch(async (error) => {
        if (error.rpcCode !== -32601) throw error;
        const { thread } = await this.rpc('thread/read', { threadId: id, includeTurns: true });
        return { data: thread.turns.slice(-limit).reverse() };
      });
    return [...data].reverse().flatMap((turn) => (turn.items ?? []).flatMap((item) => {
      if (tools) {
        const tool = toolOf(item);
        if (tool) return [{ id: item.id, turnId: turn.id, role: 'tool', text: '', tool }];
      }
      const role = { userMessage: 'user', agentMessage: 'assistant' }[item.type];
      const text = role && limitText(item.type === 'agentMessage' ? item.text : plainText(item.content));
      return text ? [{ id: item.id, turnId: turn.id, role, text, phase: item.phase }] : [];
    }));
  }

  /** Start a thread in `cwd`, or the folder of the most recently used Codex session, and send the first message. */
  async create(text, { cwd } = {}) {
    if (!this.ready) throw new ApiError(503, 'Codex App Server is unavailable.');
    const recent = [...this.state.sessions.values()].filter((row) => row.agent === agent && row.cwd)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    const folder = cwd ?? recent?.cwd;
    const { thread, model, reasoningEffort } = await this.rpc('thread/start', folder ? { cwd: folder } : {});
    this.thread(thread);
    this.model(thread.id, model, reasoningEffort);
    this.attached.set(thread.id, Promise.resolve());
    const { turn } = await this.rpc('turn/start', {
      threadId: thread.id, clientUserMessageId: randomUUID(), input: [{ type: 'text', text }],
    });
    if (turn.status === 'inProgress') this.turns.set(thread.id, turn.id);
    return { id: thread.id, turnId: turn.id };
  }

  async send(id, text, clientId) {
    await this.join(id);
    const { turn } = await this.rpc('turn/start', {
      threadId: id, clientUserMessageId: clientId, input: [{ type: 'text', text }],
    });
    if (turn.status === 'inProgress') this.turns.set(id, turn.id);
    return { turnId: turn.id };
  }

  async control(id, action, text, expected) {
    const turnId = this.turns.get(id);
    if (!turnId || expected !== turnId) throw new ApiError(409, 'The active turn changed. Refresh and try again.');
    if (action === 'interrupt') return this.rpc('turn/interrupt', { threadId: id, turnId });
    return this.rpc('turn/steer', { threadId: id, expectedTurnId: turnId, input: [{ type: 'text', text }] });
  }

  receive(message) {
    const { id, method, params = {} } = message;
    if (id !== undefined && !method) {
      const call = this.outstanding.get(id);
      if (!call) return;
      this.outstanding.delete(id);
      if (message.error) {
        const error = new ApiError(409, limitText(message.error.message, 350) || 'Codex rejected the operation.');
        error.rpcCode = message.error.code;
        call.reject(error);
      } else call.resolve(message.result);
      return;
    }
    if (id !== undefined) {
      if (approvalKinds.has(method) && this.state.sessions.has(agent + ':' + params.threadId)) {
        this.registerRequest(id, method, params);
      }
      return; // Leave other native requests with their original client.
    }
    if (method === 'thread/started') this.thread(params.thread);
    const session = params.threadId;
    if (!session || !this.state.sessions.has(agent + ':' + session)) return;
    if (method === 'thread/status/changed') this.state.put(agent, session, { status: statusOf(params.status) });
    // What the turn is doing right now, for the glasses: set when a tool call starts, cleared when a turn starts or ends.
    if (method === 'item/started' && toolOf(params.item ?? {})) this.state.transient('action', agent, session, { tool: toolOf(params.item) });
    if (method === 'turn/started' || method === 'turn/completed') this.state.transient('action', agent, session, { tool: null });
    if (method === 'turn/started') {
      this.turns.set(session, params.turn.id);
      this.state.put(agent, session, { turnId: params.turn.id, status: 'running' });
    }
    if (method === 'turn/completed') {
      if (this.turns.get(session) === params.turn.id) this.turns.delete(session);
      this.state.put(agent, session, { turnId: null, updatedAt: Date.now(),
        status: params.turn.status === 'failed' ? 'failed' : 'idle' });
      this.state.transient('turn', agent, session, { turnId: params.turn.id, status: params.turn.status });
    }
    if (method === 'item/agentMessage/delta') this.state.transient('delta', agent, session, {
      turnId: params.turnId, itemId: params.itemId, text: limitText(params.delta),
    });
    if (method === 'item/completed') this.state.event('activity', agent, session);
    if (method === 'serverRequest/resolved') {
      this.state.clearRequest(this.nativeRequests.get(params.requestId));
      this.nativeRequests.delete(params.requestId);
    }
  }

  registerRequest(id, method, params) {
    if (this.nativeRequests.has(id)) return;
    const isInput = method === 'item/tool/requestUserInput';
    const questions = isInput ? params.questions?.map((q) => ({
      id: q.id, title: limitText(q.header, 160), text: limitText(q.question, 500),
      options: q.options?.map(({ label }) => limitText(label, 160)) ?? [], secret: !!q.isSecret,
    })) ?? [] : [];
    if (questions.some((question) => question.secret)) return;
    const details = {
      kind: isInput ? 'input' : 'approval',
      title: isInput ? 'Codex needs an answer' : params.command ? 'Run a command' : 'Modify files',
      description: limitText(params.reason, 500), command: limitText(params.command, 10000),
      approvalAllowed: typeof params.command === 'string' && params.command.length > 0
        && params.command.length <= 10000 && !params.networkApprovalContext,
      cwd: limitText(params.cwd, 500), questions,
    };
    this.nativeRequests.set(id, this.state.addRequest(agent, params.threadId, details, (decision) => {
      let result;
      if (isInput) {
        const answers = Object.fromEntries(questions.map((question) => {
          const value = limitText(decision.answers?.[question.id], 1000).trim();
          if (!value) throw new ApiError(400, 'Answer each question.');
          return [question.id, { answers: [value] }];
        }));
        result = { answers };
      } else {
        // acceptForSession: allow this kind of action for the rest of the session.
        if (!['accept', 'acceptForSession', 'decline'].includes(decision.decision)) throw new ApiError(400, 'Select a decision.');
        if (decision.decision !== 'decline' && !details.approvalAllowed) {
          throw new ApiError(409, 'Review this approval in the native Codex client.');
        }
        result = { decision: decision.decision };
      }
      this.write({ id, result });
    }));
  }
}
