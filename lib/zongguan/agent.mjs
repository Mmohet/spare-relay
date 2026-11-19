import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { ModelError } from './model.mjs';
import { toolSpecs } from './tools.mjs';

/*
 * 总管: Relay's own super agent. Underneath it works like the Codex and Claude Code CLIs (a loop over tools,
 * one long history, automatic compaction); on the surface it talks like a chat product: short, conclusion first.
 * A turn starts when the user speaks or when sessions report something (finished, failed, asking, stalled).
 */

export const zongguanPrompt = `你是「总管」，Relay 里替用户管所有 Agent 会话（Codex、Claude Code、Muse、Grok、DeepSeek）的超级 Agent。
你的工作是派活和转述，不是干活：你没有读文件、跑命令、改代码的工具，也不要想怎么做，只看做没做成。

你是在跟用户对话，不是写东西给他看。用户戴着眼镜，屏幕离得远，只能扫一眼，多半在走路或说话。
- 能不说的就不说：上下文已经有的、跟上一条一样的不说，能一句就不两句，能合并的合并，开头不说「收到」「好的」「我记下了」。省的是不带新信息的词和句，不是把词缩成怪字（「会话」不能写成「话」）。例：「你在眼镜上说的话、从眼镜新开的会话」→「眼镜上说的和新开的会话」；「你在电脑上自己跑的不再报，也不追问」→「电脑上跑的不再报也不追问」。
- 开头一个符号当锚点：✓ 做完、好了；? 要用户定；→ 已转达、已派出；✗ 出错、没做成；… 还在做。后面紧跟会话简称和结论，说完就停。之后只留用户要做或要定的事；会话说的计划、自查项、提醒、数字细节都不转，用户问了再说。例：「宣传视频那个会话修好了一个缓存 bug，现在第三次渲染正在进行」→「… 宣传视频：第三次渲染中」；「那个宣传视频会话在等你定一件事：开场那 44 秒录音是整段不切、原样放在片头，还是切成两段」→「? 宣传视频：开场录音整段放片头还是切两段」；「✓ 网关已在 14:37 重启，跟进、卡片建议都生效了。接下来，它会按这些规则工作：漏做会追一次，批准卡片会带建议」→「✓ 网关重启了，跟进和卡片建议都生效」。
- 提到会话一律用简称，从会话名里取几个字（「宣传视频」「Relay 网关」），不说「那个会话」「那个 Claude 会话」；简称撞了才加 Agent 名。
- 只说看到的：消息里没写的原因不猜（不说「可能还在跑或出错了」）。
- 用户要照着做的内容（要他点什么、装什么、选什么）另起一段写清楚，最多两句；别的细节不写，用户问了再说。
- 直接说结论，不铺垫、不复述用户的话、不客套、不在结尾总结或问「还要别的吗」。
- 不用标题、列表、表格、粗体；要说几件事就用逗号或分号连成一句。
- 不贴过程和日志；用户问了再展开，展开也只说他问的那一点。
- 看进展先 list_sessions；读会话默认只看文字，只有文字答不了用户的问题时才加 include_tools。
- 派活：转述用户的话只修语法、补全省略，不加意思，不替用户加步骤、理由或要求（网关会在后面附上用户原话）；空闲的会话直接发；正在忙的会话要么用 mode=note 排队，要么问用户要不要打断。
- 打断正在跑的会话、开新会话，先问用户；用户说好再带 confirmed=true 调用。
- 会话来要批准或提问（APPROVAL、QUESTION），先 read_session 看它在干什么，再用 recommend 给一个建议和一句理由；拿不准就不建议。建议只挂在卡片上，不能自己回答。
- 用户说「好」，对应的请求有你的建议，就按建议回答。
- 用户说「好」「不行」「选第二个」「你帮我选」，就替他回答对应的请求；你帮他选时说清选了什么。说的话能对上好几件事时，用一句话问是哪件，不要猜。
- 用户说「收一下」「太长了」就压缩；说「清空」就清空；对你本人的长期要求（「以后你……」「总管以后……」）才用 remember_instruction 记进说明文件；要某个会话做的事、只管某件活的规矩，转给那个会话，不记。
- 会话做完时消息里带着「派活时用户原话」：逐条对照它交的结果。用户明确说过、它没做的，用 follow_up 追一次，只填原话里的原文；用户没说的不算漏，不要加要求。标了「已经自动追过一次」还缺的，不再追，在回复里问用户要不要再追。都做到了就不用追。
- 会话来消息时你不能自己派新活，只能 follow_up；别的要等用户开口。
- 送来的会话消息只有这几种：Relay 发起的那一轮（你派的、用户在眼镜上说的、Relay 新开的）做完、出错、卡住；任何会话的批准和提问；用户让你盯的会话的新回复（NEW_REPLY）。用户在电脑上自己跑的不会送来，你也不用提。
- 用户说「帮我盯着 X」就先 list_sessions 找到它再 track_session；说「不用盯了」「drop 掉」就 drop_session。
- 会话的消息以「Message Type / Sender / Payload」的形式送来。值得用户现在知道的，用 report 给一行提醒（几件事合成一句）；不值得的只记下，不要打扰。进度（在渲染、在重跑、修了个小问题再来）也可以说，但比结论还短：只说在干什么，要多久可以带上，不说做完后打算干什么，例「… 宣传视频：v17 渲染中，约十分钟」；跟上一条进度比没变就不回话。
- 做完一件事，用一句话说你做了什么。
- 每一轮最后用 offer_choices 备好用户下一步可能要你做的事（2 到 5 个短句）：从常用指令出发，按眼下的情况改具体，比如有会话在等用户就放最前，填上真实的会话简称。用户在眼镜上不说话也能叫出来选，选中就当用户说了那句话。`;

