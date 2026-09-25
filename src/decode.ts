// sniff() and decode(): one pass over the wire bytes. Every field read pushes a ByteRange, so the
// ranges partition [0, size) with no gaps or overlaps. Only structural failures throw.

import { base58, hex, hexByte, readCompactU16 } from './codec.ts';
import { V0_PREFIX, V1_VERSION_BYTE } from './constants.ts';
import type { ByteRange, DecodedTx, Field, Group, Header, Lookup, RawInstruction, V1Config, Version } from './types.ts';

export class DecodeError extends Error {
  /** Byte offset where the walk failed. */
  at: number;
  /** What was decoded before the failure. */
  partial: { version: Version | null; ranges: ByteRange[] };
  constructor(message: string, at: number, partial: { version: Version | null; ranges: ByteRange[] }) {
    super(message);
    this.name = 'DecodeError';
    this.at = at;
    this.partial = partial;
  }
}

/**
 * Which wire format is this? O(1) for v1 (byte 0 is 0x81). For legacy/v0 it reads the compact-u16
 * signature count n, skips 64n bytes and looks at the message's first byte: 0x80 = v0, high bit clear = legacy.
 */
export function sniff(bytes: Uint8Array): { version: Version; discriminatorOffset: number | null } {
  const partial = { version: null, ranges: [] };
  if (bytes.length === 0) throw new DecodeError('empty transaction', 0, partial);
  if (bytes[0] === V1_VERSION_BYTE) return { version: 'v1', discriminatorOffset: 0 };
  const r = readCompactU16(bytes, 0);
  if (typeof r === 'string') throw new DecodeError(r + ' (signature count)', 0, partial);
  const at = r[1] + 64 * r[0];
  if (at >= bytes.length) throw new DecodeError(`truncated: ${r[0]} signatures need ${at + 1} B, have ${bytes.length}`, bytes.length, partial);
  const b = bytes[at];
  if (b & 0x80) {
    if (b === V0_PREFIX) return { version: 'v0', discriminatorOffset: at };
    throw new DecodeError(`unknown version byte ${hexByte(b)} at offset ${at}`, at, partial);
  }
  return { version: 'legacy', discriminatorOffset: null };
}

const preview = (bytes: Uint8Array, s: number, e: number) => hex(bytes, s, Math.min(e, s + 16)) + (e - s > 16 ? '…' : '');
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

