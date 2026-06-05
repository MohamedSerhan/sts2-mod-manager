# Cross-platform CI test coverage + Nexus mac/Linux uploads

**Date:** 2026-06-04
**Issue:** [#95](https://github.com/MohamedSerhan/sts2-mod-manager/issues/95) (folds in #106)
**Status:** Approved — ready for implementation plan

## Problem

Two cross-platform gaps in the CI/release pipeline, folded into one change so a
single agent owns the pipeline work. They touch different workflow files
(`ci.yml` vs `build.yml`) so they don't collide, but share the
"verify + ship on macOS/Linux" theme.

1. **`cargo test` runs only on Linux.** The `CI Gate` builds/bundles on
   Windows + macOS + Linux, but `test-rust` executes only on `ubuntu-22.04`.
   macOS and Windows get a compile/bundle check but **zero test execution** —
   even though the redesign touches OS-divergent surface (file moves with
   rename→copy fallback, archive extraction, path normalization, the `notify`
   7→8 watcher bump, case-sensitive-FS matching).

2. **`publish-nexus` uploads Windows only.** The macOS `.dmg` and Linux
   `.AppImage` are built and attached to the GitHub Release but never sent to
   Nexus (mod 856). The Nexus page advertises only the Windows portable zip.

## Empirical grounding (done during design)

Run locally on Windows 11 (≈ `windows-latest`), against this branch:

- `cargo test --manifest-path src-tauri/Cargo.toml` → **343 passed, 0 failed, 1 ignored.**
- `cargo test … --features qa-cassette` → same, plus the cassette tests, **0 failed.**
- The three path-safety tests the issue flagged (`path_inside_*` in
  `src-tauri/src/mods/state.rs`, hardcoding `/tmp/mods` + `/etc/passwd`)
  **already pass on Windows.** `path_is_inside` tries `canonicalize()` (FS-touching)
  then falls back to a **lexical** component-walk when the path doesn't exist;
  `/tmp/mods` doesn't exist on any runner, so the lexical path — which is
  cross-platform-safe — runs everywhere.

**Conclusion:** the `tempfile` refactor the issue assumed is **not required**.
Adding Windows + macOS legs to `test-rust` is low-risk. (YAGNI: no `state.rs`
change ships in this PR.)

## Tooling constraint that shaped scope (macOS vs Linux smoke)

Automated WebDriver UI smoke depends on a WebView driver per platform:

| Platform | Webview | WebDriver | Automated smoke in CI |
|---|---|---|---|
| Windows | WebView2 (Edge) | msedgedriver | ✅ exists today |
| Linux | WebKitGTK | WebKitWebDriver | ✅ feasible (xvfb + official `tauri-driver`) |
| macOS | WKWebView | **none — Apple ships none** | ❌ not with official tooling |

GitHub hosts `macos-latest` and `ubuntu-latest`, so **no Mac/Linux hardware is
needed for automated CI tests**. The macOS blocker is the missing WebDriver, not
hardware — even with a Mac you can't run the official WebDriver smoke there
(only community embedded-server plugins exist; deferred). A Mac helps only for a
**manual** checklist.

Decision: macOS gets a **manual** checklist this PR; Linux automated smoke is a
**follow-up issue**; vitest-on-macOS is skipped (pure JS in jsdom, no
OS-divergent surface).

## Scope

**In:**
1. `test-rust` → 3-platform matrix (`ci.yml`).
2. `publish-nexus` → 3-file matrix (`build.yml`).
3. macOS manual smoke checklist + doc accuracy fixes (`RELEASING.md`).

**Out (this PR):**
- Linux automated WebDriver smoke — feasible, own chunk → **follow-up issue**.
- vitest on macOS — low value → skipped.
- macOS automated WebDriver smoke — no official tooling → not pursued.
- Any `src-tauri/` change (tests already pass on Windows).

## Part 1 — `test-rust` → 3-platform matrix (`.github/workflows/ci.yml`)

Convert the single-OS job (currently `runs-on: ubuntu-22.04`, lines 89–109)
into a matrix. Target shape:

```yaml
  test-rust:
    needs: changes
    if: ${{ needs.changes.outputs.app == 'true' }}
    strategy:
      fail-fast: false
      matrix:
        platform: [ubuntu-22.04, windows-latest, macos-latest]
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v5
      - name: Install system dependencies (Linux)
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri
          key: test-rust-${{ matrix.platform }}
      - name: Rust tests (default features)
        run: cargo test --manifest-path=src-tauri/Cargo.toml
      - name: Rust tests (qa-cassette feature)
        run: cargo test --manifest-path=src-tauri/Cargo.toml --features qa-cassette
```

Rationale / invariants:
- `fail-fast: false` — one OS failing still reports the others (mirrors `app-build`).
- macOS/Windows need **no** system-dep install (system webviews); guard the apt step.
- Per-OS cache `key` — distinct caches avoid cross-OS thrash (Swatinem guidance;
  `app-build` already does `key: ci-gate-${{ matrix.platform }}`).
- No `npm`/frontend build — `cargo test` compiles the crate + test targets, not
  the bundled app; the current Linux job is already npm-free and green, proving
  `frontendDist` isn't needed at test time.
- **`ci-gate` unchanged.** It already lists `test-rust` in `needs` and checks
  `needs.test-rust.result`; a matrix job's aggregate `result` is `failure` if
  any leg fails, `success` only if all pass.

## Part 2 — `publish-nexus` → 3-file matrix (`.github/workflows/build.yml`)

Replace the single Windows upload (lines 383–410) with a matrix over the three
release assets. Filenames match what `format-release` links (build.yml:317–329):

| Matrix file template | `display_name` |
|---|---|
| `STS2.Mod.Manager_{V}_x64_portable.zip` | `STS2 Mod Manager {V} (Windows Portable)` |
| `STS2.Mod.Manager_{V}_universal.dmg` | `STS2 Mod Manager {V} (macOS Universal)` |
| `STS2.Mod.Manager_{V}_amd64.AppImage` | `STS2 Mod Manager {V} (Linux AppImage)` |

Target shape:

```yaml
  publish-nexus:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: build
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      max-parallel: 1   # serialize: insurance against archive_existing_file races
      matrix:
        include:
          - file_tpl: "STS2.Mod.Manager_{V}_x64_portable.zip"
            label: "Windows Portable"
          - file_tpl: "STS2.Mod.Manager_{V}_universal.dmg"
            label: "macOS Universal"
          - file_tpl: "STS2.Mod.Manager_{V}_amd64.AppImage"
            label: "Linux AppImage"
    steps:
      - name: Resolve version + asset name
        id: meta
        run: |
          VERSION="${GITHUB_REF_NAME#v}"
          FILENAME="${{ matrix.file_tpl }}"; FILENAME="${FILENAME//\{V\}/$VERSION}"
          echo "version=$VERSION"   >> "$GITHUB_OUTPUT"
          echo "filename=$FILENAME" >> "$GITHUB_OUTPUT"
      - name: Download asset from GitHub Release
        env: { GITHUB_TOKEN: "${{ secrets.GITHUB_TOKEN }}" }
        run: gh release download "${GITHUB_REF_NAME}" -R "${GITHUB_REPOSITORY}" -p "${{ steps.meta.outputs.filename }}"
      - name: Upload to Nexus Mods
        uses: Nexus-Mods/upload-action@v1.0.0-beta.7
        with:
          api_key:               ${{ secrets.NEXUS_API_KEY }}
          file_group_id:         ${{ secrets.NEXUS_FILE_GROUP_ID }}
          filename:              ${{ steps.meta.outputs.filename }}
          version:               ${{ steps.meta.outputs.version }}
          file_category:         main
          archive_existing_file: true
          display_name:          STS2 Mod Manager ${{ steps.meta.outputs.version }} (${{ matrix.label }})
```

Rationale / invariants:
- Stays decoupled (`needs: build`, parallel with `publish-updater` /
  `format-release`) so a Nexus outage can't block the Release or in-app updater.
- `file_category: main` for all three — Nexus's "Main files" section supports
  multiple files (standard practice for multi-platform downloads); `main` is
  already proven valid by the current Windows job. Resolves the issue's
  "confirm file_category for non-Windows files" open question.
- `max-parallel: 1` serializes the three uploads. Insurance against an
  `archive_existing_file` race if the action archives by category rather than by
  filename. Uploads aren't time-critical. **Open item (verify in
  implementation):** read `Nexus-Mods/upload-action@v1.0.0-beta.7` README/source
  to confirm archive semantics; if strictly per-filename, `max-parallel: 1` can
  be relaxed — but it ships as the safe default.
