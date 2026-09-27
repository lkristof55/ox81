// Scheduled every 10 min: getSlot(finalized) + getBlock(tip, falls back to tip-1..tip-5) -> census + featured -> store.
// 2 Helius calls per run (288/day). Locally: npm run dev -- --cron.
// Split mode (Cloudflare Workers Free: CF_FREE_PLAN=1 or CENSUS_TXS_PER_RUN > 0): each run does one step of one block
// (fetch it, scan one page, or publish), so no run decodes a whole block; see lib/snapshot.mjs advanceSnapshot().
import { advanceSnapshot, cronBudget, refreshSnapshot } from '../../lib/snapshot.mjs';

export default async () => {
  try {
    const budget = cronBudget();
    if (budget.txsPerRun) {
      console.log(`census-cron: ${(await advanceSnapshot(budget)).note}`);
    } else {
      const snap = await refreshSnapshot();
      console.log(`census-cron: slot ${snap.featured.slot}, ${snap.census.txs.total} txs, ${snap.census.card.line}`);
    }
  } catch (e) {
    console.error(`census-cron failed: ${e.message}`);
  }
  return new Response(null, { status: 204 });
};

export const config = { schedule: '*/10 * * * *' };
