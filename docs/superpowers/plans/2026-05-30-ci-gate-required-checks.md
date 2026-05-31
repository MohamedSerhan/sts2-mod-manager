# CI Gate (change-aware required checks) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A single always-on `CI Gate` status check, required on `main`, that internally runs only the checks relevant to a change (app tests, 3-platform build, compile, script tests, workflow lint, CHANGELOG gate) so neither the auto-fix bot nor a manual merge can land a breaking change.

**Architecture:** A new `.github/workflows/ci.yml`: a `changes` job classifies the diff (via a tested `scripts/ci-changes.mjs`) → conditional check jobs gate on `needs.changes.outputs.*` → an `always()` `CI Gate` job passes only if every *relevant* job succeeded (skipped = N/A). Branch protection requires `CI Gate`. The auto-merge workflow is tightened to require `CI Gate == SUCCESS`.

**Tech Stack:** GitHub Actions YAML, Node 22 (`node:test`), `tauri-apps/tauri-action`, `actionlint`, `gh` CLI. Spec: `docs/superpowers/specs/2026-05-30-ci-gate-required-checks-design.md`.

---

## File Map

**Create:**
- `scripts/ci-changes.mjs` (+ `scripts/ci-changes.test.mjs`) — pure `classifyPaths` + `unreleasedBulletCount` helpers + thin CLI (`classify`, `unreleased-count`).
- `.github/workflows/ci.yml` — the gate.

**Modify:**
- `.github/workflows/claude-autofix-merge.yml` — require the `CI Gate` check is `SUCCESS`.
- `.github/workflows/build.yml` — remove the now-redundant `check` job.
- `RELEASING.md` — document the gate + one-time `no-changelog` label + branch-protection setup.

---

### Task 1: `scripts/ci-changes.mjs` — change classifier + changelog counter

**Goal:** A tested module that buckets changed paths (`app`/`scripts`/`workflows`) and counts `[Unreleased]` CHANGELOG bullets, plus a CLI the workflow calls.

**Files:**
- Create: `scripts/ci-changes.mjs`, `scripts/ci-changes.test.mjs`

**Acceptance Criteria:**
- [ ] `classifyPaths` flags `app` for `src/**`, `src-tauri/**` (NOT `src-tauri/target/**`), `package.json`, `package-lock.json`, `src-tauri/{Cargo.toml,Cargo.lock,tauri.conf.json}`; `scripts` for `scripts/**`; `workflows` for `.github/workflows/**`; docs/other → all false; handles `[]`/`null`.
- [ ] `unreleasedBulletCount` counts `- `/`* ` bullets under `## [Unreleased]` only (0 for empty/no-section/no-bullets).
- [ ] CLI: `classify` reads newline paths on stdin → prints `app=.. scripts=.. workflows=..`; `unreleased-count` reads CHANGELOG text on stdin → prints the count. Module has no import side effects.
- [ ] `node --test scripts/ci-changes.test.mjs` passes.

**Verify:** `node --test scripts/ci-changes.test.mjs` → all pass.

**Steps:**

- [ ] **Step 1: Write `scripts/ci-changes.test.mjs`:**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPaths, unreleasedBulletCount } from './ci-changes.mjs';

test('classifyPaths buckets app/scripts/workflows', () => {
  assert.deepEqual(classifyPaths(['src/App.tsx']), { app: true, scripts: false, workflows: false });
  assert.deepEqual(classifyPaths(['src-tauri/src/lib.rs']), { app: true, scripts: false, workflows: false });
  assert.deepEqual(classifyPaths(['src-tauri/Cargo.toml']), { app: true, scripts: false, workflows: false });
  assert.deepEqual(classifyPaths(['package-lock.json']), { app: true, scripts: false, workflows: false });
  assert.deepEqual(classifyPaths(['scripts/foo.mjs']), { app: false, scripts: true, workflows: false });
  assert.deepEqual(classifyPaths(['.github/workflows/ci.yml']), { app: false, scripts: false, workflows: true });
  assert.deepEqual(classifyPaths(['README.md', 'docs/x.md', '.claude/y']), { app: false, scripts: false, workflows: false });
});

