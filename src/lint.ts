// lint(): pure predicates over a decoded tx (+ optional RPC meta). Every finding points back at byte ranges.

import { analyze } from './analyze.ts';
import {
  COMPUTE_BUDGET_PROGRAM, HEAP_COST, HEAP_MAX, HEAP_MIN, HEAP_STEP, LOADED_DATA_PAGE, MAX_ADDRESSES, MAX_IXS,
  MAX_LOADED_DATA, MAX_SIGS, MAX_TX_LEGACY, MAX_TX_V1, NOOP_COMPUTE_BUDGET_CU,
} from './constants.ts';
import type { DecodedTx, Field, Instruction, LintFinding, LintId, LoadedAddresses, TxMeta } from './types.ts';

const fmt = (n: number) => n.toLocaleString('en-US');
const SEVERITY_ORDER = { error: 0, warn: 1, info: 2 } as const;

export function lint(tx: DecodedTx, meta?: TxMeta | null, loaded?: LoadedAddresses | null): LintFinding[] {
  const a = analyze(tx, loaded);
  const out: LintFinding[] = [];
  const add = (id: LintId, severity: LintFinding['severity'], title: string, detail: string, ranges: [number, number][] = [], cu: number | null = null, bytes: number | null = null) =>
    out.push({ id, severity, title, detail, ranges, cu, bytes });
  const ixRanges = (ixs: Instruction[]): [number, number][] => {
    const set = new Set(ixs.map((i) => i.index));
    return tx.ranges.filter((r) => r.ix !== undefined && set.has(r.ix)).map((r) => [r.start, r.end]);
  };
  const fieldRanges = (field: Field): [number, number][] => tx.ranges.filter((r) => r.field === field).map((r) => [r.start, r.end]);
  const MASK: [number, number][] = [[4, 8]];
  const cb = a.computeBudget;
  const cbOf = (kind: string) => cb.find((i) => i.computeBudget?.kind === kind);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

  let loadedLimit: number | null = null;
  let cuLimit: number | null = null;
  let cuLimitRanges: [number, number][] = [];

  if (tx.version === 'v1') {
    const cfg = tx.config!;
    const bits = new Set(cfg.bits);
    cuLimit = cfg.computeUnitLimit;
    cuLimitRanges = fieldRanges('configComputeUnitLimit');
    loadedLimit = cfg.loadedAccountsDataSizeLimit;

    if (cb.length) {
      const usedElse = a.instructions.some((i) => i.programId !== COMPUTE_BUDGET_PROGRAM && a.computeBudgetIndexes.has(i.programIndex))
        || a.instructions.some((i) => i.accounts.some((x) => a.computeBudgetIndexes.has(x)));
      const bytes = cb.reduce((s, i) => s + 4 + i.accounts.length + i.dataLength, 0) + (usedElse ? 0 : 32 * a.computeBudgetIndexes.size);
      const ranges = ixRanges(cb);
      if (!usedElse) for (const r of tx.ranges) if (r.field === 'address' && a.computeBudgetIndexes.has(r.index!)) ranges.push([r.start, r.end]);
      ranges.sort((x, y) => x[0] - y[0]);
      const applies = (kind: string | undefined): string => {
        switch (kind) {
          case 'SetComputeUnitLimit': return `config computeUnitLimit = ${cfg.computeUnitLimit ?? '0 (bit 2 unset)'}`;
          case 'SetComputeUnitPrice': return `config priority fee = ${cfg.priorityFeeLamports ?? '0 (bits 0+1 unset)'} lamports`;
          case 'SetLoadedAccountsDataSizeLimit': return `config loadedAccountsDataSizeLimit = ${cfg.loadedAccountsDataSizeLimit ?? '0 (bit 3 unset)'}`;
          case 'RequestHeapFrame': return `config heapSize = ${cfg.heapSize ?? '32768 (bit 4 unset)'}`;
          default: return 'no config equivalent';
        }
      };
      const asks = cb.map((i) => `ix ${i.index} ${i.computeBudget!.kind}(${i.computeBudget!.value ?? ''}) -> ${applies(i.computeBudget!.kind)}`);
      add('V1_DEAD_COMPUTE_BUDGET', 'warn', `${plural(cb.length, 'dead ComputeBudget instruction')}`,
        `v1 ignores ComputeBudget instructions for configuration (SIMD-0385) but still runs each one as a no-op (${NOOP_COMPUTE_BUDGET_CU} CU each). ${asks.join('; ')}.`,
        ranges, NOOP_COMPUTE_BUDGET_CU * cb.length, bytes);
    }

    const price = cbOf('SetComputeUnitPrice');
    if (price && (cfg.priorityFeeLamports === null || cfg.priorityFeeLamports === '0')) {
      add('V1_PRIORITY_ONLY_IN_IX', 'warn', 'Priority fee set only in a dead instruction',
        `SetComputeUnitPrice(${price.computeBudget!.value ?? '?'} micro-lamports/CU) does nothing on v1. The config ${cfg.priorityFeeLamports === null ? 'has no priority fee (bits 0+1 unset)' : 'sets 0 lamports'}, so this transaction bids 0 priority.`,
        [...ixRanges([price]), ...(cfg.priorityFeeLamports === null ? MASK : fieldRanges('configPriorityFee'))].sort((x, y) => x[0] - y[0]));
    }
    if (!bits.has(2)) add('V1_CU_LIMIT_ABSENT', 'error', 'No compute unit limit', 'Config bit 2 is unset, so the requested compute unit limit is 0 (SIMD-0385).', MASK);
    else if (cfg.computeUnitLimit === 0) add('V1_CU_LIMIT_ZERO', 'error', 'Compute unit limit is 0', 'The config requests 0 compute units.', cuLimitRanges);
    if (!bits.has(3)) add('V1_LOADED_LIMIT_ABSENT', 'error', 'No loaded-accounts data limit', 'Config bit 3 is unset, so the loaded accounts data size limit is 0 (SIMD-0385), unlike the 64 MiB legacy/v0 default. The transaction cannot load account data.', MASK);
    if (bits.has(0) !== bits.has(1)) add('V1_PRIORITY_HALF_MASK', 'error', 'Priority fee uses one bit of two', 'Bits 0 and 1 must both be set or both unset; this transaction is invalid (SIMD-0385).', MASK);
    const unknown = cfg.bits.filter((b) => b >= 5);
    if (unknown.length) add('V1_UNKNOWN_CONFIG_BITS', 'error', 'Unknown config bits', `Bits ${unknown.join(', ')} are not assigned by SIMD-0385 and must be 0.`, [...MASK, ...fieldRanges('configUnknown')]);
    const heap = cfg.heapSize;
    if (heap !== null && (heap % HEAP_STEP !== 0 || heap < HEAP_MIN || heap > HEAP_MAX))
      add('V1_HEAP_INVALID', 'error', 'Heap size out of range', `${fmt(heap)} is not a multiple of ${HEAP_STEP} in [${HEAP_MIN}, ${HEAP_MAX}].`, fieldRanges('configHeapSize'));
    if (tx.size > MAX_TX_LEGACY && tx.size <= MAX_TX_V1)
      add('SIZE_OVER_1232', 'info', `${fmt(tx.size)} B: only possible as v1`, 'Legacy and v0 cap at 1,232 B. Submit as base64; base58 submission is capped at 1,232 B.');

    // SIMD-0385 sanitization rules not covered above
    const h = tx.header;
    const nAddr = tx.addresses.length;
    const sanitize: string[] = [];
    if (tx.size > MAX_TX_V1) sanitize.push(`size ${fmt(tx.size)} B > ${fmt(MAX_TX_V1)} B`);
    if (h.numRequiredSignatures > MAX_SIGS) sanitize.push(`${h.numRequiredSignatures} signatures > ${MAX_SIGS}`);
    if (h.numRequiredSignatures === 0) sanitize.push('0 required signatures (no fee payer)');
    if (nAddr > MAX_ADDRESSES) sanitize.push(`${nAddr} addresses > ${MAX_ADDRESSES}`);
    if (tx.instructions.length > MAX_IXS) sanitize.push(`${tx.instructions.length} instructions > ${MAX_IXS}`);
    if (h.numRequiredSignatures > 0 && h.numReadonlySigned >= h.numRequiredSignatures) sanitize.push(`numReadonlySigned ${h.numReadonlySigned} >= numRequiredSignatures ${h.numRequiredSignatures}`);
    if (nAddr < h.numRequiredSignatures + h.numReadonlyUnsigned) sanitize.push(`numAddresses ${nAddr} < numRequiredSignatures + numReadonlyUnsigned (${h.numRequiredSignatures + h.numReadonlyUnsigned})`);
    for (const ix of tx.instructions) {
      if (ix.programIndex === 0) sanitize.push(`ix ${ix.index} program index 0 is the fee payer`);
      else if (ix.programIndex >= nAddr) sanitize.push(`ix ${ix.index} program index ${ix.programIndex} >= numAddresses ${nAddr}`);
      const bad = ix.accounts.find((x) => x >= nAddr);
      if (bad !== undefined) sanitize.push(`ix ${ix.index} account index ${bad} >= numAddresses ${nAddr}`);
    }
    for (const rule of sanitize) add('V1_SANITIZE', 'error', 'Fails v1 sanitization', `${rule} (SIMD-0385).`);
  } else {
    const limIx = cbOf('SetComputeUnitLimit');
    if (limIx?.computeBudget?.value) { cuLimit = Number(limIx.computeBudget.value); cuLimitRanges = ixRanges([limIx]); }
    const ldIx = cbOf('SetLoadedAccountsDataSizeLimit');
    if (ldIx?.computeBudget?.value) loadedLimit = Number(ldIx.computeBudget.value);
    if (cb.length)
      add('LEGACY_BUDGET_IXS', 'info', plural(cb.length, 'ComputeBudget instruction'),
        `On v1 these move into the 4-byte config values and the instructions are dropped (each would otherwise run as a ${NOOP_COMPUTE_BUDGET_CU} CU no-op).`,
        ixRanges(cb), NOOP_COMPUTE_BUDGET_CU * cb.length, null);
    if (tx.lookups.length) {
      const k = tx.lookups.reduce((s, L) => s + L.writableIndexes.length + L.readonlyIndexes.length, 0);
      add('V0_LOOKUPS', 'info', `${plural(k, 'address')} via ${plural(tx.lookups.length, 'lookup table')}`,
        'v1 has no address lookup tables: a v1 port inlines each address (+31 B each: 32 B inline instead of a 1 B index).',
        tx.ranges.filter((r) => r.group === 'lookup').map((r) => [r.start, r.end]), null, 31 * k);
    }
    if (tx.size > MAX_TX_LEGACY)
      add('SIZE_OVER_LIMIT', 'error', `${fmt(tx.size)} B: over the ${tx.version} limit`, `Legacy and v0 transactions cap at ${fmt(MAX_TX_LEGACY)} B; only v1 allows up to ${fmt(MAX_TX_V1)} B.`);
  }

  if (loadedLimit !== null && loadedLimit >= MAX_LOADED_DATA) {
    const cu = Math.ceil(loadedLimit / LOADED_DATA_PAGE) * HEAP_COST;
    const rr = tx.version === 'v1' ? fieldRanges('configLoadedAccountsDataSizeLimit') : ixRanges([cbOf('SetLoadedAccountsDataSizeLimit')!]);
    add('LOADED_LIMIT_MAX', 'info', 'Loaded-accounts limit at the 64 MiB maximum',
      `Requests ${fmt(loadedLimit)} B. Per the Agave cost model the pre-execution estimate charges ${HEAP_COST} CU per 32 KiB requested: ${fmt(cu)} CU reserved.`, rr, cu, null);
  }

  const seen = new Map<string, number>();
  const dups: string[] = [];
  const pubkeys = a.accounts.map((x) => x.pubkey);
  pubkeys.forEach((k, i) => { if (!k) return; if (seen.has(k)) dups.push(k); else seen.set(k, i); });
  if (dups.length) {
    const rr = tx.ranges.filter((r) => r.field === 'address' && dups.includes(r.value!)).map((r): [number, number] => [r.start, r.end]);
    add('DUPLICATE_ADDRESS', tx.version === 'v1' ? 'error' : 'info', 'Duplicate address',
      `${dups[0]} appears more than once${dups.length > 1 ? ` (${dups.length} duplicates)` : ''}. ${tx.version === 'v1' ? 'v1 sanitization rejects this.' : 'Allowed here, rejected by v1.'}`, rr);
  }

  const used = meta?.computeUnitsConsumed ?? null;
  if (cuLimit && used && used > 0 && cuLimit >= 4 * used)
    add('CU_OVERASK', 'info', `Asked ${(cuLimit / used).toFixed(1)}x the compute it used`, `Requested ${fmt(cuLimit)} CU, consumed ${fmt(used)}.`, cuLimitRanges, cuLimit - used, null);

  return out
    .map((f, i) => [f, i] as const)
    .sort((x, y) => SEVERITY_ORDER[x[0].severity] - SEVERITY_ORDER[y[0].severity] || x[1] - y[1])
    .map(([f]) => f);
}
