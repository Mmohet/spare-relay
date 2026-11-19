import { randomUUID } from 'node:crypto';
import { ApiError, limitText, runJson } from './state.mjs';

const agent = 'grok';
const pollEvery = 6000;
const idleEvery = 60000; // every read goes to Grok's servers; slow down while nobody is looking
const targetsEvery = 60000;
const doctorEvery = 300000;
const replyWindow = 180000;
// Same fields and the same 2,048-character cut as `gbot approvals list`.
const cardFields = ['reason', 'command', 'summary', 'action', 'description', 'target', 'machineId', 'surface', 'workingDirectory'];

/** A pending approval card in a transcript entry, read the way `gbot approvals` reads it. */
export function approvalCard(entry) {
  if (entry?.kind !== 'send-message') return null;
  const type = entry.message?.type;
  const card = type === 'auto-review-approval' ? entry.message.approval
    : type === 'local-tool-permission' ? entry.message.ask : null;
  if (card?.status !== 'pending' || typeof card.requestId !== 'string' || typeof entry.id !== 'string') return null;
  const details = { entryId: entry.id, requestId: card.requestId, type, truncated: false };
  for (const key of cardFields) {
    if (typeof card[key] !== 'string') continue;
    details.truncated ||= card[key].length > 2048;
    details[key] = card[key].slice(0, 2048);
  }
  return details;
}

function text(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('');
  return '';
}

/** One transcript row for the panel and the lens, or null for entries that carry nothing to read. */
function rowOf(entry) {
  const id = String(entry.id ?? entry.seq);
  if (entry.kind === 'message' && entry.role === 'user') return { id, role: 'user', text: limitText(text(entry.content)) };
  if (entry.kind === 'user-attachment') return { id, role: 'user', text: '附件 ' + limitText(entry.file_name, 200) };
  if (entry.kind !== 'send-message') return null;
  const message = entry.message ?? {};
  const card = approvalCard(entry);
  if (card) return { id, role: 'tool', tool: { text: '要批准 ' + (card.command || card.action || card.summary || card.type) } };
  if (message.type === 'widget') {
    const options = (message.widget?.options ?? []).map((option) => option.label).filter(Boolean).join(' / ');
    return { id, role: 'assistant', text: limitText([message.widget?.prompt, options].filter(Boolean).join('\n')) };
  }
  if (message.type === 'user-form') return { id, role: 'tool', tool: { text: '要你在电脑上填表 ' + limitText(message.formRequest?.title, 200) } };
  const body = text(message.content);
  return body.trim() ? { id, role: 'assistant', text: limitText(body) } : null;
}

/**
 * Grok Bot through `gbot`: each bot and group is a session. Replies go through an injected
 * `sender` when one is given, otherwise through `gbot send`. Approval cards become panel requests answered with
 * `gbot approvals respond` (accept once or decline, never a standing grant).
 */
export class GbotCli {
  constructor(state, { binary = 'gbot', run = runJson, idle = () => false, sender = null } = {}) {
    this.state = state;
    this.agent = agent;
    this.binary = binary;
    this.run = run;
    this.idle = idle;
    this.healthy = false;
    this.targets = [];
    this.targetsAt = 0;
    this.polledAt = 0;
    this.threads = new Map(); // target id -> { at, entries }
    this.cards = new Map(); // entryId:requestId -> panel request id
    this.pending = new Map(); // target id -> { commandId, seq, at }
    this.sender = sender;
    // gbot sends only with the Grok Bot app's cached sandbox session; its other login can only read.
    this.gbotSends = null;
    this.checkedAt = 0;
  }

  /** The injected sender when it is available, else gbot when it has the Grok Bot app's session. */
  get canSend() {
    if (this.sender?.available()) return true;
    return this.gbotSends;
  }

  call(args, timeout = 15000) {
    return this.run(this.binary, [...args, '--json'], { timeout });
  }

  async discover() {
    if (this.listing) return this.listing;
    this.listing = this.refresh().finally(() => { this.listing = null; });
    return this.listing;
  }

  async refresh() {
    if (Date.now() - this.polledAt < (this.idle() ? idleEvery : pollEvery) && !this.pending.size) return;
    this.polledAt = Date.now();
    try {
      if (Date.now() - this.checkedAt >= doctorEvery) {
        this.checkedAt = Date.now();
        const doctor = await this.call(['doctor']).catch(() => null);
        this.gbotSends = doctor?.grokBotAppSession?.usable === true;
      }
      if (Date.now() - this.targetsAt >= targetsEvery || !this.targets.length) {
        const [bots, groups] = await Promise.all([this.call(['bots', 'list']), this.call(['groups', 'list'])]);
        if (!Array.isArray(bots) || !Array.isArray(groups)) throw new Error('Unexpected bot list.');
        this.targets = [...bots, ...groups].filter((row) => typeof row?.id === 'string' && !row.hiddenFromSidebar);
        this.targetsAt = Date.now();
        const ids = new Set(this.targets.map((row) => row.id));
        for (const row of [...this.state.sessions.values()]) {
          if (row.agent === agent && row.source === 'gbot' && !ids.has(row.id)) this.state.remove(agent, row.id);
        }
      }
      await Promise.all(this.targets.map((target) => this.poll(target)));
      this.healthy = true;
      this.state.connection(agent, 'connected');
    } catch {
      this.healthy = false;
      this.state.connection(agent, 'offline');
      for (const target of this.targets) this.state.put(agent, target.id, { status: 'offline', capabilities: ['history'] });
    }
  }

