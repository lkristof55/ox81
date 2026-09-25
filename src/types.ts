// Public types. Every shape here is also the JSON the Ox81 site's /api/* endpoints return.

export type Version = 'legacy' | 'v0' | 'v1';

/** 9 fixed groups; every byte of a transaction belongs to exactly one. */
export type Group = 'version' | 'header' | 'config' | 'lifetime' | 'count' | 'address' | 'instruction' | 'lookup' | 'signature';

export type Field =
  // shared
  | 'version' | 'numRequiredSignatures' | 'numReadonlySigned' | 'numReadonlyUnsigned'
  | 'numInstructions' | 'numAddresses' | 'address' | 'ixData' | 'ixAccounts' | 'signature'
  // v1
  | 'configMask' | 'lifetimeSpecifier' | 'configPriorityFee' | 'configComputeUnitLimit'
  | 'configLoadedAccountsDataSizeLimit' | 'configHeapSize' | 'configUnknown' | 'ixHeader'
  // legacy / v0
  | 'numSignatures' | 'recentBlockhash' | 'ixProgramIndex' | 'ixNumAccounts' | 'ixDataLength'
  | 'numLookups' | 'lookupTable' | 'lookupNumWritable' | 'lookupWritable' | 'lookupNumReadonly' | 'lookupReadonly';

/** One field's bytes: [start, end). A decoded tx's ranges partition [0, size) exactly. */
export interface ByteRange {
  start: number;
  end: number;
  field: Field;
  group: Group;
  label: string;
  /** Short display value: '0x81', '1', base58, or a hex preview (first 16 B + '…'). */
  value: string | null;
  /** Address / signature / lookup index, or the config bit for configUnknown. */
  index?: number;
  /** Instruction index for ix* fields. */
  ix?: number;
}

export interface Header {
  numRequiredSignatures: number;
  numReadonlySigned: number;
  numReadonlyUnsigned: number;
}

/** v1 TransactionConfig. null = bit not set (SIMD-0385 minimums apply: fee 0, CU 0, loaded 0, heap 32768). */
export interface V1Config {
  mask: number;
  maskHex: string;
  bits: number[];
  /** u64 decimal, total lamports; null unless bits 0 and 1 are both set. */
  priorityFeeLamports: string | null;
  computeUnitLimit: number | null;
  loadedAccountsDataSizeLimit: number | null;
  heapSize: number | null;
}

export interface Lookup {
  index: number;
  table: string;
  writableIndexes: number[];
  readonlyIndexes: number[];
}

/** An instruction as it sits on the wire (indexes, not keys). */
export interface RawInstruction {
  index: number;
  programIndex: number;
  accounts: number[];
  /** Byte offset and length of the data inside the tx bytes. */
  dataStart: number;
  dataLength: number;
}

/** Output of decode(): the byte partition plus the parsed structure. */
export interface DecodedTx {
  version: Version;
  size: number;
  bytes: Uint8Array;
  /** v1: 0; v0: 1 + 64n; legacy: null. */
  discriminatorOffset: number | null;
  header: Header;
  config: V1Config | null;
  /** Static (inline) addresses, base58. */
  addresses: string[];
  /** Byte offset of each static address. */
  addressOffsets: number[];
  lookups: Lookup[];
  instructions: RawInstruction[];
  signatures: string[];
  ranges: ByteRange[];
}

export type ComputeBudgetKind =
  | 'RequestUnitsDeprecated' | 'RequestHeapFrame' | 'SetComputeUnitLimit'
  | 'SetComputeUnitPrice' | 'SetLoadedAccountsDataSizeLimit' | 'Unknown';

export interface Account {
  index: number;
  /** null only for lookup-loaded accounts when the resolved addresses are unknown (raw bytes). */
  pubkey: string | null;
  signer: boolean;
  /** Per header + lookup section; runtime demotions (reserved keys, programs) are not applied. */
  writable: boolean;
  source: 'static' | 'lookup';
  lookupIndex: number | null;
  label: string | null;
}

export interface Instruction {
  index: number;
  programIndex: number;
  programId: string | null;
  program: string | null;
  accounts: number[];
  dataLength: number;
  dataHex: string;
  computeBudget: null | { kind: ComputeBudgetKind; value: string | null };
  /** true iff the tx is v1 and the program is ComputeBudget (it runs as a 150 CU no-op). */
  deadOnV1: boolean;
}