test('classifyPaths ignores src-tauri/target, handles mixed + empty/null', () => {
  assert.deepEqual(classifyPaths(['src-tauri/target/release/x']), { app: false, scripts: false, workflows: false });
  assert.deepEqual(classifyPaths(['src/a.ts', 'scripts/b.mjs']), { app: true, scripts: true, workflows: false });
  assert.deepEqual(classifyPaths([]), { app: false, scripts: false, workflows: false });
  assert.deepEqual(classifyPaths(null), { app: false, scripts: false, workflows: false });
});

test('unreleasedBulletCount counts bullets under [Unreleased] only', () => {
  const cl = `# Changelog

## [Unreleased]
### Added
- A new thing
- Another thing
### Fixed
- A fix

## [1.2.0] - 2026-01-01
### Added
- Old thing
`;
  assert.equal(unreleasedBulletCount(cl), 3);
});

test('unreleasedBulletCount = 0 for empty/no-section/no-bullets', () => {
  assert.equal(unreleasedBulletCount(''), 0);
  assert.equal(unreleasedBulletCount('# Changelog\n## [1.0.0]\n- x\n'), 0);
  assert.equal(unreleasedBulletCount('## [Unreleased]\n### Added\n'), 0);
});
```

- [ ] **Step 2: Run → confirm fail** (`node --test scripts/ci-changes.test.mjs`; module missing).

- [ ] **Step 3: Implement `scripts/ci-changes.mjs`:**

```js
// scripts/ci-changes.mjs
// Pure helpers + thin CLI for the change-aware CI gate (.github/workflows/ci.yml).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const APP_PATTERNS = [
  /^src\//,
  /^src-tauri\/(?!target\/)/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^src-tauri\/Cargo\.toml$/,
  /^src-tauri\/Cargo\.lock$/,
  /^src-tauri\/tauri\.conf\.json$/,
];

/** Bucket a list of changed file paths into the gate's categories. */
export function classifyPaths(paths) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.length);
  return {
    app: list.some((p) => APP_PATTERNS.some((re) => re.test(p))),
    scripts: list.some((p) => /^scripts\//.test(p)),
    workflows: list.some((p) => /^\.github\/workflows\//.test(p)),
  };
}

/** Count bullet lines ("- ..."/"* ...") under the `## [Unreleased]` heading. */
export function unreleasedBulletCount(changelogText) {
  const lines = (typeof changelogText === 'string' ? changelogText : '').split(/\r?\n/);
  let inSection = false;
  let count = 0;
  for (const line of lines) {
    if (/^##\s+\[/.test(line)) { inSection = /^##\s+\[Unreleased\]/i.test(line); continue; }
    if (inSection && /^\s*[-*]\s+\S/.test(line)) count += 1;
  }
  return count;
}

function readStdin() { try { return readFileSync(0, 'utf-8'); } catch { return ''; } }

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'classify') {
    const paths = readStdin().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const { app, scripts, workflows } = classifyPaths(paths);
    console.log(`app=${app}`);
    console.log(`scripts=${scripts}`);
    console.log(`workflows=${workflows}`);
  } else if (cmd === 'unreleased-count') {
    console.log(unreleasedBulletCount(readStdin()));
  } else {
    console.error('usage: ci-changes.mjs classify|unreleased-count');
    process.exit(2);
  }
}
```

- [ ] **Step 4: Run tests → pass.** Sanity: `printf 'src/a.ts\nscripts/b.mjs\n' | node scripts/ci-changes.mjs classify` → `app=true / scripts=true / workflows=false`.

- [ ] **Step 5: Commit** (`git add scripts/ci-changes.mjs scripts/ci-changes.test.mjs`; message `feat(ci): ci-changes.mjs — change classifier + [Unreleased] counter`; trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`).

---

### Task 2: `.github/workflows/ci.yml` — the change-aware gate

**Goal:** The gate workflow: `changes` → conditional jobs → `CI Gate` gatekeeper.

