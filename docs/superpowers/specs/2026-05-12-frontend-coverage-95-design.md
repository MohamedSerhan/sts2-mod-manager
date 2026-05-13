# Frontend coverage to 95 % + smoke backlog + backend pure-helper coverage

**Status:** draft — awaiting user review.
**Worktree:** `.claude/worktrees/frontend-coverage-95` (branch
`worktree-frontend-coverage-95`).

## Why

`qa/whats-left.md` left two QA debts open at the v1.3.4 cut:

1. **Frontend coverage gate** — measured by Vitest + v8, sitting at
   ~70 % lines today, with a stated target of 95 %. The thresholds in
   `vitest.config.ts` are deliberately set below the live number so
   a normal day doesn't fail the gate; they have not yet been raised
   to the goal because the per-file gaps below 95 % were never
   filled in.
2. **Tier-2 WebDriver smoke specs** — the cassette + fixture
   infrastructure shipped, but a handful of high-value flows are
   still un-spec'd (profile switch, repair walk-back, three
   walkthrough-finding regression locks).

The user also wants the **backend pure helpers** that are completely
untested (download.rs has zero tests today) brought up far enough
that the high-value functions are exercised. Not full backend
coverage — sharing.rs / subscriptions.rs / updater's HTTP paths
need a stateful GitHub mock that whats-left.md explicitly defers.

## Goal

Single end-state, verifiable by running `npm run qa` from the
worktree:

- **Vitest:** all of `lines ≥ 95`, `statements ≥ 95`,
  `functions ≥ 95`, `branches ≥ 90`, with `vitest.config.ts`
  thresholds raised to enforce this on every subsequent run.
- **Smoke:** five new specs added — profile switch, repair
  walk-back, walkthrough-finding #20 / #21 / #22 — running green
  in both base and `CASSETTE=1` modes as appropriate.
- **Backend:** pure helpers in `download.rs` covered by unit
  tests in-file; no goal numeric threshold, just "the functions
  listed below have tests."

## Baseline (fresh, 2026-05-12)

```
Statements 69.74%   Branches 65.62%   Functions 72.59%   Lines 70.87%
452 tests / 36 files
```

Per-file gaps (sorted by uncovered-line count):

| File | Stmts | Lines | Branch | Funcs | Notes |
|---|---|---|---|---|---|
| `views/Settings.tsx` | 54.74 | 56.39 | 66.76 | 66.1 | ~480 lines uncov, 1143-line file; top-tab bodies untested |
| `views/Home.tsx` | 52.14 | 53.45 | 45.81 | 58.46 | ~370 uncov; share-code paste, subscription banner, drift overlay, version-up toast |
| `views/Profiles.tsx` | 53.48 | 55.6 | 55.5 | 52.7 | ~350 uncov; snapshot create, repair, share kebab, apply-with-skipped |
| `components/OnboardingOverlay.tsx` | 25 | 23.52 | 54.16 | 25 | ~230 uncov; steps 2–5 of the wizard never enter a test |
| `App.tsx` | 66.52 | 68.36 | 59.6 | 60.27 | ~190 uncov; top-bar resize handle, `sts2mm://` deep-link parsing, dev-badge branches |
| `views/Mods.tsx` | 71.36 | 73.51 | 69.11 | 83.33 | ~180 uncov; advanced-mode form open/close, source editor save, repair confirmation |
| `views/Browse.tsx` | 60.71 | 61.53 | 54.16 | 44.82 | ~135 uncov; Nexus-trending error path (194-225), install-from-detail (291-348) |
| `components/PublishModal.tsx` | 65 | 66.15 | 58.26 | 61.9 | ~120 uncov |
| `components/AutoDetectModal.tsx` | 54.71 | 53.33 | 55.31 | 66.66 | ~80 uncov |
| `components/DiagnosticBundle.tsx` | 63.88 | 73.33 | 54.54 | 44.44 | ~50 uncov |
| `contexts/AppContext.tsx` | 84.67 | 84.54 | 50 | 82.35 | polling loop's error path + refresh-throttle branch |

