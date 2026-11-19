import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { prepareLaunchAgent } from '../mac/launch-agent.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const launch = (...args) => run('/bin/launchctl', args);
const domain = 'gui/' + process.getuid();
const root = await mkdtemp('/private/tmp/relay-launchd-test.');
const token = randomBytes(32).toString('base64url');
const label = 'local.relay.test.' + process.pid;
const target = domain + '/' + label;
let bootstrapped = false;

async function running(log, previous) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const job = await launch('print', target).catch(() => null);
    const pid = Number(/^\s+pid = (\d+)$/m.exec(job?.stdout ?? '')?.[1]);
    const output = await readFile(log, 'utf8').catch(() => '');
    const ports = [...output.matchAll(/listening on http:\/\/127\.0\.0\.1:(\d+)/g)];
    const port = Number(ports.at(-1)?.[1]);
    if (pid && pid !== previous && port && ports.length >= (previous ? 2 : 1)) {
      const base = 'http://127.0.0.1:' + port;
      const healthy = await fetch(base + '/health', { signal: AbortSignal.timeout(500) })
        .then((response) => response.ok).catch(() => false);
      if (healthy) return { pid, base };
    }
    await delay(250);
  }
  throw new Error('launchd did not start a healthy gateway before timeout.');
}

try {
  await Promise.all(['server.mjs', 'lib'].map((name) =>
    cp(join(source, name), join(root, name), { recursive: true })));
  await writeFile(join(root, '.env'), [
    'PANEL_PORT=0', 'PANEL_TOKEN=' + token, 'PANEL_CODEX_MODE=off',
    'CLAUDE_CONFIG_DIR=' + root, '',
  ].join('\n'), { mode: 0o600 });
  const { plist, log } = await prepareLaunchAgent(root, { label });
  await run('/usr/bin/plutil', ['-lint', plist]);
  await launch('bootstrap', domain, plist);
  bootstrapped = true;
  const original = await running(log);
  const login = await fetch(original.base + '/api/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  await launch('kill', 'SIGKILL', target);
  const restored = await running(log, original.pid);
  assert.notEqual(restored.pid, original.pid);
  const fleet = await fetch(restored.base + '/api/fleet', { headers: { cookie } });
  assert.equal(fleet.status, 200);
  assert.equal((await fleet.json()).agents.length, 4);
  console.log('launchd restarted the killed loopback gateway and restored the browser login.');
} finally {
  if (bootstrapped) await launch('bootout', target);
  await rm(root, { recursive: true, force: true });
}