// Last in the system prompt, so the length rules are what the model reads right before the session's long message.
export const replyCheck = `## 回话前对一遍
符号、会话简称、结论，一句说完；之后只留用户要做或要定的事，要定的只说定什么和选项，每个选项几个字。进度只说在干什么。会话说的计划、自查项、提醒、细节，和客套话，都删掉。`;

const compactPrompt = `把下面这段「总管」和用户、各会话的对话压成摘要，最多 40 行，中文。
保留：用户的要求和决定、派给谁什么活、各会话做成了什么或卡在哪、还没解决的事。不要过程细节。`;

const working = new Set(['running', 'approval', 'input']);
const urgent = new Set(['QUESTION', 'APPROVAL', 'FAILED']);
const helperFolder = /\/\.vibe-island(?:\/|$)/;
const placeholder = /^（(没有文字回复|读不到它的回复)）$/; // what lastWords says when there is no reply to read
const names = { codex: 'Codex', claude: 'Claude', muse: 'Muse', grok: 'Grok', dsh: 'DeepSeek', hermes: 'Hermes' };
const offText = '总管没配好：钥匙串里没有 relay-opencode';
const dismiss = '不用了'; // the last choice on the choices card: close it
const keepBlocks = 200;

export class Zongguan extends EventEmitter {
  constructor({ state, store, tools, model, compactAt = 300000, batchMs = 3000, digestMs = 300000, quietMs = 30000, stallMs = 600000, stallEvery = 60000, maxSteps = 12, now = Date.now }) {
    super();
    Object.assign(this, { state, store, tools, model, compactAt, batchMs, digestMs, quietMs, stallMs, stallEvery, maxSteps, now });
    this.enabled = Boolean(model);
    tools.agent = this;
    store.repair();
    this.blocks = store.meta('blocks') ?? [];
    this.reports = store.meta('reports') ?? [];
    this.unread = Boolean(store.meta('unread'));
    // Reports from news that can wait (finished, stalled): they go out together later.
    this.held = store.meta('held') ?? [];
    this.heldTimer = null;
    if (this.held.length) this.armHeld();
    this.status = 'idle';
    this.since = now();
    this.card = null;
    this.choices = store.meta('choices') ?? []; // what 总管 prepared for the user to pick without speaking
    this.waiting = [];
    this.inbox = [];
    this.events = [];
    this.busy = false;
    this.turnNow = null;
    this.statusOf = new Map();
    this.runSince = new Map();
    this.stalled = new Set();
    this.seenRequests = new Set();
    // When Relay last sent each session a message (0: Relay started the session). Finished, failed and stalled turns
    // reach 总管 only when Relay started them; what the user runs on the computer stays out. Questions always come.
    this.relaySent = new Map(store.meta('relaySent') ?? []);
    this.startOf = new Map(); // when the session last left idle
    // Sessions the user asked 总管 to track: every new reply reaches it, wherever it came from.
    this.tracked = store.meta('tracked') ?? [];
    this.lastText = new Map(); // key -> the reply 总管 last heard from it
    this.seenUpdated = new Map();
    this.quietTimers = new Map();
  }

