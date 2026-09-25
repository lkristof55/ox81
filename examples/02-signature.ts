// Mainnet: X-ray any transaction by signature (read-only getTransaction).
//   OX81_RPC_URL=https://your-rpc node examples/02-signature.ts <signature>
import { fetchTransaction, xray } from '../src/index.ts';

const rpc = process.env.OX81_RPC_URL ?? 'https://api.mainnet-beta.solana.com';
const sig = process.argv[2] ?? 'W81fNLqueZDWx5335CaemPZE2D8EuqAYhwUD47WX5RexigN9BEjGxmZcaoLkFsitubvAY6wYXfi8hnLrPoB7FMz';

const t = await fetchTransaction(rpc, sig);
if (!t) throw new Error('not found (unknown or not yet confirmed)');
const x = xray(t.bytes, { meta: t.meta, loadedAddresses: t.loadedAddresses, source: 'rpc' });

console.log(`${x.version} · ${x.size} B · slot ${x.meta?.slot} · ${x.ranges.length} byte ranges`);
if (x.config) console.log(`bid: ${x.config.priorityFeeLamports ?? 0} lamports priority, CU limit ${x.config.computeUnitLimit ?? 0}, used ${x.meta?.computeUnitsConsumed}`);
for (const f of x.lint) console.log(`  ${f.severity.padEnd(5)} ${f.id} ${f.cu !== null ? `(${f.cu} CU)` : ''}`);
if (x.v1Port) console.log(`as v1 it would be ${x.v1Port.size} B (${x.v1Port.bytesDelta >= 0 ? '+' : ''}${x.v1Port.bytesDelta})`);
