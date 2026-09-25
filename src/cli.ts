#!/usr/bin/env node
// ox81 CLI:
//   ox81 xray <signature|base64> [--rpc URL] [--json]
//   ox81 lint <signature|base64> [--rpc URL] [--json]
//   ox81 census [--slots N] [--rpc URL] [--json]
// RPC: --rpc, else env OX81_RPC_URL, else the public mainnet endpoint (rate-limited).

import { census } from './census.ts';
import { fromBase58, fromBase64 } from './codec.ts';
import { decode, DecodeError } from './decode.ts';
import { fetchBlock, fetchSlot, fetchTransaction } from './rpc.ts';
import type { ByteRange, RpcBlockBase64, XrayResult } from './types.ts';
import { xray } from './xray.ts';

const PUBLIC_RPC = 'https://api.mainnet-beta.solana.com';
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const opt = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const positional = args.filter((a, i) => !a.startsWith('--') && !['--rpc', '--slots', '--concurrency'].includes(args[i - 1]));
const [cmd, input] = positional;
const json = flag('json');
const fmt = (n: number) => n.toLocaleString('en-US');

function rpcUrl(): string {
  const u = opt('rpc') || process.env.OX81_RPC_URL;
  if (u) return u;
  if (!json) console.error(`warning: no --rpc or OX81_RPC_URL; using ${PUBLIC_RPC} (public, rate-limited)`);
  return PUBLIC_RPC;
}

function usage(code = 0): never {
  console.log(`ox81: byte-exact X-ray for Solana transactions (legacy, v0, v1)

  ox81 xray <signature|base64> [--rpc URL] [--json]   every byte labelled + lint + misread + v1 port
  ox81 lint <signature|base64> [--rpc URL] [--json]   lint findings only
  ox81 census [--slots N] [--rpc URL] [--json]        v1 share and v1 mistakes over the last N slots (default 10)

  RPC: --rpc URL, else env OX81_RPC_URL, else ${PUBLIC_RPC}`);
  process.exit(code);
}

async function load(input: string): Promise<XrayResult> {
  const sig = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(input) ? fromBase58(input) : null;
  if (sig && sig.length === 64) {
    const t = await fetchTransaction(rpcUrl(), input);
    if (!t) throw new Error(`transaction ${input} not found (unknown, or not yet confirmed)`);
    return xray(t.bytes, { meta: t.meta, loadedAddresses: t.loadedAddresses, source: 'rpc' });
  }
  const bytes = fromBase64(input);
  if (!bytes || !bytes.length) throw new Error('input is neither a base58 signature nor base64 transaction bytes');
  return xray(bytes, { source: 'raw' });
}

/** Collapse runs of the same repeated field (address x63, signature x2) for the terminal. */
function collapse(ranges: ByteRange[]): { start: number; end: number; field: string; value: string }[] {
  const out: { start: number; end: number; field: string; value: string; n: number }[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    if (last && r.index !== undefined && r.ix === undefined && last.field.startsWith(r.field) && ['address', 'signature'].includes(r.field)) {
      last.end = r.end; last.n++; last.field = `${r.field} x${last.n}`; last.value = '';
      continue;
    }
    const label = r.ix !== undefined ? `${r.field} (ix ${r.ix})` : r.field;
    out.push({ start: r.start, end: r.end, field: label, value: r.value ?? '', n: 1 });
  }
  return out;
}

function printXray(x: XrayResult, lintOnly: boolean) {
  const where = x.meta ? ` · slot ${x.meta.slot}` : '';
  console.log(`${x.version} · ${fmt(x.size)} B (max ${fmt(x.maxSize)})${where} · ${x.signature ?? 'unsigned'}`);
  if (!lintOnly) {
    if (x.config) console.log(`config mask ${x.config.maskHex} bits [${x.config.bits.join(',')}] · priority ${x.config.priorityFeeLamports ?? '0 (unset)'} lamports · CU limit ${x.config.computeUnitLimit ?? '0 (unset)'} · loaded ${x.config.loadedAccountsDataSizeLimit ?? '0 (unset)'} · heap ${x.config.heapSize ?? '32768 (unset)'}`);
    console.log('');
    for (const r of collapse(x.ranges)) {
      const v = r.value.length > 48 ? r.value.slice(0, 45) + '…' : r.value;
      console.log(`[${String(r.start).padStart(5)}, ${String(r.end).padStart(5)})  ${r.field.padEnd(40)} ${v}`);
    }
  }
  console.log('\nlint:' + (x.lint.length ? '' : ' clean'));
  for (const f of x.lint) {
    const cost = [f.cu !== null ? `${fmt(f.cu)} CU` : '', f.bytes !== null ? `${fmt(f.bytes)} B` : ''].filter(Boolean).join(', ');
    console.log(`  ${f.severity.padEnd(5)} ${f.id.padEnd(24)} ${f.title}${cost ? ` (${cost})` : ''}`);
    console.log(`        ${f.detail}`);
  }
  if (lintOnly) return;
  console.log('\nmisread:');
  for (const m of x.misread) console.log(`  ${m.ok ? 'ok  ' : 'FAIL'} ${m.reader.padEnd(24)} ${m.result}`);
  if (x.v1Port) console.log(`\nv1 port: ${fmt(x.v1Port.size)} B (${x.v1Port.bytesDelta >= 0 ? '+' : ''}${x.v1Port.bytesDelta} B), ${x.v1Port.fits ? 'fits' : 'blocked: ' + x.v1Port.blockers.join('; ')}, config bits [${x.v1Port.configBits.join(',')}], ${x.v1Port.removedComputeBudgetIxs} ComputeBudget ixs dropped, ${x.v1Port.inlinedLookupAddresses} lookup addresses inlined`);
}

