import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { agents, ApiError } from './state.mjs';

const ready = new Set(['connected', 'observing']);
// A finished turn reaches the phone only when nobody has touched the Mac for this long: at the desk you see it there.
const awayAfter = 120000;
const working = new Set(['running', 'approval', 'input']);

/** Milliseconds since the last keyboard or mouse input on this Mac; Infinity when it cannot tell. */
function macIdle() {
  return new Promise((resolve) => {
    execFile('/usr/sbin/ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 3000 }, (error, out) => {
      const match = /"HIDIdleTime" = (\d+)/.exec(String(out ?? ''));
      resolve(error || !match ? Infinity : Number(match[1]) / 1e6);
    });
  });
}

/* ---------- Spare Agent Protocol: glasses app requests and push (spare.cool/io/agent §15–19) ---------- */

// The five agents this version runs, in their default order; relay setup picks which run and in what order.
// The glasses address an agent by its letter and show it by its glyph (a digit, 5 is 总管).
const order = ['codex', 'claude', 'muse', 'grok', 'dsh'];
const letters = { codex: 'c', claude: 'k', muse: 'm', grok: 'g', dsh: 'd', hermes: 'h', antigravity: 'v' };
const byLetter = Object.fromEntries(Object.entries(letters).map(([agent, letter]) => [letter, agent]));
const shortName = { codex: 'Codex', claude: 'Claude', muse: 'Muse', grok: 'Grok', dsh: 'DeepSeek', zongguan: '总管',
  hermes: 'Hermes', antigravity: 'Antigravity' };
const titles = { 'Run a command': '要运行命令', 'Modify files': '要改文件', 'Tool approval': '要用工具',
  'Codex needs an answer': '要你回答', 'Claude needs an answer': '要你回答' };
const width = 492; // Text column on the 540-pixel lens, matching spare/app.json.
const appPattern = /^dev\.[a-z0-9_-]+\.[a-z0-9_-]+$/;
const pushPattern = /^https:\/\/[a-z0-9.-]+\.spare\.cool\/v1\/agent-push\/[A-Za-z0-9_-]{16,256}$/;
const devicePattern = /^[A-Za-z0-9_-]{1,64}$/;

/** Cut a string to at most `bytes` UTF-8 bytes without splitting a character. */
export function fitBytes(text, bytes = 63) {
  let out = '';
  let used = 0;
  for (const char of String(text ?? '')) {
    const size = Buffer.byteLength(char);
    if (used + size > bytes) break;
    out += char;
    used += size;
  }
  return out;
}

// Rough advance widths for the lens font. The glasses' font is not published; these are measured on the
// simulator's CJK font (Hiragino Sans GB), where dashes, quotes and "…" are a full em like the ideographs.
function measure(text, size) {
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code >= 0x2e80 || (code >= 0x2010 && code <= 0x206f) || code === 0xb7) total += 1;
    else if (char === ' ') total += 0.3;
    else if (/[.,:;'!|ilj]/.test(char)) total += 0.3;
    else if (/[MW@mw%]/.test(char)) total += 0.92;
    else if (/[A-Z]/.test(char)) total += 0.72;
    else if (/[0-9]/.test(char)) total += 0.66;
    else if (/[-_/()[\]]/.test(char)) total += 0.42;
    else total += 0.58;
  }
  return total * size;
}

/**
 * Wrap text for one text element per line. Punctuation never starts a line and words or paths are not split,
 * unless a single word is wider than the line. The last line ends with "…" when text was dropped.
 */
export function wrap(value, size, lines = Infinity, column = width, cap = 63) {
  const out = [];
  for (const paragraph of String(value ?? '').replace(/\r/g, '').split('\n')) {
    let line = '';
    // Runs of spaces shrink to two: the lens uses a double space as a separator ("空闲  6 分钟前").
    for (const char of paragraph.replace(/\s/g, ' ').replace(/ {3,}/g, '  ').trim()) {
      // A line also ends at the string limit, so long Chinese lines wrap instead of being cut.
      if ((measure(line + char, size) <= column && Buffer.byteLength(line + char) <= cap) || !line) { line += char; continue; }
      if (char === ' ') { out.push(line); line = ''; continue; }
      const keep = /[，。？！、：；）」』,.?!:;)]/.test(char) ? /[\w./~-]+$|.$/u
        : /[\w./~-]$/.test(line) && /[\w./~-]/.test(char) ? /[\w./~-]+$/ : null;
      const moved = keep ? line.match(keep)?.[0] ?? '' : '';
      if (moved && moved.length < line.length) {
        out.push(line.slice(0, -moved.length).trimEnd());
        line = moved + char;
      } else {
        out.push(line);
        line = char;
      }
    }
    if (line) out.push(line);
  }
  const fitted = out.map((line) => fitBytes(line, cap));
  if (fitted.length <= lines) return fitted;
  const kept = fitted.slice(0, lines);
  let last = kept[lines - 1];
  while (last && measure(last + '…', size) > column) last = [...last].slice(0, -1).join('');
  while (last && Buffer.byteLength(last + '…') > cap) last = [...last].slice(0, -1).join('');
  kept[lines - 1] = fitBytes(last + '…', cap);
  return kept;
}

const one = (value, size, column = width) => wrap(value, size, 1, column)[0] ?? '';

function age(at, now) {
  if (!at) return '';
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟';
  if (seconds < 86400) return Math.floor(seconds / 3600) + ' 小时';
  return Math.floor(seconds / 86400) + ' 天';
}

const verbs = { Read: '读', Grep: '搜', Glob: '找文件', WebFetch: '打开网页', TodoWrite: '更新待办', Skill: '用技能', ToolSearch: '找工具' };
const baseName = (path) => String(path ?? '').split('/').filter(Boolean).at(-1) ?? '';

/** A tool call (the `tool` of a transcript row or a live action) as a short line of what the agent is doing. */
export function toolText(tool) {
  if (!tool) return '';
  if (tool.text) return firstLine(tool.text);
  switch (tool.type) {
    case 'commandExecution': return '运行 ' + firstLine(displayCommand(tool.command));
    case 'fileChange': return '改 ' + baseName(tool.path) + (tool.files > 1 ? ' 等 ' + tool.files + ' 个文件' : '');
    case 'webSearch': return '搜索 ' + firstLine(tool.query);
    case 'mcpToolCall': return '用 ' + tool.server + ' · ' + tool.tool;
    case 'imageView': return '看图 ' + baseName(tool.path);
    case 'collabAgentToolCall': return '派子 Agent 干活';
    case 'dynamicToolCall': return (verbs[tool.tool] ?? '用 ' + tool.tool) + (tool.detail ? ' ' + firstLine(tool.detail) : '');
    default: return '';
  }
}

/** Codex wraps commands as `/bin/zsh -lc '…'`; the lens shows the command inside. */
export function displayCommand(command) {
  const text = String(command ?? '').trim();
  const match = /^(?:\/(?:usr\/)?bin\/)?(?:zsh|bash|sh) -l?c (?:'((?:[^']|'\\'')*)'|"((?:[^"\\]|\\.)*)")$/s.exec(text);
  if (!match) return text;
  return match[1] !== undefined ? match[1].replace(/'\\''/g, "'") : match[2].replace(/\\(.)/g, '$1');
}

