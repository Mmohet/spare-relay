import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * 总管's memory in the gateway's database: its one long conversation (OpenAI chat messages),
 * the dispatch ledger, and small values. The instructions file is plain text the user can edit.
 */
export class ZongguanStore {
  constructor(db, instructionsPath) {
    this.db = db;
    this.path = instructionsPath;
    this.commandsPath = join(dirname(instructionsPath), 'commands.md'); // the user's common commands, one a line
    db.exec(`
      CREATE TABLE IF NOT EXISTS zg_message (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, body TEXT NOT NULL,
        turn INTEGER NOT NULL, kind TEXT NOT NULL, at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS zg_task (
        id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, session TEXT NOT NULL,
        task TEXT NOT NULL, at INTEGER NOT NULL, done_at INTEGER
      );
    `);
    // The user's words a task came from, and how many times 总管 has pushed it on its own; older databases lack both.
    const columns = new Set(db.prepare('PRAGMA table_info(zg_task)').all().map((column) => column.name));
    if (!columns.has('said')) db.exec("ALTER TABLE zg_task ADD COLUMN said TEXT NOT NULL DEFAULT ''");
    if (!columns.has('pushes')) db.exec('ALTER TABLE zg_task ADD COLUMN pushes INTEGER NOT NULL DEFAULT 0');
    this.insert = db.prepare('INSERT INTO zg_message(role, body, turn, kind, at) VALUES (?, ?, ?, ?, ?)');
    this.all = db.prepare('SELECT seq, body, turn, kind, at FROM zg_message ORDER BY seq');
    this.dropUpTo = db.prepare('DELETE FROM zg_message WHERE seq <= ?');
    this.dropAll = db.prepare('DELETE FROM zg_message');
    this.reads = db.prepare("SELECT seq, body FROM zg_message WHERE kind = 'read' AND turn < ?");
    this.rewrite = db.prepare('UPDATE zg_message SET body = ? WHERE seq = ?');
    this.maxTurn = db.prepare('SELECT MAX(turn) AS turn FROM zg_message');
    this.insertTask = db.prepare('INSERT INTO zg_task(agent, session, task, said, pushes, at) VALUES (?, ?, ?, ?, ?, ?)');
    this.open = db.prepare('SELECT id, agent, session, task, said, pushes, at FROM zg_task WHERE done_at IS NULL ORDER BY id');
    this.last = db.prepare('SELECT id, agent, session, task, said, pushes, at, done_at FROM zg_task WHERE agent = ? AND session = ? ORDER BY id DESC LIMIT 1');
    this.finish = db.prepare('UPDATE zg_task SET done_at = ? WHERE agent = ? AND session = ? AND done_at IS NULL');
    this.getSetting = db.prepare('SELECT value FROM setting WHERE key = ?');
    this.putSetting = db.prepare('INSERT INTO setting VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  }

  append(message, { turn, kind }) {
    return Number(this.insert.run(message.role, JSON.stringify(message), turn, kind, Date.now()).lastInsertRowid);
  }

  messages() {
    return this.all.all().map(({ seq, body, turn, kind, at }) => ({ seq, turn, kind, at, message: JSON.parse(body) }));
  }

  /** After a restart mid-turn: every tool call without a result gets "[中断]", so the next request is valid. */
  repair() {
    const answered = new Set();
    const asked = [];
    for (const { message, turn } of this.messages()) {
      if (message.role === 'tool') answered.add(message.tool_call_id);
      for (const call of message.tool_calls ?? []) asked.push({ id: call.id, turn });
    }
    const missing = asked.filter((call) => !answered.has(call.id));
    for (const call of missing) this.append({ role: 'tool', tool_call_id: call.id, content: '[中断]' }, { turn: call.turn, kind: 'chat' });
    return missing.length;
  }

  compactUpTo(seq, summary, marker) {
    const turn = this.maxTurn.get()?.turn ?? 0;
    this.db.exec('BEGIN');
    try {
      this.dropUpTo.run(seq);
      // The summary and the marker go before what is left, so they get the smallest seqs again.
      const rest = this.all.all();
      this.dropAll.run();
      this.append({ role: 'user', content: '[之前对话的摘要]\n' + summary }, { turn, kind: 'summary' });
      this.append({ role: 'assistant', content: marker }, { turn, kind: 'marker' });
      for (const row of rest) this.insert.run(JSON.parse(row.body).role, row.body, row.turn, row.kind, row.at);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  elideReads(beforeTurn) {
    for (const { seq, body } of this.reads.all(beforeTurn)) {
      this.rewrite.run(JSON.stringify({ ...JSON.parse(body), content: '[已读，原文已省略]' }), seq);
    }
  }

  clear() { this.dropAll.run(); }

  /** Clearing from inside a turn keeps that turn, so its tool call and result stay paired. */
  clearBefore(turn) { this.db.prepare('DELETE FROM zg_message WHERE turn < ?').run(turn); }

  /** The newest seq of turns before `turn`, or 0. */
  lastSeqBefore(turn) { return Number(this.db.prepare('SELECT MAX(seq) AS seq FROM zg_message WHERE turn < ?').get(turn)?.seq ?? 0); }

  /** Turn numbers only grow, also across compaction and clearing. */
  nextTurn() {
    const turn = Math.max(Number(this.meta('lastTurn') ?? 0), this.maxTurn.get()?.turn ?? 0) + 1;
    this.setMeta('lastTurn', turn);
    return turn;
  }

  addTask({ agent, session, task, said = '', pushes = 0 }) {
    return Number(this.insertTask.run(agent, session, task, said, pushes, Date.now()).lastInsertRowid);
  }

  openTasks() { return this.open.all().map((row) => ({ ...row })); }

  /** The newest task sent to a session, done or not, or null. */
  lastTask(agent, session) {
    const row = this.last.get(agent, session);
    return row ? { ...row } : null;
  }

  finishTasks(agent, session) { return Number(this.finish.run(Date.now(), agent, session).changes); }

  instructions() {
    try { return readFileSync(this.path, 'utf8'); } catch { return ''; }
  }

  /** The user's common commands, in the file's order; list markers and blank lines dropped. */
  commands() {
    let text = '';
    try { text = readFileSync(this.commandsPath, 'utf8'); } catch { return []; }
    return text.split('\n').map((line) => line.replace(/^\s*(?:[-*]|\d+[.、])\s*/, '').trim()).filter(Boolean);
  }

  addInstruction(text) {
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, '- ' + String(text).replace(/\s+/g, ' ').trim() + '\n');
  }

  /** The OpenCode session id for 总管's one conversation: made once, kept across restarts and compaction. */
  session() {
    const id = this.meta('session') ?? 'ses_' + randomUUID().replaceAll('-', '');
    this.setMeta('session', id);
    return id;
  }

  meta(key) {
    const row = this.getSetting.get('zongguan.' + key);
    return row ? JSON.parse(row.value) : null;
  }

  setMeta(key, value) { this.putSetting.run('zongguan.' + key, JSON.stringify(value)); }
}
