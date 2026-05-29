import { describe, expect, it, vi } from 'vitest';

import { withTimeout } from './withTimeout';

describe('withTimeout', () => {
  it('resolves with the value and clears the timer when the promise settles first', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000, 'too slow')).resolves.toBe(7);
  });

  it('propagates the underlying rejection when the promise fails first', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000, 'too slow')).rejects.toThrow('boom');
  });

  it('rejects with the timeout message when the promise stalls past the ceiling', async () => {
    vi.useFakeTimers();
    try {
      // A promise that never settles — only the timeout can resolve the race.
      const stalled = new Promise<number>(() => {});
      const raced = withTimeout(stalled, 1000, 'took too long');
      const expectation = expect(raced).rejects.toThrow('took too long');
      await vi.advanceTimersByTimeAsync(1000);
      await expectation;
    } finally {
      vi.useRealTimers();
    }
  });
});
