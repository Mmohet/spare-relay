#!/usr/bin/env node
// relay: status and on/off for the Relay gateway on this Mac.
//   relay            status
//   relay on         start now and at every login
//   relay off        stop and do not start at login
//   relay restart    restart the running gateway
//   relay log [-f]   recent gateway log
//   relay setup      find the agents on this Mac and choose which ones Relay runs (PANEL_AGENTS in .env)
// `relay serve` is what launchd runs: it readies the chat helper, starts the gateway, and runs
// Relay's Cloudflare tunnel (data/cloudflared-relay.yml) beside it while that file exists.
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv, promisify } from 'node:util';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const data = join(root, 'data');
const label = 'local.relay.gateway';
const domain = 'gui/' + process.getuid();
const target = domain + '/' + label;
const installed = join(homedir(), 'Library', 'LaunchAgents', label + '.plist');
const log = join(data, 'gateway.log');
const helperApp = join(data, 'Relay Accessibility.app');
const marker = join(data, 'active-mailbox');
const tunnelConfig = join(data, 'cloudflared-relay.yml');
const tunnelLog = join(data, 'tunnel.log');
const mailboxPattern = /^\/private\/tmp\/relay-mailbox\.[a-z0-9]+$/i;
const run = promisify(execFile);
const launchctl = (...args) => run('/bin/launchctl', args);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function loadEnv() {
  try { process.loadEnvFile(join(root, '.env')); } catch {}
  return { port: Number(process.env.PANEL_PORT || 4488), token: process.env.PANEL_TOKEN };
}

async function job() {
  const out = await launchctl('print', target).then((r) => r.stdout, () => null);
  if (!out) return { loaded: false };
  return { loaded: true, pid: Number(/^\s+pid = (\d+)$/m.exec(out)?.[1]) || null,
    state: /^\s+state = (.+)$/m.exec(out)?.[1], exit: /last exit code = (.+)$/m.exec(out)?.[1] };
}

async function autostart() {
  const file = await stat(installed).then(() => true, () => false);
  const disabled = await launchctl('print-disabled', domain)
    .then((r) => new RegExp('"' + label.replace(/\./g, '\\.') + '" => (true|disabled)').test(r.stdout), () => false);
  return file && !disabled;
}

async function helperProcess() {
  const out = await run('/usr/bin/pgrep', ['-fl', 'RelayAccessibility serve']).then((r) => r.stdout, () => '');
  return out.split('\n').map((line) => /^(\d+) .* serve (\S+)/.exec(line)).filter(Boolean)
    .map((m) => ({ pid: Number(m[1]), mailbox: m[2] }));
}

async function currentMailbox() {
  const value = (await readFile(marker, 'utf8').catch(() => '')).trim();
  if (!mailboxPattern.test(value)) return null;
  return await stat(value).then((info) => (info.isDirectory() ? value : null), () => null);
}

/** The helper's mailbox lives in /private/tmp, which a restart empties: make a new one and point the helper at it. */
async function readyHelper() {
  if (!(await stat(helperApp).then(() => true, () => false))) return null;
  let mailbox = await currentMailbox();
  if (!mailbox) {
    mailbox = await mkdtemp('/private/tmp/relay-mailbox.');
    await writeFile(marker, mailbox + '\n', { mode: 0o600 });
  }
  const running = await helperProcess();
  if (running.some((p) => p.mailbox === mailbox)) return mailbox;
  for (const p of running) { try { process.kill(p.pid); } catch {} }
  await run('/usr/bin/open', ['-a', helperApp, '--args', 'serve', mailbox, '--allow-activation']).catch(() => {});
  return mailbox;
}

async function stopHelper() {
  for (const p of await helperProcess()) { try { process.kill(p.pid); } catch {} }
}

async function tunnelHost() {
  const text = await readFile(tunnelConfig, 'utf8').catch(() => null);
  return text ? /hostname:\s*(\S+)/.exec(text)?.[1] ?? null : null;
}

async function tunnelProcess() {
  // Only cloudflared itself: a looser match also hits any shell whose command line mentions the file.
  const out = await run('/usr/bin/pgrep', ['-f', '^/[^ ]*/cloudflared tunnel --config [^ ]*/data/cloudflared-relay\\.yml run$'])
    .then((r) => r.stdout, () => '');
  return out.trim() ? Number(out.trim().split('\n')[0]) : null;
}

/** What someone outside sees: the gateway, Cloudflare Access turning them away, or nothing. */
async function publicCheck(host) {
  const response = await fetch('https://' + host + '/health', { redirect: 'manual', signal: AbortSignal.timeout(6000) })
    .catch(() => null);
  if (!response) return '公网连不上';
  if (response.status === 200) return '公网能连到网关';
  if ([302, 401, 403].includes(response.status)) return '被 Access 拦下（这台没走 WARP？）';
  return '公网返回 ' + response.status;
}

