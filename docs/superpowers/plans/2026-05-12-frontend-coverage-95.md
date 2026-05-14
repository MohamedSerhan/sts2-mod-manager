# Frontend Coverage to 95 % Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lift Vitest coverage from 70 %/65 %/72 %/70 % to ≥ 95 %/90 %/95 %/95 % (lines/branches/functions/statements), add five backlogged WebDriver smoke specs, and cover the pure helpers in `src-tauri/src/download.rs`. Raise `vitest.config.ts` thresholds at the end so a regression trips CI.

**Architecture:** Pure additive work. New tests extend existing `*.test.tsx` files using the established `registerInvokeHandler` mock from `src/__test__/setup.ts`. New smoke specs append to the spec arrays in `qa/runner/smoke.mjs` with new fixture seed helpers. New Rust tests sit inside `#[cfg(test)] mod tests` blocks in `src-tauri/src/download.rs`. The only non-test change is the threshold bump in `vitest.config.ts` and a strike-through in `qa/whats-left.md`.

**Tech Stack:** Vitest 4 + @vitest/coverage-v8 + jsdom + @testing-library/react / user-event for frontend tests. Selenium-webdriver + tauri-driver + msedgedriver for smoke. Rust's built-in test framework for backend.

**Spec:** `docs/superpowers/specs/2026-05-12-frontend-coverage-95-design.md`

**Worktree:** `.claude/worktrees/frontend-coverage-95` on branch `worktree-frontend-coverage-95`.

---

## Files

**Test files extended (Phase 1):**
- `src/views/Settings.test.tsx`
- `src/views/Home.test.tsx`
- `src/views/Profiles.test.tsx`
- `src/components/OnboardingOverlay.test.tsx`
- `src/App.test.tsx`
- `src/views/Mods.test.tsx`
- `src/views/Browse.test.tsx`
- `src/components/PublishModal.test.tsx`
- `src/components/AutoDetectModal.test.tsx`
- `src/components/DiagnosticBundle.test.tsx`
- `src/contexts/AppContext.test.tsx`

**Test helper possibly extended:**
- `src/__test__/setup.ts` — only if a new command shape is needed across multiple suites

**Runner file extended (Phase 2):**
- `qa/runner/smoke.mjs` — new spec functions, fixture-seed helpers, array reorganization
- `qa/fixtures/github/repos/qa-fixture/walkback-mod/` — new cassette dir
- `qa/fixtures/github/repos/qa-fixture/skipped-mod/` — new cassette dir

**Backend (Phase 3):**
- `src-tauri/src/download.rs` — new `#[cfg(test)] mod tests` at bottom of file
- `src-tauri/tests/fixtures/*.zip` — small fixture zip(s) for `peek_zip_min_game_version`

**Final commits (Phase 4):**
- `vitest.config.ts` — thresholds raised to `95 / 90 / 95 / 95`
- `qa/whats-left.md` — strike closed items

---

## How to work each Phase-1 task (read once, apply per file)

Every Phase-1 task follows the same loop. The plan lists the file-specific uncovered ranges and example tests; the executor runs the loop.

1. **Re-baseline** — run targeted coverage to confirm the current numbers:
   ```bash
   npx vitest run <test-file> --coverage --coverage.include='<source-file>' 2>&1 | tail -25
   ```
2. **Open the source** at each uncovered range, identify the branch/handler/effect.
3. **Plan tests** — one `it()` per branch. Group with `describe()`.
4. **Write tests** using `registerInvokeHandler('cmd', () => mockShape)` to set up backend responses. The full mock plumbing is in `src/__test__/setup.ts`. Existing tests in the same suite are the best style reference.
5. **Verify** — re-run the targeted coverage. File should hit ≥ 95 % lines / 95 % stmts / 95 % funcs / ≥ 90 % branches. If a branch is unreachable (defensive catch, env-var fallback), add a one-line comment in the test file documenting which lines and why.
6. **Commit** — one commit per file, conventional prefix `test(<area>):`.

Anchor patterns:
- Reach for `userEvent` for clicks/typing; `fireEvent` only when `userEvent` can't reproduce (drag, focus-out edge cases).
- Use `await waitFor(...)` around any assertion that follows a state change.
- Use `AllProviders` from `src/__test__/providers` whenever the component needs `AppContext`, `ToastContext`, or React Router.
- For modal-state branches, render → click open trigger → assert modal content → click close. Don't just import the modal directly unless it has a stable prop-driven open/close interface.

---

## Phase 1 — Vitest, file by file

### Task 1: Lift `src/views/Settings.tsx` to ≥ 95 %

**Files:**
- Modify: `src/views/Settings.test.tsx` (extend existing suite)

**Baseline:** stmts 54.74 / branch 66.76 / funcs 66.1 / lines 56.39. Uncovered ranges include the tab bodies past General/Accounts/Backups/Audit (Advanced) and many branches inside each body. Around 480 lines uncovered.

**Coverage workflow:**

- [ ] **Step 1: Baseline this file**
  ```bash
  npx vitest run src/views/Settings.test.tsx --coverage --coverage.include='src/views/Settings.tsx' 2>&1 | tail -10
  ```
  Expected: ~55 % lines.

- [ ] **Step 2: Read the source at uncovered ranges**

  Open `src/views/Settings.tsx`. The "Uncovered Line #s" from Step 1 are your map. Note which tab each range belongs to.

- [ ] **Step 3: Add a `describe()` block per tab body**

  Pattern (add after existing tests in `Settings.test.tsx`):
  ```tsx
  describe('<SettingsView> Advanced tab', () => {
    it('renders the Advanced tab body when clicked', async () => {
      const user = userEvent.setup();
      render(<Wrap />);
      await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
      await user.click(screen.getByRole('button', { name: /Advanced/ }));
      await waitFor(() => {
        // Replace with the actual heading or unique-string in Advanced body.
        expect(screen.getByText(/Advanced/i)).toBeInTheDocument();
      });
    });
  });
  ```

  Repeat for each tab body whose range appears uncovered (Sources, Diagnostics, About, etc. as they exist in the file).