  /* ----- the user ----- */

  async hear(text, from = 'glasses') {
    const words = String(text ?? '').trim();
    if (!this.enabled) return { st: 'off', h: offText };
    if (!words) return { st: 'empty', h: '没听到内容' };
    this.flushReports();
    // When the words were said: a confirmation needs words said after 总管 asked.
    this.waiting.push({ text: words, from, at: this.now() });
    if (this.busy) return { st: 'queued', h: '总管收到，这件做完就办' };
    this.kick();
    return { st: 'sent', h: '总管收到' };
  }

  /**
   * The user answered a confirm card on the glasses or the panel. The answer runs as a turn of its own in the
   * same queue as speech, so it never lands between a tool call and its result.
   */
  async confirm(confirmId, yes) {
    if (!this.tools.pending.has(confirmId)) return { st: 'gone', h: '已经处理过了' };
    let done;
    const result = new Promise((resolve) => { done = resolve; });
    const queued = this.busy;
    this.waiting.push({ card: true, confirmId, yes, done });
    this.kick();
    return queued ? { st: 'queued', h: '总管收到' } : result;
  }

  async cardTurn(job) {
    const turn = this.store.nextTurn();
    this.turnNow = turn;
    this.setStatus('working');
    try {
      if (!this.tools.pending.has(job.confirmId)) { job.done({ st: 'gone', h: '已经处理过了' }); return; }
      this.store.append({ role: 'user', content: '（在卡片上选了）' + (job.yes ? '好' : '不要') }, { turn, kind: 'chat' });
      this.block('user', job.yes ? '好' : '不要');
      let result;
      if (job.yes) result = await this.tools.runConfirmed(job.confirmId);
      else {
        this.tools.pending.delete(job.confirmId);
        result = { content: '好，不做了。' };
      }
      this.store.append({ role: 'assistant', content: result.content }, { turn, kind: 'chat' });
      this.block('reply', result.content);
      job.done({ st: 'ok', h: result.content });
    } catch (error) {
      this.store.repair();
      this.block('error', '总管出错了：' + failure(error));
      job.done({ st: 'fail', h: '没做成，请到电脑上看' });
    } finally {
      this.turnNow = null;
      this.setStatus('idle');
    }
  }

  /** offer_choices: the options the user can call up without speaking. */
  setChoices(options) {
    this.choices = options;
    this.store.setMeta('choices', options);
  }

  /**
   * The user called up the options without speaking (an empty message on 总管's page): 总管's latest options, else
   * the first common commands, then 不用了. Nothing to offer is answered like an empty message.
   */
  menu() {
    if (!this.enabled) return { st: 'off', h: offText };
    const options = (this.choices.length ? this.choices : this.store.commands()).slice(0, 5);
    if (!options.length) return { st: 'empty', h: '没听到内容' };
    this.card = { kind: 'choices', choiceId: randomUUID(), options: [...options, dismiss] };
    this.emit('change');
    return { st: 'ok', h: '选一个' };
  }

  /** The user picked option n (1-based) on the choices card: 不用了 closes it, anything else is said to 总管. */
  async choose(choiceId, n) {
    const card = this.card;
    if (card?.kind !== 'choices' || card.choiceId !== choiceId) return { st: 'gone', h: '已经处理过了' };
    const option = card.options[Number(n) - 1];
    if (!option) return { st: 'fail', h: '没有这一项' };
    this.card = null;
    this.emit('change');
    if (option === dismiss) return { st: 'ok', h: '好' };
    return this.hear(option, 'glasses');
  }

  /* ----- sessions ----- */

  watch() {
    for (const row of this.state.sessions.values()) {
      this.statusOf.set(row.agent + ':' + row.id, row.status);
      if (working.has(row.status)) this.startOf.set(row.agent + ':' + row.id, row.updatedAt ?? this.now());
      if (row.status === 'running') this.runSince.set(row.agent + ':' + row.id, row.updatedAt ?? this.now());
    }
    for (const id of this.state.requests.keys()) this.seenRequests.add(id);
    for (const key of this.tracked) {
      const row = this.state.sessions.get(key);
      if (row) this.baseline(row);
    }
    this.listener = (event) => this.observe(event);
    this.state.on('event', this.listener);
    this.stallTimer = setInterval(() => this.checkStalls(), this.stallEvery);
    this.stallTimer.unref?.();
  }

