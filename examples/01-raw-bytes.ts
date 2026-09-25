// Offline: X-ray raw wire bytes (a real v1 tx recorded from mainnet slot 450355468). No RPC.
//   node examples/01-raw-bytes.ts
import { readFileSync } from 'node:fs';
import { fromBase64, xray } from '../src/index.ts';

const rec = JSON.parse(readFileSync(new URL('../test/fixtures/tx-v1-dead-cb.json', import.meta.url), 'utf8'));
const x = xray(fromBase64(rec.transaction[0])!);

console.log(`${x.version}, ${x.size} B, config mask ${x.config?.maskHex}, priority fee ${x.config?.priorityFeeLamports} lamports`);
for (const r of x.ranges.filter((r) => r.group !== 'address')) console.log(`[${r.start}, ${r.end})`.padEnd(14), r.field.padEnd(34), r.value);
for (const f of x.lint) console.log(`${f.severity} ${f.id}: ${f.title}`);
console.log(x.misread[0].result);