const firstLine = (text) => String(text ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';
const clamp = (value, low, high) => Math.max(low, Math.min(value, high));

function codeOf(session) {
  if (['approval', 'input'].includes(session.status)) return 'w';
  if (session.status === 'failed') return 'f';
  if (session.status === 'running') return 'r';
  if (session.status === 'offline') return 'o';
  return 'i';
}

/** Status and one lens line for a message that did not go out. */
function sendFailure(agent, error) {
  const name = agents.get(agent).name;
  const native = {
    'session-working': '它正在回复，稍后再发', 'existing-draft': 'Mac 输入框里有没发的字',
    'bring-target-app-to-front': '要先把 ' + name + ' 切到前台', 'composer-focus-failed': '要先把 ' + name + ' 切到前台',
    'main-chat-not-selected': '先在 Mac 上打开 Muse 主对话', 'main-bot-not-selected': '先在 Mac 上打开 Grok Bot 主对话',
    'send-not-confirmed': '没确认发出，请到电脑上看',
  }[error.nativeCode];
  if (native) return [error.nativeCode === 'session-working' ? 'busy' : 'fail', fitBytes(native)];
  if (error instanceof ApiError && error.status === 409) return ['busy', '它正在忙，稍后再发'];
  return ['fail', fitBytes(error instanceof ApiError ? '没发出去：' + error.message : '没发出去，请到电脑上看')];
}

/* ---------- simple mode: one stream of what every session said, tool calls left out ---------- */

const glyph = { codex: '0', claude: '1', muse: '2', grok: '3', dsh: '4', zongguan: '5', hermes: '6', antigravity: '7' };
const pad = (value, size) => String(value).padStart(size, '0');
const itemId = (seq) => pad(seq.toString(36), 4);
const room = 186; // stream rows run from y 10 to y 196
// Row codes, first byte of every stream row; the second byte is the agent (0 Codex, 1 Claude, 2 Muse, 3 Grok).
//   L session label   A a Q  first line of something said (fresh / older / waiting for you)   C c q  its next line
//   M a message you sent (3 digits of bubble width follow)   W it is working   P the microphone
const fixedHeight = { L: 22, M: 36, W: 18, P: 36 };
const continued = new Set(['C', 'c', 'q']);
const starts = new Set(['L', 'A', 'a', 'Q', 'M', 'P']);
/** Pixel height of each row; the lens adds the same 6-pixel gap after the last line of an item. */
export function rowHeights(rows) {
  return rows.map((row, i) => fixedHeight[row[0]] ?? 25 + (continued.has(rows[i + 1]?.[0]) ? 0 : 6));
}
const sum = (values) => values.reduce((total, value) => total + value, 0);
const asking = /[?？]\s*$/;
const softAnswer = { y: '可以', n: '先不要' };
const firstSentence = (text) => {
  const line = firstLine(text);
  return line.match(/^.+?[。？！?!](?=\s|$|[^.?!])/u)?.[0] ?? line;
};


/* ---------- agent pages: each agent's latest session, read like a terminal ---------- */

const lensSize = 18; // font size of the lines on a request card or update card
const pageSize = 24; // font size of a page line and a directory row (spare/app.json l1-l7, e1, e2)
const lensColumn = 512; // text column, x 14 to 526
const boxColumn = 488; // inside the outline around a message you sent
const lensCap = 62; // bytes of text after the one-byte line code
const directoryDays = 14;
const directoryLimit = 30;
const windowLines = 16; // lines per page reply, d1 (top) to d16
const keepLines = 400;
// The glasses' page: rows of 30 pixels plus the gap above some of them, 128 pixels tall, at most 4 rows (main.ss gapof).
const rowGap = { v: 12, r: 12, c: 10, j: 10, b: 5, i: 5 };
const pageHeight = 128;
const pageRow = 30;

/**
 * How many lines up from the newest the page should sit so the newest Agent message shows from its first line
 * (c or j) at the top: 0 when it fits at the bottom or the newest message is yours. The glasses jump there when a
 * new message comes in while they follow the bottom, and when a page opens.
 */
export function headOffset(lines) {
  const at = (j) => lines[lines.length - 1 - j]?.[0];
  let s = -1;
  for (let j = 0; j < lines.length; j++) {
    if ('vurq'.includes(at(j))) return 0;
    if (at(j) === 'c' || at(j) === 'j') { s = j; break; }
  }
  for (let o = 0; o < s; o++) {
    let h = pageRow;
    for (let j = o; j < s; j++) h += pageRow + (rowGap[at(j)] ?? 0);
    if (h <= pageHeight) return o;
  }
  return Math.max(0, s);
}
// Codex, Claude Code and DeepSeek take a spoken message after the turn they are working on; Muse and Grok at once.
const queueAgents = new Set(['codex', 'claude', 'dsh', 'hermes']);
// Sessions that tools start for themselves (Vibe Island's summaries) are never an agent's latest.
const helperFolder = /\/\.vibe-island(?:\/|$)/;
// 总管 has one page and one stream of reports; its session code is fixed so the glasses can skip its own cards.
const zongguanKey = 'zongguan:zg';
const zongguanCode = 'zg00';
const base36 = '0123456789abcdefghijklmnopqrstuvwxyz';

function hash36(text, size = 2) {
  let value = 2166136261;
  for (const char of String(text)) value = Math.imul(value ^ char.codePointAt(0), 16777619) >>> 0;
  let out = '';
  for (let i = 0; i < size; i++) { out += base36[value % 36]; value = Math.floor(value / 36); }
  return out;
}

/** What you said, without what tools put around it; '' for rows that are not a person speaking. */
/** A message without the Relay receipt line the gateway adds for Claude Code. */
export const unstamped = (text) => String(text ?? '').replace(/\s*〔Relay 回执 [0-9a-z]{6}〕\s*$/, '');

export function spokenText(text) {
  let value = String(text ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (/^This session is being continued from a previous conversation/.test(value)) return '';
  const peer = /^<cross-session-message[^>]*>([\s\S]*?)<\/cross-session-message>\s*$/.exec(value);
  if (peer) value = peer[1].trim();
  value = unstamped(value);
  if (/^<pasted_content/.test(value)) return '（粘贴的内容）';
  if (/^<[a-z][a-z0-9_-]*[\s>]/i.test(value)) return '';
  return value;
}

/**
 * An agent's reply as lens paragraphs: Markdown marks dropped, headings and lines in bold kept as
 * emphasis. `gap` is 2 on the first line of the reply, 1 after a blank line, 0 otherwise.
 */
export function replyParagraphs(text) {
  const out = [];
  let gap = 2;
  let fence = false;
  for (const raw of String(text ?? '').replace(/\r/g, '').split('\n')) {
    if (/^\s*```/.test(raw)) { fence = !fence; if (gap < 1 && out.length) gap = 1; continue; }
    if (!raw.trim()) { if (gap < 1) gap = 1; continue; }
    let line = raw;
    let emph = false;
    if (!fence) {
      if (/\|/.test(line) && /^[\s|:-]+$/.test(line)) continue; // the rule under a table header
      const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line);
      if (heading) { line = heading[1]; emph = true; }
      if (/^\s*\*\*[^*]+\*\*[:：]?\s*$/.test(line)) emph = true;
      line = line.replace(/^\s*>\s?/, '').replace(/^\s*[-*+]\s+/, '• ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]*)`/g, '$1').replace(/\s*\|\s*/g, '  ').trim();
      if (!line) continue;
    }
    out.push({ emph, gap, text: line });
    gap = 0;
  }
  return out;
}

export class SpareGlasses {
  constructor(state, { submit, history, create, canCreate, zongguan = null, app = null, fetch: send = globalThis.fetch, idle = macIdle,
    stamp = (agent, id, text) => text, agents = order } = {}) {
    // The agents the user turned on in relay setup, in the capsule's order.
    this.agents = agents;
    this.idle = idle;
    this.stamp = stamp;
    this.zongguan = zongguan;
    this.statuses = new Map([...state.sessions].map(([key, session]) => [key, session.status]));
    this.workingAt = new Map(); // session key -> when its current turn started
    this.told = new Map(); // session key -> seq of the last reply sent as a notification
    this.state = state;
    this.submit = submit;
    this.history = history;
    this.create = create;
    this.canCreate = canCreate ?? (() => false);
    this.envApp = appPattern.test(app ?? '') ? app : null;
    this.send = send;
    this.ids = new Map(); // session key -> short id (≤ 6 bytes, fits the 10-byte request argument)
    this.keys = new Map();
    this.counter = 0;
    this.drafts = new Map();
    this.held = new Map(); // target -> { text, at }: speech heard in pieces, waiting for the wearer to finish
    this.transcripts = new Map();
    this.clients = new Set();
    this.log = [];
    this.eventId = 0;
    this.known = new Set([...state.requests.keys()]);
    this.notifyQueue = [];
    this.notifyAt = 0;
    this.timers = new Set();
    this.feed = []; // { seq, key, agent, kind: 'said' | 'me' | 'ask', text, at, request? }, oldest first
    this.feedSeq = 0;
    this.heard = new Map(); // session key -> { ids: Set of history row ids already in the feed, at }
    this.refreshing = new Map();
    this.activeAt = 0; // last request from the glasses app
    this.catching = null;
    this.draftSeq = 0;
    this.pushed = '';
    this.queued = new Map(); // session key -> [{ id, text, at, native }] spoken messages waiting for the turn to end
    this.lensCache = new Map(); // session key -> { sign, lines, messages }
    this.moves = new Map(); // session key -> how often it said something mid-turn
    this.viewing = new Map(); // agent -> { key }: the session the glasses keep on that agent's page, which leaves updatedAt alone
    this.actions = new Map(); // session key -> the tool call it runs right now, from agents that report one live
    this.onEvent = (event) => {
      if (event.kind === 'action' && event.session) {
        // A new action changes the page version, so the glasses read the page with it.
        const key = event.agent + ':' + event.session;
        if (event.tool) this.actions.set(key, event.tool); else this.actions.delete(key);
        this.moves.set(key, (this.moves.get(key) ?? 0) + 1);
        this.schedule();
        return;
      }
      if (['attention', 'session', 'connection', 'activity'].includes(event.kind)) {
        if (event.kind === 'activity' && event.session) {
          const key = event.agent + ':' + event.session;
          this.moves.set(key, (this.moves.get(key) ?? 0) + 1);
        }
        if (event.session) {
          this.transcripts.delete(event.agent + ':' + event.session);
          this.lensCache.delete(event.agent + ':' + event.session);
        }
        if (event.kind === 'attention') this.syncAsks();
        if (event.kind === 'session' && event.session) this.watchStatus(event.agent + ':' + event.session);
        // While someone wears the glasses, read what a changed session said; otherwise catch up when they come back.
        if (event.session && event.kind !== 'connection' && this.active()) this.queueRefresh(event.agent + ':' + event.session);
        this.schedule();
      }
    };
    state.on('event', this.onEvent);
    // Every change of 总管's view or reports goes out like a session's.
    this.onZongguan = () => this.schedule();
    zongguan?.on?.('change', this.onZongguan);
  }

  close() {
    this.state.off('event', this.onEvent);
    this.zongguan?.off?.('change', this.onZongguan);
    for (const timer of this.timers) clearTimeout(timer);
    for (const client of this.clients) client.end();
  }

  later(callback, ms) {
    const timer = setTimeout(() => { this.timers.delete(timer); callback(); }, ms);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  /* ----- sessions as the lens lists them ----- */

  shortId(key) {
    let id = this.ids.get(key);
    if (!id) {
      id = (++this.counter).toString(36);
      this.ids.set(key, id);
      this.keys.set(id, key);
    }
    return id;
  }

  /* ----- what a session said last, for the list's preview ----- */

  async preview(session) {
    const reply = await this.lastReply(session);
    if (reply) return reply;
    const code = codeOf(session);
    return code === 'r' ? '正在工作' : code === 'f' ? '上一轮失败' : '';
  }

  async transcript(session) {
    const key = session.agent + ':' + session.id;
    const cached = this.transcripts.get(key);
    if (cached && cached.at > Date.now() - 5000) return cached.rows;
    let rows = null;
    try {
      rows = await Promise.race([
        Promise.resolve(this.history(session.agent, session.id, { tools: true })),
        new Promise((resolve) => this.later(() => resolve(null), 3000)),
      ]);
    } catch { rows = null; }
    rows = Array.isArray(rows) ? rows : null;
    if (rows) this.transcripts.set(key, { at: Date.now(), rows });
    return rows;
  }

  /** Latest assistant reply of a session, or '' when history is slow or unavailable. */
  async lastReply(session) {
    const rows = await this.transcript(session);
    return [...(rows ?? [])].reverse().find((row) => row.role === 'assistant')?.text ?? '';
  }

  /* ----- voice: the phone dictates, the Mac keeps a draft until the wearer clicks send ----- */

  /**
   * The phone ends a dictation after a short pause, so the glasses keep listening and send what they hear in pieces:
   * `-<target>` starts a message, `.<target>` adds to it. The lens shows how it ends so far.
   */
  hold(arg, input) {
    const key = arg.slice(1);
    const text = typeof input.text === 'string' ? input.text.trim() : '';
    // A round that heard nothing means the wearer has stopped: send what was held instead of listening again.
    if (arg[0] === '.' && !text) return this.release(key);
    const kept = arg[0] === '.' && this.held.get(key)?.at > Date.now() - 300000 ? this.held.get(key).text : '';
    const joined = (!kept || !text ? kept + text : kept + (/[，。！？、；：,.!?;:]$/.test(kept) ? '' : '，') + text).slice(0, 4000);
    this.held.set(key, { text: joined, at: Date.now() });
    const tail = [...joined];
    while (Buffer.byteLength(tail.join('')) > 63) tail.shift();
    return { st: 'held', h: tail.join('') };
  }

  /** The wearer is done (a click, or a second pause): what the pieces add up to goes out as one message. */
  release(key) {
    const held = this.held.get(key);
    this.held.delete(key);
    return this.say(key, { text: held?.at > Date.now() - 300000 ? held.text : '' });
  }

  dropDraft(arg) {
    this.drafts.delete(arg ?? '');
    return { st: 'dropped' };
  }

  /* ----- simple mode: the stream ----- */

  active() { return Date.now() - this.activeAt < 600000; }

  /** A request from the glasses; after a long break, read what every recently active session said meanwhile. */
  touch() {
    const idle = !this.active();
    this.activeAt = Date.now();
    if (idle && !this.catching) {
      this.catching = this.catchUp().catch(() => {}).finally(() => { this.catching = null; this.schedule(); });
    }
  }

  async catchUp() {
    this.syncAsks();
    const cutoff = Date.now() - 24 * 3600000;
    const sessions = [...this.state.sessions.values()]
      .filter((session) => session.capabilities.includes('history') && (session.updatedAt ?? 0) > cutoff)
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 20).reverse();
    for (const session of sessions) {
      const key = session.agent + ':' + session.id;
      const heard = this.heard.get(key);
      if (heard && (session.updatedAt ?? 0) <= heard.at) continue;
      // First sight of a session: only its latest reply, so a long history does not flood the stream.
      await this.refresh(key, heard ? 'all' : 'last');
    }
  }

  queueRefresh(key) {
    if (this.refreshing.has(key)) return;
    this.refreshing.set(key, this.later(() => {
      this.refresh(key, 'turn').catch(() => {}).finally(() => this.refreshing.delete(key));
    }, 1500));
  }

  /**
   * Read a session's history and add the rows the stream has not seen. On first sight `last` adds only the latest
   * reply and `turn` adds the latest exchange (your message and what came after); `all` is for sessions seen before.
   */
  async refresh(key, first = 'turn') {
    const session = this.state.sessions.get(key);
    if (!session?.capabilities.includes('history')) return;
    this.transcripts.delete(key); // a refresh always reads the session again
    const rows = await this.transcript(session);
    if (!rows) return;
    const talk = rows.filter((row) => ['assistant', 'user'].includes(row.role) && row.id && String(row.text ?? '').trim());
    let heard = this.heard.get(key);
    let fresh;
    if (heard) fresh = talk.filter((row) => !heard.ids.has(String(row.id)));
    else {
      heard = { ids: new Set(), at: 0 };
      this.heard.set(key, heard);
      const lastUser = talk.findLastIndex((row) => row.role === 'user');
      fresh = first === 'last' ? talk.filter((row) => row.role === 'assistant').slice(-1)
        : first === 'turn' ? talk.slice(Math.max(lastUser, 0)).slice(-4) : talk;
      for (const row of talk) heard.ids.add(String(row.id));
    }
    for (const row of fresh) {
      heard.ids.add(String(row.id));
      this.add({ key, agent: session.agent, kind: row.role === 'assistant' ? 'said' : 'me', text: row.text });
    }
    if (heard.ids.size > 800) heard.ids = new Set(talk.map((row) => String(row.id)));
    heard.at = Date.now();
    if (fresh.length) this.schedule();
  }

  add(item) {
    this.feed.push({ seq: ++this.feedSeq, at: Date.now(), ...item });
    if (this.feed.length > 300) this.feed.shift();
  }

  askText(request) {
    if (request.kind === 'input') return firstLine(request.questions?.[0]?.text || request.description) || '要你回答';
    return (titles[request.title] ?? request.title) + '：' + (firstLine(displayCommand(request.command)) || firstLine(request.description));
  }

  /** Every request that waits for the wearer becomes one item of the stream. */
  syncAsks() {
    const listed = new Set(this.feed.filter((item) => item.kind === 'ask').map((item) => item.request));
    for (const request of [...this.state.requests.values()].sort((a, b) => a.at - b.at)) {
      if (listed.has(request.id)) continue;
      this.add({ key: request.agent + ':' + request.session, agent: request.agent, kind: 'ask', text: this.askText(request),
        request: request.id });
    }
  }

  lastSeq() {
    const last = new Map();
    for (const item of this.feed) last.set(item.key, item.seq);
    return last;
  }

  /**
   * What an item still waits for: `y` an approval, `i` an answer to a question, `s` a reply to a question the agent
   * ended its turn with (its last words end in a question mark and nothing came after), or '' for nothing.
   */
  pendingOf(item, last = this.lastSeq()) {
    if (item.kind === 'ask') {
      const request = this.state.requests.get(item.request);
      return request ? (request.kind === 'input' ? 'i' : 'y') : '';
    }
    if (item.kind !== 'said' || !asking.test(item.text) || item.at < Date.now() - 3 * 3600000) return '';
    const session = this.state.sessions.get(item.key);
    if (!session?.capabilities.includes('send') || session.status === 'running') return '';
    if ([...this.state.requests.values()].some((request) => request.agent + ':' + request.session === item.key)) return '';
    return last.get(item.key) === item.seq ? 's' : '';
  }

  pendingItems() {
    const last = this.lastSeq();
    return this.feed.map((item) => ({ item, pending: this.pendingOf(item, last) })).filter((entry) => entry.pending);
  }

  /** Four agents, each a state letter (w waits for you, r running, i idle, o offline) and how many sessions are busy. */
  rail(pending = this.pendingItems()) {
    return this.agents.map((agent) => {
      const waiting = new Set(pending.filter(({ item }) => item.agent === agent).map(({ item }) => item.key));
      const running = [...this.state.sessions.values()]
        .filter((session) => session.agent === agent && session.status === 'running' && !waiting.has(agent + ':' + session.id));
      const connection = this.state.online.get(agent) ?? 'unconfigured';
      const code = waiting.size ? 'w' : running.length ? 'r' : ready.has(connection) ? 'i' : 'o';
      return code + Math.min(9, waiting.size + running.length);
    }).join('');
  }

  sessionOf(key) {
    const session = this.state.sessions.get(key);
    if (session) return session;
    const agent = key.slice(0, key.indexOf(':'));
    return { agent, id: key.slice(agent.length + 1), name: agents.get(agent)?.name ?? agent, status: 'offline', capabilities: [] };
  }

  /** A short name for a session; the folder, or how long ago, is added only when two sessions share the name. */
  label(session) {
    const base = one(session.name, 15, 100);
    const folder = (cwd) => String(cwd ?? '').split('/').filter(Boolean).at(-1) ?? '';
    const twins = [...this.state.sessions.values()]
      .filter((other) => other.agent === session.agent && other.id !== session.id && one(other.name, 15, 100) === base);
    if (!twins.length) return base;
    const mine = folder(session.cwd);
    const extra = mine && twins.every((other) => folder(other.cwd) !== mine) ? mine : age(session.updatedAt, Date.now());
    return one(base + ' · ' + extra, 15, 200);
  }

  itemRows(item, previous, pending, fresh) {
    const g = glyph[item.agent];
    const rows = [];
    if (item.key !== previous) rows.push('L' + g + this.label(this.sessionOf(item.key)));
    if (item.kind === 'me') {
      const text = one(item.text, 20, 300);
      rows.push('M' + g + pad(Math.round(measure(text, 20)) + 28, 3) + text);
    } else {
      const [head, next] = pending ? ['Q', 'q'] : fresh ? ['A', 'C'] : ['a', 'c'];
      wrap(item.text, 20, 2, 392).forEach((line, i) => rows.push(fitBytes((i ? next : head) + g + line)));
    }
    return rows;
  }

  /**
   * Every stop of the stream: one per item, the microphone last. Only the last 30 items are shown, plus anything
   * older that still waits for you, so leaving the stream (turning past its top) stays a short turn of the crown.
   */
  stops() {
    const last = this.lastSeq();
    const recent = Date.now() - 600000;
    const stops = [];
    let previous = null;
    const from = this.feed.length - 30;
    for (const [index, item] of this.feed.entries()) {
      const pending = this.pendingOf(item, last);
      if (index < from && !pending) continue;
      const rows = this.itemRows(item, previous, pending, item.at > recent);
      if (last.get(item.key) === item.seq && this.state.sessions.get(item.key)?.status === 'running') rows.push('W' + glyph[item.agent]);
      stops.push({ id: itemId(item.seq), rows });
      previous = item.key;
    }
    stops.push({ id: '0000', rows: ['P0'] });
    return stops;
  }

  /**
   * The rows that fit on the lens around stop `cursor` ('e' = the newest end). At the end the rows sit on the bottom
   * edge like a chat, and the last lines of the item above fill what is left at the top.
   */
  feedView(cursor) {
    const stops = this.stops();
    const n = stops.length;
    const at = /^\d{1,4}$/.test(cursor) ? clamp(Number(cursor), 0, n - 1) : n - 1;
    const size = (stop) => sum(rowHeights(stop.rows));
    let a = at;
    let b = at;
    let used = size(stops[at]);
    while (a > 0 && used + size(stops[a - 1]) <= room) used += size(stops[--a]);
    while (b < n - 1 && used + size(stops[b + 1]) <= room) used += size(stops[++b]);
    const count = () => sum(stops.slice(a, b + 1).map((stop) => stop.rows.length));
    while (count() > 8 && a < at) used -= size(stops[a++]);
    while (count() > 8 && b > at) used -= size(stops[b--]);
    let rows = stops.slice(a, b + 1).flatMap((stop) => stop.rows);
    let y = 10;
    if (b === n - 1) {
      if (a > 0) {
        const above = stops[a - 1].rows;
        const heights = rowHeights(above);
        let spare = room - used;
        let k = above.length;
        const tail = [];
        while (k > 1 && rows.length + tail.length < 8 && spare >= heights[k - 1]) { spare -= heights[--k]; tail.unshift(above[k]); }
        // The peeking rows are not a stop of their own.
        while (tail.length && ['L', 'M'].includes(tail[0][0])) tail.shift();
        if (tail.length && starts.has(tail[0][0])) tail[0] = { A: 'C', a: 'c', Q: 'q' }[tail[0][0]] + tail[0].slice(1);
        used += sum(rowHeights(tail));
        rows = [...tail, ...rows];
      }
      y = 10 + room - used;
    }
    const values = { n: String(n), p: String(a), y: String(y), i: stops.slice(a, b + 1).map((stop) => stop.id).join(''),
      g: this.rail(), f: String(this.feedSeq) };
    rows.forEach((row, index) => { values['d' + (index + 1)] = row; });
    for (let index = rows.length; index < 8; index++) values['d' + (index + 1)] = '';
    return values;
  }

  /** Silent view: the rail, the newest thing said (the lens flashes it once) and the newest thing waiting for you. */
  top() {
    const pending = this.pendingItems();
    const said = this.feed.findLast((item) => item.kind === 'said');
    const ask = pending.at(-1);
    const values = { f: String(this.feedSeq), g: this.rail(pending), n: String(pending.length),
      a: said ? glyph[said.agent] : '', i: said ? itemId(said.seq) : '', h: said ? one(firstSentence(said.text), 20, 380) : '',
      k: ask?.pending ?? '', id: ask ? itemId(ask.item.seq) : '', w: ask ? glyph[ask.item.agent] : '',
      d1: ask ? this.label(this.sessionOf(ask.item.key)) : '' };
    const lines = ask ? wrap(ask.item.text, 24, 3, 420) : [];
    for (let index = 0; index < 3; index++) values['d' + (index + 2)] = lines[index] ?? '';
    return values;
  }

  /** Coming back after a while: who said how much, each session's latest words, and what waits. */
  back(arg) {
    const seen = Number.parseInt(arg, 10) || 0;
    const since = this.feed.filter((item) => item.seq > seen && item.kind !== 'me');
    const latest = new Map();
    for (const item of since) { latest.delete(item.key); latest.set(item.key, item); }
    const rows = [...latest.values()].slice(-3)
      .map((item) => glyph[item.agent] + one(this.label(this.sessionOf(item.key)) + '：' + item.text, 20, 400));
    const ask = this.pendingItems().at(-1);
    return { h: latest.size + ' 个会话说了 ' + since.length + ' 段', d1: rows[0] ?? '', d2: rows[1] ?? '', d3: rows[2] ?? '',
      k: ask?.pending ?? '', d4: ask ? glyph[ask.item.agent] + one(ask.item.text, 20, 380) : '', n: String(since.length) };
  }

  findItem(id) {
    const seq = Number.parseInt(id, 36);
    return this.feed.find((item) => item.seq === seq);
  }

  shortOf(key) { return pad(this.shortId(key), 4); }

  keyOfShort(id) { return this.keys.get(String(id).replace(/^0+/, '')); }

  /** One item, opened: the whole text in pages of three lines, and what can be done with it. */
  item(arg) {
    const match = /^([0-9a-z]{4})(\d)$/.exec(arg ?? '');
    if (!match) throw new ApiError(400, 'Invalid item reference.');
    const item = this.findItem(match[1]);
    const blank = { a: '', w: '0', n: '1', p: '0', id: '', d2: '', d3: '' };
    if (!item) return { ...blank, k: 'z', h: '', d1: '这条已经不在了' };
    const session = this.sessionOf(item.key);
    const request = item.kind === 'ask' ? this.state.requests.get(item.request) : null;
    const text = request ? [this.askText(request), request.description, displayCommand(request.command)]
      .filter(Boolean).filter((value, index, all) => all.indexOf(value) === index).join('\n') : item.text;
    const lines = wrap(text, 24, 27, 500);
    const pages = Math.max(1, Math.ceil(lines.length / 3));
    const page = clamp(Number(match[2]), 0, pages - 1);
    const [d1 = '', d2 = '', d3 = ''] = lines.slice(page * 3, page * 3 + 3);
    return { k: this.pendingOf(item) || (item.kind === 'me' ? 'u' : 'm'), a: glyph[item.agent],
      h: one(shortName[item.agent] + ' · ' + this.label(session), 15, 470), d1, d2, d3,
      w: session.capabilities.includes('send') ? '1' : '0', n: String(pages), p: String(page), id: this.shortOf(item.key) };
  }

  /** ✓ or ✗ on something that waits: approve or decline a request, or answer the agent's question in two words. */
  async answer(arg) {
    const match = /^([0-9a-z]{4})([yn])$/.exec(arg ?? '');
    if (!match) throw new ApiError(400, 'Invalid answer.');
    const item = this.findItem(match[1]);
    const pending = item ? this.pendingOf(item) : '';
    if (!pending) return { st: 'gone', h: '已经处理过了' };
    const yes = match[2] === 'y';
    try {
      if (pending === 'y') {
        const request = this.state.requests.get(item.request);
        if (yes && request.approvalAllowed === false) return { st: 'fail', h: '这条要在电脑上批准' };
        await this.state.decide(item.request, { decision: yes ? 'accept' : 'decline' });
        return { st: 'ok', h: yes ? '已批准' : '已拒绝' };
      }
      if (pending === 'i') return { st: 'fail', h: '这个问题要说话回答' };
      const session = this.sessionOf(item.key);
      await this.submit(item.agent, session.id, softAnswer[match[2]], randomUUID());
      return { st: 'ok', h: '已回复：' + softAnswer[match[2]] };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && pending === 'y') return { st: 'gone', h: '已经处理过了' };
      const [st, text] = sendFailure(item.agent, error);
      return { st, h: text };
    }
  }

  sessionRank(session, pending) {
    if (pending.some(({ item }) => item.key === session.agent + ':' + session.id)) return 0;
    return session.status === 'running' ? 1 : 2;
  }

  /**
   * One agent's sessions, four rows at a time: waiting for you, running, then most recent; "new" last.
   * `arg` is the agent letter and a row number, or the letter, "s" and a session's short id to land on that session.
   */
  async sessions(arg) {
    const match = /^([ckmgdhv])(?:(\d{1,3})|s([0-9a-z]{4}))$/.exec(arg ?? '');
    if (!match) throw new ApiError(400, 'Invalid list reference.');
    const agent = byLetter[match[1]];
    const pending = this.pendingItems();
    const list = [...this.state.sessions.values()].filter((session) => session.agent === agent)
      .sort((a, b) => this.sessionRank(a, pending) - this.sessionRank(b, pending) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const rows = [...list, ...(this.canCreate(agent) ? [null] : [])];
    const n = rows.length;
    const land = match[3] ? this.keyOfShort(match[3]) : null;
    const at = land ? list.findIndex((session) => agent + ':' + session.id === land) : -1;
    const p = clamp(match[3] ? Math.max(0, at) : Number(match[2]), 0, Math.max(0, n - 1));
    const start = clamp(p - 1, 0, Math.max(0, n - 4));
    const values = { n: String(n), p: String(p), y: String(start),
      h: shortName[agent] + ' · ' + list.length + ' 个会话', i: '' };
    const window = rows.slice(start, start + 4);
    const previews = await Promise.all(window.map((session) => (session ? this.preview(session)
      .catch(() => '') : '')));
    window.forEach((session, k) => {
      if (!session) {
        values.i += '----';
        values['d' + (k + 1)] = '+' + glyph[agent] + (agent === 'muse' ? '新对话' : '新会话');
        values['d' + (k + 5)] = '';
        return;
      }
      const rank = this.sessionRank(session, pending);
      const canSend = session.capabilities.includes('send');
      const code = rank === 0 ? 'w' : rank === 1 ? 'r' : 'i';
      const name = one(session.name, 20, 150);
      const x = Math.max(210, 48 + Math.round(measure(name, 20)) + 16);
      values.i += this.shortOf(agent + ':' + session.id);
      values['d' + (k + 1)] = (canSend ? code : code.toUpperCase()) + glyph[agent] + name;
      // Sessions with the same name get their folder or age in front of the preview, as the stream labels them.
      const tag = this.label(session).slice(one(session.name, 15, 100).length).replace(/^ · /, '');
      const preview = (tag ? tag + ' · ' : '') + firstSentence(previews[k]);
      values['d' + (k + 5)] = pad(x, 3) + (canSend ? one(preview, 15, 516 - x) : one(preview, 15, 460 - x) + ' · 只读');
    });
    for (let k = window.length; k < 4; k++) { values['d' + (k + 1)] = ''; values['d' + (k + 5)] = ''; }
    return values;
  }

  /** One session, newest at the bottom; `scroll` counts items back from the newest. */
  async session(arg) {
    const match = /^([0-9a-z]{4})\.(\d{1,3})$/.exec(arg ?? '');
    if (!match) throw new ApiError(400, 'Invalid session reference.');
    const key = this.keyOfShort(match[1]);
    const session = key ? this.sessionOf(key) : null;
    const values = { n: '0', p: '0', y: '34', h: '', w: '0' };
    for (let k = 1; k <= 8; k++) values['d' + k] = '';
    if (!session) return { ...values, h: '这个会话已经不在了' };
    const g = glyph[session.agent];
    const rows = (await this.transcript(session)) ?? [];
    const talk = rows.filter((row) => ['assistant', 'user'].includes(row.role) && String(row.text ?? '').trim()).slice(-40);
    const blocks = talk.map((row) => {
      if (row.role === 'user') {
        const text = one(row.text, 20, 380);
        return ['M' + g + pad(Math.round(measure(text, 20)) + 28, 3) + text];
      }
      return wrap(row.text, 20, 3, 500).map((line, i) => fitBytes((i ? 'C' : 'A') + g + line));
    });
    // The dots ride on the last block, so the first turn of the crown goes to the previous message, not past the dots.
    if (session.status === 'running') blocks.length ? blocks.at(-1).push('W' + g) : blocks.push(['W' + g]);
    const n = blocks.length;
    const scroll = clamp(Number(match[2]), 0, Math.max(0, n - 1));
    const space = 160;
    // The gap after the bottom row is never seen, so it does not take room.
    const height = (rows) => sum(rowHeights(rows)) - (rows.length && 'ACaQcq'.includes(rows.at(-1)[0]) ? 6 : 0);
    const fits = (rows) => rows.length <= 8 && height(rows) <= space;
    const end = n - 1 - scroll;
    let start = end;
    let picked = end >= 0 ? [...blocks[end]] : [];
    while (start > 0 && fits([...blocks[start - 1], ...picked])) picked = [...blocks[--start], ...picked];
    while (picked.length && !fits(picked)) picked.shift();
    // A message that does not fit whole above still shows its last lines, so the page reads on instead of leaving a gap.
    for (let i = (blocks[start - 1]?.length ?? 0) - 1; i > 0 && fits([blocks[start - 1][i], ...picked]); i--) {
      picked = [blocks[start - 1][i], ...picked];
    }
    Object.assign(values, { n: String(n), p: String(scroll), y: String(34 + space - height(picked)),
      h: one(shortName[session.agent] + ' · ' + session.name, 15, 440), w: session.capabilities.includes('send') ? '1' : '0' });
    picked.forEach((row, k) => { values['d' + (k + 1)] = row; });
    return values;
  }

  /** Where a spoken message can go: every session that takes messages, most recent first, then a new one per agent. */
  targets() {
    const live = [...this.state.sessions.values()]
      .filter((session) => session.capabilities.includes('send') && session.status !== 'offline')
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .map((session) => ({ agent: session.agent, key: session.agent + ':' + session.id }));
    return [...live, ...this.agents.filter((agent) => this.canCreate(agent)).map((agent) => ({ agent, fresh: true }))];
  }

  pick(arg) {
    const list = this.targets();
    const n = list.length;
    if (!n) return { n: '0', p: '0', y: '0', i: '', h: '没有能发的会话', id: '' };
    const p = clamp(Number.parseInt(arg, 10) || 0, 0, n - 1);
    const start = clamp(p - 2, 0, Math.max(0, n - 6));
    const target = list[p];
    return { n: String(n), p: String(p), y: String(start),
      i: list.slice(start, start + 6).map((item) => glyph[item.agent] + (item.fresh ? 'n' : 's')).join(''),
      h: target.fresh ? (target.agent === 'muse' ? '新对话' : '新会话') : this.label(this.sessionOf(target.key)),
      id: target.fresh ? 'n' + letters[target.agent] : 's' + this.shortOf(target.key) };
  }

  targetOf(ref) {
    if (/^n[ckmgdhv]$/.test(ref ?? '')) {
      const agent = byLetter[ref[1]];
      return this.canCreate(agent) ? { create: agent } : null;
    }
    const session = /^s[0-9a-z]{4}$/.test(ref ?? '') ? this.keyOfShort(ref.slice(1)) : null;
    if (session) return { key: session };
    if (/^a[0-9a-z]{4}$/.test(ref ?? '')) {
      const item = this.findItem(ref.slice(1));
      return item ? { key: item.key, item: item.seq } : null;
    }
    return null;
  }

  /** The phone heard the wearer; keep the words as a draft. `arg` names where they go, or '' to choose afterwards. */
  talk(arg, input) {
    const target = arg ? this.targetOf(arg) : { later: true };
    const values = { st: 'gone', dk: '', h: '', d1: '这件事已经处理完了', d2: '', d3: '' };
    if (!target) return values;
    const text = typeof input.text === 'string' ? input.text.trim().slice(0, 4000) : '';
    if (!text) return { ...values, st: 'empty', d1: '没听到内容' };
    const now = Date.now();
    for (const [key, draft] of this.drafts) if (draft.at < now - 300000) this.drafts.delete(key);
    const dk = 'v' + (this.draftSeq = (this.draftSeq + 1) % 46656).toString(36);
    this.drafts.set(dk, { ...target, text, at: now });
    const [d1 = '', d2 = '', d3 = ''] = wrap(text, 24, 3, 500);
    return { st: 'draft', dk, h: this.whoOf(target), d1, d2, d3 };
  }

  whoOf(target) {
    if (target.later) return '';
    if (target.create) return shortName[target.create] + ' · ' + (target.create === 'muse' ? '新对话' : '新会话');
    return one(shortName[this.sessionOf(target.key).agent] + ' · ' + this.label(this.sessionOf(target.key)), 15, 470);
  }

  /** Send a draft: `dk`, or `dk.<target>` when the target was picked after speaking. */
  async deliver(arg) {
    const [dk, ref] = String(arg ?? '').split('.');
    const draft = this.drafts.get(dk);
    if (!draft) return { st: 'gone', h: '草稿过期了，请重说' };
    const target = ref ? this.targetOf(ref) : draft.later ? null : draft;
    if (!target) return { st: 'gone', h: '要先选发给谁' };
    this.drafts.delete(dk);
    if (target.create) {
      try {
        await this.create(target.create, draft.text);
        return { st: 'sent', h: '已开始' + (target.create === 'muse' ? '新对话' : '新会话') };
      } catch (error) {
        return { st: 'fail', h: fitBytes(error instanceof ApiError ? '没开成：' + error.message : '没开成，请到电脑上看') };
      }
    }
    const session = this.sessionOf(target.key);
    try {
      const item = target.item ? this.feed.find((entry) => entry.seq === target.item) : null;
      const request = item?.kind === 'ask' ? this.state.requests.get(item.request) : null;
      if (request) {
        if (request.kind !== 'input' || request.questions?.length !== 1) throw new ApiError(409, 'Answer on the computer.');
        await this.state.decide(request.id, { answers: { [request.questions[0].id]: draft.text } });
        return { st: 'sent', h: '已回答' };
      }
      await this.submit(session.agent, session.id, draft.text, randomUUID());
      return { st: 'sent', h: '已发给 ' + this.label(session) };
    } catch (error) {
      const [st, text] = sendFailure(session.agent, error);
      return { st, h: text };
    }
  }

  /* ----- agent pages ----- */

  requestOf(session) {
    let found = null;
    for (const request of this.state.requests.values()) {
      if (request.agent === session.agent && request.session === session.id && (!found || request.at > found.at)) found = request;
    }
    return found;
  }

  /** The session of `agent` used last: the newest activity, a question it asks counting as activity. */
  latest(agent, except = null) {
    let best = null;
    let score = null;
    for (const session of this.state.sessions.values()) {
      if (session.agent !== agent || helperFolder.test(session.cwd ?? '') || agent + ':' + session.id === except) continue;
      const at = this.activityOf(session);
      const mine = [session.status === 'offline' ? 0 : 1, at];
      if (!score || mine[0] > score[0] || (mine[0] === score[0] && mine[1] > score[1])) { best = session; score = mine; }
    }
    return best;
  }

  requestCode(request) {
    if (!request) return '';
    return (request.kind === 'input' ? 'i' : 'y') + glyph[request.agent] + pad(this.shortId('r:' + request.id), 4);
  }

  activityOf(session) { return Math.max(session.updatedAt ?? 0, this.requestOf(session)?.at ?? 0); }

  /**
   * A session's code on the lens. It comes from the session's id, so the glasses' copy still names the
   * same session after the gateway restarts; a code that matches two sessions names neither.
   */
  sessionCode(key) { return key === zongguanKey ? zongguanCode : hash36(key, 4); }

  sessionByCode(agent, code) {
    const found = [...this.state.sessions.values()].filter((session) => session.agent === agent
      && this.sessionCode(agent + ':' + session.id) === code);
    return found.length === 1 ? found[0] : null;
  }

  /** The session on an agent's page: the one the glasses keep there, or else its latest. */
  viewedSession(agent) {
    const key = this.viewing.get(agent)?.key;
    return (key && this.state.sessions.get(key)) || this.latest(agent);
  }

  requestOfShort(id) {
    const key = this.keys.get(String(id ?? '').replace(/^0+/, ''));
    return key?.startsWith('r:') ? this.state.requests.get(key.slice(2)) ?? null : null;
  }

  /**
   * 总管's two characters, then three per enabled agent in the capsule's order: its glyph; w waits for you,
   * r working, i idle, o offline; how many of its sessions work. The glasses read which agents there are from it.
   */
  lensRail() {
    return this.zongguanRail() + this.agents.map((agent) => {
      const session = this.latest(agent);
      const busy = [...this.state.sessions.values()].filter((row) => row.agent === agent && working.has(row.status)).length;
      const code = session && this.requestOf(session) ? 'w' : session && working.has(session.status) ? 'r'
        : ready.has(this.state.online.get(agent) ?? 'unconfigured') ? 'i' : 'o';
      return glyph[agent] + code + Math.min(9, busy);
    }).join('');
  }

  /** 总管's column: w an unread report, r working, i idle, o off or absent. */
  zongguanRail() {
    const zongguan = this.zongguan;
    if (!zongguan?.enabled) return 'o0';
    return (zongguan.unread ? 'w' : zongguan.view().status === 'working' ? 'r' : 'i') + '0';
  }

  /** 总管's pair, then two characters per enabled agent (the rail's order) that change with its latest session, words or state. */
  versions() {
    return this.zongguanVersion() + this.agents.map((agent) => {
      const session = this.viewedSession(agent);
      if (!session) return '00';
      const key = agent + ':' + session.id;
      return hash36([key, session.updatedAt, session.status, (this.queued.get(key) ?? []).length,
        this.requestOf(session)?.id ?? '', this.moves.get(key) ?? 0].join('|'));
    }).join('');
  }

  /** 总管's pair: it changes with its status, its newest block and its card. */
  zongguanVersion() {
    if (!this.zongguan) return '00';
    const view = this.zongguan.view();
    const last = view.blocks.at(-1);
    return hash36([view.status, view.blocks.length, last?.at ?? 0, last?.text ?? '', view.openTasks, view.contextPct,
      this.zongguanCard(view)].join('|'));
  }

  /** The attention code of 总管's card: a request's own code, or "i5" and the short id of a confirmation. */
  zongguanCard(view) {
    const card = view.card;
    if (card?.kind === 'request') return this.requestCode(this.state.requests.get(card.requestId));
    if (card?.kind === 'confirm') return 'i5' + pad(this.shortId('zongguan:confirm:' + card.confirmId), 4);
    return '';
  }

  /** 总管's page: what it heard, did and said, as lens lines like a session's. */
  async zongguanPage(arg) {
    const values = { g: this.lensRail(), v: this.versions(), k: '', h: '', i: '' };
    for (let k = 1; k <= windowLines; k++) values['d' + k] = '';
    const zongguan = this.zongguan;
    if (!zongguan) { values.h = '总管没配好'; values.i = 'rdo000000000' + zongguanCode + '000'; return values; }
    if (zongguan.enabled) zongguan.markRead();
    const view = zongguan.view();
    const lines = [];
    let messages = 0;
    // Your words take one line and what 总管 looked at and sent is not shown; its replies show whole, since you act on them.
    for (const block of view.blocks) {
      if (block.kind === 'user') {
        messages += 1;
        lines.push('v' + wrap(block.text, pageSize, 1, boxColumn, lensCap)[0]);
      } else if (block.kind === 'reply') {
        messages += 1;
        for (const { emph, gap, text } of replyParagraphs(block.text)) {
          wrap(text, pageSize, Infinity, lensColumn, lensCap).forEach((line, i) => lines.push((emph ? 'hij' : 'abc')[i ? 0 : gap] + line));
        }
      } else if (block.kind === 'compacted') lines.push('a' + one(block.text, pageSize, lensColumn));
      else if (block.kind === 'error') lines.push('h' + wrap('✗ ' + block.text, pageSize, 1, lensColumn, lensCap)[0]);
    }
    const kept = lines.slice(-keepLines);
    const n = kept.length;
    const want = clamp(Number(arg), 0, Math.max(0, n - 1));
    const o = clamp(want - 4, 0, Math.max(0, n - windowLines));
    kept.slice(Math.max(0, n - o - windowLines), n - o).forEach((line, k) => { values['d' + (k + 1)] = line; });
    const status = view.status === 'working' ? 'r' : view.status === 'off' ? 'o' : 'i';
    values.i = 'wd' + status + pad(Math.min(n, 999), 3) + pad(Math.min(messages, 999), 3) + pad(o, 3) + zongguanCode
      + pad(Math.min(headOffset(kept), 999), 3) + (status === 'r' ? '整理中… ' + Math.max(0, Math.round((Date.now() - (view.since ?? Date.now())) / 1000)) + 's' : '');
    values.h = view.status === 'off' ? '总管没配好'
      : one('总管 · ' + view.openTasks + ' 件事 · 上下文 ' + view.contextPct + '%', 15, 296);
    values.k = this.zongguanCard(view);
    return values;
  }

  /** The page of a session as lens lines, oldest first, each starting with its line code. */
  async lensLines(session) {
    const key = session.agent + ':' + session.id;
    const rows = (await this.transcript(session)) ?? [];
    const lastAt = Math.max(0, ...rows.filter((row) => row.role === 'user').map((row) => row.at || 0));
    // A message sent to Claude's inbox is shown as queued until its transcript has a newer message of yours.
    const queued = (this.queued.get(key) ?? []).filter((item) => !item.native || item.at > lastAt);
    if (queued.length) this.queued.set(key, queued); else this.queued.delete(key);
    const sign = rows.length + ':' + (rows.at(-1)?.id ?? '') + ':' + queued.map((item) => item.id).join(',');
    const cached = this.lensCache.get(key);
    if (cached?.sign === sign) return cached;
    const lines = [];
    let messages = 0;
    for (const row of rows) {
      if (row.role === 'user') {
        const text = spokenText(row.text);
        if (!text) continue;
        messages += 1;
        wrap(text, pageSize, 3, boxColumn, lensCap).forEach((line, i) => lines.push((i ? 'u' : 'v') + line));
      } else if (row.role === 'assistant') {
        const paragraphs = replyParagraphs(row.text);
        if (!paragraphs.length) continue;
        messages += 1;
        for (const { emph, gap, text } of paragraphs) {
          wrap(text, pageSize, Infinity, lensColumn, lensCap)
            .forEach((line, i) => lines.push((emph ? 'hij' : 'abc')[i ? 0 : gap] + line));
        }
      }
    }
    for (const item of queued) {
      messages += 1;
      wrap(unstamped(item.text), pageSize, 3, boxColumn, lensCap).forEach((line, i) => lines.push((i ? 'q' : 'r') + line));
    }
    const result = { sign, lines: lines.slice(-keepLines), messages };
    this.lensCache.set(key, result);
    return result;
  }

  /** What a session said, as feed items the glasses show one by one; tools' own sessions are left out. */
  updates() {
    // While 总管 runs, it is the one voice on standby: its reports, not what each session said.
    if (this.zongguan?.enabled) {
      return this.zongguan.reports.map((report) => ({ kind: 'said', key: zongguanKey, agent: 'zongguan', seq: report.seq, text: report.text, at: report.at }));
    }
    return this.feed.filter((item) => item.kind === 'said' && !helperFolder.test(this.state.sessions.get(item.key)?.cwd ?? ''));
  }

  /**
   * Standby, and every push: the four agents, page versions followed by the seq of the newest words of any
   * session (the glasses fetch update cards when it grows), the newest question of any session and those words.
   */
  now() {
    const said = this.updates().at(-1);
    const asks = [...this.state.requests.values()].sort((a, b) => b.at - a.at);
    // The glasses read attention codes only here: a session's question first, else 总管's confirm card.
    const card = this.zongguan?.enabled ? this.zongguanCard(this.zongguan.view()) : '';
    return { g: this.lensRail(), v: this.versions() + (said ? glyph[said.agent] + said.seq : '0'),
      k: this.requestCode(asks[0]) || card, h: said ? one(firstSentence(said.text), 15, 330) : '' };
  }

  /**
   * The next update card: of the sessions that said something after feed item `after`, leaving out the one with
   * session code `skip` (on screen; "----" for none), the one that has waited longest, with the start of what it
   * said last. `k` is "u", the agent glyph and the session code; `i` is "U", how many sessions wait (at most 9)
   * and the seq of this item, or "U0" and the newest seq when none waits. d1–d3: up to three lens lines;
   * d4: one line for the capsule at the bottom of a page.
   */
  card(arg) {
    const match = /^u([0-9a-z]{4}|-{4})(\d{1,5})$/.exec(arg ?? '');
    if (!match) throw new ApiError(400, 'Invalid update reference.');
    const values = { k: '', h: '', i: '' };
    for (let k = 1; k <= 9; k++) values['d' + k] = '';
    const waiting = new Map(); // session key -> its newest item, in the order the sessions last spoke
    let top = 0;
    for (const item of this.updates()) {
      top = item.seq;
      if (item.seq <= Number(match[2]) || this.sessionCode(item.key) === match[1]) continue;
      waiting.delete(item.key);
      waiting.set(item.key, item);
    }
    const item = waiting.values().next().value;
    if (!item) { values.i = 'U0' + top; return values; }
    const text = replyParagraphs(item.text).map((paragraph) => paragraph.text).join('\n') || firstLine(item.text);
    const name = shortName[item.agent];
    values.k = 'u' + glyph[item.agent] + this.sessionCode(item.key);
    values.h = item.key === zongguanKey ? name + ' · 汇报' : one(name + ' · ' + this.label(this.sessionOf(item.key)), 15, 380);
    values.i = 'U' + Math.min(9, waiting.size) + item.seq;
    wrap(text, lensSize, 3, 492, 63).forEach((line, k) => { values['d' + (k + 1)] = line; });
    values.d4 = one(name + '：' + firstSentence(text), 15, 300);
    return values;
  }

  /**
   * One agent's latest session: `arg` is the agent letter and how many lines up from the newest the
   * wearer reads. The reply holds 16 lines around there; `i` packs state, counts and where they sit.
   */
  /**
   * The directory: every agent's sessions together, newest activity first (a question counts), from the
   * last 14 days, at most 30, eight rows around `arg` — a row number, or "s" and a session code to land on.
   * d1–d8: agent glyph, state (w r f i), session code, then name and state; d9–d16: the last thing said.
   */
  async directory(arg) {
    const match = /^(?:(\d{1,3})|s([0-9a-z]{4}))$/.exec(arg ?? '');
    if (!match) throw new ApiError(400, 'Invalid directory reference.');
    const now = Date.now();
    const list = [...this.state.sessions.values()]
      .filter((session) => !helperFolder.test(session.cwd ?? '') && this.activityOf(session) > now - directoryDays * 86400000)
      .sort((a, b) => this.activityOf(b) - this.activityOf(a)).slice(0, directoryLimit);
    // Row 0 starts a new session (the glasses' new-session page); the sessions follow from row 1.
    const rows = [null, ...list];
    const n = rows.length;
    const landed = match[2] ? rows.findIndex((session) => session && this.sessionCode(session.agent + ':' + session.id) === match[2]) : -1;
    const p = clamp(match[2] ? Math.max(0, landed) : Number(match[1]), 0, Math.max(0, n - 1));
    const start = clamp(p - 3, 0, Math.max(0, n - 8));
    const values = { h: '最近的会话', i: 'D' + pad(n, 3) + pad(start, 3) + pad(p, 3) };
    for (let k = 1; k <= windowLines; k++) values['d' + k] = '';
    const window = rows.slice(start, start + 8);
    const previews = await Promise.all(window.map((session) => (session ? this.preview(session).catch(() => '') : '')));
    window.forEach((session, k) => {
      if (!session) {
        values['d' + (k + 1)] = '+n----新建会话';
        values['d' + (k + 9)] = '单击选 Agent，说话开新会话';
        return;
      }
      const key = session.agent + ':' + session.id;
      const request = this.requestOf(session);
      const state = request ? 'w' : working.has(session.status) ? 'r' : session.status === 'failed' ? 'f' : 'i';
      const said = state === 'w' ? '等你' : state === 'r' ? '在跑' : state === 'f' ? '出错了'
        : age(this.activityOf(session), now) === '刚刚' ? '刚刚' : age(this.activityOf(session), now) + '前';
      // Every value the phone hands the glasses is at most 63 bytes: six for the codes, 57 for the words.
      const tail = ' · ' + said;
      const title = (wrap(session.name, pageSize, 1, 330, 57 - Buffer.byteLength(tail))[0] ?? '') + tail;
      values['d' + (k + 1)] = glyph[session.agent] + state + this.sessionCode(key) + title;
      values['d' + (k + 9)] = one(firstSentence(previews[k]), pageSize, 440);
    });
    return values;
  }

  async page(arg) {
    const zg = /^z(\d{1,3})(?:[sxr][0-9a-z]{4})?$/.exec(arg ?? '');
    if (zg) return this.zongguanPage(zg[1]);
    const match = /^([ckmgdhv])(\d{1,3})(?:([sxr])([0-9a-z]{4}))?$/.exec(arg ?? '');
    if (!match) throw new ApiError(400, 'Invalid page reference.');
    const agent = byLetter[match[1]];
    const [, , , how, code] = match;
    // s: stay on the session the glasses show; x: go to the agent's newest other session; r: the session asking
    let session = null;
    if (how === 's') session = this.sessionByCode(agent, code);
    else if (how === 'x') {
      const here = this.sessionByCode(agent, code);
      session = this.latest(agent, here ? agent + ':' + here.id : null);
    }
    else if (how === 'r') {
      const request = this.requestOfShort(code);
      if (request?.agent === agent) session = this.state.sessions.get(agent + ':' + request.session) ?? null;
    }
    session ??= this.latest(agent);
    if (!session) {
      this.viewing.delete(agent);
      const values = { g: this.lensRail(), v: this.versions(), k: '', h: '还没有会话', i: 'rdn000000000----000' };
      for (let k = 1; k <= windowLines; k++) values['d' + k] = '';
      return values;
    }
    const key = agent + ':' + session.id;
    this.viewing.set(agent, { key });
    const values = { g: this.lensRail(), v: this.versions(), k: '', h: '', i: '' };
    for (let k = 1; k <= windowLines; k++) values['d' + k] = '';
    const { lines, messages } = await this.lensLines(session);
    const n = lines.length;
    const want = clamp(Number(match[2]), 0, Math.max(0, n - 1));
    const o = clamp(want - 4, 0, Math.max(0, n - windowLines));
    lines.slice(Math.max(0, n - o - windowLines), n - o).forEach((line, k) => { values['d' + (k + 1)] = line; });
    const request = this.requestOf(session);
    const status = request ? 'w' : working.has(session.status) ? 'r' : session.status === 'offline' ? 'o' : 'i';
    values.i = (session.capabilities.includes('send') ? 'w' : 'r') + (queueAgents.has(agent) ? 'q' : 'd') + status
      + pad(Math.min(n, 999), 3) + pad(Math.min(messages, 999), 3) + pad(o, 3) + this.sessionCode(key)
      + pad(Math.min(headOffset(lines), 999), 3) + (status === 'r' ? await this.actionLine(session) : '');
    values.h = one(session.name, 15, 296);
    values.k = this.requestCode(request);
    return values;
  }

  /**
   * What a running session is doing, for the line left of the microphone: the tool it reported live, else the
   * last tool call in its transcript, else "在想…". At most 44 bytes, so it fits after the 19 bytes of page state.
   */
  async actionLine(session) {
    const key = session.agent + ':' + session.id;
    let text = toolText(this.actions.get(key));
    if (!text) {
      const last = (await this.transcript(session))?.at(-1);
      text = last?.role === 'tool' ? toolText(last.tool) : '';
    }
    return wrap(text || '在想…', 15, 1, 440, 44)[0] ?? '';
  }

  /** A question or an approval, for the pop-up: what is asked, up to six choices, and what can be done. */
  askView(arg) {
    const request = this.requestOfShort(arg);
    const values = { k: '', h: '', i: '000' };
    for (let k = 1; k <= 9; k++) values['d' + k] = '';
    const confirm = this.confirmOfShort(arg);
    if (confirm) {
      // A choice of two, without a spoken answer: 1 好, 2 不要.
      values.k = 'i5' + pad(String(arg).replace(/^0+/, ''), 4);
      values.h = '总管 · 要你点头';
      wrap(confirm.text || '要你点头', lensSize, 3, 500, 63).forEach((line, k) => { values['d' + (k + 1)] = line; });
      values.d4 = '好';
      values.d5 = '不要';
      values.i = '200';
      return values;
    }
    if (!request) return values;
    values.k = this.requestCode(request);
    // 总管's suggestion takes the third line and stars its option; the choices and the cursor stay as they were.
    const advice = this.zongguan?.enabled ? this.zongguan.adviceFor?.(request.id) ?? null : null;
    const name = shortName[request.agent];
    const others = this.state.requests.size - 1;
    const more = others > 0 ? ' · 还有 ' + others + ' 个' : '';
    // The count stays whole; the title gives way, so the value keeps to 63 bytes.
    const head = (title) => (wrap(title, 15, 1, 330, 63 - Buffer.byteLength(more))[0] ?? '') + more;
    let lines;
    if (request.kind === 'input') {
      const question = request.questions?.[0];
      const single = request.questions?.length === 1;
      values.h = head(name + ' · ' + (question?.title || '问你'));
      lines = wrap(question?.text || request.description || '要你回答', lensSize, 3, 500, 63);
      const options = single ? (question.options ?? []).slice(0, 6) : [];
      options.forEach((option, k) => { values['d' + (k + 4)] = one((advice?.option === k + 1 ? '★ ' : '') + option, lensSize, 460); });
      // Hermes's clarify takes one of its choices only, so there is no spoken answer.
      values.i = String(options.length) + '0' + (single && request.spoken !== false ? '1' : '0');
    } else {
      values.h = head(name + ' · ' + (titles[request.title] ?? request.title));
      const what = [displayCommand(request.command), request.description].filter(Boolean)
        .filter((value, index, all) => all.indexOf(value) === index).join('\n');
      lines = wrap(what || '要你批准', lensSize, 3, 500, 63);
      // Codex can allow the same kind of action for the rest of the session; Hermes says on each card whether it can.
      values.i = '0' + ((request.sessionAllowed ?? request.agent === 'codex') && request.approvalAllowed !== false ? '1' : '0')
        + (request.approvalAllowed === false ? '0' : '1');
    }
    lines.forEach((line, k) => { values['d' + (k + 1)] = line; });
    if (advice) values.d3 = one('建议：' + (advice.option ? '选 ' + advice.option : advice.decision === 'allow' ? '允许' : '拒绝') + ' · ' + advice.reason, lensSize, 500);
    return values;
  }

  /** 总管's card on screen, when the short id names its confirmation. */
  confirmOfShort(id) {
    const key = this.keys.get(String(id ?? '').replace(/^0+/, ''));
    if (!key?.startsWith('zongguan:confirm:') || !this.zongguan) return null;
    const card = this.zongguan.view().card;
    const confirmId = key.slice('zongguan:confirm:'.length);
    return card?.kind === 'confirm' && card.confirmId === confirmId ? card : { confirmId, text: '' };
  }

  /** ✓ ✗ or 本会话都允许 on an approval (y n a), or choice 1–6 of a question. */
  async act(arg) {
    if (String(arg ?? '').startsWith('-')) return this.release(arg.slice(1));
    const match = /^([0-9a-z]{4})([yna1-6])$/.exec(arg ?? '');
    if (!match) throw new ApiError(400, 'Invalid answer.');
    const confirm = this.confirmOfShort(match[1]);
    if (confirm) {
      if (!'yn12'.includes(match[2])) return { st: 'fail', h: '只能选好或不要' };
      return this.zongguan.confirm(confirm.confirmId, 'y1'.includes(match[2]));
    }
    const request = this.requestOfShort(match[1]);
    if (!request) return { st: 'gone', h: '已经处理过了' };
    const c = match[2];
    try {
      if ('yna'.includes(c)) {
        if (request.kind === 'input') return { st: 'fail', h: '这个问题要选或者说' };
        if (c !== 'n' && request.approvalAllowed === false) return { st: 'fail', h: '这条要在电脑上批准' };
        if (c === 'a' && !(request.sessionAllowed ?? request.agent === 'codex')) return { st: 'fail', h: '这里没有自动模式' };
        await this.state.decide(request.id, { decision: { y: 'accept', n: 'decline', a: 'acceptForSession' }[c] });
        return { st: 'ok', h: { y: '已允许', n: '已拒绝', a: '本会话都允许' }[c] };
      }
      const question = request.questions?.length === 1 ? request.questions[0] : null;
      const option = question?.options?.[Number(c) - 1];
      if (!option) return { st: 'fail', h: '这个要在电脑上回答' };
      await this.state.decide(request.id, { answers: { [question.id]: option } });
      return { st: 'ok', h: one('已选：' + option, 15, 296) };
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) return { st: 'gone', h: '已经处理过了' };
      const [st, h] = sendFailure(request.agent, error);
      return { st, h };
    }
  }

  /**
   * What the wearer said on a page: `arg` is the agent letter (its latest session gets it), or "a" and a
   * question's id for a free answer. Codex and Claude Code get it after the current turn.
   */
  async say(arg, input) {
    if (/^[-.]/.test(arg ?? '')) return this.hold(arg, input);
    const text = typeof input.text === 'string' ? input.text.trim().slice(0, 4000) : '';
    if (!text) return { st: 'empty', h: '没听到内容' };
    if (/^a[0-9a-z]{4}$/.test(arg ?? '')) {
      const request = this.requestOfShort(arg.slice(1));
      if (!request) return { st: 'gone', h: '这个问题已经不在了' };
      if (request.kind !== 'input' || request.questions?.length !== 1) return { st: 'fail', h: '这个要在电脑上回答' };
      try {
        await this.state.decide(request.id, { answers: { [request.questions[0].id]: text } });
        return { st: 'ok', h: '已回答' };
      } catch (error) {
        const [st, h] = sendFailure(request.agent, error);
        return { st, h };
      }
    }
    if (/^z(?:s[0-9a-z]{4})?$/.test(arg ?? '')) {
      if (!this.zongguan) return { st: 'fail', h: '总管没配好' };
      return this.zongguan.hear(text, 'glasses');
    }
    const page = /^([ckmgdhv])(?:s([0-9a-z]{4})|(n))?$/.exec(arg ?? '');
    if (!page) throw new ApiError(400, 'Invalid page reference.');
    const agent = byLetter[page[1]];
    if (page[3]) {
      // A new session (Muse: a new side conversation), in the folder used last.
      if (!this.canCreate(agent)) return { st: 'fail', h: shortName[agent] + ' 不能从眼镜新开' };
      try {
        await this.create(agent, text);
        return { st: 'sent', h: '已开始' + (agent === 'muse' ? '新对话' : '新会话') };
      } catch (error) {
        return { st: 'fail', h: fitBytes(error instanceof ApiError ? '没开成：' + error.message : '没开成，请到电脑上看') };
      }
    }
    // The glasses name the session on screen; it never goes to another one that happens to be newer.
    const session = page[2] ? this.sessionByCode(agent, page[2]) : this.latest(agent);
    if (!session) return page[2] ? { st: 'gone', h: '这个会话已经不在了' } : { st: 'fail', h: '还没有会话' };
    return this.deliverTo(session, text);
  }

  /** 总管's note to a session: sent now, or held until its turn ends, the same way as speech from the lens. */
  async queue(agent, id, text, meta) {
    const session = this.state.sessions.get(agent + ':' + id);
    if (!session) return { st: 'gone', h: '这个会话已经不在了' };
    return this.deliverTo(session, String(text ?? '').trim().slice(0, 4000), meta);
  }

  /** `meta` says who wrote it: the wearer by default, or 总管 with the wearer's words. Claude Code gets a receipt. */
  async deliverTo(session, words, meta = { origin: 'voice', said: words }) {
    const agent = session.agent;
    if (!session.capabilities.includes('send')) return { st: 'ro', h: '这个会话只能看' };
    const text = this.stamp(agent, session.id, words, meta);
    const key = agent + ':' + session.id;
    const list = this.queued.get(key) ?? [];
    const busy = working.has(session.status);
    const item = { id: randomUUID(), text, at: Date.now(), native: false };
    // Claude Code open on the computer and DeepSeek queue the message themselves; the gateway holds it for everyone else.
    if (queueAgents.has(agent) && !session.live && (busy || list.some((entry) => !entry.native))) {
      this.queued.set(key, [...list, item]);
      this.lensCache.delete(key);
      this.schedule();
      return { st: 'queued', h: '这轮结束后发' };
    }
    try {
      await this.submit(agent, session.id, text, item.id);
    } catch (error) {
      const [st, h] = sendFailure(agent, error);
      return { st, h };
    }
    if (queueAgents.has(agent) && session.live) {
      this.queued.set(key, [...list, { ...item, native: true }]);
      this.lensCache.delete(key);
      this.schedule();
      if (busy) return { st: 'queued', h: '这轮结束后发' };
    }
    return { st: 'sent', h: '已发给 ' + shortName[agent] };
  }

  /** A turn ended: send the next message the gateway was holding for that session. */
  async flushQueue(key) {
    const list = this.queued.get(key) ?? [];
    const next = list.find((item) => !item.native);
    const session = this.state.sessions.get(key);
    if (!next || !session || working.has(session.status)) return;
    this.queued.set(key, list.filter((item) => item !== next));
    if (this.queued.get(key).length === 0) this.queued.delete(key);
    this.lensCache.delete(key);
    try {
      await this.submit(session.agent, session.id, next.text, next.id);
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        this.queued.set(key, [next, ...(this.queued.get(key) ?? [])]);
      } else {
        this.queueNotify([{ key, agent: session.agent, failed: true, text: '排队的话没发出去' }]);
      }
    }
    this.schedule();
  }

  /* ----- push: spare.data keeps the open app current, spare.notify reaches the lens when something waits ----- */

  remember(req) {
    const app = req.headers['x-spare-app'];
    if (typeof app === 'string' && appPattern.test(app) && this.state.setting('spareApp') !== app) {
      this.state.set('spareApp', app);
    }
    const push = req.headers['x-spare-push'];
    const device = req.headers['x-spare-device'];
    if (typeof push === 'string' && pushPattern.test(push) && typeof device === 'string' && devicePattern.test(device)) {
      const saved = this.state.setting('sparePush') ?? {};
      if (saved[device] !== push) {
        const next = Object.fromEntries(Object.entries({ ...saved, [device]: push }).slice(-10));
        this.state.set('sparePush', next);
      }
    }
  }

  get appId() {
    return this.envApp ?? this.state.setting('spareApp');
  }

  emit(event, data, id = String(++this.eventId)) {
    const frame = { id, event, data };
    this.log.push(frame);
    if (this.log.length > 50) this.log.shift();
    for (const client of this.clients) this.write(client, frame);
    return frame;
  }

  write(res, { id, event, data }) {
    res.write('id: ' + id + '\nevent: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  }

  /** Values pushed to the open app: the same as the silent view asks for, so the lens can flash and pop up at once. */
  dataFrame() {
    const app = this.appId;
    if (!app) return null;
    // A push writes these keys as they are; the app keeps the attention code in st (its k answers map there too).
    const { k, ...now } = this.now();
    return { app, values: { ...now, st: k, _err: '' } };
  }

  schedule() {
    if (this.pending) return;
    this.pending = this.later(() => {
      this.pending = null;
      const fresh = [...this.state.requests.values()].filter((request) => !this.known.has(request.id));
      this.known = new Set([...this.state.requests.keys()]);
      if (this.asleep) return;
      const frame = this.dataFrame();
      const sign = frame ? JSON.stringify(frame.values) : '';
      if (frame && sign !== this.pushed) {
        this.pushed = sign;
        this.emit('spare.data', frame);
      }
      if (fresh.length) this.queueNotify(fresh.map((request) => ({ request })));
    }, 1000);
  }

  /** A turn that stops working (done or failed) becomes a notification with what the agent said. */
  watchStatus(key) {
    const now = this.state.sessions.get(key)?.status;
    const was = this.statuses.get(key);
    this.statuses.set(key, now);
    if (working.has(now) && !working.has(was)) this.workingAt.set(key, Date.now());
    if (working.has(was) && (now === 'idle' || now === 'failed')) {
      this.finished(key, now === 'failed').catch(() => {});
      this.flushQueue(key).catch(() => {});
    }
  }

  async finished(key, failed) {
    const since = this.workingAt.get(key) ?? 0;
    this.workingAt.delete(key);
    if (await this.idle() < awayAfter) return;
    await this.refresh(key, 'turn').catch(() => {});
    const said = this.feed.findLast((item) => item.key === key && item.kind === 'said');
    const fresh = said && said.at >= since && said.seq > (this.told.get(key) ?? 0) ? said : null;
    if (!fresh && !failed) return;
    if (fresh) this.told.set(key, fresh.seq);
    const session = this.sessionOf(key);
    this.queueNotify([{ key, agent: session.agent, failed, text: fresh ? firstSentence(fresh.text) : '' }]);
  }

  queueNotify(entries) {
    this.notifyQueue.push(...entries);
    const wait = this.notifyAt + 10000 - Date.now();
    if (wait > 0) {
      if (!this.notifyTimer) this.notifyTimer = this.later(() => { this.notifyTimer = null; this.flushNotify(); }, wait);
      return;
    }
    this.flushNotify();
  }

  flushNotify() {
    if (this.asleep) { this.notifyQueue = []; return; }
    const live = this.notifyQueue.filter((entry) => !entry.request || this.state.requests.has(entry.request.id));
    this.notifyQueue = [];
    if (!live.length) return;
    this.notifyAt = Date.now();
    const asks = live.filter((entry) => entry.request).map((entry) => entry.request);
    const done = live.filter((entry) => !entry.request);
    let data;
    if (asks.length === 1 && !done.length) {
      const [first] = asks;
      data = { title: agents.get(first.agent).name, body: fitBytes([titles[first.title] ?? first.title,
        firstLine(displayCommand(first.command) || first.questions?.[0]?.text || first.description)].filter(Boolean).join('：'), 180) };
    } else if (done.length === 1 && !asks.length) {
      const [entry] = done;
      const said = entry.failed ? ['出错了', entry.text].filter(Boolean).join('：') : entry.text;
      data = { title: fitBytes(shortName[entry.agent] + ' · ' + this.label(this.sessionOf(entry.key)), 60), body: fitBytes(said, 180) };
    } else {
      const names = [...new Set(done.map((entry) => shortName[entry.agent]))].join('、');
      const parts = [asks.length ? asks.length + ' 件事等你处理' : '', names ? names + ' 回完了' : ''];
      data = { title: 'Relay', body: parts.filter(Boolean).join('；') };
    }
    const frame = this.emit('spare.notify', data, 'n' + (asks[0]?.id ?? 'd' + this.feedSeq + '-' + this.notifyAt));
    if (!this.clients.size) void this.pushRemote(frame);
  }

  async pushRemote({ id, event, data }) {
    const saved = this.state.setting('sparePush') ?? {};
    for (const [device, url] of Object.entries(saved)) {
      try {
        const response = await this.send(url, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ event, id, data }), redirect: 'error', signal: AbortSignal.timeout(5000),
        });
        if (response.status === 404 || response.status === 410) {
          const current = { ...(this.state.setting('sparePush') ?? {}) };
          delete current[device];
          this.state.set('sparePush', current);
        }
      } catch { /* Delivery is best effort; the app reloads its list when opened. */ }
    }
  }

  events(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    res.flushHeaders();
    const cursor = req.headers['last-event-id'];
    const index = typeof cursor === 'string' ? this.log.findIndex((frame) => frame.id === cursor) : -1;
    if (index >= 0) for (const frame of this.log.slice(index + 1)) this.write(res, frame);
    const frame = this.dataFrame();
    if (frame) this.write(res, { id: String(++this.eventId), event: 'spare.data', data: frame });
    this.clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    res.on('close', () => {
      clearInterval(ping);
      this.clients.delete(res);
    });
  }

  handshake() {
    return { protocol: 1, name: 'Relay', model: 'agent-panel', capabilities: ['streaming', 'actions', 'apps', 'events'] };
  }

  /** Routes {B}/v1/spare/app/<route>. Returns the JSON object for the glasses app. */
  async app(route, method, query, input) {
    // The phone keeps the _err it wrote for a failed request until an answer overwrites it, so every answer clears it.
    return { ...(await this.route(route, method, query, input)), _err: '' };
  }

  async route(route, method, query, input) {
    const arg = query.get('k') ?? '';
    // The blank lens asks the gateway to sleep: no pushes, no notifications. Any other request wakes it.
    if (method === 'POST' && route === 'act' && arg === 'zz') { this.asleep = true; return { st: 'ok', h: '' }; }
    this.asleep = false;
    this.touch();
    if (method === 'GET' && route === 'now') return this.now();
    if (method === 'GET' && route === 'lens') return this.page(arg);
    if (method === 'GET' && route === 'dir') return this.directory(arg);
    // An update card's reference is longer than a request's four characters.
    if (method === 'GET' && route === 'ask') return String(arg ?? '').length > 4 ? this.card(arg) : this.askView(arg);
    if (method === 'POST' && route === 'act') return this.act(arg);
    if (method === 'POST' && route === 'say') return this.say(arg, input);
    if (method === 'GET' && route === 'top') return this.top();
    if (method === 'GET' && route === 'back') return this.back(arg);
    if (method === 'GET' && route === 'feed') return this.feedView(arg);
    if (method === 'GET' && route === 'item') return this.item(arg);
    if (method === 'POST' && route === 'answer') return this.answer(arg);
    if (method === 'GET' && route === 'sessions') return this.sessions(arg);
    if (method === 'GET' && route === 'session') return this.session(arg);
    if (method === 'GET' && route === 'targets') return this.pick(arg);
    if (method === 'POST' && route === 'talk') return this.talk(arg, input);
    if (method === 'POST' && route === 'deliver') return this.deliver(arg);
    if (method === 'POST' && route === 'discard') return this.dropDraft(arg);
    // Routes of the earlier paged app, still installed on some glasses.
    throw new ApiError(404, 'Unknown glasses endpoint.');
  }
}
