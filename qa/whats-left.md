# What's left — QA backlog

Snapshot of unfinished QA work at the time of the v1.3.4 cut. Each
item lists what it costs to do and why we deferred it. Pick from
here when there's a slow week or after a user reports something
related.

## Tier 2 WebDriver scenarios (UI specs)

**Updated 2026-05-13:** Phase 2 of the frontend-coverage-95 work
landed `specProfileSwitchPreservesPins` and `specRepairWalkback`
(see `qa/runner/smoke.mjs`). Walk-back uses a new cassette under
`qa/fixtures/github/repos/qa-fixture/walkback-mod/`.

What's covered today (per `qa/scenarios/INDEX.md` + the smoke
harness):
- Scenarios 006–010 — toggle / audit-count / pin / delete / create-
  profile.
- ~~Profile switch + apply (the v1.3.1 pin-preservation contract)~~
  — **DONE (2026-05-13)**.
- ~~Repair walk-back — newer-than-game cassette, click Repair,
  verify the walk-back tag installs~~ — **DONE (2026-05-13)**.

Still uncovered (priority order):

- **Drag-drop a `.zip` onto the window** — Selenium can dispatch the
  Drop event but tauri's drag-drop intercept is at the OS level.
  Likely requires computer-use MCP. Defer until reported.
- **Click "Update available" pill → row refreshes** — exercises the
  walk-back compat check + zip download + extraction. Needs a zip
  cassette fixture (we'd cassette `github.com` redirects with a
  Compress-Archive-built tiny manifest zip). ~2 hours.
- **Share-code import flow** — needs a stateful GitHub mock (Profile
  sharing item below).
- **Subscription apply** — modpack curator pushes update, friend
  applies. Needs the stateful mock.
- **Drag-drop + launch + deep link** — all OS-level; either
  computer-use MCP or new harness tier.

## Cassette playback — DONE (v1.3.4 + qa-cassette feature)

GitHub + Nexus HTTP GETs are now intercepted by
`src-tauri/src/qa_cassette.rs` when the binary is built with
`--features qa-cassette` AND `$STS2_CASSETTE_DIR` is set. URL → file
mapping is documented in that module + `qa/fixtures/README.md`.

What landed:
- Cargo feature `qa-cassette` (no-op when off; compile-time gate).
- Cassette dir layout: `<dir>/github/<url-path>.json`,
  `<dir>/nexus/<url-path>` (.json suffix is preserved when present).
- Intercept wired into `fetch_latest_release`, `fetch_releases`,
  `fetch_release_by_tag`, `download_file`, and the three Nexus
  endpoints (`get_mod_info`, `get_mod_list`, `get_mod_files`).
- Synthetic fixtures for one pending-update mod
  (`qa-fixture/test-mod`), one already-current mod
  (`qa-fixture/uptodate-mod`), and one Nexus mod (`99999`).
- Integration test at `src-tauri/tests/qa_cassette.rs` exercising
  `check_all_updates` end-to-end without WebView2 (run with
  `cargo test --features qa-cassette --test qa_cassette`).
- Smoke harness gains a `CASSETTE=1` env switch that sets
  `STS2_CASSETTE_DIR` for the spawned tauri-driver.

What's NOT done yet (deferred):
- Downloads-watcher's blocking-reqwest path in
  `downloads_watcher.rs::nexus_resolve_variant_version` is the only
  Nexus call site that bypasses the intercept (uses
  `reqwest::blocking` with an inline closure rather than
  `NexusClient`). Audit flows don't touch it; subscription apply
  does. Add a sibling intercept call when that flow gets a spec.
- Profile-share GitHub POSTs in `sharing.rs` aren't routed —
  cassette is GET-only by design. Those need a stateful mock
  server (the "Profile sharing / subscription flows" section
  below already calls this out).

## msedgedriver / WebView2 version drift — AUTOMATED

`qa/runner/scripts/download-msedgedriver.mjs` now reads the local
WebView2 build out of the registry and downloads the matching driver
from Microsoft's CDN. Idempotent. Run it after a WebView2 update
broke the smoke:

```bash
node qa/runner/scripts/download-msedgedriver.mjs
```

The release-gate (`scripts/release.sh`) calls this automatically
before the WebDriver smoke step.

## Harness environment variables

