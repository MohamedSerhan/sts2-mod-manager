import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RowMenuCustomizer } from './RowMenuCustomizer';
import { AllProviders } from '../__test__/providers';
import { ROW_MENU_STORAGE_KEY, loadRowMenuConfig } from '../lib/rowMenuConfig';

beforeEach(() => {
  try { localStorage.clear(); } catch { /* jsdom quirk */ }
});

function renderCustomizer() {
  return render(<AllProviders><RowMenuCustomizer /></AllProviders>);
}

describe('<RowMenuCustomizer>', () => {
  it('lists all 11 customizable items', () => {
    renderCustomizer();
    const list = screen.getByTestId('row-menu-customizer-list');
    expect(within(list).getAllByTestId(/^row-menu-item-/)).toHaveLength(11);
  });

  it('toggling a switch hides that id and persists', async () => {
    const user = userEvent.setup();
    renderCustomizer();
    const toggle = screen.getByRole('switch', { name: /show freeze in the menu/i });
    await user.click(toggle);
    expect(loadRowMenuConfig().hidden).toContain('freeze');
  });

  it('reset restores the default config', async () => {
    localStorage.setItem(ROW_MENU_STORAGE_KEY, JSON.stringify({ order: ['freeze'], hidden: ['freeze'] }));
    const user = userEvent.setup();
    renderCustomizer();
    await user.click(screen.getByRole('button', { name: /reset to default/i }));
    expect(loadRowMenuConfig().hidden).toEqual([]);
  });

  it('drag-drop reorders and persists', () => {
    renderCustomizer();
    const rows = screen.getAllByTestId(/^row-menu-item-/);
    const firstId = rows[0].getAttribute('data-item-id')!;
    const thirdId = rows[2].getAttribute('data-item-id')!;
    const dt = { setData: () => {}, getData: () => '', dropEffect: '', effectAllowed: '' };
    // drag row 0 onto row 2
    fireEvent.dragStart(rows[0], { dataTransfer: dt });
    fireEvent.dragOver(rows[2], { dataTransfer: dt });
    fireEvent.drop(rows[2], { dataTransfer: dt });
    const order = loadRowMenuConfig().order;
    expect(order.indexOf(firstId as never)).toBeGreaterThan(order.indexOf(thirdId as never));
  });

  it('dragEnd resets drag state so a stray later drop does not reorder', () => {
    renderCustomizer();
    const rows = screen.getAllByTestId(/^row-menu-item-/);
    const before = loadRowMenuConfig().order;
    const dt = { setData: () => {}, getData: () => '', dropEffect: '', effectAllowed: '' };
    fireEvent.dragStart(rows[0], { dataTransfer: dt });
    fireEvent.dragEnd(rows[0], { dataTransfer: dt });      // resets dragIndex → null
    fireEvent.drop(rows[2], { dataTransfer: dt });          // no active drag → no-op
    expect(loadRowMenuConfig().order).toEqual(before);
  });

  it('shows locked items as a disabled footer', () => {
    renderCustomizer();
    const locked = screen.getByTestId('row-menu-locked');
    expect(within(locked).getByText(/delete from disk/i)).toBeInTheDocument();
    expect(within(locked).getByText(/customize menu/i)).toBeInTheDocument();
  });
});
