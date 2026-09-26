// Offline tests for the backend glue: validation, rate limit, cache, 24 h aggregation, snapshot building,
// and the functions themselves against a temp store (no RPC key set, so any accidental RPC call fails loudly).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

delete process.env.HELIUS_API_KEY;
delete process.env.SOLANA_RPC_URL;
const { useStoreDir, getStore } = await import('../lib/store.mjs');
useStoreDir(mkdtempSync(join(tmpdir(), 'ox81-test-')));

const { parseSignature, parseRaw, rateLimiter, ttlCache } = await import('../lib/http.mjs');
const { aggregateCensus, pruneIndex } = await import('../lib/aggregate.mjs');
const { buildSnapshot } = await import('../lib/snapshot.mjs');
const { checkPartition } = await import('../../src/index.ts');
const xrayFn = (await import('../netlify/functions/xray.mjs')).default;
const censusFn = (await import('../netlify/functions/census.mjs')).default;
const featuredFn = (await import('../netlify/functions/featured.mjs')).default;

const FIX = new URL('../../test/fixtures/', import.meta.url);
const fixture = (n) => JSON.parse(readFileSync(new URL(n, FIX), 'utf8'));
const BLOCK = fixture('block-450355468.json');
const V1 = fixture('tx-v1-dead-cb.json');
const SIG = 'W81fNLqueZDWx5335CaemPZE2D8EuqAYhwUD47WX5RexigN9BEjGxmZcaoLkFsitubvAY6wYXfi8hnLrPoB7FMz';
const ctx = (ip = '1.1.1.1') => ({ ip });
const post = (body, ip) => xrayFn(new Request('http://x/api/xray', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), ctx(ip));

test('parseSignature: real signature ok; malformed, short, wrong alphabet rejected', () => {
  assert.equal(parseSignature(SIG), SIG);
  assert.equal(parseSignature(` ${SIG} `), SIG);
  for (const bad of ['', 'abc', SIG.slice(0, 40), SIG.replace('W', '0'), SIG + 'x'.repeat(30), 'ComputeBudget111111111111111111111111111111', null, 42]) assert.equal(parseSignature(bad), null, String(bad));
});

test('parseRaw: base64 with whitespace ok; empty, junk, oversize rejected', () => {
  assert.equal(parseRaw(V1.transaction[0]).bytes.length, 2291);
  assert.equal(parseRaw(V1.transaction[0].replace(/(.{76})/g, '$1\n')).bytes.length, 2291);
  assert.match(parseRaw('').error, /non-empty/);
  assert.match(parseRaw('!!!').error, /base64/);
  assert.match(parseRaw(Buffer.alloc(4097).toString('base64')).error, /4096/);
  assert.match(parseRaw(123).error, /string/);
});

test('rate limiter: 30 per minute per IP, then retryAfter', () => {
  const rl = rateLimiter(30, 60_000);
  for (let i = 0; i < 30; i++) assert.equal(rl('a', 1000).ok, true);
  const r = rl('a', 1000);
  assert.equal(r.ok, false);
  assert.equal(r.retryAfter, 60);
  assert.equal(rl('b', 1000).ok, true);
  assert.equal(rl('a', 61_001).ok, true);
});

test('ttl cache expires and caps size', () => {
  const c = ttlCache(1000, 2);
  c.set('a', 1, 0); c.set('b', 2, 0); c.set('c', 3, 0);
  assert.equal(c.get('a', 10), undefined);
  assert.equal(c.get('c', 10), 3);
  assert.equal(c.get('c', 2000), undefined);
});

test('snapshot from a real block: census + four featured picks', () => {
  const s = buildSnapshot(BLOCK, new Date('2026-09-25T12:50:00Z'));
  assert.equal(s.census.window, 'latest');
  assert.equal(s.census.txs.total, 974);
  assert.equal(s.census.v1.count, 100);
  assert.equal(s.featured.picks.length, 4);
  for (const p of s.featured.picks) assert.equal(checkPartition(p.xray.ranges, p.size), null);
});

test('24h aggregation sums counts, recomputes shares, medians of medians, true max', () => {
  const a = buildSnapshot(BLOCK).census;
  const b = structuredClone(a);
  b.slots = { first: a.slots.first + 1500, last: a.slots.last + 1500 };
  b.v1.size = { p50: 1000, p90: 2000, max: 4000 };
  b.v1.cuOveraskMedian = 2;
  const agg = aggregateCensus([a, b]);
  assert.equal(agg.window, '24h');
  assert.equal(agg.blocks, 2);
  assert.equal(agg.txs.total, 2 * 974);
  assert.equal(agg.v1.count, 200);
  assert.equal(agg.v1.shareAll, a.v1.shareAll);
  assert.equal(agg.v1.size.max, 4000);
  assert.equal(agg.v1.size.p50, Math.round((1415 + 1000) / 2));
  assert.equal(agg.v1.cuOveraskMedian, Math.round(((5.86 + 2) / 2) * 100) / 100);
  assert.equal(agg.v1.masks[0].count, 2 * a.v1.masks[0].count);
  assert.equal(agg.slots.last, b.slots.last);
  assert.ok(agg.v1.deadComputeBudget.examples.length <= 5);
  const empty = aggregateCensus([]);
  assert.equal(empty.txs.total, 0);
  assert.ok(!JSON.stringify(empty).includes('NaN'));
});

