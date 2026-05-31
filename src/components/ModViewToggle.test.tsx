import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModViewToggle, useModListDensity } from './ModViewToggle';

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
});

describe('<ModViewToggle>', () => {
  it('marks the active density and reports a switch to compact', async () => {
    const onChange = vi.fn();
    render(<ModViewToggle density="comfortable" onChange={onChange} />);
    const comfortable = screen.getByRole('button', { name: /^comfortable$/i });
    const compact = screen.getByRole('button', { name: /^compact$/i });
    expect(comfortable).toHaveAttribute('aria-pressed', 'true');
    expect(comfortable).toHaveClass('is-active');
    expect(compact).toHaveAttribute('aria-pressed', 'false');

    await userEvent.click(compact);
    expect(onChange).toHaveBeenCalledWith('compact');
  });

  it('reports a switch back to comfortable', async () => {
    const onChange = vi.fn();
    render(<ModViewToggle density="compact" onChange={onChange} />);
    expect(screen.getByRole('button', { name: /^compact$/i })).toHaveClass('is-active');

    await userEvent.click(screen.getByRole('button', { name: /^comfortable$/i }));
    expect(onChange).toHaveBeenCalledWith('comfortable');
  });
});

describe('useModListDensity', () => {
  it('defaults to comfortable and persists changes to localStorage', () => {
    const { result } = renderHook(() => useModListDensity());
    expect(result.current[0]).toBe('comfortable');
    act(() => result.current[1]('compact'));
    expect(result.current[0]).toBe('compact');
    expect(localStorage.getItem('sts2mm-mod-density')).toBe('compact');
  });

  it('restores a persisted compact preference on mount', () => {
    localStorage.setItem('sts2mm-mod-density', 'compact');
    const { result } = renderHook(() => useModListDensity());
    expect(result.current[0]).toBe('compact');
  });

  it('stays usable when localStorage is blocked', () => {
    const getSpy = vi
      .spyOn(Storage.prototype, 'getItem')
      .mockImplementation(() => { throw new Error('blocked'); });
    const setSpy = vi
      .spyOn(Storage.prototype, 'setItem')
      .mockImplementation(() => { throw new Error('blocked'); });
    try {
      const { result } = renderHook(() => useModListDensity());
      expect(result.current[0]).toBe('comfortable'); // readDensity catch → default
      act(() => result.current[1]('compact'));
      expect(result.current[0]).toBe('compact'); // setDensity catch → state still updates
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
  });
});
