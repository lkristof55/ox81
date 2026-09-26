// Census snapshots in Blobs (store 'ox81'), written by census-cron and refreshed inline when older than 600 s.
//   census/block/<slot>  per-block CensusResult     census/index  { slots: [{ slot, blockTime }] } (last 24 h)
//   census/latest        CensusResult window=latest census/24h    CensusResult window=24h
//   featured/latest      FeaturedResult
import { censusFromFacts, featured, scanBlocks } from '../../src/index.ts';
import { aggregateCensus, pruneIndex } from './aggregate.mjs';
import { getLatestBlock } from './sources.mjs';
import { getStore } from './store.mjs';

export const MAX_AGE_SEC = 600;
const STORE = 'ox81';

/** Pure: one block -> { census, featured }. */
export function buildSnapshot(block, now = new Date()) {
  const scanned = scanBlocks([block]);
  const census = { ...censusFromFacts(scanned.facts, [block], scanned.undecodable), window: 'latest', generatedAt: now.toISOString() };
  const feat = { ...featured(block, scanned), generatedAt: now.toISOString() };
  return { census, featured: feat };
}

let inflight = null;

/** getSlot + getBlock + census + featured, then write every key. Single-flight per instance. */
export function refreshSnapshot() {
  inflight ||= (async () => {
    try {
      const block = await getLatestBlock();
      const snap = buildSnapshot(block);
      const store = await getStore(STORE);
      const nowSec = Math.floor(Date.now() / 1000);
      const idx = (await store.get('census/index')) || { slots: [] };
      const [kept, dropped] = pruneIndex([...idx.slots, { slot: block.slot, blockTime: block.blockTime }], nowSec);
      await store.setJSON(`census/block/${block.slot}`, snap.census);
      await store.setJSON('census/index', { slots: kept });
      await store.setJSON('census/latest', snap.census);
      await store.setJSON('featured/latest', snap.featured);
      await Promise.allSettled(dropped.map((e) => store.delete(`census/block/${e.slot}`)));
      const day = await compute24h(store, kept);
      if (day) await store.setJSON('census/24h', day);
      return snap;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

async function compute24h(store, entries) {
  const nowSec = Math.floor(Date.now() / 1000);
  const recent = entries.filter((e) => (e.blockTime ?? 0) >= nowSec - 86400);
  if (!recent.length) return null;
  const per = await Promise.all(recent.map((e) => store.get(`census/block/${e.slot}`)));
  return aggregateCensus(per.filter(Boolean), { window: '24h' });
}

const ageSec = (doc) => (doc?.generatedAt ? (Date.now() - Date.parse(doc.generatedAt)) / 1000 : Infinity);

/**
 * Read a snapshot key; refresh inline when missing or older than MAX_AGE_SEC.
 * If the refresh fails and an older copy exists, return it with stale=true; otherwise rethrow.
 */
export async function readFresh(key) {
  const store = await getStore(STORE);
  const doc = await store.get(key);
  if (doc && ageSec(doc) <= MAX_AGE_SEC) return doc;
  try {
    const snap = await refreshSnapshot();
    if (key === 'census/latest') return snap.census;
    if (key === 'featured/latest') return snap.featured;
    return (await store.get(key)) ?? (doc ? { ...doc, stale: true } : null);
  } catch (e) {
    if (doc) return { ...doc, stale: true };
    throw e;
  }
}

/** /api/census?window=24h: the stored 24 h aggregate; falls back to latest (fallback=true) when there is none. */
export async function read24h() {
  const store = await getStore(STORE);
  let day = await store.get('census/24h');
  if (!day || ageSec(day) > MAX_AGE_SEC) {
    try {
      await refreshSnapshot();
      day = await store.get('census/24h');
    } catch (e) {
      if (!day) {
        const latest = await store.get('census/latest');
        if (latest) return { ...latest, window: '24h', fallback: true, stale: true };
        throw e;
      }
      return { ...day, stale: true };
    }
  }
  if (!day || !day.blocks) {
    const latest = await readFresh('census/latest');
    return { ...latest, window: '24h', fallback: true };
  }
  return day;
}
