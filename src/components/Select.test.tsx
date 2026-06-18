import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Select, type SelectOption } from './Select';

const OPTS: SelectOption[] = [
  { value: 'a', label: 'Apple' },
  { value: 'b', label: 'Banana' },
  { value: 'c', label: 'Cherry', disabled: true },
  { value: 'd', label: 'Date' },
];

function setup(value = 'a', props: Partial<Parameters<typeof Select>[0]> = {}) {
  const onChange = vi.fn();
  render(
    <Select value={value} onChange={onChange} options={OPTS} aria-label="Fruit" {...props} />,
  );
  return { onChange, user: userEvent.setup() };
}

describe('<Select>', () => {
  it('shows the selected option label on the trigger', () => {
    setup('b');
    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveTextContent('Banana');
  });

  it('opens on click and lists options', async () => {
    const { user } = setup();
    expect(screen.queryByRole('listbox')).toBeNull();
    await user.click(screen.getByRole('combobox', { name: 'Fruit' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option')).toHaveLength(4);
  });

  it('selects an option on click, closes, and reports the value', async () => {
    const { user, onChange } = setup('a');
    await user.click(screen.getByRole('combobox', { name: 'Fruit' }));
    await user.click(screen.getByRole('option', { name: 'Date' }));
    expect(onChange).toHaveBeenCalledWith('d');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('does not select a disabled option', async () => {
    const { user, onChange } = setup('a');
    await user.click(screen.getByRole('combobox', { name: 'Fruit' }));
    await user.click(screen.getByRole('option', { name: 'Cherry' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keyboard: arrow-down then Enter selects the next option', async () => {
    const { user, onChange } = setup('a');
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();
    await user.keyboard('{ArrowDown}'); // open, highlight current (a)
    await user.keyboard('{ArrowDown}'); // -> b
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('keyboard: arrow-down skips disabled options', async () => {
    const { user, onChange } = setup('b'); // start on Banana
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();
    await user.keyboard('{ArrowDown}'); // open, highlight b
    await user.keyboard('{ArrowDown}'); // skip disabled c -> d
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('d');
  });

  it('Escape closes without selecting', async () => {
    const { user, onChange } = setup();
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    await user.click(trigger);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('marks the current value as the selected option', async () => {
    const { user } = setup('d');
    await user.click(screen.getByRole('combobox', { name: 'Fruit' }));
    expect(screen.getByRole('option', { name: 'Date' })).toHaveAttribute('aria-selected', 'true');
  });

  it('associates a <label htmlFor> with the trigger', () => {
    const onChange = vi.fn();
    render(
      <>
        <label htmlFor="fruit-pick">Pick fruit</label>
        <Select id="fruit-pick" value="a" onChange={onChange} options={OPTS} />
      </>,
    );
    expect(screen.getByLabelText('Pick fruit')).toHaveAttribute('role', 'combobox');
  });
});
