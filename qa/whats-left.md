# What's left - QA backlog

Historical snapshot of unfinished QA work from earlier release cuts. The current release-confidence source of truth is `qa/coverage-matrix.md`; use this file only for older context and deeper future-harness ideas.

## Tier 2 WebDriver scenarios (UI specs)

**Updated 2026-06-06:** issue #156 added `qa/coverage-matrix.md` and wired `npm run qa:matrix` into `npm run qa`, so routine release-regression ownership now lives in the matrix instead of this backlog.

What's covered today (per `qa/scenarios/INDEX.md`, `qa/coverage-matrix.md`, and the smoke harness):
- Scenarios 006-010 - toggle / audit-count / pin / delete / create modpack.
- Modpack switch + apply (the v1.3.1 freeze/pin-preservation contracts).
- Repair walk-back - newer-than-game cassette, click Repair, verify the walk-back tag installs.
- Share-code import, share publish, restore backup, subscription updates, bulk operations, and the tier-1 historical bugs now have automated owners in the matrix.

Still manual or future-harness work:

- **Drag-drop a `.zip` onto the window** - Selenium can dispatch the Drop event but tauri's drag-drop intercept is at the OS level. Likely requires computer-use MCP. Defer until reported.
- **Launch game from the packaged app** - Steam protocol/direct binary launch needs OS spot-checking.
- **Deep-link OS registration and warm-start focus** - frontend routing is covered, but real protocol registration remains a desktop/OS boundary.

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

## Tier 2 scenarios for historical bugs - CURRENT

The current owner list is in `qa/coverage-matrix.md`. The older WebDriver-only notes below were folded into the issue #156 matrix pass:

- **#20 - Disabled library extras are preserved.** Current behavior preserves disabled library extras and keeps them out of drift; covered by `specDisabledLibraryExtrasArePreserved`.
- **#21 - Game-version-incompatible active mods do not pollute created modpacks.** Covered by `specIncompatibleModAbsentFromCreatedModpack` plus `CreateModpackWizard.test.tsx`; the create-from-active wizard leaves incompatible active mods unselected and the saved modpack stays clean.
- **#22 - Toggle state is sticky after a modpack switch.** Covered by `specToggleStickyAcrossModpackSwitch`.

## Phase 2 follow-ups (logged 2026-05-13)

- **Bug #21 second half - incompatible active mods in the manual create path.** Resolved by the current create-from-active wizard coverage in issue #156.
- **Cassette URL-to-path quirk with version tags.** `qa_cassette::url_to_path` uses `PathBuf::extension()` to decide whether to append `.json`, but `v3.0.0` has `Some("0")` as extension. Per-tag fixtures must be stored without the `.json` suffix (see `qa/fixtures/github/repos/qa-fixture/walkback-mod/releases/tags/v1.0.0` for the workaround). Real fix: always append `.json` for the GitHub bucket unless the path ends in `.zip` / `.tar.gz`. ~15 min.

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

The WebDriver harness runs on Windows and Linux in CI. Windows uses
`msedgedriver` for WebView2; Linux uses `WebKitWebDriver` from
WebKitGTK under Xvfb. macOS isn't supported by `tauri-driver` at all;
skip it.

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

The WebDriver smoke now runs in `.github/workflows/ci.yml` on Windows
and Ubuntu when app or QA files change. `scripts/release.sh` still runs
the local Windows smoke before every version bump; CI catches the Linux
WebKitGTK path on PR branches before they hit `main`.

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
