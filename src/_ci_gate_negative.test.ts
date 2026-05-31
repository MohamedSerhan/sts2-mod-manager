// Throwaway: proves the CI Gate blocks a merge when a relevant check fails.
// This is an app change (src/), so it triggers test-frontend (vitest); the test
// below fails on purpose, which should turn CI Gate red and block the merge.
// Removed immediately after the gate verification.
import { describe, it, expect } from 'vitest';

describe('CI Gate negative test (throwaway)', () => {
  it('intentionally fails to prove the gate blocks bad merges', () => {
    expect(1).toBe(2);
  });
});