- [ ] **Step 4: Cover the per-tab forms**

  Inside each tab `describe()`, add tests for:
  - Form input change → submit → assert the correct `invoke` was called with the typed value. Use `getInvokeCalls()` to verify the call shape.
  - Error path: `registerInvokeHandler('cmd', () => { throw new Error('boom'); })` → submit → assert the error UI rendered (toast, inline message — whichever the source uses).
  - Modal open/close (e.g. the "Confirm reset" dialog on the Diagnostics tab if present).

- [ ] **Step 5: Re-run coverage; iterate**
  ```bash
  npx vitest run src/views/Settings.test.tsx --coverage --coverage.include='src/views/Settings.tsx' 2>&1 | tail -10
  ```
  Continue until file is ≥ 95 % / 90 % branch. If a branch is impossible to reach, document why with a one-line `// uncovered: line N is defensive catch` comment.

- [ ] **Step 6: Run the full suite to confirm no regressions**
  ```bash
  npm run qa:unit 2>&1 | tail -8
  ```
  Expected: all green.

- [ ] **Step 7: Commit**
  ```bash
  git add src/views/Settings.test.tsx
  git commit -m "$(cat <<'EOF'
  test(settings): cover all tab bodies, forms, and error paths

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

### Task 2: Lift `src/views/Home.tsx` to ≥ 95 %

**Files:**
- Modify: `src/views/Home.test.tsx`

**Baseline:** stmts 52.14 / branch 45.81 / funcs 58.46 / lines 53.45. ~370 uncov lines. From the baseline run the uncovered ranges include `...84,737,834-862` — Home is a large file with several conditional sections.

**Workflow (same loop):**

- [ ] **Step 1: Baseline**
  ```bash
  npx vitest run src/views/Home.test.tsx --coverage --coverage.include='src/views/Home.tsx' 2>&1 | tail -10
  ```

- [ ] **Step 2: Identify sections**

  Read `Home.tsx` at uncovered ranges. Map each range to a section:
  - Share-code paste branch — find the input that captures `sts2mm://` codes, the parse + confirm modal flow.
  - Subscription banner — the per-source banner near top of Home that lists upstream changes.
  - Drift overlay — the modal that fires when the active profile drifted from the on-disk state.
  - Version-up toast — the post-update banner shown when `currentVersion > lastSeenVersion`.

- [ ] **Step 3: Add `describe()` per section**

  Example for share-code:
  ```tsx
  describe('<HomeView> share-code paste', () => {
    it('parses a valid sts2mm:// code into the confirm modal', async () => {
      const user = userEvent.setup();
      render(<Wrap />);
      await waitFor(() => { /* find share-code input */ });
      await user.type(screen.getByPlaceholderText(/sts2mm:\/\//i), 'sts2mm://...');
      // Assert the parsed mod list appears, then click Apply, then assert
      // the right install_* invoke fires.
    });

    it('shows error UI for malformed share code', async () => {
      // Type garbage; assert an inline error appears.
    });
  });
  ```

- [ ] **Step 4: Cover branches** — typical Home conditionals: `gameInfo.valid && ...`, `pendingUpdates.length > 0`, drift state, network-failure paths from `audit_mod_versions`.

- [ ] **Step 5: Re-run + iterate** (same command as Task 1).

- [ ] **Step 6: Full-suite sanity** — `npm run qa:unit`.

- [ ] **Step 7: Commit**
  ```bash
  git add src/views/Home.test.tsx
  git commit -m "test(home): cover share-code, subscription banner, drift overlay, version-up"
  ```

### Task 3: Lift `src/views/Profiles.tsx` to ≥ 95 %

**Files:**
- Modify: `src/views/Profiles.test.tsx`

**Baseline:** stmts 53.48 / branch 55.5 / funcs 52.7 / lines 55.6. Uncovered ranges include `...20-844,873-884` — kebab paths (snapshot/repair/share).

**Workflow:**

- [ ] **Step 1: Baseline**
  ```bash
  npx vitest run src/views/Profiles.test.tsx --coverage --coverage.include='src/views/Profiles.tsx' 2>&1 | tail -10
  ```

- [ ] **Step 2: Map uncovered ranges to kebab actions** — open Profiles.tsx, find the kebab menu items: Snapshot, Repair, Share (export), Delete. Each is a distinct test.

- [ ] **Step 3: Tests**

  Example for snapshot:
  ```tsx
  it('Snapshot kebab option calls snapshot_profile_cmd', async () => {
    registerInvokeHandler('list_profiles_cmd', () => [{ name: 'Default', active: true, ... }]);
    registerInvokeHandler('snapshot_profile_cmd', () => null);
    const user = userEvent.setup();
    render(<Wrap />);
    await waitFor(() => screen.getByText('Default'));
    await user.click(screen.getByTitle('Profile actions'));
    await user.click(screen.getByRole('menuitem', { name: /Snapshot/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'snapshot_profile_cmd')).toBe(true);
    });
  });
  ```

  Repeat for Repair, Share/Export (assert the share-code modal opens), Delete (assert the confirm modal opens, click confirm, assert `delete_profile_cmd` fires).

  Apply-with-skipped: register `apply_profile_cmd` to return a result with `skipped_count > 0`, click Apply, assert the "N skipped" toast appears.

- [ ] **Step 4: Re-run + iterate** until ≥ 95 % / 90 % branch.

- [ ] **Step 5: Full-suite sanity** — `npm run qa:unit`.

- [ ] **Step 6: Commit**
  ```bash
  git add src/views/Profiles.test.tsx
  git commit -m "test(profiles): cover snapshot, repair, share, delete, apply-with-skipped"
  ```

### Task 4: Lift `src/components/OnboardingOverlay.tsx` to ≥ 95 %

