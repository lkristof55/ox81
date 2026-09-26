// GET /api/health — liveness, which keys the backend can see (names only, never values), and the token mint once it exists.
const B58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export default async () => Response.json({
  ok: true,
  project: 'ox81',
  time: new Date().toISOString(),
  keys: { helius: !!process.env.HELIUS_API_KEY, birdeye: !!process.env.BIRDEYE_API_KEY },
  // null before launch (the site shows the CA as "soon"); the mint address after TOKEN_MINT is set.
  tokenMint: B58.test(process.env.TOKEN_MINT || '') ? process.env.TOKEN_MINT : null,
});

export const config = { path: '/api/health' };
