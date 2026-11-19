import { randomUUID } from 'node:crypto';
import { ApiError } from '../state.mjs';
import { toolText } from '../spare.mjs';

/*
 * 总管's tools. They only dispatch: look at sessions, talk to them, start or stop them, answer what they ask
 * when the user said so, and manage 总管's own memory. Nothing here reads files or runs commands.
 */

const names = { codex: 'Codex', claude: 'Claude', muse: 'Muse', grok: 'Grok', dsh: 'DeepSeek', hermes: 'Hermes' };
const agentIds = Object.keys(names);
const statusWord = { idle: '空闲', running: '运行中', approval: '等你批准', input: '等你回答', failed: '出错', offline: '离线', unknown: '状态未知' };
const titles = { 'Run a command': '要运行命令', 'Modify files': '要改文件', 'Tool approval': '要用工具' };
const working = new Set(['running', 'approval', 'input']);
const helperFolder = /\/\.vibe-island(?:\/|$)/;
const readCap = 6000;

const fn = (name, description, properties = {}, required = []) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', additionalProperties: false, properties, required } },
});
const session = {
  agent: { type: 'string', enum: agentIds, description: '会话所属的 Agent，来自 list_sessions' },
  id: { type: 'string', description: '会话 id，来自 list_sessions' },
};

export const toolSpecs = [
  fn('list_sessions', '看所有会话：Agent、标题、项目、状态（运行中、空闲、等你批准、等你回答、出错）、多久前有动静，还有等用户批准的请求。since_minutes 只列最近这么多分钟里动过的。', {
    agent: { type: 'string', enum: agentIds }, state: { type: 'string', enum: Object.keys(statusWord) },
    limit: { type: 'integer', minimum: 1, maximum: 40 }, since_minutes: { type: 'integer', minimum: 1, maximum: 10080 },
  }),
  fn('read_session', '读一个会话最近几轮。默认只给用户和 Agent 说的文字；只有文字答不了用户的问题时才加 include_tools 看工具调用。', {
    ...session, turns: { type: 'integer', minimum: 1, maximum: 10 }, include_tools: { type: 'boolean' },
  }, ['agent', 'id']),
  fn('send_to_session', '对会话说话。mode=task（默认）：派新任务并让它开始干，只能发给空闲的会话；mode=note：只留一句话，正在忙的会话做完这轮再看到。', {
    ...session, text: { type: 'string', minLength: 1, maxLength: 12000 }, mode: { type: 'string', enum: ['task', 'note'] },
  }, ['agent', 'id', 'text']),
  fn('start_session', '开一个新会话（Muse 是新的子对话），附上你写好的交代。要用户点头：先不带 confirmed 调用拿到 confirm_id 并问用户；用户说好后带 confirmed=true 和 confirm_id 再调。', {
    agent: { type: 'string', enum: agentIds }, text: { type: 'string', minLength: 1, maxLength: 12000 },
    cwd: { type: 'string' }, confirmed: { type: 'boolean' }, confirm_id: { type: 'string' },
  }, ['agent', 'text']),
  fn('interrupt_session', '让正在跑的会话停下。要用户点头，规则同 start_session。', {
    ...session, confirmed: { type: 'boolean' }, confirm_id: { type: 'string' },
  }, ['agent', 'id']),
  fn('answer_request', '替用户回答一个等待中的请求：批准或拒绝，选第几个选项，或者填文字。只在用户开口说了之后用（包括「你帮我选」）。', {
    request_id: { type: 'string' }, decision: { type: 'string', enum: ['allow', 'reject'] },
    option: { type: 'integer', minimum: 1, maximum: 9 }, text: { type: 'string', maxLength: 4000 },
  }, ['request_id']),
  fn('follow_up', '会话说做完了，但漏了用户派活时明确说过的东西：missing 只填用户原话里的原文片段，网关会对照原话、连同原话一起发过去。不能加用户没说的要求；同一件活只能自动追一次，再缺就问用户。', {
    ...session, missing: { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 200 } },
  }, ['agent', 'id', 'missing']),
  fn('recommend', '会话来要批准或提问时，读过上下文后给用户一个建议，挂在眼镜卡片上：批准请求给 decision，提问给 option，reason 一句话最多 14 个字。只是建议，不会替用户回答。', {
    request_id: { type: 'string' }, decision: { type: 'string', enum: ['allow', 'reject'] },
    option: { type: 'integer', minimum: 1, maximum: 9 }, reason: { type: 'string', minLength: 1, maxLength: 14 },
  }, ['request_id', 'reason']),
  fn('track_session', '用户让你盯着某个会话时用：之后它的每条新回复都会送来，不管是谁发起的。只在用户开口后用。', session, ['agent', 'id']),
  fn('drop_session', '用户说不用再盯某个会话时用。只在用户开口后用。', session, ['agent', 'id']),
  fn('compact', '把你自己较早的对话压缩成摘要。用户说「收一下」「太长了」时用。'),
  fn('clear_history', '清空你自己的对话历史，派活记录和说明文件保留。用户说「清空」时用。'),
  fn('remember_instruction', '把用户对总管本人的长期要求（「以后你……」）记进说明文件，以后每轮都会读，压缩也不会丢。要某个会话做的事、只管某件活的规矩不要记，转给那个会话。', {
    text: { type: 'string', minLength: 1, maxLength: 200 },
  }, ['text']),
  fn('report', '在眼镜胶囊下面给用户一行提醒。只在用户现在会想知道时用，几件事合成一句。', {
    text: { type: 'string', minLength: 1, maxLength: 40 },
  }, ['text']),
  fn('show_card', '在页面上摆一张卡：带 request_id 是审批或提问卡，用户可以直接选；带 agent 和 id 是会话卡。', {
    request_id: { type: 'string' }, ...session,
  }),
  fn('offer_choices', '备好用户下一步可能要你做的事，2 到 5 个，每个一句短话。用户在眼镜上不说话就能叫出来选，选中就当用户说了这句话。从常用指令出发，按眼下的情况改具体。', {
    options: { type: 'array', minItems: 2, maxItems: 5, items: { type: 'string', minLength: 1, maxLength: 30 } },
  }, ['options']),
];

