# Audit & Update UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make audit fast (parallel GitHub/Nexus calls), make the Mods view toolbar button actually update (instead of re-auditing) when updates are available, and add a "Latest" badge for up-to-date rows.

**Architecture:**
- **Rust:** swap the sequential `for m in &all_mods` loop in `audit_mod_versions` for a bounded-concurrency stream via `futures_util::stream::iter(...).buffer_unordered(8)`. Extract the per-mod body into `async fn audit_one_mod(m, ctx)`. Re-sort results by lowercase mod name before returning so UI order is stable.
- **Frontend:** lift `handleUpdateAll` from `Settings.tsx` into `AppContext` as `updateAllGithub`. Rewrite the Mods view toolbar button into a state-machine with a primary action verb + a small ↻ re-audit icon. Add a `Latest` pill (reuses the existing `.gf-pill-ok` class) on rows that satisfy a new shared `isUpToDate(entry)` helper. Demote Settings audit `Re-audit` button to ghost when bulk button shows (keeps existing N≥2 gate).

**Tech Stack:** Rust (tokio, futures_util, tauri), TypeScript (React, Vitest, Testing Library, @tauri-apps/api).

**Spec:** `docs/superpowers/specs/2026-05-12-audit-update-ux-design.md`

---

## File map

**Backend (Rust):**
- Modify: `src-tauri/src/updater.rs` — `audit_mod_versions` (split, parallelize, sort)
- (No new files; the extracted `audit_one_mod` lives alongside its caller for now.)

**Frontend (TypeScript/React):**
- Modify: `src/contexts/AppContext.tsx` — add `updateAllGithub` and `updatingAll` state to context value
- New: `src/lib/auditState.ts` — shared `isUpToDate(entry)` + `countGithubUpdates(entries)` helpers
- New: `src/lib/auditState.test.ts` — tests for the helpers above
- Modify: `src/views/Mods.tsx` — toolbar button state-machine, ↻ re-audit icon button, Latest pill on rows
- Modify: `src/views/Settings.tsx` — call `updateAllGithub` from context, demote Re-audit when bulk button shows, render Latest pill, drop local `updatingAll` state and `handleUpdateAll` body
- Modify: `src/views/Mods.test.tsx` — update existing button-label tests, add new tests for action behavior + ↻ button
- Modify: `src/views/Settings.test.tsx` — Latest pill render test, button-variant tests
- Modify: `src/styles.css` — only if a new pill style is needed (we expect to reuse `.gf-pill-ok`)

---

## Task 1: Add shared `isUpToDate` helper + tests

**Files:**
- Create: `src/lib/auditState.ts`
- Create: `src/lib/auditState.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/auditState.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { ModAuditEntry } from '../types';
import { isUpToDate, countGithubUpdates } from './auditState';

function entry(over: Partial<ModAuditEntry>): ModAuditEntry {
  return {
    mod_name: 'X',
    folder_name: null,
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
    min_game_version: null,
    game_version_too_old: false,
    latest_release_min_game_version: null,
    latest_release_blocked_by_game_version: false,
    latest_compatible_tag: null,
    ...over,
  };
}

describe('isUpToDate', () => {
  it('returns true when a GitHub-linked mod has no pending update and no problems', () => {
    expect(
      isUpToDate(entry({ github_repo: 'a/b', needs_update: false })),
    ).toBe(true);
  });

  it('returns true when a Nexus-linked mod has no pending update', () => {
    expect(
      isUpToDate(entry({ nexus_url: 'https://nexusmods.com/x', needs_update: false })),
    ).toBe(true);
  });

  it('returns false when the row has no source linked', () => {
    expect(isUpToDate(entry({ github_repo: null, nexus_url: null }))).toBe(false);
  });

  it('returns false when an update is pending', () => {
    expect(
      isUpToDate(entry({ github_repo: 'a/b', needs_update: true })),
    ).toBe(false);
  });

  it('returns false when the row has a real error (not auto-detected fallback)', () => {
    expect(
      isUpToDate(
        entry({ github_repo: 'a/b', error: '404', github_auto_detected: false }),
      ),
    ).toBe(false);
  });

  it('ignores errors when they are the auto-detected-fallback flavor', () => {
    expect(
      isUpToDate(
        entry({ github_repo: 'a/b', error: 'whatever', github_auto_detected: true }),
      ),
    ).toBe(true);
  });

  it('returns false when GitHub has a release but no installable assets', () => {
    expect(
      isUpToDate(
        entry({
          github_repo: 'a/b',
          latest_release_tag: 'v2',
          latest_release_with_assets_tag: null,
        }),
      ),
    ).toBe(false);
  });

  it('returns false when the mod is incompatible with the installed game version', () => {
    expect(
      isUpToDate(entry({ github_repo: 'a/b', game_version_too_old: true })),
    ).toBe(false);
  });
});

describe('countGithubUpdates', () => {
  it('counts only GitHub rows that have installable assets and a pending update', () => {
    const rows: ModAuditEntry[] = [
      entry({ mod_name: 'A', github_repo: 'a/a', needs_update: true, latest_release_with_assets_tag: 'v2' }),
      entry({ mod_name: 'B', github_repo: 'b/b', needs_update: true, latest_release_with_assets_tag: null }),
      entry({ mod_name: 'C', github_repo: null, nexus_url: 'x', needs_update: true }),
      entry({ mod_name: 'D', github_repo: 'd/d', needs_update: false, latest_release_with_assets_tag: 'v1' }),
    ];
    expect(countGithubUpdates(rows)).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/auditState.test.ts`
