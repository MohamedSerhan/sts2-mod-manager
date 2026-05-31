import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sum } from './sum.mjs';

test('empty array → 0', () => {
  assert.equal(sum([]), 0);
});

test('missing / non-array argument → 0', () => {
  assert.equal(sum(), 0, 'no args');
  assert.equal(sum(null), 0, 'null');
  assert.equal(sum('not an array'), 0, 'string');
});

test('normal array of numbers', () => {
  assert.equal(sum([1, 2, 3]), 6);
  assert.equal(sum([0, -1, 5]), 4);
  assert.equal(sum([42]), 42);
});

test('non-number entries are ignored', () => {
  assert.equal(sum([1, 'two', 3, null, undefined, true, 4]), 8);
  assert.equal(sum(['a', 'b']), 0, 'all non-numbers → 0');
});
