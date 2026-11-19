// Relay for DeepSeek Harness (dsh): a plugin for the web profile that puts its sessions on the Relay gateway.
//
// It reports each turn, tool call and message to the gateway, raises approvals and questions there while the
// same prompt shows in the dsh window (whichever answers first applies), and serves the gateway a small local
// API to list sessions, read their history, send a message into one and start a new one. Install it by adding to
// ~/.dsh/profiles/web/cordis.patch.yml:
//
//   - insert:
//       - id: relay
//         name: /absolute/path/to/dsh/relay.mjs
//         config:
//           gateway: http://127.0.0.1:4488
//           token: <PANEL_DSH_TOKEN from the gateway's .env>
//
// Only Node built-ins are used, so the file loads from anywhere.

import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export const name = 'relay';

const helloEvery = 20000;
const textLimit = 12000;
const argsLimit = 4000;
const historyMessages = 60;
const reported = new Set(['turn/start', 'turn/end', 'tool/call', 'tool/result', 'user/message', 'assistant/message', 'session/title']);

const sessionIdOf = (session) => String(session?.header?.id ?? session?.meta?.id ?? session?.id ?? '');
const cut = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');

/** The visible text of a message: its text blocks, without reasoning or tool blocks. */
function textOf(content) {
  if (typeof content === 'string') return cut(content, textLimit);
  if (!Array.isArray(content)) return '';
  return cut(content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text).join('\n'), textLimit);
}

/** One session event in the few fields the gateway uses; null for events it does not show. */
export function compact(event) {
  const data = event?.data ?? {};
  switch (event?.type) {
    case 'turn/start': return { type: 'turn/start', turn: data.turn };
    case 'turn/end': return { type: 'turn/end', turn: data.turn, reason: String(data.reason?.kind ?? data.reason ?? '') };
    case 'tool/call': return { type: 'tool/call', callId: String(data.callId ?? ''), name: String(data.name ?? ''), args: cut(data.arguments, argsLimit) };
    case 'tool/result': return { type: 'tool/result', callId: String(data.message?.toolCallId ?? ''), error: Boolean(data.error || data.message?.isError) };
    // dsh also logs what it injects (runtime context, skill catalog, time) as user messages; only the person's count.
    case 'user/message': return data.source?.kind && data.source.kind !== 'user' ? null
      : { type: 'user/message', id: String(data.id ?? ''), text: textOf(data.content ?? data.message?.content) };
    case 'assistant/message': return { type: 'assistant/message', id: String(data.message?.id ?? ''), text: textOf(data.message?.content) };
    case 'session/title': return { type: 'session/title', title: cut(String(data.title ?? data.text ?? ''), 200) };
    default: return null;
  }
}

function sameSecret(given, secret) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (error) { reject(error); }
    });
    req.on('error', reject);
  });
}

function abortError() {
  const error = new Error('request was canceled before an answer was accepted');
  error.name = 'AbortError';
  return error;
}

