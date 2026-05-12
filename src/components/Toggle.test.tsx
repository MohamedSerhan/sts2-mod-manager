import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Toggle } from './Toggle';

describe('<Toggle>', () => {
  it('renders a role=switch with aria-checked matching the prop', () => {
    const { rerender } = render(<Toggle checked={false} onChange={() => {}} />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    rerender(<Toggle checked onChange={() => {}} />);
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('adds the "on" class when checked', () => {
    render(<Toggle checked onChange={() => {}} />);
    expect(screen.getByRole('switch').className).toContain('on');
  });

  it('omits the "on" class when unchecked', () => {
    render(<Toggle checked={false} onChange={() => {}} />);
    expect(screen.getByRole('switch').className).not.toContain('on');
  });

  it('calls onChange with the OPPOSITE of checked on click', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Toggle checked={false} onChange={onChange} />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('flips the other way on click when starting checked', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Toggle checked onChange={onChange} />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('does not fire onChange when disabled', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Toggle checked={false} disabled onChange={onChange} />);
    await user.click(screen.getByRole('switch'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
