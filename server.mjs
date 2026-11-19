import { createServer } from 'node:http';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { agents, ApiError, limitText, State } from './lib/state.mjs';
import { Codex } from './lib/codex.mjs';
import { Bridge } from './lib/bridge.mjs';
import { MacChat } from './lib/mac-chat.mjs';
import { ClaudeObserver } from './lib/claude-observer.mjs';
import { ClaudeCli } from './lib/claude-cli.mjs';
import { MuseCli } from './lib/muse-cli.mjs';
import { GbotCli } from './lib/gbot.mjs';
import { defaultWords, norm, NovaTools, VoiceDesk, wordNames } from './lib/voice.mjs';
import { SpareGlasses } from './lib/spare.mjs';
import { DshWeb } from './lib/dsh.mjs';
import { HermesAcp } from './lib/hermes.mjs';
import { openCode, readKey } from './lib/zongguan/model.mjs';
import { ZongguanStore } from './lib/zongguan/store.mjs';
import { ZongguanTools } from './lib/zongguan/tools.mjs';
import { Zongguan } from './lib/zongguan/agent.mjs';

const cookieName = 'agent_panel';
const idPattern = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(req) {
  return /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function body(req, limit = 128 * 1024) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new ApiError(415, 'Expected a JSON request.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ApiError(413, 'Request body is too large.');
    chunks.push(chunk);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks));
    if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  } catch { /* Respond with the same error for invalid JSON. */ }
  throw new ApiError(400, 'Expected a JSON object.');
}

function sameOrigin(req, publicOrigin) {
  const origin = req.headers.origin;
  if (!origin) return;
  let parsed;
  try { parsed = new URL(origin); } catch { throw new ApiError(403, 'Origin is not allowed.'); }
  if (publicOrigin ? parsed.origin !== publicOrigin : parsed.host !== req.headers.host) {
    throw new ApiError(403, 'Origin is not allowed.');
  }
}

function sessionDigest(token, session) {
  return createHmac('sha256', token).update('relay-browser-session:' + session).digest('hex');
}

function authorized(req, config, state) {
  if (equal(bearer(req), config.panelToken)) return true;
  const session = req.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(session ?? '')
    && state.loginValid(sessionDigest(config.panelToken, session), Date.now());
}

/** Spoken aliases per command: up to 8 short phrases each; an empty list falls back to the defaults. */
function voiceWords(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError(400, 'Voice words must be an object.');
  const words = {};
  for (const name of Object.keys(defaultWords)) {
    const list = input[name];
    if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 8 || list.some((word) => typeof word !== 'string' || !norm(word) || word.length > 16)) {
      throw new ApiError(400, 'Each command takes up to 8 phrases of 1–16 characters.');
    }
    if (list.length) words[name] = list.map((word) => word.trim());
  }
  return words;
}

/** A spoken phrase that jumps to one session (agent + id) or one project folder (cwd). */
function voiceShortcuts(input, state) {
  if (!Array.isArray(input) || input.length > 30) throw new ApiError(400, 'Shortcuts must be a list of at most 30.');
  return input.map((item) => {
    const phrase = typeof item?.phrase === 'string' ? item.phrase.trim() : '';
    if (!norm(phrase) || phrase.length > 16) throw new ApiError(400, 'A shortcut needs a phrase of 1–16 characters.');
    if (typeof item.cwd === 'string' && item.cwd.startsWith('/')) return { phrase, cwd: item.cwd.slice(0, 500) };
    const row = state.get(item.agent, item.id);
    if (!row.capabilities.includes('send')) throw new ApiError(409, 'A shortcut needs a writable session.');
    return { phrase, agent: row.agent, id: row.id };
  });
}

function sse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  });
  res.flushHeaders();
}