export function apply(ctx, config = {}) {
  const gateway = String(config.gateway ?? 'http://127.0.0.1:4488').replace(/\/+$/, '');
  const token = String(config.token ?? '');
  const log = (...args) => ctx.logger?.('relay')?.info?.(...args);
  if (!/^[A-Za-z0-9_-]{24,128}$/.test(token)) {
    ctx.logger?.('relay')?.warn?.('relay: set config.token to PANEL_DSH_TOKEN; the plugin stays off');
    return;
  }
  const secret = randomBytes(24).toString('base64url');
  const clones = new WeakSet();
  let controller = null;
  let server = null;
  let url = '';
  let greeted = 0; // when the gateway last accepted a hello
  let queue = Promise.resolve();
  let active = true;

  const post = (payload, signal) => fetch(gateway + '/hooks/dsh', {
    method: 'POST', signal,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(async (res) => {
    if (!res.ok) throw new Error('gateway answered ' + res.status);
    return res.json();
  });
  // Events go one at a time so the gateway sees them in order; a gateway that is down only drops them.
  const report = (payload) => {
    queue = queue.then(() => post(payload, AbortSignal.timeout(5000))).catch(() => {});
  };
  const hello = () => {
    if (!active || !url) return;
    post({ kind: 'hello', url, secret, pid: process.pid }, AbortSignal.timeout(5000))
      .then(() => { greeted = Date.now(); }, () => { greeted = 0; });
  };
  const reachable = () => Date.now() - greeted < helloEvery * 2;

  ctx.inject(['sessionController'], (child) => {
    controller = child.sessionController;
    child.effect(() => () => { if (controller === child.sessionController) controller = null; });
  });

  ctx.on('session/event', (session, event) => {
    if (!reported.has(event?.type)) return;
    const id = sessionIdOf(session);
    const item = compact(event);
    if (!id || !item) return;
    report({ kind: 'event', session: id, cwd: cut(session?.header?.cwd ?? '', 500), seq: event.seq, at: event.time, ...item });
  });

  /**
   * Answer from the gateway or from dsh's own window, whichever comes first. The request is dispatched
   * again down the rest of the chain with its own abort signal, so a gateway answer withdraws the prompt
   * in the window; an answer in the window aborts the gateway's held request, which removes its card.
   */
  async function relay(carrier, type, request, next, payload, unanswered) {
    if (clones.has(request) || !reachable()) return next();
    const id = sessionIdOf(request?.agent?.session);
    if (!id) return next();
    if (request?.signal?.aborted) throw abortError();
    const native = new AbortController();
    const remote = new AbortController();
    const forwarded = { ...request, signal: native.signal };
    clones.add(forwarded);
    const missing = Symbol('no answerer');
    const local = Promise.resolve()
      .then(() => (carrier == null ? ctx.waterfall(type, forwarded, () => missing) : ctx.waterfall(carrier, type, forwarded, () => missing)))
      .then((value) => (value === missing ? { kind: 'missing' } : { kind: 'local', value }), (error) => ({ kind: 'error', error }));
    const asked = post({ kind: 'ask', session: id, ...payload }, remote.signal)
      .then((reply) => (reply?.answer !== undefined ? { kind: 'remote', value: reply.answer } : { kind: 'unanswered' }), () => ({ kind: 'unanswered' }));
    let unhook = () => {};
    const canceled = new Promise((resolve) => {
      if (!request?.signal) return;
      const onAbort = () => resolve({ kind: 'canceled' });
      request.signal.addEventListener('abort', onAbort, { once: true });
      unhook = () => request.signal.removeEventListener('abort', onAbort);
    });
    try {
      // A gateway that gives no answer leaves the window to answer; no answerer at all ends as `unanswered`.
      const localOrMissing = local.then((result) => (result.kind === 'missing'
        ? asked.then((reply) => (reply.kind === 'remote' ? reply : { kind: 'nobody' })) : result));
      const remoteOnly = asked.then((reply) => (reply.kind === 'remote' ? reply : new Promise(() => {})));
      const winner = await Promise.race([localOrMissing, remoteOnly, canceled]);
      if (winner.kind === 'remote') { native.abort(); return winner.value; }
      remote.abort();
      if (winner.kind === 'canceled') { native.abort(); throw abortError(); }
      if (winner.kind === 'nobody') return unanswered();
      if (winner.kind === 'error') throw winner.error;
      return winner.value;
    } finally {
      unhook();
    }
  }

  ctx.on('approval/request', function (request, next) {
    return relay(this, 'approval/request', request, next,
      { type: 'approval', toolName: String(request?.toolName ?? ''), callId: String(request?.callId ?? ''), reason: cut(request?.reason ?? '', 2000) },
      () => 'unavailable');
  }, { prepend: true });

  ctx.on('user-questions/request', function (request, next) {
    const questions = Array.isArray(request?.questions) ? request.questions : [];
    return relay(this, 'user-questions/request', request, next, { type: 'question', questions }, () => {
      const error = new Error('no user-questions answerer accepted the request');
      error.name = 'UserQuestionError';
      error.code = 'NO_PROVIDER';
      throw error;
    });
  }, { prepend: true });

  async function route(req, res) {
    const reply = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (!auth || !sameSecret(auth[1], secret)) return reply(401, { error: 'unauthorized' });
    if (!controller) return reply(503, { error: 'dsh is still starting' });
    const path = new URL(req.url, 'http://localhost');
    const signal = AbortSignal.timeout(15000);
    try {
      if (req.method === 'GET' && path.pathname === '/sessions') {
        const { items } = await controller.list({}, signal);
        return reply(200, { sessions: items.map((item) => ({
          id: item.sessionId, updatedAt: item.updatedAt, running: item.running, blank: item.blank,
          available: item.agentAvailable, cwd: item.cwd ?? '', parent: item.parentSessionId ?? null,
          values: item.projections?.values ?? {},
        })) });
      }
      if (req.method === 'GET' && path.pathname === '/history') {
        const sessionId = path.searchParams.get('id') ?? '';
        const page = await controller.page({ address: { kind: 'session', sessionId }, maxMessages: historyMessages }, signal);
        const events = (page.records ?? []).map((record) => record?.event ?? record)
          .map((event) => { const item = compact(event); return item && { ...item, seq: event.seq, at: event.time }; })
          .filter(Boolean);
        return reply(200, { events });
      }
      if (req.method === 'POST' && path.pathname === '/prompt') {
        const input = await readBody(req);
        const text = cut(input.text, textLimit);
        if (!text.trim()) return reply(400, { error: 'empty message' });
        await controller.prompt({ requestId: String(input.requestId), sessionId: String(input.id), mode: 'queue',
          content: [{ type: 'text', text }] }, signal);
        return reply(202, { accepted: true });
      }
      if (req.method === 'POST' && path.pathname === '/create') {
        const input = await readBody(req);
        const text = cut(input.text, textLimit);
        if (!text.trim()) return reply(400, { error: 'empty message' });
        const cwd = typeof input.cwd === 'string' && input.cwd.startsWith('/') ? { cwd: input.cwd } : {};
        const { sessionId } = await controller.create(cwd);
        await controller.prompt({ requestId: String(input.requestId), sessionId, mode: 'queue',
          content: [{ type: 'text', text }] }, signal);
        return reply(202, { id: sessionId });
      }
      if (req.method === 'POST' && path.pathname === '/cancel') {
        const input = await readBody(req);
        controller.cancel({ sessionId: String(input.id) });
        return reply(202, { accepted: true });
      }
      return reply(404, { error: 'unknown' });
    } catch (error) {
      log('relay request failed', path.pathname, error?.name, error?.code ?? error?.message);
      return reply(502, { error: String(error?.code ?? error?.name ?? 'failed') });
    }
  }

  ctx.effect(() => {
    server = createServer((req, res) => { route(req, res).catch(() => { try { res.destroy(); } catch {} }); });
    server.on('error', () => {});
    server.listen(0, '127.0.0.1', () => {
      url = 'http://127.0.0.1:' + server.address().port;
      hello();
    });
    const timer = setInterval(hello, helloEvery);
    timer.unref?.();
    return () => {
      active = false;
      clearInterval(timer);
      post({ kind: 'bye', pid: process.pid }, AbortSignal.timeout(2000)).catch(() => {});
      try { server?.close(); } catch {}
    };
  }, 'relay gateway link');
}
