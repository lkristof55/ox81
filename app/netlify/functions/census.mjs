// GET /api/census?window=latest|24h -> census snapshot from the store (census-cron). Netlify refreshes it inline when older
// than 600 s; on Cloudflare it is served as stored (stale by block age), or warming=true before the first one exists.
import { fail, ok } from '../../lib/http.mjs';
import { read24h, readFresh } from '../../lib/snapshot.mjs';

export default async (req) => {
  if (req.method !== 'GET') return fail('BAD_INPUT', 'use GET');
  const window = new URL(req.url).searchParams.get('window') || 'latest';
  if (window !== 'latest' && window !== '24h') return fail('BAD_INPUT', "window must be 'latest' or '24h'");
  try {
    const body = window === '24h' ? await read24h() : await readFresh('census/latest');
    if (!body) return fail('UPSTREAM', 'no census snapshot yet');
    return ok({ ...body, window, fallback: !!body.fallback, stale: !!body.stale }, body.warming ? 0 : 120);
  } catch (e) {
    return e.timeout ? fail('TIMEOUT', 'the RPC did not answer within 8 s and no snapshot exists yet') : fail('UPSTREAM', `could not build a census: ${e.message}`);
  }
};

export const config = { path: '/api/census' };
