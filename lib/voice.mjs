import { randomUUID } from 'node:crypto';
import { ApiError, plainText } from './state.mjs';

/*
 * Voice desk: with "由 Agent 直接回答" on, every sentence said to Nova arrives here (spare.cool/io/agent §3–4).
 * Spoken commands list sessions and projects, lock one, collect a draft and send it; anything else joins the draft.
 * The lens holds about 3 lines of 14 characters, so lists and replies come a page at a time.
 */

export const defaultWords = {
  send: ['发送', '确认发送', '发出去'],
  cancel: ['取消', '取消发送', '算了'],
  end: ['结束对话', '关闭', '退出', '再见'],
  recent: ['最近对话', '最近会话', '列出对话'],
  projects: ['列出项目', '项目列表'],
  next: ['下一页'],
  prev: ['上一页'],
  reread: ['从头浏览', '从头念', '看回复'],
  current: ['当前对话', '当前Agent', '当前项目'],
  help: ['口令帮助', '帮助'],
  more: ['继续', '接着说'],
  find: ['查找对话', '搜索对话', '找对话'],
  create: ['新建对话', '新对话'],
  select: ['选择', '选'],
};
export const wordNames = {
  send: '确认发送', cancel: '取消发送', end: '结束对话', recent: '最近对话', projects: '列出项目', next: '下一页',
  prev: '上一页', reread: '从头浏览回复', current: '当前对话', help: '口令帮助', more: '继续说',
  find: '查找对话（后接主题）', create: '新建对话（可接 Agent 名）', select: '选择（后接序号）',
};

const shortName = { codex: 'Codex', claude: 'Claude', muse: 'Muse', grok: 'Grok', dsh: 'DeepSeek' };
const agentWords = [['claude code', 'claude'], ['claude', 'claude'], ['codex', 'codex'], ['muse', 'muse'],
  ['grok bot', 'grok'], ['grok', 'grok'], ['deepseek', 'dsh'], ['dsh', 'dsh']];
const working = new Set(['running', 'approval', 'input']);
const numbers = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const pageSize = 3;
const listen = 60;

/** Comparable form of something said: no spaces or punctuation, lower case. */
export const norm = (text) => String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

/** Display width on the lens: CJK counts 1, everything narrower counts half. */
const widthOf = (char) => (/[⺀-￯]/u.test(char) ? 1 : 0.5);
export function clip(text, size) {
  let out = '';
  let used = 0;
  for (const char of String(text ?? '')) {
    if (used + widthOf(char) > size) return out + '…';
    out += char;
    used += widthOf(char);
  }
  return out;
}

/** Spoken replies are plain text: drop Markdown marks, links and code blocks. */
export function plain(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, '（代码略）')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~]{1,3}([^*_~\n]+)[*_~]{1,3}/g, '$1')
    .replace(/\n{2,}/g, '\n').trim();
}

/** Split text into lens pages of about `size` width, breaking after sentences where possible. */
export function paginate(text, size = 40) {
  const sentences = plain(text).split('\n').flatMap((line) => line.match(/[^。！？!?；;]+[。！？!?；;]?/gu) ?? []);
  const pages = [];
  let page = '';
  let used = 0;
  for (const sentence of sentences.map((item) => item.trim()).filter(Boolean)) {
    for (const char of sentence) {
      if (used + widthOf(char) > size) {
        pages.push(page);
        page = '';
        used = 0;
      }
      page += char;
      used += widthOf(char);
    }
    if (used > size * 0.6) {
      pages.push(page);
      page = '';
      used = 0;
    }
  }
  if (page) pages.push(page);
  return pages.length ? pages : [''];
}

function numberOf(text) {
  const value = norm(text).replace(/^第/, '').replace(/[个项条]$/, '');
  if (/^\d{1,2}$/.test(value)) return Number(value);
  if (/^十[一二三四五六七八九]$/.test(value)) return 10 + numbers[value[1]];
  return value.length === 1 ? numbers[value] ?? 0 : 0;
}

/** How many character pairs two strings share: enough to match "阿里云服务器运维" to "阿里云运维". */
function overlap(query, text) {
  const pairs = (value) => {
    const chars = [...norm(value)];
    return new Set(chars.map((char, index) => char + (chars[index + 1] ?? '')));
  };
  const wanted = pairs(query);
  const have = pairs(text);
  let score = 0;
  for (const pair of wanted) if (have.has(pair)) score += pair.length;
  return score;
}

const folder = (cwd) => String(cwd ?? '').split('/').filter(Boolean).at(-1) ?? '';

