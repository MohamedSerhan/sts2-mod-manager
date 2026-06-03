import { useCallback, useRef } from 'react';

/**
 * Scroll-pin safety net for long mutating lists.
 *
 * Attach the returned `ref` to a component's root element, then call
 * `pinScroll()` *before* a mutation that re-renders / reflows the list
 * (a toggle, an add, an enable-all). It captures the nearest scrollable
 * ancestor's `scrollTop` and re-pins it for ~12 frames (~200ms) so neither
 * the synchronous re-render nor any focus-driven scroll the engine schedules
 * right after can yank the user to the top.
 *
 * Inert under jsdom (scrollHeight/clientHeight are 0 there), so it doesn't
 * touch the test suite unless a test fakes a real scroll container. This is
 * the shared implementation behind LibraryTable's row toggles and
 * ModpackDetail's Add-from-library / enable-all-in-pack actions.
 */
export function usePinScroll<T extends HTMLElement = HTMLDivElement>(): {
  ref: React.RefObject<T | null>;
  pinScroll: () => void;
} {
  const ref = useRef<T>(null);

  const pinScroll = useCallback(() => {
    let el: HTMLElement | null = ref.current?.parentElement ?? null;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight) {
        break;
      }
      el = el.parentElement;
    }
    if (!el) return;
    const scroller = el;
    const top = scroller.scrollTop;
    let frame = 0;
    const hold = () => {
      if (scroller.scrollTop !== top) scroller.scrollTop = top;
      // ~12 frames (~200ms) covers the synchronous re-render plus any async
      // focus-driven scroll the engine schedules just after.
      if (++frame < 12) requestAnimationFrame(hold);
    };
    requestAnimationFrame(hold);
  }, []);

  return { ref, pinScroll };
}
