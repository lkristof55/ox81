// Pure: combine per-block CensusResults into one window (the 24 h view). No I/O.
import { cardLine, median, sortMasks } from '../../src/index.ts';

const round4 = (x) => Math.round(x * 10000) / 10000;
const round2 = (x) => Math.round(x * 100) / 100;

/**
 * Sums per-block counts. cuOveraskMedian = median of per-block medians; size p50/p90 = medians of the per-block
 * p50/p90 (blocks with v1 txs only); size max = the true max. Shares and the card line are recomputed from the sums.
 */
export function aggregateCensus(perBlock, { window = '24h' } = {}) {
  const list = perBlock.filter(Boolean);
  const sum = (f) => list.reduce((s, c) => s + (f(c) || 0), 0);
  const versions = { legacy: sum((c) => c.versions.legacy), v0: sum((c) => c.versions.v0), v1: sum((c) => c.versions.v1) };
  const versionsNonVote = { legacy: sum((c) => c.versionsNonVote.legacy), v0: sum((c) => c.versionsNonVote.v0), v1: sum((c) => c.versionsNonVote.v1) };
  const total = sum((c) => c.txs.total);
  const vote = sum((c) => c.txs.vote);
  const nonVote = total - vote;
  const deadTxs = sum((c) => c.v1.deadComputeBudget.txs);
  const deadIxs = sum((c) => c.v1.deadComputeBudget.ixs);
  const masks = new Map();
  for (const c of list) for (const m of c.v1.masks || []) masks.set(m.mask, (masks.get(m.mask) || 0) + m.count);
  const withV1 = list.filter((c) => c.v1.count > 0);
  const med = median(list.map((c) => c.v1.cuOveraskMedian).filter((x) => typeof x === 'number'));
  const p50 = median(withV1.map((c) => c.v1.size.p50));
  const p90 = median(withV1.map((c) => c.v1.size.p90));
  const newestFirst = [...list].sort((a, b) => b.slots.last - a.slots.last);
  const examples = [];
  for (const c of newestFirst) for (const s of c.v1.deadComputeBudget.examples || []) if (examples.length < 5) examples.push(s);
  const slotsFirst = list.map((c) => c.slots.first), slotsLast = list.map((c) => c.slots.last);
  const tFirst = list.map((c) => c.blockTime.first).filter(Boolean), tLast = list.map((c) => c.blockTime.last).filter(Boolean);
  const shareAll = total ? round4(versions.v1 / total) : 0;
  const deadShare = versions.v1 ? round4(deadTxs / versions.v1) : 0;
  return {
    window,
    fallback: false,
    stale: false,
    generatedAt: new Date().toISOString(),
    blocks: list.length,
    slots: { first: slotsFirst.length ? Math.min(...slotsFirst) : 0, last: slotsLast.length ? Math.max(...slotsLast) : 0 },
    blockTime: { first: tFirst.length ? Math.min(...tFirst) : 0, last: tLast.length ? Math.max(...tLast) : 0 },
    txs: { total, vote, nonVote },
    versions,
    versionsNonVote,
    v1: {
      count: versions.v1,
      shareAll,
      shareNonVote: nonVote ? round4(versionsNonVote.v1 / nonVote) : 0,
      over1232: sum((c) => c.v1.over1232),
      deadComputeBudget: {
        txs: deadTxs,
        ixs: deadIxs,
        cu: sum((c) => c.v1.deadComputeBudget.cu),
        failedTxs: sum((c) => c.v1.deadComputeBudget.failedTxs),
        share: deadShare,
        examples,
      },
      priorityOnlyInIx: sum((c) => c.v1.priorityOnlyInIx),
      loadedLimitMax: sum((c) => c.v1.loadedLimitMax),
      cuLimitAbsent: sum((c) => c.v1.cuLimitAbsent),
      loadedLimitAbsent: sum((c) => c.v1.loadedLimitAbsent),
      cuOveraskMedian: med === null ? null : round2(med),
      masks: sortMasks(masks),
      size: { p50: p50 === null ? 0 : Math.round(p50), p90: p90 === null ? 0 : Math.round(p90), max: list.length ? Math.max(0, ...list.map((c) => c.v1.size.max)) : 0 },
    },
    v0: { count: sum((c) => c.v0.count), withLookups: sum((c) => c.v0.withLookups) },
    undecodable: sum((c) => c.undecodable),
    card: { line: cardLine(shareAll, deadShare) },
  };
}

/** Keep index entries younger than `maxAgeSec` (by blockTime), newest last, at most `cap`. Returns [kept, dropped]. */
export function pruneIndex(entries, nowSec, { maxAgeSec = 86400, cap = 200 } = {}) {
  const uniq = new Map();
  for (const e of entries || []) if (e && Number.isFinite(e.slot)) uniq.set(e.slot, e);
  const sorted = [...uniq.values()].sort((a, b) => a.slot - b.slot);
  const fresh = sorted.filter((e) => (e.blockTime ?? 0) >= nowSec - maxAgeSec);
  const kept = fresh.slice(-cap);
  const keptSet = new Set(kept.map((e) => e.slot));
  return [kept, sorted.filter((e) => !keptSet.has(e.slot))];
}