const clip = (text, size) => (String(text ?? '').length > size ? String(text).slice(0, size) + '…' : String(text ?? ''));
const folder = (cwd) => String(cwd ?? '').split('/').filter(Boolean).at(-1) ?? '';
const label = (row) => names[row.agent] + '·' + (row.name || '未命名');

/** The lens line for one tool call, e.g. "读 Claude·眼镜胶囊". */
export function toolVerb(name, args, state) {
  const row = state.sessions.get(args?.agent + ':' + args?.id);
  const who = row ? label(row) : names[args?.agent] ?? '会话';
  switch (name) {
    case 'list_sessions': return '看所有会话';
    case 'read_session': return '读 ' + who + (args?.include_tools ? '（含工具）' : '');
    case 'send_to_session': return '发给 ' + who + '：' + clip(args?.text, 16);
    case 'start_session': return '开新的 ' + (names[args?.agent] ?? '') + ' 会话';
    case 'interrupt_session': return '打断 ' + who;
    case 'answer_request': return '回答请求';
    case 'recommend': return '建议 ' + (args?.decision ? (args.decision === 'allow' ? '允许' : '拒绝') : '选 ' + args?.option) + '：' + clip(args?.reason, 14);
    case 'track_session': return '盯 ' + who;
    case 'drop_session': return '不盯 ' + who;
    case 'follow_up': return '追问 ' + who + '：' + clip((args?.missing ?? []).join('；'), 16);
    case 'compact': return '压缩历史';
    case 'clear_history': return '清空历史';
    case 'remember_instruction': return '记下：' + clip(args?.text, 16);
    case 'report': return '提醒你：' + clip(args?.text, 20);
    case 'show_card': return '摆出卡片';
    case 'offer_choices': return null;
    default: return name;
  }
}

class ToolRefusal extends Error {}

/** How long ago, in the words the prompt uses: minutes, hours or days. */
function ago(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return minutes + ' 分钟前';
  if (minutes < 1440) return Math.round(minutes / 60) + ' 小时前';
  return Math.round(minutes / 1440) + ' 天前';
}

