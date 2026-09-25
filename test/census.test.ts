import assert from 'node:assert/strict';
import test from 'node:test';
import { census, featured, median, percentile } from '../src/census.ts';
import { block, BLOCK_SLOT, fixture } from './helpers.ts';

test('census of a real block matches the independent reference numbers', () => {
  const c = census([block()]);
  const ref = fixture('census-450355468.expected.json');
  for (const k of ['blocks', 'slots', 'blockTime', 'txs', 'versions', 'versionsNonVote', 'v1', 'v0', 'card']) assert.deepEqual((c as any)[k], ref[k], k);
  assert.equal(c.undecodable, 0);
  assert.equal(c.v1.count, 100);
  assert.equal(c.v1.deadComputeBudget.cu, 450);
});

test('census of nothing is all zeros, never NaN', () => {
  const c = census([]);
  assert.equal(c.txs.total, 0);
  assert.equal(c.v1.shareAll, 0);
  assert.equal(c.v1.cuOveraskMedian, null);
  assert.deepEqual(c.v1.size, { p50: 0, p90: 0, max: 0 });
  assert.ok(!JSON.stringify(c).includes('NaN'));
  const e = census([{ slot: 5, blockTime: 1, transactions: [] }]);
  assert.equal(e.slots.first, 5);
  assert.equal(e.card.line, 'v1 = 0.0% of txs · 0.0% of v1 still pay for dead ComputeBudget ixs');
});

test('undecodable transactions are counted, not thrown', () => {
  const c = census([{ slot: 1, blockTime: 1, transactions: [{ transaction: ['AAAA', 'base64'], meta: null }, { transaction: ['%%%', 'base64'], meta: null }] }]);
  assert.equal(c.undecodable, 2);
  assert.equal(c.txs.total, 0);
});

test('featured picks the four demo transactions from the block', () => {
  const f = featured(block());
  assert.equal(f.slot, BLOCK_SLOT);
  assert.deepEqual(f.picks.map((p) => [p.kind, p.version, p.size]), [['v1-largest', 'v1', 2401], ['v1-dead-cb', 'v1', 2291], ['v0-lookups', 'v0', 584], ['legacy', 'legacy', 331]]);
  assert.equal(f.picks[1].signature, 'W81fNLqueZDWx5335CaemPZE2D8EuqAYhwUD47WX5RexigN9BEjGxmZcaoLkFsitubvAY6wYXfi8hnLrPoB7FMz');
  for (const p of f.picks) {
    assert.equal(p.xray.source, 'rpc');
    assert.equal(p.xray.meta!.slot, BLOCK_SLOT);
    assert.equal(p.xray.signature, p.signature);
  }
});

test('median and nearest-rank percentile', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([7], 50), 7);
});
