import { access, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const id = process.argv[2];
if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id ?? '')) {
  throw new Error('Pass the existing Claude Code session UUID.');
}
const local = (name) => fileURLToPath(new URL(name, import.meta.url));
await access(local('./.env'));
await mkdir(local('./data'), { recursive: true, mode: 0o700 });
const config = { mcpServers: { 'relay-panel': {
  command: process.execPath,
  args: ['--env-file=' + local('./.env'), local('./claude-channel.mjs')],
  env: { PANEL_CLAUDE_SESSION: id },
} } };
const dest = local('./data/claude-' + id + '.json');
await writeFile(dest, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
console.log(dest);
