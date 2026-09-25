// xray(): decode + resolve + lint + misread + v1Port in one call. The result is plain JSON.

import { analyze } from './analyze.ts';
import { toBase64 } from './codec.ts';
import { MAX_TX_LEGACY, MAX_TX_V1 } from './constants.ts';
import { decode } from './decode.ts';
import { lint } from './lint.ts';
import { misread } from './misread.ts';
import { v1Port } from './port.ts';
import type { DecodedTx, LoadedAddresses, TxMeta, XrayResult } from './types.ts';

export interface XrayOptions {
  meta?: TxMeta | null;
  /** Addresses resolved from lookup tables (RPC meta.loadedAddresses). Without them lookup-loaded pubkeys are null. */
  loadedAddresses?: LoadedAddresses | null;
  source?: 'rpc' | 'raw';
}

export function xray(input: Uint8Array | DecodedTx, opts: XrayOptions = {}): XrayResult {
  const tx = input instanceof Uint8Array ? decode(input) : input;
  const loaded = opts.loadedAddresses && (opts.loadedAddresses.writable?.length || opts.loadedAddresses.readonly?.length) ? opts.loadedAddresses : null;
  const a = analyze(tx, loaded);
  return {
    signature: tx.signatures[0] ?? null,
    source: opts.source ?? 'raw',
    version: tx.version,
    size: tx.size,
    maxSize: tx.version === 'v1' ? MAX_TX_V1 : MAX_TX_LEGACY,
    discriminator: tx.version === 'v1' ? { offset: 0, hex: '0x81' } : tx.version === 'v0' ? { offset: tx.discriminatorOffset!, hex: '0x80' } : null,
    header: { ...tx.header },
    config: tx.config ? { ...tx.config, bits: [...tx.config.bits] } : null,
    accounts: a.accounts,
    lookups: tx.lookups,
    instructions: a.instructions,
    signatures: tx.signatures,
    raw: toBase64(tx.bytes),
    ranges: tx.ranges,
    lint: lint(tx, opts.meta ?? null, loaded),
    misread: misread(tx),
    v1Port: v1Port(tx, loaded),
    meta: opts.meta ?? null,
  };
}