test('index pruning keeps the last 24 h, dedupes, caps', () => {
  const now = 2_000_000;
  const [kept, dropped] = pruneIndex([{ slot: 1, blockTime: now - 90000 }, { slot: 2, blockTime: now - 100 }, { slot: 2, blockTime: now - 100 }, { slot: 3, blockTime: now }], now);
  assert.deepEqual(kept.map((e) => e.slot), [2, 3]);
  assert.deepEqual(dropped.map((e) => e.slot), [1]);
  const many = Array.from({ length: 300 }, (_, i) => ({ slot: i, blockTime: now }));
  assert.equal(pruneIndex(many, now)[0].length, 200);
});

test('POST /api/xray: raw bytes -> xray (no RPC), bad input 400, truncated 422 with offset', async () => {
  const r = await post({ raw: V1.transaction[0] }, 'p1');
  assert.equal(r.status, 200);
  const x = await r.json();
  assert.equal(x.source, 'raw');
  assert.equal(x.version, 'v1');
  assert.equal(x.meta, null);
  assert.equal(x.misread.length, 5);
  assert.equal(checkPartition(x.ranges, x.size), null);

  assert.equal((await post('not json', 'p1')).status, 400);
  assert.equal((await post({ raw: '' }, 'p1')).status, 400);
  const bad = await post({ raw: Buffer.from(V1.transaction[0], 'base64').subarray(0, 100).toString('base64') }, 'p1');
  assert.equal(bad.status, 422);
  const e = await bad.json();
  assert.equal(e.code, 'DECODE_FAILED');
  assert.equal(typeof e.at, 'number');
  assert.equal(e.partial.version, 'v1');
  assert.ok(e.partial.ranges.length > 0);
});

test('GET /api/xray validates the signature before any RPC; no RPC configured -> 502 JSON', async () => {
  const r = await xrayFn(new Request('http://x/api/xray?sig=nope'), ctx('g1'));
  assert.equal(r.status, 400);
  assert.equal((await r.json()).code, 'BAD_INPUT');
  const miss = await xrayFn(new Request('http://x/api/xray'), ctx('g1'));
  assert.equal(miss.status, 400);
  const up = await xrayFn(new Request(`http://x/api/xray?sig=${SIG}`), ctx('g1'));
  assert.equal(up.status, 502);
  const body = await up.json();
  assert.equal(body.code, 'UPSTREAM');
  assert.ok(!/api-key|stack/i.test(body.error));
});

test('xray rate limit: 31st request in a minute from one IP gets 429', async () => {
  let last;
  for (let i = 0; i < 31; i++) last = await xrayFn(new Request('http://x/api/xray?sig=nope'), ctx('flood'));
  assert.equal(last.status, 429);
  assert.equal((await last.json()).code, 'RATE_LIMITED');
});

test('census/featured: fresh snapshot served from the store; old snapshot + failed refresh -> stale=true; nothing -> 502', async () => {
  const store = await getStore('ox81');
  assert.equal((await censusFn(new Request('http://x/api/census'))).status, 502);

  const snap = buildSnapshot(BLOCK);
  await store.setJSON('census/latest', snap.census);
  await store.setJSON('featured/latest', snap.featured);
  const c = await censusFn(new Request('http://x/api/census'));
  assert.equal(c.status, 200);
  const cj = await c.json();
  assert.equal(cj.stale, false);
  assert.equal(cj.txs.total, 974);
  const f = await featuredFn(new Request('http://x/api/featured'));
  assert.equal(f.status, 200);
  assert.equal((await f.json()).picks[0].kind, 'v1-largest');

  const old = { ...snap.census, generatedAt: new Date(Date.now() - 3600_000).toISOString() };
  await store.setJSON('census/latest', old);
  const s = await (await censusFn(new Request('http://x/api/census'))).json();
  assert.equal(s.stale, true);

  const d = await censusFn(new Request('http://x/api/census?window=24h'));
  assert.equal(d.status, 200);
  const dj = await d.json();
  assert.equal(dj.window, '24h');
  assert.equal(dj.fallback, true);

  assert.equal((await censusFn(new Request('http://x/api/census?window=7d'))).status, 400);
});