export class VoiceDesk {
  constructor(state, { submit, glasses, create, canCreate, wait = 300000 }) {
    this.state = state;
    this.submit = submit;
    this.glasses = glasses;
    this.create = create;
    this.canCreate = canCreate ?? (() => false);
    this.wait = wait;
    this.draft = [];
    this.list = null; // { title, items: [{ label, agent?, id?, cwd? }], page }
    this.reply = null; // { pages, index }
    this.focus = null; // 'list' | 'reply': what 下一页 turns
    this.fresh = null; // a new session to start on send: { agent, cwd }
    this.project = null;
  }

  words() {
    const saved = this.state.setting('voiceWords') ?? {};
    return Object.fromEntries(Object.entries(defaultWords).map(([name, list]) => [name,
      Array.isArray(saved[name]) && saved[name].length ? saved[name] : list]));
  }

  shortcuts() {
    return this.state.setting('voiceShortcuts') ?? [];
  }

  /** The locked session, or null when none is chosen or it went away. */
  target() {
    const chosen = this.state.setting('voiceTarget');
    const session = chosen && this.state.sessions.get(chosen.agent + ':' + chosen.id);
    return session?.capabilities.includes('send') ? session : null;
  }

  label(session) {
    return shortName[session.agent] + '·' + clip(session.name || '未命名', 12);
  }

  lock(session) {
    this.state.set('voiceTarget', { agent: session.agent, id: session.id });
    this.state.event('voice-target', session.agent, session.id);
    this.fresh = null;
    this.draft = [];
    this.reply = null;
  }