Expected: FAIL with `Failed to resolve import "./auditState"` (file doesn't exist yet).

- [ ] **Step 3: Write the implementation**

Create `src/lib/auditState.ts`:

```ts
import type { ModAuditEntry } from '../types';

export function isUpToDate(entry: ModAuditEntry): boolean {
  const hasSource = Boolean(entry.github_repo || entry.nexus_url);
  if (!hasSource) return false;
  if (entry.needs_update) return false;
  const hasRealError = Boolean(entry.error) && !entry.github_auto_detected;
  if (hasRealError) return false;
  const goneNoAssets =
    Boolean(entry.latest_release_tag) && !entry.latest_release_with_assets_tag;
  if (goneNoAssets) return false;
  if (entry.game_version_too_old) return false;
  return true;
}

export function countGithubUpdates(entries: ModAuditEntry[]): number {
  return entries.filter(
    (e) => e.needs_update && e.github_repo && e.latest_release_with_assets_tag,
  ).length;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/lib/auditState.test.ts`
Expected: PASS, 9/9.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auditState.ts src/lib/auditState.test.ts
git commit -m "feat(audit): isUpToDate + countGithubUpdates helpers"
```

---

## Task 2: Lift `updateAllGithub` into `AppContext`

**Files:**
- Modify: `src/contexts/AppContext.tsx`
- Modify: `src/contexts/AppContext.test.tsx` (existing test file — add a test)

- [ ] **Step 1: Write the failing test**

Add at the bottom of `src/contexts/AppContext.test.tsx` (alongside existing tests — keep their imports working):

```ts
it('exposes updateAllGithub that runs the bulk-update path and refreshes audit rows', async () => {
  const useTauri = await import('../hooks/useTauri');
  const updateAllMock = vi.spyOn(useTauri, 'updateAllMods').mockResolvedValue([
    { name: 'A', enabled: true, version: '2.0.0', folder_name: 'A', mod_id: null,
      min_game_version: null, github_url: null, nexus_url: null } as any,
  ]);
  vi.spyOn(useTauri, 'auditModVersions').mockResolvedValue([]);

  let ctx: ReturnType<typeof useApp> | null = null;
  function Probe() {
    ctx = useApp();
    return null;
  }
  render(
    <ToastProvider>
      <ConfirmProvider>
        <AppProvider>
          <Probe />
        </AppProvider>
      </ConfirmProvider>
    </ToastProvider>,
  );

  await waitFor(() => expect(ctx).not.toBeNull());
  // Auto-confirm dialog: stub window.confirm path used by ConfirmProvider for tests
  // (matches the pattern used elsewhere in this test file).
  const result = ctx!.updateAllGithub(['A']);
  // The ConfirmProvider in tests auto-resolves true (see test setup); if not,
  // the test setup file mocks it.
  await result;
  expect(updateAllMock).toHaveBeenCalled();
});
```

(Note: the exact `ConfirmProvider` auto-resolve harness is already established in this file — match the pattern used by existing tests that invoke confirm-protected actions. Read the file's top imports + helpers before writing the test.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/contexts/AppContext.test.tsx -t "updateAllGithub"`
Expected: FAIL — `ctx.updateAllGithub is not a function`.

- [ ] **Step 3: Add the new state, function, and context value**

In `src/contexts/AppContext.tsx`:

3a. Add `updateAllMods` to the existing top-of-file import from `useTauri`:

```ts
import {
  getGameInfo, getInstalledMods, isGameRunning, checkSubscriptionUpdates,
  auditModVersions, updateAllMods,
} from '../hooks/useTauri';
```

3b. Add `useConfirm` import and `useToast` (toast is already imported). At top of file:

```ts
import { useConfirm } from './ConfirmContext';
```

(Confirm the existing confirm-context import path matches what `Settings.tsx` uses — adjust if different.)

3c. Extend `AppContextType` (around line 22-29):

```ts
  /** True while updateAllGithub is in flight. Drives the toolbar's
   *  "Updating N…" disabled state in both Mods and Settings views. */
  updatingAll: boolean;
  /** Run a bulk update across every GitHub-sourced row in `names`. Shows
   *  a confirm, toasts a summary, then re-audits just the touched rows.
   *  Safe to call with a single name. */
  updateAllGithub: (githubUpdateNames: string[]) => Promise<void>;
```

3d. Add state inside `AppProvider` near the other useState calls (after `auditing`):

```ts
  const [updatingAll, setUpdatingAll] = useState<boolean>(false);
  const confirm = useConfirm();
```

3e. Add the function below `refreshAuditEntries`:

```ts
  /** Bulk-update every GitHub-sourced mod the audit flagged. Pinned mods
   *  are skipped on the backend, so this only touches things the audit
   *  was already flagging. We confirm first because it kicks off multiple
   *  downloads and modifies the install on disk. After completion we
   *  re-audit only the rows we touched (the union of requested names and
   *  what came back — mod names can shift after install when the manifest
   *  renames). */
  const updateAllGithub = useCallback(async (githubUpdateNames: string[]) => {
    if (updatingAll || githubUpdateNames.length === 0) return;
    const ok = await confirm({
      title: `Update ${githubUpdateNames.length} mod${githubUpdateNames.length === 1 ? '' : 's'}?`,
      body:
        `This will download and re-install the latest GitHub release for each. ` +
        `Pinned mods are skipped. Make sure STS2 is closed first.`,
      confirmLabel: `Update ${githubUpdateNames.length} mod${githubUpdateNames.length === 1 ? '' : 's'}`,
    });
    if (!ok) return;
    setUpdatingAll(true);
    try {
      const updated = await updateAllMods();
      toast.success(
        updated.length === 0
          ? 'Nothing to update.'
          : `Updated ${updated.length} mod${updated.length === 1 ? '' : 's'}.`,
      );
      await refreshAll();
      const names = Array.from(
        new Set([...githubUpdateNames, ...updated.map((m) => m.name)]),
      );
      await refreshAuditEntries(names);
    } catch (e) {
      toast.error(`Update all failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUpdatingAll(false);
    }
  }, [updatingAll, confirm, toast, refreshAll, refreshAuditEntries]);
