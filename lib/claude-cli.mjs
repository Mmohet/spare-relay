import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { ApiError, limitText } from './state.mjs';

const agent = 'claude';
const turnLimit = 30 * 60000;
const fileTools = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Print mode with the Agent SDK's stdio protocol: user turns go in as JSON lines,
// and every permission prompt comes back to us as a `can_use_tool` control request.
const protocol = ['--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
  '--permission-prompt-tool', 'stdio'];

export function requestDetails(request, cwd) {
  const input = request.input ?? {};
  const name = String(request.tool_name ?? '');
  const command = name === 'Bash' ? input.command : fileTools.has(name) ? input.file_path ?? input.notebook_path : '';
  return {
    kind: 'approval',
    title: name === 'Bash' ? 'Run a command' : fileTools.has(name) ? 'Modify files' : 'Tool approval',
    description: limitText(request.description || request.title || request.display_name || name, 500),
    command: limitText(command, 10000), cwd: limitText(cwd, 500), tool: limitText(name, 200),
    approvalAllowed: true,
  };
}

/**
 * Continues closed Claude Code sessions and starts new ones by running `claude -p`
 * in the session's folder. Running sessions belong to their open window: messages go
 * to its inbox, or are refused when it has none (see ClaudeObserver).
 */
export class ClaudeCli {
  constructor(state, { binary = 'claude', configDir = null, bridge, observer = null, spawn = nodeSpawn } = {}) {
    this.state = state;
    this.agent = agent;
    this.binary = binary;
    // Only an explicit config folder is passed on: setting it, even to ~/.claude, makes
    // Claude Code look for a different keychain login.
    this.configDir = configDir;
    this.bridge = bridge;
    this.observer = observer;
    this.spawn = spawn;
    this.active = new Map(); // session id -> run
  }

  async send(id, text, commandId = randomUUID()) {
    if (this.bridge?.leases.has(id)) return this.bridge.send(id, text, commandId);
    // A session open on the computer takes messages only in its own inbox, after its current turn.
    if (this.observer?.isLive(id)) return this.observer.sendPeer(id, text, commandId);
    if (this.active.has(id)) throw new ApiError(409, 'This session is already working.');
    const row = this.state.get(agent, id);
    if (!(await stat(row.cwd ?? '').then((info) => info.isDirectory()).catch(() => false))) {
      throw new ApiError(409, 'The folder of this session is gone.');
    }
    const run = this.start(['-p', '--resume', id, ...protocol], row.cwd, text, commandId, id);
    await run.started;
    return { commandId };
  }

  /** Interrupts only reach sessions that a Claude bridge still holds. */
  control(id, action, text, turnId) {
    if (!this.bridge?.leases.has(id)) throw new ApiError(409, 'This session does not support ' + action + '.');
    return this.bridge.control(id, action, text, turnId);
  }

  /** Start a session in `cwd`, or the folder of the most recent Claude session, and send it the first message. */
  async create(text, { cwd } = {}) {
    const recent = [...this.state.sessions.values()].filter((row) => row.agent === agent && row.cwd)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0];
    const folder = cwd ?? recent?.cwd;
    if (!folder) throw new ApiError(409, 'Open a Claude Code session on the computer first.');
    const commandId = randomUUID();
    const run = this.start(['-p', ...protocol], folder, text, commandId, null, limitText(text.split('\n')[0], 110));
    const id = await run.started;
    return { id, commandId };
  }

  start(args, cwd, text, commandId, knownId, name) {
    const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'USER', 'SHELL', 'TMPDIR']
      .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
    if (this.configDir) env.CLAUDE_CONFIG_DIR = this.configDir;
    const child = this.spawn(this.binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const run = { child, id: knownId, commandId, requests: new Map(), reply: '', done: false };
    let resolveStart;
    let rejectStart;
    run.started = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
    const write = (message) => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify(message) + '\n'); };
    const attach = (id) => {
      run.id = id;
      this.active.set(id, run);
      this.state.put(agent, id, { status: 'running', updatedAt: Date.now(), cwd: limitText(cwd, 500), live: false,
        capabilities: ['history', 'send'], ...(name ? { name } : {}) });
      resolveStart(id);
    };
    if (knownId) attach(knownId);
    const timer = setTimeout(() => child.kill('SIGTERM'), turnLimit);
    child.stdin.on('error', () => {});
    child.stderr.resume();
    child.on('error', () => rejectStart(new ApiError(503, 'Claude Code could not be started.')));

    createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.type === 'system' && message.subtype === 'init') {
        if (!run.id && typeof message.session_id === 'string') attach(message.session_id);
        if (run.id && message.model) this.state.put(agent, run.id, { model: message.model });
        return;
      }
      if (message.type === 'assistant') {
        const parts = Array.isArray(message.message?.content) ? message.message.content : [];
        const said = parts.filter((part) => part?.type === 'text').map((part) => part.text).join('\n');
        if (said.trim()) run.reply = said;
        if (run.id) this.state.event('activity', agent, run.id);
        return;
      }
      if (message.type === 'control_request') {
        const request = message.request ?? {};
        if (request.subtype !== 'can_use_tool' || !run.id) {
          write({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Not supported from Relay.' } });
          return;
        }
        const panelId = this.state.addRequest(agent, run.id, requestDetails(request, cwd), (decision) => {
          if (!['accept', 'decline'].includes(decision.decision)) throw new ApiError(400, 'Select a decision.');
          if (run.done) throw new ApiError(409, 'This session already stopped.');
          // Status first: the answer can make Claude finish the turn before write() returns.
          run.requests.delete(message.request_id);
          this.state.put(agent, run.id, { status: run.requests.size ? 'approval' : 'running' });
          write({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id,
            response: decision.decision === 'accept'
              ? { behavior: 'allow', updatedInput: request.input ?? {} }
              : { behavior: 'deny', message: 'Declined from Relay.' } } });
        });
        run.requests.set(message.request_id, panelId);
        this.state.put(agent, run.id, { status: 'approval' });
        return;
      }
      if (message.type === 'result') {
        run.done = true;
        if (run.id) {
          this.state.put(agent, run.id, { status: message.is_error ? 'failed' : 'idle', updatedAt: Date.now() });
          this.state.transient('reply', agent, run.id, { commandId, text: limitText(message.result || run.reply) });
          this.state.event('activity', agent, run.id);
        }
        child.stdin.end();
      }
    });

    child.on('close', () => {
      clearTimeout(timer);
      for (const panelId of run.requests.values()) this.state.clearRequest(panelId);
      if (!run.id) {
        rejectStart(new ApiError(502, 'Claude Code did not start the session.'));
        return;
      }
      if (this.active.get(run.id) === run) this.active.delete(run.id);
      if (!run.done) {
        this.state.put(agent, run.id, { status: 'failed', updatedAt: Date.now() });
        this.state.event('command.unconfirmed', agent, run.id);
      }
    });

    write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'initialize' } });
    write({ type: 'user', session_id: '', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'text', text }] } });
    return run;
  }

  close() {
    for (const run of this.active.values()) run.child.kill('SIGTERM');
  }
}
