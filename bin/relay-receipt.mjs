#!/usr/bin/env node
// Checks a Relay receipt with the gateway on this Mac: who wrote the message (the wearer or 总管), the wearer's own
// words, and the full text that was sent. Usage: node bin/relay-receipt.mjs <receipt>. Never prints the token.
import { readFileSync } from 'node:fs';

const id = String(process.argv[2] ?? '').trim();
const envPath = process.env.RELAY_ENV || new URL('../.env', import.meta.url).pathname;
const env = Object.fromEntries(readFileSync(envPath, 'utf8').split('\n')
  .map((line) => /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line)).filter(Boolean).map(([, key, value]) => [key, value.replace(/^["']|["']$/g, '')]));

if (!/^[0-9a-z]{6}$/.test(id)) {
  console.log('用法：node bin/relay-receipt.mjs <6 位回执号>');
  process.exit(2);
}
const response = await fetch('http://127.0.0.1:' + (env.PANEL_PORT || '4488') + '/api/receipts/' + id, {
  headers: { authorization: 'Bearer ' + env.PANEL_TOKEN }, signal: AbortSignal.timeout(5000),
}).catch(() => null);
if (!response) {
  console.log('网关没有回应，没法核对');
  process.exit(1);
}
if (response.status === 404) {
  console.log('没有这张回执');
  process.exit(1);
}
if (!response.ok) {
  console.log('网关拒绝了核对（' + response.status + '）');
  process.exit(1);
}
const receipt = await response.json();
const when = new Date(receipt.at).toLocaleString('zh-CN', { hour12: false });
console.log((receipt.origin === 'voice' ? '本人语音' : '总管转述') + ' · ' + when + ' · 发给 ' + receipt.agent + ':' + receipt.session);
console.log('用户原话：' + (receipt.said ? '「' + receipt.said + '」' : '（没有，总管自己发的）'));
console.log('发出的全文：\n' + receipt.text);
