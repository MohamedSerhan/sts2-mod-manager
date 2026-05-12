import { describe, expect, it } from 'vitest';

import { cn } from './utils';

describe('cn (class-name merger)', () => {
  it('joins strings with spaces', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c');
  });

  it('drops falsy values', () => {
    expect(cn('a', false, null, undefined, 0, '', 'b')).toBe('a b');
  });

  it('flattens arrays and objects (clsx)', () => {
    expect(cn(['a', 'b'], { c: true, d: false })).toBe('a b c');
  });

  it('merges conflicting tailwind classes — later wins', () => {
    // twMerge keeps the last conflicting class. This is the whole
    // point of `cn` over plain clsx.
    expect(cn('px-2', 'px-4')).toBe('px-4');
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
  });

  it('preserves non-conflicting classes when merging', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
  });

  it('returns empty string for no inputs', () => {
    expect(cn()).toBe('');
  });
});
