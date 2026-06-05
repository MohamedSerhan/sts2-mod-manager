# Cross-platform CI test coverage + Nexus mac/Linux uploads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run `cargo test` on macOS + Windows (not just Linux) in the CI gate, publish the macOS `.dmg` and Linux `.AppImage` to Nexus alongside the Windows zip, and document a manual macOS release smoke check.

**Architecture:** Pure CI/release-pipeline + docs change. Two GitHub Actions jobs become matrices (`test-rust` over 3 OSes; `publish-nexus` over 3 files), plus `RELEASING.md` edits. No application (`src/`, `src-tauri/`) code changes — the Rust suite already passes on Windows (verified locally: 343 tests, both feature sets, 0 failures), so the `tempfile` refactor the issue assumed is unnecessary (YAGNI).

**Tech Stack:** GitHub Actions YAML, `Swatinem/rust-cache@v2`, `Nexus-Mods/upload-action@v1.0.0-beta.7`, `cargo test`, Markdown.

**Spec:** [docs/superpowers/specs/2026-06-04-cross-platform-ci-coverage-and-nexus-uploads-design.md](docs/superpowers/specs/2026-06-04-cross-platform-ci-coverage-and-nexus-uploads-design.md)

**Cross-cutting notes for the executor:**
- This PR is **workflows + docs only** → `scripts/ci-changes.mjs` classifies it as `workflows: true, app: false`. The `changelog` CI job is skipped (it needs `app == true`), so **do NOT add a changelog fragment**. The `workflow-lint` job *will* run and lints both edited workflows with `actionlint`.
- Because `app: false`, the `test-rust` job does **not** auto-run on this PR. The matrix is exercised by triggering `ci.yml` via `workflow_dispatch` on the branch (its dispatch branch marks every bucket changed → `app: true`). This is Task 1's real cross-platform verification.
- `publish-nexus` runs only on `v*` tags, so it can't be exercised pre-merge — validate it by `actionlint` + review here; it gets its first live run at the next release (re-runnable per-leg).
- Work is in the existing worktree on branch `claude/hardcore-sanderson-01a980`.

---

### Task 1: `test-rust` → 3-platform matrix (`ci.yml`)

**Goal:** Run both `cargo test` invocations on `ubuntu-22.04`, `windows-latest`, and `macos-latest` instead of Linux only.

**Files:**
- Modify: `.github/workflows/ci.yml` (the `test-rust:` job, currently lines 89–109)