export class ZongguanTools {
  constructor({ state, store, submit, history, create, canCreate, queue, control, lastReply = null, stamp = (agent, id, text) => text }) {
    Object.assign(this, { state, store, submit, history, create, canCreate, queue, control, lastReply, stamp });
    this.agent = null; // set by Zongguan
    this.pending = new Map();
    this.advice = new Map(); // request id -> { decision } or { option }, plus a reason
  }

  async run(name, args = {}, turn) {
    const verb = toolVerb(name, args, this.state);
    const block = verb === null ? null : { kind: 'tool', text: verb }; // null: nothing the user needs to see
    const method = {
      list_sessions: this.list, read_session: this.read, send_to_session: this.send, start_session: this.start,
      interrupt_session: this.interrupt, answer_request: this.answer, follow_up: this.followUp, recommend: this.recommend, track_session: this.track, drop_session: this.drop, compact: this.compact, clear_history: this.clear,
      remember_instruction: this.remember, report: this.report, show_card: this.card, offer_choices: this.offer,
    }[name];
    if (!method) return { content: '没有这个工具：' + name, block };
    try {
      return { block, ...(await method.call(this, args ?? {}, turn)) };
    } catch (error) {
      if (error instanceof ToolRefusal) return { content: error.message, block };
      if (error instanceof ApiError) return { content: '没做成：' + error.message, block };
      return { content: '没做成，网关出错了。', block };
    }
  }

  row(args) {
    const row = this.state.sessions.get(args.agent + ':' + args.id);
    if (!row) throw new ToolRefusal('这个会话已经不在了，先 list_sessions。');
    return row;
  }

  requestsOf(row) {
    return [...this.state.requests.values()].filter((item) => item.agent === row.agent && item.session === row.id);
  }

  async list({ agent, state: wanted, limit = 20, since_minutes: since }) {
    const now = this.agent?.now?.() ?? Date.now();
    const after = Number(since) > 0 ? now - Number(since) * 60000 : null;
    const rows = [...this.state.sessions.values()]
      .filter((row) => !helperFolder.test(row.cwd ?? '') && (!agent || row.agent === agent))
      .filter((row) => after === null || (row.updatedAt ?? 0) >= after)
      .map((row) => ({ row, status: this.requestsOf(row).length ? 'approval' : row.status }))
      .filter((entry) => !wanted || entry.status === wanted)
      .sort((a, b) => (b.row.updatedAt ?? 0) - (a.row.updatedAt ?? 0))
      .slice(0, Math.min(Math.max(Number(limit) || 20, 1), 40));
    if (!rows.length) return { content: after === null ? '现在没有会话。' : '最近 ' + Number(since) + ' 分钟没有动过的会话。' };
    const lines = await Promise.all(rows.map(async ({ row, status }, index) => {
      let line = names[row.agent] + ' · ' + (row.name || '未命名') + ' · ' + (folder(row.cwd) || '-') + ' · '
        + (statusWord[status] ?? statusWord.unknown) + (row.updatedAt ? ' · ' + ago(now - row.updatedAt) : '')
        + '  [agent=' + row.agent + ' id=' + row.id + ']';
      // What it said last, for the eight most recent sessions only: every read can cost a command-line call.
      if (this.lastReply && index < 8) {
        const said = String(await this.lastReply(row).catch(() => '')).split('\n').find((part) => part.trim()) ?? '';
        if (said) line += '\n  最后一句：' + clip(said.trim(), 60);
      }
      for (const item of this.requestsOf(row)) {
        line += '\n  ' + (item.kind === 'input' ? '等你回答' : '等你批准') + ' request=' + item.id + '：'
          + (titles[item.title] ?? item.title ?? '') + (item.description ? ' ' + clip(item.description, 60) : '');
      }
      return line;
    }));
    return { content: lines.join('\n') };
  }

