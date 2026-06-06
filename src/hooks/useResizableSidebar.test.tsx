import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useResizableSidebar } from './useResizableSidebar';
import { SidebarResizeHandle } from '../components/SidebarResizeHandle';
import { SIDEBAR_WIDTH_STORAGE_KEY, DEFAULT_SIDEBAR_WIDTH } from '../display/sidebarWidth';

function Harness() {
  const sidebar = useResizableSidebar();
  return (
    <div>
      <span data-testid="w">{sidebar.width}</span>
      <SidebarResizeHandle sidebar={sidebar} />
    </div>
  );
}

afterEach(() => {
  localStorage.clear();
  document.documentElement.dir = '';
});

describe('useResizableSidebar', () => {
  it('starts at the default width and exposes separator semantics', () => {
    render(<Harness />);
    expect(screen.getByTestId('w')).toHaveTextContent(String(DEFAULT_SIDEBAR_WIDTH));
    const handle = screen.getByRole('separator');
    expect(handle).toHaveAttribute('aria-orientation', 'vertical');
    expect(handle).toHaveAttribute('aria-valuenow', '248');
  });

  it('drag widens the sidebar, clamps to max, and persists on mouseup', () => {
    render(<Harness />);
    const handle = screen.getByRole('separator');
    fireEvent.mouseDown(handle, { clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 1000 });
    fireEvent.mouseUp(document);
    expect(screen.getByTestId('w')).toHaveTextContent('420');
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('420');
  });

  it('arrow keys nudge width by the step and persist', () => {
    render(<Harness />);
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(screen.getByTestId('w')).toHaveTextContent('264');
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('264');
  });

  it('double-click resets to the default', () => {
    render(<Harness />);
    const handle = screen.getByRole('separator');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(screen.getByTestId('w')).toHaveTextContent('264');
    fireEvent.doubleClick(handle);
    expect(screen.getByTestId('w')).toHaveTextContent('248');
    expect(localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)).toBe('248');
  });

  it('flips arrow-key direction in RTL', () => {
    document.documentElement.dir = 'rtl';
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    expect(screen.getByTestId('w')).toHaveTextContent('264');
  });
});
