import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const session = process.env.PANEL_CLAUDE_SESSION;
const token = process.env.PANEL_CLAUDE_BRIDGE_TOKEN;
const gateway = new URL(process.env.PANEL_BRIDGE_URL || 'http://127.0.0.1:4488');
if (!/^[0-9a-f-]{36}$/i.test(session ?? '') || !token
  || (gateway.protocol !== 'https:' && gateway.hostname !== '127.0.0.1')) {
  throw new Error('Provide the selected Claude session ID, bridge token, and a trusted gateway.');
}
const instance = randomUUID();
const events = [];
const pending = new Map();
const approvals = new Map();
let timer;
let processing = false;
let initialized = false;
let lastActivity = Date.now();
const update = (event) => {
  lastActivity = Date.now();
  if (events.length < 200) events.push(event);
};
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n');
const notify = (method, params) => send({ method, params });

function dispatch(command) {
  if (command.type === 'message') {
    pending.set(command.id, Date.now());
    notify('notifications/claude/channel', {
      content: command.text, meta: { chat_id: command.id },
    });
    update({ id: command.id, type: 'user', text: command.text });
  } else if (command.type === 'decision' && approvals.has(command.request)) {
    notify('notifications/claude/channel/permission', {
      request_id: command.request, behavior: command.decision === 'accept' ? 'allow' : 'deny',
    });
    approvals.delete(command.request);
    update({ id: command.request, type: 'resolved' });
  } else {
    update({ id: command.id, type: 'ack', ok: false });
    return;
  }
  update({ id: command.id, type: 'ack', ok: true });
}

async function sync() {
  if (processing || !initialized) return;
  processing = true;
  const now = Date.now();
  for (const [id, at] of pending) if (now - at > 5 * 60000) pending.delete(id);
  for (const [id, at] of approvals) if (now - at > 5 * 60000) approvals.delete(id);
  const batch = events.slice(0, 80);
  try {
    const response = await fetch(new URL('/bridge/claude/sync', gateway), {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({
        session, instance, status: approvals.size ? 'approval' : pending.size ? 'running' : 'unknown',
        capabilities: ['history', 'send', 'approval'], updatedAt: lastActivity, events: batch,
      }),
      redirect: 'error', signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) return;
    const { commands } = await response.json();
    events.splice(0, batch.length);
    for (const command of commands) dispatch(command);
  } catch { /* A failed poll does not replay a previously dispatched command. */ }
  finally { processing = false; }
}

function receive(frame) {
  const { id, method, params } = frame;
  const respond = (result) => { if (id !== undefined) send({ id, result }); };
  if (method === 'initialize') {
    respond({
      protocolVersion: params.protocolVersion,
      capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} },
      serverInfo: { name: 'relay-panel', version: '0.1.0' },
      instructions: 'A relay-panel channel message is a user message from their Remote Panel. Respond to the user through the reply tool with the matching chat_id.',
    });
  } else if (method === 'notifications/initialized') {
    initialized = true;
    if (!timer) timer = setInterval(sync, 1400);
    void sync();
  } else if (method === 'tools/list') {
    respond({ tools: [{
      name: 'reply', description: 'Return a response to the original Relay Panel message.',
      inputSchema: { type: 'object', properties: { chat_id: { type: 'string' }, text: { type: 'string' } },
        required: ['chat_id', 'text'], additionalProperties: false },
    }] });
  } else if (method === 'tools/call' && params?.name === 'reply') {
    const { chat_id: chatId, text } = params.arguments ?? {};
    if (!pending.has(chatId) || typeof text !== 'string' || !text.trim()) {
      respond({ isError: true, content: [{ type: 'text', text: 'Unknown relay message or empty reply.' }] });
      return;
    }
    pending.delete(chatId);
    update({ id: randomUUID(), commandId: chatId, type: 'assistant', text: text.slice(0, 12000) });
    void sync();
    respond({ content: [{ type: 'text', text: 'Reply recorded.' }] });
  } else if (method === 'notifications/claude/channel/permission_request') {
    const request = params?.request_id;
    if (typeof request !== 'string' || !/^[a-z]{5}$/.test(request) || approvals.has(request)) return;
    approvals.set(request, Date.now());
    update({ id: request, type: 'approval', title: params.tool_name, description: params.description,
      command: params.input_preview });
    void sync();
  } else if (method === 'ping') {
    respond({});
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: 'Unknown method' } });
  }
}

const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  try { receive(JSON.parse(line)); } catch { /* Ignore malformed input frames. */ }
});
input.on('close', () => {
  initialized = false;
  clearInterval(timer);
});
