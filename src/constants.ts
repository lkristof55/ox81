// Every number the decoder, linter and census rely on, with its source.
// SIMD-0385 = https://github.com/solana-foundation/solana-improvement-documents/blob/main/proposals/0385-transaction-v1.md
// (field names follow SIMD PR #666: ConfigRequests -> ConfigValues).

/** Byte 0 of every v1 transaction (SIMD-0385 VersionByte). */
export const V1_VERSION_BYTE = 0x81;
/** First message byte of a v0 transaction; sits after the signatures at offset 1 + 64n. */
export const V0_PREFIX = 0x80;

/** Max serialized size of a v1 transaction (SIMD-0385). */
export const MAX_TX_V1 = 4096;
/** Max serialized size of a legacy / v0 transaction (packet data size, 1280 - 48). */
export const MAX_TX_LEGACY = 1232;
/** Max signatures per transaction (SIMD-0385). */
export const MAX_SIGS = 12;
/** Max addresses per v1 transaction, inline only (SIMD-0385). */
export const MAX_ADDRESSES = 64;
/** Max instructions per v1 transaction (SIMD-0385). */
export const MAX_IXS = 64;

/** v1 heap size bounds and step (SIMD-0385 / ComputeBudget RequestHeapFrame rules). */
export const HEAP_MIN = 32768;
export const HEAP_MAX = 262144;
export const HEAP_STEP = 1024;

/**
 * CU a ComputeBudget instruction costs on v1, where it configures nothing but still runs as a no-op.
 * Measured on mainnet: tx W81fNLque… (slot 450355468) has config CU limit 77,597 and its next
 * instruction logs "consumed 1281 of 77447": 77,597 - 77,447 = 150.
 * Also stated in solana-dev-skill references/transactions-v1.md.
 */
export const NOOP_COMPUTE_BUDGET_CU = 150;

/** Cost model: 8 CU per 32 KiB of requested loaded-accounts data (solana-sdk fee-structure calculate_memory_usage_cost). */
export const LOADED_DATA_PAGE = 32768;
export const HEAP_COST = 8;
/** Max loaded accounts data size limit: 64 MiB. */
export const MAX_LOADED_DATA = 67108864;

/** Transaction config mask bits (SIMD-0385 TransactionConfigMask). */
export const CONFIG_BIT_PRIORITY_LO = 0;
export const CONFIG_BIT_PRIORITY_HI = 1;
export const CONFIG_BIT_CU_LIMIT = 2;
export const CONFIG_BIT_LOADED_LIMIT = 3;
export const CONFIG_BIT_HEAP = 4;

/** RPC error code for "transaction version not supported by the requesting client". */
export const RPC_ERR_UNSUPPORTED_VERSION = -32015;

export const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
export const VOTE_PROGRAM = 'Vote111111111111111111111111111111111111111';