function subscribe(req, res, state, watch) {
  sse(res);
  watch.panels += 1;
  const send = (event) => {
    const { text, ...safe } = event;
    if (!res.write((event.seq !== undefined ? 'id: ' + event.seq + '\n' : '')
      + 'data: ' + JSON.stringify(event.kind === 'delta' ? { ...safe, text } : safe) + '\n\n')) {
      res.end(); // Reconnect and replay persistent events if a client falls behind.
    }
  };
  const cursor = req.headers['last-event-id'];
  const latest = state.latestEvent.get()?.seq ?? 0;
  if (typeof cursor === 'string' && /^\d{1,15}$/.test(cursor)) {
    const since = Number(cursor);
    const replay = state.after.all(since);
    if (since > latest || replay.length === 500 || (replay[0] && replay[0].seq !== since + 1)) {
      send({ kind: 'reset', seq: latest });
    } else {
      for (const event of replay) send(event);
    }
  }
  // The browser loads a snapshot on ready, including when there is nothing to replay.
  send({ kind: 'ready', seq: latest });
  state.on('event', send);
  const heartbeat = setInterval(() => res.write(': alive\n\n'), 15000);
  res.on('close', () => {
    clearInterval(heartbeat);
    state.off('event', send);
    watch.panels -= 1;
  });
}

function matches(route, regex) {
  return regex.exec(route)?.slice(1).map(decodeURIComponent);
}

function messageText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 12000) {
    throw new ApiError(400, 'Enter a message between 1 and 12,000 characters.');
  }
  return value.trim();
}

/** Absolute path of a command-line tool on PATH or in ~/.local/bin, or null; "off" turns it off. */
function findTool(env, value, name) {
  if (value === 'off') return null;
  const candidates = value ? [value] : [...String(env.PATH ?? '').split(':').filter(Boolean),
    ...(env.HOME ? [join(env.HOME, '.local/bin')] : [])].map((directory) => join(directory, name));
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK);
      return resolve(path);
    } catch {}
  }
  return null;
}

/**
 * Command-line adapter first, the older adapter (desktop helper or bridge) while the
 * command line is failing. Sessions of the older adapter keep going to it.
 */
export class Fallback {
  constructor(primary, secondary) {
    this.agent = primary.agent;
    this.primary = primary;
    this.secondary = secondary;
    if (typeof primary.create === 'function') this.create = (text) => {
      if (!primary.healthy) throw new ApiError(503, 'The command line for this agent is not answering.');
      return primary.create(text);
    };
  }

  async discover() {
    await this.primary.discover();
    // Also while the command line can read but not send (Grok without its app session).
    if (!this.primary.healthy || this.primary.canSend === false) await this.secondary?.discover?.();
  }

  owner(id) {
    const secondary = this.secondary;
    return secondary && (secondary.id === id || secondary.leases?.has(id)) ? secondary : this.primary;
  }

  history(id, options) { return this.owner(id).history(id, options); }
  send(id, text, nonce) { return this.owner(id).send(id, text, nonce); }
}

/** Every agent Relay knows, in the order the wizard lists them. `supported`: this version can run it. */
const agentRules = [
  { key: 'codex', name: 'Codex', supported: true, find: (env) => findTool(env, env.CODEX_BIN?.includes('/') ? env.CODEX_BIN : '', 'codex') },
  { key: 'claude', name: 'Claude Code', supported: true,
    find: (env) => findTool(env, env.PANEL_CLAUDE_BIN, 'claude') ?? directory(env.CLAUDE_CONFIG_DIR || (env.HOME && join(env.HOME, '.claude'))) },
  { key: 'muse', name: 'Muse', supported: true, find: (env) => findTool(env, env.PANEL_MUSE_CLI, 'muse-cli') },
  { key: 'grok', name: 'Grok Bot', supported: true, find: (env) => findTool(env, env.PANEL_GBOT_BIN, 'gbot') },
  { key: 'dsh', name: 'DeepSeek', supported: true, find: (env) => findTool(env, '', 'dsh') },
  { key: 'hermes', name: 'Hermes Agent', supported: true, find: (env) => findTool(env, '', 'hermes') },
  { key: 'antigravity', name: 'Antigravity', supported: false, find: (env) => findTool(env, '', 'agy') },
];
const supportedAgents = agentRules.filter((rule) => rule.supported).map((rule) => rule.key);

function directory(path) {
  try { return path && statSync(path).isDirectory() ? resolve(path) : null; } catch { return null; }
}

/** What is installed on this Mac: one row per agent with the path found (null when none). */
export function detectAgents(env) {
  return agentRules.map(({ key, name, supported, find }) => ({ key, name, supported, path: find(env) }));
}

/** PANEL_AGENTS, written by `relay setup`: the agents that run, in the capsule's order. Unset runs none. */
export function parseAgents(value) {
  const keys = String(value ?? '').split(',').map((key) => key.trim());
  return [...new Set(keys.filter((key) => supportedAgents.includes(key)))];
}