- First run is clean: no existing `.dmg`/`.AppImage` on Nexus yet, so
  `archive_existing_file` simply has nothing to archive for those.
- A missing asset (e.g. a release where one platform build failed) fails just
  that leg (`fail-fast: false`); re-run via "Re-run failed jobs". Matches the
  current single-file failure behavior.

## Part 3 — macOS manual smoke checklist + doc fixes (`RELEASING.md`)

1. **New section "Smoke-testing the macOS build"** beside the existing
   Windows "Smoke-testing the portable build" section. Steps target the
   OS-divergent surface the redesign touches:
   - Open the universal `.dmg`, drag to Applications, launch (Gatekeeper note).
   - Game-path auto-detect resolves (path normalization).
   - Switch a modpack (apply/snapshot chain).
   - Drag-drop install a mod zip (archive extraction).
   - Toggle a mod off → confirm it physically **moved** to `mods_disabled/`
     (the rename→copy file-move path).
   - Report-a-bug from the UI.
   - Note: requires a Mac (Intel or Apple Silicon — universal binary).
2. **Doc accuracy fixes** that ride along with Part 2:
   - "Release flow" (line 30): `publish-nexus` now uploads Windows zip +
     macOS `.dmg` + Linux `.AppImage`.
   - "What is not automated" (line 59): remove the stale "macOS / Linux uploads
     to Nexus — Windows only" bullet (now automated).
   - "Re-running a release" (line 64): the duplicate-upload caveat now spans all
     three files.

