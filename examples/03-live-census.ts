// Mainnet: census of the newest finalized block (read-only getSlot + getBlock, ~3-4 MB).
//   OX81_RPC_URL=https://your-rpc node examples/03-live-census.ts
import { census, fetchLatestBlock } from '../src/index.ts';

const rpc = process.env.OX81_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const block = await fetchLatestBlock(rpc, { timeoutMs: 20000 });
const c = census([block]);

console.log(`slot ${block.slot} · ${c.txs.total} txs · legacy ${c.versions.legacy} / v0 ${c.versions.v0} / v1 ${c.versions.v1}`);
console.log(c.card.line);
console.log(`dead ComputeBudget ixs: ${c.v1.deadComputeBudget.ixs} (${c.v1.deadComputeBudget.cu} CU of no-ops) in ${c.v1.deadComputeBudget.txs} v1 txs`);
