// Offline tests for the Cloudflare target: the D1 store backend (against test/d1-fake.mjs, Node's built-in SQLite
// behind D1's API), worker.mjs routing, and scheduled() running census-cron, whole-block and split (free plan).
// The RPC is a stub that serves the recorded block, so nothing here reaches the network.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

delete process.env.HELIUS_API_KEY;
delete process.env.CF_FREE_PLAN;
delete process.env.CENSUS_TXS_PER_RUN;
process.env.SOLANA_RPC_URL = 'https://rpc.invalid/';

const { fakeD1 } = await import('./d1-fake.mjs');
const { getStore, useD1, useStoreDir, D1_MAX_VALUE_BYTES } = await import('../lib/store.mjs');
const { buildSnapshot, cronBudget, pageTxs, slimTx, FREE_PLAN_TXS_PER_RUN } = await import('../lib/snapshot.mjs');
const worker = (await import('../worker.mjs')).default;
const { ROUTES, SCHEDULED } = await import('../worker.mjs');

const FIX = new URL('../../test/fixtures/', import.meta.url);
const fixture = (n) => JSON.parse(readFileSync(new URL(n, FIX), 'utf8'));
const V1 = fixture('tx-v1-dead-cb.json');

// ---------------------------------------------------------------- RPC stub (getSlot + getBlock of the recorded block)
const rpcCalls = [];
function stubRpc(block) {
  rpcCalls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    rpcCalls.push({ url: String(url), method: body.method, acceptEncoding: init.headers?.['accept-encoding'] ?? null });
    if (body.method === 'getSlot') return Response.json({ jsonrpc: '2.0', id: body.id, result: block.slot });
    if (body.method === 'getBlock') {
      if (body.params[0] !== block.slot) return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32007, message: 'skipped' } });
      const { _note, slot, ...rest } = block;
      return Response.json({ jsonrpc: '2.0', id: body.id, result: rest });
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no such method in the stub' } });
  };
}
/** The recorded block, re-stamped as just finalized so the 24 h window keeps it. */
function freshBlock() {
  const b = fixture('block-450355468.json');
  b.blockTime = Math.floor(Date.now() / 1000) - 20;
  return b;
}
const envWith = (db) => {
  const assets = [];
  return { env: { DB: db, ASSETS: { fetch: async (req) => { assets.push(new URL(req.url).pathname); return new Response('asset', { status: 200 }); } } }, assets };
};
const ctx = { waitUntil() {} };
const call = (env, path, init) => worker.fetch(new Request(`https://ox81.test${path}`, init), env, ctx);
const cron = (env) => worker.scheduled({ cron: '*/10 * * * *', scheduledTime: Date.now() }, env, ctx);
const noGen = (o) => ({ ...o, generatedAt: null, stale: null });

// ---------------------------------------------------------------- D1 store

async function storeScenario(s) {
  const out = {};
  out.missing = await s.get('nope');
  await s.setJSON('a/1', { n: 1, t: 'ünïcødé ✓', arr: [1, null, 'x'] });
  out.roundTrip = await s.get('a/1');
  await s.setJSON('a/1', { n: 2 });
  out.overwritten = await s.get('a/1');
  for (const k of ['a/2', 'a%/x', 'a_/y', 'ab', 'b/1', 'a/', 'a/%']) await s.setJSON(k, k);
  const keys = async (prefix) => (await s.list({ prefix })).blobs.map((b) => b.key).sort();
  out.all = await keys('');
  out.a = await keys('a/');
  out.percent = await keys('a%');
  out.underscore = await keys('a_');
  out.pctInside = await keys('a/%');
  out.none = await keys('zzz');
  await s.delete('a/2');
  await s.delete('never-existed');
  out.deleted = await s.get('a/2');
  out.afterDelete = await keys('a/');
  return out;
}

test('D1 store: get / setJSON / delete / list({ prefix }) behave exactly like the file store', async () => {
  useD1(null);
  useStoreDir(mkdtempSync(join(tmpdir(), 'ox81-cf-')));
  const files = await storeScenario(await getStore('scenario'));
  const db = fakeD1();
  useD1(db);
  const d1 = await storeScenario(await getStore('scenario'));
  assert.deepEqual(d1, files);
  assert.equal(d1.missing, null);
  assert.deepEqual(d1.percent, ['a%/x']);        // % is a literal, not a wildcard
  assert.deepEqual(d1.underscore, ['a_/y']);     // so is _
  assert.deepEqual(d1.pctInside, ['a/%']);
  assert.deepEqual(d1.a, ['a/', 'a/%', 'a/1', 'a/2']);
  // stores are separate namespaces in one table
  await (await getStore('other')).setJSON('a/1', 'other');
  assert.deepEqual(await (await getStore('scenario')).get('a/1'), { n: 2 });
  assert.equal(await (await getStore('other')).get('a/1'), 'other');
  assert.deepEqual((await (await getStore('other')).list()).blobs, [{ key: 'a/1' }]);
  useD1(null);
});

