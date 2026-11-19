import { access, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const labelDefault = 'local.relay.gateway';
const xml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]);
const string = (value) => '<string>' + xml(value) + '</string>';

export async function prepareLaunchAgent(root, options = {}) {
  const label = options.label ?? labelDefault;
  if (!/^local\.relay\.[a-zA-Z0-9.-]+$/.test(label)) throw new Error('Invalid Relay launchd label.');
  const directory = resolve(root);
  const data = join(directory, 'data');
  const env = join(directory, '.env');
  // `relay on` points this at mac/relay.mjs, which readies the chat helper before the gateway.
  const server = resolve(options.entry ?? join(directory, 'server.mjs'));
  await Promise.all([access(env), access(server)]);
  await mkdir(data, { recursive: true, mode: 0o700 });
  const plist = join(data, label + '.plist');
  const log = join(data, 'gateway.log');
  const executable = resolve(options.node ?? process.execPath);
  const searchPath = (process.env.PATH ?? '').split(':').filter((part) => part.startsWith('/')).join(':');
  const path = searchPath || '/usr/bin:/bin:/usr/sbin:/sbin';
  const args = [executable, '--env-file=' + env, server, ...(options.args ?? [])].map(string).join('\n    ');
  await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(label)}
  <key>ProgramArguments</key>
  <array>
    ${args}
  </array>
  <key>WorkingDirectory</key>${string(directory)}
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key>${string(path)}</dict>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key>${string(log)}
  <key>StandardErrorPath</key>${string(log)}
</dict>
</plist>
`, { mode: 0o600 });
  return { plist, log, label };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const { plist } = await prepareLaunchAgent(root);
  console.log(plist);
}