The smoke harness uses these to keep its state isolated from the
developer's real install. Verified in `src-tauri/src/lib.rs::run`
and `state.rs::new`.

- `STS2_FIXTURE_GAME_PATH` — overrides auto-detect. Points at a
  tempdir game tree with `release_info.json`, `mods/`, and
  `mods_disabled/`. The smoke creates this per run and cleans it
  up in `finally`.
- `STS2_CONFIG_DIR` — overrides `dirs::config_dir() + "/sts2-mod-
  manager"`. Catches `mod_sources.json`, `active_profile.txt`,
  the log file, etc.
- `STS2_CACHE_DIR` — overrides `dirs::cache_dir() + "/sts2-mod-
  manager"`. Catches downloaded release zips.
- `STS2_CASSETTE_DIR` — when the binary is built with `--features
  qa-cassette`, redirects outbound GitHub + Nexus GETs to disk
  fixtures under this path. See `src-tauri/src/qa_cassette.rs`.

A shipped build (no feature, no env vars) behaves identically to
v1.3.4 — these are pure escape hatches.

## Tier 2 scenarios for historical bugs — DONE (2026-05-13)

These were tracked in `walkthrough-findings.md` as ⚠️ "fix shipped
but no test guards it". All three now have WebDriver specs under
`qa/runner/smoke.mjs`:

- ~~**#20 — Profile Repair deletes orphan disabled files.**~~ —
  covered by `specRepairRemovesOrphanDisabled`.
- ~~**#21 — Game-version-skipped mods don't pollute the saved
  snapshot.**~~ — covered by `specSkippedModAbsentFromSnapshot`.
  **Caveat:** the spec drives the apply-time skip path
  (`switch_profile` correctly disables incompatible mods on disk and
  records `enabled: false` in the profile JSON). The companion
  *manual-snapshot* path in `src-tauri/src/profiles.rs::snapshot_current_with_sources`
  does NOT mirror the bug-#21 filter that landed in
  `subscriptions.rs::build_synced_profile_snapshot`. A re-snapshot
  via the Profiles kebab will still include incompatible mods. New
  follow-up item logged in the `Phase 2 follow-ups` section below.
- ~~**#22 — Profile state is sticky after toggle.**~~ — covered by
  `specToggleStickyAcrossProfileSwitch`.

## Phase 2 follow-ups (logged 2026-05-13)

- **Bug #21 second half — manual snapshot doesn't filter
  incompatible mods.** `snapshot_current_with_sources` (profiles.rs
  ~L188) loops every on-disk mod and writes them into the snapshot
  regardless of `min_game_version`. The `build_synced_profile_snapshot`
  in subscriptions.rs has the correct filter (commit 37df97f). Mirror
  the filter into the plain-snapshot path, then upgrade
  `specSkippedModAbsentFromSnapshot` to drive the kebab → Snapshot
  flow and assert the skipped mod is absent. ~1 hour.
- **Cassette URL→path quirk with version tags.** `qa_cassette::url_to_path`
  uses `PathBuf::extension()` to decide whether to append `.json`,
  but `v3.0.0` has `Some("0")` as extension. Per-tag fixtures must
  be stored without the `.json` suffix (see `qa/fixtures/github/repos/
  qa-fixture/walkback-mod/releases/tags/v1.0.0` for the workaround).
  Real fix: always append `.json` for the GitHub bucket unless the
  path ends in `.zip` / `.tar.gz`. ~15 min.

## Frontend coverage gate — DONE (2026-05-13, 95/90/95/95 landed)

Vitest + jsdom + Testing Library + v8 coverage are wired. The
release.sh QA gate enforces the thresholds declared in
`vitest.config.ts` and drops the release if coverage regresses.

Live coverage (`npm run qa:coverage`):
- Lines:      **97.8%**   · gate 95
- Statements: **96.69%**  · gate 95
- Functions:  **97.03%**  · gate 95
- Branches:   **91.9%**   · gate 90
- 878 tests across 36 files

The trajectory ladder (68/63/70/67 → 80/75/85/80 → 95/90/95/95) is
fully landed. Per-file priority surfaces (App / Home / Mods /
Browse / Profiles / Settings / OnboardingOverlay / PublishModal /
AutoDetectModal / DiagnosticBundle / AppContext) all sit at ≥95%
lines / ≥90% branches with documented `// uncovered:` annotations
for any dead-code defensive guards.