  async read({ agent, id, turns = 3, include_tools: tools = false }) {
    const row = this.row({ agent, id });
    const rows = (await this.history(row.agent, row.id, { tools: tools === true })) ?? [];
    // The last `turns` exchanges: count back over the user's messages.
    let start = 0;
    let seen = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].role === 'user' && ++seen >= Math.min(Math.max(Number(turns) || 3, 1), 10)) { start = i; break; }
    }
    const lines = rows.slice(start).flatMap((item) => {
      if (item.role === 'user' && item.text) return ['你：' + item.text];
      if (item.role === 'assistant' && item.text) return ['它：' + item.text];
      if (item.role === 'tool' && tools === true) return ['工具：' + (toolText(item.tool) || '用了工具')];
      return [];
    });
    let content = label(row) + '，' + (statusWord[row.status] ?? statusWord.unknown) + '\n' + (lines.join('\n') || '还没有内容。');
    if (content.length > readCap) content = '…' + content.slice(-readCap);
    return { content, kind: 'read' };
  }

  async send({ agent, id, text, mode = 'task' }, turn) {
    const row = this.row({ agent, id });
    const message = String(text ?? '').trim();
    if (!message) throw new ToolRefusal('要说的话是空的。');
    if (!row.capabilities.includes('send')) throw new ToolRefusal(label(row) + ' 只能看，不能发消息。');
    // Without the user's words 总管 sends nothing of its own: a missed item goes through follow_up, anything else to the user.
    if (turn?.source === 'event') throw new ToolRefusal('会话来消息时不能自己派活：漏了用户说过的用 follow_up，别的先问用户。');
    // The session sees what the user actually said, so 总管's wording never stands in for the user's.
    const said = turn?.source === 'user' ? String(turn.said ?? '').trim() : '';
    const full = message + (said ? '\n\n用户原话：「' + said + '」' : '\n\n（总管自己发的，不是用户说的）');
    const meta = { origin: 'zongguan', said };
    const busy = working.has(row.status) || this.requestsOf(row).length > 0;
    if (busy && mode === 'note') {
      const { h } = await this.queue(row.agent, row.id, full, meta);
      return { content: label(row) + '：' + h };
    }
    if (busy) throw new ToolRefusal('它正在忙：要打断先用 interrupt_session，或者用 mode=note 排队。');
    await this.submit(row.agent, row.id, this.stamp(row.agent, row.id, full, meta), randomUUID(), true);
    this.store.addTask({ agent: row.agent, session: row.id, task: clip(message, 120), said });
    return { content: '已发给 ' + label(row) + '，它做完会通知你。' };
  }

  /** One push on 总管's own, made only of the user's words: the quotes must be in them, and the words go along. */
  async followUp({ agent, id, missing }) {
    const row = this.row({ agent, id });
    if (!row.capabilities.includes('send')) throw new ToolRefusal(label(row) + ' 只能看，不能发消息。');
    if (working.has(row.status) || this.requestsOf(row).length > 0) throw new ToolRefusal('它正在忙，做完再说。');
    const task = this.store.lastTask(row.agent, row.id);
    const said = String(task?.said ?? '').trim();
    if (!said) throw new ToolRefusal('这件活没有用户原话，不能自己追；要追先问用户。');
    if (task.pushes >= 1) throw new ToolRefusal('已经自动追过一次了，问用户要不要再追。');
    const quotes = (Array.isArray(missing) ? missing : []).map((item) => String(item ?? '').trim()).filter(Boolean);
    if (!quotes.length) throw new ToolRefusal('要写漏了用户原话里的哪几句。');
    const bare = (text) => text.replace(/\s+/g, '');
    const stray = quotes.find((quote) => !bare(said).includes(bare(quote)));
    if (stray) throw new ToolRefusal('用户原话里没有：' + stray + '。只能引用原话。');
    const full = '你说过：' + quotes.map((quote) => '「' + quote + '」').join('；') + '，' + (quotes.length > 1 ? '这几条' : '这条')
      + '还没做，请补上。\n\n用户原话：「' + said + '」';
    const meta = { origin: 'zongguan', said };
    await this.submit(row.agent, row.id, this.stamp(row.agent, row.id, full, meta), randomUUID(), true);
    this.store.addTask({ agent: row.agent, session: row.id, task: clip('追问：' + quotes.join('；'), 120), said, pushes: task.pushes + 1 });
    return { content: '已追 ' + label(row) + '，只引用了用户原话；这件活不会再自动追。' };
  }

  /** start and interrupt: the first call asks; the confirmed call runs only after the user said yes. */
  confirmGate(name, args, turn, describe) {
    const { confirmed, confirm_id: confirmId, ...wanted } = args;
    if (confirmed !== true) {
      const id = randomUUID().slice(0, 8);
      this.pending.set(id, { name, args: wanted, at: this.agent?.now?.() ?? Date.now(), text: describe });
      return { content: '需要用户点头：' + describe + '。问用户；用户说好后带 confirmed=true 和 confirm_id=' + id + ' 再调。',
        card: { kind: 'confirm', confirmId: id, text: describe } };
    }
    const entry = this.pending.get(confirmId);
    if (!entry || entry.name !== name || JSON.stringify(entry.args) !== JSON.stringify(wanted)
      || turn?.source !== 'user' || !(turn.userAt > entry.at)) throw new ToolRefusal('等用户说好再做。');
    this.pending.delete(confirmId);
    return null;
  }

  async start(args, turn) {
    const agent = args.agent;
    if (!names[agent] || !this.canCreate(agent)) throw new ToolRefusal((names[agent] ?? agent) + ' 现在不能新开会话。');
    const text = String(args.text ?? '').trim();
    if (!text) throw new ToolRefusal('交代是空的。');
    const asked = this.confirmGate('start_session', { agent, text, ...(args.cwd ? { cwd: args.cwd } : {}) , confirmed: args.confirmed,
      confirm_id: args.confirm_id }, turn, '开一个新的 ' + names[agent] + ' 会话：' + clip(text, 30));
    if (asked) return asked;
    return this.doStart({ agent, text, cwd: args.cwd });
  }

  async doStart({ agent, text, cwd }) {
    await this.create(agent, text, cwd ? { cwd } : {});
    return { content: '已开新的 ' + names[agent] + (agent === 'muse' ? ' 子对话' : ' 会话') + '。' };
  }

  async interrupt(args, turn) {
    const row = this.row(args);
    if (!row.capabilities.includes('interrupt')) throw new ToolRefusal(label(row) + ' 不能从这里打断。');
    const asked = this.confirmGate('interrupt_session', { agent: row.agent, id: row.id, confirmed: args.confirmed,
      confirm_id: args.confirm_id }, turn, '打断 ' + label(row));
    if (asked) return asked;
    return this.doInterrupt({ agent: row.agent, id: row.id });
  }

  async doInterrupt({ agent, id }) {
    const row = this.row({ agent, id });
    await this.control(row.agent, row.id, 'interrupt');
    return { content: '已打断 ' + label(row) + '。' };
  }

  /** The user approved a confirm card on the glasses or the panel. */
  async runConfirmed(confirmId) {
    const entry = this.pending.get(confirmId);
    if (!entry) return { content: '这件事已经不在了。' };
    this.pending.delete(confirmId);
    try {
      return entry.name === 'start_session' ? await this.doStart(entry.args) : await this.doInterrupt(entry.args);
    } catch (error) {
      if (error instanceof ToolRefusal) return { content: error.message };
      return { content: '没做成：' + (error instanceof ApiError ? error.message : '网关出错了') };
    }
  }

  async answer({ request_id: id, decision, option, text }, turn) {
    if (turn?.source !== 'user') throw new ToolRefusal('只有用户开口后才能替他批准或回答。');
    const request = this.state.requests.get(id);
    if (!request) throw new ToolRefusal('这个请求已经处理过了。');
    if (decision) {
      if (request.kind === 'input') throw new ToolRefusal('这是个问题，要选一个选项或者填文字。');
      if (decision === 'allow' && request.approvalAllowed === false) throw new ToolRefusal('这条要在电脑上批准。');
      await this.state.decide(id, { decision: decision === 'allow' ? 'accept' : 'decline' });
      this.advice.delete(id);
      return { content: decision === 'allow' ? '已允许。' : '已拒绝。' };
    }
    const question = request.questions?.length === 1 ? request.questions[0] : null;
    if (!question) throw new ToolRefusal('这个要在电脑上回答。');
    if (option) {
      const choice = question.options?.[option - 1];
      if (!choice) throw new ToolRefusal('没有第 ' + option + ' 个选项。');
      await this.state.decide(id, { answers: { [question.id]: choice } });
      this.advice.delete(id);
      return { content: '已选：' + choice };
    }
    if (String(text ?? '').trim()) {
      await this.state.decide(id, { answers: { [question.id]: String(text).trim() } });
      this.advice.delete(id);
      return { content: '已回答。' };
    }
    throw new ToolRefusal('要给 decision、option 或 text。');
  }

  /** A suggestion for the user's card. It answers nothing: answer_request still waits for the user's words. */
  async recommend({ request_id: id, decision, option, reason }) {
    const request = this.state.requests.get(id);
    if (!request) throw new ToolRefusal('这个请求已经处理过了。');
    const why = [...String(reason ?? '').trim()].slice(0, 14).join('');
    if (!why) throw new ToolRefusal('要写一句理由。');
    if (request.kind === 'input') {
      if (!option) throw new ToolRefusal('这是个问题，要给 option。');
      const choices = request.questions?.length === 1 ? request.questions[0].options ?? [] : [];
      if (!choices[option - 1]) throw new ToolRefusal('没有第 ' + option + ' 个选项。');
      this.advice.set(id, { option, reason: why });
    } else {
      if (!decision) throw new ToolRefusal('批准请求要给 decision。');
      this.advice.set(id, { decision, reason: why });
    }
    return { content: '建议已挂在卡片上；用户说「好」就按建议回答。', card: { kind: 'request', requestId: id } };
  }

  /** "允许（理由）" or "选 2（理由）", or '' without advice. */
  adviceText(id) {
    const advice = this.advice.get(id);
    if (!advice) return '';
    return (advice.option ? '选 ' + advice.option : advice.decision === 'allow' ? '允许' : '拒绝') + '（' + advice.reason + '）';
  }

  async track({ agent, id }, turn) {
    if (turn?.source !== 'user') throw new ToolRefusal('盯哪个会话要等用户开口。');
    const row = this.row({ agent, id });
    this.agent.track(row);
    return { content: '开始盯 ' + label(row) + '，它的新回复都会送来。' };
  }

  async drop({ agent, id }, turn) {
    if (turn?.source !== 'user') throw new ToolRefusal('不盯哪个会话要等用户开口。');
    const row = this.state.sessions.get(agent + ':' + id);
    const name = row ? label(row) : (names[agent] ?? agent) + ' 的会话';
    return { content: this.agent.drop(agent + ':' + id) ? '不盯 ' + name + ' 了。' : '本来就没盯 ' + name + '。' };
  }

  async compact() {
    await this.agent.compact();
    return { content: '已压缩。' };
  }

  async clear() {
    this.agent.clearHistory();
    return { content: '已清空历史。' };
  }

  async offer({ options }) {
    const list = (Array.isArray(options) ? options : []).map((item) => clip(String(item ?? '').replace(/\s+/g, ' ').trim(), 30)).filter(Boolean);
    if (list.length < 2 || list.length > 5) throw new ToolRefusal('选项要两到五个。');
    this.agent.setChoices(list);
    return { content: '选项备好了，用户叫出来时会看到。' };
  }

  async remember({ text }) {
    if (!String(text ?? '').trim()) throw new ToolRefusal('要记的是空的。');
    this.store.addInstruction(text);
    return { content: '记下了。' };
  }

  async report({ text }, turn) {
    const line = clip(String(text ?? '').trim(), 40);
    if (!line) throw new ToolRefusal('提醒是空的。');
    if (turn?.reported) throw new ToolRefusal('这一轮已经提醒过了，一轮只提醒一次。');
    if (turn) turn.reported = true;
    // Finished or stalled work can wait; questions, approvals, failures and what the user asked for go out now.
    if (turn?.source === 'event' && !turn.urgent) {
      this.agent.holdReport(line);
      return { content: '已记下，用户下次开口、看总管页或过一会儿时一起报。' };
    }
    this.agent.publishReport(line);
    return { content: '已提醒。' };
  }

  async card({ request_id: requestId, agent, id }) {
    if (requestId) {
      if (!this.state.requests.has(requestId)) throw new ToolRefusal('这个请求已经处理过了。');
      return { content: '卡片已摆出。', card: { kind: 'request', requestId } };
    }
    const row = this.row({ agent, id });
    const status = this.requestsOf(row).length ? 'approval' : row.status;
    return { content: '卡片已摆出。', block: { kind: 'detail', text: names[row.agent] + ' · ' + (row.name || '未命名') + ' · ' + (statusWord[status] ?? statusWord.unknown) } };
  }
}