export type LintId =
  | 'V1_DEAD_COMPUTE_BUDGET' | 'V1_PRIORITY_ONLY_IN_IX' | 'V1_CU_LIMIT_ABSENT' | 'V1_CU_LIMIT_ZERO'
  | 'V1_LOADED_LIMIT_ABSENT' | 'V1_PRIORITY_HALF_MASK' | 'V1_UNKNOWN_CONFIG_BITS' | 'V1_HEAP_INVALID'
  | 'SIZE_OVER_1232' | 'LOADED_LIMIT_MAX' | 'CU_OVERASK' | 'LEGACY_BUDGET_IXS' | 'V0_LOOKUPS'
  | 'DUPLICATE_ADDRESS' | 'V1_SANITIZE' | 'SIZE_OVER_LIMIT';

export interface LintFinding {
  id: LintId;
  severity: 'error' | 'warn' | 'info';
  title: string;
  detail: string;
  /** Byte spans to highlight, [start, end). */
  ranges: [number, number][];
  /** CU attributed to the finding. */
  cu: number | null;
  /** Bytes attributed to the finding. */
  bytes: number | null;
}

export type ReaderId = 'pre-v1-parser' | 'legacy-only-parser' | 'rpc-no-version-param' | 'rpc-max-version-0' | 'geyser-versioned-first';

export interface MisreadProfile {
  reader: ReaderId;
  name: string;
  ok: boolean;
  result: string;
  detail: { claimedSignatures: number | null; bytesNeeded: number | null; errorCode: number | null };
}

export interface V1Port {
  size: number;
  fits: boolean;
  addresses: number;
  removedComputeBudgetIxs: number;
  configBits: number[];
  inlinedLookupAddresses: number;
  bytesDelta: number;
  blockers: string[];
}

/** The parts of RPC meta the linter uses. */
export interface TxMeta {
  slot: number;
  blockTime: number | null;
  err: object | null;
  fee: number;
  computeUnitsConsumed: number | null;
  costUnits: number | null;
}

export interface LoadedAddresses {
  writable: string[];
  readonly: string[];
}

export interface XrayResult {
  signature: string | null;
  source: 'rpc' | 'raw';
  version: Version;
  size: number;
  maxSize: 1232 | 4096;
  discriminator: null | { offset: number; hex: '0x80' | '0x81' };
  header: Header;
  config: V1Config | null;
  accounts: Account[];
  lookups: Lookup[];
  instructions: Instruction[];
  signatures: string[];
  raw: string;
  ranges: ByteRange[];
  lint: LintFinding[];
  misread: MisreadProfile[];
  v1Port: V1Port | null;
  meta: TxMeta | null;
}

/** One transaction of a getBlock / getTransaction response with encoding 'base64'. */
export interface RpcTxBase64 {
  transaction: [string, 'base64'] | [string, string];
  meta: {
    err: object | null;
    fee: number;
    computeUnitsConsumed?: number | null;
    costUnits?: number | null;
    loadedAddresses?: LoadedAddresses | null;
    [k: string]: unknown;
  } | null;
  version?: 'legacy' | number;
}

/** getBlock(slot, { encoding: 'base64', maxSupportedTransactionVersion: 1, transactionDetails: 'full' }) + the slot. */
export interface RpcBlockBase64 {
  slot: number;
  blockTime: number | null;
  transactions: RpcTxBase64[];
  [k: string]: unknown;
}

export interface CensusMask { mask: number; bits: number[]; count: number }

export interface CensusResult {
  window: 'latest' | '24h' | string;
  fallback: boolean;
  stale: boolean;
  generatedAt: string;
  blocks: number;
  slots: { first: number; last: number };
  blockTime: { first: number; last: number };
  txs: { total: number; vote: number; nonVote: number };
  versions: { legacy: number; v0: number; v1: number };
  versionsNonVote: { legacy: number; v0: number; v1: number };
  v1: {
    count: number;
    shareAll: number;
    shareNonVote: number;
    over1232: number;
    deadComputeBudget: { txs: number; ixs: number; cu: number; failedTxs: number; share: number; examples: string[] };
    priorityOnlyInIx: number;
    loadedLimitMax: number;
    cuLimitAbsent: number;
    loadedLimitAbsent: number;
    cuOveraskMedian: number | null;
    masks: CensusMask[];
    size: { p50: number; p90: number; max: number };
  };
  v0: { count: number; withLookups: number };
  /** Transactions the decoder could not walk (should stay 0; any other value is a bug report). */
  undecodable: number;
  card: { line: string };
}

export type FeaturedKind = 'v1-largest' | 'v1-dead-cb' | 'v0-lookups' | 'legacy';

export interface FeaturedPick {
  kind: FeaturedKind;
  signature: string;
  version: Version;
  size: number;
  xray: XrayResult;
}
