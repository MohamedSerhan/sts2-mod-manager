import { fireEvent, render, screen } from '@testing-library/react';
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

  it('closes when the open trigger is clicked again', async () => {
    const { user } = setup();
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });

    await user.click(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(trigger);

    expect(screen.queryByRole('listbox')).toBeNull();
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

  it('keyboard: ignores non-opening keys while closed', async () => {
    const { user, onChange } = setup('a');
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();

    await user.keyboard('x');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
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

  it('shows a placeholder and does not open while disabled', async () => {
    const { user, onChange } = setup('missing', {
      disabled: true,
      placeholder: 'Pick one',
    });
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });

    expect(trigger).toHaveTextContent('Pick one');
    await user.click(trigger);
    trigger.focus();
    await user.keyboard('{Enter}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('ignores forced disabled trigger events', () => {
    const { onChange } = setup('missing', {
      disabled: true,
      placeholder: 'Pick one',
    });
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });

    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'Enter' });

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('closes on outside pointerdown without calling the wrapper click handler', async () => {
    const onClick = vi.fn();
    const { user } = setup('a', { onClick });

    await user.click(screen.getByRole('combobox', { name: 'Fruit' }));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(onClick).toHaveBeenCalledTimes(1);

    await user.click(document.body);

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('keyboard: arrow-up opens and moves backward around disabled options', async () => {
    const { user, onChange } = setup('d');
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();

    await user.keyboard('{ArrowUp}');
    await user.keyboard('{ArrowUp}');
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('keyboard: Home and End jump to the first and last enabled options', async () => {
    const { user, onChange } = setup('b');
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();

    await user.keyboard('{Enter}');
    await user.keyboard('{Home}');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('a');

    await user.click(trigger);
    await user.keyboard('{End}');
    await user.keyboard(' ');
    expect(onChange).toHaveBeenCalledWith('d');
  });

  it('keyboard: End skips disabled trailing options', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        value="a"
        onChange={onChange}
        options={[
          { value: 'a', label: 'Apple' },
          { value: 'b', label: 'Banana' },
          { value: 'c', label: 'Cherry', disabled: true },
          { value: 'd', label: 'Date', disabled: true },
        ]}
        aria-label="Fruit"
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();

    await user.keyboard(' ');
    await user.keyboard('{End}');
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('keyboard: Tab closes and choosing the current option does not emit a change', async () => {
    const { user, onChange } = setup('a');
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();

    await user.keyboard('{Enter}');
    await user.keyboard('{Tab}');
    expect(screen.queryByRole('listbox')).toBeNull();

    trigger.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');

    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keyboard: leaves the highlight unchanged when every option is disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        value="a"
        onChange={onChange}
        options={[
          { value: 'a', label: 'Apple', disabled: true },
          { value: 'b', label: 'Banana', disabled: true },
        ]}
        aria-label="Fruit"
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();

    await user.keyboard('{Enter}{ArrowDown}{Enter}');

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keyboard: does not commit when no option can be highlighted', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Select
        value="missing"
        onChange={onChange}
        options={[
          { value: 'a', label: 'Apple', disabled: true },
          { value: 'b', label: 'Banana', disabled: true },
        ]}
        aria-label="Fruit"
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    trigger.focus();

    await user.keyboard('{Enter}{Enter}');

    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps the menu open for pointerdown inside the control and can commit the hovered option', async () => {
    const { user, onChange } = setup('a');
    const trigger = screen.getByRole('combobox', { name: 'Fruit' });

    await user.click(trigger);
    fireEvent.pointerDown(trigger);
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    await user.hover(screen.getByRole('option', { name: 'Date' }));
    await user.keyboard('{Enter}');

    expect(onChange).toHaveBeenCalledWith('d');
  });
});
