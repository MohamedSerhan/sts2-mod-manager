import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { usePinScroll } from './usePinScroll';

describe('usePinScroll', () => {
  it('no-ops when the ref is not attached to any element', () => {
    // Until the ref is attached, ref.current is null, so pinScroll() must
    // bail at the `ref.current?.parentElement ?? null` guard rather than
    // throw on a null element. (usePinScroll.ts lines 25/33.)
    const { result } = renderHook(() => usePinScroll());
    expect(() => act(() => result.current.pinScroll())).not.toThrow();
  });
});
