import { randomUUID } from 'node:crypto';
import { ApiError, limitText } from './state.mjs';

const validId = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const statuses = new Set(['running', 'idle', 'approval', 'input', 'failed', 'unknown']);
const ttl = 15000;
const capabilities = new Set(['history', 'send', 'approval', 'interrupt']);

export class Bridge {
  constructor(state, agent) {
    this.state = state;
    this.agent = agent;
    this.leases = new Map();
    this.historyBySession = new Map();
    this.requests = new Map();
    this.commands = new Map();
  }

  sync(input) {
    const { session, instance } = input;
    if (!validId.test(session ?? '') || !validId.test(instance ?? '')) throw new ApiError(400, 'Invalid bridge identity.');
    const before = this.leases.get(session);
    if (before && before.until > Date.now() && before.instance !== instance) {
      throw new ApiError(409, 'Another bridge owns this session lease.');
    }
    const current = before?.instance === instance ? before : { instance, sent: new Set() };
    current.until = Date.now() + ttl;
    this.leases.set(session, current);
    this.state.connection(this.agent, 'connected');

    const enabled = Array.isArray(input.capabilities)
      ? [...new Set(input.capabilities.filter((value) => capabilities.has(value)))] : [];
    const known = this.state.sessions.get(this.agent + ':' + session);
    this.state.put(this.agent, session, {
      name: limitText(input.name, 110) || known?.name || this.agent,
      cwd: limitText(input.cwd, 500) || known?.cwd,
      status: statuses.has(input.status) ? input.status : 'unknown',
      updatedAt: Math.max(known?.updatedAt ?? 0, Math.min(Number(input.updatedAt) || 0, Date.now())),
      capabilities: enabled,
    });

    for (const event of Array.isArray(input.events) ? input.events.slice(0, 80) : []) {
      if (event && validId.test(event.id ?? '')) this.observe(session, event);
    }

    const work = [];
    for (const [id, ticket] of this.commands) {
      if (ticket.session !== session) continue;
      if (ticket.instance !== instance) {
        this.commands.delete(id);
        this.state.event('command.expired', this.agent, session);
        continue;
      }
      if (!current.sent.has(id)) {
        current.sent.add(id);
        work.push(ticket);
      }
    }
    return { commands: work };
  }

  observe(session, event) {
    if (event.type === 'ack') {
      const command = this.commands.get(event.id);
      if (command?.session === session) {
        this.commands.delete(event.id);
        this.leases.get(session)?.sent.delete(event.id);
        this.state.event(event.ok === true ? 'command.dispatched' : 'command.failed', this.agent, session);
      }
      return;
    }
    if (event.type === 'permission-denied') {
      this.state.event('native.permission_denied', this.agent, session);
      return;
    }
    if (event.type === 'failed') {
      this.state.event('command.failed', this.agent, session);
      this.state.transient('turn', this.agent, session, { commandId: event.id, status: 'failed' });
      return;
    }
    if (event.type === 'approval') {
      const key = session + ':' + event.id;
      if (this.requests.has(key)) return;
      const id = this.state.addRequest(this.agent, session, {
        kind: 'approval', title: limitText(event.title, 120) || 'Tool approval',
        description: limitText(event.description, 500), command: limitText(event.command, 10000),
        approvalAllowed: event.approvalAllowed !== false,
      }, (body) => {
        if (!['accept', 'decline'].includes(body.decision)) throw new ApiError(400, 'Select a decision.');
        if (body.decision === 'accept' && event.approvalAllowed === false) {
          throw new ApiError(409, 'The full approval must be reviewed in the native client.');
        }
        this.command(session, { type: 'decision', request: event.id, decision: body.decision });
      });
      this.requests.set(key, { id, session, until: Date.now() + 5 * 60000 });
      return;
    }
    if (event.type === 'resolved') {
      const key = session + ':' + event.id;
      this.state.clearRequest(this.requests.get(key)?.id);
      this.requests.delete(key);
      return;
    }
    if (!['user', 'assistant'].includes(event.type) || typeof event.text !== 'string') return;
    const log = this.historyBySession.get(session) ?? new Map();
    if (log.has(event.id)) return;
    const message = {
      id: event.id, role: event.type, text: limitText(event.text), at: Date.now(),
      commandId: validId.test(event.commandId ?? '') ? event.commandId : undefined,
    };
    log.set(event.id, message);
    if (log.size > 100) log.delete(log.keys().next().value);
    this.historyBySession.set(session, log);
    this.state.event('activity', this.agent, session);
    if (message.role === 'assistant' && message.commandId) {
      this.state.transient('reply', this.agent, session, { commandId: message.commandId, text: message.text });
    }
  }

  expire() {
    const now = Date.now();
    let expired = false;
    for (const [session, lease] of this.leases) {
      if (lease.until > now) continue;
      expired = true;
      this.leases.delete(session);
      const row = this.state.get(this.agent, session);
      this.state.put(this.agent, session, {
        status: 'offline', capabilities: row.capabilities.filter((value) => value === 'history'),
      });
    }
    // Only when the last lease ran out now: a command-line adapter may own "connected" otherwise.
    if (expired && this.leases.size === 0 && this.state.online.get(this.agent) === 'connected') {
      this.state.connection(this.agent, 'offline');
    }
    for (const [key, entry] of this.requests) {
      if (entry.until <= now || !this.leases.has(entry.session)) {
        this.state.clearRequest(entry.id);
        this.requests.delete(key);
      }
    }
    for (const [id, ticket] of this.commands) {
      const lease = this.leases.get(ticket.session);
      if (!lease || ticket.at + ttl <= now) {
        this.commands.delete(id);
        lease?.sent.delete(id);
        this.state.event('command.unconfirmed', this.agent, ticket.session);
      }
    }
  }

  command(session, input, id = randomUUID()) {
    const lease = this.leases.get(session);
    if (!lease || lease.until <= Date.now()) throw new ApiError(503, 'The session bridge is offline.');
    const existing = this.commands.get(id);
    if (existing) {
      if (existing.session !== session || existing.type !== input.type || existing.text !== input.text) {
        throw new ApiError(409, 'The message identifier was already used.');
      }
      return { commandId: id };
    }
    this.commands.set(id, { id, session, instance: lease.instance, at: Date.now(), ...input });
    return { commandId: id };
  }

  send(session, text, clientId) {
    return this.command(session, { type: 'message', text }, clientId);
  }

  history(session) { return [...(this.historyBySession.get(session)?.values() ?? [])]; }

  control(session, action) {
    if (action !== 'interrupt') throw new ApiError(409, 'This session cannot steer.');
    return this.command(session, { type: 'interrupt' });
  }
}
