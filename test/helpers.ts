// Test helpers: load fixtures, and build synthetic legacy / v1 transactions byte by byte.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromBase58, fromBase64 } from '../src/codec.ts';
import type { RpcBlockBase64 } from '../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
export const fixture = <T = any>(name: string): T => JSON.parse(readFileSync(join(here, 'fixtures', name), 'utf8'));
export const BLOCK_SLOT = 450355468;
export const block = (): RpcBlockBase64 => fixture<RpcBlockBase64>(`block-${BLOCK_SLOT}.json`);
export const txBytes = (rec: { transaction: [string, string] }) => fromBase64(rec.transaction[0])!;

export const key = (b58: string) => fromBase58(b58)!;
/** A deterministic fake 32-byte key: all bytes = n (n > 0). */
export const fakeKey = (n: number) => new Uint8Array(32).fill(n);
export const CB = key('ComputeBudget111111111111111111111111111111');
export const SYSTEM = new Uint8Array(32);

const u32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const u64 = (v: bigint) => [...u32(Number(v & 0xffffffffn)), ...u32(Number(v >> 32n))];
export const compactU16 = (v: number) => {
  const out: number[] = [];
  for (;;) {
    const b = v & 0x7f;
    v >>= 7;
    if (v === 0) { out.push(b); return out; }
    out.push(b | 0x80);
  }
};

export interface Ix { program: number; accounts: number[]; data: number[] }

export const cbLimit = (v: number): number[] => [2, ...u32(v)];
export const cbPrice = (v: bigint): number[] => [3, ...u64(v)];
export const cbLoaded = (v: number): number[] => [4, ...u32(v)];
export const cbHeap = (v: number): number[] => [1, ...u32(v)];

/** v1 wire bytes (SIMD-0385). `values` are the ConfigValues in ascending bit order, already as bytes. */
export function buildV1(o: {
  header?: [number, number, number];
  mask: number;
  values?: number[];
  addresses: Uint8Array[];
  ixs: Ix[];
  sigs?: number;
  lifetime?: Uint8Array;
}): Uint8Array {
  const [s, rs, ru] = o.header ?? [1, 0, 1];
  const out: number[] = [0x81, s, rs, ru, ...u32(o.mask), ...(o.lifetime ?? fakeKey(7)), o.ixs.length, o.addresses.length];
  for (const a of o.addresses) out.push(...a);
  out.push(...(o.values ?? []));
  for (const ix of o.ixs) out.push(ix.program, ix.accounts.length, ix.data.length & 0xff, ix.data.length >> 8);
  for (const ix of o.ixs) out.push(...ix.accounts, ...ix.data);
  for (let i = 0; i < (o.sigs ?? s); i++) out.push(...new Uint8Array(64).fill(9 + i));
  return Uint8Array.from(out);
}
export const v1Values = { fee: (v: bigint) => u64(v), u32 };

/** legacy (or v0 with `lookups`) wire bytes. */
export function buildLegacy(o: {
  header?: [number, number, number];
  addresses: Uint8Array[];
  ixs: Ix[];
  v0?: boolean;
  lookups?: { table: Uint8Array; writable: number[]; readonly: number[] }[];
}): Uint8Array {
  const [s, rs, ru] = o.header ?? [1, 0, 1];
  const out: number[] = [...compactU16(s)];
  for (let i = 0; i < s; i++) out.push(...new Uint8Array(64).fill(9 + i));
  if (o.v0) out.push(0x80);
  out.push(s, rs, ru, ...compactU16(o.addresses.length));
  for (const a of o.addresses) out.push(...a);
  out.push(...fakeKey(7), ...compactU16(o.ixs.length));
  for (const ix of o.ixs) out.push(ix.program, ...compactU16(ix.accounts.length), ...ix.accounts, ...compactU16(ix.data.length), ...ix.data);
  if (o.v0) {
    const L = o.lookups ?? [];
    out.push(...compactU16(L.length));
    for (const l of L) out.push(...l.table, ...compactU16(l.writable.length), ...l.writable, ...compactU16(l.readonly.length), ...l.readonly);
  }
  return Uint8Array.from(out);
}
