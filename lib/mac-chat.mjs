import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, limitText } from './state.mjs';

const handledErrors = new Map([
  ['accessibility-permission-required', 'macOS Accessibility permission is required for the chat helper.'],
  ['existing-draft', 'Finish or clear the existing draft in the native chat before sending.'],
  ['main-chat-not-selected', 'Open the Muse main chat first.'],
  ['main-bot-not-selected', 'Open the main Grok Bot chat first.'],
  ['bring-target-app-to-front', 'Bring this app to the foreground before sending.'],
  ['session-working', 'The native app is already generating a reply.'],
]);

let writing = false;
const replyWindow = 90000;

function nativeError(reason) {
  const error = new ApiError(409, handledErrors.get(reason)
    ?? 'The native chat did not confirm the operation. Check the app before retrying.');
  error.nativeCode = reason;
  return error;
}

function call(binary, agent, method, data) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'PANEL_MAC_ALLOW_ACTIVATION']
      .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
    const child = spawn(binary, [agent, method], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let failure = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
      if (output.length > 2_000_000) child.kill('SIGKILL');
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      failure = (failure + chunk).slice(0, 200);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(nativeError(failure));
        return;
      }
      try { resolve(JSON.parse(output)); } catch { reject(new ApiError(502, 'Invalid native chat response.')); }
    });
    child.stdin.end(data ? JSON.stringify(data) : '');
  });
}

async function mailbox(directory, agent, method, input) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, randomUUID());
  const expiresAt = Date.now() + 6500;
  try {
    await writeFile(path + '.writing', JSON.stringify({ agent, method, input, expiresAt }),
      { mode: 0o600, flag: 'wx' });
    await rename(path + '.writing', path + '.request');
    while (Date.now() < expiresAt) {
      const result = await readFile(path + '.response', 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      });
      if (result) {
        const reply = JSON.parse(result);
        if (!reply.ok) throw nativeError(reply.error);
        return reply.value;
      }
      await delay(100);
    }
    throw nativeError('helper-not-running');
  } finally {
    await Promise.allSettled(['.writing', '.request', '.response'].map((extension) =>
      rm(path + extension, { force: true })));
  }
}

function normalize(messages) {
  const occurrences = new Map();
  return messages.flatMap((row) => {
    if (!['assistant', 'user'].includes(row?.role)) return [];
    const text = limitText(row.text).trim();
    if (!text) return [];
    const hash = createHash('sha256').update(row.role + '\0' + text).digest('hex').slice(0, 28);
    const occurrence = (occurrences.get(hash) ?? 0) + 1;
    occurrences.set(hash, occurrence);
    return [{ id: hash + '-' + occurrence, role: row.role, text }];
  });
}

export class MacChat {
  constructor(state, agent, options) {
    this.state = state;
    this.agent = agent;
    this.options = options;
    this.messages = [];
  }

  invoke(method, input) {
    const { directory, binary } = this.options;
    return directory ? mailbox(directory, this.agent, method, input)
      : call(binary, this.agent, method, input);
  }

  async discover() {
    if (this.observing) return;
    this.observing = true;
    try {
      const raw = await this.invoke('status');
      if (raw.id !== this.agent + '-main' || !Array.isArray(raw.messages)) return;
      const old = this.messages;
      this.messages = normalize(raw.messages);
      const lastId = this.messages.at(-1)?.id;
      const changed = old.at(-1)?.id !== lastId;
      this.id = raw.id;
      this.state.put(this.agent, raw.id, {
        name: limitText(raw.name, 110),
        status: raw.status === 'running' || this.pending ? 'running' : 'unknown',
        capabilities: raw.writable === true ? ['history', 'send'] : ['history'],
        updatedAt: changed ? Date.now() : this.state.sessions.get(this.agent + ':' + raw.id)?.updatedAt,
      });
      this.state.connection(this.agent, raw.writable === true ? 'connected' : 'observing');
      if (changed) this.state.event('activity', this.agent, raw.id);
      this.observeReply(raw.status);
    } catch (error) {
      this.state.connection(this.agent, error.nativeCode === 'accessibility-permission-required' ? 'permission' : 'offline');
      if (this.id) this.state.put(this.agent, this.id, { status: 'offline', capabilities: ['history'] });
    } finally {
      this.observing = false;
    }
  }

  observeReply(nativeStatus) {
    const pending = this.pending;
    if (!pending) return;
    if (Date.now() >= pending.at + replyWindow) {
      this.pending = null;
      this.state.event('command.unconfirmed', this.agent, this.id);
      return;
    }
    const anchor = pending.anchor ? this.messages.findLastIndex((row) => row.id === pending.anchor) : -1;
    if (pending.anchor && anchor === -1) return;
    const newer = this.messages.slice(anchor + 1);
    const prompt = newer.findIndex((row) => row.role === 'user');
    if (prompt < 0) return;
    if (newer[prompt].text !== pending.text || newer.slice(prompt + 1).some((row) => row.role === 'user')) {
      this.pending = null;
      this.state.event('command.unconfirmed', this.agent, this.id);
      return;
    }
    const replies = newer.slice(prompt + 1).filter((row) => row.role === 'assistant');
    if (!replies.length || nativeStatus === 'running') return;
    const last = replies.at(-1).id;
    if (pending.candidate !== last) {
      pending.candidate = last;
      pending.since = Date.now();
      return;
    }
    if (Date.now() - pending.since < 2500) return;
    this.pending = null;
    this.state.transient('reply', this.agent, this.id, {
      commandId: pending.commandId, text: limitText(replies.map((row) => row.text).join('\n\n')),
    });
    this.state.event('activity', this.agent, this.id);
  }

  history() { return this.messages; }

  async send(id, text, commandId = randomUUID()) {
    if (writing || this.pending) throw new ApiError(409, 'The desktop bridge is already waiting for a reply.');
    writing = true;
    try {
      if (id !== this.id) throw new ApiError(409, 'The selected desktop chat changed.');
      const anchor = this.messages.at(-1)?.id;
      const result = await this.invoke('send', { session: id, text });
      if (result.dispatched !== true) throw new ApiError(502, 'The desktop app did not confirm dispatch.');
      this.pending = { commandId, text, anchor, at: Date.now() };
      this.state.put(this.agent, id, { status: 'running' });
      return { commandId };
    } finally {
      writing = false;
    }
  }
}