## Out of scope → follow-up

File a tracking issue: **"CI: Linux automated WebDriver smoke leg."** Sketch:
make `qa/runner/smoke.mjs` platform-aware (binary name without `.exe`;
`WebKitWebDriver` as the native driver; Linux/no-op zombie reap instead of
`taskkill`), add a `smoke-linux` `ci.yml` leg (`apt-get` webkit driver + `xvfb`,
`cargo install tauri-driver`, `npm run qa:smoke:build`, `xvfb-run -a npm run
qa:smoke:cassette`), and add it to the `ci-gate` `needs` + check list. The React
DOM is identical across platforms, so the existing XPath specs should carry over;
the cost is a new CI leg with its own flakiness/timing budget.

## Verification plan

- **Static:** `python -c "import yaml…"` parse + `actionlint` (the repo's
  `workflow-lint` job) on both edited workflows. Locally re-run the two
  `cargo test` invocations (already green on Windows).
- **Dynamic (this PR's own CI):** the PR touches `.github/workflows/**` →
  `workflows: true`, `app: false`. The `changelog` job is skipped (needs
  `app == true`) → **no changelog fragment required**. The new `test-rust`
  matrix legs are exercised only on app-touching PRs; to smoke the matrix itself
  before merge, either (a) trigger `ci.yml` via `workflow_dispatch` (its
  classify branch marks everything changed), or (b) a throwaway no-op `src-tauri`
  edit on a scratch branch. `publish-nexus` only runs on `v*` tags — validated at
  the next real release (and re-runnable per-leg if a platform misbehaves).
- **Doc:** `RELEASING.md` renders; the new section reads as an actionable
  checklist.

## Risks

| Risk | Mitigation |
|---|---|
| `archive_existing_file` parallel race archives sibling main files | `max-parallel: 1`; verify action semantics in implementation. |
| CI minutes ↑ (macOS leg billed 10×, Windows 2×) | Tests are fast (sub-second run; cost is runner spin-up). Repo already runs 3-platform build + Windows smoke per app PR — marginal. |
| A test passes locally on Windows but flakes on `windows-latest` CI | That is precisely the gap this closes; the PR's own CI (via dispatch) surfaces it before merge. |
| macOS checklist is aspirational if no maintainer has a Mac | It documents the intended check; harmless if unrun, valuable when a Mac is available. |
