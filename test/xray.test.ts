import assert from 'node:assert/strict';
import test from 'node:test';
import { decode } from '../src/decode.ts';
import { misread } from '../src/misread.ts';
import { v1Port } from '../src/port.ts';
import { toTxMeta } from '../src/rpc.ts';
import { xray } from '../src/xray.ts';
import { buildLegacy, buildV1, CB, cbLimit, cbPrice, fakeKey, fixture, SYSTEM, txBytes, v1Values } from './helpers.ts';

const NORMATIVE = (x: any) => JSON.parse(JSON.stringify(x, (k, v) => (['label', 'value', 'title', 'detail', 'result', 'name', '_note'].includes(k) ? undefined : v)));

test('xray() equals the independent reference output on real v1 and v0 txs (all structural fields)', () => {
  for (const [tx, expected] of [['tx-v1-dead-cb.json', 'xray-v1-dead-cb.expected.json'], ['tx-v0-lookups.json', 'xray-v0-lookups.expected.json']]) {
    const rec = fixture(tx);
    const x = xray(txBytes(rec), { meta: toTxMeta(rec.slot, rec.blockTime, rec.meta), loadedAddresses: rec.meta.loadedAddresses, source: 'rpc' });
    assert.deepEqual(NORMATIVE(x), NORMATIVE(fixture(expected)), tx);
  }
});

test('raw path: lookup-loaded accounts have pubkey null', () => {
  const x = xray(txBytes(fixture('tx-v0-lookups.json')));
  assert.equal(x.source, 'raw');
  assert.equal(x.meta, null);
  const loaded = x.accounts.filter((a) => a.source === 'lookup');
  assert.equal(loaded.length, 6);
  assert.ok(loaded.every((a) => a.pubkey === null));
});

test('misread: a sig-count-first parser reads 0x81 0x01 as 129 signatures', () => {
  const m = misread(decode(txBytes(fixture('tx-v1-dead-cb.json'))));
  assert.deepEqual(m.map((p) => p.reader), ['pre-v1-parser', 'legacy-only-parser', 'rpc-no-version-param', 'rpc-max-version-0', 'geyser-versioned-first']);
  assert.deepEqual(m[0].detail, { claimedSignatures: 129, bytesNeeded: 2 + 64 * 129, errorCode: null });
  assert.equal(m[3].detail.errorCode, -32015);
  const two = misread(decode(buildV1({ header: [2, 0, 1], mask: 12, values: [...v1Values.u32(1), ...v1Values.u32(1)], addresses: [fakeKey(1), fakeKey(2), SYSTEM], ixs: [] })));
  assert.equal(two[0].detail.claimedSignatures, 257);
  const legacy = misread(decode(buildLegacy({ addresses: [fakeKey(1), SYSTEM], ixs: [] })));
  assert.ok(legacy.every((p) => p.ok));
});

test('v1Port size equals the length of the actual v1 encoding of the same message', () => {
  const payer = fakeKey(1), dest = fakeKey(2);
  const transferData = [2, 0, 0, 0, 0x40, 0x42, 0x0f, 0, 0, 0, 0, 0];
  // legacy: [payer, dest, System, ComputeBudget]; CB ixs set limit + price
  const legacy = decode(buildLegacy({
    header: [1, 0, 2],
    addresses: [payer, dest, SYSTEM, CB],
    ixs: [{ program: 3, accounts: [], data: cbLimit(1000) }, { program: 3, accounts: [], data: cbPrice(10_000n) }, { program: 2, accounts: [0, 1], data: transferData }],
  }));
  const port = v1Port(legacy)!;
  // the same message as v1: ComputeBudget address and ixs gone, config bits 0,1,2,3
  const v1 = decode(buildV1({
    header: [1, 0, 1], mask: 0b1111,
    values: [...v1Values.fee(10n), ...v1Values.u32(1000), ...v1Values.u32(32768)],
    addresses: [payer, dest, SYSTEM],
    ixs: [{ program: 2, accounts: [0, 1], data: transferData }],
  }));
  assert.equal(port.size, v1.size);
  assert.deepEqual(port.configBits, [0, 1, 2, 3]);
  assert.equal(port.removedComputeBudgetIxs, 2);
  assert.equal(port.addresses, 3);
  assert.equal(port.fits, true);
  assert.equal(port.bytesDelta, v1.size - legacy.size);
  assert.equal(v1Port(v1), null);
});

test('v1Port of the real v0 tx inlines its 6 lookup addresses', () => {
  const rec = fixture('tx-v0-lookups.json');
  const p = v1Port(decode(txBytes(rec)), rec.meta.loadedAddresses)!;
  assert.deepEqual(p, { size: 694, fits: true, addresses: 10, removedComputeBudgetIxs: 3, configBits: [0, 1, 2, 3], inlinedLookupAddresses: 6, bytesDelta: 110, blockers: [] });
});
