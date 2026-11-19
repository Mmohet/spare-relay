import { randomUUID } from 'node:crypto';
import { ApiError, limitText, runJson } from './state.mjs';

const agent = 'muse';
const listEvery = 8000; // `muse-cli` opens a fresh gateway connection per call (about 2 s).
const idleEvery = 60000; // each listing downloads tens of KB; nobody needs it every 8 s while nobody is looking
const replyWindow = 180000;

function statusOf(value) {
  if (/fail|error/i.test(value ?? '')) return 'failed';
  if (/run|progress|work|stream|pending|think/i.test(value ?? '')) return 'running';
  return 'idle';
}

/**
 * Muse through its command-line client: every chat and side chat is a session,
 * replies go to the chosen chat, and a new side chat can be started.
 */
export class MuseCli {
  constructor(state, { binary = 'muse-cli', run = runJson, idle = () => false } = {}) {
    this.state = state;
    this.agent = agent;
    this.binary = binary;
    this.run = run;
    this.idle = idle;
    this.listedAt = 0;
    this.healthy = false;
    this.known = new Map(); // session id -> updated_at_ms at the last listing
    this.histories = new Map(); // session id -> { at, rows }
    this.warm = new Set(); // chats to read ahead
    this.titles = new Map(); // untitled chats started here -> their first line
    this.pending = new Map(); // session id -> { commandId, baseline, at }
  }

  call(args, timeout) {
    return this.run(this.binary, args, { timeout });
  }

  async discover() {
    if (this.listing) return this.listing;
    this.listing = this.refresh().finally(() => { this.listing = null; });
    return this.listing;
  }

  async refresh() {
    if (Date.now() - this.listedAt >= (this.idle() ? idleEvery : listEvery) || this.pending.size) {
      this.listedAt = Date.now();
      try {
        const raw = await this.call(['raw', 'sessions.list'], 15000);
        const sessions = raw?.result?.sessions;
        if (!Array.isArray(sessions)) throw new Error('Unexpected session list.');
        const seen = new Set();
        for (const row of sessions) {
          if (row.archived || typeof row.session_id !== 'string') continue;
          const id = row.session_id;
          seen.add(id);
          const updatedAt = Number(row.updated_at_ms) || 0;
          if (this.known.has(id) && this.known.get(id) !== updatedAt) this.state.event('activity', agent, id);
          // Reading a chat takes seconds, longer than the lens waits: keep each one read ahead.
          if (this.known.get(id) !== updatedAt || !this.histories.has(id)) this.warm.add(id);
          this.known.set(id, updatedAt);
          this.state.put(agent, id, {
            name: limitText(row.title, 110) || this.titles.get(id) || (row.is_primary ? '主对话' : '对话'),
            status: this.pending.has(id) ? 'running' : statusOf(row.status),
            updatedAt, preview: limitText(row.snippet, 300),
            capabilities: row.can_send_messages === false ? ['history'] : ['history', 'send'],
          });
        }
        for (const row of [...this.state.sessions.values()]) {
          if (row.agent === agent && row.capabilities.includes('history') && !seen.has(row.id) && this.known.has(row.id)) {
            this.known.delete(row.id);
            this.state.remove(agent, row.id);
          }
        }
        this.healthy = true;
        this.state.connection(agent, 'connected');
        void this.prefetch();
      } catch {
        this.healthy = false;
        this.state.connection(agent, 'offline');
        for (const id of this.known.keys()) this.state.put(agent, id, { status: 'offline', capabilities: ['history'] });
      }
    }
    for (const [id, pending] of this.pending) await this.watchReply(id, pending).catch(() => {});
  }

  async messages(id, limit = 40) {
    const rows = await this.call(['history', '--thread', id, '--limit', String(limit)], 15000);
    if (!Array.isArray(rows)) throw new Error('Unexpected history.');
    return rows.filter((row) => ['user', 'assistant'].includes(row?.role) && typeof row.text === 'string' && row.text.trim())
      .map((row) => ({ id: String(row.message_id ?? row.seq), seq: Number(row.seq) || 0, role: row.role, text: limitText(row.text) }));
  }