  close() {
    if (this.listener) this.state.off('event', this.listener);
    clearInterval(this.stallTimer);
    clearTimeout(this.inboxTimer);
    clearTimeout(this.heldTimer);
    for (const timer of this.quietTimers.values()) clearTimeout(timer);
  }

  observe(event) {
    if (!event.session || !names[event.agent]) return;
    const key = event.agent + ':' + event.session;
    const row = this.state.sessions.get(key);
    if (event.kind === 'message.requested' || event.kind === 'session.created') {
      this.markRelay(key, event.kind === 'session.created' ? 0 : this.now());
      return;
    }
    if (event.kind === 'session') {
      if (!row) { this.statusOf.delete(key); return; }
      const before = this.statusOf.get(key);
      this.statusOf.set(key, row.status);
      if (working.has(row.status) && !working.has(before)) this.startOf.set(key, this.now());
      const ours = this.fromRelay(key);
      const tracked = this.tracked.includes(key);
      if (!working.has(row.status)) this.startOf.delete(key);
      if (tracked && (row.updatedAt ?? 0) > (this.seenUpdated.get(key) ?? 0)) {
        this.seenUpdated.set(key, row.updatedAt);
        this.whenQuiet(key);
      }
      if (row.status === 'running' && before !== 'running') { this.runSince.set(key, this.now()); this.stalled.delete(key); }
      if (row.status !== 'running') this.runSince.delete(key);
      if (helperFolder.test(row.cwd ?? '') || before === row.status) return;
      if ((working.has(before) && row.status === 'idle') || (row.status === 'failed' && before !== undefined)) {
        if (!ours && !tracked) { if (row.status === 'idle') this.store.finishTasks(row.agent, row.id); return; }
        if (ours) this.markRelay(key, null);
      }
      if (working.has(before) && row.status === 'idle') {
        // The user's words for what it was asked, so 总管 can check the result against them.
        const task = this.store.openTasks().filter((item) => item.agent === row.agent && item.session === row.id && item.said).at(-1);
        this.store.finishTasks(row.agent, row.id);
        const asked = task ? '\n派活时用户原话：「' + task.said + '」' + (task.pushes >= 1 ? '（已经自动追过一次）' : '') : '';
        // The status can flap (idle, running, idle) with no new reply; the reply 总管 already heard is no news.
        const words = this.lastWords(row).then((text) => {
          if (text === this.lastText.get(key) && !placeholder.test(text)) return null;
          this.lastText.set(key, text);
          return text + asked;
        });
        this.queueEvent('FINAL_ANSWER', row, words);
      } else if (row.status === 'failed' && before !== undefined) {
        this.queueEvent('FAILED', row, '这一轮出错了。');
      }
    }
    if (event.kind === 'activity' && row && this.tracked.includes(key)) this.whenQuiet(key);
    if (event.kind === 'attention' && row && !helperFolder.test(row.cwd ?? '')) {
      for (const request of this.state.requests.values()) {
        if (request.agent !== row.agent || request.session !== row.id || this.seenRequests.has(request.id)) continue;
        this.seenRequests.add(request.id);
        this.queueEvent(request.kind === 'input' ? 'QUESTION' : 'APPROVAL', row,
          [request.title, request.description, ...(request.questions ?? []).map((q) => q.text)].filter(Boolean).join('：') + '（request=' + request.id + '）');
      }
    }
  }

  checkStalls() {
    for (const [key, since] of this.runSince) {
      if (this.stalled.has(key) || this.now() - since < this.stallMs) continue;
      const row = this.state.sessions.get(key);
      if (!row || row.status !== 'running' || helperFolder.test(row.cwd ?? '')) continue;
      this.stalled.add(key);
      if (!this.fromRelay(key) && !this.tracked.includes(key)) continue;
      this.queueEvent('STALLED', row, '已经 ' + Math.round((this.now() - since) / 60000) + ' 分钟没有新动静。');
    }
  }

  /** Start tracking a session: what it says from now on reaches 总管. */
  track(row) {
    const key = row.agent + ':' + row.id;
    if (!this.tracked.includes(key)) this.tracked = [...this.tracked, key].slice(-40);
    this.store.setMeta('tracked', this.tracked);
    this.baseline(row);
  }

