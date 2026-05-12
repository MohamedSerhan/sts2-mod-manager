import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Button } from './Button';

describe('<Button>', () => {
  it('renders its children inside a <button>', () => {
    render(<Button>Save</Button>);
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
  });

  it('defaults to the primary variant + md size', () => {
    render(<Button>Save</Button>);
    const btn = screen.getByRole('button', { name: 'Save' });
    expect(btn.className).toContain('gf-btn');
    // primary+md has no extra size class
    expect(btn.className).not.toContain('gf-btn-sm');
    expect(btn.className).not.toContain('gf-btn-lg');
  });

  it.each([
    ['primary',   'gf-btn'],
    ['secondary', 'gf-btn-2'],
    ['danger',    'gf-btn-danger'],
    ['ghost',     'gf-btn-3'],
  ] as const)('applies %s-variant utility class', (variant, expected) => {
    render(<Button variant={variant}>X</Button>);
    expect(screen.getByRole('button').className).toContain(expected);
  });

  it('applies sm size for primary variant', () => {
    render(<Button size="sm">X</Button>);
    expect(screen.getByRole('button').className).toContain('gf-btn-sm');
  });

  it('passes through extra HTML attributes (title, disabled, type)', () => {
    render(
      <Button title="Submit form" type="submit" disabled>
        Send
      </Button>,
    );
    const btn = screen.getByRole('button', { name: 'Send' });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Submit form');
    expect(btn).toHaveAttribute('type', 'submit');
  });

  it('fires onClick when clicked', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(<Button onClick={onClick}>Click me</Button>);
    await user.click(screen.getByRole('button', { name: 'Click me' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire onClick when disabled', async () => {
    const onClick = vi.fn();
    const user = userEvent.setup();
    render(
      <Button disabled onClick={onClick}>
        Click me
      </Button>,
    );
    await user.click(screen.getByRole('button', { name: 'Click me' }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('merges caller-provided className with the variant class', () => {
    render(<Button className="extra-class">X</Button>);
    expect(screen.getByRole('button').className).toContain('extra-class');
    expect(screen.getByRole('button').className).toContain('gf-btn');
  });
});