/** Walk the transaction once. Throws DecodeError only on truncation, trailing bytes, a malformed compact-u16 or an unknown version byte. */
export function decode(bytes: Uint8Array): DecodedTx {
  const size = bytes.length;
  const ranges: ByteRange[] = [];
  let version: Version | null = null;

  const fail = (message: string, at: number): never => {
    throw new DecodeError(message, at, { version, ranges: ranges.slice() });
  };
  const need = (at: number, n: number, what: string) => {
    if (at + n > size) fail(`truncated: ${what} needs ${n} B at offset ${at}, ${Math.max(0, size - at)} left`, at);
  };
  const push = (start: number, end: number, field: Field, group: Group, label: string, value: string | null, index?: number, ix?: number) => {
    if (end <= start) return;
    const r: ByteRange = { start, end, field, group, label, value };
    if (index !== undefined) r.index = index;
    if (ix !== undefined) r.ix = ix;
    ranges.push(r);
  };
  const cu16 = (at: number, field: Field, group: Group, label: string, index?: number, ix?: number): [number, number] => {
    const r = readCompactU16(bytes, at);
    if (typeof r === 'string') return fail(`${r} (${label}) at offset ${at}`, at);
    push(at, r[1], field, group, label, String(r[0]), index, ix);
    return r;
  };

  if (size === 0) fail('empty transaction', 0);

  const addresses: string[] = [];
  const addressOffsets: number[] = [];
  const instructions: RawInstruction[] = [];
  const lookups: Lookup[] = [];
  const signatures: string[] = [];
  let header: Header;
  let config: V1Config | null = null;
  let discriminatorOffset: number | null = null;
  let o = 0;

  const readAddresses = (n: number) => {
    need(o, 32 * n, `${n} addresses`);
    for (let i = 0; i < n; i++) {
      const k = base58(bytes, o, o + 32);
      addresses.push(k);
      addressOffsets.push(o);
      push(o, o + 32, 'address', 'address', `address[${i}]`, k, i);
      o += 32;
    }
  };
  const readSignatures = (n: number) => {
    need(o, 64 * n, `${n} signatures`);
    for (let j = 0; j < n; j++) {
      const s = base58(bytes, o, o + 64);
      signatures.push(s);
      push(o, o + 64, 'signature', 'signature', `signature[${j}]`, s, j);
      o += 64;
    }
  };
  const readHeader = (at: number): Header => {
    need(at, 3, 'message header');
    push(at, at + 1, 'numRequiredSignatures', 'header', 'required signatures', String(bytes[at]));
    push(at + 1, at + 2, 'numReadonlySigned', 'header', 'readonly signed', String(bytes[at + 1]));
    push(at + 2, at + 3, 'numReadonlyUnsigned', 'header', 'readonly unsigned', String(bytes[at + 2]));
    return { numRequiredSignatures: bytes[at], numReadonlySigned: bytes[at + 1], numReadonlyUnsigned: bytes[at + 2] };
  };

  if (bytes[0] === V1_VERSION_BYTE) {
    // ---- v1 (SIMD-0385): fixed offsets up to the addresses, signatures at the tail ----
    version = 'v1';
    discriminatorOffset = 0;
    push(0, 1, 'version', 'version', 'version byte', '0x81');
    header = readHeader(1);
    need(4, 4, 'config mask');
    const mask = u32le(bytes, 4);
    const maskHex = '0x' + mask.toString(16).padStart(8, '0');
    push(4, 8, 'configMask', 'config', 'config mask', maskHex);
    need(8, 32, 'lifetime specifier');
    push(8, 40, 'lifetimeSpecifier', 'lifetime', 'lifetime specifier (blockhash)', base58(bytes, 8, 40));
    need(40, 2, 'instruction and address counts');
    const nIx = bytes[40];
    const nAddr = bytes[41];
    push(40, 41, 'numInstructions', 'count', 'instructions', String(nIx));
    push(41, 42, 'numAddresses', 'count', 'addresses', String(nAddr));
    o = 42;
    readAddresses(nAddr);

    const bits: number[] = [];
    for (let b = 0; b < 32; b++) if ((mask >>> b) & 1) bits.push(b);
    config = { mask, maskHex, bits, priorityFeeLamports: null, computeUnitLimit: null, loadedAccountsDataSizeLimit: null, heapSize: null };
    const both = bits.includes(0) && bits.includes(1);
    for (const b of bits) {
      if (b === 1 && both) continue; // consumed together with bit 0
      if (b === 0 && both) {
        need(o, 8, 'priority fee (u64)');
        const v = ((BigInt(u32le(bytes, o + 4)) << 32n) | BigInt(u32le(bytes, o))).toString();
        config.priorityFeeLamports = v;
        push(o, o + 8, 'configPriorityFee', 'config', 'priority fee (lamports, u64)', v);
        o += 8;
        continue;
      }
      need(o, 4, `config value for bit ${b}`);
      const v = u32le(bytes, o);
      if (b <= 1) push(o, o + 4, 'configPriorityFee', 'config', 'priority fee (half, invalid)', String(v));
      else if (b === 2) { config.computeUnitLimit = v; push(o, o + 4, 'configComputeUnitLimit', 'config', 'compute unit limit', String(v)); }
      else if (b === 3) { config.loadedAccountsDataSizeLimit = v; push(o, o + 4, 'configLoadedAccountsDataSizeLimit', 'config', 'loaded accounts data size limit', String(v)); }
      else if (b === 4) { config.heapSize = v; push(o, o + 4, 'configHeapSize', 'config', 'heap size', String(v)); }
      else push(o, o + 4, 'configUnknown', 'config', `unknown config bit ${b}`, String(v), b);
      o += 4;
    }

    need(o, 4 * nIx, `${nIx} instruction headers`);
    const hdrs: [number, number, number][] = [];
    for (let j = 0; j < nIx; j++) {
      const p = bytes[o], na = bytes[o + 1], nd = u16le(bytes, o + 2);
      hdrs.push([p, na, nd]);
      push(o, o + 4, 'ixHeader', 'instruction', `ix ${j} header`, `program=${p} accounts=${na} data=${nd}`, undefined, j);
      o += 4;
    }
    for (let j = 0; j < nIx; j++) {
      const [p, na, nd] = hdrs[j];
      need(o, na, `ix ${j} account indexes`);
      const accounts = Array.from(bytes.subarray(o, o + na));
      push(o, o + na, 'ixAccounts', 'instruction', `ix ${j} account indexes`, accounts.join(','), undefined, j);
      o += na;
      need(o, nd, `ix ${j} data`);
      push(o, o + nd, 'ixData', 'instruction', `ix ${j} data (${nd} B)`, preview(bytes, o, o + nd), undefined, j);
      instructions.push({ index: j, programIndex: p, accounts, dataStart: o, dataLength: nd });
      o += nd;
    }
    readSignatures(header.numRequiredSignatures);
  } else {
    // ---- legacy / v0: compact-u16 signature count first ----
    const [nSig, s1] = cu16(0, 'numSignatures', 'count', 'signatures');
    o = s1;
    readSignatures(nSig);
    need(o, 1, 'message');
    const first = bytes[o];
    if (first & 0x80) {
      if (first !== V0_PREFIX) fail(`unknown version byte ${hexByte(first)} at offset ${o}`, o);
      version = 'v0';
      discriminatorOffset = o;
      push(o, o + 1, 'version', 'version', 'version byte', '0x80');
      o += 1;
    } else version = 'legacy';
    header = readHeader(o);
    o += 3;
    const [nAddr, a1] = cu16(o, 'numAddresses', 'count', 'addresses');
    o = a1;
    readAddresses(nAddr);
    need(o, 32, 'recent blockhash');
    push(o, o + 32, 'recentBlockhash', 'lifetime', 'recent blockhash', base58(bytes, o, o + 32));
    o += 32;
    const [nIx, i1] = cu16(o, 'numInstructions', 'count', 'instructions');
    o = i1;
    for (let j = 0; j < nIx; j++) {
      need(o, 1, `ix ${j} program index`);
      const p = bytes[o];
      push(o, o + 1, 'ixProgramIndex', 'instruction', `ix ${j} program index`, String(p), undefined, j);
      o += 1;
      const [na, n1] = cu16(o, 'ixNumAccounts', 'instruction', `ix ${j} account count`, undefined, j);
      o = n1;
      need(o, na, `ix ${j} account indexes`);
      const accounts = Array.from(bytes.subarray(o, o + na));
      push(o, o + na, 'ixAccounts', 'instruction', `ix ${j} account indexes`, accounts.join(','), undefined, j);
      o += na;
      const [nd, d1] = cu16(o, 'ixDataLength', 'instruction', `ix ${j} data length`, undefined, j);
      o = d1;
      need(o, nd, `ix ${j} data`);
      push(o, o + nd, 'ixData', 'instruction', `ix ${j} data (${nd} B)`, preview(bytes, o, o + nd), undefined, j);
      instructions.push({ index: j, programIndex: p, accounts, dataStart: o, dataLength: nd });
      o += nd;
    }
    if (version === 'v0') {
      const [nL, l1] = cu16(o, 'numLookups', 'count', 'lookup tables');
      o = l1;
      for (let j = 0; j < nL; j++) {
        need(o, 32, `lookup ${j} table address`);
        const table = base58(bytes, o, o + 32);
        push(o, o + 32, 'lookupTable', 'lookup', `lookup[${j}] table`, table, j);
        o += 32;
        const [nw, w1] = cu16(o, 'lookupNumWritable', 'lookup', `lookup[${j}] writable count`, j);
        o = w1;
        need(o, nw, `lookup ${j} writable indexes`);
        const writableIndexes = Array.from(bytes.subarray(o, o + nw));
        push(o, o + nw, 'lookupWritable', 'lookup', `lookup[${j}] writable indexes`, writableIndexes.join(','), j);
        o += nw;
        const [nr, r1] = cu16(o, 'lookupNumReadonly', 'lookup', `lookup[${j}] readonly count`, j);
        o = r1;
        need(o, nr, `lookup ${j} readonly indexes`);
        const readonlyIndexes = Array.from(bytes.subarray(o, o + nr));
        push(o, o + nr, 'lookupReadonly', 'lookup', `lookup[${j}] readonly indexes`, readonlyIndexes.join(','), j);
        o += nr;
        lookups.push({ index: j, table, writableIndexes, readonlyIndexes });
      }
    }
  }

  if (o !== size) fail(`trailing bytes: the ${version} walk ended at offset ${o}, the transaction is ${size} B`, o);

  return { version: version as Version, size, bytes, discriminatorOffset, header, config, addresses, addressOffsets, lookups, instructions, signatures, ranges };
}

/** The byte partition: sorted, contiguous ranges covering [0, size). */
export function byteMap(tx: DecodedTx): ByteRange[] {
  return tx.ranges;
}

/** Assert the partition invariant; returns an error string or null. */
export function checkPartition(ranges: ByteRange[], size: number): string | null {
  let pos = 0;
  for (const r of ranges) {
    if (r.start !== pos) return `gap or overlap at ${pos} (next range starts at ${r.start})`;
    if (r.end <= r.start) return `empty range at ${r.start}`;
    pos = r.end;
  }
  return pos === size ? null : `ranges end at ${pos}, size is ${size}`;
}
