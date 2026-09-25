// Records the offline test fixtures from mainnet (read-only). Run once:
//   OX81_RPC_URL=https://your-rpc node scripts/record.ts
// Writes test/fixtures/*.json with meta trimmed to what ox81 reads (no log messages).

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchBlock, rpc } from '../src/rpc.ts';
import type { RpcTxBase64 } from '../src/types.ts';

const url = process.env.OX81_RPC_URL;
if (!url) {
  console.error('set OX81_RPC_URL to a mainnet RPC that serves getBlock');
  process.exit(1);
}
const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'fixtures');
await mkdir(out, { recursive: true });

// A finalized block from 2026-09-25 with legacy, v0 and v1 txs (974 txs, 100 of them v1).
const SLOT = Number(process.env.OX81_FIXTURE_SLOT || 450355468);
const SIGS = {
  'tx-v1-dead-cb': 'W81fNLqueZDWx5335CaemPZE2D8EuqAYhwUD47WX5RexigN9BEjGxmZcaoLkFsitubvAY6wYXfi8hnLrPoB7FMz',
  'tx-v0-lookups': '5hHdshyVtQ2XfwXEEZZzc5cwXuXct2bZdxHwqEfo4Hi56nPqBWNyw1n7yLaiczmucYQCMnZVcF4mCRFKi29JamNb',
};

const trimMeta = (m: RpcTxBase64['meta']) => m && {
  err: m.err ?? null,
  fee: m.fee,
  computeUnitsConsumed: m.computeUnitsConsumed ?? null,
  costUnits: m.costUnits ?? null,
  loadedAddresses: m.loadedAddresses ?? { writable: [], readonly: [] },
};

const block = await fetchBlock(url, SLOT, { timeoutMs: 30000 });
if (!block) throw new Error(`slot ${SLOT} has no block`);
const slim = {
  _note: `getBlock(${SLOT}, {encoding:'base64', maxSupportedTransactionVersion:1, transactionDetails:'full', rewards:false}); meta trimmed to err/fee/computeUnitsConsumed/costUnits/loadedAddresses. Recorded ${new Date().toISOString()}.`,
  slot: SLOT,
  blockTime: block.blockTime,
  blockhash: block.blockhash,
  parentSlot: block.parentSlot,
  transactions: block.transactions.map((t) => ({ transaction: t.transaction, meta: trimMeta(t.meta), version: t.version })),
};
await writeFile(join(out, `block-${SLOT}.json`), JSON.stringify(slim));
console.log(`block-${SLOT}.json: ${slim.transactions.length} txs`);

for (const [name, sig] of Object.entries(SIGS)) {
  const r = await rpc<(RpcTxBase64 & { slot: number; blockTime: number | null }) | null>(url, 'getTransaction', [sig, { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  if (!r) { console.log(`${name}: not found`); continue; }
  const rec = { _note: `getTransaction(${sig}, base64, maxSupportedTransactionVersion 1)`, signature: sig, slot: r.slot, blockTime: r.blockTime, version: r.version, transaction: r.transaction, meta: trimMeta(r.meta) };
  await writeFile(join(out, `${name}.json`), JSON.stringify(rec, null, 1));
  console.log(`${name}.json: slot ${r.slot}`);
}