test('D1 store refuses a value over the 2 MB row cap instead of truncating it', async () => {
  useD1(fakeD1());
  const s = await getStore('big');
  await s.setJSON('ok', 'x'.repeat(D1_MAX_VALUE_BYTES - 2));
  assert.equal((await s.get('ok')).length, D1_MAX_VALUE_BYTES - 2);
  await assert.rejects(s.setJSON('too-big', 'x'.repeat(D1_MAX_VALUE_BYTES)), /2 MB/);
  await assert.rejects(s.setJSON('too-big-utf8', 'é'.repeat(D1_MAX_VALUE_BYTES / 2)), /2 MB/);
  assert.equal(await s.get('too-big'), null);
  useD1(null);
});

test('split pages stay in block order, under the tx budget and far under the row cap', () => {
  const block = fixture('block-450355468.json');
  const pages = pageTxs(block.transactions, 100);
  assert.equal(pages.length, 10);
  assert.deepEqual(pages.flat(), block.transactions);
  assert.ok(pages.every((p) => p.length <= 100));
  const huge = Array.from({ length: 400 }, (_, i) => ({ transaction: ['A'.repeat(5464), 'base64'], meta: { loadedAddresses: { writable: Array(128).fill('x'.repeat(44)), readonly: Array(128).fill('y'.repeat(44)) } }, i }));
  const hp = pageTxs(huge, 1000);
  assert.ok(hp.length > 1);
  for (const p of hp) assert.ok(JSON.stringify(p).length < 1_000_000, 'page over 1 MB');
});

test('cron budget: whole block by default, split under CF_FREE_PLAN=1, CENSUS_TXS_PER_RUN wins', () => {
  assert.deepEqual(cronBudget({}), { txsPerRun: 0, identity: false });
  assert.deepEqual(cronBudget({ CF_FREE_PLAN: '0' }), { txsPerRun: 0, identity: false });
  assert.deepEqual(cronBudget({ CF_FREE_PLAN: '1' }), { txsPerRun: FREE_PLAN_TXS_PER_RUN, identity: true });
  assert.deepEqual(cronBudget({ CF_FREE_PLAN: '1', CENSUS_TXS_PER_RUN: '40' }), { txsPerRun: 40, identity: true });
  assert.deepEqual(cronBudget({ CENSUS_TXS_PER_RUN: '0', CF_FREE_PLAN: '1' }), { txsPerRun: 0, identity: true });
  assert.deepEqual(cronBudget({ CENSUS_TXS_PER_RUN: 'abc' }), { txsPerRun: 0, identity: false });
});

// ---------------------------------------------------------------- worker routing

test('worker: every function path reaches its handler, everything else goes to ASSETS', async () => {
  assert.deepEqual(ROUTES.map((r) => r.path).sort(), ['/api/census', '/api/featured', '/api/health', '/api/xray']);
  assert.equal(SCHEDULED.length, 1);
  const { env, assets } = envWith(fakeD1());

  const h = await call(env, '/api/health');
  assert.equal(h.status, 200);
  const hj = await h.json();
  assert.equal(hj.ok, true);
  assert.equal(hj.project, 'ox81');

  // nothing stored yet: same shape, no numbers, warming=true, never cached
  const c = await call(env, '/api/census');
  assert.equal(c.status, 200);
  assert.equal(c.headers.get('cache-control'), 'no-store');
  const cj = await c.json();
  assert.equal(cj.warming, true);
  assert.equal(cj.window, 'latest');
  assert.equal(cj.txs.total, 0);
  assert.ok(cj.v1 && cj.versions && cj.card);
  const d = await (await call(env, '/api/census?window=24h')).json();
  assert.equal(d.warming, true);
  assert.equal(d.window, '24h');
  assert.equal(d.fallback, false);
  const f = await (await call(env, '/api/featured/')).json();   // trailing slash, as scripts/dev.mjs allows
  assert.equal(f.warming, true);
  assert.deepEqual(f.picks, []);
  assert.equal((await call(env, '/api/census?window=7d')).status, 400);

  assert.equal((await call(env, '/api/xray?sig=nope')).status, 400);
  const x = await call(env, '/api/xray', { method: 'POST', body: JSON.stringify({ raw: V1.transaction[0] }) });
  assert.equal(x.status, 200);
  assert.equal((await x.json()).source, 'raw');

  for (const p of ['/', '/index.html', '/og.png', '/api/nope', '/api', '/apix/census', '/api/census/extra']) {
    const r = await call(env, p);
    assert.equal(await r.text(), 'asset', p);
  }
  assert.deepEqual(assets, ['/', '/index.html', '/og.png', '/api/nope', '/api', '/apix/census', '/api/census/extra']);
});