```

3f. Add the two new fields to the `<AppContext.Provider value={{ ... }}>` literal:

```tsx
<AppContext.Provider value={{
  gameInfo, mods, loading, activeProfile, gameRunning, subUpdates,
  auditResults, auditing, runAudit, refreshAuditEntries,
  updatingAll, updateAllGithub,
  refreshGameInfo, refreshMods, refreshAll, refreshGameRunning, refreshSubUpdates,
  setActiveProfile, notifyNexusOpen,
}}>
```

- [ ] **Step 4: Run all AppContext tests**

Run: `npx vitest run src/contexts/AppContext.test.tsx`
Expected: PASS (including the new `updateAllGithub` test).

- [ ] **Step 5: Commit**

```bash
git add src/contexts/AppContext.tsx src/contexts/AppContext.test.tsx
git commit -m "feat(audit): lift updateAllGithub from Settings into AppContext"
```

---

## Task 3: Replace Mods view toolbar button with state-machine + ↻

**Files:**
- Modify: `src/views/Mods.tsx`
- Modify: `src/views/Mods.test.tsx`

- [ ] **Step 1: Update existing tests + add new ones**

In `src/views/Mods.test.tsx`, find every assertion that uses the literal `Check for updates` and update to `Audit mods`. Replace each block of the form:

```ts
await user.click(screen.getByRole('button', { name: 'Check for updates' }));
```

with:

```ts
await user.click(screen.getByRole('button', { name: 'Audit mods' }));
```

For the test currently asserting `screen.getByRole('button', { name: /^1 update$/ })` (around line 133): update the assertion to:

```ts
expect(screen.getByRole('button', { name: /^Update 1 mod$/ })).toBeInTheDocument();
```

Then add a new test block (after the existing ones in the same `describe`):

```ts
it('clicking the "Update N mods" toolbar button triggers the bulk update, not a re-audit', async () => {
  const useTauri = await import('../hooks/useTauri');
  const updateAllSpy = vi.spyOn(useTauri, 'updateAllMods').mockResolvedValue([]);
  const auditSpy = vi.spyOn(useTauri, 'auditModVersions');
  const user = userEvent.setup();
  render(<Wrap />);
  await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
  await user.click(screen.getByRole('button', { name: 'Audit mods' }));
  const updateBtn = await screen.findByRole('button', { name: /^Update 1 mod$/ });
  const auditCallsAfterAudit = auditSpy.mock.calls.length;
  await user.click(updateBtn);
  // Confirm dialog auto-accepts in this test harness.
  await waitFor(() => expect(updateAllSpy).toHaveBeenCalledTimes(1));
  // The bulk update path triggers a *targeted* re-audit afterwards (refreshAuditEntries),
  // so we expect exactly one additional auditModVersions call (the targeted one),
  // never a fresh full audit caused by clicking the button itself.
  expect(auditSpy.mock.calls.length).toBe(auditCallsAfterAudit + 1);
  expect(auditSpy.mock.calls[auditSpy.mock.calls.length - 1][0]).toEqual(['BaseLib']);
});