Files already ≥ 90 % across the board are left alone.

## Approach

### Phase 1 — Vitest, file-by-file (priority order above)

For each file:

1. Run `npm run qa:coverage` (or just `npx vitest run <pattern>
   --coverage` for the target file) and read the uncovered-line
   ranges out of the `Uncovered Line #s` column.
2. Open the source file at those lines, identify the branch
   (modal state, error path, advanced-mode toggle, hot-key handler).
3. Extend the file's existing `*.test.tsx` with new `describe()`
   blocks. Every priority-list file already has a sibling test
   file (verified). Use the established `registerInvokeHandler`
   mock from `src/__test__/setup.ts`.
4. If the suite needs a new invoke shape, extend the helper
   rather than re-rolling per-test. Setup file is the source of
   truth for mock shapes.
5. Re-run coverage; iterate until the file clears 95 % lines /
   90 % branches.

**Per-tab split for Settings.tsx:** the file is 1143 lines with
seven tab bodies (General, Audit, Sources, Backup, Diagnostics,
About, plus the strip). One `describe()` per tab. Smoke already
covers the tab-strip click; tests cover the rendered body.

**Defensive branches:** some uncovered branches are genuinely
dead in tests (try/catch wrapping a promise that never rejects
under our mocks). Branches threshold is 90, not 95, exactly to
absorb that. If a file's branch metric stalls in the 88-89 range,
that is acceptable — write a comment in the test file documenting
which branches are intentionally unreached and why.

**Commits:** one per file. Branchable, reviewable, revertable.

### Phase 2 — Smoke spec backlog

Add to `qa/runner/smoke.mjs`. Each new spec gets a `specXxx`
function and an entry in the appropriate `*_SPECS` array. The
spec arrays should be split:

- `BASE_SPECS` — read-only navigation / render assertions (no
  state mutation, no cassette). Current contents stay as-is.
- `CASSETTE_SPECS` — needs `CASSETTE=1` for HTTP fixtures.
- `STATE_SPECS` — mutates the fixture-game tree. Currently
  this is mis-named `TOGGLE_SPECS` and is appended in non-cassette
  mode only. Rename + reorganize so state specs always run with
  a fresh fixture tree (rebuild between specs if needed; currently
  they share one tree by luck-of-ordering).

#### New specs

1. **Profile switch + apply** (`STATE_SPECS`).
   Create a second profile via the existing helper, click the
   profile to switch, assert the active-profile indicator updates,
   re-snapshot, assert pins survived the switch.
2. **Repair walk-back** (`CASSETTE_SPECS`, new fixture
   `qa-fixture/walkback-mod`).
   Seed a mod whose installed version exceeds the cassette's
   "compatible with current game version" tag list. Click
   Repair on the row. Wait for the walk-back tag to install,
   assert the installed `manifest.version` rolled back.
   Needs a new cassette under `qa/fixtures/github/repos/
   qa-fixture/walkback-mod/releases.json` returning two
   releases — one too-new, one compatible.
3. **#22 — toggle stickiness across profile switch** (`STATE_SPECS`).
   Toggle QaTestMod off. Switch to a second profile. Switch back.
   Assert the toggle is still off.
4. **#20 — Profile Repair deletes orphan disabled files**
   (`STATE_SPECS`).
   Seed `mods_disabled/OrphanMod/` with a mod file that isn't
   in the active profile manifest. Click Profiles → Repair.
   Assert the file is gone from disk.
5. **#21 — game-version-skipped mods don't pollute snapshot**
   (`CASSETTE_SPECS`, new fixture `qa-fixture/skipped-mod`).
   Seed a mod whose manifest carries `min_game_version: "999.0.0"`.
   Apply a profile. Re-snapshot. Assert the skipped mod is NOT
   in the new snapshot.

#### Deferred (out of scope, tracked in whats-left.md)

