# Release Trigger + Release-Worthiness Suggester — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A guided `workflow_dispatch` release (patch/minor/major dropdown wrapping `scripts/release.sh`), a `RELEASING.md` definition of "release-worthy" (= user-facing CHANGELOG entry), and a release-suggester workflow that comments the release URL + suggested bump on any PR that adds a user-facing entry — suggest-only, never auto-release.

**Architecture:** Reuse the existing `scripts/release.sh` (it already bumps all version files, enforces the changelog gate, tags `v<next>`, and pushes → `build.yml`'s `v*`-tag publish pipeline). A new `release.yml` wraps it behind a dropdown; a new `release-suggester.yml` reuses `ci-changes.mjs` to detect a new `[Unreleased]` bullet and post a marked comment.

**Tech Stack:** GitHub Actions (`workflow_dispatch` choice input, `pull_request`), Node 22 + `node:test`, `gh` CLI, `scripts/release.sh`, `actionlint`.

**Spec:** `docs/superpowers/specs/2026-05-31-release-trigger-design.md`

> ⚠️ **HARD SAFETY RULE — do NOT _run_ `release.yml` as a test.** Triggering it cuts a **real release** (tag → `build.yml` publishes → users get it), which violates the "no release until v1.7.0" requirement. `release.yml` is validated by `actionlint` + inspection ONLY. Its first real run is when the maintainer chooses to cut the actual release. The release-*suggester* (which only comments) is the part that gets a live test.

**Merge note:** like the other workflow PRs, this lands via maintainer admin-merge after CI Gate (single-maintainer; can't self-approve). Merging it does NOT release anything — `release.yml` only runs on manual dispatch.

---

### Task 1: `suggestedBump` helper + tests in `ci-changes.mjs`

**Goal:** A pure function (+ CLI) that maps a CHANGELOG `[Unreleased]` section to a suggested semver bump, so the suggester can recommend patch/minor/major.

**Files:**
- Modify: `scripts/ci-changes.mjs` (add `suggestedBump` export + a `suggested-bump` CLI command)
- Modify: `scripts/ci-changes.test.mjs` (add tests)

**Acceptance Criteria:**
- [ ] `suggestedBump(text)`: `Removed` section or a `BREAKING` marker → `'major'`; `Added`/`Changed`/`Deprecated` → `'minor'`; only `Fixed`/`Security` → `'patch'`; no `[Unreleased]` bullets → `null`.
- [ ] CLI `node scripts/ci-changes.mjs suggested-bump < CHANGELOG.md` prints the bump (nothing when `null`).
- [ ] New tests pass; existing `ci-changes.test.mjs` tests still pass.

**Verify:** `node --test scripts/ci-changes.test.mjs` → all pass.

**Steps:**

- [ ] **Step 1: Write failing tests** — append to `scripts/ci-changes.test.mjs`. Also add `suggestedBump` to the existing top `import { classifyPaths, unreleasedBulletCount } from './ci-changes.mjs';` line → `import { classifyPaths, unreleasedBulletCount, suggestedBump } from './ci-changes.mjs';`

```js
test('suggestedBump: Added -> minor', () => {
  assert.equal(suggestedBump('## [Unreleased]\n### Added\n- A thing\n'), 'minor');
});
test('suggestedBump: only Fixed -> patch', () => {
  assert.equal(suggestedBump('## [Unreleased]\n### Fixed\n- A fix\n'), 'patch');
});
test('suggestedBump: Removed -> major', () => {
  assert.equal(suggestedBump('## [Unreleased]\n### Removed\n- Dropped X\n'), 'major');
});
test('suggestedBump: BREAKING marker -> major', () => {
  assert.equal(suggestedBump('## [Unreleased]\n### Changed\n- BREAKING: changed Y\n'), 'major');
});
test('suggestedBump: Added + Fixed -> minor', () => {
  assert.equal(suggestedBump('## [Unreleased]\n### Added\n- A\n### Fixed\n- B\n'), 'minor');
});
test('suggestedBump: Security only -> patch', () => {
  assert.equal(suggestedBump('## [Unreleased]\n### Security\n- Patched Z\n'), 'patch');
});
test('suggestedBump: empty/no bullets -> null', () => {
  assert.equal(suggestedBump('## [Unreleased]\n### Added\n'), null);
  assert.equal(suggestedBump(''), null);
});
```

- [ ] **Step 2: Run tests, confirm they FAIL** — `node --test scripts/ci-changes.test.mjs` → fails (`suggestedBump is not a function`).

- [ ] **Step 3: Implement `suggestedBump`** — add to `scripts/ci-changes.mjs` right after `unreleasedBulletCount`:

```js
/** Suggest a semver bump from the CHANGELOG `[Unreleased]` section.
 *  `Removed` or a `BREAKING` marker -> 'major'; `Added`/`Changed`/`Deprecated`
 *  -> 'minor'; only `Fixed`/`Security` -> 'patch'. Returns null when the
 *  `[Unreleased]` section has no bullet content. */
export function suggestedBump(changelogText) {
  const lines = (typeof changelogText === 'string' ? changelogText : '').split(/\r?\n/);
  let inSection = false;
  let heading = null;
  const filled = new Set();
  let breaking = false;
  for (const line of lines) {
    if (/^##\s+\[/.test(line)) { inSection = /^##\s+\[Unreleased\]/i.test(line); heading = null; continue; }
    if (!inSection) continue;
    if (/^###\s+/.test(line)) { heading = line.replace(/^###\s+/, '').trim().toLowerCase(); continue; }
    if (/\bBREAKING\b/i.test(line)) breaking = true;
    if (heading && /^\s*[-*]\s+\S/.test(line)) filled.add(heading);
  }
  if (filled.size === 0 && !breaking) return null;
  if (breaking || filled.has('removed')) return 'major';
  if (filled.has('added') || filled.has('changed') || filled.has('deprecated')) return 'minor';
  return 'patch';
}
```

- [ ] **Step 4: Add the CLI command** — in the `isMain` block, add a branch alongside `unreleased-count`:

```js
  } else if (cmd === 'suggested-bump') {
    const b = suggestedBump(readStdin());
    if (b) console.log(b);
  } else {
```
(Update the `usage:` error string to `classify|unreleased-count|suggested-bump`.)

- [ ] **Step 5: Run tests, confirm PASS** — `node --test scripts/ci-changes.test.mjs` → all pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/ci-changes.mjs scripts/ci-changes.test.mjs
git commit -m "feat(ci): suggestedBump helper for release-worthiness suggester"
```

---

### Task 2: `release.yml` — the guided release workflow

**Goal:** A `workflow_dispatch` workflow with a patch/minor/major dropdown that runs `scripts/release.sh` to cut a release.

**Files:**
- Create: `.github/workflows/release.yml`

**Acceptance Criteria:**
- [ ] `workflow_dispatch` with a `bump` `choice` input (options: patch, minor, major).
- [ ] Checks out `main` with the **PAT** (`DEV_BUILD_LABEL_TOKEN`) so the tag push triggers `build.yml`.
- [ ] Runs `npm ci`, sets up Node + Rust, and runs `SKIP_QA=1 ./scripts/release.sh "<bump>"`.
- [ ] `actionlint` passes.

**Verify:** `actionlint .github/workflows/release.yml` → no errors (or the CI `workflow-lint` job on the PR). **Do NOT run the workflow** (it cuts a real release).

**Steps:**

- [ ] **Step 1: Create `.github/workflows/release.yml`:**

```yaml
name: Release
# Manual, guided release. Pick the semver bump; this wraps scripts/release.sh,
# which enforces the CHANGELOG gate, bumps all version files, tags v<next>, and
# pushes -> build.yml's publish pipeline fires on the v* tag.
#
# SKIP_QA=1: everything on main already passed the required CI Gate (3-platform
# build + smoke + tests) at merge, and the Windows smoke can't run here. The
# changelog/dev-speak + i18n gates in release.sh still run (they are outside SKIP_QA).
on:
  workflow_dispatch:
    inputs:
      bump:
        description: "Release type"
        required: true
        type: choice
        options: [patch, minor, major]
permissions:
  contents: write
jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout main (PAT so the tag push triggers build.yml)
        uses: actions/checkout@v5
        with:
          ref: main
          fetch-depth: 0
          token: ${{ secrets.DEV_BUILD_LABEL_TOKEN }}
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
          cache: "npm"
      - run: npm ci
      - uses: dtolnay/rust-toolchain@stable
      - name: Configure git identity
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
      - name: Cut release
        env:
          SKIP_QA: "1"
        run: ./scripts/release.sh "${{ inputs.bump }}"
```

- [ ] **Step 2: Validate (inspection only)** — `actionlint .github/workflows/release.yml` (if installed; else rely on the PR's `workflow-lint`). Re-read the YAML; confirm the PAT checkout, `npm ci`, and `SKIP_QA=1` are present. **Do not trigger it.**

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(release): guided workflow_dispatch release with patch/minor/major picker"
```

---

### Task 3: `release-suggester.yml` — the PR comment

**Goal:** On any PR that adds a new user-facing CHANGELOG `[Unreleased]` bullet, post/update one marked comment with the suggested bump + the Release-workflow URL.

**Files:**
- Create: `.github/workflows/release-suggester.yml`

**Acceptance Criteria:**
- [ ] Triggers on `pull_request` (opened/synchronize/reopened) to `main`; permissions `contents: read`, `pull-requests: write`.
- [ ] Computes head vs base `unreleased-count`; if head added a bullet → release-worthy.
- [ ] Posts/updates ONE comment marked `<!-- release-suggester -->` with the suggested bump (from `suggested-bump`) + the link to `release.yml`'s Run page. Removes it if a later push makes the PR no longer release-worthy.
- [ ] `actionlint` passes.

**Verify:** `actionlint .github/workflows/release-suggester.yml` → no errors. (Live behavior validated in Task 5.)

**Steps:**

- [ ] **Step 1: Create `.github/workflows/release-suggester.yml`:**

```yaml
name: Release suggester
# When a PR adds a user-facing CHANGELOG [Unreleased] entry, comment the suggested
# bump + a link to the Release workflow. Suggest-only — this never cuts a release.
on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [main]
permissions:
  contents: read
  pull-requests: write
concurrency:
  group: release-suggester-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  suggest:
    runs-on: ubuntu-latest
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      REPO: ${{ github.repository }}
      PR: ${{ github.event.pull_request.number }}
      MARKER: "<!-- release-suggester -->"
    steps:
      - uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
      - name: Decide release-worthiness + bump
        id: decide
        run: |
          BASE_SHA="${{ github.event.pull_request.base.sha }}"
          HEAD_COUNT=$(node scripts/ci-changes.mjs unreleased-count < CHANGELOG.md)
          BASE_COUNT=$(git show "$BASE_SHA:CHANGELOG.md" 2>/dev/null | node scripts/ci-changes.mjs unreleased-count || echo 0)
          echo "base=$BASE_COUNT head=$HEAD_COUNT"
          if [ "$HEAD_COUNT" -gt "$BASE_COUNT" ]; then
            BUMP=$(node scripts/ci-changes.mjs suggested-bump < CHANGELOG.md)
            echo "worthy=true" >> "$GITHUB_OUTPUT"
            echo "bump=${BUMP:-minor}" >> "$GITHUB_OUTPUT"
          else
            echo "worthy=false" >> "$GITHUB_OUTPUT"
          fi
      - name: Find existing marked comment
        id: find
        run: |
          ID=$(gh api "repos/$REPO/issues/$PR/comments" --paginate \
                 --jq "[.[] | select(.body | startswith(\"$MARKER\"))][0].id // empty")
          echo "id=$ID" >> "$GITHUB_OUTPUT"
      - name: Post or update suggestion
        if: ${{ steps.decide.outputs.worthy == 'true' }}
        run: |
          RUN_URL="${{ github.server_url }}/$REPO/actions/workflows/release.yml"
          DEF_URL="${{ github.server_url }}/$REPO/blob/main/RELEASING.md"
          BODY=$(printf '%s\n' \
            "$MARKER" \
            "🚀 **Release-worthy** — this PR adds a user-facing change ([what counts]($DEF_URL))." \
            "" \
            "Suggested bump: **${{ steps.decide.outputs.bump }}**." \
            "" \
            "Once it merges, ship it (plus anything else queued on \`main\`) → **[Run the Release workflow]($RUN_URL)**, pick the bump, and Run.")
          if [ -n "${{ steps.find.outputs.id }}" ]; then
            gh api -X PATCH "repos/$REPO/issues/comments/${{ steps.find.outputs.id }}" -f body="$BODY" >/dev/null
            echo "Updated existing comment."
          else
            gh pr comment "$PR" --repo "$REPO" --body "$BODY"
            echo "Posted new comment."
          fi
      - name: Remove stale suggestion
        if: ${{ steps.decide.outputs.worthy == 'false' && steps.find.outputs.id != '' }}
        run: |
          gh api -X DELETE "repos/$REPO/issues/comments/${{ steps.find.outputs.id }}" >/dev/null
          echo "Removed stale suggestion."
```

- [ ] **Step 2: Validate** — `actionlint .github/workflows/release-suggester.yml`. Note `SHELLCHECK_OPTS: --exclude=SC2016` is set globally if actionlint flags the single-quoted `$` in the jq (matches `workflow-lint`'s config).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release-suggester.yml
git commit -m "feat(release): suggest release + bump on PRs with a user-facing changelog entry"
```

---

### Task 4: `RELEASING.md` — the release-worthiness definition

**Goal:** A short section codifying what "release-worthy" means, as the single source of truth the suggester links to.

**Files:**
- Modify: `RELEASING.md`

**Acceptance Criteria:**
- [ ] A "What's release-worthy" section states: user-facing (adds a CHANGELOG `[Unreleased]` bullet) = release-worthy; internal-only is not.

**Verify:** Read `RELEASING.md`; the section is present and matches the suggester's rule.

**Steps:**

- [ ] **Step 1: Add this section to `RELEASING.md`** (near the top, or beside the existing release instructions):

```markdown
## What's release-worthy

A change is **release-worthy** iff it is **user-facing** — i.e. it adds a
`CHANGELOG.md` `[Unreleased]` bullet under Added / Changed / Fixed / Security
(or Removed / Deprecated). Internal-only changes (CI, build, tests, refactors,
docs, chore) are **not** release-worthy and don't, on their own, warrant a release.

The release-suggester bot applies exactly this rule: it comments on a PR only
when the PR adds a new `[Unreleased]` bullet, and the "Run the Release workflow"
link it posts is how you ship — when you're ready, it releases everything queued
in `[Unreleased]` at once.
```

- [ ] **Step 2: Commit**

```bash
git add RELEASING.md
git commit -m "docs(release): define what makes a change release-worthy"
```

---

### Task 5: Validate live (suggester) + land the feature

**Goal:** Prove the suggester comments correctly on a real PR, confirm `release.yml` is sound by inspection (NOT by running it), then land the feature on `main`.

**Files:** none (operational).

**Acceptance Criteria:**
- [ ] On a PR that adds a user-facing `[Unreleased]` bullet, the suggester posts the marked comment with the correct suggested bump + the `release.yml` Run URL.
- [ ] On a PR with no new `[Unreleased]` bullet (or `no-changelog`), no comment is posted.
- [ ] `release.yml` confirmed via `actionlint` + inspection — **NOT run** (running it would cut a real release).
- [ ] The feature PR is CI-green (workflow-lint + script-tests + CI Gate) and merged to `main` by maintainer admin-merge. Merging does NOT trigger a release.

**Verify:** `gh pr view <suggester-test-pr> --json comments` shows the marked comment with the right bump; `gh release view --json tagName` is unchanged (still v1.6.1) throughout.

**Steps:**

- [ ] **Step 1:** Open the feature PR (`release-trigger` → `main`). CI runs `script-tests` (the new `ci-changes` tests) + `workflow-lint` + `CI Gate`.
- [ ] **Step 2:** The feature PR itself adds no `[Unreleased]` bullet (it's internal/CI), so the suggester should NOT comment on it — that's the negative case. To test the positive case, either rely on the next real user-facing auto-fix PR, or push a tiny throwaway branch that adds one `[Unreleased]` bullet and open a draft PR → confirm the marked comment appears with the right bump → close it.
- [ ] **Step 3:** Confirm `gh release view --json tagName` is still `v1.6.1` (nothing released).
- [ ] **Step 4:** Maintainer admin-merges the feature PR after CI Gate is green. Confirm again no release fired.

---

## Self-Review

- **Spec coverage:** release workflow → Task 2; release-worthiness definition → Task 4; suggester comment → Task 3 (+ helper Task 1); flow/safety/validation → Task 5. The suggested-bump heuristic from the spec → Task 1. All spec sections map to a task.
- **Placeholder scan:** no TBD/TODO; full code for the helper + tests, full YAML for both workflows, full text for the doc. The only "fill-in" is the operator picking a throwaway PR in Task 5, which is inherent to a live test.
- **Type/identifier consistency:** `suggestedBump` / `suggested-bump` / `unreleased-count` / the `<!-- release-suggester -->` marker / `DEV_BUILD_LABEL_TOKEN` / `SKIP_QA=1` are used consistently across tasks and match the existing repo conventions.
