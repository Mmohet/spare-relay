import { randomUUID } from 'node:crypto';
import { ApiError, limitText } from './state.mjs';

const agent = 'dsh';
const listEvery = 4000;
const historyFresh = 3000;
const recentLimit = 20; // Idle sessions listed besides the running ones.
const freshFor = 60000; // how long a session started from the gateway may stay unlisted
const askLimit = 590000; // the plugin holds an approval this long at most
const urlPattern = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;
const secretPattern = /^[A-Za-z0-9_-]{24,128}$/;
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const fileTools = new Set(['edit', 'write', 'apply_patch', 'str_replace_editor']);

function argsOf(text) {
  try {
    const value = JSON.parse(text || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const baseName = (path) => String(path ?? '').split('/').filter(Boolean).at(-1) ?? '';
const innerFields = ['command', 'text', 'path', 'file_path', 'filePath', 'pattern', 'url', 'query', 'skill', 'description'];

/**
 * The first tool a `run_code` script calls, as `tools.bash({ command: "…" })`: dsh's code-calling presets
 * (the default "ptc" among them) run tools from a script instead of calling them directly. Only string
 * literals are read; null when the script calls no tool that way.
 */
function innerCall(code) {
  const call = /\btools\.([A-Za-z_]+)\s*\(/.exec(String(code ?? ''));
  if (!call) return null;
  const rest = code.slice(call.index + call[0].length, call.index + call[0].length + 4000);
  const args = {};
  for (const key of innerFields) {
    const found = new RegExp('\\b' + key + '\\s*:\\s*("(?:[^"\\\\\\n]|\\\\.)*"|\'(?:[^\'\\\\\\n]|\\\\.)*\'|`[^`$]*`)').exec(rest);
    if (!found) continue;
    const literal = found[1];
    try { args[key] = literal[0] === '"' ? JSON.parse(literal) : literal.slice(1, -1).replace(/\\(.)/g, '$1'); } catch { args[key] = literal.slice(1, -1); }
  }
  return { name: call[1], args };
}

/** A dsh tool call in the gateway's shape (the one Codex and Claude rows use), for the lens's action line. */
export function dshTool(name, argsText) {
  const args = argsOf(argsText);
  if (name === 'run_code') {
    const inner = innerCall(args.code);
    if (inner && inner.name !== 'run_code') return dshTool(inner.name, JSON.stringify(inner.args));
    return { type: 'dynamicToolCall', tool: 'run_code', detail: limitText(String(args.description ?? ''), 200) };
  }
  const path = args.path ?? args.file_path ?? args.filePath
    ?? /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(String(args.patch ?? args.input ?? ''))?.[1];
  if (name === 'bash' || name === 'terminal_send') return { type: 'commandExecution', command: limitText(String(args.command ?? args.text ?? args.input ?? ''), 2000) };
  if (fileTools.has(name)) return { type: 'fileChange', files: 1, path: limitText(String(path ?? ''), 500) };
  if (name === 'web_search') return { type: 'webSearch', query: limitText(String(args.query ?? ''), 300) };
  const detail = ['grep', 'glob'].includes(name) ? args.pattern : baseName(path) || args.url || args.skill || args.query;
  return { type: 'dynamicToolCall', tool: name, detail: limitText(String(detail ?? ''), 200) };
}

/** dsh's questions as the panel's: at most four, each with its options. */
function questionsOf(items) {
  const questions = (Array.isArray(items) ? items : []).slice(0, 4).map((item, index) => ({
    id: 'q' + (index + 1), original: String(item?.id ?? ''), title: limitText(item?.header, 160),
    text: limitText(item?.question, 500), multiple: Boolean(item?.multiSelect),
    options: (Array.isArray(item?.options) ? item.options : []).map((option) => limitText(option?.label, 160)).filter(Boolean),
  }));
  return questions.length && questions.every((question) => question.original && question.text.trim()) ? questions : null;
}

/**
 * DeepSeek Harness sessions open in its web app. The `dsh/relay.mjs` plugin inside dsh reports every turn
 * and tool call here, holds its approvals and questions open until one side answers, and serves a local API
 * for the session list, history and sending a message. Without the plugin dsh is simply not shown.
 */
export class DshWeb {
  constructor(state, { fetch: fetcher = fetch } = {}) {
    this.state = state;
    this.agent = agent;
    this.fetch = fetcher;
    this.peer = null; // { url, secret, pid, at } from the plugin's last hello
    this.listedAt = 0;
    this.known = new Set();
    this.fresh = new Map(); // session id -> when the glasses started it; dsh lists it only after its first turn starts
    this.histories = new Map(); // session id -> { at, rows }
    this.calls = new Map(); // tool call id -> { session, name, args }, for the approval card
    this.turning = new Map(); // session id -> 'running' | 'idle' | 'failed' from the plugin's events
    this.asking = new Map(); // panel request id -> session id
  }

  /** What the plugin posts: `hello`, `bye`, `event` or `ask`. An `ask` resolves when it is answered or dropped. */
  async hook(input, closed = new Promise(() => {})) {
    switch (input?.kind) {
      case 'hello': return this.hello(input);
      case 'bye':
        if (this.peer && this.peer.pid === input.pid) this.drop();
        return {};
      case 'event': return this.event(input);
      case 'ask': return this.ask(input, closed);
      default: throw new ApiError(400, 'Unknown dsh hook.');
    }
  }

  hello({ url, secret, pid }) {
    if (!urlPattern.test(url ?? '') || !secretPattern.test(secret ?? '') || !Number.isInteger(pid)) throw new ApiError(400, 'Invalid dsh hello.');
    const fresh = !this.peer || this.peer.url !== url || this.peer.secret !== secret;
    this.peer = { url, secret, pid, at: Date.now() };
    this.state.connection(agent, 'connected');
    if (fresh) {
      this.listedAt = 0;
      void this.discover().catch(() => {});
    }
    return {};
  }

  drop() {
    this.peer = null;
    this.state.connection(agent, 'offline');
    for (const id of this.known) this.state.put(agent, id, { status: 'offline', capabilities: [] });
  }

  event(input) {
    const id = String(input.session ?? '');
    if (!idPattern.test(id)) throw new ApiError(400, 'Invalid dsh session.');
    const at = Number(input.at) || Date.now();
    const update = { updatedAt: at };
    if (input.cwd) update.cwd = limitText(input.cwd, 500);
    this.histories.delete(id);
    switch (input.type) {
      case 'turn/start':
        this.turning.set(id, 'running');
        this.state.transient('action', agent, id, { tool: null });
        break;
      case 'turn/end':
        this.turning.set(id, /error|fail/i.test(input.reason ?? '') ? 'failed' : 'idle');
        this.state.transient('action', agent, id, { tool: null });
        this.settle(id);
        break;
      case 'tool/call': {
        const callId = String(input.callId ?? '');
        if (callId) {
          this.calls.set(callId, { session: id, name: String(input.name ?? ''), args: String(input.args ?? '') });
          if (this.calls.size > 200) this.calls.delete(this.calls.keys().next().value);
        }
        this.turning.set(id, 'running');
        this.state.transient('action', agent, id, { tool: dshTool(String(input.name ?? ''), input.args) });
        break;
      }
      case 'user/message':
      case 'assistant/message':
        this.state.event('activity', agent, id);
        break;
      case 'session/title':
        if (input.title) update.name = limitText(input.title, 110);
        break;
      default:
        break;
    }
    if (!this.known.has(id) && this.peer) this.listedAt = 0; // a session the list has not shown yet
    if (this.state.sessions.has(agent + ':' + id)) this.state.put(agent, id, { ...update, status: this.statusOf(id) });
    return {};
  }

  statusOf(id) {
    if ([...this.asking.values()].includes(id)) return 'approval';
    return this.turning.get(id) ?? 'idle';
  }

  ask(input, closed) {
    const id = String(input.session ?? '');
    if (!idPattern.test(id)) throw new ApiError(400, 'Invalid dsh session.');
    const cwd = this.state.sessions.get(agent + ':' + id)?.cwd ?? '';
    let details;
    let answer;
    if (input.type === 'question') {
      const questions = questionsOf(input.questions);
      if (!questions) return {};
      details = { kind: 'input', title: 'DeepSeek needs an answer', description: questions[0].text, cwd: limitText(cwd, 500),
        questions: questions.map(({ original, ...question }) => question) };
      // The panel and the lens send the chosen labels or your own words; dsh wants labels and custom text apart.
      answer = (decision) => ({ answers: questions.map((question) => {
        const given = decision.answers?.[question.id];
        const values = (Array.isArray(given) ? given : [given]).map((value) => limitText(String(value ?? ''), 1000).trim()).filter(Boolean);
        if (!values.length) throw new ApiError(400, 'Answer each question.');
        const selected = values.filter((value) => question.options.includes(value));
        const custom = values.filter((value) => !question.options.includes(value)).join(', ');
        return { id: question.original, selected, ...(custom ? { custom } : {}) };
      }) });
    } else {
      const name = String(input.toolName ?? '');
      const call = this.calls.get(String(input.callId ?? ''));
      const tool = call ? dshTool(call.name, call.args) : null;
      const command = tool?.type === 'commandExecution' ? tool.command : tool?.type === 'fileChange' ? tool.path : '';
      details = { kind: 'approval',
        title: tool?.type === 'commandExecution' ? 'Run a command' : tool?.type === 'fileChange' ? 'Modify files' : 'Tool approval',
        description: limitText(input.reason || name, 500), command: limitText(command, 10000), cwd: limitText(cwd, 500),
        tool: limitText(name, 200), approvalAllowed: true };
      answer = (decision) => {
        if (!['accept', 'decline'].includes(decision.decision)) throw new ApiError(400, 'Select a decision.');
        return decision.decision === 'accept' ? 'allowed-once' : 'rejected';
      };
    }
    return new Promise((resolve) => {
      let request = null;
      let gone = false;
      const finish = (reply = {}) => {
        if (!this.asking.delete(request)) return;
        this.state.clearRequest(request);
        this.apply(id);
        resolve(reply);
      };
      request = this.state.addRequest(agent, id, details, (decision) => {
        const value = answer(decision);
        if (gone || !this.asking.has(request)) throw new ApiError(409, 'This was already answered on the computer.');
        this.turning.set(id, 'running');
        finish({ answer: value });
      });
      this.asking.set(request, id);
      const timer = setTimeout(() => finish(), askLimit);
      timer.unref?.();
      closed.then(() => { gone = true; clearTimeout(timer); finish(); });
      this.apply(id);
    });
  }

  /** Drop the cards still waiting in a session whose turn ended. */
  settle(id) {
    for (const [request, session] of [...this.asking]) {
      if (session !== id) continue;
      this.asking.delete(request);
      this.state.clearRequest(request);
    }
  }

  apply(id) {
    if (this.state.sessions.has(agent + ':' + id)) this.state.put(agent, id, { status: this.statusOf(id) });
  }

  async call(method, path, body) {
    const peer = this.peer;
    if (!peer) throw new ApiError(503, 'DeepSeek Harness is not connected. Open dsh web with the Relay plugin.');
    let res;
    try {
      res = await this.fetch(peer.url + path, {
        method, signal: AbortSignal.timeout(15000),
        headers: { authorization: 'Bearer ' + peer.secret, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      if (this.peer === peer) this.drop();
      throw new ApiError(502, 'DeepSeek Harness did not answer.');
    }
    const value = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status === 401 ? 502 : res.status >= 500 ? 502 : 409, 'DeepSeek Harness refused: ' + limitText(String(value.error ?? res.status), 100));
    return value;
  }

  async discover() {
    if (!this.peer) {
      if (!this.state.online.has(agent)) this.state.connection(agent, 'unconfigured');
      return;
    }
    if (Date.now() - this.peer.at > 60000) { this.drop(); return; } // no hello for three rounds: dsh is gone
    if (Date.now() - this.listedAt < listEvery) return;
    this.listedAt = Date.now();
    const { sessions } = await this.call('GET', '/sessions');
    const rows = (Array.isArray(sessions) ? sessions : [])
      .filter((row) => idPattern.test(row?.id ?? '') && !row.parent && !row.blank)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const shown = [...rows.filter((row) => row.running), ...rows.filter((row) => !row.running).slice(0, recentLimit)];
    const seen = new Set();
    for (const row of shown) {
      seen.add(row.id);
      if (!row.running && this.turning.get(row.id) === 'running' && ![...this.asking.values()].includes(row.id)) this.turning.set(row.id, 'idle');
      if (row.running && !this.turning.has(row.id)) this.turning.set(row.id, 'running');
      const values = row.values ?? {};
      const title = values.title ?? values.sessionTitle ?? values.sessionListMetadata?.title;
      const previous = this.state.sessions.get(agent + ':' + row.id);
      this.known.add(row.id);
      this.state.put(agent, row.id, {
        name: limitText(typeof title === 'string' ? title : '', 110) || previous?.name && previous.name !== 'DeepSeek' && previous.name || '对话',
        status: this.statusOf(row.id), updatedAt: Math.max(Number(row.updatedAt) || 0, previous?.updatedAt ?? 0),
        cwd: limitText(row.cwd, 500), live: true, capabilities: ['history', 'send', 'interrupt'],
      });
    }
    for (const id of [...this.known]) {
      if (seen.has(id)) { this.fresh.delete(id); continue; }
      if (Date.now() - (this.fresh.get(id) ?? 0) < freshFor) continue; // started from here, not listed yet
      this.fresh.delete(id);
      this.known.delete(id);
      this.histories.delete(id);
      this.state.remove(agent, id);
    }
  }

  async history(id, { tools = false } = {}) {
    const cached = this.histories.get(id);
    let rows = cached && Date.now() - cached.at < historyFresh ? cached.rows : null;
    if (!rows) {
      const { events } = await this.call('GET', '/history?id=' + encodeURIComponent(id));
      rows = [];
      for (const event of Array.isArray(events) ? events : []) {
        const at = Number(event.at) || 0;
        if (event.type === 'tool/call') {
          rows.push({ id: 'c' + event.seq, role: 'tool', tool: dshTool(String(event.name ?? ''), event.args), at });
        } else if ((event.type === 'user/message' || event.type === 'assistant/message') && event.text?.trim()) {
          rows.push({ id: event.id || 'm' + event.seq, role: event.type === 'user/message' ? 'user' : 'assistant', text: limitText(event.text), at });
        }
      }
      this.histories.set(id, { at: Date.now(), rows });
    }
    return (tools ? rows : rows.filter((row) => row.role !== 'tool')).slice(tools ? -120 : -80);
  }

  /** Into the session's queue: dsh starts it now when idle, or after the running turn. */
  async send(id, text, commandId = randomUUID()) {
    await this.call('POST', '/prompt', { id, text, requestId: commandId });
    this.histories.delete(id);
    this.turning.set(id, 'running');
    this.state.put(agent, id, { status: this.statusOf(id), updatedAt: Date.now() });
    return { commandId };
  }

  /**
   * A new session in dsh's default folder (or `cwd`), started with `text`. It is put in the gateway's state
   * right away, because dsh lists it as blank until its first turn starts.
   */
  async create(text, { cwd } = {}) {
    const message = limitText(String(text ?? ''), 12000);
    if (!message.trim()) throw new ApiError(400, 'Say something to start the session with.');
    const { id } = await this.call('POST', '/create', { text: message, requestId: randomUUID(), ...(cwd ? { cwd } : {}) });
    if (typeof id !== 'string' || !idPattern.test(id)) throw new ApiError(502, 'DeepSeek Harness did not name the new session.');
    this.turning.set(id, 'running');
    this.known.add(id);
    this.fresh.set(id, Date.now());
    this.state.put(agent, id, { name: limitText(message.split('\n')[0], 110), status: this.statusOf(id), updatedAt: Date.now(),
      cwd: limitText(cwd ?? '', 500), live: true, capabilities: ['history', 'send', 'interrupt'] });
    this.listedAt = 0;
    await this.discover().catch(() => {});
    return { id };
  }

  async control(id, action) {
    if (action !== 'interrupt') throw new ApiError(409, 'DeepSeek Harness sessions take messages and interrupts only.');
    await this.call('POST', '/cancel', { id });
    return { ok: true };
  }
}
