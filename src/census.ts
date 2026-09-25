// census(): fold decode + lint over whole blocks. featured(): pick real txs from a block for demos.

import { analyze } from './analyze.ts';
import { fromBase64 } from './codec.ts';
import { MAX_LOADED_DATA, MAX_TX_LEGACY, NOOP_COMPUTE_BUDGET_CU } from './constants.ts';
import { decode } from './decode.ts';
import { lint } from './lint.ts';
import { toTxMeta } from './rpc.ts';
import type { CensusMask, CensusResult, DecodedTx, FeaturedKind, FeaturedPick, RpcBlockBase64, RpcTxBase64 } from './types.ts';
import { xray } from './xray.ts';

const round4 = (x: number) => Math.round(x * 10000) / 10000;
const round2 = (x: number) => Math.round(x * 100) / 100;

/** Median (mean of the two middle values for even n). */
export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Nearest-rank percentile (p in 0..100). */
export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[rank - 1];
}

export function pct(x: number): string {
  return (x * 100).toFixed(1) + '%';
}

export function cardLine(shareAll: number, deadShare: number): string {
  return `v1 = ${pct(shareAll)} of txs · ${pct(deadShare)} of v1 still pay for dead ComputeBudget ixs`;
}

/** One transaction's census facts. */
export interface TxFacts {
  signature: string;
  version: DecodedTx['version'];
  size: number;
  vote: boolean;
  failed: boolean;
  deadCbIxs: number;
  lintIds: string[];
  mask: number | null;
  overask: number | null;
  lookups: number;
}

export function txFacts(tx: DecodedTx, rpcTx: RpcTxBase64): TxFacts {
  const a = analyze(tx);
  const consumed = rpcTx.meta?.computeUnitsConsumed ?? null;
  const findings = lint(tx, consumed !== null ? { slot: 0, blockTime: null, err: null, fee: 0, computeUnitsConsumed: consumed, costUnits: null } : null);
  const limit = tx.version === 'v1'
    ? tx.config!.computeUnitLimit
    : Number(a.computeBudget.find((i) => i.computeBudget?.kind === 'SetComputeUnitLimit')?.computeBudget?.value ?? NaN);
  return {
    signature: tx.signatures[0] ?? '',
    version: tx.version,
    size: tx.size,
    vote: a.isVote,
    failed: !!rpcTx.meta?.err,
    deadCbIxs: tx.version === 'v1' ? a.computeBudget.length : 0,
    lintIds: findings.map((f) => f.id),
    mask: tx.config?.mask ?? null,
    overask: limit && consumed && consumed > 0 && Number.isFinite(limit) ? limit / consumed : null,
    lookups: tx.lookups.length,
  };
}

/** Decode every transaction of the blocks once; undecodable txs are counted, not thrown. */
export function scanBlocks(blocks: RpcBlockBase64[]): { facts: TxFacts[]; decoded: { block: RpcBlockBase64; tx: DecodedTx; rpcTx: RpcTxBase64; facts: TxFacts }[]; undecodable: number } {
  const facts: TxFacts[] = [];
  const decoded: { block: RpcBlockBase64; tx: DecodedTx; rpcTx: RpcTxBase64; facts: TxFacts }[] = [];
  let undecodable = 0;
  for (const block of blocks) {
    for (const rpcTx of block.transactions ?? []) {
      const bytes = fromBase64(rpcTx.transaction[0]);
      if (!bytes) { undecodable++; continue; }
      let tx: DecodedTx;
      try { tx = decode(bytes); } catch { undecodable++; continue; }
      const f = txFacts(tx, rpcTx);
      facts.push(f);
      decoded.push({ block, tx, rpcTx, facts: f });
    }
  }
  return { facts, decoded, undecodable };
}

