import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AutoDetectModal } from './AutoDetectModal';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

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
  describe('open / scanning lifecycle', () => {
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

    it('toasts an error when auto_detect_sources throws', async () => {
      registerInvokeHandler('auto_detect_sources', () => { throw new Error('rate-limited'); });
      render(<Wrap />);
      await waitFor(() => {
        expect(screen.getByText(/Auto-detect failed.*rate-limited/)).toBeInTheDocument();
      });
    });

    it('coerces non-Error rejections into a string in the failure toast', async () => {
      registerInvokeHandler('auto_detect_sources', () => Promise.reject('boom'));
      render(<Wrap />);
      await waitFor(() => {
        expect(screen.getByText(/Auto-detect failed: boom/)).toBeInTheDocument();
      });
    });
  });

  describe('empty / no-result states', () => {
    it('renders the no-mods empty state when nothing matched and skipped_already_linked is 0', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [],
        unmatched: [],
        skipped_already_linked: 0,
      }));
      render(<Wrap />);
      await waitFor(() => {
        expect(screen.getByText(/No mods to scan/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/Install some mods first/i)).toBeInTheDocument();
    });

    it('renders the "everything already linked" empty state (singular copy)', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [],
        unmatched: [],
        skipped_already_linked: 1,
      }));
      render(<Wrap />);
      await waitFor(() => {
        expect(screen.getByText(/every mod already has a source/i)).toBeInTheDocument();
      });
      // singular "has" branch
      expect(screen.getByText(/All 1 installed mod has a GitHub or Nexus link/i)).toBeInTheDocument();
    });

    it('renders the "everything already linked" empty state (plural copy)', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [],
        unmatched: [],
        skipped_already_linked: 4,
      }));
      render(<Wrap />);
      await waitFor(() => {
        expect(screen.getByText(/All 4 installed mods have a GitHub or Nexus link/i)).toBeInTheDocument();
      });
    });
  });

  describe('result list rendering', () => {
    it('renders high-confidence matches, ambiguous matches, unmatched mods, and the skipped-linked footer', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [
          { mod_name: 'BaseLib', github_repo: 'Alchyr/BaseLib', confidence: 'high' },
          { mod_name: 'Anniv6', github_repo: 'maintainer/Anniv6', confidence: 'low' },
        ],
        unmatched: ['MysteryMod'],
        skipped_already_linked: 2,
      }));
      render(<Wrap />);
      await waitFor(() => {
        expect(screen.getByText('BaseLib')).toBeInTheDocument();
      });
      // ambiguous row + its confidence label
      expect(screen.getByText('Anniv6')).toBeInTheDocument();
      expect(screen.getByText('maintainer/Anniv6')).toBeInTheDocument();
      expect(screen.getByText('low')).toBeInTheDocument();
      // unmatched row
      expect(screen.getByText('MysteryMod')).toBeInTheDocument();
      expect(screen.getByText('no candidates')).toBeInTheDocument();
      // skipped-already-linked footer (plural branch within the results pane)
      expect(screen.getByText(/2 mods skipped — already linked/i)).toBeInTheDocument();
    });

    it('renders the singular skipped-linked footer when only one mod was skipped', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [
          { mod_name: 'BaseLib', github_repo: 'Alchyr/BaseLib', confidence: 'high' },
        ],
        unmatched: [],
        skipped_already_linked: 1,
      }));
      render(<Wrap />);
      await waitFor(() => {
        expect(screen.getByText(/1 mod skipped — already linked/i)).toBeInTheDocument();
      });
    });
  });

  describe('skip toggle on high-confidence rows', () => {
    it('clicking a high-confidence row toggles its skip state and the apply count', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [
          { mod_name: 'BaseLib', github_repo: 'Alchyr/BaseLib', confidence: 'high' },
          { mod_name: 'TickRate', github_repo: 'foo/TickRate', confidence: 'high' },
        ],
        unmatched: [],
        skipped_already_linked: 0,
      }));
      const user = userEvent.setup();
      render(<Wrap />);
      const baseLibRow = await screen.findByText('BaseLib');
      // Initial: both rows say "link", apply button reads "Apply 2 matches"
      expect(screen.getAllByText('link')).toHaveLength(2);
      expect(screen.getByRole('button', { name: /Apply 2 matches/ })).toBeInTheDocument();

      // First click skips BaseLib → one row flips to "skip", apply becomes "Apply 1 match"
      await user.click(baseLibRow);
      expect(screen.getByText('skip')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Apply 1 match/ })).toBeInTheDocument();

      // Second click un-skips BaseLib → back to "Apply 2 matches"
      await user.click(baseLibRow);
      expect(screen.queryByText('skip')).toBeNull();
      expect(screen.getByRole('button', { name: /Apply 2 matches/ })).toBeInTheDocument();
    });

    it('skipping every high-confidence match hides the Apply button entirely', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [
          { mod_name: 'OnlyOne', github_repo: 'me/OnlyOne', confidence: 'high' },
        ],
        unmatched: [],
        skipped_already_linked: 0,
      }));
      const user = userEvent.setup();
      render(<Wrap />);
      const row = await screen.findByText('OnlyOne');
      await user.click(row);
      // willApply.length === 0 → Apply button is not rendered
      expect(screen.queryByRole('button', { name: /Apply/ })).toBeNull();
    });
  });

  describe('handleApply', () => {
    it('writes set_mod_source for every non-skipped high-confidence match and closes', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [
          { mod_name: 'BaseLib', github_repo: 'Alchyr/BaseLib', confidence: 'high' },
          { mod_name: 'TickRate', github_repo: 'foo/TickRate', confidence: 'high' },
        ],
        unmatched: [],
        skipped_already_linked: 0,
      }));
      registerInvokeHandler('set_mod_source', () => ({}));
      const onApplied = vi.fn();
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<Wrap onApplied={onApplied} onClose={onClose} />);
      const apply = await screen.findByRole('button', { name: /Apply 2 matches/ });
      await user.click(apply);

      await waitFor(() => {
        expect(onApplied).toHaveBeenCalledTimes(1);
      });
      expect(onClose).toHaveBeenCalledTimes(1);

      const setCalls = getInvokeCalls().filter((c) => c.cmd === 'set_mod_source');
      expect(setCalls).toHaveLength(2);
      expect(setCalls[0].args).toEqual({
        modName: 'BaseLib',
        folderName: null,
        sourceUrl: 'github:Alchyr/BaseLib',
      });
      expect(setCalls[1].args).toEqual({
        modName: 'TickRate',
        folderName: null,
        sourceUrl: 'github:foo/TickRate',
      });
      // Success toast — plural form
      expect(screen.getByText(/Linked 2 mods to GitHub sources/i)).toBeInTheDocument();
    });

    it('uses the singular success toast when exactly one mod links', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [
          { mod_name: 'BaseLib', github_repo: 'Alchyr/BaseLib', confidence: 'high' },
        ],
        unmatched: [],
        skipped_already_linked: 0,
      }));
      registerInvokeHandler('set_mod_source', () => ({}));
      const user = userEvent.setup();
      render(<Wrap />);
      const apply = await screen.findByRole('button', { name: /Apply 1 match/ });
      await user.click(apply);
      await waitFor(() => {
        expect(screen.getByText(/Linked 1 mod to GitHub sources/i)).toBeInTheDocument();
      });
    });

    it('emits the partial-failure toast when some set_mod_source calls throw', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [
          { mod_name: 'GoodMod', github_repo: 'me/GoodMod', confidence: 'high' },
          { mod_name: 'BadMod', github_repo: 'me/BadMod', confidence: 'high' },
        ],
        unmatched: [],
        skipped_already_linked: 0,
      }));
      registerInvokeHandler('set_mod_source', (args) => {
        if (args?.modName === 'BadMod') throw new Error('disk full');
        return {};
      });
      const onApplied = vi.fn();
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<Wrap onApplied={onApplied} onClose={onClose} />);
      const apply = await screen.findByRole('button', { name: /Apply 2 matches/ });
      await user.click(apply);
      await waitFor(() => {
        expect(screen.getByText(/1 linked · 1 failed/)).toBeInTheDocument();
      });
      expect(onApplied).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('skips already-skipped rows so set_mod_source is only called for live picks', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [
          { mod_name: 'KeepMe', github_repo: 'me/KeepMe', confidence: 'high' },
          { mod_name: 'SkipMe', github_repo: 'me/SkipMe', confidence: 'high' },
        ],
        unmatched: [],
        skipped_already_linked: 0,
      }));
      registerInvokeHandler('set_mod_source', () => ({}));
      const user = userEvent.setup();
      render(<Wrap />);
      const skipRow = await screen.findByText('SkipMe');
      await user.click(skipRow); // mark SkipMe as skipped
      const apply = screen.getByRole('button', { name: /Apply 1 match/ });
      await user.click(apply);
      await waitFor(() => {
        expect(screen.getByText(/Linked 1 mod to GitHub sources/i)).toBeInTheDocument();
      });
      const setCalls = getInvokeCalls().filter((c) => c.cmd === 'set_mod_source');
      expect(setCalls).toHaveLength(1);
      expect(setCalls[0].args).toMatchObject({ modName: 'KeepMe' });
    });
  });

  describe('rate-limited banner', () => {
    it('shows the rate-limited banner when rate_limited is true', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [],
        unmatched: ['SearchedMod'],
        not_checked: ['ThrottledMod'],
        skipped_already_linked: 0,
        rate_limited: true,
        rate_limit_reset_at: null,
        authenticated: false,
      }));
      render(<Wrap />);
      // Identify the banner by its unique "GitHub rate-limited" copy — role="alert"
      // alone is ambiguous because the global toast region is also role="alert".
      const banner = await screen.findByText(/GitHub rate-limited/i);
      expect(banner).toBeInTheDocument();
      // It is exposed as an alert for a11y.
      expect(banner.closest('[role="alert"]')).not.toBeNull();
    });

    it('does NOT show the banner when rate_limited is false', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [{ mod_name: 'BaseLib', github_repo: 'Alchyr/BaseLib', confidence: 'high' }],
        unmatched: [],
        not_checked: [],
        skipped_already_linked: 0,
        rate_limited: false,
        rate_limit_reset_at: null,
        authenticated: true,
      }));
      render(<Wrap />);
      await waitFor(() => {
        expect(screen.getByText('BaseLib')).toBeInTheDocument();
      });
      expect(screen.queryByText(/GitHub rate-limited/i)).toBeNull();
    });

    it('does NOT show the banner when rate_limited is absent', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [],
        unmatched: ['UnfoundMod'],
        skipped_already_linked: 0,
      }));
      render(<Wrap />);
      await waitFor(() => {
        expect(screen.getByText('UnfoundMod')).toBeInTheDocument();
      });
      expect(screen.queryByText(/GitHub rate-limited/i)).toBeNull();
    });

    it('shows "not checked" rows for mods in not_checked and does NOT label them "no candidates"', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [],
        unmatched: [],
        not_checked: ['ThrottledMod'],
        skipped_already_linked: 0,
        rate_limited: true,
        rate_limit_reset_at: null,
        authenticated: false,
      }));
      render(<Wrap />);
      await waitFor(() => {
        expect(screen.getByText('ThrottledMod')).toBeInTheDocument();
      });
      expect(screen.getByText(/search was rate-limited/i)).toBeInTheDocument();
      // Must NOT say "no candidates" for a throttled mod.
      expect(screen.queryByText('no candidates')).toBeNull();
    });

    it('shows the not-checked stat badge when not_checked is non-empty', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [{ mod_name: 'BaseLib', github_repo: 'Alchyr/BaseLib', confidence: 'high' }],
        unmatched: [],
        not_checked: ['ThrottledMod', 'OtherMod'],
        skipped_already_linked: 0,
        rate_limited: true,
        rate_limit_reset_at: null,
        authenticated: true,
      }));
      render(<Wrap />);
      await waitFor(() => {
        expect(screen.getByText('BaseLib')).toBeInTheDocument();
      });
      // The "not checked" stat badge (count=2) must appear.
      expect(screen.getByText('not checked')).toBeInTheDocument();
    });
  });

  describe('dismiss affordances', () => {
    it('Close (X) button fires onClose', async () => {
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
      const closeBtn = screen.getByRole('button', { name: /Close/i });
      await user.click(closeBtn);
      expect(onClose).toHaveBeenCalled();
    });

    it('Cancel footer button fires onClose', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [],
        unmatched: [],
        skipped_already_linked: 0,
      }));
      const onClose = vi.fn();
      const user = userEvent.setup();
      render(<Wrap onClose={onClose} />);
      const cancel = await screen.findByRole('button', { name: /Cancel/i });
      await user.click(cancel);
      expect(onClose).toHaveBeenCalled();
    });

    it('clicking the modal backdrop fires onClose but clicks inside the dialog do not', async () => {
      registerInvokeHandler('auto_detect_sources', () => ({
        matched: [],
        unmatched: [],
        skipped_already_linked: 0,
      }));
      const onClose = vi.fn();
      const user = userEvent.setup();
      const { container } = render(<Wrap onClose={onClose} />);
      await waitFor(() => {
        expect(screen.queryByText(/Scanning…/)).toBeNull();
      });
      // Inside-dialog click must not bubble to backdrop's onClose
      const dialog = container.querySelector('.gf-modal');
      expect(dialog).not.toBeNull();
      await user.click(dialog!);
      expect(onClose).not.toHaveBeenCalled();

      // Backdrop click does close
      const backdrop = container.querySelector('.gf-modal-back');
      expect(backdrop).not.toBeNull();
      await user.click(backdrop!);
      expect(onClose).toHaveBeenCalled();
    });
  });
});