  /** Stop tracking; false when it was not tracked. */
  drop(key) {
    if (!this.tracked.includes(key)) return false;
    this.tracked = this.tracked.filter((item) => item !== key);
    this.store.setMeta('tracked', this.tracked);
    clearTimeout(this.quietTimers.get(key));
    this.quietTimers.delete(key);
    this.lastText.delete(key);
    return true;
  }

  /** What it says now counts as heard, so only later replies are news. */
  baseline(row) {
    const key = row.agent + ':' + row.id;
    this.seenUpdated.set(key, row.updatedAt ?? 0);
    this.lastWords(row).then((text) => { if (!this.lastText.has(key)) this.lastText.set(key, text); });
  }

  /**
   * Codex, Grok and Muse report a reply made elsewhere only as activity or a newer update time. Once the session has
   * been quiet for quietMs, 总管 hears its last reply if that changed.
   */
  whenQuiet(key) {
    clearTimeout(this.quietTimers.get(key));
    const timer = setTimeout(async () => {
      this.quietTimers.delete(key);
      const row = this.state.sessions.get(key);
      if (!row || !this.tracked.includes(key) || working.has(row.status)) return;
      const text = await this.lastWords(row);
      if (placeholder.test(text) || text === this.lastText.get(key)) return;
      this.lastText.set(key, text);
      this.queueEvent('NEW_REPLY', row, text);
    }, this.quietMs);
    timer.unref?.();
    this.quietTimers.set(key, timer);
  }

  /** Relay sent this session a message at `at` (0: Relay started it); null forgets it. Kept across restarts. */
  markRelay(key, at) {
    if (at === null) this.relaySent.delete(key); else this.relaySent.set(key, at);
    this.store.setMeta('relaySent', [...this.relaySent].slice(-200));
  }

  /** The turn running now began after Relay's message, so Relay started it rather than the user at the computer. */
  fromRelay(key) {
    const sent = this.relaySent.get(key);
    return sent !== undefined && (this.startOf.get(key) ?? -1) >= sent;
  }

  async lastWords(row) {
    try {
      const rows = (await this.tools.history(row.agent, row.id, { tools: false })) ?? [];
      const text = [...rows].reverse().find((item) => item.role === 'assistant' && item.text)?.text ?? '';
      return text.length > 1500 ? text.slice(0, 1500) + '…' : text || '（没有文字回复）';
    } catch {
      return '（读不到它的回复）';
    }
  }

  queueEvent(type, row, payload) {
    if (!this.enabled) return;
    // The user is waiting on these: their reports go out at once.
    if (urgent.has(type)) this.inboxUrgent = true;
    // A payload of null is news that turned out not to be (see FINAL_ANSWER).
    this.inbox.push(Promise.resolve(payload).then((text) => text === null ? null : 'Message Type: ' + type + '\nSender: ' + names[row.agent] + '·'
      + (row.name || '未命名') + ' (' + row.agent + ':' + row.id + ')\nPayload: ' + text));
    if (this.inboxTimer) return;
    this.inboxTimer = setTimeout(async () => {
      this.inboxTimer = null;
      const messages = (await Promise.all(this.inbox.splice(0))).filter(Boolean);
      const isUrgent = Boolean(this.inboxUrgent);
      this.inboxUrgent = false;
      if (!messages.length) return;
      this.events.push({ text: messages.join('\n\n'), urgent: isUrgent });
      this.kick();
    }, this.batchMs);
    this.inboxTimer.unref?.();
  }

  /* ----- turns ----- */

  kick() {
    if (this.busy) return;
    this.busy = true;
    (async () => {
      try {
        for (;;) {
          if (this.waiting.length) {
            const job = this.waiting.shift();
            if (job.card) await this.cardTurn(job); else await this.turn({ source: 'user', ...job });
          }
          // Everything sessions said while 总管 was busy goes into one turn.
          else if (this.events.length) {
            const batch = this.events.splice(0);
            await this.turn({ source: 'event', text: batch.map((item) => item.text).join('\n\n'), urgent: batch.some((item) => item.urgent) });
          }
          else break;
        }
      } finally {
        this.busy = false;
      }
    })();
  }