**Files:**
- Create: `.github/workflows/ci.yml`

**Acceptance Criteria:**
- [ ] `changes` job emits `app`/`scripts`/`workflows` outputs from the PR diff via `ci-changes.mjs classify` (and treats `workflow_dispatch` as everything-changed).
- [ ] `compile` (app|scripts|workflows), `test-frontend` (app), `test-rust` (app), `app-build` (app, 3-platform matrix), `script-tests` (scripts), `workflow-lint` (workflows), `changelog` (app && PR && not `no-changelog`) each gate on the right `needs.changes.outputs.*`.
- [ ] `CI Gate` job is `if: always()`, `needs:` all jobs, fails iff any needed job's `result` is `failure`/`cancelled`.
- [ ] `permissions: contents: read`; valid YAML.

**Verify:** `python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('OK')"` → `OK`.

**Steps:**

- [ ] **Step 1: Create `.github/workflows/ci.yml`:**

```yaml
name: CI Gate

# Change-aware required gate. The single `CI Gate` check (set required in branch
# protection) passes only if every check RELEVANT to the change succeeded; a
# correctly-skipped job counts as not-applicable. See the spec.
on:
  pull_request:
    branches: [main]
    types: [opened, synchronize, reopened, labeled, unlabeled]
  workflow_dispatch:

concurrency:
  group: ci-gate-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  changes:
    runs-on: ubuntu-latest
    outputs:
      app: ${{ steps.classify.outputs.app }}
      scripts: ${{ steps.classify.outputs.scripts }}
      workflows: ${{ steps.classify.outputs.workflows }}
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
      - name: Classify changed files
        id: classify
        run: |
          if [ "${{ github.event_name }}" = "pull_request" ]; then
            CHANGED=$(git diff --name-only "${{ github.event.pull_request.base.sha }}" "${{ github.event.pull_request.head.sha }}")
          else
            # workflow_dispatch: run everything.
            CHANGED=$(printf 'src/x\nsrc-tauri/x\nscripts/x\n.github/workflows/x\n')
          fi
          printf '%s\n' "$CHANGED" | node scripts/ci-changes.mjs classify >> "$GITHUB_OUTPUT"
          echo "--- buckets ---"; printf '%s\n' "$CHANGED" | node scripts/ci-changes.mjs classify

  compile:
    needs: changes
    if: ${{ needs.changes.outputs.app == 'true' || needs.changes.outputs.scripts == 'true' || needs.changes.outputs.workflows == 'true' }}
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
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
          cache: "npm"
      - run: npm ci
      - name: TypeScript check
        run: npx tsc --noEmit
      - name: Cargo check
        working-directory: src-tauri
        run: cargo check

  test-frontend:
    needs: changes
    if: ${{ needs.changes.outputs.app == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
          cache: "npm"
      - run: npm ci
      - name: Frontend tests (vitest)
        run: npm test

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
      - name: Rust tests
        run: cargo test --manifest-path=src-tauri/Cargo.toml

  app-build:
    needs: changes
    if: ${{ needs.changes.outputs.app == 'true' }}
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: windows-latest
            args: ""
          - platform: macos-latest
            args: "--target universal-apple-darwin"
          - platform: ubuntu-22.04
            args: ""
    runs-on: ${{ matrix.platform }}
    steps:
      - uses: actions/checkout@v5
      - name: Install system dependencies (Linux)
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libssl-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev squashfs-tools
      - uses: dtolnay/rust-toolchain@stable
      - name: Add Rust targets (macOS universal)
        if: matrix.platform == 'macos-latest'
        run: |
          rustup target add aarch64-apple-darwin
          rustup target add x86_64-apple-darwin
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri
          key: ci-gate-${{ matrix.platform }}
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
          cache: "npm"
      - run: npm ci
      - name: Build (verify it bundles on this platform)
        # Build-only: empty tagName => no release, no upload. No signing env: the
        # gate verifies compilation + bundling, not updater signatures.
        # IMPLEMENTER NOTE: if tauri-action errors without signing because the
        # updater plugin is configured, add the two TAURI_SIGNING_* env vars from
        # build.yml's "Build Tauri app" step.
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: ""
          releaseName: ""
          includeUpdaterJson: false
          args: ${{ matrix.args }}

  script-tests:
    needs: changes
    if: ${{ needs.changes.outputs.scripts == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
      - name: Script unit tests
        run: |
          node --test scripts/nexus-triage.test.mjs
          node --test scripts/dev-build-stamp.test.mjs
          node --test scripts/make-dev-icon.test.mjs
          node --test scripts/qa-pipeline.test.mjs
          node --test scripts/ci-changes.test.mjs

  workflow-lint:
    needs: changes
    if: ${{ needs.changes.outputs.workflows == 'true' }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - name: YAML parse all workflows
        run: |
          python -c "import yaml,glob; [yaml.safe_load(open(f)) for f in glob.glob('.github/workflows/*.yml')]; print('YAML OK')"
      - name: actionlint
        uses: raven-actions/actionlint@v2

  changelog:
    needs: changes
    if: ${{ github.event_name == 'pull_request' && needs.changes.outputs.app == 'true' && !contains(github.event.pull_request.labels.*.name, 'no-changelog') }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
      - name: Require a new [Unreleased] CHANGELOG entry
        run: |
          BASE_COUNT=$(git show "${{ github.event.pull_request.base.sha }}:CHANGELOG.md" 2>/dev/null | node scripts/ci-changes.mjs unreleased-count || echo 0)
          HEAD_COUNT=$(node scripts/ci-changes.mjs unreleased-count < CHANGELOG.md)
          echo "[Unreleased] bullets — base: $BASE_COUNT, head: $HEAD_COUNT"
          if [ "$HEAD_COUNT" -le "$BASE_COUNT" ]; then
            echo "::error::App code changed but no new CHANGELOG [Unreleased] bullet was added. Add a player-language entry, or label the PR 'no-changelog' for internal-only changes."
            exit 1
          fi

  ci-gate:
    name: CI Gate
    needs: [changes, compile, test-frontend, test-rust, app-build, script-tests, workflow-lint, changelog]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Verify every relevant check passed
        run: |
          fail=0
          check() { echo "$1: $2"; if [ "$2" = "failure" ] || [ "$2" = "cancelled" ]; then fail=1; fi; }
          check "changes"       "${{ needs.changes.result }}"
          check "compile"       "${{ needs.compile.result }}"
          check "test-frontend" "${{ needs.test-frontend.result }}"
          check "test-rust"     "${{ needs.test-rust.result }}"
          check "app-build"     "${{ needs.app-build.result }}"
          check "script-tests"  "${{ needs.script-tests.result }}"
          check "workflow-lint" "${{ needs.workflow-lint.result }}"
          check "changelog"     "${{ needs.changelog.result }}"
          if [ "$fail" = "1" ]; then echo "::error::CI Gate failed — a relevant check did not pass."; exit 1; fi
          echo "CI Gate passed (skipped jobs were not relevant to this change)."
```

