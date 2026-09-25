// misread(): closed-form model of what five kinds of pre-v1 reader do with the same bytes.

import { RPC_ERR_UNSUPPORTED_VERSION } from './constants.ts';
import type { DecodedTx, MisreadProfile } from './types.ts';

const fmt = (n: number) => n.toLocaleString('en-US');
const hx = (b: number) => '0x' + b.toString(16).padStart(2, '0');
const none = { claimedSignatures: null, bytesNeeded: null, errorCode: null };

/**
 * What a sig-count-first (legacy/v0) parser sees in a v1 tx: byte 0 = 0x81 has the continuation bit set,
 * so it reads 0x81 0xNN as a compact-u16: 1 + 128 * NN signatures, and needs 2 + 64 * that many bytes.
 */
export function sigCountMisread(tx: DecodedTx): { claimed: number | null; needed: number | null; result: string } {
  const b1 = tx.bytes[1] ?? 0;
  const b2 = tx.bytes[2] ?? 0;
  if (b1 === 0) return { claimed: null, needed: null, result: 'Rejects 0x81 0x00 as a non-canonical compact-u16.' };
  let claimed: number;
  let width: number;
  if (b1 < 0x80) { claimed = 1 + 128 * b1; width = 2; }
  else if (b2 <= 0x03 && b2 !== 0) { claimed = 1 + 128 * (b1 & 0x7f) + 16384 * b2; width = 3; }
  else return { claimed: null, needed: null, result: `Rejects 0x81 ${hx(b1)} ${hx(b2)} as a malformed compact-u16.` };
  const needed = width + 64 * claimed;
  const bytesShown = width === 2 ? `0x81 ${hx(b1)}` : `0x81 ${hx(b1)} ${hx(b2)}`;
  return { claimed, needed, result: `Reads ${bytesShown} as a compact-u16 signature count of ${fmt(claimed)}: needs ${fmt(needed)} B, the transaction is ${fmt(tx.size)} B.` };
}

export function misread(tx: DecodedTx): MisreadProfile[] {
  const v = tx.version;
  const out: MisreadProfile[] = [];
  if (v === 'v1') {
    const m = sigCountMisread(tx);
    const detail = { claimedSignatures: m.claimed, bytesNeeded: m.needed, errorCode: null };
    const fits = m.needed !== null && m.needed <= tx.size;
    out.push({ reader: 'pre-v1-parser', name: 'Legacy/v0 wire parser', ok: false, result: fits ? m.result.replace(': needs', ', then misreads the rest: needs') : m.result, detail });
    out.push({ reader: 'legacy-only-parser', name: 'Legacy-only parser', ok: false, result: m.claimed !== null ? `Same misread: ${fmt(m.claimed)} signatures.` : m.result, detail: { ...detail } });
  } else {
    out.push({ reader: 'pre-v1-parser', name: 'Legacy/v0 wire parser', ok: true, result: 'Parses.', detail: { ...none } });
    out.push(v === 'v0'
      ? { reader: 'legacy-only-parser', name: 'Legacy-only parser', ok: false, result: 'Reads the 0x80 version byte as numRequiredSignatures = 128.', detail: { ...none } }
      : { reader: 'legacy-only-parser', name: 'Legacy-only parser', ok: true, result: 'Parses.', detail: { ...none } });
  }
  out.push({
    reader: 'rpc-no-version-param', name: 'RPC call without maxSupportedTransactionVersion', ok: v === 'legacy',
    result: v === 'legacy' ? 'Returns the transaction.' : `Error ${RPC_ERR_UNSUPPORTED_VERSION}: transaction version not supported by the requesting client.`,
    detail: { ...none, errorCode: v === 'legacy' ? null : RPC_ERR_UNSUPPORTED_VERSION },
  });
  out.push({
    reader: 'rpc-max-version-0', name: 'RPC call with maxSupportedTransactionVersion: 0', ok: v !== 'v1',
    result: v === 'v1' ? `Error ${RPC_ERR_UNSUPPORTED_VERSION}. getBlock fails for the whole block.` : 'Returns the transaction.',
    detail: { ...none, errorCode: v === 'v1' ? RPC_ERR_UNSUPPORTED_VERSION : null },
  });
  out.push({
    reader: 'geyser-versioned-first', name: 'Geyser consumer that checks `versioned` before `config`', ok: v !== 'v1',
    result: v === 'v1' ? 'Labels it v0: `versioned` is true for v0 and v1.' : 'Classified correctly.',
    detail: { ...none },
  });
  return out;
}
