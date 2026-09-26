// Contract client: GET/POST /api/xray, GET /api/census, GET /api/featured (concept.json → api).
const B58 = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

export function classify(q) {
  const s = (q || '').trim();
  if (!s) return { kind: 'empty' };
  if (B58.test(s)) return { kind: 'sig', value: s };
  const b = s.replace(/\s+/g, '');
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(b) && b.length >= 4) return { kind: 'raw', value: b };
  return { kind: 'bad' };
}

async function j(res) {
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    const e = new Error((body && body.error) || `HTTP ${res.status}`);
    e.status = res.status; e.code = (body && body.code) || (res.status === 404 ? 'NOT_FOUND' : res.status === 429 ? 'RATE_LIMITED' : res.status >= 500 ? 'UPSTREAM' : 'BAD_INPUT');
    e.body = body; e.retryAfter = Number(res.headers.get('retry-after')) || null;
    throw e;
  }
  return body;
}

function withTimeout(ms, signal) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(new DOMException('timeout', 'TimeoutError')), ms);
  if (signal) signal.addEventListener('abort', () => c.abort(signal.reason));
  return { signal: c.signal, done: () => clearTimeout(t) };
}

export async function xray(q, { signal } = {}) {
  const c = classify(q);
  if (c.kind === 'empty') { const e = new Error('empty'); e.code = 'EMPTY'; throw e; }
  if (c.kind === 'bad') { const e = new Error('bad input'); e.code = 'BAD_INPUT'; throw e; }
  const to = withTimeout(12000, signal);
  try {
    const res = c.kind === 'sig'
      ? await fetch(`/api/xray?sig=${encodeURIComponent(c.value)}`, { signal: to.signal })
      : await fetch('/api/xray', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raw: c.value }), signal: to.signal });
    return await j(res);
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') { const t = new Error('timeout'); t.code = 'TIMEOUT'; throw t; }
    if (!e.code) e.code = 'UPSTREAM';
    throw e;
  } finally { to.done(); }
}

export async function census(windowName = 'latest') {
  const to = withTimeout(15000);
  try { return await j(await fetch(`/api/census?window=${windowName}`, { signal: to.signal })); } finally { to.done(); }
}

export async function featured() {
  const to = withTimeout(15000);
  try { return await j(await fetch('/api/featured', { signal: to.signal })); } finally { to.done(); }
}

export const fmt = (n) => (n == null ? '–' : Number(n).toLocaleString('en-US'));
export const pct = (x, d = 1) => (x == null ? '–' : (x * 100).toFixed(d));
export const short = (s, a = 6, b = 4) => (s && s.length > a + b + 1 ? `${s.slice(0, a)}…${s.slice(-b)}` : s || '–');
export const utc = (unix) => (unix ? new Date(unix * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '–');
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// What a pre-v1 parser reads from bytes 0..1 of a v1 tx: 0x81 then byte 1 (numRequiredSignatures) as a compact-u16
// signature count. Taken from the xray's own misread result, with the byte from its range list.
export function v1Misread(xr) {
  const m = (xr.misread || []).find((p) => p.reader === 'pre-v1-parser');
  const r1 = xr.ranges && xr.ranges[1];
  const b1 = r1 && r1.field === 'numRequiredSignatures' ? Number(r1.value) : xr.header ? xr.header.numRequiredSignatures : null;
  const claimed = m && m.detail && m.detail.claimedSignatures != null ? m.detail.claimedSignatures : b1 != null && b1 < 128 ? 1 + 128 * b1 : null;
  return {
    b1, b1hex: b1 != null ? '0x' + b1.toString(16).padStart(2, '0') : '0x??', claimed,
    needed: m && m.detail ? m.detail.bytesNeeded : null,
    formula: b1 != null && b1 < 128 ? `1 + 128·${b1}` : null,
  };
}