async function runCensus() {
  const n = Math.max(1, Math.min(1000, Number(opt('slots') ?? 10) || 10));
  const conc = Math.max(1, Math.min(16, Number(opt('concurrency') ?? 4) || 4));
  const url = rpcUrl();
  const tip = await fetchSlot(url, 'finalized');
  const slots = Array.from({ length: n }, (_, i) => tip - i);
  const blocks: RpcBlockBase64[] = [];
  let skipped = 0, done = 0;
  const t0 = performance.now();
  let next = 0;
  await Promise.all(Array.from({ length: conc }, async () => {
    while (next < slots.length) {
      const s = slots[next++];
      const b = await fetchBlock(url, s, { timeoutMs: 30000, retries: 4 });
      if (b) blocks.push(b); else skipped++;
      done++;
      if (!json && process.stderr.isTTY) process.stderr.write(`\rfetched ${done}/${n} slots`);
    }
  }));
  if (!json && process.stderr.isTTY) process.stderr.write('\n');
  const fetchMs = performance.now() - t0;
  const t1 = performance.now();
  const c = census(blocks.sort((a, b) => a.slot - b.slot));
  const censusMs = performance.now() - t1;
  if (json) { console.log(JSON.stringify({ ...c, window: `slots:${n}`, skippedSlots: skipped }, null, 2)); return; }
  const v = c.v1;
  console.log(`ox81 census · slots ${c.slots.first}..${c.slots.last} · ${c.blocks} blocks (${skipped} skipped) · ${fmt(c.txs.total)} txs · ${new Date(c.blockTime.last * 1000).toISOString()}`);
  console.log(`versions     legacy ${fmt(c.versions.legacy)} · v0 ${fmt(c.versions.v0)} · v1 ${fmt(c.versions.v1)}   (non-vote: legacy ${fmt(c.versionsNonVote.legacy)} · v0 ${fmt(c.versionsNonVote.v0)} · v1 ${fmt(c.versionsNonVote.v1)})`);
  console.log(`v1 share     ${(v.shareAll * 100).toFixed(1)}% of all txs · ${(v.shareNonVote * 100).toFixed(1)}% of non-vote`);
  console.log(`v1 > 1232 B  ${fmt(v.over1232)} of ${fmt(v.count)}`);
  console.log(`dead CB      ${fmt(v.deadComputeBudget.txs)} v1 txs carry ${fmt(v.deadComputeBudget.ixs)} ComputeBudget ixs = ${fmt(v.deadComputeBudget.cu)} CU of no-ops (${(v.deadComputeBudget.share * 100).toFixed(1)}% of v1; ${v.deadComputeBudget.failedTxs} of those txs failed, for their own reasons)`);
  console.log(`priority     ${fmt(v.priorityOnlyInIx)} v1 txs set a price only in a dead ix`);
  console.log(`limits       ${fmt(v.loadedLimitMax)} request the 64 MiB loaded-data max · ${fmt(v.cuLimitAbsent)} no CU limit · ${fmt(v.loadedLimitAbsent)} no loaded limit · median CU over-ask ${v.cuOveraskMedian ?? '-'}x`);
  console.log(`masks        ${v.masks.slice(0, 5).map((m) => `0x${m.mask.toString(16).padStart(2, '0')}[${m.bits.join(',')}] ${fmt(m.count)}`).join(' · ')}`);
  console.log(`v1 size      p50 ${fmt(v.size.p50)} B · p90 ${fmt(v.size.p90)} B · max ${fmt(v.size.max)} B`);
  console.log(`v0           ${fmt(c.v0.count)} (${fmt(c.v0.withLookups)} with lookup tables)`);
  console.log(`\n${c.card.line}`);
  console.log(`(fetch ${(fetchMs / 1000).toFixed(1)} s, census ${censusMs.toFixed(0)} ms)`);
}

try {
  if (!cmd || flag('help') || cmd === 'help') usage(cmd ? 0 : 1);
  if (cmd === 'census') await runCensus();
  else if (cmd === 'xray' || cmd === 'lint') {
    if (!input) usage(1);
    const x = await load(input);
    if (json) console.log(JSON.stringify(cmd === 'lint' ? x.lint : x, null, 2));
    else printXray(x, cmd === 'lint');
  } else if (cmd === 'decode') {
    // hidden helper: structural decode only
    const bytes = fromBase64(input ?? '');
    if (!bytes) throw new Error('decode takes base64');
    console.log(JSON.stringify(decode(bytes).ranges, null, 2));
  } else usage(1);
} catch (e) {
  if (e instanceof DecodeError) {
    console.error(`decode failed at offset ${e.at}: ${e.message}`);
    if (json) console.log(JSON.stringify({ error: e.message, at: e.at, partial: e.partial }, null, 2));
  } else console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