- [ ] **Step 2: Validate** — `python -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('OK')"` → `OK`.

- [ ] **Step 3: Commit** (`feat(ci): change-aware CI Gate workflow`; 4.8 trailer).

---

### Task 3: Require `CI Gate == SUCCESS` in the auto-merge gate

**Goal:** `claude-autofix-merge.yml` only merges when the `CI Gate` check specifically succeeded (not merely "nothing failing"), aligning the bot's pre-check with branch protection.

**Files:**
- Modify: `.github/workflows/claude-autofix-merge.yml`

**Acceptance Criteria:**
- [ ] The "Require CI green" step checks the `CI Gate` check's state is `SUCCESS` (via `gh pr checks --json name,state`), not the bare `gh pr checks` exit code.
- [ ] Not-`SUCCESS` (incl. missing/pending) → `green=false` + the existing holding comment; YAML valid.

**Verify:** `python -c "import yaml; yaml.safe_load(open('.github/workflows/claude-autofix-merge.yml')); print('OK')"` → `OK`.

**Steps:**

- [ ] **Step 1: Replace the `Require CI green` step's `run:` body** with:

```bash
          # Require the change-aware CI Gate specifically to have SUCCEEDED.
          STATE=$(gh pr checks "$PR" --repo "$REPO" --json name,state \
                    --jq '[.[] | select(.name == "CI Gate")][0].state // "MISSING"')
          echo "CI Gate state: $STATE"
          if [ "$STATE" = "SUCCESS" ]; then
            echo "green=true" >> "$GITHUB_OUTPUT"
          else
            echo "green=false" >> "$GITHUB_OUTPUT"
            gh pr comment "$PR" --repo "$REPO" --body "Approved + QA-passed, but the CI Gate isn't green yet (state: $STATE) — holding the merge until it passes. Re-approve once it's green."
          fi
```

