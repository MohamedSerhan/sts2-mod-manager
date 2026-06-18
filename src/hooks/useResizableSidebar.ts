import { useCallback, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  SIDEBAR_WIDTH_STEP,
  clampSidebarWidth,
  loadSidebarWidth,
  saveSidebarWidth,
} from '../display/sidebarWidth';

function directionSign(): number {
  if (typeof document === 'undefined') return 1;
  return document.documentElement.dir === 'rtl' ? -1 : 1;
}

export interface ResizableSidebar {
  width: number;
  min: number;
  max: number;
  onHandleMouseDown: (event: MouseEvent<HTMLElement>) => void;
  onHandleKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  onHandleDoubleClick: () => void;
}

export function useResizableSidebar(): ResizableSidebar {
  const [width, setWidth] = useState<number>(() => loadSidebarWidth());
  const drag = useRef<{ startX: number; startWidth: number; sign: number } | null>(null);

  const onHandleMouseDown = useCallback((event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    drag.current = { startX: event.clientX, startWidth: width, sign: directionSign() };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = (move: globalThis.MouseEvent) => {
      const state = drag.current;
      if (!state) return;
      const delta = (move.clientX - state.startX) * state.sign;
      setWidth(clampSidebarWidth(state.startWidth + delta));
    };
    const onUp = () => {
      drag.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setWidth((current) => {
        saveSidebarWidth(current);
        return current;
      });
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [width]);

  const onHandleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const sign = directionSign();
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = width + SIDEBAR_WIDTH_STEP * sign;
    else if (event.key === 'ArrowLeft') next = width - SIDEBAR_WIDTH_STEP * sign;
    if (next === null) return;
    event.preventDefault();
    const clamped = clampSidebarWidth(next);
    setWidth(clamped);
    saveSidebarWidth(clamped);
  }, [width]);

  const onHandleDoubleClick = useCallback(() => {
    setWidth(DEFAULT_SIDEBAR_WIDTH);
    saveSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  }, []);

  return {
    width,
    min: MIN_SIDEBAR_WIDTH,
    max: MAX_SIDEBAR_WIDTH,
    onHandleMouseDown,
    onHandleKeyDown,
    onHandleDoubleClick,
  };
}
