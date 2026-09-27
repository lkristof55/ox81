// Census snapshots in the store 'ox81' (Netlify Blobs, Cloudflare D1 or local files), written by census-cron.
//   census/block/<slot>  per-block CensusResult     census/index  { slots: [{ slot, blockTime }] } (last 24 h)
//   census/latest        CensusResult window=latest census/24h    CensusResult window=24h
//   featured/latest      FeaturedResult
// Netlify: the endpoints refresh inline when a snapshot is older than 600 s.
// Cloudflare: worker.mjs calls serveStoredOnly(), so the endpoints only read and the cron is the only writer.
//
// Split mode (Workers Free: CF_FREE_PLAN=1, or CENSUS_TXS_PER_RUN > 0) reads one block over several cron runs, one
// step per run, so no run decodes a whole block (see advanceSnapshot):
//   census/work            cursor { slot, blockTime, txs, pages, next, attempt }
//   census/work/page/<i>   { start, txs }: up to CENSUS_TXS_PER_RUN txs of the block (base64 + the meta ox81 reads)
//   census/work/facts/<i>  { facts, undecodable, candidates }: page i's TxFacts and its featured candidates
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

/** Write one finished block: its per-block census, the 24 h index, latest, featured, and the 24 h aggregate. */
async function publishSnapshot(store, block, snap) {
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
}

let inflight = null;