- Update-available pill → row refreshes (needs zip cassette fixture).
- Share-code import flow (needs stateful GitHub mock).
- Subscription apply (needs stateful mock).
- Drag-drop + launch + deep-link (OS-level, computer-use MCP).

### Phase 3 — Backend pure helpers (download.rs)

`download.rs` currently has zero tests. The HTTP-bound functions
(`fetch_*`, `download_*`, `search_github_*`,
`download_and_install_*`) need cassettes or a stateful mock — out
of scope. The pure helpers can be unit-tested in-file with a
`#[cfg(test)] mod tests`:

| Function | What to test |
|---|---|
| `slugify` (line 359) | Standard cases (spaces → `-`), unicode, empty, leading/trailing punctuation, multiple consecutive separators collapse |
| `repo_mentions_sts2` (line 171) | Description contains "STS2" / "Symphony" / "mod-loader"; case sensitivity; nil description |
| `find_best_asset` (line 535) | Prefers `.zip` over `.7z`, prefers exact name match, falls back, returns None on empty assets |
| `peek_zip_min_game_version` (line 434) | Pass a fixture zip with a manifest declaring `min_game_version`; assert the value comes back. Pass one without; assert `Ok(None)`. Pass a non-zip; assert error. |

`updater.rs` already has 10 tests; pure helpers
(`parse_version`, `is_version_tag`, `compare_versions`,
`is_newer_version`, `game_version_satisfies`,
`install_is_incompatible`, `parse_owner_repo`,
`is_mod_asset`) — spot-check whether they're covered;
add what's missing.

No backend threshold is enforced (matches existing convention —
backend coverage is reported, not gated).

### Phase 4 — Threshold bump

Final commit raises `vitest.config.ts`:

```ts
thresholds: {
  lines: 95,
  functions: 95,
  branches: 90,
  statements: 95,
},
```

Run `npm run qa:coverage` one more time; confirm it exits 0.

Update `qa/whats-left.md`:
- Strike the "Frontend coverage gate" section (or mark
  "**DONE — gate raised to 95/90/95/95**").
- Strike the Tier-2 specs that landed (profile switch,
  walk-back, #20/#21/#22).
- Leave the deferred items in place with their reasons intact.

## Risks

- **Settings.tsx may resist clean per-tab tests.** It is 1143
  lines and some tab bodies share helpers with siblings. If
  factoring them out is the only path to a 95 % gate, do a
  *minimal* extract (move a helper to a sibling file, no
  rename, no signature change). Avoid cosmetic refactors.
- **OnboardingOverlay's step 2-5 wizard depends on Tauri
  detect-game responses.** Mock shapes for each step must be
  added to `setup.ts`. Catalog them once, reuse across the
  five new tests.
- **Smoke state-spec isolation.** The current
  `TOGGLE_SPECS`/`STATE_SPECS` array shares one fixture tree
  across specs. Repair-walk-back (Phase 2 spec 2) and #20
  (Phase 2 spec 4) both touch the disabled-mods folder. Plan
  to rebuild `FIXTURE_DIRS` between mutating specs. (~30 LoC
  in the runner.)
- **Defensive branches.** Some `catch` blocks wrap promises
  that, given our mocks, never reject. Branches metric will
  not reach 95 % on those files. The 90 % threshold absorbs
  this. Don't write tests that exist solely to game the metric.

## Non-goals

- Backend coverage threshold gate.
- `sharing.rs` / `subscriptions.rs` coverage (needs stateful mock).
- Drag-drop / OS-level smoke specs.
- Any refactor that doesn't unblock a specific test.

## Deliverables

- ~11 commits, one per Vitest file lifted to ≥ 95 %.
- ~5 commits, one per new smoke spec (+ array reorganization commit).
- ~1 commit for `download.rs` pure-helper tests.
- 1 commit raising `vitest.config.ts` thresholds + striking
  closed items from `qa/whats-left.md`.
- Final `npm run qa` exits 0.
