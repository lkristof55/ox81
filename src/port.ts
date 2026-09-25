// v1Port(): the exact size a legacy/v0 tx would have as v1 (closed form; re-signing is not modelled).
//
//   size = 1 + 3 + 4 + 32 + 1 + 1 + 32*A + 4*P + sum over non-ComputeBudget ixs of (4 + nAccounts + dataLen) + 64*S
//
// A = static + lookup-loaded addresses, minus the ComputeBudget address when only ComputeBudget ixs use it.
// P = popcount of {2, 3} U the bits implied by ComputeBudget ixs (price -> 0,1; limit -> 2; loaded -> 3; heap -> 4).
//     Bits 2 and 3 are always set: a v1 tx without them gets 0 CU and 0 loaded bytes. The u64 fee is bits 0+1 = 8 B.
// S = numRequiredSignatures.

import { analyze } from './analyze.ts';
import { MAX_ADDRESSES, MAX_IXS, MAX_TX_V1 } from './constants.ts';
import type { DecodedTx, LoadedAddresses, V1Port } from './types.ts';

const BITS_FOR: Record<string, number[]> = {
  SetComputeUnitPrice: [0, 1],
  SetComputeUnitLimit: [2],
  SetLoadedAccountsDataSizeLimit: [3],
  RequestHeapFrame: [4],
};

export function v1Port(tx: DecodedTx, loaded?: LoadedAddresses | null): V1Port | null {
  if (tx.version === 'v1') return null;
  const a = analyze(tx, loaded);
  const cb = a.computeBudget;
  const rest = a.instructions.filter((i) => !i.computeBudget);
  const bits = new Set([2, 3]);
  for (const i of cb) for (const b of BITS_FOR[i.computeBudget!.kind] ?? []) bits.add(b);
  const cbOnly = cb.length > 0
    && !rest.some((i) => a.computeBudgetIndexes.has(i.programIndex))
    && !a.instructions.some((i) => i.accounts.some((x) => a.computeBudgetIndexes.has(x)));
  const inlined = tx.lookups.reduce((s, L) => s + L.writableIndexes.length + L.readonlyIndexes.length, 0);
  const A = a.accounts.length - (cbOnly ? a.computeBudgetIndexes.size : 0);
  const S = tx.header.numRequiredSignatures;
  const size = 1 + 3 + 4 + 32 + 1 + 1 + 32 * A + 4 * bits.size + rest.reduce((s, i) => s + 4 + i.accounts.length + i.dataLength, 0) + 64 * S;

  const blockers: string[] = [];
  if (size > MAX_TX_V1) blockers.push(`size ${size} B > ${MAX_TX_V1} B`);
  if (A > MAX_ADDRESSES) blockers.push(`${A} addresses > ${MAX_ADDRESSES}`);
  if (rest.length > MAX_IXS) blockers.push(`${rest.length} instructions > ${MAX_IXS}`);
  const keys = a.accounts.map((x) => x.pubkey).filter((k): k is string => !!k);
  if (new Set(keys).size !== keys.length) blockers.push('duplicate address');

  return {
    size,
    fits: blockers.length === 0,
    addresses: A,
    removedComputeBudgetIxs: cb.length,
    configBits: [...bits].sort((x, y) => x - y),
    inlinedLookupAddresses: inlined,
    bytesDelta: size - tx.size,
    blockers,
  };
}