async function health(port) {
  return fetch('http://127.0.0.1:' + port + '/health', { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok, () => false);
}

async function fleet(port, token) {
  if (!token) return null;
  return fetch('http://127.0.0.1:' + port + '/api/fleet', {
    headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(5000),
  }).then((r) => (r.ok ? r.json() : null), () => null);
}

// Same states as the web panel (public/app.js).
const connectionNames = { connected: '已连接', observing: '已连接', permission: '缺权限', offline: '离线', unconfigured: '未接入' };
const pad = (text, width) => {
  const size = [...String(text)].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0);
  return text + ' '.repeat(Math.max(1, width - size));
};

async function status() {
  const { port, token } = loadEnv();
  const [j, auto, ok, helpers, mailbox] = await Promise.all([job(), autostart(), health(port), helperProcess(), currentMailbox()]);
  const running = j.pid ? `运行中（pid ${j.pid}）` : j.loaded ? `已加载但没在跑（上次退出码 ${j.exit ?? '?'}）` : ok ? '在跑，但不是开机自启起的' : '已停止';
  console.log(pad('Relay', 8) + running + '    开机自启：' + (auto ? '开' : '关'));
  console.log(pad('网关', 8) + `http://127.0.0.1:${port}  ` + (ok ? '正常' : '连不上'));
  const helper = !(await stat(helperApp).then(() => true, () => false)) ? '没装（Grok 只能读）'
    : helpers.some((p) => p.mailbox === mailbox) ? '运行中' : helpers.length ? '在跑但信箱对不上，relay restart 可修' : '没在跑（Grok 只能读）';
  console.log(pad('助手', 8) + helper);
  const host = await tunnelHost();
  if (host) {
    const pid = await tunnelProcess();
    console.log(pad('隧道', 8) + host + '  ' + (pid ? '运行中，' + (await publicCheck(host)) : '没在跑'));
  }
  if (ok) {
    const snapshot = await fleet(port, token);
    if (snapshot) {
      console.log('');
      console.log(pad('Agent', 13) + pad('连接', 10) + pad('会话', 6) + '等你');
      for (const agent of snapshot.agents) {
        const waiting = agent.sessions.filter((s) => ['approval', 'input'].includes(s.status)).length;
        console.log(pad(agent.name ?? agent.id, 13) + pad(connectionNames[agent.connection] ?? agent.connection, 10)
          + pad(String(agent.sessions.length), 6) + (waiting || '-'));
      }
      if (snapshot.attention.length) console.log('\n待处理 ' + snapshot.attention.length + ' 件');
    } else {
      console.log('\n读不到 Agent 列表（检查 .env 里的 PANEL_TOKEN）');
    }
  }
  console.log('\n日志  ' + log);
}

/** Healthy, then a moment for the agents: Muse and Grok answer their first listing seconds after the gateway is up. */
async function waitHealthy(port, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end && !(await health(port))) await sleep(500);
  if (!(await health(port))) return false;
  const { token } = loadEnv();
  while (Date.now() < end) {
    const snapshot = await fleet(port, token);
    if (!snapshot || snapshot.agents.every((agent) => agent.connection !== 'unconfigured')) break;
    await sleep(1000);
  }
  return true;
}

async function on() {
  const { port } = loadEnv();
  const { prepareLaunchAgent } = await import('./launch-agent.mjs');
  // Homebrew's node keeps one path across upgrades; the node this shell happens to run may belong to another tool.
  const brew = '/opt/homebrew/bin/node';
  const node = (await stat(brew).then(() => true, () => false)) ? brew : process.execPath;
  const { plist } = await prepareLaunchAgent(root, { label, node, entry: join(root, 'mac', 'relay.mjs'), args: ['serve'] });
  const before = await job();
  if (!before.loaded && await health(port)) {
    throw new Error(`端口 ${port} 已经有一个网关在跑（多半是前台的 npm start），先关掉它再 relay on。`);
  }
  await mkdir(dirname(installed), { recursive: true });
  await copyFile(plist, installed);
  await launchctl('enable', target);
  if (before.loaded) await launchctl('bootout', target).catch(() => {});
  await launchctl('bootstrap', domain, installed);
  console.log((await waitHealthy(port)) ? '已打开，开机也会自动启动。' : '已交给 launchd，但网关 20 秒内没起来，看 relay log。');
  await status();
}

async function off() {
  const before = await job();
  if (before.loaded) await launchctl('bootout', target).catch(() => {});
  await launchctl('disable', target).catch(() => {});
  await stopHelper();
  console.log('已关闭，开机不会再启动。');
}

