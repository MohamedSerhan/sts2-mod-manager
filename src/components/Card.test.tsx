import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Card } from './Card';

describe('<Card>', () => {
  it('renders children inside a div with gf-card class', () => {
    render(
      <Card>
        <span>contents</span>
      </Card>,
    );
    // The contents span is wrapped by the card div; the wrapper has gf-card.
    const card = screen.getByText('contents').parentElement!;
    expect(card.className).toContain('gf-card');
  });

  it('applies p-5 padding by default', () => {
    const { container } = render(<Card>x</Card>);
    const card = container.querySelector('.gf-card')!;
    expect(card.className).toContain('p-5');
  });

  it('omits padding when noPadding is set', () => {
    const { container } = render(<Card noPadding>x</Card>);
    expect(container.querySelector('.gf-card')!.className).not.toContain('p-5');
  });

  it('merges custom className', () => {
    const { container } = render(<Card className="extra-card">x</Card>);
    expect(container.querySelector('.gf-card')!.className).toContain('extra-card');
  });

  it('forwards HTML attributes (role, onClick) to the wrapper', () => {
    render(
      <Card role="region" aria-label="My region">
        x
      </Card>,
    );
    expect(screen.getByRole('region', { name: 'My region' })).toBeInTheDocument();
  });
});
