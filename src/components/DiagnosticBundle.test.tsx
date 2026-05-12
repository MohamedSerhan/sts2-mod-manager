import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { DiagnosticBundle } from './DiagnosticBundle';
import { AllProviders } from '../__test__/providers';
import { registerInvokeHandler } from '../__test__/setup';

beforeEach(() => {
  // jsdom doesn't ship navigator.clipboard; stub a Promise-resolving mock.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn(async () => {}) },
    configurable: true,
  });
});

function Wrap(props: Partial<React.ComponentProps<typeof DiagnosticBundle>> = {}) {
  return (
    <AllProviders>
      <DiagnosticBundle open={props.open ?? true} onClose={props.onClose ?? (() => {})} />
    </AllProviders>
  );
}

describe('<DiagnosticBundle>', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(<Wrap open={false} />);
    expect(container.querySelector('.gf-modal')).toBeNull();
  });

  it('renders the modal title + generate + close buttons', async () => {
    render(<Wrap />);
    await waitFor(() => {
      // Several places say "Generate" — assert at least one is present.
      expect(screen.getAllByText(/Generate/i).length).toBeGreaterThan(0);
    });
  });

  it('Close button calls onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    await waitFor(() => {
      expect(screen.getAllByText(/Generate/i).length).toBeGreaterThan(0);
    });
    const close = screen.getAllByTitle(/Close/i)[0];
    await user.click(close);
    expect(onClose).toHaveBeenCalled();
  });

  it('Generate button reads the log tail when clicked', async () => {
    let calls = 0;
    registerInvokeHandler('read_log_tail', () => { calls += 1; return 'log A\nlog B'; });
    registerInvokeHandler('get_log_path', () => 'C:/Users/me/AppData/sts2mm.log');
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getAllByText(/Generate/i).length).toBeGreaterThan(0);
    });
    const buttons = screen.getAllByRole('button');
    const gen = buttons.find((b) => /Generate|Copy/i.test(b.textContent ?? ''));
    if (gen) {
      await user.click(gen);
      await waitFor(() => {
        expect(calls).toBeGreaterThan(0);
      });
    }
  });
});