  async read(id, limit = 60) {
    const raw = await this.call(['thread', id, '--limit', String(limit)]);
    const entries = raw?.transcript?.entries;
    if (!Array.isArray(entries)) throw new Error('Unexpected thread.');
    this.threads.set(id, { at: Date.now(), entries });
    return entries;
  }

  async poll(target) {
    const id = target.id;
    const previous = this.threads.get(id)?.entries.at(-1)?.id;
    const entries = await this.read(id);
    const last = entries.at(-1);
    if (previous && last?.id !== previous) this.state.event('activity', agent, id);
    const cards = entries.map(approvalCard).filter(Boolean);
    this.syncCards(id, cards);
    const pending = this.pending.get(id);
    if (pending) this.watchReply(id, pending, entries);
    const streaming = entries.slice(-3).some((entry) => entry.isStreaming === true);
    this.state.put(agent, id, {
      name: limitText(target.name, 110) || 'Grok Bot', source: 'gbot', group: target.kind === 'group',
      status: cards.length ? 'approval' : streaming || this.pending.has(id) ? 'running' : 'idle',
      updatedAt: Number(last?.timestampMs) || this.state.sessions.get(agent + ':' + id)?.updatedAt || 0,
      capabilities: this.canSend ? ['history', 'send'] : ['history'],
    });
  }

  syncCards(id, cards) {
    const live = new Set();
    for (const card of cards) {
      const key = card.entryId + ':' + card.requestId;
      live.add(key);
      if (this.cards.has(key)) continue;
      const details = {
        kind: 'approval',
        title: card.command ? 'Run a command' : 'Tool approval',
        description: limitText(card.reason || card.summary || card.description, 500),
        command: limitText(card.command || card.action, 2048),
        cwd: limitText(card.workingDirectory, 500),
        // Same rule as gbot: a card whose details were cut can only be declined here.
        approvalAllowed: !card.truncated,
      };
      this.cards.set(key, this.state.addRequest(agent, id, details, async (decision) => {
        if (!['accept', 'decline'].includes(decision.decision)) throw new ApiError(400, 'Select a decision.');
        if (decision.decision === 'accept' && card.truncated) throw new ApiError(409, 'Approve this one in Grok Bot.');
        await this.call(['approvals', 'respond', '--target', id, '--entry-id', card.entryId,
          '--request-id', card.requestId, '--decision', decision.decision])
          .catch(() => { throw new ApiError(409, 'Grok Bot did not take the decision. Check the app.'); });
        this.cards.delete(key);
        this.polledAt = 0;
      }));
    }
    for (const [key, request] of this.cards) {
      if (!live.has(key) && this.state.requests.get(request)?.session === id) {
        this.cards.delete(key);
        this.state.clearRequest(request);
      }
    }
  }

  watchReply(id, pending, entries) {
    const replies = entries.filter((entry) => entry.kind === 'send-message' && Number(entry.seq) > pending.seq)
      .map(rowOf).filter((row) => row?.role === 'assistant');
    const streaming = entries.slice(-3).some((entry) => entry.isStreaming === true);
    if (replies.length && !streaming) {
      this.pending.delete(id);
      this.state.transient('reply', agent, id, { commandId: pending.commandId, text: limitText(replies.map((row) => row.text).join('\n\n')) });
    } else if (Date.now() - pending.at > replyWindow) {
      this.pending.delete(id);
      this.state.event('command.unconfirmed', agent, id);
    }
  }

  async history(id) {
    const cached = this.threads.get(id);
    const entries = cached && Date.now() - cached.at < 4000 ? cached.entries : await this.read(id);
    return entries.map(rowOf).filter((row) => row && (row.text?.trim() || row.tool));
  }

  async send(id, message, commandId = randomUUID()) {
    if (this.pending.has(id)) throw new ApiError(409, 'Grok Bot is still answering here.');
    const entries = await this.read(id, 5).catch(() => []);
    const seq = Math.max(0, ...entries.map((entry) => Number(entry.seq) || 0));
    if (this.sender?.available()) {
      await this.sender.send(id, message, commandId);
      this.pending.set(id, { commandId, seq, at: Date.now() });
      this.state.put(agent, id, { status: 'running', updatedAt: Date.now() });
      this.polledAt = 0;
      return { commandId };
    }
    // gbot has no "--" separator; a leading space keeps "-text" from being read as an option.
    const result = await this.call(['send', id, message.startsWith('-') ? ' ' + message : message], 30000)
      .catch((error) => {
        if (/may not make this request/i.test(error.message)) {
          this.gbotSends = false;
          this.polledAt = 0;
          throw new ApiError(409, 'Grok Bot only lets its app send. Reply in Grok Bot.');
        }
        throw new ApiError(502, 'Grok Bot did not take the message. Check the thread before resending.');
      });
    if (!['accepted', 'unknown'].includes(result?.delivery)) throw new ApiError(502, 'Grok Bot did not confirm the message.');
    this.pending.set(id, { commandId, seq, at: Date.now() });
    this.state.put(agent, id, { status: 'running', updatedAt: Date.now() });
    return { commandId };
  }
}