**Files:**
- Modify: `src/components/OnboardingOverlay.test.tsx`

**Baseline:** stmts 25 / branch 54.16 / funcs 25 / lines 23.52. Uncovered ranges: `...30-142,232-332` — virtually the entire wizard past step 1.

**Workflow:**

- [ ] **Step 1: Baseline**
  ```bash
  npx vitest run src/components/OnboardingOverlay.test.tsx --coverage --coverage.include='src/components/OnboardingOverlay.tsx' 2>&1 | tail -10
  ```

- [ ] **Step 2: Catalog the steps**

  Read OnboardingOverlay.tsx top-to-bottom; list each step (looks like step 1: welcome → step 2: game detect → step 3: profile → step 4: mod sources → step 5: launch). Each transition is a "Next" button click.

- [ ] **Step 3: Mock the per-step Tauri invokes**

  Step 2 (game detect) needs `detect_game_path` to return a valid shape. Step 3 (profile) needs `list_profiles_cmd` / `create_profile_cmd`. Step 4 (sources) needs `get_mod_sources` / `set_mod_sources`. Register these in each step's tests.

- [ ] **Step 4: Tests — one per step + the Skip-setup path**

  ```tsx
  describe('<OnboardingOverlay> step 2: game detect', () => {
    it('advances when a valid game path is auto-detected', async () => {
      registerInvokeHandler('detect_game_path', () => ({ valid: true, game_path: 'C:/Game', ... }));
      const user = userEvent.setup();
      render(<Wrap />);
      // Click Next from step 1, assert step 2 heading appears, etc.
    });

    it('shows manual-entry fallback when auto-detect fails', async () => {
      registerInvokeHandler('detect_game_path', () => ({ valid: false, ... }));
      // Assert the manual path input renders.
    });
  });
  ```

- [ ] **Step 5: Cover Skip-setup**

  ```tsx
  it('Skip setup dismisses the overlay without any invoke', async () => {
    const user = userEvent.setup();
    render(<Wrap />);
    await user.click(screen.getByRole('button', { name: /Skip setup/i }));
    // Assert the overlay is gone — check the `.gf-wiz-rail` selector is no longer in the DOM.
  });
  ```

- [ ] **Step 6: Re-run + iterate**.

- [ ] **Step 7: Commit**
  ```bash
  git add src/components/OnboardingOverlay.test.tsx
  git commit -m "test(onboarding): cover wizard steps 2-5 and Skip-setup path"
  ```

### Task 5: Lift `src/App.tsx` to ≥ 95 %

**Files:**
- Modify: `src/App.test.tsx`

**Baseline:** stmts 66.52 / branch 59.6 / funcs 60.27 / lines 68.36. Uncovered: `...16,467,556-711` — top-bar resize, deep-link routing, dev-badge branches.

**Workflow:**

- [ ] **Step 1: Baseline**
  ```bash
  npx vitest run src/App.test.tsx --coverage --coverage.include='src/App.tsx' 2>&1 | tail -10
  ```

- [ ] **Step 2: Map uncovered ranges**

  Open `App.tsx`. Look for:
  - `useEffect` listeners on window resize / Tauri window events
  - `sts2mm://` deep-link handler — likely an `onOpenUrl` listener
  - Dev-badge conditional (`import.meta.env.DEV` or similar)

- [ ] **Step 3: Tests — drive listeners via the mock**

  `vi.mock('@tauri-apps/api/event', ...)` from setup.ts captures `listen()` calls. To deliver a fake event:
  ```tsx
  import { listen } from '@tauri-apps/api/event';

  it('handles a sts2mm:// deep link by routing to Home with share code', async () => {
    render(<Wrap />);
    await waitFor(() => screen.getByText(/STS2 Mod Manager/i));
    // Grab the handler the app registered for the deep-link event:
    const call = (listen as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[0] === 'deep-link' /* or whatever event name */
    );
    expect(call).toBeDefined();
    // Invoke it with a fake payload:
    (call![1] as (e: { payload: { url: string } }) => void)({
      payload: { url: 'sts2mm://share/abc' },
    });
    await waitFor(() => /* assert the share-code modal opened */);
  });
  ```

- [ ] **Step 4: Resize handle test**

  Simulate `window.dispatchEvent(new Event('resize'))` or call the Tauri window event handler directly via the mock pattern above.

- [ ] **Step 5: Re-run + iterate**.

- [ ] **Step 6: Commit**
  ```bash
  git add src/App.test.tsx
  git commit -m "test(app): cover deep-link routing, resize, dev-badge branches"
  ```

### Task 6: Lift `src/views/Mods.tsx` to ≥ 95 %

**Files:**
- Modify: `src/views/Mods.test.tsx`

**Baseline:** stmts 71.36 / branch 69.11 / funcs 83.33 / lines 73.51. Uncovered: `...63,818-833,844` — repair flow, advanced-mode form, source editor.

**Workflow:**

- [ ] **Step 1: Baseline + read source.**

- [ ] **Step 2: Tests for the three uncovered subsystems:**
  - **Advanced-mode form open/close** — find the toggle/button, click, assert form fields render. Type a value, click Save, assert the correct invoke fires.
  - **Source editor** — find the per-row Source kebab, click, assert SourceEditor modal opens, simulate save, assert `set_mod_source` invoke.
  - **Repair confirmation** — click Repair on a row, confirm modal, assert `repair_mod_cmd` invoke.

- [ ] **Step 3: Iterate. Commit.**
  ```bash
  git add src/views/Mods.test.tsx
  git commit -m "test(mods): cover advanced-mode form, source editor, repair flow"
  ```

### Task 7: Lift `src/views/Browse.tsx` to ≥ 95 %

**Files:**
- Modify: `src/views/Browse.test.tsx`

**Baseline:** stmts 60.71 / branch 54.16 / funcs 44.82 / lines 61.53. Uncovered: `...94-225,291-348`.

**Workflow:**

- [ ] **Step 1: Baseline + read source.**

