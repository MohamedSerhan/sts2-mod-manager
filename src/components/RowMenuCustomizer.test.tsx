import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RowMenuCustomizer } from './RowMenuCustomizer';
import { AllProviders } from '../__test__/providers';
import { DEFAULT_ROW_MENU_ORDER, ROW_MENU_STORAGE_KEY, loadRowMenuConfig } from '../lib/rowMenuConfig';

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

  it('pointer drag reorders and persists', () => {
    renderCustomizer();
    const list = screen.getByTestId('row-menu-customizer-list');
    const rows = screen.getAllByTestId(/^row-menu-item-/);
    const firstId = rows[0].getAttribute('data-item-id')!;
    const thirdId = rows[2].getAttribute('data-item-id')!;
    const handle = within(rows[0]).getByLabelText(/drag/i);
    // jsdom rows have zero-height rects; a large clientY hit-tests as the
    // last row, which is enough to prove the pointer reorder path works.
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 0 });
    fireEvent.pointerMove(list, { pointerId: 1, clientY: 9999 });
    fireEvent.pointerUp(list, { pointerId: 1, clientY: 9999 });
    const order = loadRowMenuConfig().order;
    expect(order.indexOf(firstId as never)).toBeGreaterThan(order.indexOf(thirdId as never));
  });

  it('pointer cancel resets drag state so a stray later pointerup does not reorder', () => {
    renderCustomizer();
    const list = screen.getByTestId('row-menu-customizer-list');
    const rows = screen.getAllByTestId(/^row-menu-item-/);
    const before = loadRowMenuConfig().order;
    const handle = within(rows[0]).getByLabelText(/drag/i);
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 0 });
    fireEvent.pointerCancel(list, { pointerId: 1 });
    fireEvent.pointerUp(list, { pointerId: 1, clientY: 9999 });
    expect(loadRowMenuConfig().order).toEqual(before);
  });

  it('up and down buttons reorder items without dragging', async () => {
    const user = userEvent.setup();
    renderCustomizer();
    const rows = screen.getAllByTestId(/^row-menu-item-/);
    const firstId = rows[0].getAttribute('data-item-id')!;
    const secondId = rows[1].getAttribute('data-item-id')!;

    await user.click(within(rows[1]).getByRole('button', { name: /move .* up/i }));
    expect(loadRowMenuConfig().order[0]).toBe(secondId);

    const reorderedRows = screen.getAllByTestId(/^row-menu-item-/);
    await user.click(within(reorderedRows[0]).getByRole('button', { name: /move .* down/i }));
    const order = loadRowMenuConfig().order;
    expect(order.indexOf(firstId as never)).toBeLessThan(order.indexOf(secondId as never));
  });

  it('disables arrow buttons that would move an item past the list edge', () => {
    renderCustomizer();
    const rows = screen.getAllByTestId(/^row-menu-item-/);
    expect(within(rows[0]).getByRole('button', { name: /move .* up/i })).toBeDisabled();
    expect(within(rows[rows.length - 1]).getByRole('button', { name: /move .* down/i })).toBeDisabled();
  });

  it('shows locked items as a disabled footer', () => {
    renderCustomizer();
    const locked = screen.getByTestId('row-menu-locked');
    expect(within(locked).getByText(/delete from disk/i)).toBeInTheDocument();
    expect(within(locked).getByText(/customize menu/i)).toBeInTheDocument();
  });

  it('the locked Customize row has a toggle, and Delete does not', () => {
    renderCustomizer();
    const locked = screen.getByTestId('row-menu-locked');
    const deleteRow = within(locked).getByText(/delete from disk/i).closest('.gf-row-menu-item') as HTMLElement;
    const customizeRow = within(locked).getByText(/customize menu/i).closest('.gf-row-menu-item') as HTMLElement;
    expect(within(deleteRow).queryByRole('switch')).toBeNull();
    expect(within(customizeRow).getByRole('switch', { name: /show customize menu/i })).toBeInTheDocument();
  });

  it('switching off the Customize toggle persists showCustomizeEntry: false', async () => {
    const user = userEvent.setup();
    renderCustomizer();
    const toggle = screen.getByRole('switch', { name: /show customize menu/i });
    expect(toggle).toBeChecked();
    await user.click(toggle);
    expect(toggle).not.toBeChecked();
    expect(loadRowMenuConfig().showCustomizeEntry).toBe(false);
    const stored = JSON.parse(localStorage.getItem(ROW_MENU_STORAGE_KEY)!);
    expect(stored.showCustomizeEntry).toBe(false);
  });

  it('reset restores showCustomizeEntry to true', async () => {
    localStorage.setItem(
      ROW_MENU_STORAGE_KEY,
      JSON.stringify({ order: [...DEFAULT_ROW_MENU_ORDER], hidden: [], showCustomizeEntry: false }),
    );
    const user = userEvent.setup();
    renderCustomizer();
    expect(screen.getByRole('switch', { name: /show customize menu/i })).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: /reset to default/i }));
    expect(screen.getByRole('switch', { name: /show customize menu/i })).toBeChecked();
    expect(loadRowMenuConfig().showCustomizeEntry).toBe(true);
  });
});