/** `.env` text with only its PANEL_AGENTS line set to `list`; every other line stays as it was. */
export function withAgents(text, list) {
  const line = 'PANEL_AGENTS=' + list.join(',');
  const lines = String(text ?? '').split('\n');
  const at = lines.findIndex((row) => /^PANEL_AGENTS=/.test(row));
  if (at >= 0) { lines[at] = line; return lines.join('\n'); }
  const body = lines.join('\n');
  return body + (body && !body.endsWith('\n') ? '\n' : '') + line + '\n';
}

export function configFromEnv(env) {
  const publicOrigin = env.PANEL_PUBLIC_ORIGIN ? new URL(env.PANEL_PUBLIC_ORIGIN).origin : null;
  const config = {
    host: '127.0.0.1', port: Number(env.PANEL_PORT ?? 4488),
    panelToken: env.PANEL_TOKEN, novaToken: env.PANEL_NOVA_TOKEN,
    publicOrigin, data: resolve(env.PANEL_DATA_DIR ?? 'data'), spareApp: env.PANEL_SPARE_APP_ID || null,
    agents: parseAgents(env.PANEL_AGENTS),
    macChat: env.PANEL_MAC_CHAT_DIR || env.PANEL_MAC_CHAT_BIN ? {
      directory: env.PANEL_MAC_CHAT_DIR && resolve(env.PANEL_MAC_CHAT_DIR), binary: env.PANEL_MAC_CHAT_BIN,
    } : null,
    claudeRoot: env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'),
    claudeConfigDir: env.CLAUDE_CONFIG_DIR || null,
    // Command-line tools, found on PATH or in ~/.local/bin; set a variable to "off" to skip one.
    tools: {
      muse: findTool(env, env.PANEL_MUSE_CLI, 'muse-cli'),
      grok: findTool(env, env.PANEL_GBOT_BIN, 'gbot'),
      claude: findTool(env, env.PANEL_CLAUDE_BIN, 'claude'),
    },
    codex: { command: env.CODEX_BIN || 'codex', mode: env.PANEL_CODEX_MODE ?? 'proxy', socket: env.CODEX_APP_SERVER_SOCKET },
    bridgeTokens: Object.fromEntries(['claude', 'muse', 'grok'].map((agent) => [
      agent, env['PANEL_' + agent.toUpperCase() + '_BRIDGE_TOKEN'],
    ])),
    // Claude Code's hooks in ~/.claude/settings.json send this; it can only report sessions and ask for approvals.
    claudeHookToken: env.PANEL_CLAUDE_HOOK_TOKEN || null,
    // The Relay plugin inside DeepSeek Harness (dsh/relay.mjs) sends this; it can only report sessions and ask for approvals.
    dshToken: env.PANEL_DSH_TOKEN || null,
    // Hermes Agent: its database is read from here; `hermes acp` speaks for it.
    hermes: {
      home: env.HERMES_HOME || (env.HOME ? join(env.HOME, '.hermes') : join(homedir(), '.hermes')),
      command: findTool(env, env.PANEL_HERMES_BIN, 'hermes') ?? 'hermes',
    },
    // 总管, Relay's own super agent. Its OpenCode key is read at start (keychain, then PANEL_OPENCODE_KEY), never kept here.
    zongguan: {
      enabled: env.PANEL_ZONGGUAN !== 'off',
      model: env.PANEL_ZONGGUAN_MODEL || 'deepseek-v4.1-flash',
      // The second-highest of deepseek-v4.1-flash's low / high / max.
      effort: env.PANEL_ZONGGUAN_EFFORT || 'high',
      compactAt: env.PANEL_ZONGGUAN_COMPACT_AT === undefined ? 300000 : Number(env.PANEL_ZONGGUAN_COMPACT_AT),
    },
  };
  if (!Number.isInteger(config.zongguan.compactAt) || config.zongguan.compactAt < 10000) {
    throw new Error('Invalid PANEL_ZONGGUAN_COMPACT_AT: a whole number of tokens, at least 10000.');
  }
  const tokens = [config.panelToken, config.novaToken, ...Object.values(config.bridgeTokens), config.claudeHookToken, config.dshToken]
    .filter(Boolean);
  if (!config.panelToken || tokens.some((token) => !/^[A-Za-z0-9_-]{24,128}$/.test(token))
    || new Set(tokens).size !== tokens.length) throw new Error('Set distinct random panel and integration tokens (24+ base64url characters).');
  if (!['off', 'proxy', 'stdio'].includes(config.codex.mode)) throw new Error('Invalid PANEL_CODEX_MODE.');
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid PANEL_PORT.');
  return config;
}

