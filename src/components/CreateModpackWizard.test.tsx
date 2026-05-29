/**
 * Tests for the 4-step CreateModpackWizard (Start → Choose → Health → Finish).
 *
 * Coverage targets:
 *   - Happy path (from-active → choose → health → create) calls onCreated with
 *     the right name and sharedNow=false.
 *   - Cancel at each step closes the wizard.
 *   - Back at steps 2/3/4 returns to the previous step.
 *   - "Create and share now" branch calls onCreated with sharedNow=true.
 *   - Empty name disables both Create buttons.
 *   - GitHub-not-mentioned invariant for steps 1, 2, 3 (allowed only at the
 *     bottom of step 4 in the share-hint copy).
 *   - "Clone" strategy is hidden when no profiles exist, shown when ≥1.
 *   - Step 3 health summary reads counts from a mocked audit_mod_versions.
 *   - The mod picker pre-selection persists across Back/Next navigation.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CreateModpackWizard } from './CreateModpackWizard';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import type { ModAuditEntry, ModInfo, Profile } from '../types';

const baseMod = (overrides: Partial<ModInfo> = {}): ModInfo => ({
  name: 'Mod A',
  version: '1.0.0',
  description: 'desc',
  enabled: false,
  files: ['Mod A/mod.dll'],
  source: null,
  hash: null,
  dependencies: [],
  size_bytes: 1024,
  folder_name: 'mod-a',
  mod_id: null,
  github_url: null,
  nexus_url: null,
  pinned: false,
  min_game_version: null,
  author: null,
  note: null,
  custom_url: null,
  display_name: null,
  display_description: null,
  ...overrides,
});

const baseProfile = (overrides: Partial<Profile> = {}): Profile => ({
  name: 'Existing Pack',
  game_version: null,
  created_by: null,
  mods: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
});

const baseAudit = (overrides: Partial<ModAuditEntry> = {}): ModAuditEntry => ({
  mod_name: 'Mod A',
  folder_name: 'mod-a',
  github_repo: null,
  installed_version: '1.0.0',
  latest_release_tag: null,
  latest_release_with_assets_tag: null,
  latest_has_assets: false,
  needs_update: false,
  asset_names: [],
  releases_scanned: 0,
  error: null,
  nexus_url: null,
  nexus_version: null,
  nexus_update_available: false,
  update_source: null,
  github_auto_detected: false,
  pinned: false,
  game_version_too_old: false,
  ...overrides,
});

function seed(opts: {
  mods?: ModInfo[];
  profiles?: Profile[];
  audit?: ModAuditEntry[];
  onCreate?: (name: string) => Profile;
} = {}) {
  registerInvokeHandler('get_installed_mods', () => opts.mods ?? []);
  registerInvokeHandler('list_profiles_cmd', () => opts.profiles ?? []);
  registerInvokeHandler('audit_mod_versions', () => opts.audit ?? []);
  registerInvokeHandler('create_profile', (args) => {
    const name = String(args?.name ?? '');
    return (opts.onCreate ?? ((n) => baseProfile({ name: n })))(name);
  });
  registerInvokeHandler('set_profile_mod_membership', (args) =>
    baseProfile({ name: String(args?.profileName ?? '') }),
  );
}

function Wrap(props: { onClose?: () => void; onCreated?: (r: { name: string; sharedNow: boolean }) => void } = {}) {
  return (
    <AllProviders>
      <CreateModpackWizard
        onClose={props.onClose ?? (() => {})}
        onCreated={props.onCreated ?? (() => {})}
      />
    </AllProviders>
  );
}

async function waitForStep1() {
  return await screen.findByRole('button', { name: /start from my active mods/i });
}

async function chooseFromActive() {
  fireEvent.click(await waitForStep1());
}

async function clickNext() {
  fireEvent.click(await screen.findByRole('button', { name: /^next$/i }));
}

async function clickContinueAnyway() {
  fireEvent.click(await screen.findByRole('button', { name: /continue anyway/i }));
}

describe('<CreateModpackWizard>', () => {
  beforeEach(() => {
    // Each test seeds its own data — but the safe defaults register []
    // for get_installed_mods, list_profiles_cmd, audit_mod_versions.
  });

  describe('happy path', () => {
    it('from-active → choose → health → create calls onCreated with name and sharedNow=false', async () => {
      const enabledMod = baseMod({ name: 'Active One', enabled: true, folder_name: 'active-one' });
      const inactiveMod = baseMod({ name: 'Sleeper', enabled: false, folder_name: 'sleeper' });
      seed({ mods: [enabledMod, inactiveMod] });
      const onCreated = vi.fn();
      render(<Wrap onCreated={onCreated} />);

      // Step 1
      await chooseFromActive();

      // Step 2 — confirm pre-selection happened (Active One checked, Sleeper not).
      // Selection count should read "1 selected" because only Active One is enabled.
      await waitFor(() => {
        expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
      });
      await clickNext();

      // Step 3 — show health, click Continue anyway.
      await clickContinueAnyway();

      // Step 4 — enter name, click Create.
      const nameInput = await screen.findByLabelText(/modpack name/i);
      fireEvent.change(nameInput, { target: { value: 'My Test Pack' } });
      fireEvent.click(screen.getByRole('button', { name: /^create modpack$/i }));

      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledWith({ name: 'My Test Pack', sharedNow: false });
      });

      // create_profile invoked with the trimmed name.
      expect(
        getInvokeCalls().some(
          (c) => c.cmd === 'create_profile' && c.args?.name === 'My Test Pack',
        ),
      ).toBe(true);

      // set_profile_mod_membership invoked for the pre-selected mod.
      expect(
        getInvokeCalls().some(
          (c) =>
            c.cmd === 'set_profile_mod_membership' &&
            c.args?.modName === 'Active One' &&
            c.args?.included === true,
        ),
      ).toBe(true);
    });
  });

  describe('cancel', () => {
    it('cancel on step 1 closes wizard', async () => {
      seed();
      const onClose = vi.fn();
      render(<Wrap onClose={onClose} />);
      await waitForStep1();
      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
      expect(onClose).toHaveBeenCalled();
    });

    it('cancel on step 2 closes wizard', async () => {
      seed({ mods: [baseMod({ name: 'A', enabled: true })] });
      const onClose = vi.fn();
      render(<Wrap onClose={onClose} />);
      await chooseFromActive();
      // Wait for step 2.
      await screen.findByPlaceholderText(/search installed mods/i);
      // Find the dialog footer's Cancel button (not the dialog header X if any).
      const cancelButtons = screen.getAllByRole('button', { name: /^cancel$/i });
      fireEvent.click(cancelButtons[0]);
      expect(onClose).toHaveBeenCalled();
    });

    it('cancel on step 3 closes wizard', async () => {
      seed({ mods: [baseMod({ name: 'A', enabled: true })] });
      const onClose = vi.fn();
      render(<Wrap onClose={onClose} />);
      await chooseFromActive();
      await clickNext();
      // Step 3 has a Continue anyway button.
      await screen.findByRole('button', { name: /continue anyway/i });
      const cancelButtons = screen.getAllByRole('button', { name: /^cancel$/i });
      fireEvent.click(cancelButtons[0]);
      expect(onClose).toHaveBeenCalled();
    });

    it('cancel on step 4 closes wizard', async () => {
      seed({ mods: [baseMod({ name: 'A', enabled: true })] });
      const onClose = vi.fn();
      render(<Wrap onClose={onClose} />);
      await chooseFromActive();
      await clickNext();
      await clickContinueAnyway();
      // Step 4 has the name input.
      await screen.findByLabelText(/modpack name/i);
      const cancelButtons = screen.getAllByRole('button', { name: /^cancel$/i });
      fireEvent.click(cancelButtons[0]);
      expect(onClose).toHaveBeenCalled();
    });
  });

  describe('back navigation', () => {
    it('back at step 2 returns to step 1', async () => {
      seed({ mods: [baseMod({ name: 'A', enabled: true })] });
      render(<Wrap />);
      await chooseFromActive();
      // We're at step 2 — the search box is rendered.
      await screen.findByPlaceholderText(/search installed mods/i);
      fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
      // Step 1 surface is back — the "Start from my active mods" button is rendered again.
      expect(await screen.findByRole('button', { name: /start from my active mods/i })).toBeInTheDocument();
    });

    it('back at step 3 returns to step 2', async () => {
      seed({ mods: [baseMod({ name: 'A', enabled: true })] });
      render(<Wrap />);
      await chooseFromActive();
      await clickNext();
      // Step 3 has Continue anyway.
      await screen.findByRole('button', { name: /continue anyway/i });
      fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
      // Back to step 2 — search input is visible again.
      expect(await screen.findByPlaceholderText(/search installed mods/i)).toBeInTheDocument();
    });

    it('back at step 4 returns to step 3', async () => {
      seed({ mods: [baseMod({ name: 'A', enabled: true })] });
      render(<Wrap />);
      await chooseFromActive();
      await clickNext();
      await clickContinueAnyway();
      // Step 4 has the name input.
      await screen.findByLabelText(/modpack name/i);
      fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
      // Back to step 3 — Continue anyway is back.
      expect(await screen.findByRole('button', { name: /continue anyway/i })).toBeInTheDocument();
    });
  });

  describe('share-now branch', () => {
    it('Create and share now calls onCreated with sharedNow=true', async () => {
      seed({ mods: [baseMod({ name: 'A', enabled: true })] });
      const onCreated = vi.fn();
      render(<Wrap onCreated={onCreated} />);
      await chooseFromActive();
      await clickNext();
      await clickContinueAnyway();
      const nameInput = await screen.findByLabelText(/modpack name/i);
      fireEvent.change(nameInput, { target: { value: 'Shared Pack' } });
      fireEvent.click(screen.getByRole('button', { name: /create and share now/i }));
      await waitFor(() => {
        expect(onCreated).toHaveBeenCalledWith({ name: 'Shared Pack', sharedNow: true });
      });
    });
  });

  describe('empty name guard', () => {
    it('disables both create buttons when name is empty', async () => {
      seed({ mods: [baseMod({ name: 'A', enabled: true })] });
      render(<Wrap />);
      await chooseFromActive();
      await clickNext();
      await clickContinueAnyway();
      await screen.findByLabelText(/modpack name/i);
      const createBtn = screen.getByRole('button', { name: /^create modpack$/i });
      const shareBtn = screen.getByRole('button', { name: /create and share now/i });
      expect(createBtn).toBeDisabled();
      expect(shareBtn).toBeDisabled();
    });

    it('disables both create buttons when name is whitespace only', async () => {
      seed({ mods: [baseMod({ name: 'A', enabled: true })] });
      render(<Wrap />);
      await chooseFromActive();
      await clickNext();
      await clickContinueAnyway();
      const nameInput = await screen.findByLabelText(/modpack name/i);
      fireEvent.change(nameInput, { target: { value: '   ' } });
      expect(screen.getByRole('button', { name: /^create modpack$/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /create and share now/i })).toBeDisabled();
    });
  });

  describe('github-not-mentioned invariant', () => {
    it('does not mention GitHub on steps 1, 2, 3', async () => {
      // Seed mods that have github_url to ensure we never bleed it into the UI.
      seed({
        mods: [
          baseMod({
            name: 'Linked One',
            enabled: true,
            github_url: 'https://github.com/owner/repo',
          }),
        ],
        profiles: [baseProfile({ name: 'Old Pack' })], // so clone option also shows
      });
      render(<Wrap />);
      // Step 1.
      await waitForStep1();
      expect(screen.queryByText(/github/i)).toBeNull();
      // Step 2.
      await chooseFromActive();
      await screen.findByPlaceholderText(/search installed mods/i);
      expect(screen.queryByText(/github/i)).toBeNull();
      // Step 3.
      await clickNext();
      await screen.findByRole('button', { name: /continue anyway/i });
      expect(screen.queryByText(/github/i)).toBeNull();
    });

    it('mentions GitHub only inside the share-hint on step 4', async () => {
      seed({ mods: [baseMod({ name: 'A', enabled: true })] });
      render(<Wrap />);
      await chooseFromActive();
      await clickNext();
      await clickContinueAnyway();
      await screen.findByLabelText(/modpack name/i);
      // One match expected — the hint copy beside Create-and-share-now.
      const matches = screen.queryAllByText(/github/i);
      expect(matches.length).toBe(1);
    });
  });

  describe('clone option visibility', () => {
    it('hides the Clone strategy when no profiles exist', async () => {
      seed({ profiles: [] });
      render(<Wrap />);
      await waitForStep1();
      expect(screen.queryByRole('button', { name: /clone an existing modpack/i })).toBeNull();
    });

    it('shows the Clone strategy when at least one profile exists', async () => {
      seed({ profiles: [baseProfile({ name: 'Old Pack' })] });
      render(<Wrap />);
      // Wait for profiles to load.
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /clone an existing modpack/i })).toBeInTheDocument();
      });
    });
  });

  describe('step 3 health summary', () => {
    it('reads counts from the mocked audit_mod_versions response', async () => {
      seed({
        mods: [
          baseMod({
            name: 'Linked Update',
            enabled: true,
            folder_name: 'linked-update',
            github_url: 'https://github.com/owner/linked',
          }),
          baseMod({
            name: 'Blocked One',
            enabled: true,
            folder_name: 'blocked-one',
          }),
          baseMod({
            name: 'Frozen One',
            enabled: true,
            folder_name: 'frozen-one',
          }),
        ],
        audit: [
          baseAudit({ mod_name: 'Linked Update', folder_name: 'linked-update', needs_update: true }),
          baseAudit({ mod_name: 'Blocked One', folder_name: 'blocked-one', game_version_too_old: true }),
          baseAudit({ mod_name: 'Frozen One', folder_name: 'frozen-one', pinned: true }),
        ],
      });
      render(<Wrap />);
      await chooseFromActive();
      await clickNext();
      // Wait for the health summary lines to materialize.
      await waitFor(() => {
        // "1 mod has a linked source" — only Linked Update has a github_url.
        expect(screen.getByText(/1 mod has a linked source/i)).toBeInTheDocument();
      });
      expect(screen.getByText(/1 mod has updates available/i)).toBeInTheDocument();
      expect(screen.getByText(/1 mod needs a newer game version/i)).toBeInTheDocument();
      expect(screen.getByText(/1 frozen mod will stay at its current version/i)).toBeInTheDocument();
    });
  });

  describe('mod selection persists across navigation', () => {
    it('preserves user selections when navigating back and forward', async () => {
      seed({
        mods: [
          baseMod({ name: 'A', enabled: true, folder_name: 'a' }),
          baseMod({ name: 'B', enabled: true, folder_name: 'b' }),
        ],
      });
      render(<Wrap />);
      await chooseFromActive();
      // Both A and B pre-selected (both enabled). Selection count = 2.
      await waitFor(() => {
        expect(screen.getByText(/2 selected/i)).toBeInTheDocument();
      });
      // Uncheck B.
      const bRow = screen.getByLabelText(/^B$/i);
      fireEvent.click(bRow);
      await waitFor(() => {
        expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
      });
      // Step 3 then Back to step 2.
      await clickNext();
      await screen.findByRole('button', { name: /continue anyway/i });
      fireEvent.click(screen.getByRole('button', { name: /^back$/i }));
      // Selection persisted.
      await waitFor(() => {
        expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
      });
    });
  });

  describe('search and sort', () => {
    it('filters the mod list by name (case-insensitive)', async () => {
      seed({
        mods: [
          baseMod({ name: 'Alpha Power', enabled: false, folder_name: 'alpha' }),
          baseMod({ name: 'Beta Tools', enabled: false, folder_name: 'beta' }),
        ],
      });
      render(<Wrap />);
      // Use Empty strategy so neither is pre-selected.
      fireEvent.click(await screen.findByRole('button', { name: /start empty/i }));
      const search = await screen.findByPlaceholderText(/search installed mods/i);
      // Both visible initially.
      expect(screen.getByLabelText(/alpha power/i)).toBeInTheDocument();
      expect(screen.getByLabelText(/beta tools/i)).toBeInTheDocument();
      // Filter to alpha.
      fireEvent.change(search, { target: { value: 'ALPHA' } });
      expect(screen.getByLabelText(/alpha power/i)).toBeInTheDocument();
      expect(screen.queryByLabelText(/beta tools/i)).toBeNull();
    });

    it('sort by Size orders larger mods first (covers sort==="size" branch)', async () => {
      // Two mods with different size_bytes — sort should put the bigger
      // one first regardless of name. We pin the visible order by
      // reading the rendered checkbox labels in document order.
      seed({
        mods: [
          baseMod({ name: 'SmallMod', enabled: false, folder_name: 's', size_bytes: 1024 }),
          baseMod({ name: 'BigMod', enabled: false, folder_name: 'b', size_bytes: 9_000_000 }),
        ],
      });
      render(<Wrap />);
      fireEvent.click(await screen.findByRole('button', { name: /start empty/i }));
      const sortSelect = await screen.findByLabelText(/sort/i) as HTMLSelectElement;
      fireEvent.change(sortSelect, { target: { value: 'size' } });
      // Find the labels in document order — the bigger mod should appear first.
      const labels = await screen.findAllByText(/^(SmallMod|BigMod)$/);
      expect(labels[0]).toHaveTextContent('BigMod');
      expect(labels[1]).toHaveTextContent('SmallMod');
    });

    it('sort by Enabled orders enabled mods first (covers sort==="enabled" branch)', async () => {
      seed({
        mods: [
          baseMod({ name: 'Disabled', enabled: false, folder_name: 'd' }),
          baseMod({ name: 'Enabled', enabled: true, folder_name: 'e' }),
        ],
      });
      render(<Wrap />);
      fireEvent.click(await screen.findByRole('button', { name: /start empty/i }));
      const sortSelect = await screen.findByLabelText(/sort/i) as HTMLSelectElement;
      fireEvent.change(sortSelect, { target: { value: 'enabled' } });
      const labels = await screen.findAllByText(/^(Disabled|Enabled)$/);
      expect(labels[0]).toHaveTextContent('Enabled');
      expect(labels[1]).toHaveTextContent('Disabled');
    });
  });

  // ── Clone strategy ───────────────────────────────────────────────
  // The clone strategy seeds selectedMods from an existing profile's
  // mod list. Unlike "from active" / "empty", clone needs a follow-up
  // dropdown to pick which existing modpack to clone from. Without
  // these tests, the clone-strategy branch in applyStrategyAndAdvance
  // (lines 110-112) sits uncovered.
  describe('clone strategy', () => {
    it('clicking the Clone tile then picking a profile + Next seeds selection from that profile', async () => {
      seed({
        mods: [
          baseMod({ name: 'PackedMod', enabled: false, folder_name: 'pm' }),
          baseMod({ name: 'OtherMod', enabled: false, folder_name: 'om' }),
        ],
        profiles: [
          {
            ...baseProfile({ name: 'Source Pack' }),
            mods: [{
              name: 'PackedMod', version: '1.0', source: null, hash: null,
              files: [], enabled: true, bundle_url: null,
              folder_name: 'pm', mod_id: 'PackedMod',
            }],
          },
        ],
      });
      render(<Wrap />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /clone an existing modpack/i })).toBeInTheDocument();
      });
      // 1. Click the Clone tile — sets strategy='clone' but does NOT advance.
      fireEvent.click(screen.getByRole('button', { name: /clone an existing modpack/i }));
      // 2. The clone-pick dropdown appears.
      const pick = await screen.findByLabelText(/pick a modpack to clone/i);
      // 3. Choose the existing pack.
      fireEvent.change(pick, { target: { value: 'Source Pack' } });
      // 4. Click the dedicated Next button below the dropdown.
      const allNexts = screen.getAllByRole('button', { name: /^next$/i });
      // The dropdown's Next button is the one inside the clone-pick div.
      const pickContainer = pick.closest('.gf-create-wizard-clone-pick');
      const cloneNext = allNexts.find((b) => pickContainer?.contains(b));
      expect(cloneNext).toBeDefined();
      fireEvent.click(cloneNext!);
      // 5. The wizard advances to step 2 with PackedMod selected (1 mod).
      await waitFor(() => {
        expect(screen.getByText(/1 selected/i)).toBeInTheDocument();
      });
    });
  });

  // ── Error paths: audit catch + create catch ───────────────────────
  describe('error paths', () => {
    it('audit failure leaves the health summary at zeros (covers goToHealth catch)', async () => {
      seed({
        mods: [baseMod({ name: 'A', enabled: true })],
      });
      registerInvokeHandler('audit_mod_versions', () => { throw new Error('rate-limited'); });
      render(<Wrap />);
      await chooseFromActive();
      await clickNext();
      // Step 3 with zeros + Continue anyway button present.
      await screen.findByRole('button', { name: /continue anyway/i });
      // Linked count is 0 (the catch sets health to all zeros).
      expect(screen.getByText(/0 mods have linked sources/i)).toBeInTheDocument();
    });

    it('create_profile failure surfaces an inline error (covers handleCreate catch)', async () => {
      seed({
        mods: [baseMod({ name: 'A', enabled: true })],
      });
      registerInvokeHandler('create_profile', () => { throw new Error('disk full'); });
      render(<Wrap />);
      await chooseFromActive();
      await clickNext();
      await clickContinueAnyway();
      const nameInput = await screen.findByLabelText(/modpack name/i);
      fireEvent.change(nameInput, { target: { value: 'FailPack' } });
      fireEvent.click(screen.getByRole('button', { name: /^create modpack$/i }));
      // The error string appears in the wizard body (handleCreate catch
      // sets createError → displayed near the Create button).
      await waitFor(() => {
        expect(screen.getByText(/disk full/i)).toBeInTheDocument();
      });
    });
  });

  // ── Bulk select / deselect ────────────────────────────────────────
  describe('select all', () => {
    it('Select all checks every visible mod, then Deselect all clears them', async () => {
      seed({
        mods: [
          baseMod({ name: 'A', enabled: false, folder_name: 'a' }),
          baseMod({ name: 'B', enabled: false, folder_name: 'b' }),
          baseMod({ name: 'C', enabled: false, folder_name: 'c' }),
        ],
      });
      render(<Wrap />);
      // Start empty so nothing is pre-selected.
      fireEvent.click(await screen.findByRole('button', { name: /start empty/i }));
      await screen.findByPlaceholderText(/search installed mods/i);
      await waitFor(() => { expect(screen.getByText(/0 selected/i)).toBeInTheDocument(); });

      // Select all → all three checked, button flips to Deselect all.
      fireEvent.click(screen.getByRole('button', { name: /^select all$/i }));
      await waitFor(() => { expect(screen.getByText(/3 selected/i)).toBeInTheDocument(); });

      // Deselect all → back to none.
      fireEvent.click(screen.getByRole('button', { name: /^deselect all$/i }));
      await waitFor(() => { expect(screen.getByText(/0 selected/i)).toBeInTheDocument(); });
    });
  });

  // ── Step 3 must never trap the user ───────────────────────────────
  describe('step 3 escape hatch', () => {
    it('lets the user Continue anyway while the audit is still running', async () => {
      // Audit handler that never settles on its own — proves step 3 never
      // strands the user behind a slow/stalled check.
      seed({ mods: [baseMod({ name: 'A', enabled: true })] });
      let resolveAudit!: (v: ModAuditEntry[]) => void;
      registerInvokeHandler(
        'audit_mod_versions',
        () => new Promise<ModAuditEntry[]>((r) => { resolveAudit = r; }),
      );
      render(<Wrap />);
      await chooseFromActive();
      await clickNext();

      // Still "Checking…", but Continue anyway is enabled and works.
      const continueBtn = await screen.findByRole('button', { name: /continue anyway/i });
      expect(continueBtn).toBeEnabled();
      fireEvent.click(continueBtn);
      expect(await screen.findByLabelText(/modpack name/i)).toBeInTheDocument();

      // Settle the dangling audit so withTimeout clears its timer.
      await act(async () => { resolveAudit([]); });
    });
  });
});
