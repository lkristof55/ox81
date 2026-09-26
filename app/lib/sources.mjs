// Upstream I/O. One RPC (Helius mainnet, key from env), wrapped around the ox81 library's fetch helpers:
// 8 s timeout per call, retry with backoff on 429/503 (inside ox81 rpc()), no key ever leaves the server.
import { fetchLatestBlock, fetchTransaction, RpcError } from '../../src/index.ts';

export function rpcUrl() {
  if (process.env.SOLANA_RPC_URL) return process.env.SOLANA_RPC_URL;
  if (process.env.HELIUS_API_KEY) return `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
  return null;
}

export class UpstreamError extends Error {
  constructor(message, { timeout = false } = {}) {
    super(message);
    this.timeout = timeout;
  }
}

// Strip anything that could carry the key (URLs) from upstream messages before they reach a client or a log.
const scrub = (m) => String(m || '').replace(/https?:\/\/\S+/g, '<rpc>').replace(/api-key=[^&\s]+/g, 'api-key=<redacted>');

function wrap(e) {
  if (e instanceof RpcError) return new UpstreamError(scrub(e.message), { timeout: e.timeout });
  return new UpstreamError(scrub(e?.message || 'upstream failed'));
}

function requireUrl() {
  const u = rpcUrl();
  if (!u) throw new UpstreamError('no RPC configured (set HELIUS_API_KEY or SOLANA_RPC_URL)');
  return u;
}

/** Helius getTransaction(sig, base64, maxSupportedTransactionVersion 1, confirmed). 1 credit. null = not found. */
export async function getTransaction(sig) {
  const url = requireUrl();
  try {
    return await fetchTransaction(url, sig, { timeoutMs: 8000, retries: 2, commitment: 'confirmed' });
  } catch (e) {
    throw wrap(e);
  }
}

/** Helius getSlot(finalized) + getBlock(tip), falling back to tip-1..tip-5 for skipped slots. 2 credits typical. */
export async function getLatestBlock() {
  const url = requireUrl();
  try {
    return await fetchLatestBlock(url, { timeoutMs: 8000, retries: 2, back: 5 });
  } catch (e) {
    throw wrap(e);
  }
}
