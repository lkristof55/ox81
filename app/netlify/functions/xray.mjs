// GET /api/xray?sig=<base58>  -> Helius getTransaction (1 credit, cached 1 h) -> ox81.xray(bytes, { meta, loadedAddresses, source: 'rpc' })
// POST /api/xray { raw }     -> pure compute, no RPC:                         ox81.xray(bytes, { source: 'raw' })
import { DecodeError, xray } from '../../../src/index.ts';
import { clientIp, fail, ok, parseRaw, parseSignature, rateLimiter, ttlCache } from '../../lib/http.mjs';
import { getTransaction } from '../../lib/sources.mjs';

const CACHE_SECONDS = 3600;
const cache = ttlCache(CACHE_SECONDS * 1000, 500);
const limit = rateLimiter(30, 60_000);

function decodeFailed(e) {
  return fail('DECODE_FAILED', `could not decode the transaction: ${e.message}`, { at: e.at, partial: e.partial });
}

export default async (req, context) => {
  if (req.method !== 'GET' && req.method !== 'POST') return fail('BAD_INPUT', 'use GET ?sig= or POST { raw }', {}, { allow: 'GET, POST' });
  const rl = limit(clientIp(req, context));
  if (!rl.ok) return fail('RATE_LIMITED', `rate limited: 30 requests per minute, retry in ${rl.retryAfter} s`, {}, { 'retry-after': String(rl.retryAfter) });

  if (req.method === 'POST') {
    const len = Number(req.headers.get('content-length') || 0);
    if (len > 16384) return fail('BAD_INPUT', 'body too large');
    let body;
    try {
      const text = await req.text();
      if (text.length > 16384) return fail('BAD_INPUT', 'body too large');
      body = JSON.parse(text);
    } catch {
      return fail('BAD_INPUT', 'body must be JSON: { "raw": "<base64 transaction>" }');
    }
    const parsed = parseRaw(body?.raw);
    if (parsed.error) return fail('BAD_INPUT', parsed.error);
    try {
      return ok(xray(parsed.bytes, { source: 'raw' }), 0);
    } catch (e) {
      if (e instanceof DecodeError) return decodeFailed(e);
      throw e;
    }
  }

  const url = new URL(req.url);
  const raw = url.searchParams.get('sig');
  if (!raw) return fail('BAD_INPUT', 'missing ?sig= (a base58 transaction signature), or POST { raw } with base64 bytes');
  const sig = parseSignature(raw);
  if (!sig) return fail('BAD_INPUT', 'sig is not a base58 transaction signature (64-88 chars decoding to 64 bytes)');

  const hit = cache.get(sig);
  if (hit) return ok(hit, CACHE_SECONDS);

  let t;
  try {
    t = await getTransaction(sig);
  } catch (e) {
    return e.timeout ? fail('TIMEOUT', 'the RPC did not answer within 8 s') : fail('UPSTREAM', `RPC error: ${e.message}`);
  }
  if (!t) return fail('NOT_FOUND', 'transaction not found: unknown signature, or not yet confirmed');
  let result;
  try {
    result = xray(t.bytes, { meta: t.meta, loadedAddresses: t.loadedAddresses, source: 'rpc' });
  } catch (e) {
    if (e instanceof DecodeError) return decodeFailed(e);
    throw e;
  }
  cache.set(sig, result);
  return ok(result, CACHE_SECONDS);
};

export const config = { path: '/api/xray' };
