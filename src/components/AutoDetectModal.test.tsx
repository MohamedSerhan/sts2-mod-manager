import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AutoDetectModal } from './AutoDetectModal';
import { AllProviders } from '../__test__/providers';
import { registerInvokeHandler } from '../__test__/setup';

function Wrap(props: Partial<React.ComponentProps<typeof AutoDetectModal>> = {}) {
  return (
    <AllProviders>
      <AutoDetectModal
        open={props.open ?? true}
        onClose={props.onClose ?? (() => {})}
        onApplied={props.onApplied ?? (() => {})}
      />
    </AllProviders>
  );
}

describe('<AutoDetectModal>', () => {
  it('renders nothing when open=false', () => {
    const { container } = render(<Wrap open={false} />);
    expect(container.querySelector('.gf-modal')).toBeNull();
  });

  it('shows a scanning state on open then renders results', async () => {
    let resolver!: (v: unknown) => void;
    registerInvokeHandler('auto_detect_sources', () => new Promise((r) => { resolver = r; }));
    render(<Wrap />);
    // Scanning copy
    await waitFor(() => {
      expect(screen.getByText(/Scanning|scanning/i)).toBeInTheDocument();
    });
    resolver({
      matched: [],
      unmatched: [],
      skipped_already_linked: 0,
    });
    await waitFor(() => {
      // After resolution scanning copy goes away.
      expect(screen.queryByText(/Scanning…/i)).toBeNull();
    });
  });

  it('renders the empty state when nothing matched', async () => {
    registerInvokeHandler('auto_detect_sources', () => ({
      matched: [],
      unmatched: ['Foo'],
      skipped_already_linked: 0,
    }));
    render(<Wrap />);
    await waitFor(() => {
      // Unmatched mods are listed; "No links found" or similar copy appears.
      expect(screen.getByText('Foo')).toBeInTheDocument();
    });
  });

  it('renders high-confidence matches with the apply button enabled', async () => {
    registerInvokeHandler('auto_detect_sources', () => ({
      matched: [
        { mod_name: 'BaseLib', github_repo: 'Alchyr/BaseLib', confidence: 'high' },
      ],
      unmatched: [],
      skipped_already_linked: 0,
    }));
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText('BaseLib')).toBeInTheDocument();
      expect(screen.getByText('Alchyr/BaseLib')).toBeInTheDocument();
    });
  });

  it('toasts an error when auto_detect_sources throws', async () => {
    registerInvokeHandler('auto_detect_sources', () => { throw new Error('rate-limited'); });
    render(<Wrap />);
    await waitFor(() => {
      expect(screen.getByText(/Auto-detect failed.*rate-limited/)).toBeInTheDocument();
    });
  });

  it('Close button fires onClose', async () => {
    registerInvokeHandler('auto_detect_sources', () => ({
      matched: [],
      unmatched: [],
      skipped_already_linked: 0,
    }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<Wrap onClose={onClose} />);
    await waitFor(() => {
      expect(screen.queryByText(/Scanning…/)).toBeNull();
    });
    const xButtons = screen.getAllByTitle(/Close/i);
    await user.click(xButtons[0]);
    expect(onClose).toHaveBeenCalled();
  });
});