  writable() {
    return [...this.state.sessions.values()].filter((session) => session.capabilities.includes('send'))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  /* ----- one sentence in, one answer out ----- */

  async handle(req, res, input, { sse, json }) {
    const message = Array.isArray(input.messages) ? input.messages.findLast((item) => item?.role === 'user') : null;
    const text = plainText(message?.content).trim();
    if (!text || text.length > 12000) throw new ApiError(400, 'Voice request needs a valid user message.');
    const streaming = input.stream === true;
    const id = 'chatcmpl-' + randomUUID();
    const created = Math.floor(Date.now() / 1000);
    let content = '';
    let closed = false;
    const chunk = (delta, finish_reason = null) => res.write('data: ' + JSON.stringify({
      id, object: 'chat.completion.chunk', created, model: 'agent-panel', choices: [{ index: 0, delta, finish_reason }],
    }) + '\n\n');
    const out = {
      say(part) {
        if (!part || closed) return;
        content += part;
        if (streaming) chunk({ content: part });
      },
      action(data) {
        if (streaming && !closed) res.write('event: spare.action\ndata: ' + JSON.stringify(data) + '\n\n');
      },
      card(title, rows) {
        this.action({ type: 'show_card', title: clip(title, 10), rows: rows.slice(0, 3).map((row) => clip(row, 16)) });
      },
      get closed() { return closed || res.destroyed; },
    };
    res.once('close', () => { closed = true; });
    if (streaming) {
      sse(res);
      chunk({ role: 'assistant' });
    }
    try {
      await this.command(text, out);
    } catch (error) {
      out.say(error instanceof ApiError ? '出错了：' + error.message : '出错了，请到电脑上看。');
    }
    if (res.destroyed) return;
    if (streaming) {
      chunk({}, 'stop');
      res.end('data: [DONE]\n\n');
    } else {
      json(res, { id, object: 'chat.completion', created, model: 'agent-panel',
        choices: [{ index: 0, message: { role: 'assistant', content: content || '好的。' }, finish_reason: 'stop' }] });
    }
  }

  async command(text, out) {
    const said = norm(text);
    const words = this.words();
    const is = (name) => words[name].some((word) => said === norm(word));
    const after = (name) => {
      for (const word of words[name]) {
        const head = norm(word);
        if (head && said.startsWith(head) && said.length > head.length) return said.slice(head.length);
      }
      return null;
    };

    if (is('end')) {
      const dropped = this.draft.length;
      this.draft = [];
      this.list = null;
      this.focus = null;
      out.say(dropped ? '草稿没发，已丢掉。再见。' : '好的，再见。');
      return out.action({ type: 'end_conversation' });
    }
    if (is('cancel')) {
      this.draft = [];
      out.say('已取消，草稿清空了。');
      return out.action({ type: 'keep_listening', seconds: listen });
    }
    if (is('send')) return this.send(out);
    if (is('next') || is('prev')) return this.turn(out, is('next') ? 1 : -1);
    if (is('reread')) return this.reread(out);
    if (is('recent')) return this.showSessions(out, '最近对话', this.writable());
    if (is('projects')) return this.showProjects(out);
    if (is('current')) return this.current(out);
    if (is('help')) return this.help(out, words);
    if (is('more')) {
      out.say('接着说。');
      return out.action({ type: 'keep_listening', seconds: listen });
    }
    const shortcut = this.shortcuts().find((item) => norm(item.phrase) === said);
    if (shortcut) return this.useShortcut(out, shortcut);
    const picked = after('select') ?? (this.list && this.focus === 'list' && numberOf(said) ? said : null);
    if (picked !== null && numberOf(picked)) return this.pick(out, numberOf(picked));
    const topic = after('find');
    if (topic !== null || is('find')) return this.find(out, topic ?? '');
    const fresh = after('create');
    if (fresh !== null || is('create')) return this.startNew(out, fresh ?? '');
    const direct = /^(?:问|告诉|跟|和|让|ask\s+|tell\s+)\s*(claude code|claude|codex|muse|grok bot|grok|deepseek|dsh)\s*(?:说|讲)?\s*[:：,，]?\s*([\s\S]+)$/i.exec(text);
    if (direct) return this.toAgent(out, direct[1].toLowerCase(), direct[2].trim());
    return this.addDraft(out, text);
  }

  /* ----- lists ----- */

  showSessions(out, title, sessions) {
    if (!sessions.length) return out.say('没有可以发消息的对话。');
    this.list = { title, page: 0, items: sessions.map((session) => ({ label: this.label(session), agent: session.agent, id: session.id })) };
    this.focus = 'list';
    return this.showPage(out);
  }

  showProjects(out) {
    const groups = new Map();
    for (const session of this.writable()) {
      if (!session.cwd) continue;
      const entry = groups.get(session.cwd) ?? { cwd: session.cwd, count: 0 };
      entry.count += 1;
      groups.set(session.cwd, entry);
    }
    if (!groups.size) return out.say('还没有带项目目录的对话。');
    this.list = { title: '项目', page: 0, items: [...groups.values()].map((entry) => ({
      label: folder(entry.cwd) + '（' + entry.count + '）', cwd: entry.cwd })) };
    this.focus = 'list';
    return this.showPage(out);
  }

  showPage(out) {
    const { title, items, page } = this.list;
    const pages = Math.ceil(items.length / pageSize);
    const rows = items.slice(page * pageSize, page * pageSize + pageSize)
      .map((item, index) => (page * pageSize + index + 1) + ' ' + item.label);
    out.card(title + (pages > 1 ? ' ' + (page + 1) + '/' + pages : ''), rows);
    out.say(rows.join('；') + '。说选择几' + (page + 1 < pages ? '，或下一页。' : '。'));
    out.action({ type: 'keep_listening', seconds: listen });
  }

  turn(out, step) {
    if (this.focus === 'list' && this.list) {
      const pages = Math.ceil(this.list.items.length / pageSize);
      const page = this.list.page + step;
      if (page < 0 || page >= pages) return out.say(step > 0 ? '已经是最后一页。' : '已经是第一页。');
      this.list.page = page;
      return this.showPage(out);
    }
    if (!this.reply) return out.say('现在没有可以翻的内容。');
    const index = this.reply.index + step;
    if (index < 0 || index >= this.reply.pages.length) return out.say(step > 0 ? '读完了。' : '已经是开头。');
    this.reply.index = index;
    return this.readPage(out);
  }

  readPage(out) {
    const { pages, index } = this.reply;
    out.say(pages[index] + (pages.length > 1 ? '（' + (index + 1) + '/' + pages.length + (index + 1 < pages.length ? '，说下一页' : '') + '）' : ''));
    if (index + 1 < pages.length) out.action({ type: 'keep_listening', seconds: listen });
  }

  async pick(out, number) {
    if (!this.list) return out.say('先说最近对话或列出项目。');
    const from = this.list.page * pageSize + 1;
    const to = Math.min(from + pageSize - 1, this.list.items.length);
    // Only the numbers on the lens count, so a page-2 "选择二" never picks something off screen.
    if (number < from || number > to) return out.say('这一页是 ' + from + (to > from ? ' 到 ' + to : '') + '，请说其中一个。');
    const item = this.list.items[number - 1];
    if (item.cwd) {
      this.project = item.cwd;
      return this.showSessions(out, folder(item.cwd), this.writable().filter((session) => session.cwd === item.cwd));
    }
    const session = this.state.sessions.get(item.agent + ':' + item.id);
    if (!session) return out.say('这个对话已经不在了。');
    return this.choose(out, session);
  }

  async choose(out, session) {
    this.lock(session);
    this.list = null;
    this.focus = null;
    const last = plain(await this.glasses.lastReply(session).catch(() => '')).split('\n')[0];
    out.say('已选 ' + this.label(session) + (last ? '。它最后说：' + clip(last, 22) : '') + '。说内容，再说发送。');
    out.action({ type: 'keep_listening', seconds: listen });
  }

  async find(out, topic) {
    if (!topic) return out.say('要找什么？说查找对话，再加主题。');
    const sessions = this.writable().slice(0, 40);
    const previews = await Promise.all(sessions.map((session, index) => (index < 15
      ? this.glasses.lastReply(session).catch(() => '') : '')));
    const ranked = sessions.map((session, index) => ({ session,
      score: overlap(topic, session.name) * 2 + overlap(topic, folder(session.cwd)) * 2 + overlap(topic, previews[index]) }))
      .filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).slice(0, pageSize);
    if (!ranked.length) return out.say('没找到和「' + clip(topic, 10) + '」有关的对话。');
    return this.showSessions(out, '查找', ranked.map((entry) => entry.session));
  }

