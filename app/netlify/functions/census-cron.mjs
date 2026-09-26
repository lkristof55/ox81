// Scheduled every 10 min: getSlot(finalized) + getBlock(tip, falls back to tip-1..tip-5) -> census + featured -> Blobs.
// 2 Helius calls per run (288/day). Locally: npm run dev -- --cron.
import { refreshSnapshot } from '../../lib/snapshot.mjs';

export default async () => {
  try {
    const snap = await refreshSnapshot();
    console.log(`census-cron: slot ${snap.featured.slot}, ${snap.census.txs.total} txs, ${snap.census.card.line}`);
  } catch (e) {
    console.error(`census-cron failed: ${e.message}`);
  }
  return new Response(null, { status: 204 });
};

export const config = { schedule: '*/10 * * * *' };
