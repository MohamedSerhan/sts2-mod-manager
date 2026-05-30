import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextQaRound, isMergeEligible, QA_MAX_ROUNDS, MAINTAINER_LOGIN } from './qa-pipeline.mjs';

test('QA_MAX_ROUNDS is 5; maintainer is MohamedSerhan', () => {
  assert.equal(QA_MAX_ROUNDS, 5);
  assert.equal(MAINTAINER_LOGIN, 'MohamedSerhan');
});

test('nextQaRound = (marker comments) + 1', () => {
  assert.equal(nextQaRound([]), 1);
  assert.equal(nextQaRound(null), 1, 'null input → round 1');
  assert.equal(nextQaRound('not an array'), 1, 'non-array input → round 1');
  assert.equal(nextQaRound(['hello', 'no marker here']), 1);
  assert.equal(nextQaRound(['<!-- qa-round --> issues: ...']), 2);
  assert.equal(nextQaRound(['<!-- qa-round -->', 'chatter', '<!-- qa-round -->']), 3);
});

test('isMergeEligible true only for maintainer approval + qa + qa-passed', () => {
  assert.equal(isMergeEligible({ reviewState: 'approved', reviewerLogin: 'MohamedSerhan', labels: [{ name: 'qa' }, { name: 'qa-passed' }] }), true);
  assert.equal(isMergeEligible({ reviewState: 'approved', reviewerLogin: 'MohamedSerhan', labels: ['qa', 'qa-passed'] }), true, 'accepts string labels too');
});

test('isMergeEligible false for the disqualifying cases', () => {
  assert.equal(isMergeEligible({ reviewState: 'approved', reviewerLogin: 'someone-else', labels: ['qa', 'qa-passed'] }), false, 'other reviewer');
  assert.equal(isMergeEligible({ reviewState: 'commented', reviewerLogin: 'MohamedSerhan', labels: ['qa', 'qa-passed'] }), false, 'not approved');
  assert.equal(isMergeEligible({ reviewState: 'approved', reviewerLogin: 'MohamedSerhan', labels: ['qa-passed'] }), false, 'missing qa');
  assert.equal(isMergeEligible({ reviewState: 'approved', reviewerLogin: 'MohamedSerhan', labels: ['qa'] }), false, 'missing qa-passed');
  assert.equal(isMergeEligible({ reviewState: 'approved', reviewerLogin: 'MohamedSerhan', labels: [] }), false, 'no labels');
  assert.equal(isMergeEligible({}), false, 'empty object');
  assert.equal(isMergeEligible(), false, 'no args');
});
