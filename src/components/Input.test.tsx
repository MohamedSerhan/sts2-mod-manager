import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Input } from './Input';

describe('<Input>', () => {
  it('renders an <input>', () => {
    render(<Input placeholder="Type here" />);
    expect(screen.getByPlaceholderText('Type here')).toBeInTheDocument();
  });

  it('renders a <label> when label prop is supplied and links it via htmlFor', () => {
    render(<Input label="Nexus key" placeholder="paste here" />);
    const label = screen.getByText('Nexus key');
    expect(label.tagName).toBe('LABEL');
    expect(label).toHaveAttribute('for', 'nexus-key'); // slug derived from label
    expect(screen.getByPlaceholderText('paste here')).toHaveAttribute('id', 'nexus-key');
  });

  it('honors an explicit id over the derived slug', () => {
    render(<Input label="Nexus" id="my-id" />);
    expect(screen.getByLabelText('Nexus')).toHaveAttribute('id', 'my-id');
  });

  it('omits the label element when label prop is absent', () => {
    const { container } = render(<Input placeholder="x" />);
    expect(container.querySelector('label')).toBeNull();
  });

  it('forwards onChange', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Input placeholder="x" onChange={onChange} />);
    await user.type(screen.getByPlaceholderText('x'), 'hi');
    expect(onChange).toHaveBeenCalled();
  });

  it('merges custom className with gf-input', () => {
    render(<Input placeholder="x" className="extra" />);
    const input = screen.getByPlaceholderText('x');
    expect(input.className).toContain('gf-input');
    expect(input.className).toContain('extra');
  });
});
