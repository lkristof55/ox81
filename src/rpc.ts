// Thin JSON-RPC helpers (fetch only, no keys inside). Always base64 + maxSupportedTransactionVersion: 1.

import { fromBase64 } from './codec.ts';
import type { LoadedAddresses, RpcBlockBase64, RpcTxBase64, TxMeta } from './types.ts';

export class RpcError extends Error {
  /** JSON-RPC error code, when the node answered with one. */
  code: number | null;
  /** HTTP status, when the transport failed. */
  status: number | null;
  timeout: boolean;
  constructor(message: string, code: number | null = null, status: number | null = null, timeout = false) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.status = status;
    this.timeout = timeout;
  }
}

export interface RpcOptions {
  /** Per attempt, default 8000 ms. */
  timeoutMs?: number;
  /** Retries on HTTP 429 / 503, with exponential backoff (honours Retry-After). Default 2. */
  retries?: number;
  fetch?: typeof fetch;
}

let nextId = 1;

export async function rpc<T = unknown>(url: string, method: string, params: unknown[], opts: RpcOptions = {}): Promise<T> {
  const { timeoutMs = 8000, retries = 2 } = opts;
  const f = opts.fetch ?? fetch;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      throw new RpcError(timeout ? `${method} timed out after ${timeoutMs} ms` : `${method} failed: ${err.message}`, null, null, timeout);
    }
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const ra = Number(res.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, ra > 0 ? Math.min(ra * 1000, 5000) : 400 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new RpcError(`${method}: HTTP ${res.status}`, null, res.status);
    let body: { result?: T; error?: { code: number; message: string } };
    try {
      body = await res.json();
    } catch (e) {
      const err = e as Error;
      const timeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      throw new RpcError(timeout ? `${method} timed out after ${timeoutMs} ms` : `${method}: invalid JSON`, null, res.status, timeout);
    }
    if (body.error) throw new RpcError(`${method}: ${body.error.message}`, body.error.code, res.status);
    return body.result as T;
  }
}

/** Map RPC meta to the fields the linter uses. */
export function toTxMeta(slot: number, blockTime: number | null | undefined, meta: RpcTxBase64['meta']): TxMeta | null {
  if (!meta) return null;
  return {
    slot,
    blockTime: blockTime ?? null,
    err: (meta.err as object | null) ?? null,
    fee: meta.fee,
    computeUnitsConsumed: meta.computeUnitsConsumed ?? null,
    costUnits: meta.costUnits ?? null,
  };
}

export interface FetchedTx {
  bytes: Uint8Array;
  meta: TxMeta | null;
  loadedAddresses: LoadedAddresses | null;
  slot: number;
  blockTime: number | null;
}

/** getTransaction(sig, base64, maxSupportedTransactionVersion 1). Resolves null when the node has no such tx. */
export async function fetchTransaction(rpcUrl: string, signature: string, opts: RpcOptions & { commitment?: 'confirmed' | 'finalized' } = {}): Promise<FetchedTx | null> {
  const r = await rpc<(RpcTxBase64 & { slot: number; blockTime: number | null }) | null>(rpcUrl, 'getTransaction', [
    signature,
    { encoding: 'base64', maxSupportedTransactionVersion: 1, commitment: opts.commitment ?? 'confirmed' },
  ], opts);
  if (!r) return null;
  const bytes = fromBase64(r.transaction[0]);
  if (!bytes) throw new RpcError('getTransaction: transaction is not base64');
  return { bytes, meta: toTxMeta(r.slot, r.blockTime, r.meta), loadedAddresses: r.meta?.loadedAddresses ?? null, slot: r.slot, blockTime: r.blockTime ?? null };
}

export async function fetchSlot(rpcUrl: string, commitment: 'confirmed' | 'finalized' = 'finalized', opts: RpcOptions = {}): Promise<number> {
  return rpc<number>(rpcUrl, 'getSlot', [{ commitment }], opts);
}

/** JSON-RPC codes for "no block at this slot" (skipped, or not available / cleaned up). */
export const SKIPPED_SLOT_CODES = new Set([-32007, -32009, -32004]);

/** getBlock(slot, base64, full, no rewards, maxSupportedTransactionVersion 1). Resolves null for a skipped slot. */
export async function fetchBlock(rpcUrl: string, slot: number, opts: RpcOptions = {}): Promise<RpcBlockBase64 | null> {
  try {
    const r = await rpc<Omit<RpcBlockBase64, 'slot'> | null>(rpcUrl, 'getBlock', [
      slot,
      { encoding: 'base64', maxSupportedTransactionVersion: 1, transactionDetails: 'full', rewards: false, commitment: 'finalized' },
    ], { timeoutMs: 15000, ...opts });
    return r ? ({ ...r, slot } as RpcBlockBase64) : null;
  } catch (e) {
    if (e instanceof RpcError && e.code !== null && SKIPPED_SLOT_CODES.has(e.code)) return null;
    throw e;
  }
}

/** The newest finalized block: tries tip, tip-1, ... tip-`back` until one is not skipped. */
export async function fetchLatestBlock(rpcUrl: string, opts: RpcOptions & { back?: number } = {}): Promise<RpcBlockBase64> {
  const tip = await fetchSlot(rpcUrl, 'finalized', opts);
  for (let s = tip; s >= tip - (opts.back ?? 5); s--) {
    const b = await fetchBlock(rpcUrl, s, opts);
    if (b) return b;
  }
  throw new RpcError(`no block in slots ${tip - (opts.back ?? 5)}..${tip}`);
}
