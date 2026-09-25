// Zero-dependency byte codecs: base58, base64, hex, compact-u16. Uint8Array only (no Buffer), so it runs in browsers.

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_MAP = new Int16Array(128).fill(-1);
for (let i = 0; i < B58.length; i++) B58_MAP[B58.charCodeAt(i)] = i;

/** base58 (Bitcoin alphabet) of bytes[start, end). */
export function base58(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let zeros = 0;
  while (start + zeros < end && bytes[start + zeros] === 0) zeros++;
  const size = (((end - start - zeros) * 138) / 100 + 1) | 0;
  const digits = new Uint8Array(size);
  let length = 0;
  for (let i = start + zeros; i < end; i++) {
    let carry = bytes[i];
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 256 * digits[k];
      digits[k] = carry % 58;
      carry = (carry / 58) | 0;
    }
    length = j;
  }
  let it = size - length;
  while (it < size && digits[it] === 0) it++;
  let out = '1'.repeat(zeros);
  for (; it < size; it++) out += B58[digits[it]];
  return out;
}

/** Decode base58; returns null on any character outside the alphabet. */
export function fromBase58(s: string): Uint8Array | null {
  if (s.length === 0) return new Uint8Array(0);
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const size = (((s.length - zeros) * 733) / 1000 + 1) | 0;
  const b256 = new Uint8Array(size);
  let length = 0;
  for (let i = zeros; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const v = c < 128 ? B58_MAP[c] : -1;
    if (v < 0) return null;
    let carry = v;
    let j = 0;
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 58 * b256[k];
      b256[k] = carry % 256;
      carry = (carry / 256) | 0;
    }
    length = j;
  }
  let it = size - length;
  while (it < size && b256[it] === 0) it++;
  const out = new Uint8Array(zeros + (size - it));
  out.set(b256.subarray(it), zeros);
  return out;
}

type B64Static = { fromBase64?: (s: string) => Uint8Array };
type B64Proto = { toBase64?: () => string };

/** Standard base64 -> bytes. Whitespace is stripped and padding is optional. Returns null if not base64. */
export function fromBase64(s: string): Uint8Array | null {
  const clean = s.replace(/[\s]+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  const unpadded = clean.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;
  const padded = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
  const native = (Uint8Array as unknown as B64Static).fromBase64;
  try {
    if (native) return native(padded);
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function toBase64(bytes: Uint8Array): string {
  const native = (bytes as unknown as B64Proto).toBase64;
  if (native) return native.call(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, '0'));

/** Lowercase hex of bytes[start, end). */
export function hex(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = '';
  for (let i = start; i < end; i++) out += HEX[bytes[i]];
  return out;
}

export function hexByte(b: number): string {
  return '0x' + HEX[b & 0xff];
}

/**
 * Read a Solana compact-u16 (short_vec length) at `at`.
 * Returns [value, nextOffset], or a string describing why it is malformed:
 * truncated, longer than 3 bytes, over 0xffff, or a non-canonical (alias) encoding.
 */
export function readCompactU16(bytes: Uint8Array, at: number): [number, number] | string {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const o = at + i;
    if (o >= bytes.length) return 'truncated compact-u16';
    const b = bytes[o];
    value |= (b & 0x7f) << (7 * i);
    if ((b & 0x80) === 0) {
      if (i > 0 && b === 0) return 'non-canonical compact-u16 (trailing zero byte)';
      if (value > 0xffff) return 'compact-u16 over 0xffff';
      return [value, o + 1];
    }
  }
  return 'compact-u16 longer than 3 bytes';
}

export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

/** Equality of a 32-byte slice with a known key. */
export function keyEquals(bytes: Uint8Array, at: number, key: Uint8Array): boolean {
  for (let i = 0; i < 32; i++) if (bytes[at + i] !== key[i]) return false;
  return true;
}