  system() {
    const tasks = this.store.openTasks().map((task) => '- ' + names[task.agent] + '（' + task.agent + ':' + task.session + '）：' + task.task);
    const asks = [...this.state.requests.values()].map((item) => '- request=' + item.id + ' ' + (names[item.agent] ?? item.agent)
      + '：' + [item.title, item.description].filter(Boolean).join('：')
      + (this.tools.adviceText(item.id) ? ' · 总管建议：' + this.tools.adviceText(item.id) : ''));
    const confirms = [...this.tools.pending.entries()].map(([id, entry]) => '- confirm_id=' + id + '：' + entry.text);
    const commands = this.store.commands().map((line) => '- ' + line);
    return zongguanPrompt
      + '\n\n## 现在\n' + clock(this.now())
      + '\n\n## 说明文件（用户的长期要求）\n' + (this.store.instructions().trim() || '（空）')
      + '\n\n## 常用指令\n' + (commands.join('\n') || '（无）')
      + '\n\n## 派出去还没做完的活\n' + (tasks.join('\n') || '（无）')
      + '\n\n## 你在盯的会话\n' + (this.tracked.map((key) => {
        const row = this.state.sessions.get(key);
        return '- ' + (row ? names[row.agent] + '·' + (row.name || '未命名') : key) + '（' + key + '）';
      }).join('\n') || '（无）')
      + '\n\n## 等用户批准或回答的请求\n' + (asks.join('\n') || '（无）')
      + '\n\n## 等用户点头的事\n' + (confirms.join('\n') || '（无）')
      + '\n\n' + replyCheck;
  }

  async turn(job) {
    const turn = this.store.nextTurn();
    this.turnNow = turn;
    this.store.elideReads(turn);
    this.setStatus('working');
    try {
      if (Number(this.store.meta('promptTokens') ?? 0) >= this.compactAt) {
        try { await this.compact(); } catch (error) { this.block('error', '自动压缩没成功：' + failure(error)); }
      }
      const context = { id: turn, source: job.source, userAt: job.source === 'user' ? job.at ?? this.now() : 0,
        said: job.source === 'user' ? job.text : '', urgent: job.source === 'event' && Boolean(job.urgent) };
      this.store.append({ role: 'user', content: job.text }, { turn, kind: job.source === 'user' ? 'chat' : 'event' });
      if (job.source === 'user') this.block('user', job.text);
      for (let step = 0; step < this.maxSteps; step++) {
        const { message, promptTokens } = await this.model.complete({
          messages: [{ role: 'system', content: this.system() }, ...this.store.messages().map((row) => row.message)],
          tools: toolSpecs,
        });
        this.store.setMeta('promptTokens', promptTokens);
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
        this.store.append({ role: 'assistant', content: message.content ?? null, ...(calls.length ? { tool_calls: calls } : {}) }, { turn, kind: 'chat' });
        if (!calls.length) {
          if (message.content) this.block('reply', String(message.content).trim());
          return;
        }
        if (message.content) this.block('reply', String(message.content).trim());
        for (const call of calls) {
          let args = {};
          try { args = JSON.parse(call.function?.arguments || '{}'); } catch { args = null; }
          const result = args === null ? { content: '参数不是 JSON。', block: { kind: 'tool', text: call.function?.name ?? '' } }
            : await this.tools.run(call.function?.name, args, context);
          this.store.append({ role: 'tool', tool_call_id: call.id, content: result.content }, { turn, kind: result.kind ?? 'chat' });
          if (result.block) this.block(result.block.kind, result.block.text);
          if (result.card) { this.card = result.card; this.emit('change'); }
        }
      }
      this.block('error', '这件事步骤太多，先停下了。');
    } catch (error) {
      this.store.repair();
      this.block('error', '总管出错了：' + failure(error));
      // Session news never reaches standby on its own while 总管 is on, so a failed event turn says so there.
      if (job.source === 'event') this.publishReport(('总管出错了：' + failure(error)).slice(0, 40));
    } finally {
      this.turnNow = null;
      this.setStatus('idle');
    }
  }

