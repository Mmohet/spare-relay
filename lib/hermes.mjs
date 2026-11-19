import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ApiError, limitText } from './state.mjs';

const agent = 'hermes';
// Sessions you opened yourself; subagents, cron jobs, kanban workers and webhooks are Hermes's own.
const userSources = ['local', 'desktop', 'cli', 'tui', 'webui', 'acp', 'oneshot'];
const recentLimit = 20; // idle sessions listed besides the running ones, as for DeepSeek
const historyFresh = 3000;
const freshFor = 60000; // how long a session started here may be missing from Hermes's database
const askLimit = 600000; // an unanswered card gives up after ten minutes: approval denied, question skipped
const idPattern = /^[A-Za-z0-9_.:-]{1,200}$/;
const fileTools = new Set(['patch', 'write_file', 'edit_file']);
const capabilities = ['history', 'send', 'interrupt'];

function argsOf(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const baseName = (path) => String(path ?? '').split('/').filter(Boolean).at(-1) ?? '';

/** A Hermes tool call in the gateway's shape (the one the other agents' rows use), for the lens's action line. */
export function hermesTool(name, argsText) {
  const args = argsOf(argsText);
  const path = args.path ?? args.file_path ?? args.filePath;
  if (name === 'terminal') return { type: 'commandExecution', command: limitText(String(args.command ?? ''), 2000) };
  if (fileTools.has(name)) return { type: 'fileChange', files: 1, path: limitText(String(path ?? ''), 500) };
  if (name === 'web_search') return { type: 'webSearch', query: limitText(String(args.query ?? ''), 300) };
  const detail = baseName(path) || args.pattern || args.url || args.query || args.name;
  return { type: 'dynamicToolCall', tool: limitText(String(name ?? ''), 200), detail: limitText(String(detail ?? ''), 200) };
}

/**
 * Hermes Agent: sessions and history are read from its database (`~/.hermes/state.db`, read-only); speaking,
 * new sessions, interrupts, approvals and its clarify questions go through one long-lived `hermes acp`
 * (the Agent Client Protocol editors use), started the first time it is needed.
 */
export class HermesAcp {
  constructor(state, { home, command = 'hermes', args = ['acp'], env = process.env, cwd } = {}) {
    this.state = state;
    this.agent = agent;
    this.home = home;
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd || env.HOME || '/';
    this.db = null;
    this.known = new Set();
    this.fresh = new Map(); // session id -> when it was started here
    this.leased = new Set(); // sessions Hermes itself is running (a live turn lease)
    this.histories = new Map(); // session id -> { at, rows }
    this.turning = new Map(); // session id -> 'running' | 'idle' | 'failed', for turns started here
    this.queue = new Map(); // session id -> texts waiting for the running turn to end
    this.asking = new Map(); // panel request id -> { session, settle }
    this.child = null;
    this.ready = null;
    this.pending = new Map(); // JSON-RPC id -> { resolve, reject }
    this.loaded = new Set(); // sessions loaded into the running hermes acp
    this.loading = new Set(); // their replayed history is not news
    this.nextId = 1;
  }

  /* ---------- the database ---------- */

  open() {
    if (this.db) return this.db;
    const path = join(this.home, 'state.db');
    if (!existsSync(path)) return null;
    this.db = new DatabaseSync(path, { readOnly: true });
    return this.db;
  }

  query(sql, ...params) {
    const db = this.open();
    if (!db) return null;
    try {
      return db.prepare(sql).all(...params);
    } catch (error) {
      try { db.close(); } catch {}
      this.db = null; // a newer Hermes may have moved things; open again next time
      throw error;
    }
  }

  statusOf(id) {
    if ([...this.asking.values()].some((ask) => ask.session === id)) return 'approval';
    if (this.turning.get(id) === 'running') return 'running';
    if (this.leased.has(id)) return 'running';
    return this.turning.get(id) ?? 'idle';
  }

  apply(id, update = {}) {
    if (this.state.sessions.has(agent + ':' + id)) this.state.put(agent, id, { ...update, status: this.statusOf(id) });
  }

  async discover() {
    let rows;
    let leases;
    try {
      rows = this.query(`SELECT id, title, display_name AS shown, cwd, COALESCE(last_activity_at, started_at) AS at
        FROM sessions WHERE parent_session_id IS NULL AND archived = 0 AND hidden = 0
        AND source IN (${userSources.map(() => '?').join(', ')}) ORDER BY at DESC LIMIT 200`, ...userSources);
      leases = rows && this.query('SELECT conversation_id AS id FROM session_turn_leases WHERE expires_at > ?', Date.now() / 1000);
    } catch {
      this.state.connection(agent, 'offline');
      return;
    }
    if (!rows) {
      if (!this.state.online.has(agent)) this.state.connection(agent, 'unconfigured');
      return;
    }
    this.state.connection(agent, 'connected');
    this.leased = new Set(leases.map((row) => row.id));
    const usable = rows.filter((row) => idPattern.test(row.id));
    const busy = (row) => this.leased.has(row.id) || this.turning.get(row.id) === 'running';
    const shown = [...usable.filter(busy), ...usable.filter((row) => !busy(row)).slice(0, recentLimit)];
    const seen = new Set();
    for (const row of shown) {
      seen.add(row.id);
      this.known.add(row.id);
      const previous = this.state.sessions.get(agent + ':' + row.id);
      const updatedAt = Math.max(Math.round(Number(row.at) * 1000) || 0, previous?.updatedAt ?? 0);
      if (previous && updatedAt > previous.updatedAt) this.histories.delete(row.id);
      this.state.put(agent, row.id, {
        name: limitText(row.title || row.shown || '', 110) || '对话', status: this.statusOf(row.id), updatedAt,
        cwd: limitText(row.cwd ?? '', 500), live: true, capabilities,
      });
    }
    for (const id of [...this.known]) {
      if (seen.has(id)) { this.fresh.delete(id); continue; }
      if (Date.now() - (this.fresh.get(id) ?? 0) < freshFor || this.turning.get(id) === 'running') continue;
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
      const messages = this.query(`SELECT id, role, content, tool_calls AS calls, timestamp AS at FROM messages
        WHERE session_id = ? AND active = 1 AND role IN ('user', 'assistant') AND COALESCE(display_kind, '') <> 'hidden'
        ORDER BY timestamp DESC, id DESC LIMIT 400`, id);
      if (!messages) throw new ApiError(503, 'Hermes Agent is not set up on this Mac.');
      rows = [];
      for (const message of messages.reverse()) {
        const at = Math.round(Number(message.at) * 1000) || 0;
        if (message.role === 'assistant' && message.calls) {
          const calls = (() => { try { return JSON.parse(message.calls); } catch { return []; } })();
          for (const [index, call] of (Array.isArray(calls) ? calls : []).entries()) {
            rows.push({ id: 'c' + message.id + '-' + index, role: 'tool', at,
              tool: hermesTool(call?.function?.name ?? call?.name, call?.function?.arguments ?? call?.arguments) });
          }
        }
        const text = typeof message.content === 'string' ? message.content : '';
        if (text.trim()) rows.push({ id: 'm' + message.id, role: message.role, text: limitText(text), at });
      }
      this.histories.set(id, { at: Date.now(), rows });
    }
    return (tools ? rows : rows.filter((row) => row.role !== 'tool')).slice(tools ? -120 : -80);
  }

  /* ---------- hermes acp ---------- */

  ensure() {
    if (this.ready) return this.ready;
    const child = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'ignore'], env: this.env });
    this.child = child;
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        this.receive(message);
      }
    });
    child.stdin.on('error', () => {});
    const gone = () => this.lost(child);
    child.on('exit', gone);
    child.on('error', gone);
    this.ready = this.request('initialize', {
      protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }).catch((error) => {
      this.lost(child);
      throw new ApiError(502, 'Hermes Agent did not start: ' + limitText(String(error.message ?? error), 100));
    });
    return this.ready;
  }

  /** hermes acp exited: its turns failed, its cards are gone, and the next message starts it again. */
  lost(child) {
    if (this.child !== child) return;
    this.child = null;
    this.ready = null;
    this.loaded.clear();
    this.loading.clear();
    for (const { reject } of this.pending.values()) reject(new Error('hermes acp exited'));
    this.pending.clear();
    for (const [request, ask] of [...this.asking]) {
      this.asking.delete(request);
      this.state.clearRequest(request);
      ask.stop();
    }
  }

  close() {
    const child = this.child;
    this.lost(child);
    child?.kill();
    try { this.db?.close(); } catch {}
    this.db = null;
  }

  write(message) {
    this.child?.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (!this.child) { reject(new Error('hermes acp is not running')); return; }
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  receive(message) {
    if (message.method && message.id !== undefined) { this.serve(message); return; }
    if (message.method === 'session/update') { this.update(message.params ?? {}); return; }
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    if (message.error) waiting.reject(new Error(String(message.error.message ?? 'error')));
    else waiting.resolve(message.result ?? {});
  }

  /** What hermes acp asks of us: only permission (approvals and clarify questions); fs and terminal are declined. */
  serve({ id, method, params }) {
    if (method !== 'session/request_permission') {
      this.write({ id, error: { code: -32601, message: 'Not supported by Relay.' } });
      return;
    }
    this.permission(id, params ?? {});
  }

  update({ sessionId: id, update }) {
    if (!id || this.loading.has(id) || !update) return;
    if (update.sessionUpdate === 'tool_call') {
      const input = argsOf(update.rawInput);
      const name = update.kind === 'execute' && input.command ? 'terminal' : update.kind === 'edit' ? 'patch' : String(update.title ?? '');
      this.state.transient('action', agent, id, { tool: hermesTool(name, input) });
    } else if (update.sessionUpdate === 'agent_message_chunk') {
      this.histories.delete(id);
    }
  }

  permission(rpcId, { sessionId: id, toolCall = {}, options = [] }) {
    const offered = Array.isArray(options) ? options.filter((option) => option?.optionId) : [];
    const cwd = this.state.sessions.get(agent + ':' + id)?.cwd ?? '';
    const pick = (optionId) => ({ outcome: { outcome: 'selected', optionId } });
    let details;
    let answer;
    if (String(toolCall.toolCallId ?? '').startsWith('clarify-')) {
      const choices = offered.filter((option) => option.kind === 'allow_once');
      details = { kind: 'input', title: 'Hermes needs an answer', description: limitText(String(toolCall.title ?? ''), 500),
        cwd: limitText(cwd, 500), spoken: false,
        questions: [{ id: 'q1', title: '', text: limitText(String(toolCall.title ?? ''), 500), multiple: false,
          options: choices.map((option) => limitText(String(option.name ?? ''), 160)) }] };
      answer = (decision) => {
        const given = decision.answers?.q1;
        const value = Array.isArray(given) ? given[0] : given;
        const choice = choices.find((option) => option.name === value);
        if (!choice) throw new ApiError(400, 'Pick one of Hermes\'s options.');
        return pick(choice.optionId);
      };
    } else {
      const input = argsOf(toolCall.rawInput);
      const command = String(input.command ?? input.path ?? input.file_path ?? '');
      const find = (kind) => offered.find((option) => option.kind === kind);
      const session = offered.find((option) => option.optionId === 'allow_session') ?? find('allow_always');
      details = { kind: 'approval',
        title: toolCall.kind === 'execute' ? 'Run a command' : toolCall.kind === 'edit' ? 'Modify files' : 'Tool approval',
        description: limitText(String(toolCall.title ?? ''), 500), command: limitText(command || String(toolCall.title ?? ''), 10000),
        cwd: limitText(cwd, 500), tool: limitText(String(toolCall.kind ?? ''), 200),
        approvalAllowed: Boolean(find('allow_once')), sessionAllowed: Boolean(session) };
      answer = (decision) => {
        const chosen = { accept: find('allow_once'), acceptForSession: session, decline: find('reject_once') }[decision.decision];
        if (!chosen) throw new ApiError(400, 'Select a decision.');
        return pick(chosen.optionId);
      };
    }
    let request = null;
    const finish = (result) => {
      if (!this.asking.delete(request)) return;
      clearTimeout(timer);
      this.state.clearRequest(request);
      this.write({ id: rpcId, result });
      this.apply(id);
    };
    request = this.state.addRequest(agent, id, details, (decision) => finish(answer(decision)));
    const timer = setTimeout(() => finish({ outcome: { outcome: 'cancelled' } }), askLimit);
    timer.unref?.();
    this.asking.set(request, { session: id, stop: () => clearTimeout(timer) });
    this.apply(id);
  }

  /** The turn's cards whose question went away with it. */
  settle(id) {
    for (const [request, ask] of [...this.asking]) {
      if (ask.session !== id) continue;
      this.asking.delete(request);
      this.state.clearRequest(request);
      ask.stop();
    }
  }

  async load(id) {
    if (this.loaded.has(id)) return;
    this.loading.add(id);
    try {
      const cwd = this.state.sessions.get(agent + ':' + id)?.cwd || this.cwd;
      await this.request('session/load', { sessionId: id, cwd, mcpServers: [] });
      this.loaded.add(id);
    } finally {
      this.loading.delete(id);
    }
  }

  /** Start a turn now; it runs in the background and the next queued message follows it. */
  async begin(id, text) {
    this.turning.set(id, 'running');
    this.histories.delete(id);
    this.apply(id, { updatedAt: Date.now() });
    try {
      await this.ensure();
      await this.load(id);
    } catch (error) {
      this.turning.set(id, 'failed');
      this.apply(id);
      throw error instanceof ApiError ? error : new ApiError(502, 'Hermes Agent could not open this session.');
    }
    this.request('session/prompt', { sessionId: id, prompt: [{ type: 'text', text }] })
      .then(() => 'idle', () => 'failed')
      .then((status) => {
        this.turning.set(id, status);
        this.settle(id);
        this.histories.delete(id);
        this.state.event('activity', agent, id);
        this.apply(id, { updatedAt: Date.now() });
        const next = status === 'idle' ? this.queue.get(id)?.shift() : null;
        if (status !== 'idle') this.queue.delete(id);
        if (next !== undefined && next !== null) this.begin(id, next).catch(() => {});
      });
  }

  /** Into the session now, or after the running turn (Hermes takes one prompt at a time). */
  async send(id, text, commandId = randomUUID()) {
    const message = limitText(String(text ?? ''), 12000);
    if (!message.trim()) throw new ApiError(400, 'Say something.');
    if (!idPattern.test(id)) throw new ApiError(400, 'Invalid Hermes session.');
    if (this.turning.get(id) === 'running') {
      this.queue.set(id, [...(this.queue.get(id) ?? []), message]);
      return { commandId };
    }
    await this.begin(id, message);
    return { commandId };
  }

  async create(text, { cwd } = {}) {
    const message = limitText(String(text ?? ''), 12000);
    if (!message.trim()) throw new ApiError(400, 'Say something to start the session with.');
    await this.ensure();
    const folder = cwd || this.cwd;
    const { sessionId: id } = await this.request('session/new', { cwd: folder, mcpServers: [] })
      .catch(() => { throw new ApiError(502, 'Hermes Agent did not start a session.'); });
    if (typeof id !== 'string' || !idPattern.test(id)) throw new ApiError(502, 'Hermes Agent did not name the new session.');
    this.loaded.add(id);
    this.known.add(id);
    this.fresh.set(id, Date.now());
    this.state.put(agent, id, { name: limitText(message.split('\n')[0], 110), status: 'running', updatedAt: Date.now(),
      cwd: limitText(folder, 500), live: true, capabilities });
    await this.begin(id, message);
    return { id };
  }

  async control(id, action) {
    if (action !== 'interrupt') throw new ApiError(409, 'Hermes Agent sessions take messages and interrupts only.');
    this.queue.delete(id);
    if (this.child && this.turning.get(id) === 'running') this.write({ method: 'session/cancel', params: { sessionId: id } });
    return { ok: true };
  }
}
