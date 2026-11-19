import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const frameId = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

async function verifyInactive(session, root) {
  const registry = join(root, 'sessions');
  for (const file of await readdir(registry).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })) {
    if (!/^\d+\.json$/.test(file)) continue;
    const row = await readFile(join(registry, file), 'utf8').then(JSON.parse).catch(() => null);
    if (row?.sessionId !== session || String(row.pid) + '.json' !== file) continue;
    try {
      process.kill(row.pid, 0);
    } catch (error) {
      if (error.code === 'ESRCH') continue;
      throw new Error('Cannot confirm whether the original Claude session is closed.');
    }
    throw new Error('The original Claude session is open. Use Channels or close that session before resuming.');
  }
  const projects = join(root, 'projects');
  for (const folder of await readdir(projects)) {
    if ((await stat(join(projects, folder, session + '.jsonl')).catch(() => null))?.isFile()) return;
  }
  throw new Error('The selected Claude session was not found in local history.');
}

export async function openClaudeStdio(options) {
  const { session, token, cwd = process.cwd(), command = 'claude', isolated, testSettings } = options;
  const gateway = new URL(options.gateway ?? 'http://127.0.0.1:4488');
  if (!uuid.test(session ?? '') || !token || (gateway.protocol !== 'https:' && gateway.hostname !== '127.0.0.1')) {
    throw new Error('Use an exact Claude session UUID, local bridge token, and trusted gateway.');
  }
  if (!isolated) await verifyInactive(session, process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'));
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'manual', '--permission-prompt-tool', 'stdio'];
  args.push(...(isolated ? ['--session-id', session, '--no-session-persistence', '--strict-mcp-config',
    '--setting-sources', '', '--tools', 'Bash', '--settings', testSettings ?? '{}'] : ['--resume', session]));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PANEL_')));
  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
  const instance = randomUUID();
  const events = [];
  const permissions = new Map();
  let active = null;
  let online = false;
  let processing = false;
  let updatedAt = Date.now();
  let timer;
  let closed = false;
  let finish;
  const finished = new Promise((resolveDone) => { finish = resolveDone; });

  function emit(event) {
    if (events.length < 200) events.push(event);
    updatedAt = Date.now();
  }

  const write = (message) => child.stdin.write(JSON.stringify(message) + '\n');
  const response = (id, data) => write({
    type: 'control_response', response: { subtype: 'success', request_id: id, response: data },
  });
  const rejectTool = (id) => response(id, { behavior: 'deny', message: 'User denied the action from Relay Panel.' });

  function dispatch(ticket) {
    let ok = false;
    if (ticket.type === 'message' && !active && frameId.test(ticket.id)) {
      active = { id: ticket.id, assistant: null };
      const messageId = uuid.test(ticket.id) ? ticket.id : randomUUID();
      write({ type: 'user', uuid: messageId, message: { role: 'user', content: ticket.text },
        parent_tool_use_id: null, session_id: session, client_composed: true });
      emit({ id: messageId, type: 'user', text: ticket.text });
      ok = true;
    }
    if (ticket.type === 'decision') {
      const permission = permissions.get(ticket.request);
      if (permission && (ticket.decision === 'decline' || ticket.decision === 'accept' && permission.approvable)) {
        if (ticket.decision === 'decline') rejectTool(ticket.request);
        else response(ticket.request, { behavior: 'allow', updatedInput: permission.input });
        permissions.delete(ticket.request);
        emit({ id: ticket.request, type: 'resolved' });
        ok = true;
      }
    }
    emit({ id: ticket.id, type: 'ack', ok });
  }

  async function sync() {
    if (!online || closed || processing) return;
    processing = true;
    const batch = events.slice(0, 80);
    try {
      const reply = await fetch(new URL('/bridge/claude/sync', gateway), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3500),
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ session, instance, cwd, updatedAt, events: batch,
          status: permissions.size ? 'approval' : active ? 'running' : 'idle',
          capabilities: ['history', 'send', 'approval'] }),
      });
      if (!reply.ok || closed) return;
      const { commands } = await reply.json();
      events.splice(0, batch.length);
      for (const ticket of commands) dispatch(ticket);
    } catch { /* Only the gateway can redeliver observations; commands are never retried here. */ }
    finally { processing = false; }
  }

  let initialized;
  const ready = new Promise((resolveReady, rejectReady) => { initialized = { resolveReady, rejectReady }; });
  const deadline = setTimeout(() => {
    initialized.rejectReady(new Error('Claude CLI did not initialize.'));
    child.kill('SIGTERM');
  }, 15000);
  child.stdin.on('error', () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    let frame;
    try { frame = JSON.parse(line); } catch { return; }
    if (frame.type === 'control_response' && frame.response?.request_id === 'relay-initialize') {
      clearTimeout(deadline);
      if (frame.response.subtype !== 'success') {
        initialized.rejectReady(new Error('Claude CLI rejected the bridge initialization.'));
        child.kill();
        return;
      }
      online = true;
      timer = setInterval(sync, 700);
      void sync();
      initialized.resolveReady();
      return;
    }
    if (frame.session_id && frame.session_id !== session) {
      console.error('Claude CLI returned a different session ID. Closing the bridge.');
      child.kill();
      return;
    }
    if (frame.type === 'control_request') {
      const id = frame.request_id;
      const request = frame.request;
      if (typeof id !== 'string') return;
      if (!active || request?.subtype !== 'can_use_tool' || !frameId.test(id)) {
        rejectTool(id);
        return;
      }
      const details = JSON.stringify(request.input ?? {});
      const approvable = details.length <= 10000 && request.tool_name !== 'AskUserQuestion';
      permissions.set(id, { input: request.input ?? {}, approvable });
      emit({ id, type: 'approval', title: request.title ?? request.tool_name,
        description: request.description ?? request.decision_reason,
        command: details, approvalAllowed: approvable });
      void sync();
    }
    if (frame.type === 'control_cancel_request' && permissions.delete(frame.request_id)) {
      emit({ id: frame.request_id, type: 'resolved' });
    }
    if (frame.type === 'assistant' && active && !frame.parent_tool_use_id) {
      active.assistant = frame.uuid;
    }
    if (frame.type === 'result' && active) {
      const item = active;
      active = null;
      for (const id of permissions.keys()) emit({ id, type: 'resolved' });
      permissions.clear();
      if (Array.isArray(frame.permission_denials) && frame.permission_denials.length) {
        emit({ id: item.id, type: 'permission-denied' });
      }
      const result = typeof frame.result === 'string' ? frame.result.trim() : '';
      if (frame.subtype === 'success' && !frame.is_error && result && !result.startsWith('Failed to authenticate:')) {
        emit({ id: frameId.test(item.assistant ?? '') ? item.assistant : randomUUID(),
          type: 'assistant', commandId: item.id, text: result.slice(0, 12000) });
      } else {
        emit({ id: item.id, type: 'failed', message: 'Claude Code did not complete this turn.' });
      }
      void sync();
    }
  });

  child.on('error', () => initialized.rejectReady(new Error('Claude CLI failed to start.')));
  child.once('close', () => {
    closed = true;
    clearTimeout(deadline);
    clearInterval(timer);
    initialized.rejectReady(new Error('Claude CLI closed before initialization.'));
    finish();
  });
  write({ type: 'control_request', request_id: 'relay-initialize', request: { subtype: 'initialize', hooks: {} } });
  await ready;
  return {
    finished,
    close: async () => {
      if (!closed) {
        const stop = setTimeout(() => child.kill('SIGKILL'), 3000);
        child.stdin.end();
        await finished;
        clearTimeout(stop);
      }
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const agent = await openClaudeStdio({
    session: process.argv[2], token: process.env.PANEL_CLAUDE_BRIDGE_TOKEN,
    gateway: process.env.PANEL_BRIDGE_URL ?? 'http://127.0.0.1:' + (process.env.PANEL_PORT || 4488),
    command: process.env.PANEL_CLAUDE_BIN,
  });
  console.log('The selected Claude Code session is connected to the panel.');
  process.once('SIGTERM', () => void agent.close());
  process.once('SIGINT', () => void agent.close());
  await agent.finished;
}
