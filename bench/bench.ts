// npm run bench  (= node bench/bench.ts)
// Measures ox81 on the recorded mainnet block in test/fixtures (974 txs: 671 legacy, 203 v0, 100 v1).
// Optional reference numbers: if `esbuild` / `@solana/web3.js` resolve, they are measured too; otherwise skipped.

import { readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { census, decode, fromBase64, sniff, xray } from '../src/index.ts';
import type { RpcBlockBase64 } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const block: RpcBlockBase64 = JSON.parse(readFileSync(join(here, '..', 'test', 'fixtures', 'block-450355468.json'), 'utf8'));
const txs = block.transactions.map((t) => fromBase64(t.transaction[0])!);
const bytesTotal = txs.reduce((s, b) => s + b.length, 0);
const v1 = txs.filter((b) => b[0] === 0x81);

function measure(fn: () => void, minMs = 1500): { runs: number; ms: number } {
  for (let i = 0; i < 3; i++) fn(); // warm-up
  let runs = 0;
  const t0 = performance.now();
  let t = t0;
  while (t - t0 < minMs) { fn(); runs++; t = performance.now(); }
  return { runs, ms: t - t0 };
}
function medianMs(fn: () => void, n = 25): number {
  for (let i = 0; i < 3; i++) fn();
  const xs: number[] = [];
  for (let i = 0; i < n; i++) { const t = performance.now(); fn(); xs.push(performance.now() - t); }
  xs.sort((a, b) => a - b);
  return xs[n >> 1];
}
const k = (n: number) => Math.round(n).toLocaleString('en-US');

console.log(`ox81 bench · ${cpus()[0].model} · ${cpus().length} cores · ${Math.round(totalmem() / 2 ** 30)} GB · Node ${process.version}`);
console.log(`fixture: slot ${block.slot}, ${txs.length} txs (${v1.length} v1), ${k(bytesTotal)} B of wire bytes\n`);

let sink = 0;
{
  const r = measure(() => { for (const b of txs) sink += sniff(b).version.length; });
  const ns = (r.ms * 1e6) / (r.runs * txs.length);
  console.log(`sniff()              ${ns.toFixed(1)} ns/tx`);
}
{
  const r = measure(() => { for (const b of txs) sink += decode(b).ranges.length; });
  const perSec = (r.runs * txs.length) / (r.ms / 1000);
  console.log(`decode() + byteMap   ${k(perSec)} txs/s   (${((r.runs * bytesTotal) / (r.ms / 1000) / 1e6).toFixed(1)} MB/s, all ${txs.length} txs)`);
}
{
  const r = measure(() => { for (const b of v1) sink += decode(b).ranges.length; });
  console.log(`decode() v1 only     ${k((r.runs * v1.length) / (r.ms / 1000))} txs/s`);
}
{
  const r = measure(() => { for (const b of txs) sink += xray(b).lint.length; });
  console.log(`xray() full          ${k((r.runs * txs.length) / (r.ms / 1000))} txs/s   (decode + accounts + lint + misread + v1Port + base64)`);
}
{
  const ms = medianMs(() => { sink += census([block]).txs.total; });
  console.log(`census(1 block)      ${ms.toFixed(1)} ms median of 25   (${txs.length} txs incl. base64 decode, network excluded)`);
}

try {
  const esbuild = await import('esbuild' as string);
  const out = await esbuild.build({ entryPoints: [join(here, '..', 'src', 'index.ts')], bundle: true, minify: true, format: 'esm', write: false, platform: 'neutral' });
  const code = out.outputFiles[0].contents as Uint8Array;
  console.log(`browser bundle       ${k(code.length)} B minified, ${k(gzipSync(code).length)} B gzip   (esbuild ${esbuild.version}, src/index.ts, esm)`);
} catch {
  console.log('browser bundle       skipped (npm i -D esbuild to measure)');
}

try {
  const web3 = await import('@solana/web3.js' as string);
  const { VersionedTransaction } = web3.default ?? web3;
  let ok = 0, threw = 0;
  for (const b of txs) { try { VersionedTransaction.deserialize(b); ok++; } catch { threw++; } }
  const r = measure(() => { for (const b of txs) { try { sink += VersionedTransaction.deserialize(b).signatures.length; } catch { /* counted above */ } } });
  console.log(`reference: @solana/web3.js VersionedTransaction.deserialize  ${k((r.runs * txs.length) / (r.ms / 1000))} txs/s   (${ok} parsed, ${threw} threw; objects only, no byte map / lint)`);
} catch {
  console.log('reference: @solana/web3.js skipped (npm i -D @solana/web3.js@1.99.0 to compare)');
}
if (sink === -1) console.log(sink);
