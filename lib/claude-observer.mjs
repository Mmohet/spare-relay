import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { readdir, readFile, open, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { join } from 'node:path';
import { requestDetails } from './claude-cli.mjs';
import { ApiError, limitText, plainText } from './state.mjs';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const recentLimit = 20; // Closed sessions listed besides the running ones.
const recentAge = 14 * 86400000;
const scanEvery = 15000;
// What each Claude Code hook says about the turn. Stop and StopFailure end it; the tool events mean it goes on.
const hookStatus = { UserPromptSubmit: 'running', PreToolUse: 'running', PostToolUse: 'running', PostToolUseFailure: 'running',
  PermissionDenied: 'running', Stop: 'idle', StopFailure: 'failed' };
// Plan approval stays in Claude's own window.
const askedThere = new Set(['ExitPlanMode']);
const askLimit = 590000; // just under the hook timeout written into Claude's settings

/** Tool call of a Claude transcript in the shape `toolLine` in spare.mjs reads. */
export function claudeTool(part) {
  const name = String(part?.name ?? '');
  const input = part?.input ?? {};
  if (name === 'Bash') return { type: 'commandExecution', command: limitText(input.command, 2000) };
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) return { type: 'fileChange', files: 1, path: input.file_path ?? input.notebook_path };
  if (name === 'WebSearch') return { type: 'webSearch', query: limitText(input.query, 300) };
  if (['Task', 'Agent'].includes(name)) return { type: 'collabAgentToolCall' };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return { type: 'mcpToolCall', server: mcp[1], tool: mcp[2] };
  // What the tool works on, for the glasses' "what it is doing" line: a file name, a pattern, an address.
  const file = String(input.file_path ?? input.path ?? '').split('/').filter(Boolean).at(-1);
  const detail = ['Grep', 'Glob'].includes(name) ? input.pattern : file || input.url || input.skill || input.query;
  return { type: 'dynamicToolCall', tool: name, detail: limitText(detail ?? '', 200) };
}

async function readSlice(path, start, length) {
  const file = await open(path).catch(() => null);
  if (!file) return '';
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
}