  useShortcut(out, shortcut) {
    if (shortcut.cwd) {
      this.project = shortcut.cwd;
      return this.showSessions(out, folder(shortcut.cwd), this.writable().filter((session) => session.cwd === shortcut.cwd));
    }
    const session = this.state.sessions.get(shortcut.agent + ':' + shortcut.id);
    if (!session?.capabilities.includes('send')) return out.say('口令「' + shortcut.phrase + '」对应的对话不在了。');
    return this.choose(out, session);
  }

  /* ----- drafts and sending ----- */

  current(out) {
    const session = this.target();
    const who = this.fresh ? '新对话（' + shortName[this.fresh.agent] + (this.fresh.cwd ? '·' + folder(this.fresh.cwd) : '') + '）'
      : session ? this.label(session) : '还没选对话';
    out.say('当前：' + who + (this.draft.length ? '，草稿 ' + this.draft.length + ' 段。' : '。'));
  }

  startNew(out, rest) {
    const named = agentWords.find(([word]) => norm(rest).startsWith(norm(word)));
    const agent = named?.[1] ?? this.target()?.agent ?? 'codex';
    if (!this.canCreate(agent)) return out.say(shortName[agent] + ' 现在开不了新对话。');
    this.fresh = { agent, cwd: this.project ?? undefined };
    this.draft = [];
    this.list = null;
    this.focus = null;
    out.say('新对话（' + shortName[agent] + (this.project ? '·' + folder(this.project) : '') + '）。说内容，再说发送。');
    out.action({ type: 'keep_listening', seconds: listen });
  }

  toAgent(out, word, text) {
    const agent = agentWords.find(([name]) => name === word)[1];
    const chosen = this.target();
    const session = chosen?.agent === agent ? chosen : this.writable().find((item) => item.agent === agent);
    if (!session) return out.say('没有可以发给 ' + shortName[agent] + ' 的对话。');
    if (session !== chosen) this.lock(session);
    this.fresh = null;
    this.draft = [text];
    out.say('草稿给 ' + this.label(session) + '：' + clip(text, 20) + '。说发送。');
    out.action({ type: 'keep_listening', seconds: listen });
  }

  addDraft(out, text) {
    if (!this.fresh && !this.target()) {
      out.say('先说最近对话，选一个对话。');
      return out.action({ type: 'keep_listening', seconds: listen });
    }
    this.draft.push(text);
    this.list = null;
    this.focus = null;
    const tail = this.draft.join('');
    out.card('草稿', paginate(tail, 16).slice(-3));
    out.say('记下了（' + this.draft.length + ' 段）。说发送，或接着说。');
    out.action({ type: 'keep_listening', seconds: listen });
  }

  async send(out) {
    if (!this.draft.length) return out.say('草稿是空的，先说要发的内容。');
    const text = this.draft.join('\n');
    let agent;
    let id;
    let accepted;
    const events = [];
    const receive = (event) => events.push(event);
    this.state.on('event', receive);
    try {
      if (this.fresh) {
        ({ agent } = this.fresh);
        accepted = await this.create(agent, text, { cwd: this.fresh.cwd });
        id = accepted.id;
        const session = this.state.sessions.get(agent + ':' + id);
        if (session) this.lock(session);
        else this.fresh = null;
      } else {
        const session = this.target();
        if (!session) return out.say('先说最近对话，选一个对话。');
        if (working.has(session.status)) return out.say(this.label(session) + ' 还在忙，等它做完再发。草稿留着。');
        ({ agent, id } = session);
        accepted = await this.submit(agent, id, text, randomUUID(), true);
      }
    } catch (error) {
      this.state.off('event', receive);
      if (error instanceof ApiError && error.status === 409) return out.say('现在发不了：' + error.message + ' 草稿留着。');
      throw error;
    }
    this.draft = [];
    const correlation = accepted?.turnId ?? accepted?.commandId;
    out.say('已发送，回复中。');
    if (!correlation) {
      this.state.off('event', receive);
      return out.say('好了会推通知给你。');
    }
    const reply = await this.collect(agent, id, correlation, events, receive, out);
    if (reply === null) return;
    if (!reply) return out.say('它这次没有文字回复。');
    this.reply = { pages: paginate(reply), index: 0 };
    this.focus = 'reply';
    out.say('\n');
    this.readPage(out);
  }