## Backend coverage gate — current 19%

`cargo-llvm-cov` is wired. Run `cargo llvm-cov --manifest-path
src-tauri/Cargo.toml --summary-only` for a per-file report.

Current state:
- Lines: 19.12% overall (pre-Task 19)
- `mods.rs` 54% (most user-flow paths covered)
- `qa_cassette.rs` 76%
- `nexus.rs` 49%, `quick_add.rs` 51%, `updater.rs` 13%, `backup.rs` covered via new unit tests
- 82 Rust unit tests (+20 from Task 19's `download.rs` pure-helper
  coverage on 2026-05-13: `slugify`, `repo_mentions_sts2`,
  `find_best_asset`, `peek_zip_min_game_version`) + 13 integration
  + 3 cassette-feature = 98 backend tests

Path to higher backend coverage: the big untested chunks are
`download.rs`'s I/O paths (the pure helpers are now covered),
`sharing.rs` (926 lines, 4%), and `subscriptions.rs` (421 lines,
0%). Most of these need a stateful mock HTTP server to exercise.

## Linux + macOS support

The WebDriver harness is Windows-only today because it uses
`msedgedriver` directly. To run in CI on Linux:

- Use `tauri-driver` on Linux, which forwards to `WebKitWebDriver`.
- The capability shape is identical (`browserName: 'wry'` +
  `tauri:options.application`) — `smoke.mjs` doesn't need changes.
- CI must install WebKitGTK + WebKitWebDriver in the runner image.

macOS isn't supported by `tauri-driver` at all; skip.

## Profile sharing / subscription flows

Curator + subscriber flows hit GitHub heavily:
- Create + push `sts2mm-profiles` repo
- Upload + diff modpack bundles
- Apply share codes

WebDriver can drive these against a **mocked GitHub** (a small HTTP
server in the harness that imitates the GitHub API for the test
duration). Same shape as cassette playback but stateful — the
server has to remember what the client uploaded so subsequent
fetches see it.

Significant work (~1 day). Defer until a curator-side bug actually
reports.

## "Stale duplicate detected" follow-up

When the manager finds two mods sharing both `manifest.name` AND
`manifest.id` (signal: same mod, different folders, probably one is
stale), surface a banner on the Mods view: "We see two
'CardArtEditor' folders — the older one (v1.0.0) looks stale.
Remove?" with a one-click cleanup.

This would have made the JadeDemon scenario auto-resolving. Not a
correctness fix (the v1.3.1 changes already make the two mods
behave correctly) — purely UX. ~2 hours.

## CI integration

The WebDriver smoke is currently local-only. A reasonable CI lane:

```yaml
qa-smoke:
  runs-on: windows-latest
  steps:
    - uses: actions/checkout@v4
    - run: cargo install tauri-driver --version "^2"
    - run: npm install
    - run: npm run tauri build -- --no-bundle --features qa-cassette
    - run: node qa/runner/scripts/download-msedgedriver.mjs
    - run: node qa/runner/smoke.mjs
    - run: CASSETTE=1 node qa/runner/smoke.mjs
```

`scripts/release.sh` already runs the equivalent locally before
every version bump — see the QA gate section there. The CI lane is
just for catching regressions on PR branches before they hit `main`.

## Notes for the agent who picks this up

- Cassette + fixture-game-path + STS2_CONFIG_DIR + STS2_CACHE_DIR
  overrides + Vitest are all wired. Pick from "Tier 2 WebDriver
  scenarios" above for next coverage, or "Tier 2 scenarios for
  historical bugs" for high-value regression locks.
- The smoke harness is at `qa/runner/smoke.mjs`. Tests are an array
  of `[label, fn]` pairs near the bottom — add new specs there.
- `screenshot()` + `last-failure.png` is invaluable for debugging.
  Tauri's WebView2 looks normal but small differences (e.g. an
  overlay on top) only show in the screenshot.
- Every WebDriver run uses a fresh WebView2 user-data folder, so
  state doesn't persist between runs. Use that to your advantage —
  no test-isolation bookkeeping needed.
- The onboarding wizard fires every run. `dismissOnboardingIfPresent`
  handles it. If you add a spec that expects a clean Home view, run
  it after the dismiss step.