- [ ] **Step 2: Tests**
  - Nexus-trending error path (lines 194-225): `registerInvokeHandler('nexus_get_trending', () => { throw new Error('rate limited'); })` → render → assert error UI.
  - Install-from-detail (lines 291-348): drive the BrowseDetail panel, click the Install button, assert the install_* invoke fires.
  - Empty-state branches (no results, no API key configured).

- [ ] **Step 3: Iterate. Commit.**
  ```bash
  git add src/views/Browse.test.tsx
  git commit -m "test(browse): cover Nexus error path and install-from-detail"
  ```

### Task 8: Lift `src/components/PublishModal.tsx` to ≥ 95 %

**Files:**
- Modify: `src/components/PublishModal.test.tsx`

**Baseline:** stmts 65 / branch 58.26 / funcs 61.9 / lines 66.15. Uncovered: `...47-149,335-351`.

**Workflow:**

- [ ] **Step 1: Baseline + read source.**

- [ ] **Step 2: Tests**

  PublishModal walks the user through publishing a profile as a share code or a curated subscription. Cover:
  - Form validation (empty name, invalid GitHub repo URL)
  - Submit happy path → assert `publish_profile_cmd` invoke + close
  - Submit error path → assert error UI
  - Cancel/close button

- [ ] **Step 3: Iterate. Commit.**
  ```bash
  git add src/components/PublishModal.test.tsx
  git commit -m "test(publish-modal): cover validation, happy path, error path"
  ```

### Task 9: Lift `src/components/AutoDetectModal.tsx` to ≥ 95 %

**Files:**
- Modify: `src/components/AutoDetectModal.test.tsx`

**Baseline:** stmts 54.71 / branch 55.31 / funcs 66.66 / lines 53.33. Uncovered: `49-74,162-174`.

**Workflow:**

- [ ] **Step 1: Baseline + read source.**

- [ ] **Step 2: Tests**
  - Successful detect: `detect_game_path` returns `valid: true` → modal shows the path → Accept button fires `set_game_path` and closes.
  - Failure detect: `valid: false` → manual-entry fallback shown → typing + submit fires the right invoke.
  - Cancel button.

- [ ] **Step 3: Iterate. Commit.**
  ```bash
  git add src/components/AutoDetectModal.test.tsx
  git commit -m "test(auto-detect-modal): cover success, failure, manual-entry paths"
  ```

### Task 10: Lift `src/components/DiagnosticBundle.tsx` to ≥ 95 %

**Files:**
- Modify: `src/components/DiagnosticBundle.test.tsx`

**Baseline:** stmts 63.88 / branch 54.54 / funcs 44.44 / lines 73.33. Uncovered: `...0-73,80-83,144`.

**Workflow:**

- [ ] **Step 1: Baseline + read source.**

- [ ] **Step 2: Tests**
  - Generate bundle → assert `make_diagnostic_bundle_cmd` invoke + the file-path is displayed.
  - Open-folder button → assert `openPath` from `@tauri-apps/plugin-opener` was called.
  - Error case (bundle generation fails).

- [ ] **Step 3: Iterate. Commit.**
  ```bash
  git add src/components/DiagnosticBundle.test.tsx
  git commit -m "test(diagnostic-bundle): cover generate, open-folder, error paths"
  ```

### Task 11: Lift `src/contexts/AppContext.tsx` to ≥ 95 % / 90 % branch

**Files:**
- Modify: `src/contexts/AppContext.test.tsx`

**Baseline:** stmts 84.67 / branch 50 / funcs 82.35 / lines 84.54. Uncovered: `...21-226,262-265`. The 50 % branch metric is the killer.

**Workflow:**

- [ ] **Step 1: Baseline + read source.**

- [ ] **Step 2: Map uncovered branches**

  Most likely culprits in the polling loop:
  - Throttle / debounce branches (`if (sinceLastRefresh < THROTTLE_MS) return`)
  - Error path in `refreshAll` (one invoke throws → others should still run)
  - The interval cleanup branch when component unmounts mid-poll

- [ ] **Step 3: Tests**

  Example throttle test:
  ```tsx
  it('refreshAll throttles repeated calls within the throttle window', async () => {
    let refreshCount = 0;
    registerInvokeHandler('get_installed_mods', () => { refreshCount++; return []; });
    const { result } = renderHook(() => useApp(), { wrapper: AllProviders });
    await act(async () => { await result.current.refreshAll(); });
    await act(async () => { await result.current.refreshAll(); });
    // First call ran; second hit the throttle. Exact count depends on
    // whether the initial mount also called it — adjust per impl.
    expect(refreshCount).toBeLessThan(3);
  });
  ```

  Example error-resilience test:
  ```tsx
  it('refreshAll continues other commands when one throws', async () => {
    registerInvokeHandler('get_installed_mods', () => { throw new Error('disk'); });
    registerInvokeHandler('list_profiles_cmd', () => [{ name: 'Default', active: true }]);
    const { result } = renderHook(() => useApp(), { wrapper: AllProviders });
    await act(async () => { await result.current.refreshAll(); });
    expect(result.current.profiles).toEqual([{ name: 'Default', active: true }]);
  });
  ```

- [ ] **Step 4: Iterate.** If a defensive branch genuinely can't be exercised (e.g. a `catch` that re-throws after logging), document it: `// uncovered: line N — catch re-throws, no observable behavior`.

- [ ] **Step 5: Commit.**
  ```bash
  git add src/contexts/AppContext.test.tsx
  git commit -m "test(app-context): cover throttle, error resilience, cleanup branches"
  ```

### Task 12: Run full coverage; backfill any file that regressed or remains below

**Files:** any from the priority list whose coverage didn't reach the gate.

- [ ] **Step 1: Full coverage run**
  ```bash
  npm run qa:coverage 2>&1 | tail -45
  ```