test('worker: the rate limit keys on cf-connecting-ip', async () => {
  const { env } = envWith(fakeD1());
  const hit = (ip) => call(env, '/api/xray?sig=nope', { headers: { 'cf-connecting-ip': ip } });
  let last;
  for (let i = 0; i < 31; i++) last = await hit('203.0.113.7');
  assert.equal(last.status, 429);
  assert.equal((await hit('203.0.113.8')).status, 400);
});

// ---------------------------------------------------------------- scheduled()

test('scheduled(): census-cron reads the whole block (no budget) and the endpoints serve it from D1', async () => {
  const block = freshBlock();
  stubRpc(block);
  const { env } = envWith(fakeD1());
  await cron(env);
  assert.deepEqual(rpcCalls.map((c) => c.method), ['getSlot', 'getBlock']);
  assert.equal(rpcCalls[1].acceptEncoding, null);
  const ref = buildSnapshot(block);

  const cj = await (await call(env, '/api/census')).json();
  assert.equal(cj.warming, undefined);
  assert.equal(cj.stale, false);
  assert.deepEqual(noGen(cj), noGen({ ...ref.census, fallback: false }));
  const fj = await (await call(env, '/api/featured')).json();
  assert.deepEqual(noGen(fj), noGen(ref.featured));
  const dj = await (await call(env, '/api/census?window=24h')).json();
  assert.equal(dj.window, '24h');
  assert.equal(dj.blocks, 1);
  assert.equal(dj.txs.total, 974);

  // the endpoints never refresh: an hour-old block is served as stale, with no RPC call
  rpcCalls.length = 0;
  const store = await getStore('ox81');
  await store.setJSON('census/latest', { ...ref.census, blockTime: { first: block.blockTime - 3600, last: block.blockTime - 3600 } });
  const old = await (await call(env, '/api/census')).json();
  assert.equal(old.stale, true);
  assert.equal(old.txs.total, 974);
  assert.equal(rpcCalls.length, 0);
});

for (const perRun of [100, 333, 1000]) {
  test(`scheduled() split mode (${perRun} txs per run): same census and featured picks as one whole-block run`, async () => {
    const block = freshBlock();
    stubRpc(block);
    process.env.CF_FREE_PLAN = '1';
    process.env.CENSUS_TXS_PER_RUN = String(perRun);
    try {
      const db = fakeD1();
      const { env } = envWith(db);
      const pages = pageTxs(block.transactions.map(slimTx), perRun).length;
      assert.ok(pages >= Math.ceil(974 / perRun));
      for (let run = 1; run <= pages + 1; run++) {
        await cron(env);
        assert.equal((await (await call(env, '/api/census')).json()).warming, true, `published early, run ${run}`);
      }
      // only the first step talks to the RPC, uncompressed
      assert.deepEqual(rpcCalls.map((c) => c.method), ['getSlot', 'getBlock']);
      assert.ok(rpcCalls.every((c) => c.acceptEncoding === 'identity'));
      await cron(env);  // publish
      const ref = buildSnapshot(block);
      const cj = await (await call(env, '/api/census')).json();
      assert.deepEqual(noGen(cj), noGen({ ...ref.census, fallback: false }));
      const fj = await (await call(env, '/api/featured')).json();
      assert.deepEqual(noGen(fj), noGen(ref.featured));
      assert.deepEqual(fj.picks.map((p) => p.kind), ['v1-largest', 'v1-dead-cb', 'v0-lookups', 'legacy']);
      // the work rows are gone; the next run fetches a new block
      assert.deepEqual((await (await getStore('ox81')).list({ prefix: 'census/work' })).blobs, []);
      await cron(env);
      assert.equal(rpcCalls.filter((c) => c.method === 'getSlot').length, 2);
    } finally {
      delete process.env.CF_FREE_PLAN;
      delete process.env.CENSUS_TXS_PER_RUN;
    }
  });
}

test('split mode: a step that does not finish twice drops the block, and the next run starts a new one', async () => {
  const block = freshBlock();
  stubRpc(block);
  process.env.CENSUS_TXS_PER_RUN = '500';
  try {
    const { env } = envWith(fakeD1());
    await cron(env);                                   // fetch: 2 pages
    const store = await getStore('ox81');
    const work = await store.get('census/work');
    assert.equal(work.pages, 2);
    // two runs that died in page 1 (the marker was written, the step never completed)
    await store.setJSON('census/work', { ...work, attempt: { step: 0, n: 2 } });
    await cron(env);
    assert.equal(await store.get('census/work'), null);
    assert.deepEqual((await store.list({ prefix: 'census/work/' })).blobs, []);
    await cron(env);                                   // starts over
    assert.equal((await store.get('census/work')).next, 0);
    assert.equal(rpcCalls.filter((c) => c.method === 'getBlock').length, 2);
  } finally {
    delete process.env.CENSUS_TXS_PER_RUN;
  }
});