/** getSlot + getBlock + census + featured, then write every key. Single-flight per instance. */
export function refreshSnapshot() {
  inflight ||= (async () => {
    try {
      const block = await getLatestBlock();
      const snap = buildSnapshot(block);
      const store = await getStore(STORE);
      await publishSnapshot(store, block, snap);
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

// ---------------------------------------------------------------- split mode (one step per cron run)

/** Default page size under CF_FREE_PLAN=1: about 5 ms of decode + lint per run on the measuring machine. */
export const FREE_PLAN_TXS_PER_RUN = 100;
/** Page rows stay far under D1's 2 MB row cap (estimate below is an upper bound per tx). */
const PAGE_MAX_CHARS = 1_000_000;
/** A step that did not finish twice (e.g. the run was killed for CPU) drops the block; the next run starts a new one. */
const MAX_ATTEMPTS = 2;
const WORK = 'census/work';
const PAGE = (i) => `census/work/page/${i}`;
const FACTS = (i) => `census/work/facts/${i}`;

/**
 * The cron's budget from env. CENSUS_TXS_PER_RUN wins; CF_FREE_PLAN=1 defaults it to FREE_PLAN_TXS_PER_RUN and asks
 * the RPC for an uncompressed block. 0 = the whole block in one run (Netlify, Workers Paid).
 */
export function cronBudget(env = process.env) {
  const free = /^(1|true|yes)$/i.test(env.CF_FREE_PLAN || '');
  const raw = env.CENSUS_TXS_PER_RUN;
  const n = raw !== undefined && raw !== '' ? Number(raw) : free ? FREE_PLAN_TXS_PER_RUN : 0;
  return { txsPerRun: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0, identity: free };
}

/** A block transaction with only the meta fields ox81 reads (the same trim as the recorded test fixtures). */
export function slimTx(t) {
  const m = t.meta;
  return {
    transaction: t.transaction,
    meta: m ? { err: m.err ?? null, fee: m.fee, computeUnitsConsumed: m.computeUnitsConsumed ?? null, costUnits: m.costUnits ?? null, loadedAddresses: m.loadedAddresses ?? null } : null,
    version: t.version,
  };
}

/** Split txs into pages of at most `perPage` txs and about PAGE_MAX_CHARS of JSON, in block order. */
export function pageTxs(txs, perPage) {
  const pages = [];
  let cur = [], chars = 0;
  for (const t of txs) {
    const la = t.meta?.loadedAddresses;
    const size = (t.transaction?.[0]?.length ?? 0) + 64 * ((la?.writable?.length ?? 0) + (la?.readonly?.length ?? 0)) + 512;
    if (cur.length && (cur.length >= perPage || chars + size > PAGE_MAX_CHARS)) { pages.push(cur); cur = []; chars = 0; }
    cur.push(t);
    chars += size;
  }
  if (cur.length) pages.push(cur);
  return pages;
}

/**
 * One step of the split census, chosen by the cursor in the store:
 *   fetch   getSlot + getBlock (1 block), store it as pages; no decoding
 *   scan    decode + lint one page (scanBlocks), store its TxFacts and its featured() candidates
 *   publish censusFromFacts over every page + featured() over the candidates, then the same writes as a full run
 * The published census and featured picks are the ones buildSnapshot() gives for the same block (tested).
 */
export async function advanceSnapshot({ txsPerRun = FREE_PLAN_TXS_PER_RUN, identity = false } = {}) {
  const store = await getStore(STORE);
  const work = await store.get(WORK);
  if (!work) return startBlock(store, txsPerRun, identity);
  const step = work.next;
  const attempt = work.attempt && work.attempt.step === step ? work.attempt.n + 1 : 1;
  if (attempt > MAX_ATTEMPTS) {
    await clearWork(store, work);
    return { step: 'abandoned', slot: work.slot, note: `dropped slot ${work.slot}: step ${step + 2} of ${work.pages + 2} did not finish twice` };
  }
  await store.setJSON(WORK, { ...work, attempt: { step, n: attempt } });
  return step < work.pages ? scanPage(store, work, step) : publishWork(store, work);
}

async function startBlock(store, txsPerRun, identity) {
  const block = await getLatestBlock({ identity });
  // leftovers of a run that died between its writes
  const { blobs } = await store.list({ prefix: 'census/work/' });
  await Promise.allSettled(blobs.map((b) => store.delete(b.key)));
  const pages = pageTxs((block.transactions ?? []).map(slimTx), txsPerRun);
  let start = 0;
  const writes = pages.map((txs, i) => { const w = store.setJSON(PAGE(i), { start, txs }); start += txs.length; return w; });
  await Promise.all(writes);
  await store.setJSON(WORK, { slot: block.slot, blockTime: block.blockTime ?? null, txs: start, pages: pages.length, next: 0, attempt: null, startedAt: new Date().toISOString() });
  return { step: 'fetch', slot: block.slot, note: `slot ${block.slot}: ${start} txs in ${pages.length} pages, step 1 of ${pages.length + 2}` };
}

async function scanPage(store, work, i) {
  const page = await store.get(PAGE(i));
  if (!page) throw new Error(`page ${i} of slot ${work.slot} is missing`);
  const block = { slot: work.slot, blockTime: work.blockTime, transactions: page.txs };
  const scanned = scanBlocks([block]);
  // featured() over the whole block can only pick, from this page, what featured() picks from this page alone
  // (each kind is the first match in block order, or the first largest), so these txs are kept for publish.
  const at = new Map(page.txs.map((t, k) => [t, page.start + k]));
  const bySig = new Map(scanned.decoded.map((d) => [d.tx.signatures[0], d.rpcTx]));
  const candidates = [];
  for (const p of featured(block, scanned).picks) {
    const tx = bySig.get(p.signature);
    if (tx && !candidates.some((c) => c.tx === tx)) candidates.push({ i: at.get(tx), tx });
  }
  await store.setJSON(FACTS(i), { facts: scanned.facts, undecodable: scanned.undecodable, candidates });
  await store.setJSON(WORK, { ...work, next: i + 1, attempt: null });
  return { step: 'scan', slot: work.slot, note: `slot ${work.slot}: page ${i + 1}/${work.pages} (${page.txs.length} txs), step ${i + 2} of ${work.pages + 2}` };
}

async function publishWork(store, work) {
  const parts = await Promise.all(Array.from({ length: work.pages }, (_, i) => store.get(FACTS(i))));
  if (parts.some((p) => !p)) throw new Error(`facts of slot ${work.slot} are incomplete`);
  const facts = parts.flatMap((p) => p.facts);
  const undecodable = parts.reduce((s, p) => s + p.undecodable, 0);
  const candidates = parts.flatMap((p) => p.candidates).sort((a, b) => a.i - b.i).map((c) => c.tx);
  const blockRef = { slot: work.slot, blockTime: work.blockTime };
  const now = new Date();
  const snap = {
    census: { ...censusFromFacts(facts, [blockRef], undecodable), window: 'latest', generatedAt: now.toISOString() },
    featured: { ...featured({ ...blockRef, transactions: candidates }), generatedAt: now.toISOString() },
  };
  await publishSnapshot(store, blockRef, snap);
  await clearWork(store, work);
  return { step: 'publish', slot: work.slot, snap, note: `slot ${work.slot}: ${snap.census.txs.total} txs, ${snap.census.card.line}` };
}

async function clearWork(store, work) {
  const n = work.pages || 0;
  await Promise.allSettled([...Array.from({ length: n }, (_, i) => PAGE(i)), ...Array.from({ length: n }, (_, i) => FACTS(i))].map((k) => store.delete(k)));
  await store.delete(WORK);
}

// ---------------------------------------------------------------- reads (the HTTP endpoints)

let serveOnly = false;

/** Cloudflare: the endpoints never refresh (inline or in waitUntil); they serve the stored snapshot with its age. */
export function serveStoredOnly(on = true) { serveOnly = on; }

const ageSec = (doc) => (doc?.generatedAt ? (Date.now() - Date.parse(doc.generatedAt)) / 1000 : Infinity);

/** Serve-only staleness: the newest block in the doc is older than CENSUS_STALE_SEC (default 1200 s, two cron periods). */
function isStale(doc) {
  const limit = Number(process.env.CENSUS_STALE_SEC) > 0 ? Number(process.env.CENSUS_STALE_SEC) : 2 * MAX_AGE_SEC;
  const t = typeof doc.blockTime === 'number' ? doc.blockTime : doc.blockTime?.last;
  return (t > 0 ? Date.now() / 1000 - t : ageSec(doc)) > limit;
}

/** Cold start with nothing stored yet (serve-only): the normal shape with no numbers and warming=true. */
export function warmingDoc(key, now = new Date()) {
  if (key === 'featured/latest') return { slot: 0, blockTime: null, generatedAt: now.toISOString(), stale: false, warming: true, picks: [] };
  return { ...censusFromFacts([], []), window: 'latest', generatedAt: now.toISOString(), warming: true, card: { line: 'no census yet: the cron is still reading its first block' } };
}

/**
 * Read a snapshot key; refresh inline when missing or older than MAX_AGE_SEC.
 * If the refresh fails and an older copy exists, return it with stale=true; otherwise rethrow.
 * Serve-only: never refresh; the stored doc with stale by block age, or a warming doc.
 */
export async function readFresh(key) {
  const store = await getStore(STORE);
  const doc = await store.get(key);
  if (serveOnly) return doc ? { ...doc, stale: isStale(doc) } : warmingDoc(key);
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
  if (serveOnly) {
    if (day && day.blocks) return { ...day, stale: isStale(day) };
    const latest = await readFresh('census/latest');
    return { ...latest, window: '24h', fallback: !latest.warming };
  }
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
