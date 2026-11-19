import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const app = process.argv[2];
if (!/^dev\.[a-z0-9_-]+\.[a-z0-9_-]+$/.test(app ?? '')) {
  throw new Error('Pass the assigned Spare developer app ID as the first argument.');
}
const root = fileURLToPath(new URL('.', import.meta.url));
const dist = join(root, 'dist', app);
const manifest = JSON.parse(await readFile(join(root, 'app.json'), 'utf8'));
manifest.id = app; // Requests go to the wearer's own Agent, so the manifest carries no host to rewrite.
await mkdir(dist, { recursive: true });
await writeFile(join(dist, 'app.json'), JSON.stringify(manifest, null, 2) + '\n');
for (const item of ['main.ss', 'icon.png', 'assets', 'scenarios']) {
  await cp(join(root, item), join(dist, item), { recursive: true });
}
console.log('Prepared ' + dist);