/** `deps` is for tests: an injected model, or a key reader that never touches the keychain. */
export async function start(config, deps = {}) {
  await mkdir(config.data, { recursive: true, mode: 0o700 });
  await chmod(config.data, 0o700);
  const state = new State(join(config.data, 'events.sqlite'));
  // Only the agents the user turned on run; the rest get no adapter, no polling and no hooks.
  // Callers that build a config by hand (tests) get the original five.
  const enabledList = config.agents ?? ['codex', 'claude', 'muse', 'grok', 'dsh'];
  const enabled = new Set(enabledList);
  const codex = new Codex(state, config.codex);
  const bridges = new Map((config.macChat ? ['claude'] : ['claude', 'muse', 'grok']).filter((agent) => enabled.has(agent))
    .map((agent) => [agent, new Bridge(state, agent)]));
  const mac = config.macChat ? ['muse', 'grok'].filter((agent) => enabled.has(agent)).map((agent) => new MacChat(state, agent, config.macChat)) : [];
  const claudeCli = config.tools.claude && enabled.has('claude')
    ? new ClaudeCli(state, { binary: config.tools.claude, configDir: config.claudeConfigDir, bridge: bridges.get('claude') }) : null;
  const claude = new ClaudeObserver(state, config.claudeRoot, bridges.get('claude'), claudeCli);
  if (claudeCli) claudeCli.observer = claude;
  const dsh = new DshWeb(state);
  if (enabled.has('dsh')) state.adapters.set('dsh', dsh);
  const hermes = enabled.has('hermes') ? new HermesAcp(state, { home: config.hermes?.home, command: config.hermes?.command }) : null;
  if (hermes) state.adapters.set('hermes', hermes);
  if (enabled.has('codex')) state.adapters.set('codex', codex);
  for (const [agent, bridge] of bridges) state.adapters.set(agent, bridge);
  for (const desktop of mac) state.adapters.set(desktop.agent, desktop);
  if (claudeCli) state.adapters.set('claude', claudeCli);
  // Someone is looking when the web panel is open or the glasses asked for a page lately. The phone's
  // event stream does not count: it can stay open for notifications while the glasses app is closed.
  const watch = { panels: 0, glassesAt: 0, active: () => watch.panels > 0 || Date.now() - watch.glassesAt < 180000 };
  // Muse and Grok: the command line when it is installed, the older adapter as fallback.
  // Every call of theirs goes over the network, so they poll slowly while nobody is looking.
  const clis = [];
  for (const [agent, Adapter] of [['muse', MuseCli], ['grok', GbotCli]]) {
    if (!config.tools[agent] || !enabled.has(agent)) continue;
    const options = { binary: config.tools[agent], idle: () => !watch.active() };
    const adapter = new Fallback(new Adapter(state, options), state.adapters.get(agent));
    state.adapters.set(agent, adapter);
    clis.push(adapter);
  }
  const outbound = new Map();
  const busy = new Set();
  const server = createServer(handle);
  const history = (agent, id, options) => (agent === 'claude' ? claude : state.adapters.get(agent)).history(id, options);
  const canCreate = (agent) => typeof state.adapters.get(agent)?.create === 'function'
    && ['connected', 'observing'].includes(state.online.get(agent));
  let glasses;
  // Claude Code shows what Relay sends as a message from another session; a receipt lets it check with the gateway
  // that the wearer said it (bin/relay-receipt.mjs). Other agents take Relay's messages as the user's own.
  const stamp = (agent, id, text, { origin = 'voice', said = text } = {}) => (agent !== 'claude' ? text
    : text + '\n\n〔Relay 回执 ' + state.addReceipt({ agent, session: id, origin, said, text }) + '〕');
  const zongguanStore = new ZongguanStore(state.db, join(config.data, 'zongguan.md'));
  let model = deps.model ?? null;
  if (!model && config.zongguan.enabled) {
    const key = await (deps.readKey ?? readKey)({ env: deps.env ?? process.env });
    if (key) {
      model = openCode({
        key, model: config.zongguan.model, effort: config.zongguan.effort, session: zongguanStore.session(),
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
    }
  }
  // A session Relay starts is Relay's from its first turn, so 总管 hears how that turn ends.
  const createSession = async (agent, text, options) => {
    const created = await state.adapters.get(agent).create(text, options);
    if (created?.id) state.event('session.created', agent, created.id);
    return created;
  };
  const zongguanTools = new ZongguanTools({
    state, store: zongguanStore, submit, history, canCreate,
    create: createSession,
    // Codex interrupts name the active turn; the other adapters ignore it.
    control: (agent, id, action) => {
      const adapter = state.adapters.get(agent);
      return adapter.control(id, action, '', adapter.turns?.get?.(id));
    },
    queue: (agent, id, text, meta) => (typeof glasses?.queue === 'function' ? glasses.queue(agent, id, text, meta) : { st: 'fail', h: '还不能排队' }),
    stamp,
    lastReply: (row) => glasses.lastReply(row),
  });
  const zongguan = new Zongguan({ state, store: zongguanStore, tools: zongguanTools, model, compactAt: config.zongguan.compactAt });
  zongguan.on('change', () => state.transient('zongguan', 'zongguan', null, {}));
  zongguan.watch();
  glasses = new SpareGlasses(state, {
    submit, stamp, app: config.spareApp, zongguan, agents: enabledList,
    history,
    // New sessions from the lens: only adapters that can start one, and only while connected.
    canCreate,
    create: createSession,
    // Resuming a Codex thread or reading a Claude transcript puts the model on the session row.
  });
  const desk = new VoiceDesk(state, { submit, glasses, create: glasses.create, canCreate: glasses.canCreate });
  const novaTools = new NovaTools(state, { submit, glasses });

  async function submit(agent, id, text, nonce = randomUUID(), requireIdle = false) {
    const row = state.get(agent, id);
    if (!row.capabilities.includes('send')) throw new ApiError(409, 'This session is available for monitoring only.');
    const key = agent + ':' + id + ':' + nonce;
    const target = agent + ':' + id;
    const prior = outbound.get(key);
    if (prior) {
      if (prior.text !== text) throw new ApiError(409, 'The message identifier was already used.');
      return prior.promise;
    }
    if (busy.has(target) || (requireIdle && ['running', 'input', 'approval'].includes(row.status))) {
      throw new ApiError(409, 'This session is already working.');
    }
    busy.add(target);
    const promise = Promise.resolve().then(() => state.adapters.get(agent).send(id, text, nonce))
      .finally(() => busy.delete(target));
    outbound.set(key, { promise, text, at: Date.now() });
    state.event('message.requested', agent, id);
    return promise;
  }

  async function handle(req, res) {
    res.setHeader('cache-control', 'no-store');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    const path = new URL(req.url, 'http://localhost').pathname;
    const method = req.method;
    try {
      if (path === '/health' && method === 'GET') return json(res, { ok: true });
      const bridgeRoute = matches(path, /^\/bridge\/(claude|muse|grok)\/sync$/);
      if (bridgeRoute && method === 'POST') {
        const [agent] = bridgeRoute;
        const bridge = bridges.get(agent);
        if (!bridge || !equal(bearer(req), config.bridgeTokens[agent])) throw new ApiError(401, 'Bridge authentication required.');
        return json(res, bridge.sync(await body(req)));
      }
      if (path === '/hooks/claude' && method === 'POST') {
        if (!enabled.has('claude')) throw new ApiError(404, 'Claude Code is not enabled in relay setup.');
        if (!config.claudeHookToken || !equal(bearer(req), config.claudeHookToken)) throw new ApiError(401, 'Hook authentication required.');
        // A permission request holds the connection until it is answered; Claude Code closes it when its window answers first.
        const closed = new Promise((resolve) => res.on('close', resolve));
        return json(res, await claude.hook(await body(req, 4 * 1024 * 1024), closed));
      }
      if (path === '/hooks/dsh' && method === 'POST') {
        if (!enabled.has('dsh')) throw new ApiError(404, 'DeepSeek is not enabled in relay setup.');
        if (!config.dshToken || !equal(bearer(req), config.dshToken)) throw new ApiError(401, 'Hook authentication required.');
        // An approval or a question holds the connection until it is answered; the plugin closes it when dsh's window answers first.
        const closed = new Promise((resolve) => res.on('close', resolve));
        return json(res, await dsh.hook(await body(req, 1024 * 1024), closed));
      }
      // Nova's MCP tools. The token goes in the Authorization header, or in the path for clients that only take a URL.
      const mcp = /^\/mcp(?:\/([A-Za-z0-9_-]{24,128}))?$/.exec(path);
      if (mcp) {
        if (!equal(bearer(req) ?? mcp[1], config.novaToken)) {
          res.setHeader('www-authenticate', 'Bearer');
          throw new ApiError(401, 'Nova authentication required.');
        }
        if (method !== 'POST') {
          res.setHeader('allow', 'POST');
          throw new ApiError(405, 'This MCP endpoint takes POST only.');
        }
        const message = await body(req);
        const reply = await novaTools.rpc(message);
        if (!reply) {
          res.writeHead(202);
          return res.end();
        }
        return json(res, reply);
      }
      if (path.startsWith('/v1/')) {
        if (!equal(bearer(req), config.novaToken)) throw new ApiError(401, 'Nova authentication required.');
        glasses.remember(req);
        if (path === '/v1/spare/agent' && method === 'GET') return json(res, glasses.handshake());
        if (path === '/v1/spare/events' && method === 'GET') return glasses.events(req, res);
        const glassesRoute = matches(path, /^\/v1\/spare\/app\/([a-z]+)$/);
        if (glassesRoute) {
          watch.glassesAt = Date.now();
          const input = method === 'POST' ? await body(req) : {};
          const query = new URL(req.url, 'http://localhost').searchParams;
          return json(res, await glasses.app(glassesRoute[0], method, query, input));
        }
        if (path === '/v1/models' && method === 'GET') {
          return json(res, { object: 'list', data: [{ id: 'agent-panel', object: 'model', owned_by: 'local' }] });
        }
        if (path === '/v1/chat/completions' && method === 'POST') {
          return await desk.handle(req, res, await body(req), { sse, json });
        }
        throw new ApiError(404, 'Unknown voice endpoint.');
      }
      sameOrigin(req, config.publicOrigin);
      if (path === '/api/login' && method === 'POST') {
        const input = await body(req);
        if (!equal(input.token, config.panelToken)) throw new ApiError(401, 'Access key did not match.');
        const session = randomBytes(32).toString('base64url');
        state.issueLogin(sessionDigest(config.panelToken, session), Date.now() + 12 * 3600000);
        const secure = config.publicOrigin?.startsWith('https:') ? '; Secure' : '';
        res.setHeader('set-cookie', cookieName + '=' + session + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200' + secure);
        return json(res, { ok: true });
      }
      if (!authorized(req, config, state)) throw new ApiError(401, 'Panel authentication required.');
      if (path === '/api/fleet' && method === 'GET') return json(res, state.snapshot());
      if (path === '/api/events' && method === 'GET') return subscribe(req, res, state, watch);
      if (path === '/api/voice-target' && method === 'PUT') {
        const { agent, id } = await body(req);
        if (!state.get(agent, id).capabilities.includes('send')) throw new ApiError(409, 'Select a writable session.');
        state.set('voiceTarget', { agent, id });
        state.event('voice-target', agent, id);
        return json(res, { ok: true });
      }
      if (path === '/api/zongguan' && method === 'GET') return json(res, zongguan.view());
      const receipt = matches(path, /^\/api\/receipts\/([0-9a-z]{6})$/);
      if (receipt && method === 'GET') {
        const row = state.receipt(receipt[0]);
        if (!row) throw new ApiError(404, 'No such receipt.');
        return json(res, row);
      }
      if (path === '/api/zongguan/say' && method === 'POST') {
        const input = await body(req);
        return json(res, await zongguan.hear(messageText(input.text), 'panel'), 202);
      }
      if (path === '/api/zongguan/confirm' && method === 'POST') {
        const input = await body(req);
        if (typeof input.confirmId !== 'string' || typeof input.yes !== 'boolean') throw new ApiError(400, 'Expected confirmId and yes.');
        return json(res, await zongguan.confirm(input.confirmId, input.yes));
      }
      if (path === '/api/voice' && method === 'GET') {
        return json(res, { words: desk.words(), defaults: defaultWords, names: wordNames, shortcuts: desk.shortcuts() });
      }
      if (path === '/api/voice' && method === 'PUT') {
        const input = await body(req);
        if (input.words !== undefined) state.set('voiceWords', voiceWords(input.words));
        if (input.shortcuts !== undefined) state.set('voiceShortcuts', voiceShortcuts(input.shortcuts, state));
        return json(res, { words: desk.words(), shortcuts: desk.shortcuts() });
      }
      const session = matches(path, /^\/api\/sessions\/(codex|claude|muse|grok|dsh|hermes)\/([^/]+)\/(history|send|steer|interrupt)$/);
      if (session) {
        const [agent, id, action] = session;
        const row = state.get(agent, id);
        if (!row.capabilities.includes(action)) throw new ApiError(409, 'This session does not support ' + action + '.');
        if (method === 'GET' && action === 'history') {
          const history = await (agent === 'claude' ? claude : state.adapters.get(agent)).history(id);
          return json(res, { history });
        }
        if (method === 'POST' && action !== 'history') {
          const input = await body(req);
          if (action === 'send') {
            if (typeof input.nonce !== 'string' || !idPattern.test(input.nonce)) throw new ApiError(400, 'Invalid message identifier.');
            return json(res, await submit(agent, id, messageText(input.text), input.nonce), 202);
          }
          const text = action === 'steer' ? messageText(input.text) : '';
          return json(res, await state.adapters.get(agent).control(id, action, text, input.turnId), 202);
        }
      }
      const attention = matches(path, /^\/api\/attention\/([^/]+)$/);
      if (attention && method === 'POST') {
        await state.decide(attention[0], await body(req));
        return json(res, { ok: true });
      }
      throw new ApiError(404, 'Unknown panel endpoint.');
    } catch (error) {
      if (res.headersSent) return res.end();
      if (!(error instanceof ApiError)) console.error('Panel request failed:', error.name);
      json(res, { error: { message: error instanceof ApiError ? error.message : 'The gateway could not finish this request.' } },
        error instanceof ApiError ? error.status : 500);
    }
  }

  let refreshing;
  function refresh() {
    if (refreshing) return;
    refreshing = (async () => {
      for (const bridge of bridges.values()) bridge.expire();
      const fallbacks = new Set(clis.map((adapter) => adapter.secondary));
      await Promise.allSettled([enabled.has('claude') && claude.discover(), enabled.has('dsh') && dsh.discover(), hermes?.discover(),
        enabled.has('codex') && (codex.ready ? codex.discover() : codex.connect()),
        ...mac.filter((desktop) => !fallbacks.has(desktop)).map((desktop) => desktop.discover()),
        ...clis.map((adapter) => adapter.discover())]);
      const now = Date.now();
      for (const [nonce, entry] of outbound) if (entry.at < now - 3600000) outbound.delete(nonce);
      state.expireLogins.run(now);
    })().finally(() => { refreshing = null; });
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  void refresh();
  const interval = setInterval(refresh, 4500);
  // A Claude Code session that starts, stops or writes is seen within a second, not at the next poll.
  if (enabled.has('claude')) claude.watch();
  let closing;
  return { server, state, glasses, zongguan, close: () => {
    if (closing) return closing;
    clearInterval(interval);
    zongguan.close();
    glasses.close();
    claude.close();
    claudeCli?.close();
    hermes?.close();
    const native = codex.close();
    const stopped = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    closing = Promise.allSettled([stopped, refreshing, native]).then(() => state.db.close());
    return closing;
  } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const env = { ...process.env };
  if (!env.PANEL_MAC_CHAT_DIR && !env.PANEL_MAC_CHAT_BIN) {
    const marker = join(resolve(env.PANEL_DATA_DIR ?? 'data'), 'active-mailbox');
    const mailbox = (await readFile(marker, 'utf8').catch(() => '')).trim();
    if (/^\/private\/tmp\/relay-mailbox\.[a-z0-9]+$/i.test(mailbox)) env.PANEL_MAC_CHAT_DIR = mailbox;
  }
  const config = configFromEnv(env);
  const app = await start(config);
  console.log('Local Agent Remote Panel is listening on http://127.0.0.1:' + app.server.address().port);
  process.on('SIGTERM', () => app.close());
  process.on('SIGINT', () => app.close());
}