it('the ↻ re-audit icon button calls runAudit', async () => {
  const useTauri = await import('../hooks/useTauri');
  const auditSpy = vi.spyOn(useTauri, 'auditModVersions');
  const user = userEvent.setup();
  render(<Wrap />);
  await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
  await user.click(screen.getByRole('button', { name: 'Audit mods' }));
  await screen.findByRole('button', { name: /^Update 1 mod$/ });
  const callsBefore = auditSpy.mock.calls.length;
  await user.click(screen.getByRole('button', { name: 'Re-audit' }));
  await waitFor(() => expect(auditSpy.mock.calls.length).toBe(callsBefore + 1));
});
```

(Confirm the mock fixture in `Wrap` includes `BaseLib` with a pending GitHub update so `Update 1 mod` appears — this is the existing test pattern at `src/views/Mods.test.tsx` line ~130.)

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run src/views/Mods.test.tsx -t "Update N mods toolbar button"`
Expected: FAIL — button labeled "1 update" not "Update 1 mod" yet; re-audit ↻ button doesn't exist.

- [ ] **Step 3: Replace the toolbar button block in `src/views/Mods.tsx`**

Add the import at the top of `src/views/Mods.tsx`:

```ts
import { countGithubUpdates } from '../lib/auditState';
```

Pull the new context fields where `useApp()` is currently called:

```ts
const { /* …existing destructured… */ updatingAll, updateAllGithub } = useApp();
```

Replace the existing toolbar `<Button …>{Check for updates / Checking… / N updates / Up to date}</Button>` (currently `Mods.tsx:411–430`) with this block:

```tsx
{(() => {
  const ghUpdateCount = auditResults ? countGithubUpdates(auditResults) : 0;
  const ghUpdateNames = auditResults
    ? auditResults
        .filter(r => r.needs_update && r.github_repo && r.latest_release_with_assets_tag)
        .map(r => r.mod_name)
    : [];

  if (auditing) {
    return (
      <Button variant="secondary" size="sm" disabled title="Checking each mod against its source…">
        <ClipboardCheck size={14} className="animate-pulse" />
        Auditing…
      </Button>
    );
  }

  if (updatingAll) {
    return (
      <Button variant="primary" size="sm" disabled>
        <RefreshCw size={14} className="animate-spin" />
        Updating {ghUpdateCount}…
      </Button>
    );
  }

  if (auditResults === null) {
    return (
      <Button
        variant="secondary"
        size="sm"
        onClick={handleCheckUpdates}
        title="Check each mod against its source for updates."
      >
        <ClipboardCheck size={14} />
        Audit mods
      </Button>
    );
  }

  if (ghUpdateCount === 0) {
    return (
      <>
        <span
          className="gf-pill gf-pill-ok"
          title="Every linked mod is on its source's latest installable release."
          style={{ padding: '6px 10px', fontSize: 13 }}
        >
          Up to date
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleCheckUpdates}
          title="Re-audit"
          aria-label="Re-audit"
        >
          <RefreshCw size={14} />
        </Button>
      </>
    );
  }

  return (
    <>
      <Button
        variant="primary"
        size="sm"
        onClick={() => updateAllGithub(ghUpdateNames)}
        title="Update every GitHub-linked mod with a pending update. Pinned mods are skipped."
      >
        <Download size={14} />
        Update {ghUpdateCount} mod{ghUpdateCount === 1 ? '' : 's'}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        onClick={handleCheckUpdates}
        title="Re-audit"
        aria-label="Re-audit"
      >
        <RefreshCw size={14} />
      </Button>
    </>
  );
})()}
```