  /** Summarise every message before the current turn; the current turn's tool call and result stay paired. */
  async compact() {
    const cutoff = this.turnNow ? this.store.lastSeqBefore(this.turnNow) : Infinity;
    const old = this.store.messages().filter((row) => row.seq <= cutoff);
    if (old.length < 2) return;
    const transcript = old.map(({ message }) => {
      const calls = (message.tool_calls ?? []).map((call) => '[调用 ' + call.function?.name + ' ' + (call.function?.arguments ?? '') + ']').join(' ');
      return message.role + '：' + [message.content ?? '', calls].filter(Boolean).join(' ');
    }).join('\n');
    const { message } = await this.model.complete({ messages: [{ role: 'system', content: compactPrompt }, { role: 'user', content: transcript }] });
    const summary = String(message.content ?? '').trim() || '（没有可记的）';
    const minutes = Math.max(1, Math.round((this.now() - old[0].at) / 60000));
    const span = minutes < 60 ? minutes + ' 分钟' : Math.round(minutes / 60) + ' 小时';
    const marker = '— 已压缩 · 前 ' + span + '记成 ' + summary.split('\n').filter((line) => line.trim()).length + ' 行摘要 —';
    this.store.compactUpTo(old.at(-1).seq, summary, marker);
    this.store.setMeta('promptTokens', 0);
    this.block('compacted', marker);
  }

  clearHistory() {
    if (this.turnNow) this.store.clearBefore(this.turnNow); else this.store.clear();
    this.store.setMeta('promptTokens', 0);
    this.blocks = [];
    this.block('compacted', '— 已清空历史 —');
  }

  /** A report that can wait: it goes out with the next urgent one, when the user speaks or opens the page, or after digestMs. */
  holdReport(text) {
    this.held = [...this.held, text].slice(-20);
    this.store.setMeta('held', this.held);
    this.armHeld();
  }

  armHeld() {
    if (this.heldTimer) return;
    this.heldTimer = setTimeout(() => { this.heldTimer = null; this.flushReports(); }, this.digestMs);
    this.heldTimer.unref?.();
  }

  flushReports() {
    if (!this.held.length) return;
    this.publishReport(null);
  }

  /** One report; whatever was held goes out with it, joined, or shortened when it does not fit in a line. */
  publishReport(text) {
    const lines = [...this.held, ...(text ? [text] : [])];
    if (!lines.length) return;
    this.held = [];
    this.store.setMeta('held', []);
    clearTimeout(this.heldTimer);
    this.heldTimer = null;
    const joined = lines.join('；');
    text = lines.length === 1 || [...joined].length <= 40 ? joined
      : [...(lines.length + ' 件事：' + lines[0])].slice(0, 40).join('');
    const seq = (this.reports.at(-1)?.seq ?? 0) + 1;
    this.reports = [...this.reports, { seq, text, at: this.now() }].slice(-20);
    this.unread = true;
    this.store.setMeta('reports', this.reports);
    this.store.setMeta('unread', true);
    this.emit('change');
  }

  markRead() {
    this.flushReports();
    if (!this.unread) return;
    this.unread = false;
    this.store.setMeta('unread', false);
    this.emit('change');
  }

  /* ----- what the glasses and the panel draw ----- */

  block(kind, text) {
    if (!text) return;
    this.blocks = [...this.blocks, { kind, text, at: this.now() }].slice(-keepBlocks);
    this.store.setMeta('blocks', this.blocks);
    this.emit('change');
  }

  setStatus(status) {
    this.status = status;
    this.since = this.now();
    this.emit('change');
  }

  /** 总管's suggestion for a waiting request, for the glasses card. */
  adviceFor(id) {
    return this.state.requests.has(id) ? this.tools.advice.get(id) ?? null : null;
  }

  activeCard() {
    const card = this.card;
    if (card?.kind === 'request' && this.state.requests.has(card.requestId)) return card;
    if (card?.kind === 'confirm' && this.tools.pending.has(card.confirmId)) return card;
    if (card?.kind === 'choices') return card;
    return null;
  }

  view() {
    const tokens = Number(this.store.meta('promptTokens') ?? 0);
    return {
      status: this.enabled ? this.status : 'off', since: this.since,
      contextPct: Math.min(100, Math.round((tokens / this.compactAt) * 100)),
      openTasks: this.store.openTasks().length, blocks: this.blocks, card: this.activeCard(),
      ...(this.enabled ? {} : { offText }),
    };
  }
}

/** Local date and time for the prompt, e.g. 2026-11-19 09:05（周四）. */
function clock(at) {
  const d = new Date(at);
  const two = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes())
    + '（周' + '日一二三四五六'[d.getDay()] + '）';
}

function failure(error) {
  return error instanceof ModelError ? error.message : '网关出错了';
}