  /** Wait for the reply to one message; null when the wearer moved on or it took too long (a notification follows). */
  collect(agent, id, correlation, early, collecting, out) {
    return new Promise((resolve) => {
      let text = '';
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(progress);
        clearInterval(gone);
        this.state.off('event', receive);
        this.state.off('event', collecting);
        resolve(value);
      };
      const receive = (event) => {
        if (event.agent !== agent || event.session !== id || !['delta', 'turn', 'reply'].includes(event.kind)) return;
        if (event.turnId !== correlation && event.commandId !== correlation) return;
        if (event.kind === 'delta' || event.kind === 'reply') text += event.text ?? '';
        if (event.kind === 'reply' || event.kind === 'turn') {
          if (event.status && event.status !== 'completed') {
            out.say('这一轮失败了，请到电脑上看。');
            finish(null);
          } else finish(text);
        }
      };
      const timer = setTimeout(() => {
        out.say('还在做，做完会推通知给你。');
        finish(null);
      }, this.wait);
      timer.unref?.();
      // Spare ends a turn after 60 seconds without reply text; a progress line restarts that wait (up to 10 minutes).
      const progress = setInterval(() => out.action({ type: 'progress', text: shortName[agent] + ' 还在处理' }), 20000);
      progress.unref?.();
      const gone = setInterval(() => { if (out.closed) finish(null); }, 1000);
      gone.unref?.();
      this.state.on('event', receive);
      this.state.off('event', collecting);
      for (const event of early) receive(event);
    });
  }

  async reread(out) {
    const session = this.target();
    if (!session) return out.say('先说最近对话，选一个对话。');
    const last = await this.glasses.lastReply(session).catch(() => '');
    if (!last) return out.say(this.label(session) + ' 还没有回复。');
    this.reply = { pages: paginate(last), index: 0 };
    this.focus = 'reply';
    return this.readPage(out);
  }

  help(out, words) {
    const text = Object.keys(defaultWords).map((name) => wordNames[name] + '：' + words[name][0]).join('；') + '。';
    this.reply = { pages: paginate(text), index: 0 };
    this.focus = 'reply';
    return this.readPage(out);
  }
}

/*
 * Nova tools: the same sessions as an MCP server (POST /mcp). Takeover stays off: Nova's own assistant
 * decides when a request is for an agent, finds the session, polishes the wording, reads it back and sends.
 * Nova shows no embedded UI, so the look comes from words: every tool result opens with a suggested lens line in
 * the style of the voice desk ("口令。（状态）内容 1/3"), which Nova's model may use as is or reword.
 */

const statusWord = { idle: '空闲', running: '运行中', approval: '等你批准', input: '等你回答', failed: '出错', unknown: '状态未知' };
const mcpVersions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const agentIds = ['codex', 'claude', 'muse', 'grok', 'dsh'];

export const novaInstructions = `这是用户自己电脑上的 Agent 控制台：Codex、Claude Code 等编程 Agent 的会话。
用户提到 Codex、Claude、Agent、某个项目或会话，想让 Agent 做事，或问 Agent 进展时使用；其他问题照常自己回答。
- 找会话：先调 list_agents。用户说得含糊就带 query 搜；只有一个明显匹配就直接用，几个都像就念前三个让用户挑。
- 发消息：把用户口述整理成给 Agent 的清楚指令。保留原意，补上用户提到的目标、上下文和做到什么算完成，去掉口头语，不替用户加需求。
  先调 send_to_agent 不带 confirmed，拿到预览后把整理好的内容简短念给用户；用户说确认或发送，再用同样的参数加 confirmed=true 调用。用户说取消就不发。
- 回答要短：镜片一屏约 3 行、每行 14 个字。
- 镜片样式：先复述用户的口令，括号里写状态，再接内容；列表带序号，长内容带页码。照这个样子说，细节按上下文替换：
  最近对话。（最近 3 个）1.Codex·网关 运行中；2.Claude·眼镜 等批准；3.Codex·笔记 空闲。说选第几个。
  选择一。（已选 Codex·笔记）说内容，再说确认发送。
  确认发送。（回复中）已发给 Codex·笔记，做完会推送通知。
  下一页。（2/3）……
  每个工具结果第一行「镜片：」是按这个样式写好的建议说法，可以直接用，也可以改。
- 用户说「选第几个」「下一页」「取消」「确认发送」时，自己对应到上一次的列表、回复或预览；下一页就用 read_reply 的 page 加一。
- Agent 运行中或等你批准时不要发新消息，告诉用户等它做完；批准命令请用户到电脑或 Relay 上处理。
- 只用工具返回的内容，不编造会话名或回复。`;