If `Download` and `RefreshCw` aren't already imported at the top of `Mods.tsx`, add them to the `lucide-react` import.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/views/Mods.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/Mods.tsx src/views/Mods.test.tsx
git commit -m "feat(mods): toolbar state-machine — 'Update N mods' actually updates"
```

---

## Task 4: Render Latest pill on Mods view rows

**Files:**
- Modify: `src/views/Mods.tsx`
- Modify: `src/views/Mods.test.tsx`

- [ ] **Step 1: Write the failing test**

Add to `src/views/Mods.test.tsx` in the same `describe`:

```ts
it('renders a "Latest" pill on rows whose audit entry is up-to-date', async () => {
  const user = userEvent.setup();
  render(<Wrap />); // Wrap fixture must include a mod whose audit says needs_update=false + github_repo set.
  await waitFor(() => { expect(screen.getByText('BaseLib')).toBeInTheDocument(); });
  await user.click(screen.getByRole('button', { name: 'Audit mods' }));
  // Pick a test fixture mod that is up-to-date. If the existing fixtures don't
  // include one, extend the local mock to include a second mod e.g. "GoodMod"
  // with needs_update=false and github_repo set; assert its Latest pill.
  const latestPills = await screen.findAllByText('Latest');
  expect(latestPills.length).toBeGreaterThanOrEqual(1);
});
```

If the existing `Wrap` fixture's audit mock doesn't include an up-to-date row, extend it to add one (e.g. add a `GoodMod` audit entry with `needs_update: false`, `github_repo: 'good/mod'`, `latest_release_with_assets_tag: 'v1'`, and the matching installed mod row). Keep the change small — one extra entry.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/views/Mods.test.tsx -t "Latest"`
Expected: FAIL — `unable to find element with the text: Latest`.

- [ ] **Step 3: Render the pill**

Add the import at the top of `src/views/Mods.tsx`:

```ts
import { isUpToDate } from '../lib/auditState';
```

Find where each Mods view row renders the mod name (search for `entry.mod_name` or wherever the row title renders — the existing audit-derived pills like "Update available" render in the same area). Add next to those pills:

```tsx
{audit && isUpToDate(audit) && (
  <span
    className="gf-pill gf-pill-ok"
    title="On the source's latest installable release."
  >
    Latest
  </span>
)}
```

Where `audit` is the row's `auditByKey.get(rowKey)` lookup that already exists in this file (see the `auditByKey` memo around `Mods.tsx:110`). If the variable in the local render scope has a different name, use that name; don't introduce a new lookup.

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/views/Mods.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/Mods.tsx src/views/Mods.test.tsx
git commit -m "feat(mods): Latest pill on up-to-date rows"
```

---

## Task 5: Migrate Settings to context-based `updateAllGithub` + render Latest pill + demote Re-audit

**Files:**
- Modify: `src/views/Settings.tsx`
- Modify: `src/views/Settings.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `src/views/Settings.test.tsx`:

```ts
it('renders a "Latest" pill on up-to-date audit rows', async () => {
  const user = userEvent.setup();
  render(<Wrap />); // existing fixture must include at least one up-to-date row
  await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
  await user.click(screen.getByRole('button', { name: /Audit/ }));
  await user.click(screen.getByRole('button', { name: /Run audit|Re-audit/ }));
  const latestPills = await screen.findAllByText('Latest');
  expect(latestPills.length).toBeGreaterThanOrEqual(1);
});

it('demotes Re-audit to ghost variant when 2+ GitHub updates are pending', async () => {
  const user = userEvent.setup();
  render(<Wrap />); // fixture must include 2+ rows with needs_update + github + assets tag
  await waitFor(() => { expect(screen.getByText('Game Path')).toBeInTheDocument(); });
  await user.click(screen.getByRole('button', { name: /Audit/ }));
  await user.click(screen.getByRole('button', { name: /Run audit|Re-audit/ }));
  // Wait for audit to land
  const updateAllBtn = await screen.findByRole('button', { name: /^Update \d+ mods$/ });
  expect(updateAllBtn).toBeInTheDocument();
  const reAuditBtn = screen.getByRole('button', { name: /^Re-audit$/ });
  // The ghost variant in this codebase renders with `gf-btn-ghost` (or similar — confirm token).
  expect(reAuditBtn.className).toMatch(/ghost/);
});
```

