// Resolve a decoded tx into accounts and instructions (program ids, ComputeBudget payloads).

import { hex } from './codec.ts';
import { COMPUTE_BUDGET_PROGRAM, VOTE_PROGRAM } from './constants.ts';
import type { Account, ComputeBudgetKind, DecodedTx, Instruction, LoadedAddresses } from './types.ts';

/** Well-known program labels (display only). */
export const PROGRAM_LABELS: Record<string, string> = {
  '11111111111111111111111111111111': 'System',
  [COMPUTE_BUDGET_PROGRAM]: 'ComputeBudget',
  [VOTE_PROGRAM]: 'Vote',
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: 'Token',
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: 'Token-2022',
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: 'AssociatedToken',
  MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr: 'Memo',
  Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo: 'Memo v1',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter v6',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P': 'pump.fun',
  pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA: 'PumpSwap',
  AddressLookupTab1e1111111111111111111111111: 'AddressLookupTable',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium AMM v4',
  CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK: 'Raydium CLMM',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca Whirlpool',
  LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo: 'Meteora DLMM',
};

const CB_KINDS: ComputeBudgetKind[] = ['RequestUnitsDeprecated', 'RequestHeapFrame', 'SetComputeUnitLimit', 'SetComputeUnitPrice', 'SetLoadedAccountsDataSizeLimit'];

/** Parse a ComputeBudget instruction's data (discriminator byte + LE payload). */
export function parseComputeBudget(data: Uint8Array): { kind: ComputeBudgetKind; value: string | null } {
  if (data.length === 0) return { kind: 'Unknown', value: null };
  const d = data[0];
  const kind = CB_KINDS[d] ?? 'Unknown';
  let value: string | null = null;
  const u32 = (o: number) => (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24)) >>> 0;
  if ((d === 1 || d === 2 || d === 4) && data.length >= 5) value = String(u32(1));
  if (d === 3 && data.length >= 9) value = ((BigInt(u32(5)) << 32n) | BigInt(u32(1))).toString();
  return { kind, value };
}

export interface Analysis {
  accounts: Account[];
  instructions: Instruction[];
  /** Instructions whose program is ComputeBudget. */
  computeBudget: Instruction[];
  /** Account indexes that hold the ComputeBudget program id. */
  computeBudgetIndexes: Set<number>;
  isVote: boolean;
}

const cache = new WeakMap<DecodedTx, Analysis>();

/** Accounts (static, then lookup writable, then lookup readonly) and resolved instructions. Memoized per tx when `loaded` is omitted. */
export function analyze(tx: DecodedTx, loaded?: LoadedAddresses | null): Analysis {
  if (!loaded) {
    const hit = cache.get(tx);
    if (hit) return hit;
  }
  const { numRequiredSignatures: ns, numReadonlySigned: nrs, numReadonlyUnsigned: nru } = tx.header;
  const n = tx.addresses.length;
  const accounts: Account[] = tx.addresses.map((pubkey, index) => {
    const signer = index < ns;
    const writable = signer ? index < ns - nrs : index < n - nru;
    return { index, pubkey, signer, writable, source: 'static', lookupIndex: null, label: PROGRAM_LABELS[pubkey] ?? null };
  });
  if (tx.lookups.length) {
    const lw = loaded?.writable ?? [];
    const lr = loaded?.readonly ?? [];
    let idx = n, c = 0;
    for (const L of tx.lookups) for (let k = 0; k < L.writableIndexes.length; k++, c++) {
      const pubkey = lw[c] ?? null;
      accounts.push({ index: idx++, pubkey, signer: false, writable: true, source: 'lookup', lookupIndex: L.index, label: pubkey ? PROGRAM_LABELS[pubkey] ?? null : null });
    }
    c = 0;
    for (const L of tx.lookups) for (let k = 0; k < L.readonlyIndexes.length; k++, c++) {
      const pubkey = lr[c] ?? null;
      accounts.push({ index: idx++, pubkey, signer: false, writable: false, source: 'lookup', lookupIndex: L.index, label: pubkey ? PROGRAM_LABELS[pubkey] ?? null : null });
    }
  }
  const computeBudgetIndexes = new Set<number>();
  accounts.forEach((a) => { if (a.pubkey === COMPUTE_BUDGET_PROGRAM) computeBudgetIndexes.add(a.index); });
  let isVote = false;
  const instructions: Instruction[] = tx.instructions.map((ix) => {
    const programId = accounts[ix.programIndex]?.pubkey ?? null;
    const data = tx.bytes.subarray(ix.dataStart, ix.dataStart + ix.dataLength);
    const isCb = programId === COMPUTE_BUDGET_PROGRAM;
    if (programId === VOTE_PROGRAM) isVote = true;
    return {
      index: ix.index,
      programIndex: ix.programIndex,
      programId,
      program: programId ? PROGRAM_LABELS[programId] ?? null : null,
      accounts: ix.accounts,
      dataLength: ix.dataLength,
      dataHex: hex(data),
      computeBudget: isCb ? parseComputeBudget(data) : null,
      deadOnV1: tx.version === 'v1' && isCb,
    };
  });
  const out: Analysis = { accounts, instructions, computeBudget: instructions.filter((i) => i.computeBudget), computeBudgetIndexes, isVote };
  if (!loaded) cache.set(tx, out);
  return out;
}