(Keep the step's `id: ci`, its `if:`, and the surrounding `gate`/`merge` steps unchanged.)

- [ ] **Step 2: Validate YAML** (command above) → `OK`.

- [ ] **Step 3: Commit** (`feat(ci): auto-merge requires the CI Gate check to succeed`; 4.8 trailer).

---

### Task 4: Remove the redundant `check` job from `build.yml`

**Goal:** `ci.yml`'s `compile` + `script-tests` supersede `build.yml`'s `check` job; remove it so compile/tests don't double-run and there's one source of truth.

**Files:**
- Modify: `.github/workflows/build.yml`

**Acceptance Criteria:**
- [ ] The `check` job (and only it) is removed from `build.yml`; the `build` + `publish-*` + `format-release` jobs and all triggers are untouched.
- [ ] No remaining reference to a `check` job/needs; YAML valid.

**Verify:** `python -c "import yaml; d=yaml.safe_load(open('.github/workflows/build.yml')); assert 'check' not in d['jobs']; print('OK')"` → `OK`.

**Steps:**

- [ ] **Step 1:** Delete the entire `check:` job block in `.github/workflows/build.yml` (from `  check:` through the last `node --test` step, ending just before `  build:`). Leave the `on:`/`concurrency:`/`permissions:` and every other job exactly as-is.
- [ ] **Step 2: Validate** (command above) → `OK`. Also confirm `grep -n "needs:.*check" .github/workflows/build.yml` returns nothing (no job depended on `check`).
- [ ] **Step 3: Commit** (`refactor(ci): drop build.yml check job — superseded by the CI Gate`; 4.8 trailer).

---

### Task 5: Runbook + one-time setup (`RELEASING.md`)

**Goal:** Document the gate, the `no-changelog` label, and the exact one-time commands the maintainer runs (the `no-changelog` label + making `CI Gate` a required status check — neither of which the automation may do itself).

**Files:**
- Modify: `RELEASING.md`

**Acceptance Criteria:**
- [ ] A "### CI Gate (required checks)" subsection explains: the gate runs only checks relevant to the change; `CI Gate` is required on `main` so nothing merges (auto or manual) until it's green; app PRs run app tests + 3-platform build + a CHANGELOG `[Unreleased]` entry (or the `no-changelog` label).
- [ ] Documents the one-time `gh label create no-changelog` command and the branch-protection command/UI to require the `CI Gate` check.
- [ ] Notes that direct pushes to `main` should be disallowed (require PRs) so the gate can't be bypassed.

**Verify:** `grep -q "CI Gate" RELEASING.md && grep -q "no-changelog" RELEASING.md && echo OK` → `OK`.

**Steps:**

- [ ] **Step 1:** Add the subsection. Include this setup block:

```bash
# One-time label
gh label create no-changelog --color ededed --description "App change with no user-facing CHANGELOG entry (skips the changelog gate)" --repo MohamedSerhan/sts2-mod-manager

# Make CI Gate a required status check on main (also disallow direct pushes via the UI:
# Settings -> Branches -> main -> Require a pull request before merging).
gh api -X PATCH repos/MohamedSerhan/sts2-mod-manager/branches/main/protection/required_status_checks \
  -f 'strict=true' -f 'checks[][context]=CI Gate'
```

(Note: the exact `gh api` shape for required checks can vary by API version; the UI path is Settings → Branches → main → Require status checks to pass → add `CI Gate`. Document both.)

- [ ] **Step 2: Verify + commit** (`docs(ci): runbook for the CI Gate + one-time required-check setup`; 4.8 trailer).

---

### Task 6: End-to-end verification (USER GATE)

**Goal:** Prove the gate live on `main`: it runs only relevant checks, and it blocks a bad change from merging (auto AND manual).

**Files:** None (operational — runs post-merge, since the gate fires from the default branch + PR head, and the required-check setting applies once `CI Gate` exists on `main`).

**Acceptance Criteria:**
- [ ] After this merges to `main`: the `no-changelog` label exists and `CI Gate` is set as a required status check on `main`.
- [ ] A **docs-only** PR → only `changes` + `CI Gate` run (everything else skipped) → goes green fast → mergeable.
- [ ] A **scripts-only** PR → `script-tests` run; no `app-build`.
- [ ] An **app** PR with a deliberately failing vitest or `cargo test` → `CI Gate` RED → merge blocked (the bot's auto-merge holds AND the maintainer cannot manually merge).
- [ ] An **app** PR with no CHANGELOG entry → `changelog` RED → blocked; adding `no-changelog` → green.
- [ ] An **app** PR that breaks one platform's build → `app-build` (that platform) RED → `CI Gate` RED → blocked.
- [ ] The auto-fix bot's app-touching PR runs the full gate before its approval-merge.

**Verify:** (operational) `gh pr checks <N>` shows only the relevant jobs ran; a PR with a forced-failing check shows `CI Gate` failing and `gh pr merge` is refused by branch protection.

**Steps:**
- [ ] **Step 1:** After merge, create the `no-changelog` label + set `CI Gate` required (Task 5 commands).
- [ ] **Step 2:** Open a docs-only throwaway PR → confirm only `CI Gate` runs + it's green.
- [ ] **Step 3:** Open an app PR with a deliberately failing test → confirm `CI Gate` RED + merge blocked; then fix → green + mergeable. Clean up the throwaway PRs.
- [ ] **Step 4:** Confirm the `no-changelog` path: an app PR with no changelog → RED; add label → green.

No commit (verification only).

---

## Self-Review

| Spec requirement | Task |
|---|---|
| Change detection into app/scripts/workflows buckets | Task 1 (`classifyPaths`) + Task 2 (`changes` job) |
| App tests (vitest + cargo test) as gates | Task 2 (`test-frontend`, `test-rust`) |
| 3-platform build as a gate, app-changes only | Task 2 (`app-build`) |
| Compile/type checks | Task 2 (`compile`) |
| Script tests / workflow lint, conditional | Task 2 (`script-tests`, `workflow-lint`) |
| CHANGELOG `[Unreleased]` gate + `no-changelog` opt-out | Task 1 (`unreleasedBulletCount`) + Task 2 (`changelog`) + Task 5 (label) |
| Single always-on `CI Gate` gatekeeper | Task 2 (`ci-gate`) |
| Required on `main` (gates auto + manual) | Task 5 (branch-protection command) + Task 6 (apply + verify) |
| Auto-merge respects the gate | Task 3 (`CI Gate == SUCCESS`) |
| Remove redundant `check` | Task 4 |
| Live verification | Task 6 |

All spec requirements mapped. Naming consistent: `classifyPaths`/`unreleasedBulletCount`/`ci-changes.mjs`/`CI Gate` across Tasks 1–6. Plan-level decisions resolved: custom tested `ci-changes.mjs` (not a third-party path-filter); focused build duplication in `app-build` (composite-action refactor noted as future); `check` removed from `build.yml`; gate triggers on `pull_request` + `workflow_dispatch` (no `push` — PRs are the gate point, main is built from gated PRs, and direct pushes are disallowed via branch protection).