- [ ] **Step 2: Identify files still below 95 % lines / 95 % stmts / 95 % funcs / 90 % branches.**

  Skip files that were never in scope (already at 100 %, or never on the priority list).

- [ ] **Step 3: For each below-gate file, repeat the per-file workflow** (baseline → tests → iterate → commit). Each gets its own commit.

- [ ] **Step 4: Re-run full coverage; confirm all four global metrics ≥ their targets.**

  ```bash
  npm run qa:coverage 2>&1 | tail -10
  ```
  Expected last 4 lines (numbers may be higher):
  ```
  Statements   : 95.xx% ...
  Branches     : 90.xx% ...
  Functions    : 95.xx% ...
  Lines        : 95.xx% ...
  ```

---

## Phase 2 — Smoke spec backlog

### Task 13: Reorganize spec arrays in `qa/runner/smoke.mjs`

**Files:**
- Modify: `qa/runner/smoke.mjs`

The current `TOGGLE_SPECS` array is misnamed and mixes a stateful mod-toggle, a destructive delete, and a profile-create. The new specs (profile-switch, #20, #22) also mutate fixture state, and the cassette-mode specs (walk-back, #21) need their own group. Reorganize before adding the new specs so each new commit lands cleanly.

- [ ] **Step 1: Rename `TOGGLE_SPECS` → `STATE_SPECS`** in the file. Update its comment to describe its real contents.

- [ ] **Step 2: Extract a `rebuildFixtureTree()` helper** that tears down `FIXTURE_DIRS` and calls `makeFixtureGameTree()` again. Wire it into the spec loop to call it before each `STATE_SPECS` entry, since these mutate state.

  Indicative diff (paraphrase — preserve existing logic):
  ```js
  for (const [name, fn] of SPECS) {
    process.stdout.write(`▸ ${name} ... `);
    try {
      if (STATE_SPECS.includes(SPEC_NAME_LOOKUP)) await rebuildFixtureTree(driver);
      await fn(driver);
      process.stdout.write('PASS\n');
    } ...
  ```

  The exact shape depends on how the runner currently iterates — wire the rebuild via a per-entry `{ name, fn, freshTree?: boolean }` shape if cleaner.

- [ ] **Step 3: Verify the existing smoke still passes** (assumes msedgedriver + release build are present locally):
  ```bash
  npm run qa:smoke 2>&1 | tail -30
  ```
  Expected: every spec PASS.

- [ ] **Step 4: Commit**
  ```bash
  git add qa/runner/smoke.mjs
  git commit -m "refactor(smoke): split TOGGLE_SPECS into STATE_SPECS with fresh fixture per spec"
  ```

### Task 14: Add spec — Profile switch + apply

**Files:**
- Modify: `qa/runner/smoke.mjs`

- [ ] **Step 1: Write `specProfileSwitchPreservesPins`**

  Function lives next to `specCreateProfile`. Steps:
  1. Nav to Profiles.
  2. Create a second profile named e.g. `QA Switch ${Date.now().toString(36)}`.
  3. Nav to Mods, pin QaTestMod via its kebab (reuse the pattern from `specPinSuppressesPendingUpdate`).
  4. Nav back to Profiles, click the new profile to make it active (find the "Apply" or "Switch" button on that profile's card).
  5. Wait for the active-profile indicator to flip.
  6. Switch back to the original profile the same way.
  7. Nav to Mods. Assert QaTestMod's row still has the pinned indicator.

- [ ] **Step 2: Append to `STATE_SPECS`**
  ```js
  ['profile switch preserves pins (v1.3.1 contract)', specProfileSwitchPreservesPins],
  ```

- [ ] **Step 3: Run smoke; confirm PASS.**
  ```bash
  npm run qa:smoke 2>&1 | tail -30
  ```

- [ ] **Step 4: Commit**
  ```bash
  git add qa/runner/smoke.mjs
  git commit -m "test(smoke): profile switch preserves pins"
  ```

### Task 15: Add spec — Repair walk-back

**Files:**
- Create: `qa/fixtures/github/repos/qa-fixture/walkback-mod/releases.json`
- Create: `qa/fixtures/github/repos/qa-fixture/walkback-mod/releases/latest.json` (if the cassette needs separate latest)
- Modify: `qa/runner/smoke.mjs` (new `seedWalkbackMod` helper + new `specRepairWalkback` + entry in `CASSETTE_SPECS`)

- [ ] **Step 1: Create the cassette**

  Mirror the shape of the existing `qa/fixtures/github/repos/qa-fixture/test-mod/` cassette. The cassette returns two releases:
  - latest: tag `v3.0.0`, `min_game_version: "999.0.0"` (intentionally incompatible)
  - prior: tag `v1.0.0`, `min_game_version: "0.100.0"` (compatible with fixture game version `0.105.0`)

  The exact JSON shape matches what `fetch_latest_release` / `fetch_releases` parse — copy from the `test-mod` cassette and edit the version + min_game_version fields.

- [ ] **Step 2: Add `seedWalkbackMod()` to smoke.mjs**

  Pattern follows `seedQaTestMod`. Seeds `mods/WalkbackMod/WalkbackMod.json` (manifest v2.0.0 — too new, will need walk-back) + `WalkbackMod.dll`. The cassette will resolve `v3.0.0` as latest (incompatible) so the audit fires the walk-back path to `v1.0.0`.

  Call it from `makeFixtureGameTree()` alongside the existing seeds.

- [ ] **Step 3: Write `specRepairWalkback`**

  1. Click Mods.
  2. Wait for the WalkbackMod row.
  3. Click the row's Repair button (kebab → Repair, or the inline Repair pill).
  4. Wait for the modal/banner that confirms walk-back installed (look for text like "Walked back to v1.0.0" or a version pill).
  5. Read the on-disk manifest at `mods/WalkbackMod/WalkbackMod.json`; assert `version === '1.0.0'`.

- [ ] **Step 4: Append to `CASSETTE_SPECS`**
  ```js
  ['repair walk-back installs older compatible tag', specRepairWalkback],
  ```

- [ ] **Step 5: Build the cassette-feature binary and run cassette smoke**
  ```bash
  npm run tauri build -- --no-bundle --features qa-cassette
  CASSETTE=1 npm run qa:smoke 2>&1 | tail -30
  ```
  Expected: every cassette spec PASS.

- [ ] **Step 6: Commit**
  ```bash
  git add qa/fixtures/github/repos/qa-fixture/walkback-mod qa/runner/smoke.mjs
  git commit -m "test(smoke): repair walk-back installs older compatible tag"
  ```

### Task 16: Add spec — #22 toggle stickiness across profile switch

**Files:**
- Modify: `qa/runner/smoke.mjs`

- [ ] **Step 1: Write `specToggleStickyAcrossProfileSwitch`**

  1. Reuse fresh fixture tree (the STATE_SPECS framework handles this if Task 13 was done).
  2. Nav to Mods, toggle QaTestMod off (reuse the pattern from `specToggleMovesQaTestModToDisabled` — find the toggle, click).
  3. Nav to Profiles, create a second profile, switch to it, switch back to the first.
  4. Nav to Mods. Assert QaTestMod's toggle is still `aria-checked=false` AND the folder is still in `mods_disabled/`.

- [ ] **Step 2: Append to `STATE_SPECS`**
  ```js
  ['#22: toggle state sticky across profile switch', specToggleStickyAcrossProfileSwitch],
  ```

- [ ] **Step 3: Run smoke + commit**
  ```bash
  npm run qa:smoke 2>&1 | tail -30
  git add qa/runner/smoke.mjs
  git commit -m "test(smoke): #22 toggle state sticky across profile switch"
  ```

### Task 17: Add spec — #20 Profile Repair removes orphan disabled files

**Files:**
- Modify: `qa/runner/smoke.mjs`

- [ ] **Step 1: Extend `makeFixtureGameTree`** (or add a separate seed call) to drop an `OrphanMod` folder into `mods_disabled/` that is NOT in any profile manifest.

  Or, more locally: seed it inside the spec itself before clicking Repair. Either is fine — the framework supports both.

- [ ] **Step 2: Write `specRepairRemovesOrphanDisabled`**

  1. Verify the orphan folder exists at `FIXTURE_DIRS.game + '/mods_disabled/OrphanMod/'`.
  2. Nav to Profiles, click the active profile's Repair button (kebab → Repair or inline).
  3. Wait for the Repair-done UI (toast or modal confirm).
  4. Assert `mods_disabled/OrphanMod/` no longer exists on disk.

- [ ] **Step 3: Append + run + commit**
  ```js
  ['#20: profile repair removes orphan mods_disabled folders', specRepairRemovesOrphanDisabled],
  ```
  ```bash
  npm run qa:smoke 2>&1 | tail -30
  git add qa/runner/smoke.mjs
  git commit -m "test(smoke): #20 profile repair removes orphan disabled folders"
  ```

### Task 18: Add spec — #21 game-version-skipped mods absent from snapshot

**Files:**
- Create: `qa/fixtures/github/repos/qa-fixture/skipped-mod/releases/latest.json` (if any audit fires for this mod)
- Modify: `qa/runner/smoke.mjs` (new `seedSkippedMod` helper + new `specSkippedModAbsentFromSnapshot` + entry in `CASSETTE_SPECS`)

- [ ] **Step 1: Cassette (only if the spec triggers an audit)**

  If the spec just applies + snapshots without auditing, no cassette needed. If applying triggers an audit, mirror the `uptodate-mod` cassette and set the latest version to the same as the manifest so audit reports up-to-date.

- [ ] **Step 2: `seedSkippedMod()`**

  Seeds `mods/SkippedMod/SkippedMod.json` with `min_game_version: "999.0.0"` (above the fixture game version `0.105.0`) and `version: "1.0.0"`. Also seeds the `.dll` placeholder.

- [ ] **Step 3: `specSkippedModAbsentFromSnapshot`**

  1. Confirm SkippedMod is on disk (the seed put it there).
  2. Nav to Profiles. Click Apply on the active profile.
  3. Wait for apply completion.
  4. Click Snapshot in the active profile's kebab (or whatever path creates a new snapshot).
  5. Read the new snapshot file (lives under `FIXTURE_DIRS.config/profiles/<profile>/snapshots/...` — exact path may be in profile JSON; read the profile to find it).
  6. Assert `SkippedMod` is NOT in the snapshot's mod list.

  Alternative: assert via UI by switching to a fresh profile and applying the snapshot, then confirming SkippedMod is not enabled.

- [ ] **Step 4: Append + cassette build + commit**
  ```js
  ['#21: skipped mods not in fresh snapshot', specSkippedModAbsentFromSnapshot],
  ```
  ```bash
  npm run tauri build -- --no-bundle --features qa-cassette
  CASSETTE=1 npm run qa:smoke 2>&1 | tail -30
  git add qa/fixtures/github/repos/qa-fixture/skipped-mod qa/runner/smoke.mjs
  git commit -m "test(smoke): #21 skipped mods absent from fresh snapshot"
  ```

---

## Phase 3 — Backend pure helpers in `download.rs`

### Task 19: Add `#[cfg(test)] mod tests` to `src-tauri/src/download.rs`

**Files:**
- Modify: `src-tauri/src/download.rs` (append a `#[cfg(test)] mod tests { ... }` block at end of file)
- Create: `src-tauri/tests/fixtures/min_game_version.zip` (a small zip with a mod manifest declaring `min_game_version`)
- Create: `src-tauri/tests/fixtures/no_min_game_version.zip` (a mod manifest WITHOUT `min_game_version`)

The test fixtures live in `src-tauri/tests/fixtures/` since unit tests inside `download.rs` can refer to them via `concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/...")`.

- [ ] **Step 1: Build the fixture zips**

  Two zips, each containing a single JSON manifest at the zip root:
  ```json
  // min_game_version.zip → contains FixtureMod.json with min_game_version "0.105.0"
  { "id": "FixtureMod", "name": "FixtureMod", "version": "1.0.0", "min_game_version": "0.105.0", "dependencies": [] }

  // no_min_game_version.zip → same fields, without min_game_version
  { "id": "FixtureMod", "name": "FixtureMod", "version": "1.0.0", "dependencies": [] }
  ```

  Build via PowerShell:
  ```powershell
  $tmp = New-TemporaryFile; Remove-Item $tmp; New-Item -ItemType Directory $tmp | Out-Null
  Set-Content -Path "$tmp/FixtureMod.json" -Value '{"id":"FixtureMod","name":"FixtureMod","version":"1.0.0","min_game_version":"0.105.0","dependencies":[]}'
  Compress-Archive -Path "$tmp/*" -DestinationPath src-tauri/tests/fixtures/min_game_version.zip -Force
  Set-Content -Path "$tmp/FixtureMod.json" -Value '{"id":"FixtureMod","name":"FixtureMod","version":"1.0.0","dependencies":[]}'
  Compress-Archive -Path "$tmp/*" -DestinationPath src-tauri/tests/fixtures/no_min_game_version.zip -Force
  Remove-Item -Recurse -Force $tmp
  ```

  Verify they unzip correctly: `unzip -l src-tauri/tests/fixtures/min_game_version.zip`.

- [ ] **Step 2: Write the test module**

  Append to the bottom of `src-tauri/src/download.rs`:

  ```rust
  #[cfg(test)]
  mod tests {
      use super::*;

      // ── slugify ───────────────────────────────────────────────
      #[test]
      fn slugify_handles_spaces_and_punctuation() {
          // Read the actual slugify impl at line 359 first — its rules
          // (which chars become '-', which are kept) drive these inputs.
          // The cases below are illustrative; tune to match real behavior.
          assert_eq!(slugify("Hello World"), "hello-world");
          assert_eq!(slugify("  leading and trailing  "), "leading-and-trailing");
          assert_eq!(slugify(""), "");
      }

      #[test]
      fn slugify_keeps_alphanumerics() {
          assert_eq!(slugify("Mod123Name"), "mod123name");
      }

      // ── repo_mentions_sts2 (signals: sts2, slaythespire2, slaythespireii) ──
      fn make_repo(
          full_name: &str,
          name: &str,
          description: Option<&str>,
          topics: Vec<&str>,
      ) -> GitHubRepo {
          GitHubRepo {
              full_name: full_name.to_string(),
              name: name.to_string(),
              description: description.map(String::from),
              html_url: format!("https://github.com/{full_name}"),
              stargazers_count: 0,
              updated_at: "2026-05-12T00:00:00Z".to_string(),
              owner: GitHubOwner {
                  login: full_name.split('/').next().unwrap_or("").to_string(),
                  avatar_url: String::new(),
              },
              topics: topics.into_iter().map(String::from).collect(),
          }
      }

      #[test]
      fn repo_mentions_sts2_matches_sts2_in_description() {
          assert!(repo_mentions_sts2(&make_repo(
              "alice/cool-mod",
              "cool-mod",
              Some("A mod for STS2"),
              vec![],
          )));
      }

      #[test]
      fn repo_mentions_sts2_matches_slaythespire2_separators_collapsed() {
          // "slay-the-spire-2" → "slaythespire2" after separator collapse.
          assert!(repo_mentions_sts2(&make_repo(
              "alice/slay-the-spire-2-helper",
              "slay-the-spire-2-helper",
              None,
              vec![],
          )));
      }

      #[test]
      fn repo_mentions_sts2_matches_via_topics() {
          assert!(repo_mentions_sts2(&make_repo(
              "alice/x",
              "x",
              None,
              vec!["sts2"],
          )));
      }

      #[test]
      fn repo_mentions_sts2_no_match_returns_false() {
          assert!(!repo_mentions_sts2(&make_repo(
              "alice/unrelated",
              "unrelated",
              Some("A different game's mod"),
              vec!["unity"],
          )));
      }

      #[test]
      fn repo_mentions_sts2_no_description_no_topics() {
          assert!(!repo_mentions_sts2(&make_repo(
              "alice/x",
              "x",
              None,
              vec![],
          )));
      }

      // ── find_best_asset ───────────────────────────────────────
      fn make_asset(name: &str) -> GitHubAsset {
          GitHubAsset {
              name: name.to_string(),
              size: 1024,
              browser_download_url: format!("https://example.com/{name}"),
              content_type: "application/octet-stream".to_string(),
              download_count: 0,
          }
      }

      fn make_release(assets: Vec<GitHubAsset>) -> GitHubRelease {
          GitHubRelease {
              tag_name: "v1.0.0".to_string(),
              name: Some("v1.0.0".to_string()),
              body: None,
              prerelease: false,
              published_at: Some("2026-05-12T00:00:00Z".to_string()),
              assets,
              html_url: "https://example.com/release".to_string(),
          }
      }

      #[test]
      fn find_best_asset_prefers_zip() {
          let release = make_release(vec![
              make_asset("source.tar.gz"),
              make_asset("mod-bundle.7z"),
              make_asset("mod-bundle.zip"),
          ]);
          assert_eq!(
              find_best_asset(&release).map(|a| a.name.as_str()),
              Some("mod-bundle.zip"),
          );
      }

      #[test]
      fn find_best_asset_falls_back_to_first_when_no_zip() {
          let release = make_release(vec![
              make_asset("mod-bundle.7z"),
              make_asset("source.tar.gz"),
          ]);
          assert_eq!(
              find_best_asset(&release).map(|a| a.name.as_str()),
              Some("mod-bundle.7z"),
          );
      }

      #[test]
      fn find_best_asset_returns_none_for_empty() {
          let release = make_release(vec![]);
          assert!(find_best_asset(&release).is_none());
      }

      // ── peek_zip_min_game_version ─────────────────────────────
      #[test]
      fn peek_zip_min_game_version_reads_manifest_field() {
          let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
              .join("tests/fixtures/min_game_version.zip");
          let out = peek_zip_min_game_version(&path).expect("read ok");
          assert_eq!(out.as_deref(), Some("0.105.0"));
      }

      #[test]
      fn peek_zip_min_game_version_returns_none_when_absent() {
          let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
              .join("tests/fixtures/no_min_game_version.zip");
          let out = peek_zip_min_game_version(&path).expect("read ok");
          assert!(out.is_none());
      }

      #[test]
      fn peek_zip_min_game_version_errors_on_non_zip() {
          let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
              .join("src/download.rs"); // any non-zip file
          assert!(peek_zip_min_game_version(&path).is_err());
      }
  }
  ```

  > Note: `slugify`'s exact rule set isn't in this plan — read the impl at `download.rs:359` and adjust the input/expected pairs accordingly. The repo / release / asset constructor helpers above are concrete and match the actual struct definitions at `download.rs:14-44`.

- [ ] **Step 3: Run the new tests**
  ```bash
  cargo test --manifest-path=src-tauri/Cargo.toml download::tests 2>&1 | tail -20
  ```
  Expected: all `download::tests::*` pass.

- [ ] **Step 4: Full backend test run**
  ```bash
  npm run qa:rust 2>&1 | tail -10
  ```
  Expected: existing tests still pass.

- [ ] **Step 5: Commit**
  ```bash
  git add src-tauri/src/download.rs src-tauri/tests/fixtures/
  git commit -m "test(download): cover slugify, repo_mentions_sts2, find_best_asset, peek_zip_min_game_version"
  ```

---

## Phase 4 — Raise the threshold gate

### Task 20: Bump `vitest.config.ts` thresholds to 95 / 90 / 95 / 95

**Files:**
- Modify: `vitest.config.ts` (lines 69-74 today)

- [ ] **Step 1: Run full coverage one more time** to confirm current live numbers exceed targets.
  ```bash
  npm run qa:coverage 2>&1 | tail -10
  ```
  Expected: lines ≥ 95, statements ≥ 95, functions ≥ 95, branches ≥ 90.

- [ ] **Step 2: Edit `vitest.config.ts`**

  Replace:
  ```ts
  thresholds: {
    lines: 68,
    functions: 70,
    branches: 63,
    statements: 67,
  },
  ```

  With:
  ```ts
  thresholds: {
    lines: 95,
    functions: 95,
    branches: 90,
    statements: 95,
  },
  ```

  Also update the comment block above the thresholds to reflect the new live numbers (replace the "Actual coverage at the time of writing" lines with the latest output) and to mark the trajectory as complete.

- [ ] **Step 3: Confirm the gate now enforces**
  ```bash
  npm run qa:coverage 2>&1 | tail -15
  ```
  Expected: exit code 0, all four metric lines green.

- [ ] **Step 4: Commit**
  ```bash
  git add vitest.config.ts
  git commit -m "test(coverage): raise gate to 95/90/95/95"
  ```

### Task 21: Update `qa/whats-left.md` — strike closed items

**Files:**
- Modify: `qa/whats-left.md`

- [ ] **Step 1: Edit the doc**

  - Under "Frontend coverage gate — current 70 %, target 95 %": replace the section with a "**DONE (2026-05-12)**" header noting the gate is at 95/90/95/95. Keep the per-file gap table struck-through OR replace with the now-live numbers, your call.
  - Under "Tier 2 WebDriver scenarios": strike the items now landed (profile switch, repair walk-back). Update "Tier 2 scenarios for historical bugs" to strike #20/#21/#22.
  - Leave the explicitly-deferred items (drag-drop zip, share-code, subscription, OS-level) intact.

  Style: use `~~strikethrough~~` for items that landed in this branch; add a `**DONE (2026-05-12)**` line under each struck section.

- [ ] **Step 2: Commit**
  ```bash
  git add qa/whats-left.md
  git commit -m "docs(qa): mark frontend gate + Tier-2 specs as done in whats-left"
  ```

---

## Phase 5 — Final verification

### Task 22: End-to-end QA gate

- [ ] **Step 1: Run the full QA chain**
  ```bash
  npm run qa 2>&1 | tail -50
  ```
  This runs: rust tests, rust cassette tests, vitest coverage with the new gate, smoke base, smoke cassette.

  Expected: every stage green, exit 0.

  If smoke fails on a flake-prone WebDriver step, re-run that single sub-command (`npm run qa:smoke` or `npm run qa:smoke:cassette`) once to rule out a transient before treating it as a regression.

- [ ] **Step 2: Report**

  - Frontend live numbers (lines/branches/functions/statements).
  - Total tests added (frontend / smoke / backend).
  - Per-task commit hashes.
  - Time spent.
  - Any branches documented as intentionally-uncovered.

---

## Notes for the executor

- The fixture-game-path + cassette infrastructure is already wired — `qa/runner/smoke.mjs` already sets `STS2_FIXTURE_GAME_PATH`, `STS2_CONFIG_DIR`, `STS2_CACHE_DIR`, and the cassette env var. Re-use those mechanisms; do not invent new ones.
- The `registerInvokeHandler` mock in `src/__test__/setup.ts` already has safe defaults for the read-only commands (`get_installed_mods`, `list_profiles_cmd`, etc.). Tests only need to register handlers for commands whose default response would mask a behavior under test.
- Existing tests are the best style guide. Match their patterns (AllProviders wrapper, `waitFor` everywhere a state change is observed, `userEvent.setup()` over `fireEvent` where possible).
- Branches threshold is 90 % deliberately. If you find yourself contriving tests to hit a defensive catch, stop and document the line as intentionally-uncovered instead.
- This is a worktree — `git push` is not needed yet. Finish all 22 tasks, run `npm run qa`, then we'll merge.
