import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID } from 'node:crypto';

export const agents = new Map([
  ['codex', { name: 'Codex', group: 'Development', glyph: 'CX' }],
  ['claude', { name: 'Claude Code', group: 'Development', glyph: 'CC' }],
  ['muse', { name: 'Muse', group: 'Assistant', glyph: 'MU' }],
  ['grok', { name: 'Grok Bot', group: 'Assistant', glyph: 'GB' }],
  ['dsh', { name: 'DeepSeek', group: 'Development', glyph: 'DS' }],
  ['hermes', { name: 'Hermes Agent', group: 'Development', glyph: 'HM' }],
]);

export class State extends EventEmitter {
  constructor(path) {
    super();
    this.setMaxListeners(0);
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS event (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL,
        agent TEXT NOT NULL, session TEXT, at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS panel_login (digest TEXT PRIMARY KEY, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS relay_receipt (
        id TEXT PRIMARY KEY, at INTEGER NOT NULL, agent TEXT NOT NULL, session TEXT NOT NULL,
        origin TEXT NOT NULL, said TEXT NOT NULL, text TEXT NOT NULL
      );
    `);
    this.insertReceipt = this.db.prepare('INSERT INTO relay_receipt VALUES (?, ?, ?, ?, ?, ?, ?)');
    this.readReceipt = this.db.prepare('SELECT * FROM relay_receipt WHERE id = ?');
    this.insert = this.db.prepare('INSERT INTO event(kind, agent, session, at) VALUES (?, ?, ?, ?)');
    this.after = this.db.prepare('SELECT * FROM event WHERE seq > ? ORDER BY seq LIMIT 500');
    this.latestEvent = this.db.prepare('SELECT seq FROM event ORDER BY seq DESC LIMIT 1');
    this.getSetting = this.db.prepare('SELECT value FROM setting WHERE key = ?');
    this.putSetting = this.db.prepare('INSERT INTO setting VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    this.prune = this.db.prepare('DELETE FROM event WHERE seq < ?');
    this.insertLogin = this.db.prepare('INSERT INTO panel_login VALUES (?, ?)');
    this.readLogin = this.db.prepare('SELECT expires FROM panel_login WHERE digest = ?');
    this.expireLogins = this.db.prepare('DELETE FROM panel_login WHERE expires <= ?');
    this.limitLogins = this.db.prepare(
      'DELETE FROM panel_login WHERE rowid IN (SELECT rowid FROM panel_login ORDER BY expires DESC, rowid DESC LIMIT -1 OFFSET 100)',
    );
    this.sessions = new Map();
    this.requests = new Map();
    this.adapters = new Map();
    this.online = new Map();
  }

  issueLogin(digest, expires) {
    this.insertLogin.run(digest, expires);
    this.limitLogins.run();
  }

  loginValid(digest, now) {
    return (this.readLogin.get(digest)?.expires ?? 0) > now;
  }

  event(kind, agent, session = null, live = {}) {
    const at = Date.now();
    const seq = Number(this.insert.run(kind, agent, session, at).lastInsertRowid);
    if (seq % 100 === 0) this.prune.run(seq - 5000);
    this.emit('event', { seq, kind, agent, session, at, ...live });
  }

  transient(kind, agent, session, live) {
    this.emit('event', { kind, agent, session, at: Date.now(), ...live });
  }

  put(agent, id, update) {
    const key = agent + ':' + id;
    const previous = this.sessions.get(key);
    const session = {
      agent, id, name: agents.get(agent).name, status: 'unknown', capabilities: [],
      ...previous, ...update,
    };
    if (JSON.stringify(previous) !== JSON.stringify(session)) {
      this.sessions.set(key, session);
      this.event('session', agent, id);
    }
    return session;
  }

  remove(agent, id) {
    if (this.sessions.delete(agent + ':' + id)) this.event('session', agent, id);
  }

  get(agent, id) {
    const session = this.sessions.get(agent + ':' + id);
    if (!session) throw new ApiError(404, 'Session is not registered.');
    return session;
  }

  connection(agent, status) {
    if (this.online.get(agent) === status) return;
    this.online.set(agent, status);
    this.event('connection', agent);
  }

  addRequest(agent, session, details, respond) {
    const id = randomUUID();
    const entry = { id, agent, session, ...details, at: Date.now(), respond };
    this.requests.set(id, entry);
    this.event('attention', agent, session);
    return id;
  }

  clearRequest(id) {
    const entry = this.requests.get(id);
    if (!entry) return;
    this.requests.delete(id);
    this.event('attention', entry.agent, entry.session);
  }

  async decide(id, decision) {
    const request = this.requests.get(id);
    if (!request || request.resolving) throw new ApiError(409, 'This request is no longer available.');
    request.resolving = true;
    try {
      await request.respond(decision);
      this.clearRequest(id);
    } finally {
      request.resolving = false;
    }
  }

  snapshot() {
    const attention = [...this.requests.values()].map(({ respond, resolving, ...item }) => item);
    return {
      agents: [...agents].map(([id, meta]) => ({
        id, ...meta, connection: this.online.get(id) ?? 'unconfigured',
        sessions: [...this.sessions.values()].filter((session) => session.agent === id)
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)),
      })),
      attention,
      voiceTarget: this.setting('voiceTarget'),
    };
  }

  setting(key) {
    const record = this.getSetting.get(key);
    return record ? JSON.parse(record.value) : null;
  }

  set(key, value) {
    this.putSetting.run(key, JSON.stringify(value));
  }

  /** A Relay receipt: what was sent to a session, who wrote it (voice: the wearer; zongguan: 总管) and the wearer's words. */
  addReceipt({ agent, session, origin, said, text }) {
    for (;;) {
      const id = Array.from(randomBytes(6), (byte) => '0123456789abcdefghijklmnopqrstuvwxyz'[byte % 36]).join('');
      if (this.readReceipt.get(id)) continue;
      this.insertReceipt.run(id, Date.now(), agent, session, origin, String(said ?? ''), String(text ?? ''));
      return id;
    }
  }

  receipt(id) {
    const row = this.readReceipt.get(String(id));
    return row ? { ...row } : null;
  }
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function limitText(value, limit = 12000) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

export function plainText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter((part) => /^(text|input_text|output_text)$/i.test(part?.type))
    .map((part) => part.text ?? '').join('\n');
}

/**
 * Run a local command-line tool and parse its JSON output. Only a few environment
 * variables reach the child; stdout is capped so a runaway tool cannot fill memory.
 */
export function runJson(binary, args, { timeout = 15000, env = {}, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const base = Object.fromEntries(['PATH', 'HOME', 'LANG', 'USER', 'TMPDIR']
      .filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
    const child = spawn(binary, args, { env: { ...base, ...env }, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let failure = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      output += chunk;
      if (output.length > 8_000_000) child.kill('SIGKILL');
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { failure = (failure + chunk).slice(-400); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        // Some tools (gbot --json) print their error object on stdout.
        const detail = failure.trim() || output.trim().slice(-400);
        const error = new Error((signal ? 'killed by ' + signal : 'exit ' + code) + ': ' + detail);
        error.exitCode = code;
        reject(error);
        return;
      }
      try { resolve(JSON.parse(output)); } catch { reject(new Error('Invalid JSON from ' + binary)); }
    });
  });
}