/** Census over transaction facts from one or more blocks. */
export function censusFromFacts(facts: TxFacts[], blocks: { slot: number; blockTime: number | null }[], undecodable = 0): CensusResult {
  const versions = { legacy: 0, v0: 0, v1: 0 };
  const versionsNonVote = { legacy: 0, v0: 0, v1: 0 };
  let vote = 0;
  const dead = { txs: 0, ixs: 0, cu: 0, failedTxs: 0, share: 0, examples: [] as string[] };
  let over1232 = 0, priorityOnlyInIx = 0, loadedLimitMax = 0, cuLimitAbsent = 0, loadedLimitAbsent = 0;
  const overasks: number[] = [];
  const sizes: number[] = [];
  const masks = new Map<number, number>();
  let v0Lookups = 0;
  for (const f of facts) {
    versions[f.version]++;
    if (f.vote) vote++;
    else versionsNonVote[f.version]++;
    if (f.version === 'v0' && f.lookups > 0) v0Lookups++;
    if (f.version !== 'v1') continue;
    sizes.push(f.size);
    if (f.size > MAX_TX_LEGACY) over1232++;
    if (f.deadCbIxs > 0) {
      dead.txs++;
      dead.ixs += f.deadCbIxs;
      if (f.failed) dead.failedTxs++;
      if (dead.examples.length < 5) dead.examples.push(f.signature);
    }
    if (f.lintIds.includes('V1_PRIORITY_ONLY_IN_IX')) priorityOnlyInIx++;
    if (f.lintIds.includes('LOADED_LIMIT_MAX')) loadedLimitMax++;
    if (f.lintIds.includes('V1_CU_LIMIT_ABSENT')) cuLimitAbsent++;
    if (f.lintIds.includes('V1_LOADED_LIMIT_ABSENT')) loadedLimitAbsent++;
    if (f.overask !== null) overasks.push(f.overask);
    if (f.mask !== null) masks.set(f.mask, (masks.get(f.mask) ?? 0) + 1);
  }
  const total = facts.length;
  const nonVote = total - vote;
  dead.cu = dead.ixs * NOOP_COMPUTE_BUDGET_CU;
  dead.share = versions.v1 ? round4(dead.txs / versions.v1) : 0;
  const shareAll = total ? round4(versions.v1 / total) : 0;
  const med = median(overasks);
  const slots = blocks.map((b) => b.slot);
  const times = blocks.map((b) => b.blockTime).filter((t): t is number => typeof t === 'number');
  return {
    window: 'latest',
    fallback: false,
    stale: false,
    generatedAt: new Date().toISOString(),
    blocks: blocks.length,
    slots: { first: slots.length ? Math.min(...slots) : 0, last: slots.length ? Math.max(...slots) : 0 },
    blockTime: { first: times.length ? Math.min(...times) : 0, last: times.length ? Math.max(...times) : 0 },
    txs: { total, vote, nonVote },
    versions,
    versionsNonVote,
    v1: {
      count: versions.v1,
      shareAll,
      shareNonVote: nonVote ? round4(versionsNonVote.v1 / nonVote) : 0,
      over1232,
      deadComputeBudget: dead,
      priorityOnlyInIx,
      loadedLimitMax,
      cuLimitAbsent,
      loadedLimitAbsent,
      cuOveraskMedian: med === null ? null : round2(med),
      masks: sortMasks(masks),
      size: { p50: percentile(sizes, 50), p90: percentile(sizes, 90), max: sizes.length ? Math.max(...sizes) : 0 },
    },
    v0: { count: versions.v0, withLookups: v0Lookups },
    undecodable,
    card: { line: cardLine(shareAll, dead.share) },
  };
}

export function sortMasks(masks: Map<number, number>): CensusMask[] {
  return [...masks.entries()]
    .map(([mask, count]) => ({ mask, bits: Array.from({ length: 32 }, (_, b) => b).filter((b) => (mask >>> b) & 1), count }))
    .sort((a, b) => b.count - a.count || a.mask - b.mask);
}

/** Census of whole blocks (getBlock base64 + slot). */
export function census(blocks: RpcBlockBase64[]): CensusResult {
  const { facts, undecodable } = scanBlocks(blocks);
  return censusFromFacts(facts, blocks, undecodable);
}

/**
 * Real transactions for demos, in this order when present: the largest v1 by bytes, the first v1 carrying a
 * ComputeBudget ix, the first non-vote v0 using lookup tables, the first non-vote legacy tx. Each with its full xray.
 */
export function featured(block: RpcBlockBase64, scanned?: ReturnType<typeof scanBlocks>): { slot: number; blockTime: number | null; generatedAt: string; stale: boolean; picks: FeaturedPick[] } {
  const s = scanned ?? scanBlocks([block]);
  const rows = s.decoded.filter((d) => d.block === block);
  const pick: [FeaturedKind, (typeof rows)[number] | undefined][] = [
    ['v1-largest', rows.filter((r) => r.tx.version === 'v1').reduce<(typeof rows)[number] | undefined>((m, r) => (!m || r.tx.size > m.tx.size ? r : m), undefined)],
    ['v1-dead-cb', rows.find((r) => r.tx.version === 'v1' && r.facts.deadCbIxs > 0)],
    ['v0-lookups', rows.find((r) => r.tx.version === 'v0' && !r.facts.vote && r.tx.lookups.length > 0)],
    ['legacy', rows.find((r) => r.tx.version === 'legacy' && !r.facts.vote)],
  ];
  const picks: FeaturedPick[] = [];
  for (const [kind, r] of pick) {
    if (!r) continue;
    picks.push({
      kind,
      signature: r.tx.signatures[0],
      version: r.tx.version,
      size: r.tx.size,
      xray: xray(r.tx, { meta: toTxMeta(block.slot, block.blockTime, r.rpcTx.meta), loadedAddresses: r.rpcTx.meta?.loadedAddresses ?? null, source: 'rpc' }),
    });
  }
  return { slot: block.slot, blockTime: block.blockTime ?? null, generatedAt: new Date().toISOString(), stale: false, picks };
}