(If the existing `Wrap` fixture doesn't yield 2+ pending GitHub updates, extend it to include a second `needs_update + github + assets` entry. Keep changes minimal.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/views/Settings.test.tsx -t "Latest pill|demotes Re-audit"`
Expected: FAIL — "Latest" not rendered; Re-audit button still has secondary variant.

- [ ] **Step 3: Migrate Settings**

In `src/views/Settings.tsx`:

3a. Add the imports:

```ts
import { isUpToDate, countGithubUpdates } from '../lib/auditState';
```

3b. Replace the destructured useApp call to add the new context fields:

```ts
const {
  gameInfo, refreshAll, auditResults, auditing, runAudit, refreshAuditEntries,
  updatingAll, updateAllGithub,
} = useApp();
```

3c. Delete the local `updatingAll` state declaration (around line 76):

```ts
// REMOVE this line:
const [updatingAll, setUpdatingAll] = useState(false);
```

3d. Delete the entire local `handleUpdateAll` function (around lines 295–330). Its call sites become `updateAllGithub`.

3e. In the audit toolbar block (around line 742), update the `onClick` to call the context function and update the button label to match the unified wording:

```tsx
<Button
  variant="primary"
  size="sm"
  onClick={() => updateAllGithub(ghUpdates)}
  disabled={updatingAll || updatingMod !== null}
  title={`Update ${ghUpdates.length} GitHub-sourced mods (skips pinned)`}
>
  {updatingAll ? (
    <RefreshCw size={14} className="animate-spin" />
  ) : (
    <Download size={14} />
  )}
  {updatingAll
    ? `Updating ${ghUpdates.length}…`
    : `Update ${ghUpdates.length} mod${ghUpdates.length === 1 ? '' : 's'}`}
</Button>
```

3f. Update the Re-audit button to ghost variant when the bulk button is showing (i.e. `ghUpdates.length >= 2`):

```tsx
<Button
  variant={ghUpdates.length >= 2 ? 'ghost' : 'secondary'}
  size="sm"
  onClick={runAudit}
  disabled={auditing || updatingAll}
>
  <ClipboardCheck size={14} className={auditing ? 'animate-pulse' : ''} />
  {auditing ? 'Auditing...' : auditResults ? 'Re-audit' : 'Run audit'}
</Button>
```

3g. In the per-row render block (around line 829), add the Latest pill next to the mod name. Find the JSX:

```tsx
<span className="font-medium flex items-center gap-2" style={{ color: 'var(--ink)' }}>
  <span className={`gf-audit-led ${ledClass}`} />
  {entry.mod_name}
  {entry.pinned && (
    <span className="gf-pill" style={{ background: 'var(--indigo-elev)', color: 'var(--ink-mute)' }}>
```

Add a Latest pill before the Pinned pill:

```tsx
{isUpToDate(entry) && (
  <span className="gf-pill gf-pill-ok" title="On the source's latest installable release.">
    Latest
  </span>
)}
```

3h. (Optional but recommended consistency.) Replace the inline `okCount` IIFE in the footer (around line 1045) with a `countUpToDate` derived from the helper so the footer count and the Latest pill can never diverge:

```tsx
const okCount = auditResults.filter(isUpToDate).length;
```

(Verify the resulting `okCount` matches the prior inline predicate — they should be byte-equal given that `isUpToDate` mirrors the inline predicate.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/views/Settings.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/views/Settings.tsx src/views/Settings.test.tsx
git commit -m "feat(settings): use context updateAllGithub, render Latest pill, demote Re-audit"
```

---

## Task 6: Parallelize the Rust audit loop

**Files:**
- Modify: `src-tauri/src/updater.rs`

This task is structured to keep the diff reviewable: first extract the per-mod body into a function without changing behavior, run all tests to confirm parity, then swap the loop for `buffer_unordered`.

### 6a. Define the audit context struct

- [ ] **Step 1: Add a context struct above `audit_mod_versions`**

In `src-tauri/src/updater.rs`, just above `pub async fn audit_mod_versions` (line 1206), add:

```rust
/// Immutable inputs the per-mod audit body needs. Held by reference so
/// we can share it across the concurrent stream without cloning per mod.
struct AuditCtx<'a> {
    sources_db: &'a ModSources,
    nexus_api_key: Option<&'a str>,
    user_game_version: Option<&'a str>,
    cache_path: &'a std::path::Path,
    token: Option<&'a str>,
}

/// How many per-mod audit tasks can run concurrently. 8 is empirically
/// the sweet spot for GitHub's secondary rate limit on unauthenticated
/// clients — high enough to mask network latency, low enough to stay
/// under the 100/min secondary cap.
const AUDIT_CONCURRENCY: usize = 8;
```

(`ModSources` is the type of `sources_db` — confirm the actual name by reading the existing `load_sources` return type and use it.)

### 6b. Extract `audit_one_mod`

- [ ] **Step 2: Move the per-mod body into a new function**

Below `audit_mod_versions`, add:

```rust
/// Audit one mod. Returns an entry even for mods with no source linked.
/// Errors at the per-source level (GitHub 404, Nexus rate-limit, etc.)
/// are captured into `ModAuditEntry.error` — this function returns
/// `ModAuditEntry` rather than `Result` because a single mod failing
/// must not cancel the rest of the stream.
async fn audit_one_mod(m: &ModInfo, ctx: &AuditCtx<'_>) -> ModAuditEntry {
    // Body copied verbatim from the previous loop, with these substitutions:
    //   sources_db          → ctx.sources_db
    //   nexus_api_key       → ctx.nexus_api_key.map(|s| s.to_string())
    //   user_game_version   → ctx.user_game_version.map(|s| s.to_string())
    //   cache_path          → ctx.cache_path
    //   token               → ctx.token
    // …then `return entry;` at the bottom instead of `results.push(entry);`.
}
```

Concretely: copy lines 1250–1647 of the pre-change file (the entire loop body — both the `if !has_any_source { results.push(...); continue; }` and the final `results.push(...)` paths) into the function body. Replace the two push-then-continue / push paths with `return entry_value;`. The `for m in &all_mods { … }` loop in `audit_mod_versions` is replaced with a call to this function (still sequentially for now — concurrency comes in 6c).

After this step, `audit_mod_versions` looks like:

```rust
let ctx = AuditCtx {
    sources_db: &sources_db,
    nexus_api_key: nexus_api_key.as_deref(),
    user_game_version: user_game_version.as_deref(),
    cache_path: &cache_path,
    token: token.as_deref(),
};

let mut results: Vec<ModAuditEntry> = Vec::with_capacity(all_mods.len());
for m in &all_mods {
    results.push(audit_one_mod(m, &ctx).await);
}

Ok(results)
```

- [ ] **Step 3: Build and run the full Rust test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — extraction must be behavior-preserving. If anything fails, that's a copy-paste bug in the extraction; fix before continuing.

Also run the cassette playback if it has its own test target:

Run: `cargo test --manifest-path src-tauri/Cargo.toml audit_mod_versions`
Expected: PASS.

- [ ] **Step 4: Commit the extraction**

```bash
git add src-tauri/src/updater.rs
git commit -m "refactor(audit): extract audit_one_mod (no behavior change)"
```

### 6c. Parallelize via `buffer_unordered` + stable sort

- [ ] **Step 5: Add the import at the top of `updater.rs`**

```rust
use futures_util::stream::{self, StreamExt};
```

(`futures-util` is already in `Cargo.toml` per `grep -E "^(futures|tokio)" src-tauri/Cargo.toml`.)

- [ ] **Step 6: Swap the sequential loop for `buffer_unordered`**

Replace the loop in `audit_mod_versions`:

```rust
let mut results: Vec<ModAuditEntry> = stream::iter(all_mods.iter())
    .map(|m| audit_one_mod(m, &ctx))
    .buffer_unordered(AUDIT_CONCURRENCY)
    .collect()
    .await;

// buffer_unordered yields results in completion order. Re-sort by the
// mod's display name so the UI render order is stable across audits.
results.sort_by(|a, b| {
    a.mod_name.to_lowercase().cmp(&b.mod_name.to_lowercase())
});

Ok(results)
```

The previous loop's order was the scan order of `all_mods` — that's already non-stable across runs (filesystem readdir order), so sorting by name here is a strict improvement.

- [ ] **Step 7: Run the Rust test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: PASS — concurrent execution must produce the same logical entries.

Also test that the cassette-playback layer still works (per `src-tauri/src/lib.rs:22` comment, `audit_mod_versions` is called directly by the cassette layer). If there's a specific cassette test:

Run: `cargo test --manifest-path src-tauri/Cargo.toml -- --include-ignored qa_cassette`
Expected: PASS.

- [ ] **Step 8: Smoke-test in dev**

```bash
npm run tauri dev
```

In the app: open Settings → Audit, click `Run audit`. Verify (a) it completes faster than before (subjective — should feel snappy on 10+ mods), (b) the row order is alphabetical and stable across consecutive audits, (c) no rows missing, (d) error rows still surface their error string.

- [ ] **Step 9: Commit**

```bash
git add src-tauri/src/updater.rs
git commit -m "perf(audit): run per-mod checks in parallel (concurrency 8)"
```

---

## Task 7: End-to-end verification

**Files:** none modified.

- [ ] **Step 1: Run the entire frontend test suite**

Run: `npm test`
Expected: all tests PASS. Coverage stays above the existing gates set in `vitest.config.ts`.

- [ ] **Step 2: Run the entire backend test suite**

Run: `cargo test --manifest-path src-tauri/Cargo.toml`
Expected: all tests PASS.

- [ ] **Step 3: Manual smoke test against the running app**

Run: `npm run tauri dev`

Walk the QA list from the spec:
- 0 mods → `Audit mods` button available; click → empty Audit state; toolbar returns to idle.
- 1 mod with update → click `Audit mods` → button becomes `Update 1 mod` → click → confirm → mod updates → button settles to `Up to date` pill + ↻.
- 3 mods, 2 with updates, 1 pinned with update → toolbar shows `Update 2 mods` (pinned excluded by backend); confirm dialog body mentions pinned-skipped.
- ↻ re-audit during the "Up to date" or "Update N" states triggers an audit, not an update.
- Settings → Audit: Re-audit button is ghost-styled when N≥2 updates pending; secondary when N<2 or no audit yet.
- Latest pill renders on every audit row that satisfies `isUpToDate` — both Settings and Mods views.

- [ ] **Step 4: Final commit (only if any smoke-test follow-ups needed)**

If smoke test surfaces a bug, fix and commit. Otherwise no commit.

---

## Self-Review

Reviewed against `docs/superpowers/specs/2026-05-12-audit-update-ux-design.md`:

- **Section 1 (parallelism)** — Task 6 covers extraction (6a–6b) and parallelization (6c) with both an inline `cargo test` checkpoint after extraction and another after parallelization. Sort-by-name + AUDIT_CONCURRENCY=8 + AuditCtx all match the spec.
- **Section 2 (Mods view toolbar)** — Task 3 covers the full state machine (Audit mods / Auditing… / Up to date+↻ / Update N mods+↻ / Updating N…). The `updateAllGithub` lift is Task 2. Tests pin both the new labels and the action behavior.
- **Section 3 (Latest pill)** — Task 1 builds `isUpToDate`. Task 4 renders it on Mods view. Task 5 renders it on Settings rows. Same helper drives both, so they can't diverge.
- **Section 4 (Settings alignment)** — Task 5 keeps the N≥2 gate, demotes Re-audit to ghost when bulk button shows, unifies the label to `Update N mods`, calls the context function, and renders the Latest pill.
- **Confirm dialog confirmLabel** — spec called for `Update N mods` instead of `Update all`; implemented in Task 2 step 3e.
- **Type/name consistency** — `updateAllGithub`, `updatingAll`, `isUpToDate`, `countGithubUpdates`, `AuditCtx`, `audit_one_mod`, `AUDIT_CONCURRENCY` — used consistently across all tasks.
- **No placeholders** — every code step contains the actual code; no "TBD" or "similar to above". Two callouts use "confirm the existing token by reading file" style verification, which is appropriate when the engineer needs to match an existing pattern they can grep for in seconds.

No gaps found.