const sessionArgs = {
  agent: { type: 'string', enum: agentIds, description: '会话所属的 Agent，来自 list_agents' },
  id: { type: 'string', description: '会话 id，来自 list_agents' },
};

const toolList = [
  {
    name: 'list_agents', title: '列出 Agent 会话',
    description: '用户提到 Codex、Claude、Agent、电脑上的会话或某个项目，想看进展或让 Agent 做事时，先调这个。列出用户电脑上可以发消息的 Agent 会话和状态（空闲、运行中、等你批准、出错），最近活动的在前。query 按会话名、项目文件夹和最近回复搜索。',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      agent: { type: 'string', enum: agentIds, description: '只看某个 Agent' },
      query: { type: 'string', maxLength: 60, description: '用户提到的主题或项目名' },
      limit: { type: 'integer', minimum: 1, maximum: 10, description: '最多几条，默认 5' },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'read_reply', title: '读最新回复',
    description: '用户问某个 Agent 做得怎么样、回了什么时用。读某个会话里 Agent 的最新一条回复和当前状态。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['agent', 'id'], properties: {
      ...sessionArgs,
      page: { type: 'integer', minimum: 1, description: '镜片上的第几页，从 1 开始；用户说下一页时加一' },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'send_to_agent', title: '给 Agent 发消息',
    description: '用户想让电脑上的 Agent 做事时用。把整理好的指令发给某个会话。不带 confirmed 只返回预览、不发送；念给用户确认后，用同样的参数加 confirmed=true 才真正发送，并最多等 wait_seconds 秒把回复带回来。',
    inputSchema: { type: 'object', additionalProperties: false, required: ['agent', 'id', 'text'], properties: {
      ...sessionArgs,
      text: { type: 'string', minLength: 1, maxLength: 12000, description: '整理好的、要发给 Agent 的完整指令' },
      confirmed: { type: 'boolean', description: '用户已经听过预览并说了确认' },
      wait_seconds: { type: 'integer', minimum: 0, maximum: 50, description: '发送后等回复的秒数，默认 20' },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

const promptList = [
  {
    name: 'ask_agent', title: '交给 Agent',
    description: '把一件事整理成指令，确认后发给电脑上的 Agent',
    arguments: [
      { name: 'request', description: '想让 Agent 做的事', required: true },
      { name: 'agent', description: 'Codex、Claude 等，可不填', required: false },
    ],
    text: ({ request, agent }) => `帮我把这件事交给${agent ? ' ' + agent + ' ' : '合适的 '}Agent：${request}
1. 用 list_agents 找到对应的会话，拿不准就念前三个让我选。
2. 把我的话整理成清楚的指令，先调 send_to_agent 拿预览，简短念给我。
3. 我说确认再发送；等到回复就用一句话告诉我结论。`,
  },
  {
    name: 'agent_status', title: 'Agent 进展',
    description: '看电脑上各个 Agent 现在在做什么',
    arguments: [],
    text: () => `看一下我电脑上的 Agent 现在在做什么：调 list_agents，按「等你批准、运行中、刚回完」的顺序，每个会话一句话，最多三个。
有等我批准的，提醒我到电脑或 Relay 上处理。`,
  },
];

const ago = (at) => {
  const minutes = Math.round((Date.now() - (at ?? 0)) / 60000);
  if (!at || minutes < 0) return '';
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  if (minutes < 1440) return Math.round(minutes / 60) + ' 小时前';
  return Math.round(minutes / 1440) + ' 天前';
};

class ToolError extends Error {}

/** The suggested lens line: （状态）内容. */
const lens = (status, body) => '镜片：（' + status + '）' + body;
const short = (row) => shortName[row.agent] + '·' + clip(row.label.split('·').slice(1).join('·'), 8);

export class NovaTools {
  constructor(state, { submit, glasses }) {
    this.state = state;
    this.submit = submit;
    this.glasses = glasses;
  }

  writable() {
    return [...this.state.sessions.values()].filter((session) => session.capabilities.includes('send'))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }

  describe(session) {
    const waiting = [...this.state.requests.values()].filter((item) => item.agent === session.agent && item.session === session.id).length;
    const status = waiting ? 'approval' : session.status;
    return {
      agent: session.agent, id: session.id, label: shortName[session.agent] + '·' + (session.name || '未命名'),
      folder: folder(session.cwd), status, statusText: statusWord[status] ?? statusWord.unknown, updated: ago(session.updatedAt),
    };
  }

  session(args) {
    if (!agentIds.includes(args?.agent) || typeof args.id !== 'string' || !args.id) throw new ToolError('需要 list_agents 返回的 agent 和 id。');
    const session = this.state.sessions.get(args.agent + ':' + args.id);
    if (!session) throw new ToolError('这个会话已经不在了，请重新 list_agents。');
    if (!session.capabilities.includes('send')) throw new ToolError('这个会话只能看，不能发消息。');
    return session;
  }

  /* ----- JSON-RPC over Streamable HTTP, stateless; null means a notification (HTTP 202) ----- */

  async rpc(message) {
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return { jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32600, message: 'Invalid request' } };
    }
    if (message.id === undefined || message.id === null) return null;
    const answer = (result) => ({ jsonrpc: '2.0', id: message.id, result });
    const fail = (code, text) => ({ jsonrpc: '2.0', id: message.id, error: { code, message: text } });
    const params = message.params ?? {};
    switch (message.method) {
      case 'initialize': return answer({
        protocolVersion: mcpVersions.includes(params.protocolVersion) ? params.protocolVersion : mcpVersions[0],
        capabilities: { tools: { listChanged: false }, prompts: { listChanged: false } },
        serverInfo: { name: 'relay-gateway', title: 'Relay 电脑 Agent', version: '0.5.0' },
        instructions: novaInstructions,
      });
      case 'ping': return answer({});
      case 'tools/list': return answer({ tools: toolList });
      case 'tools/call': {
        const run = { list_agents: () => this.list(params.arguments ?? {}), read_reply: () => this.read(params.arguments ?? {}),
          send_to_agent: () => this.send(params.arguments ?? {}) }[params.name];
        if (!run) return fail(-32602, 'Unknown tool: ' + params.name);
        try {
          return answer(await run());
        } catch (error) {
          if (!(error instanceof ToolError) && !(error instanceof ApiError)) throw error;
          return answer({ content: [{ type: 'text', text: error.message }], isError: true });
        }
      }
      case 'prompts/list': return answer({ prompts: promptList.map(({ text, ...prompt }) => prompt) });
      case 'prompts/get': {
        const prompt = promptList.find((item) => item.name === params.name);
        if (!prompt) return fail(-32602, 'Unknown prompt: ' + params.name);
        const args = params.arguments ?? {};
        const missing = prompt.arguments.find((item) => item.required && !String(args[item.name] ?? '').trim());
        if (missing) return fail(-32602, 'Missing argument: ' + missing.name);
        return answer({ description: prompt.description,
          messages: [{ role: 'user', content: { type: 'text', text: prompt.text(args) } }] });
      }
      default: return fail(-32601, 'Method not found: ' + message.method);
    }
  }

  /* ----- the three tools ----- */

  async list({ agent, query, limit }) {
    const size = Number.isInteger(limit) && limit >= 1 && limit <= 10 ? limit : 5;
    let sessions = this.writable().filter((session) => !agent || session.agent === agent);
    const topic = typeof query === 'string' ? query.trim().slice(0, 60) : '';
    if (topic) {
      const pool = sessions.slice(0, 40);
      const previews = await Promise.all(pool.map((session, index) => (index < 15 ? this.glasses.lastReply(session).catch(() => '') : '')));
      sessions = pool.map((session, index) => ({ session,
        score: overlap(topic, session.name) * 2 + overlap(topic, folder(session.cwd)) * 2 + overlap(topic, previews[index]) }))
        .filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score).map((entry) => entry.session);
    }
    const rows = sessions.slice(0, size).map((session) => this.describe(session));
    const attention = this.state.requests.size;
    const lines = rows.map((row, index) => (index + 1) + '. ' + row.label + (row.folder ? '（' + row.folder + '）' : '')
      + ' — ' + row.statusText + (row.updated ? '，' + row.updated : '') + '  [agent=' + row.agent + ' id=' + row.id + ']');
    const head = !rows.length ? lens(topic ? '没找到' : '没有会话', topic ? '没有和「' + clip(topic, 8) + '」有关的会话。' : '现在没有可以发消息的会话。')
      : lens((topic ? '找到 ' : '最近 ') + Math.min(rows.length, 3) + ' 个', rows.slice(0, 3).map((row, index) => (index + 1) + '.' + short(row) + ' ' + row.statusText).join('；')
        + '。说选第几个。' + (attention ? '有 ' + attention + ' 件等你批准。' : ''));
    const text = head + (rows.length ? '\n全部：\n' + lines.join('\n') : '');
    return {
      content: [{ type: 'text', text: text + (attention ? '\n有 ' + attention + ' 件事等用户批准，需要到电脑或 Relay 上处理。' : '') }],
      structuredContent: { view: 'sessions', query: topic, sessions: rows, attention },
    };
  }

  async read(args) {
    const session = this.session(args);
    const row = this.describe(session);
    const reply = plain(await this.glasses.lastReply(session).catch(() => ''));
    const text = reply.length > 2000 ? reply.slice(0, 2000) + '…（后面略）' : reply;
    const pages = paginate(reply);
    const page = Math.min(Math.max(Number.isInteger(args.page) ? args.page : 1, 1), pages.length);
    const head = !reply ? lens(short(row) + ' ' + row.statusText, '还没有回复。')
      : lens(short(row) + (pages.length > 1 ? ' ' + page + '/' + pages.length : ''), pages[page - 1]
        + (page < pages.length ? ' 说下一页。' : ''));
    return {
      content: [{ type: 'text', text: head + '\n' + row.label + '，' + row.statusText + '。' + (text ? '\n完整回复（回答追问用，不要整段念）：\n' + text : '') }],
      structuredContent: { view: 'reply', session: row, reply: text, page, pages: pages.length },
    };
  }

  async send(args) {
    const session = this.session(args);
    const text = typeof args.text === 'string' ? args.text.trim() : '';
    if (!text || text.length > 12000) throw new ToolError('text 要 1 到 12000 个字。');
    const row = this.describe(session);
    if (args.confirmed !== true) {
      return {
        content: [{ type: 'text', text: lens('待确认', '发给 ' + short(row) + '：' + clip(text, 24) + '。说确认发送或取消。')
          + '\n还没有发送。把下面这段简短念给用户确认；用户确认后用同样的参数加 confirmed=true 再调用。\n发给 ' + row.label + '：\n' + text }],
        structuredContent: { view: 'draft', session: row, text },
      };
    }
    if (working.has(row.status)) throw new ToolError(row.label + ' ' + row.statusText + '，等它做完再发。');
    const wait = Number.isInteger(args.wait_seconds) && args.wait_seconds >= 0 && args.wait_seconds <= 50 ? args.wait_seconds : 20;
    const early = [];
    const collecting = (event) => early.push(event);
    this.state.on('event', collecting);
    let accepted;
    try {
      accepted = await this.submit(session.agent, session.id, text, randomUUID(), true);
    } catch (error) {
      this.state.off('event', collecting);
      if (error instanceof ApiError && error.status === 409) throw new ToolError('现在发不了：' + error.message);
      throw error;
    }
    const correlation = accepted?.turnId ?? accepted?.commandId;
    const outcome = correlation && wait
      ? await this.reply(session.agent, session.id, correlation, early, collecting, wait * 1000)
      : (this.state.off('event', collecting), null);
    const reply = outcome?.text ? plain(outcome.text) : '';
    const result = outcome?.failed ? 'failed' : outcome ? 'replied' : 'working';
    const pages = paginate(reply);
    const head = { failed: lens('出错', '已发送，但这一轮失败了，请到电脑上看。'),
      working: lens('回复中', '已发给 ' + short(row) + '，做完会推送通知。'),
      replied: reply ? lens('已回复' + (pages.length > 1 ? ' 1/' + pages.length : ''), pages[0] + (pages.length > 1 ? ' 说下一页。' : ''))
        : lens('已回复', '它这次没有文字回复。') }[result];
    const said = head + '\n' + { failed: '已发送，但这一轮出错了，请到电脑上看。', working: '已发送，' + row.label + ' 还在做，做完会推送通知。',
      replied: reply ? '已发送。' + row.label + ' 回复：\n' + (reply.length > 2000 ? reply.slice(0, 2000) + '…（后面略）' : reply) : '已发送，它这次没有文字回复。' }[result];
    return {
      content: [{ type: 'text', text: said }],
      structuredContent: { view: 'sent', session: this.describe(session), text, result, reply: reply.slice(0, 2000) },
    };
  }

  /** The reply to one message: { text }, { failed: true }, or null when it takes longer than `ms`. */
  reply(agent, id, correlation, early, collecting, ms) {
    return new Promise((resolve) => {
      let text = '';
      const finish = (value) => {
        clearTimeout(timer);
        this.state.off('event', receive);
        resolve(value);
      };
      const receive = (event) => {
        if (event.agent !== agent || event.session !== id || !['delta', 'turn', 'reply'].includes(event.kind)) return;
        if (event.turnId !== correlation && event.commandId !== correlation) return;
        if (event.kind === 'delta' || event.kind === 'reply') text += event.text ?? '';
        if (event.kind === 'reply' || event.kind === 'turn') finish(event.status && event.status !== 'completed' ? { failed: true } : { text });
      };
      const timer = setTimeout(() => finish(null), ms);
      timer.unref?.();
      this.state.on('event', receive);
      this.state.off('event', collecting);
      for (const event of early) receive(event);
    });
  }
}
