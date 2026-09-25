import assert from 'node:assert/strict';
import test from 'node:test';
import { base58, fromBase58, fromBase64, readCompactU16, toBase64 } from '../src/codec.ts';
import { checkPartition, decode, DecodeError, sniff } from '../src/decode.ts';
import { block, buildLegacy, buildV1, fakeKey, fixture, SYSTEM, txBytes } from './helpers.ts';

test('every tx of a real mainnet block decodes, and its ranges partition [0, size)', () => {
  const b = block();
  assert.equal(b.transactions.length, 974);
  const seen = { legacy: 0, v0: 0, v1: 0 };
  for (const t of b.transactions) {
    const bytes = fromBase64(t.transaction[0])!;
    const d = decode(bytes);
    assert.equal(checkPartition(d.ranges, d.size), null);
    assert.equal(d.ranges[0].start, 0);
    assert.equal(d.ranges.at(-1)!.end, bytes.length);
    // the node's own version label agrees with the bytes
    assert.equal(d.version, t.version === 'legacy' ? 'legacy' : `v${t.version}`);
    assert.equal(sniff(bytes).version, d.version);
    seen[d.version]++;
  }
  assert.deepEqual(seen, { legacy: 671, v0: 203, v1: 100 });
});

test('v1 config parsed from the bytes reproduces the fee the chain charged (5000 x sigs + priority lamports)', () => {
  let checked = 0;
  for (const t of block().transactions) {
    const d = decode(fromBase64(t.transaction[0])!);
    if (d.version !== 'v1') continue;
    const expected = 5000 * d.header.numRequiredSignatures + Number(d.config!.priorityFeeLamports ?? 0);
    assert.equal(t.meta!.fee, expected);
    checked++;
  }
  assert.equal(checked, 100);
});

test('v1 layout of W81fNLque… matches SIMD-0385 offsets', () => {
  const d = decode(txBytes(fixture('tx-v1-dead-cb.json')));
  const at = (field: string) => d.ranges.filter((r) => r.field === field).map((r) => [r.start, r.end]);
  assert.equal(d.version, 'v1');
  assert.equal(d.size, 2291);
  assert.deepEqual(at('version'), [[0, 1]]);
  assert.deepEqual(at('configMask'), [[4, 8]]);
  assert.deepEqual(at('lifetimeSpecifier'), [[8, 40]]);
  assert.deepEqual(at('numInstructions'), [[40, 41]]);
  assert.deepEqual(at('numAddresses'), [[41, 42]]);
  assert.equal(at('address').length, 63);
  assert.deepEqual(at('address').at(-1), [42 + 62 * 32, 2058]);
  assert.deepEqual(at('configPriorityFee'), [[2058, 2066]]);
  assert.deepEqual(at('configComputeUnitLimit'), [[2066, 2070]]);
  assert.deepEqual(at('configLoadedAccountsDataSizeLimit'), [[2070, 2074]]);
  assert.deepEqual(at('ixHeader'), [[2074, 2078], [2078, 2082], [2082, 2086]]);
  assert.deepEqual(at('signature'), [[2227, 2291]]);
  assert.deepEqual(d.config, { mask: 15, maskHex: '0x0000000f', bits: [0, 1, 2, 3], priorityFeeLamports: '28488', computeUnitLimit: 77597, loadedAccountsDataSizeLimit: 13631488, heapSize: null });
  assert.equal(d.signatures[0], 'W81fNLqueZDWx5335CaemPZE2D8EuqAYhwUD47WX5RexigN9BEjGxmZcaoLkFsitubvAY6wYXfi8hnLrPoB7FMz');
});

test('v0: the 0x80 discriminator sits after the signatures (offset 1 + 64n)', () => {
  const bytes = txBytes(fixture('tx-v0-lookups.json'));
  assert.deepEqual(sniff(bytes), { version: 'v0', discriminatorOffset: 65 });
  const d = decode(bytes);
  assert.equal(d.lookups.length, 1);
  assert.deepEqual(d.lookups[0].writableIndexes, [0, 8, 24, 2]);
  assert.deepEqual(d.lookups[0].readonlyIndexes, [20, 25]);
});

test('matches the independent reference decoder byte for byte (ranges are normative)', () => {
  for (const [tx, expected] of [['tx-v1-dead-cb.json', 'xray-v1-dead-cb.expected.json'], ['tx-v0-lookups.json', 'xray-v0-lookups.expected.json']]) {
    const d = decode(txBytes(fixture(tx)));
    const strip = (rs: any[]) => rs.map(({ start, end, field, group, index, ix }) => ({ start, end, field, group, index, ix }));
    assert.deepEqual(strip(d.ranges), strip(fixture(expected).ranges));
  }
});