  /** Read changed chats one at a time in the background, newest first. */
  async prefetch() {
    if (this.prefetching) return;
    this.prefetching = true;
    try {
      while (this.warm.size) {
        const id = [...this.warm].sort((a, b) => (this.known.get(b) ?? 0) - (this.known.get(a) ?? 0))[0];
        this.warm.delete(id);
        if (this.known.has(id)) await this.load(id).catch(() => {});
      }
    } finally {
      this.prefetching = false;
    }
  }

  async load(id) {
    const rows = await this.messages(id);
    this.histories.set(id, { at: Date.now(), rows });
    return rows;
  }

  /** The last read of a chat right away; a read older than a few seconds is renewed behind it. */
  async history(id) {
    const cached = this.histories.get(id);
    if (!cached) return this.load(id);
    if (Date.now() - cached.at >= 4000) {
      this.warm.add(id);
      void this.prefetch();
    }
    return cached.rows;
  }

  async watchReply(id, pending) {
    if (Date.now() - pending.at > replyWindow) {
      this.pending.delete(id);
      this.state.put(agent, id, { status: 'idle' });
      this.state.event('command.unconfirmed', agent, id);
      return;
    }
    const rows = await this.messages(id, 10);
    const replies = rows.filter((row) => row.role === 'assistant' && row.seq > pending.baseline);
    if (replies.length) this.finish(id, pending, replies.map((row) => row.text).join('\n\n'));
  }

  finish(id, pending, text) {
    if (this.pending.get(id) !== pending) return;
    this.pending.delete(id);
    this.warm.add(id);
    void this.prefetch();
    this.state.put(agent, id, { status: 'idle', updatedAt: Date.now() });
    this.state.transient('reply', agent, id, { commandId: pending.commandId, text: limitText(text) });
    this.state.event('activity', agent, id);
  }

  async send(id, text, commandId = randomUUID()) {
    if (this.pending.has(id)) throw new ApiError(409, 'Muse is still answering in this chat.');
    const before = await this.messages(id, 5).catch(() => []);
    const pending = { commandId, baseline: Math.max(0, ...before.map((row) => row.seq)), at: Date.now() };
    // `--wait 0` returns before the message is delivered and loses it, so the send waits for
    // the reply in the background; history polling covers a reply that comes later.
    // `--` keeps a message that starts with "-" from being read as an option.
    const job = this.call(['send', '--thread', id, '--wait', '150', '--', text], 170000);
    this.pending.set(id, pending);
    const early = await Promise.race([job.then(() => null, (error) => error),
      new Promise((resolve) => setTimeout(resolve, 3000, null))]);
    if (early) {
      this.pending.delete(id);
      throw new ApiError(502, 'Muse did not accept the message. Check the Muse app before retrying.');
    }
    job.then((result) => {
      if (result?.reply?.role === 'assistant' && result.reply.text) this.finish(id, pending, result.reply.text);
    }, () => {
      if (this.pending.get(id) !== pending) return;
      this.pending.delete(id);
      this.state.put(agent, id, { status: 'idle' });
      this.state.event('command.unconfirmed', agent, id);
    });
    this.state.put(agent, id, { status: 'running', updatedAt: Date.now() });
    return { commandId };
  }

  /** Start a side chat and send the first message into it. */
  async create(text) {
    const started = await this.call(['session-start'], 20000)
      .catch(() => { throw new ApiError(502, 'Muse could not start a new chat.'); });
    const id = started?.session_id ?? started?.id;
    if (typeof id !== 'string' || !id) throw new ApiError(502, 'Muse did not return the new chat.');
    this.known.set(id, Date.now());
    this.titles.set(id, limitText(text.split('\n')[0], 110) || '新对话');
    this.state.put(agent, id, { name: this.titles.get(id), status: 'idle',
      updatedAt: Date.now(), capabilities: ['history', 'send'] });
    const { commandId } = await this.send(id, text);
    return { id, commandId };
  }
}
