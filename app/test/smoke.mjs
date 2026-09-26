// Smoke test against a running server: node test/smoke.mjs http://localhost:8888
// One real mainnet request per endpoint. The inputs are live: the signatures come from the newest finalized
// block (via /api/featured), so every run X-rays transactions that landed minutes ago.
const base = process.argv[2] || 'http://localhost:8888';
const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
let featured = null;

function assert(c, msg) { if (!c) throw new Error(msg); }
async function get(path, init) {
  const r = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(30000) });
  const j = await r.json();
  return [r.status, j];
}
function partition(ranges, size) {
  let pos = 0;
  for (const r of ranges) { if (r.start !== pos || r.end <= r.start) return false; pos = r.end; }
  return pos === size;
}
function checkXray(x, source) {
  assert(['legacy', 'v0', 'v1'].includes(x.version), `version ${x.version}`);
  assert(x.source === source, `source ${x.source}`);
  assert(partition(x.ranges, x.size), 'ranges do not partition [0, size)');
  assert(x.misread.length === 5, 'misread must have 5 readers');
  assert(Array.isArray(x.lint) && Array.isArray(x.accounts) && Array.isArray(x.instructions), 'lint/accounts/instructions');
  assert(x.maxSize === (x.version === 'v1' ? 4096 : 1232), 'maxSize');
  if (x.version === 'v1') assert(x.config && x.discriminator?.offset === 0 && x.v1Port === null, 'v1 config/discriminator');
  else assert(x.config === null && x.v1Port && typeof x.v1Port.size === 'number', 'legacy/v0 v1Port');
}
function checkCensus(c, window) {
  assert(c.window === window, `window ${c.window}`);
  assert(c.txs.total > 0 && c.blocks >= 1, 'census has no txs');
  assert(c.versions.legacy + c.versions.v0 + c.versions.v1 === c.txs.total, 'versions do not sum to total');
  assert(c.txs.vote + c.txs.nonVote === c.txs.total, 'vote split');
  assert(c.v1.shareAll >= 0 && c.v1.shareAll <= 1, 'shareAll');
  assert(typeof c.card.line === 'string' && c.card.line.startsWith('v1 = '), 'card line');
  assert(c.slots.last > 450_000_000, 'slot looks wrong');
  const ageMin = (Date.now() / 1000 - c.blockTime.last) / 60;
  assert(ageMin < 30 || c.stale, `newest block is ${ageMin.toFixed(0)} min old and not flagged stale`);
}

const checks = [
  ['GET /api/health', async () => { const [, j] = await get('/api/health'); assert(j.ok, JSON.stringify(j)); }],
  ['GET /api/census (latest, live block)', async () => {
    const [s, c] = await get('/api/census');
    assert(s === 200, `${s} ${JSON.stringify(c)}`);
    checkCensus(c, 'latest');
    return `slot ${c.slots.last}: ${c.card.line}`;
  }],
  ['GET /api/census?window=24h', async () => {
    const [s, c] = await get('/api/census?window=24h');
    assert(s === 200, `${s} ${JSON.stringify(c)}`);
    checkCensus(c, '24h');
    return `${c.blocks} blocks, fallback=${c.fallback}`;
  }],
  ['GET /api/featured', async () => {
    const [s, f] = await get('/api/featured');
    assert(s === 200, `${s} ${JSON.stringify(f)}`);
    assert(f.picks.length >= 1, 'no picks');
    assert(f.picks[0].kind === 'v1-largest' || !f.picks.some((p) => p.version === 'v1'), 'v1-largest must lead when the block has v1');
    for (const p of f.picks) { assert(SIG_RE.test(p.signature), 'pick signature'); checkXray(p.xray, 'rpc'); assert(p.xray.meta?.slot === f.slot, 'pick meta.slot'); }
    featured = f;
    return f.picks.map((p) => `${p.kind} ${p.size} B`).join(', ');
  }],
  ['GET /api/xray?sig=<v1 tx from the newest block>', async () => {
    const pick = featured.picks.find((p) => p.version === 'v1') || featured.picks[0];
    const [s, x] = await get(`/api/xray?sig=${pick.signature}`);
    assert(s === 200, `${s} ${JSON.stringify(x)}`);
    checkXray(x, 'rpc');
    assert(x.signature === pick.signature, 'signature mismatch');
    assert(x.meta && x.meta.slot > 0, 'meta');
    return `${x.version} ${x.size} B, ${x.ranges.length} ranges, lint [${x.lint.map((l) => l.id).join(', ')}]`;
  }],
  ['POST /api/xray { raw } (same bytes, no RPC)', async () => {
    const pick = featured.picks.find((p) => p.version === 'v0') || featured.picks.at(-1);
    const [s, x] = await get('/api/xray', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw: pick.xray.raw }) });
    assert(s === 200, `${s} ${JSON.stringify(x)}`);
    checkXray(x, 'raw');
    assert(JSON.stringify(x.ranges) === JSON.stringify(pick.xray.ranges), 'raw ranges differ from rpc ranges');
    return `${x.version} ${x.size} B`;
  }],
  ['errors: 400 / 404 / 422 carry { error, code }', async () => {
    const [s1, e1] = await get('/api/xray?sig=not-a-signature');
    assert(s1 === 400 && e1.code === 'BAD_INPUT' && e1.error, `bad sig: ${s1}`);
    const fake = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';
    const [s2, e2] = await get(`/api/xray?sig=${fake}`);
    assert(s2 === 404 && e2.code === 'NOT_FOUND', `unknown sig: ${s2}`);
    const [s3, e3] = await get('/api/xray', { method: 'POST', body: JSON.stringify({ raw: 'gQEA' }) });
    assert(s3 === 422 && e3.code === 'DECODE_FAILED' && typeof e3.at === 'number' && e3.partial, `truncated: ${s3}`);
    const [s4, e4] = await get('/api/census?window=1y');
    assert(s4 === 400 && e4.code === 'BAD_INPUT', `bad window: ${s4}`);
  }],
];

let failed = 0;
for (const [name, fn] of checks) {
  const t = Date.now();
  try {
    const note = await fn();
    console.log(`ok   ${name} ${Date.now() - t}ms${note ? `  (${note})` : ''}`);
  } catch (e) {
    failed++;
    console.log(`FAIL ${name}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
