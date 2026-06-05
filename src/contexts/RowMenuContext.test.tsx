// src/contexts/RowMenuContext.test.tsx
import { describe, expect, it, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { RowMenuProvider, useRowMenu } from './RowMenuContext';
import { DEFAULT_ROW_MENU_CONFIG, loadRowMenuConfig } from '../lib/rowMenuConfig';

beforeEach(() => {
  try { localStorage.clear(); } catch { /* storage may be unavailable in some environments */ }
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <RowMenuProvider>{children}</RowMenuProvider>
);

describe('useRowMenu', () => {
  it('starts from the default config', () => {
    const { result } = renderHook(() => useRowMenu(), { wrapper });
    expect(result.current.config).toEqual(DEFAULT_ROW_MENU_CONFIG);
  });

  it('toggleHidden updates config and persists', () => {
    const { result } = renderHook(() => useRowMenu(), { wrapper });
    act(() => result.current.toggleHidden('freeze'));
    expect(result.current.config.hidden).toContain('freeze');
    expect(loadRowMenuConfig().hidden).toContain('freeze');
  });

  it('setOrder updates config and persists', () => {
    const { result } = renderHook(() => useRowMenu(), { wrapper });
    const reversed = [...result.current.config.order].reverse();
    act(() => result.current.setOrder(reversed));
    expect(result.current.config.order).toEqual(reversed);
    expect(loadRowMenuConfig().order).toEqual(reversed);
  });

  it('reset restores the default config', () => {
    const { result } = renderHook(() => useRowMenu(), { wrapper });
    act(() => result.current.toggleHidden('freeze'));
    act(() => result.current.reset());
    expect(result.current.config).toEqual(DEFAULT_ROW_MENU_CONFIG);
    expect(loadRowMenuConfig()).toEqual(DEFAULT_ROW_MENU_CONFIG);
  });

  it('falls back to default config when used without a provider', () => {
    const { result } = renderHook(() => useRowMenu());
    expect(result.current.config).toEqual(DEFAULT_ROW_MENU_CONFIG);
    // mutators are safe no-ops; calling them must not throw
    expect(() => act(() => result.current.toggleHidden('freeze'))).not.toThrow();
  });
});