async function restart() {
  if (!(await job()).loaded) throw new Error('Relay 没打开，用 relay on。');
  await readyHelper();
  await launchctl('kickstart', '-k', target);
  const { port } = loadEnv();
  console.log((await waitHealthy(port)) ? '已重启。' : '重启了，但网关 20 秒内没起来，看 relay log。');
  await status();
}

async function serve() {
  const mailbox = await readyHelper().catch((error) => {
    console.error('Chat helper not started: ' + error.message);
    return null;
  });
  const { configFromEnv, start } = await import('../server.mjs');
  const env = { ...process.env };
  if (mailbox && !env.PANEL_MAC_CHAT_DIR && !env.PANEL_MAC_CHAT_BIN) env.PANEL_MAC_CHAT_DIR = mailbox;
  const app = await start(configFromEnv(env));
  console.log('Local Agent Remote Panel is listening on http://127.0.0.1:' + app.server.address().port);
  const tunnel = await runTunnel();
  const stop = () => { tunnel?.stop(); app.close(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/** Keep cloudflared running for as long as the gateway runs; it dies with the gateway. */
async function runTunnel() {
  if (!(await stat(tunnelConfig).then(() => true, () => false))) return null;
  const binary = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'].find((path) => existsSync(path));
  if (!binary) { console.error('Tunnel not started: cloudflared is not installed.'); return null; }
  // A gateway killed outright leaves its cloudflared behind; do not run two.
  const leftover = await tunnelProcess();
  if (leftover) { try { process.kill(leftover); } catch {} }
  let child = null;
  let stopping = false;
  const launch = () => {
    const out = openSync(tunnelLog, 'a', 0o600);
    child = spawn(binary, ['tunnel', '--config', tunnelConfig, 'run'], { stdio: ['ignore', out, out] });
    closeSync(out);
    child.on('exit', () => { if (!stopping) setTimeout(launch, 5000); });
  };
  launch();
  return { stop: () => { stopping = true; child?.kill('SIGTERM'); } };
}

/** Lists what is installed, asks which agents Relay runs, writes PANEL_AGENTS and offers a restart. */
async function setup() {
  const { detectAgents, parseAgents, withAgents } = await import('../server.mjs');
  const file = join(root, '.env');
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) throw new Error('还没有 .env：先在项目目录运行 npm run setup。');
  const saved = parseEnv(text);
  const chosen = /^PANEL_AGENTS=/m.test(text) ? parseAgents(saved.PANEL_AGENTS) : null;
  const rows = detectAgents({ ...process.env, ...saved });
  console.log('这台 Mac 上的 Agent：');
  for (const row of rows) {
    const note = !row.supported ? '下一版支持' : chosen?.includes(row.key) ? '已启用' : chosen ? '没启用' : '';
    console.log('  ' + row.name.padEnd(13) + (row.path ? '找到 ' + row.path : '没找到') + (note ? '  · ' + note : ''));
  }
  if (!process.stdin.isTTY) return console.log('不在终端里：只列出检测结果，.env 没有改。');
  const ask = createInterface({ input: process.stdin, output: process.stdout });
  const picked = [];
  try {
    for (const row of rows) {
      if (!row.supported || (!row.path && !chosen?.includes(row.key))) continue;
      // First run: everything found is on by default. Later: keep what was chosen before.
      const fallback = chosen ? chosen.includes(row.key) : true;
      const answer = (await ask.question('启用 ' + row.name + (row.path ? '' : '（没找到命令）') + '？' + (fallback ? '[Y/n] ' : '[y/N] '))).trim();
      if (answer ? /^y/i.test(answer) : fallback) picked.push(row.key);
    }
    await writeFile(file, withAgents(text, picked));
    await chmod(file, 0o600);
    console.log('已写入 .env：PANEL_AGENTS=' + picked.join(','));
    if (!(await job()).loaded) return console.log('网关不是由 relay on 管着的：重启网关后生效。');
    const again = (await ask.question('现在重启网关让它生效？[Y/n] ')).trim();
    if (!again || /^y/i.test(again)) await restart();
    else console.log('下次重启网关（relay restart）后生效。');
  } finally {
    ask.close();
  }
}

const commands = { status, on, off, restart, serve, setup,
  log: async () => {
    if (!(await stat(log).then(() => true, () => false))) return console.log('还没有日志：网关由 relay on 启动后才写 ' + log);
    const child = spawn('/usr/bin/tail', [process.argv.includes('-f') ? '-f' : '-n', ...(process.argv.includes('-f') ? [] : ['40']), log], { stdio: 'inherit' });
    await new Promise((done) => child.on('close', done));
  } };
const name = process.argv[2] ?? 'status';
if (!commands[name]) {
  console.log('用法：relay [status|on|off|restart|setup|log [-f]]');
  process.exit(1);
}
if (name === 'serve') process.chdir(root);
try {
  await commands[name]();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
