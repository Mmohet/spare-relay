import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const path = (name) => fileURLToPath(new URL(name, import.meta.url));
const secret = () => randomBytes(32).toString('base64url');
await mkdir(path('./data'), { recursive: true, mode: 0o700 });
await chmod(path('./data'), 0o700);
const marker = path('./data/active-mailbox');
const previous = (await readFile(marker, 'utf8').catch(() => '')).trim();
const validPath = /^\/private\/tmp\/relay-mailbox\.[a-z0-9]+$/i;
const current = validPath.test(previous) ? await stat(previous).catch(() => null) : null;
if (!current?.isDirectory() || current.uid !== process.getuid() || (current.mode & 0o777) !== 0o700) {
  const mailbox = await mkdtemp('/private/tmp/relay-mailbox.');
  await chmod(mailbox, 0o700);
  await writeFile(marker, mailbox + '\n', { mode: 0o600 });
}
const content = [
  'PANEL_PORT=4488',
  'PANEL_DATA_DIR=./data',
  'PANEL_CODEX_MODE=stdio',
  'PANEL_TOKEN=' + secret(),
  'PANEL_NOVA_TOKEN=' + secret(),
  'PANEL_CLAUDE_BRIDGE_TOKEN=' + secret(),
  '',
].join('\n');
try {
  await writeFile(path('./.env'), content, { mode: 0o600, flag: 'wx' });
  console.log('Created the private local configuration (.env).');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('Using the existing local configuration (.env).');
}
