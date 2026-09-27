// GET /api/featured -> real txs from the latest snapshot block (v1-largest, v1-dead-cb, v0-lookups, legacy), each with its xray.
import { fail, ok } from '../../lib/http.mjs';
import { readFresh } from '../../lib/snapshot.mjs';

export default async (req) => {
  if (req.method !== 'GET') return fail('BAD_INPUT', 'use GET');
  try {
    const body = await readFresh('featured/latest');
    if (!body) return fail('UPSTREAM', 'no snapshot yet');
    return ok({ ...body, stale: !!body.stale }, body.warming ? 0 : 300);
  } catch (e) {
    return e.timeout ? fail('TIMEOUT', 'the RPC did not answer within 8 s and no snapshot exists yet') : fail('UPSTREAM', `could not load featured transactions: ${e.message}`);
  }
};

export const config = { path: '/api/featured' };