function lines(text, partial) {
  return text.split('\n').slice(partial ? 1 : 0).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

/** Claude's AskUserQuestion input as question cards (1–4 questions), or null when it has none to show. */
function questionsOf(tool) {
  const questions = (Array.isArray(tool.questions) ? tool.questions : []).slice(0, 4).map((question, index) => ({
    id: 'q' + (index + 1), original: String(question?.question ?? ''), title: limitText(question?.header, 160),
    text: limitText(question?.question, 500), multiple: Boolean(question?.multiSelect),
    options: (Array.isArray(question?.options) ? question.options : []).map((option) => limitText(option?.label, 160)).filter(Boolean),
  }));
  return questions.length && questions.every((question) => question.original.trim()) ? questions : null;
}

/** Which tool call a hook is about; PermissionRequest has no tool_use_id, so name and input stand in. */
function toolSign(input) {
  const name = String(input?.tool_name ?? '');
  // A question's tool input gains the answers once it is answered, so only the questions identify it.
  const tool = name === 'AskUserQuestion' ? input?.tool_input?.questions : input?.tool_input;
  return name + '\n' + JSON.stringify(tool ?? {});
}

/**
 * Claude Code sessions on this Mac. Running sessions come from `~/.claude/sessions`. A second
 * writer would fork the conversation the open window is showing, so a running session takes
 * messages only through its own inbox (the local socket Claude Code sessions use to message
 * each other); without one it stays read-only. Recently closed sessions come from the
 * transcripts and can be continued by `ClaudeCli` when it is configured (`control`).
 */
export class ClaudeObserver {
  constructor(state, root, bridge, control = null) {
    this.state = state;
    this.root = root;
    this.bridge = bridge;
    this.control = control;
    this.paths = new Map();
    this.live = new Set();
    this.inboxes = new Map(); // running session id -> { pid, sock }
    this.recent = new Map(); // session id -> { mtime, meta }
    this.scannedAt = 0;
    this.watchers = [];
    this.hooked = new Map(); // session id -> { status, at } from Claude Code's hooks
    this.reported = new Map(); // running session id -> { status, at } from the registry
    this.asking = new Map(); // panel request id -> { session, sign, drop } for prompts waiting in a hook
  }

  /**
   * Claude Code's hooks report each turn of every session on this Mac as it happens, which the registry
   * cannot: it only says busy or idle. A permission prompt becomes a card on the panel and the glasses
   * while the same prompt shows in Claude's window; whichever answers first applies. `closed` settles when
   * Claude Code stops waiting for this hook, which removes the card. Resolves with the hook's JSON reply.
   */
  async hook(input, closed = new Promise(() => {})) {
    const id = input?.session_id;
    const event = String(input?.hook_event_name ?? '');
    if (!uuid.test(id ?? '')) throw new ApiError(400, 'Invalid Claude session.');
    // Sessions Relay runs or bridges get their prompts through their own connection.
    if (this.bridge.leases.has(id) || this.control?.active.has(id)) return {};
    if (event === 'PermissionRequest') return this.permission(id, input, closed);
    if (event === 'SessionEnd') {
      this.settle(id);
      this.hooked.delete(id);
      return {};
    }
    const status = hookStatus[event];
    if (!status) return {};
    // A PreToolUse hook (optional) says which tool starts; a turn that starts or ends has none.
    if (event === 'PreToolUse') this.state.transient('action', 'claude', id, { tool: claudeTool({ name: input.tool_name, input: input.tool_input }) });
    else if (status !== 'running' || event === 'UserPromptSubmit') this.state.transient('action', 'claude', id, { tool: null });
    // A tool that ran was answered, here or in Claude's window; a turn that ended leaves nothing waiting.
    this.settle(id, status === 'running' && event !== 'UserPromptSubmit' ? toolSign(input) : null);
    this.hooked.set(id, { status, at: Date.now() });
    this.apply(id);
    return {};
  }

  permission(id, input, closed) {
    const name = String(input.tool_name ?? '');
    if (askedThere.has(name)) return {};
    const tool = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
    if (name === 'AskUserQuestion' && !questionsOf(tool)) return {};
    return new Promise((resolve) => {
      let request = null;
      let gone = false;
      const finish = () => {
        if (!this.asking.delete(request)) return;
        this.state.clearRequest(request);
        this.apply(id);
        resolve({});
      };
      const asked = name === 'AskUserQuestion' ? questionsOf(tool) : null;
      const details = asked ? { kind: 'input', title: 'Claude needs an answer', description: asked[0].text,
        cwd: limitText(input.cwd, 500), questions: asked.map(({ original, ...question }) => question) }
        : requestDetails({ tool_name: name, input: tool, description: tool.description }, input.cwd);
      request = this.state.addRequest('claude', id, details, (decision) => {
        // A question is answered with the chosen label or your own words; Claude reads them keyed by question text.
        const answers = asked && Object.fromEntries(asked.map((question) => {
          const given = decision.answers?.[question.id];
          const value = limitText(Array.isArray(given) ? given.join(', ') : given, 1000).trim();
          if (!value) throw new ApiError(400, 'Answer each question.');
          return [question.original, value];
        }));
        if (!asked && !['accept', 'decline'].includes(decision.decision)) throw new ApiError(400, 'Select a decision.');
        if (gone || !this.asking.delete(request)) throw new ApiError(409, 'This was already answered on the computer.');
        this.hooked.set(id, { status: 'running', at: Date.now() });
        this.apply(id);
        resolve({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: asked
          ? { behavior: 'allow', updatedInput: { ...tool, answers } }
          : decision.decision === 'accept' ? { behavior: 'allow' } : { behavior: 'deny', message: 'Declined from Relay.' } } });
      });
      this.asking.set(request, { session: id, sign: toolSign(input), drop: finish });
      const timer = setTimeout(finish, askLimit);
      timer.unref?.();
      closed.then(() => { gone = true; clearTimeout(timer); finish(); });
      this.apply(id);
    });
  }

  /** Drop the cards of a session's waiting prompts: all of them, or the one for this tool call. */
  settle(id, sign = null) {
    for (const ask of [...this.asking.values()]) if (ask.session === id && (!sign || ask.sign === sign)) ask.drop();
  }

  /** A running session's status: a waiting prompt first, then whichever of the hooks and the registry spoke last. */
  statusOf(id) {
    if ([...this.asking.values()].some((ask) => ask.session === id)) return 'approval';
    const reported = this.reported.get(id);
    const hooked = this.hooked.get(id);
    // The registry writes its idle a moment after the Stop hook; only a clearly later change wins.
    if (hooked && (!reported || hooked.at + 1500 >= reported.at)) return hooked.status;
    return reported?.status ?? 'unknown';
  }

  apply(id) {
    const known = this.state.sessions.get('claude:' + id);
    if (!known?.live || this.bridge.leases.has(id) || this.control?.active.has(id)) return;
    this.state.put('claude', id, { status: this.statusOf(id), updatedAt: Math.max(known.updatedAt ?? 0, Date.now()) });
  }

  isLive(id) { return this.live.has(id); }

  /**
   * Look again (`changed`, normally `discover`) soon after a session starts, stops or writes to its
   * transcript, so a new session is seen in well under the polling interval.
   */
  watch(changed = () => this.discover()) {
    let timer = null;
    let running = null;
    let again = false;
    const run = () => {
      if (running) { again = true; return; }
      running = Promise.resolve().then(changed).catch(() => {}).finally(() => {
        running = null;
        if (again) { again = false; soon(); }
      });
    };
    const soon = () => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; run(); }, 300);
      timer.unref?.();
    };
    for (const [path, recursive] of [[join(this.root, 'sessions'), false], [join(this.root, 'projects'), true]]) {
      try {
        const watcher = watch(path, { recursive, persistent: false }, soon);
        watcher.on('error', () => watcher.close());
        this.watchers.push(watcher);
      } catch { /* Polling still finds every session. */ }
    }
  }

  close() { for (const watcher of this.watchers.splice(0)) watcher.close(); }

  /** The newest of the registry's status time and the transcript's last write. */
  async activity(id, reported) {
    const path = this.paths.get(id) ?? await this.locate(id);
    const info = path ? await stat(path).catch(() => null) : null;
    return Math.max(reported, Math.round(info?.mtimeMs ?? 0));
  }

  async locate(id) {
    for (const directory of await readdir(join(this.root, 'projects')).catch(() => [])) {
      const candidate = join(this.root, 'projects', directory, id + '.jsonl');
      if (await stat(candidate).catch(() => null)) {
        this.paths.set(id, candidate);
        return candidate;
      }
    }
    return null;
  }

  /**
   * Put a message in a running session's inbox. Claude Code queues it after the current turn
   * (`priority: next`) and shows it as a message from another session on the user's behalf.
   */
  async sendPeer(id, text, commandId = randomUUID()) {
    const inbox = this.inboxes.get(id);
    if (!inbox) throw new ApiError(409, 'This session is open on the computer. Reply there.');
    const directory = join(this.root, 'sessions');
    const keys = (await readdir(directory).catch(() => [])).filter((name) => new RegExp('^' + inbox.pid + '\\.[0-9a-f]{64}\\.key$').test(name));
    const key = keys.length === 1 ? await readFile(join(directory, keys[0]), 'utf8').then(JSON.parse).catch(() => null) : null;
    if (!/^[0-9a-f]{32}$/.test(key?.peerToken ?? '')) throw new ApiError(409, 'This session does not take messages from outside.');
    const lines = JSON.stringify({ type: 'auth', token: key.peerToken }) + '\n' + JSON.stringify({
      msgV: 1, msg_id: randomUUID(), type: 'user', message: { role: 'user', content: text }, priority: 'next',
    }) + '\n';
    await new Promise((resolve, reject) => {
      const socket = connect({ path: inbox.sock });
      socket.setTimeout(5000, () => { socket.destroy(); reject(new ApiError(503, 'The session did not take the message.')); });
      socket.on('error', () => reject(new ApiError(503, 'The session did not take the message.')));
      socket.on('connect', () => socket.write(lines, () => setTimeout(() => socket.end(), 150)));
      socket.on('close', (failed) => (failed ? null : resolve()));
    });
    return { commandId };
  }

  async discover() {
    const directory = join(this.root, 'sessions');
    const files = await readdir(directory).catch(() => []);
    const seen = new Set();
    const inboxes = new Map();
    for (const name of files.filter((file) => /^\d+\.json$/.test(file))) {
      const entry = await readFile(join(directory, name), 'utf8').then(JSON.parse).catch(() => null);
      if (!uuid.test(entry?.sessionId ?? '') || String(entry.pid) + '.json' !== name) continue;
      let observed = 'unknown';
      try {
        process.kill(entry.pid, 0);
        observed = ({ busy: 'running', idle: 'idle' })[entry.status] ?? 'unknown';
      } catch (error) {
        if (error.code === 'ESRCH') continue;
      }
      const id = entry.sessionId;
      seen.add(id);
      const inbox = typeof entry.messagingSocketPath === 'string' && entry.messagingSocketPath.startsWith('/')
        && Number(entry.peerProtocol) >= 1 ? { pid: entry.pid, sock: entry.messagingSocketPath } : null;
      if (inbox) inboxes.set(id, inbox);
      this.reported.set(id, { status: observed, at: Number(entry.statusUpdatedAt ?? entry.startedAt) || 0 });
      if (this.bridge.leases.has(id) || this.control?.active.has(id)) continue;
      this.state.put('claude', id, {
        name: limitText(entry.name, 110) || 'Claude Code session',
        cwd: limitText(entry.cwd, 500), status: this.statusOf(id), reportedStatus: limitText(entry.status, 60),
        updatedAt: await this.activity(id, Number(entry.statusUpdatedAt ?? entry.startedAt) || 0),
        capabilities: inbox && this.control ? ['history', 'send'] : ['history'], live: true,
      });
    }
    this.live = seen;
    this.inboxes = inboxes;
    for (const id of this.reported.keys()) if (!seen.has(id)) this.reported.delete(id);
    // A hook can arrive before the registry lists a new session, so only old reports of gone sessions go.
    for (const [id, hooked] of this.hooked) if (!seen.has(id) && Date.now() - hooked.at > 60000) this.hooked.delete(id);
    if (Date.now() - this.scannedAt >= scanEvery) {
      this.scannedAt = Date.now();
      await this.scan().catch(() => {});
    }
    for (const [id, { meta }] of this.recent) {
      if (seen.has(id) || this.bridge.leases.has(id) || this.control?.active.has(id)) continue;
      this.state.put('claude', id, { ...meta, status: 'idle', live: false,
        capabilities: this.control ? ['history', 'send'] : ['history'] });
    }
    for (const row of this.state.sessions.values()) {
      if (row.agent !== 'claude' || seen.has(row.id) || this.recent.has(row.id)) continue;
      if (this.bridge.leases.has(row.id) || this.control?.active.has(row.id)) continue;
      this.state.put('claude', row.id, { status: 'offline', capabilities: ['history'], live: false });
    }
    if (!this.bridge.leases.size) this.state.connection('claude', seen.size || this.recent.size ? 'observing' : 'offline');
  }

  /** The newest closed transcripts, with name, folder and model read once per change. */
  async scan() {
    const base = join(this.root, 'projects');
    const candidates = [];
    for (const directory of await readdir(base).catch(() => [])) {
      for (const name of await readdir(join(base, directory)).catch(() => [])) {
        if (!name.endsWith('.jsonl') || !uuid.test(name.slice(0, -6))) continue;
        const path = join(base, directory, name);
        const info = await stat(path).catch(() => null);
        if (info && Date.now() - info.mtimeMs < recentAge) candidates.push({ id: name.slice(0, -6), path, mtime: info.mtimeMs, size: info.size });
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const next = new Map();
    for (const candidate of candidates) {
      if (next.size >= recentLimit) break;
      if (this.live.has(candidate.id)) continue;
      this.paths.set(candidate.id, candidate.path);
      const cached = this.recent.get(candidate.id);
      const meta = cached?.mtime === candidate.mtime ? cached.meta : await this.describe(candidate);
      if (meta) next.set(candidate.id, { mtime: candidate.mtime, meta });
    }
    this.recent = next;
  }

  async describe({ path, mtime, size }) {
    const head = lines(await readSlice(path, 0, 65536), false);
    const tailStart = Math.max(0, size - 262144);
    const tail = tailStart ? lines(await readSlice(path, tailStart, 262144), true) : head;
    const rows = [...head, ...tail];
    const cwd = rows.find((row) => typeof row.cwd === 'string')?.cwd;
    if (!cwd || rows.every((row) => !['user', 'assistant'].includes(row.type))) return null;
    if (!(await stat(cwd).then((info) => info.isDirectory()).catch(() => false))) return null;
    const title = rows.findLast((row) => row.type === 'custom-title')?.customTitle
      ?? rows.findLast((row) => row.type === 'agent-name')?.agentName
      ?? plainText(head.find((row) => row.type === 'user' && !row.isMeta && !row.isSidechain)?.message?.content).split('\n')[0];
    const assistant = tail.findLast((row) => row.type === 'assistant' && row.message?.model);
    return {
      name: limitText(title, 110) || 'Claude Code session', cwd: limitText(cwd, 500), updatedAt: Math.round(mtime),
      ...(assistant ? { model: assistant.message.model, effort: assistant.effort ?? null } : {}),
    };
  }

  async history(id, { tools = false } = {}) {
    const messages = new Map();
    const path = this.paths.get(id) ?? await this.locate(id);
    const info = path ? await stat(path).catch(() => null) : null;
    if (info) {
      const length = Math.min(info.size, 4 * 1024 * 1024);
      let model;
      for (const row of lines(await readSlice(path, info.size - length, length), length < info.size)) {
        if (row.isSidechain || row.isMeta || !['user', 'assistant'].includes(row.type) || !row.uuid) continue;
        const at = Date.parse(row.timestamp);
        const content = row.message?.content;
        if (row.type === 'assistant' && row.message?.model) model = { model: row.message.model, effort: row.effort ?? null };
        if (tools && row.type === 'assistant' && Array.isArray(content)) {
          content.filter((part) => part?.type === 'tool_use').forEach((part, index) => {
            messages.set(row.uuid + ':t' + index, { id: row.uuid + ':t' + index, role: 'tool', tool: claudeTool(part), at });
          });
        }
        const text = limitText(plainText(content));
        if (text) messages.set(row.uuid, { id: row.uuid, text, role: row.type, at });
      }
      // The lens header shows the model; keep it on the session row.
      if (model && this.state.sessions.has('claude:' + id)) this.state.put('claude', id, model);
    }
    for (const message of this.bridge.history(id)) messages.set(message.id, message);
    return [...messages.values()].slice(tools ? -120 : -80);
  }
}