test('synthetic v1 with every config bit: u64 fee, CU, loaded, heap, unknown bit', () => {
  const bytes = buildV1({
    mask: 0b1_0001_1111 | (1 << 8), // bits 0-4 and 8
    values: [0x39, 0x30, 0, 0, 1, 0, 0, 0, /* fee = 0x1_00003039 */ 0xa0, 0x86, 1, 0, /* 100000 */ 0, 0, 0, 4, /* 64 MiB */ 0, 0, 1, 0, /* 65536 */ 7, 0, 0, 0],
    addresses: [fakeKey(1), SYSTEM],
    ixs: [{ program: 1, accounts: [0], data: [2, 0, 0, 0] }],
  });
  const d = decode(bytes);
  assert.equal(checkPartition(d.ranges, d.size), null);
  assert.equal(d.config!.priorityFeeLamports, String(0x1_00003039));
  assert.equal(d.config!.computeUnitLimit, 100000);
  assert.equal(d.config!.loadedAccountsDataSizeLimit, 67108864);
  assert.equal(d.config!.heapSize, 65536);
  const unk = d.ranges.find((r) => r.field === 'configUnknown')!;
  assert.equal(unk.index, 8);
  assert.equal(unk.value, '7');
});

test('structural failures throw DecodeError with offset and partial ranges', () => {
  const good = buildLegacy({ addresses: [fakeKey(1), SYSTEM], ixs: [{ program: 1, accounts: [0], data: [1, 2, 3] }] });
  assert.doesNotThrow(() => decode(good));

  const cases: [string, Uint8Array, RegExp][] = [
    ['empty', new Uint8Array(0), /empty/],
    ['truncated', good.subarray(0, good.length - 1), /truncated/],
    ['trailing byte', Uint8Array.from([...good, 0]), /trailing/],
    ['non-canonical compact-u16', Uint8Array.from([0x81 ^ 0x01, 0x00]), /non-canonical/],
    ['unknown version byte 0x82', (() => { const b = Uint8Array.from(good); b[65] = 0x82; return b; })(), /unknown version byte 0x82/],
    ['v1 cut in the addresses', buildV1({ mask: 12, values: [0, 0, 1, 0, 0, 0, 1, 0], addresses: [fakeKey(1)], ixs: [] }).subarray(0, 60), /truncated/],
  ];
  for (const [name, bytes, re] of cases) {
    assert.throws(() => decode(bytes), (e: unknown) => {
      assert.ok(e instanceof DecodeError, name);
      assert.match(e.message, re, name);
      assert.equal(typeof e.at, 'number');
      assert.ok(Array.isArray(e.partial.ranges));
      if (e.partial.ranges.length) assert.equal(checkPartition(e.partial.ranges, e.partial.ranges.at(-1)!.end), null, name);
      return true;
    });
  }
});

test('codecs: base58, base64, compact-u16 edge cases', () => {
  assert.equal(base58(new Uint8Array(32)), '11111111111111111111111111111111');
  const k = fromBase58('ComputeBudget111111111111111111111111111111')!;
  assert.equal(k.length, 32);
  assert.equal(base58(k), 'ComputeBudget111111111111111111111111111111');
  assert.equal(fromBase58('0OIl'), null);
  assert.deepEqual(fromBase64(' AQID\n'), Uint8Array.from([1, 2, 3]));
  assert.deepEqual(fromBase64('AQI'), Uint8Array.from([1, 2]));
  assert.equal(fromBase64('not base64!'), null);
  assert.equal(toBase64(Uint8Array.from([1, 2, 3])), 'AQID');
  assert.deepEqual(readCompactU16(Uint8Array.from([0x7f]), 0), [127, 1]);
  assert.deepEqual(readCompactU16(Uint8Array.from([0x80, 0x01]), 0), [128, 2]);
  assert.deepEqual(readCompactU16(Uint8Array.from([0xff, 0xff, 0x03]), 0), [0xffff, 3]);
  assert.match(readCompactU16(Uint8Array.from([0xff, 0xff, 0x04]), 0) as string, /over 0xffff/);
  assert.match(readCompactU16(Uint8Array.from([0x80, 0x80, 0x80]), 0) as string, /longer than 3/);
  assert.match(readCompactU16(Uint8Array.from([0x80]), 0) as string, /truncated/);
});