**Acceptance Criteria:**
- [ ] `test-rust` declares a `strategy.matrix.platform` of `[ubuntu-22.04, windows-latest, macos-latest]` with `fail-fast: false` and `runs-on: ${{ matrix.platform }}`.
- [ ] The `apt-get` install step is guarded with `if: matrix.platform == 'ubuntu-22.04'` (macOS/Windows use system webviews).
- [ ] The `Swatinem/rust-cache@v2` step uses a per-OS `key: test-rust-${{ matrix.platform }}`.
- [ ] Both `cargo test` steps (default + `--features qa-cassette`) are unchanged and run on every platform.
- [ ] `ci-gate` is **not** modified (a matrix job's aggregate `result` already satisfies the existing `needs.test-rust.result` check).
- [ ] `ci.yml` parses as valid YAML and passes `actionlint`.

**Verify:**
- `python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML OK')"` → `YAML OK`
- After commit+push: `gh workflow run ci.yml --ref claude/hardcore-sanderson-01a980` then `gh run list --workflow=ci.yml --branch claude/hardcore-sanderson-01a980 --limit 1` → the run's `test-rust` shows 3 legs, all green.

**Steps:**

- [ ] **Step 1: Replace the `test-rust` job.** In `.github/workflows/ci.yml`, replace the entire current job:

```yaml
  test-rust:
    needs: changes
    if: ${{ needs.changes.outputs.app == 'true' }}
    runs-on: ubuntu-22.04
    steps:
      - uses: actions/checkout@v5
      - name: Install system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri
      - name: Rust tests (default features)
        run: cargo test --manifest-path=src-tauri/Cargo.toml
      - name: Rust tests (qa-cassette feature)
        # The cassette-gated integration tests compile/run only under this
        # feature. Without this step, a signature drift in cassette-only code
        # (or its fixtures) surfaces only at release, not in the PR gate.
        run: cargo test --manifest-path=src-tauri/Cargo.toml --features qa-cassette
```

with this matrix version:

```yaml
  test-rust:
    needs: changes
    if: ${{ needs.changes.outputs.app == 'true' }}
    # cargo test on all three OSes. The redesign touches OS-divergent surface
    # (file moves with rename->copy fallback, archive extraction, path
    # normalization, the notify watcher, case-sensitive-FS matching) that a
    # Linux-only leg never exercised. fail-fast: false so one OS failing still
    # reports the others.
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
        # The cassette-gated integration tests compile/run only under this
        # feature. Without this step, a signature drift in cassette-only code
        # (or its fixtures) surfaces only at release, not in the PR gate.
        run: cargo test --manifest-path=src-tauri/Cargo.toml --features qa-cassette
```

- [ ] **Step 2: Validate YAML.**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('YAML OK')"`
Expected: `YAML OK` (if `python` is unavailable, use `node -e "const y=require('js-yaml');y.load(require('fs').readFileSync('.github/workflows/ci.yml','utf8'));console.log('YAML OK')"` only if js-yaml is present; otherwise rely on the CI `workflow-lint` job).

- [ ] **Step 3: Sanity-check the cargo suite still passes (Windows, local).**

Run: `cargo test --manifest-path=src-tauri/Cargo.toml`
Expected: `test result: ok. 343 passed; 0 failed; 1 ignored` (already verified during design; this confirms no drift).

- [ ] **Step 4: Commit.**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: run cargo test on macOS + Windows in the PR gate (#95)"
```

- [ ] **Step 5: Exercise the matrix on CI (real cross-platform proof).**

```bash
git push
gh workflow run ci.yml --ref claude/hardcore-sanderson-01a980
# wait, then inspect:
gh run list --workflow=ci.yml --branch claude/hardcore-sanderson-01a980 --limit 1
gh run watch <run-id> --exit-status
```
Expected: the `test-rust` matrix shows three legs (ubuntu/windows/macos), all green. If macOS surfaces a failure, fix it in `src-tauri` under a follow-up commit on this branch (out of the assumed scope, but this is exactly the coverage gap the task closes — handle it if it appears).

---

### Task 2: `publish-nexus` → 3-file matrix (`build.yml`)

**Goal:** Upload the Windows portable zip, macOS universal `.dmg`, and Linux `.AppImage` to Nexus (mod 856), one matrix leg per file, instead of Windows only.

**Files:**
- Modify: `.github/workflows/build.yml` (the `publish-nexus:` job + its lead comment, currently lines 379–410)

**Acceptance Criteria:**
- [ ] `publish-nexus` declares `strategy` with `fail-fast: false`, `max-parallel: 1`, and a `matrix.include` of the three assets, each carrying a `suffix` and a `label`.
- [ ] The `meta` step derives `filename` as `STS2.Mod.Manager_${VERSION}_${{ matrix.suffix }}` so it resolves to `…_x64_portable.zip`, `…_universal.dmg`, `…_amd64.AppImage`.
- [ ] The upload step uses `file_category: main`, `archive_existing_file: true`, and `display_name: STS2 Mod Manager ${version} (${{ matrix.label }})`.
- [ ] The job still gates on `if: startsWith(github.ref, 'refs/tags/v')` and `needs: build` (decoupled, parallel with `publish-updater`/`format-release`).
- [ ] `build.yml` parses as valid YAML and passes `actionlint`.

**Verify:**
- `python -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml')); print('YAML OK')"` → `YAML OK`
- Logic review: the three `suffix` values concatenate to the exact filenames `format-release` links (build.yml MAC_LINKS/LINUX_LINKS/WIN_LINKS). Full live validation is at the next `v*` release (re-runnable per-leg).

**Steps:**

- [ ] **Step 1: Replace the `publish-nexus` job and its lead comment.** In `.github/workflows/build.yml`, replace the current comment + job:

```yaml
  # Upload the portable Windows zip to Nexus Mods (mod 856).
  # Runs in parallel with publish-updater + format-release so a Nexus
  # outage cannot block the GitHub Release or the in-app updater.
  # Re-run via "Re-run failed jobs" on the workflow run if Nexus is flaky.
  publish-nexus:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: build
    runs-on: ubuntu-latest
    steps:
      - name: Resolve version + asset name
        id: meta
        run: |
          TAG="${GITHUB_REF_NAME}"
          VERSION="${TAG#v}"
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          echo "filename=STS2.Mod.Manager_${VERSION}_x64_portable.zip" >> "$GITHUB_OUTPUT"

      - name: Download portable zip from GitHub Release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh release download "${GITHUB_REF_NAME}" -R "${GITHUB_REPOSITORY}" -p "${{ steps.meta.outputs.filename }}"

      - name: Upload to Nexus Mods
        uses: Nexus-Mods/upload-action@v1.0.0-beta.7
        with:
          api_key:                      ${{ secrets.NEXUS_API_KEY }}
          file_group_id:                ${{ secrets.NEXUS_FILE_GROUP_ID }}
          filename:                     ${{ steps.meta.outputs.filename }}
          version:                      ${{ steps.meta.outputs.version }}
          file_category:                main
          archive_existing_file:        true
          display_name:                 STS2 Mod Manager ${{ steps.meta.outputs.version }} (Windows Portable)
```

with this matrix version:

```yaml
  # Upload the release assets to Nexus Mods (mod 856): the Windows portable
  # zip, the macOS universal .dmg, and the Linux .AppImage — one matrix leg
  # per file. Runs in parallel with publish-updater + format-release so a
  # Nexus outage cannot block the GitHub Release or the in-app updater.
  # max-parallel: 1 serializes the uploads as insurance against an
  # archive_existing_file race. Re-run via "Re-run failed jobs" if Nexus is flaky.
  publish-nexus:
    if: startsWith(github.ref, 'refs/tags/v')
    needs: build
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      max-parallel: 1
      matrix:
        include:
          - suffix: "x64_portable.zip"
            label: "Windows Portable"
          - suffix: "universal.dmg"
            label: "macOS Universal"
          - suffix: "amd64.AppImage"
            label: "Linux AppImage"
    steps:
      - name: Resolve version + asset name
        id: meta
        run: |
          VERSION="${GITHUB_REF_NAME#v}"
          echo "version=$VERSION" >> "$GITHUB_OUTPUT"
          echo "filename=STS2.Mod.Manager_${VERSION}_${{ matrix.suffix }}" >> "$GITHUB_OUTPUT"

      - name: Download asset from GitHub Release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: gh release download "${GITHUB_REF_NAME}" -R "${GITHUB_REPOSITORY}" -p "${{ steps.meta.outputs.filename }}"

      - name: Upload to Nexus Mods
        uses: Nexus-Mods/upload-action@v1.0.0-beta.7
        with:
          api_key:                      ${{ secrets.NEXUS_API_KEY }}
          file_group_id:                ${{ secrets.NEXUS_FILE_GROUP_ID }}
          filename:                     ${{ steps.meta.outputs.filename }}
          version:                      ${{ steps.meta.outputs.version }}
          file_category:                main
          archive_existing_file:        true
          display_name:                 STS2 Mod Manager ${{ steps.meta.outputs.version }} (${{ matrix.label }})
```

- [ ] **Step 2: Confirm the upload-action's archive semantics.** Before trusting `max-parallel: 1` as merely "insurance", read the action to confirm `archive_existing_file` matches by filename (not "archive all main files"):

Run: `gh api repos/Nexus-Mods/upload-action/contents/README.md --jq '.content' | base64 -d | grep -iA3 archive_existing` (or open `https://github.com/Nexus-Mods/upload-action`).
Expected: confirmation it archives the same-named file. If it archives ALL existing files in the group, keep `max-parallel: 1` (correct) and add a one-line comment noting why; if strictly per-filename, leave `max-parallel: 1` anyway (harmless, 3 small uploads).

- [ ] **Step 3: Validate YAML.**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml')); print('YAML OK')"`
Expected: `YAML OK`

- [ ] **Step 4: Commit.**

```bash
git add .github/workflows/build.yml
git commit -m "ci: publish macOS .dmg + Linux .AppImage to Nexus (#95)"
```

---

### Task 3: macOS smoke checklist + Nexus doc fixes (`RELEASING.md`)

**Goal:** Add a manual macOS release smoke checklist and update the runbook lines that the Nexus change makes stale.

**Files:**
- Modify: `RELEASING.md` (line 30 release-flow bullet; line 59 "not automated" bullet; line 64 re-run caveat; new section after the "Smoke-testing the portable build" section)

**Acceptance Criteria:**
- [ ] The "Release flow" `publish-nexus` bullet (line 30) lists all three uploaded files.
- [ ] The stale "macOS / Linux uploads to Nexus — Windows only" bullet under "What is not automated" (line 59) is removed.
- [ ] The "Re-running a release" caveat (line 64) reflects that all three platform files re-upload.
- [ ] A new "## Smoke-testing the macOS build" section exists with the 7-step checklist and the "requires a Mac / no automated WebDriver" note.
- [ ] `RELEASING.md` still renders (no broken headings/links).

**Verify:**
- `grep -n "Smoke-testing the macOS build" RELEASING.md` → one match.
- `grep -c "the Nexus page currently hosts Windows only" RELEASING.md` → `0`.
- `grep -n "universal.dmg" RELEASING.md` → matches in the new section.

**Steps:**

- [ ] **Step 1: Update the release-flow bullet.** Replace (line 30):

```markdown
   - `publish-nexus` uploads the portable zip to Nexus Mods (mod 856).
```

with:

```markdown
   - `publish-nexus` uploads the Windows portable zip, the macOS `.dmg`, and the Linux `.AppImage` to Nexus Mods (mod 856) — one matrix leg per file.
```

- [ ] **Step 2: Remove the stale "not automated" bullet.** Delete this line under "## What is not automated" (line 59):

```markdown
- **macOS / Linux** uploads to Nexus — the Nexus page currently hosts Windows only.
```

(Leave the other two bullets — mod-page description and Posts tab — intact.)

- [ ] **Step 3: Update the re-run caveat.** Replace (line 64):

```markdown
- A full re-build for an existing tag: Actions UI → workflow_dispatch (Run workflow). Note this re-triggers every job including `publish-nexus`, which would upload a duplicate to Nexus (the upload API has no "if not exists" guard). If you only need to re-run Nexus, use "Re-run failed jobs" instead.
```

with:

```markdown
- A full re-build for an existing tag: Actions UI → workflow_dispatch (Run workflow). Note this re-triggers every job including `publish-nexus`, which would upload fresh copies of all three platform files to Nexus (the upload API has no "if not exists" guard; the prior versions are archived via `archive_existing_file`). If you only need to re-run Nexus, use "Re-run failed jobs" instead.
```

- [ ] **Step 4: Add the macOS smoke section.** Immediately after the existing "## Smoke-testing the portable build" section (after its step 4, before the `---` divider near line 74), insert:

```markdown

## Smoke-testing the macOS build

macOS has no automated UI smoke: Apple ships no WebDriver for the embedded
WKWebView, so `tauri-driver` cannot drive a macOS build (Windows uses WebView2 +
msedgedriver; Linux uses WebKitGTK + WebKitWebDriver). Run this manual pass on a
Mac when a release changes OS-divergent surface — file moves, archive
extraction, path handling, the downloads watcher. Requires a Mac (Intel or
Apple Silicon; the build is a universal binary).

1. Download `STS2.Mod.Manager_<version>_universal.dmg` from the GitHub Release.
2. Open the `.dmg`, drag the app to Applications. First launch: right-click →
   Open to clear Gatekeeper (the build is ad-hoc signed).
3. **Game-path detection** — the app auto-detects the STS2 install, or accepts a
   manually picked path without error.
4. **Switch a modpack** — pick one and Switch; the active set applies cleanly.
5. **Drag-drop install** — drag a mod `.zip` onto the window; it extracts and the
   mod appears in the Library.
6. **Toggle a mod off** — confirm the folder physically moves from `mods/` to
   `mods_disabled/` on disk (a move, not a copy — the rename→copy fallback path).
7. **Report a bug** — trigger Report a bug from the UI and confirm it produces a
   report (clipboard text or an issue link).
```

- [ ] **Step 5: Verify and commit.**

```bash
grep -n "Smoke-testing the macOS build" RELEASING.md
grep -c "the Nexus page currently hosts Windows only" RELEASING.md   # expect 0
git add RELEASING.md
git commit -m "docs: macOS release smoke checklist + Nexus multi-platform notes (#95)"
```

---

### Task 4: File the deferred Linux-smoke follow-up issue

**Goal:** Capture the deferred Linux automated WebDriver smoke work as a tracked GitHub issue so #95 can close cleanly.

**Files:** None (GitHub action only).

**Acceptance Criteria:**
- [ ] A new issue exists titled "CI: Linux automated WebDriver smoke leg (deferred from #95)" with a body summarizing the approach from the spec's "Out of scope" section.

**Verify:**
- `gh issue list --search "Linux automated WebDriver smoke" --state open` → the new issue appears.

**Steps:**

- [ ] **Step 1: Create the issue.**

```bash
gh issue create \
  --title "CI: Linux automated WebDriver smoke leg (deferred from #95)" \
  --label enhancement \
  --body "Deferred from #95. Unlike macOS (no WKWebView WebDriver), Linux automated UI smoke IS feasible in CI with no extra hardware — official \`tauri-driver\` drives WebKitGTK via WebKitWebDriver under xvfb.

Work:
- Make \`qa/runner/smoke.mjs\` platform-aware: app binary without the \`.exe\` suffix on Linux; use \`WebKitWebDriver\` as the native driver instead of \`msedgedriver.exe\`; skip/replace the \`taskkill\`-based \`reapZombieProcesses\` (it already returns early on non-win32); skip the msedgedriver preflight on Linux.
- Add a \`smoke-linux\` leg to \`.github/workflows/ci.yml\`: \`apt-get install\` the webkit driver package + \`xvfb\`, \`cargo install tauri-driver\`, \`npm run qa:smoke:build\`, then \`xvfb-run -a npm run qa:smoke:cassette\`.
- Add \`smoke-linux\` to the \`ci-gate\` \`needs\` list and its check loop.

The React DOM is identical across platforms, so the existing XPath specs should carry over; the main cost is a new CI leg with its own flakiness/timing budget. See docs/superpowers/specs/2026-06-04-cross-platform-ci-coverage-and-nexus-uploads-design.md."
```
Expected: prints the new issue URL.

---

## Notes on verification honesty

- **Task 1** is genuinely proven cross-platform only by the `workflow_dispatch` CI run (Step 5). Local `cargo test` proves Windows; macOS is proven by that CI leg. Do not claim macOS coverage works until the dispatched run is green.
- **Task 2** cannot be end-to-end tested before a real release (`publish-nexus` is tag-gated). It is validated by `actionlint` + the filename/logic review + the archive-semantics check (Step 2). State this limitation plainly when reporting completion.
- **No changelog fragment** for this PR (workflows+docs → `app: false`). Adding one would be wrong.
