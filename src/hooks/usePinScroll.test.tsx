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

  it('no-ops when no ancestor can scroll', () => {
    const { result } = renderHook(() => usePinScroll<HTMLDivElement>());
    const parent = document.createElement('div');
    const child = document.createElement('div');
    parent.style.overflowY = 'visible';
    parent.append(child);
    document.body.append(parent);
    (result.current.ref as { current: HTMLDivElement | null }).current = child;

    expect(() => act(() => result.current.pinScroll())).not.toThrow();

    parent.remove();
  });

  it('restores the scroll position through the extended hold window', () => {
    const originalRaf = globalThis.requestAnimationFrame;
    const callbacks: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      callbacks.push(callback);
      return callbacks.length;
    }) as typeof requestAnimationFrame;

    try {
      const { result } = renderHook(() => usePinScroll<HTMLDivElement>());
      const scroller = document.createElement('div');
      const child = document.createElement('div');
      scroller.style.overflowY = 'auto';
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 });
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 300 });
      scroller.scrollTop = 84;
      scroller.append(child);
      document.body.append(scroller);
      (result.current.ref as { current: HTMLDivElement | null }).current = child;

      act(() => result.current.pinScroll());
      scroller.scrollTop = 0;

      act(() => {
        for (let i = 0; i < 120; i += 1) {
          const callback = callbacks.shift();
          expect(callback).toBeDefined();
          callback?.(i);
        }
      });

      expect(scroller.scrollTop).toBe(84);
      expect(callbacks).toHaveLength(0);
      scroller.remove();
    } finally {
      globalThis.requestAnimationFrame = originalRaf;
    }
  });
});
