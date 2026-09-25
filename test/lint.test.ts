import assert from 'node:assert/strict';
import test from 'node:test';
import { decode } from '../src/decode.ts';
import { lint } from '../src/lint.ts';
import { toTxMeta } from '../src/rpc.ts';
import { buildLegacy, buildV1, CB, cbHeap, cbLimit, cbLoaded, cbPrice, fakeKey, fixture, SYSTEM, txBytes, v1Values } from './helpers.ts';

const ids = (f: { id: string }[]) => f.map((x) => x.id).sort();
const transfer = { program: 1, accounts: [0, 2], data: [2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0] };

test('real v1 tx with a dead SetComputeUnitLimit: 150 CU, 48 B, highlighted ranges', () => {
  const rec = fixture('tx-v1-dead-cb.json');
  const f = lint(decode(txBytes(rec)), toTxMeta(rec.slot, rec.blockTime, rec.meta));
  assert.deepEqual(ids(f), ['CU_OVERASK', 'SIZE_OVER_1232', 'V1_DEAD_COMPUTE_BUDGET']);
  const dead = f.find((x) => x.id === 'V1_DEAD_COMPUTE_BUDGET')!;
  assert.equal(dead.cu, 150);
  assert.equal(dead.bytes, 48); // 4 header + 12 data + 32 for the ComputeBudget address only this ix uses
  assert.deepEqual(dead.ranges, [[2026, 2058], [2074, 2078], [2086, 2098]]);
  const over = f.find((x) => x.id === 'CU_OVERASK')!;
  assert.equal(over.cu, 77597 - 1431);
});

test('real v0 tx: ComputeBudget ixs and lookup tables become v1 port notes', () => {
  const f = lint(decode(txBytes(fixture('tx-v0-lookups.json'))));
  const byId = Object.fromEntries(f.map((x) => [x.id, x]));
  assert.equal(byId.LEGACY_BUDGET_IXS.cu, 450);
  assert.equal(byId.V0_LOOKUPS.bytes, 6 * 31);
});

test('v1 that sets the priority only through SetComputeUnitPrice bids 0', () => {
  const tx = decode(buildV1({
    mask: 0b1100, values: [...v1Values.u32(200000), ...v1Values.u32(1 << 20)],
    addresses: [fakeKey(1), CB, fakeKey(3), SYSTEM],
    header: [1, 0, 2],
    ixs: [{ program: 1, accounts: [], data: cbPrice(50000n) }, { program: 3, accounts: [0, 2], data: transfer.data }],
  }));
  const f = lint(tx);
  assert.ok(ids(f).includes('V1_PRIORITY_ONLY_IN_IX'));
  assert.ok(ids(f).includes('V1_DEAD_COMPUTE_BUDGET'));
  assert.equal(f.find((x) => x.id === 'V1_DEAD_COMPUTE_BUDGET')!.bytes, 4 + 9 + 32);
});

test('v1 with no config at all: CU limit 0 and loaded limit 0 are errors', () => {
  const f = lint(decode(buildV1({ mask: 0, addresses: [fakeKey(1), fakeKey(2), SYSTEM], header: [1, 0, 1], ixs: [transfer] })));
  assert.deepEqual(ids(f.filter((x) => x.severity === 'error')), ['V1_CU_LIMIT_ABSENT', 'V1_LOADED_LIMIT_ABSENT']);
  assert.equal(f[0].severity, 'error');
});

test('v1 config rule violations: half priority mask, unknown bits, heap, zero CU limit, max loaded limit', () => {
  const f = lint(decode(buildV1({
    mask: 0b1 | 0b11100 | (1 << 9), // bit 0 only, bits 2,3,4, bit 9
    values: [...v1Values.u32(5), ...v1Values.u32(0), ...v1Values.u32(64 * 1024 * 1024), ...v1Values.u32(40000), ...v1Values.u32(1)],
    addresses: [fakeKey(1), fakeKey(2), SYSTEM], header: [1, 0, 1], ixs: [transfer],
  })));
  const got = ids(f);
  for (const id of ['V1_PRIORITY_HALF_MASK', 'V1_UNKNOWN_CONFIG_BITS', 'V1_HEAP_INVALID', 'V1_CU_LIMIT_ZERO', 'LOADED_LIMIT_MAX']) assert.ok(got.includes(id), id);
  assert.equal(f.find((x) => x.id === 'LOADED_LIMIT_MAX')!.cu, 16384); // ceil(64 MiB / 32 KiB) x 8
});

test('v1 sanitization: duplicate address, fee payer as program, index out of range', () => {
  const f = lint(decode(buildV1({
    mask: 0b1100, values: [...v1Values.u32(1000), ...v1Values.u32(1000)],
    addresses: [fakeKey(1), fakeKey(1), SYSTEM], header: [1, 0, 1],
    ixs: [{ program: 0, accounts: [9], data: [] }],
  })));
  const dup = f.find((x) => x.id === 'DUPLICATE_ADDRESS')!;
  assert.equal(dup.severity, 'error');
  const san = f.filter((x) => x.id === 'V1_SANITIZE').map((x) => x.detail).join(' | ');
  assert.match(san, /program index 0 is the fee payer/);
  assert.match(san, /account index 9 >= numAddresses 3/);
});

test('legacy: duplicates are info, oversize is an error, CB ixs are listed', () => {
  const big = Array.from({ length: 1200 }, () => 1);
  const f = lint(decode(buildLegacy({
    addresses: [fakeKey(1), fakeKey(1), CB, SYSTEM], header: [1, 0, 2],
    ixs: [{ program: 2, accounts: [], data: cbLimit(1_400_000) }, { program: 2, accounts: [], data: cbLoaded(64 * 1024 * 1024) }, { program: 2, accounts: [], data: cbHeap(65536) }, { program: 3, accounts: [0], data: big }],
  })), { slot: 1, blockTime: null, err: null, fee: 5000, computeUnitsConsumed: 1000, costUnits: null });
  const byId = Object.fromEntries(f.map((x) => [x.id, x]));
  assert.equal(byId.DUPLICATE_ADDRESS.severity, 'info');
  assert.equal(byId.SIZE_OVER_LIMIT.severity, 'error');
  assert.equal(byId.LEGACY_BUDGET_IXS.cu, 450);
  assert.equal(byId.LOADED_LIMIT_MAX.cu, 16384);
  assert.equal(byId.CU_OVERASK.cu, 1_399_000);
});

test('a clean v1 tx has no findings', () => {
  const tx = decode(buildV1({
    mask: 0b1111, values: [...v1Values.fee(5000n), ...v1Values.u32(300), ...v1Values.u32(32768)],
    addresses: [fakeKey(1), fakeKey(2), SYSTEM], header: [1, 0, 1], ixs: [transfer],
  }));
  assert.deepEqual(lint(tx, { slot: 1, blockTime: null, err: null, fee: 10000, computeUnitsConsumed: 150, costUnits: null }), []);
});
