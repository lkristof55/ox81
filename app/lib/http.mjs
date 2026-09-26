// HTTP helpers: error shape, input validation, per-IP rate limit, in-memory TTL cache. Pure except for module state.
import { fromBase58, fromBase64, MAX_TX_V1 } from '../../src/index.ts';

export const STATUS = { BAD_INPUT: 400, NOT_FOUND: 404, DECODE_FAILED: 422, RATE_LIMITED: 429, UPSTREAM: 502, TIMEOUT: 504 };

/** { error, code, at?, partial? } with the matching status. Never a stack trace. */
export function fail(code, error, extra = {}, headers = {}) {
  return Response.json({ error, code, ...extra }, { status: STATUS[code] || 500, headers: { 'cache-control': 'no-store', ...headers } });
}

export function ok(body, cacheSeconds = 0) {
  return Response.json(body, { headers: { 'cache-control': cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store' } });
}

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;

/** A base58 transaction signature: 64-88 chars that decode to exactly 64 bytes. Returns the string or null. */
export function parseSignature(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  if (!SIG_RE.test(t)) return null;
  const b = fromBase58(t);
  return b && b.length === 64 ? t : null;
}

/** Standard base64 of wire bytes, 1..4096 B. Returns { bytes } or { error }. */
export function parseRaw(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'raw must be a non-empty base64 string' };
  if (raw.length > 8192) return { error: `raw is too long: a transaction is at most ${MAX_TX_V1} bytes` };
  const bytes = fromBase64(raw);
  if (!bytes) return { error: 'raw is not valid base64' };
  if (bytes.length === 0) return { error: 'raw decodes to 0 bytes' };
  if (bytes.length > MAX_TX_V1) return { error: `raw decodes to ${bytes.length} bytes; the maximum transaction size is ${MAX_TX_V1}` };
  return { bytes };
}

/** Fixed-window limiter: `limit` requests per `windowMs` per key. */
export function rateLimiter(limit = 30, windowMs = 60_000) {
  const hits = new Map();
  return (key, now = Date.now()) => {
    const k = key || 'unknown';
    let h = hits.get(k);
    if (!h || now - h.start >= windowMs) { h = { start: now, n: 0 }; hits.set(k, h); }
    h.n++;
    if (hits.size > 10_000) for (const [kk, v] of hits) if (now - v.start >= windowMs) hits.delete(kk);
    return h.n <= limit ? { ok: true } : { ok: false, retryAfter: Math.ceil((h.start + windowMs - now) / 1000) };
  };
}

/** Tiny TTL cache with a size cap (oldest evicted first). */
export function ttlCache(ttlMs, max = 500) {
  const m = new Map();
  return {
    get(k, now = Date.now()) {
      const e = m.get(k);
      if (!e) return undefined;
      if (now - e.t > ttlMs) { m.delete(k); return undefined; }
      return e.v;
    },
    set(k, v, now = Date.now()) {
      m.delete(k);
      m.set(k, { v, t: now });
      while (m.size > max) m.delete(m.keys().next().value);
    },
    get size() { return m.size; },
  };
}

export function clientIp(req, context) {
  return context?.ip || req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
}
