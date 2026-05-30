# QA-review loop + approval-gated auto-merge (sub-project C+) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `qa` label (any PR) runs the bot's work through an automated QA-Claude review loop (capped at 5 rounds, then escalate) and auto-merges on `MohamedSerhan`'s approval only (when `qa-passed` + CI green); fix PRs ship complete with unit tests + a changelog entry when user-facing.

**Architecture:** Extends sub-project C. A tested `scripts/qa-pipeline.mjs` holds the pure logic (round-count, merge-eligibility). `claude-autofix.yml` is edited (initiate prompt adds tests+changelog; post-step also applies `qa`; revise gate widened to `auto-fix`|`qa`). A new `claude-autofix-qa.yml` runs the QA-review loop (reusing C's revise flow for fixes). A new `claude-autofix-merge.yml` merges on the maintainer's approval. `claude.yml` (read-only investigate), D, E, and the release/tag path are untouched.

**Tech Stack:** GitHub Actions YAML, `anthropics/claude-code-action@v1`, `gh` CLI, Node 22 (`node:test`), the existing Claude GitHub App + `CLAUDE_CODE_OAUTH_TOKEN` + `DEV_BUILD_LABEL_TOKEN` secrets.

**Spec:** [`docs/superpowers/specs/2026-05-29-qa-review-approval-merge-design.md`](../specs/2026-05-29-qa-review-approval-merge-design.md)

---

## Flagged runtime unknown (gate-verified, fail-safe)

The QA↔revise loop only turns if QA's `@claude` findings comment triggers C's revise job and the fix-bot's push re-triggers QA — and `GITHUB_TOKEN`-authored events don't trigger workflows (so QA must comment via `claude-code-action`'s App token / a PAT). The round-count also depends on QA reliably emitting the `<!-- qa-round -->` marker on each findings comment. Both are confirmed in the end-to-end gate (Task 6). They're **fail-safe**: the hard 5-round cap bounds a mis-wired loop (it just won't advance), and the merge gate independently requires `qa-passed` + CI-green, so no loop misbehavior can cause a bad merge. (Same discipline as D's NSIS spike / E's manifest chain / C's label-token fix.)

---

## File Map

**Create:**
- `scripts/qa-pipeline.mjs` (+ `scripts/qa-pipeline.test.mjs`) — pure tested helpers: `nextQaRound`, `isMergeEligible` + a thin CLI
- `.github/workflows/claude-autofix-qa.yml` — the QA-review loop
- `.github/workflows/claude-autofix-merge.yml` — merge-on-approval

**Modify:**
- `.github/workflows/claude-autofix.yml` — `initiate` prompt (+ tests + changelog), post-step (+`qa` label), `revise` gate (`auto-fix`→`auto-fix`|`qa`)
- `.github/workflows/build.yml` — add `node --test scripts/qa-pipeline.test.mjs` to the `check` job
- `RELEASING.md` — document the `qa` label, the QA loop + 5-round cap, approve→merge (your approval only), the qa-on-own-PR auto-revise, and the labels to create

**Untouched:** `claude.yml`, D, E, release/tag path.

---

### Task 1: `qa-pipeline.mjs` — pure helpers (round-count + merge-eligibility)

**Goal:** A tested Node module exposing `nextQaRound(commentBodies)` (the round-count + cap input) and `isMergeEligible({reviewState, reviewerLogin, labels})` (the auto-merge predicate), plus a thin CLI the workflows call.

**Files:**
- Create: `scripts/qa-pipeline.mjs`, `scripts/qa-pipeline.test.mjs`
- Modify: `.github/workflows/build.yml` (run the new test in the `check` job)

**Acceptance Criteria:**
- [ ] `nextQaRound([])` → 1; `nextQaRound(['x','<!-- qa-round --> …'])` → 2; counts only bodies containing the marker
- [ ] `isMergeEligible` → true ONLY for `reviewState==='approved'` AND `reviewerLogin==='MohamedSerhan'` AND labels include both `qa` and `qa-passed` (accepts label arrays of strings OR `{name}` objects)
- [ ] false for: other reviewer, non-approved state, missing `qa`, or missing `qa-passed`
- [ ] CLI: `node scripts/qa-pipeline.mjs cap` prints `5`; `… round` reads a JSON array of comment bodies on stdin and prints the next round; `… merge-eligible` reads `$GITHUB_EVENT_PATH` and exits 0/1
- [ ] Module importable without side effects; `node --test scripts/qa-pipeline.test.mjs` passes; wired into CI `check`

**Verify:** `node --test scripts/qa-pipeline.test.mjs` → all pass

**Steps:**

- [ ] **Step 1: Write the failing tests** `scripts/qa-pipeline.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextQaRound, isMergeEligible, QA_MAX_ROUNDS, MAINTAINER_LOGIN } from './qa-pipeline.mjs';

test('QA_MAX_ROUNDS is 5; maintainer is MohamedSerhan', () => {
  assert.equal(QA_MAX_ROUNDS, 5);
  assert.equal(MAINTAINER_LOGIN, 'MohamedSerhan');
});

test('nextQaRound = (marker comments) + 1', () => {
  assert.equal(nextQaRound([]), 1);
  assert.equal(nextQaRound(['hello', 'no marker here']), 1);
  assert.equal(nextQaRound(['<!-- qa-round --> issues: ...']), 2);
  assert.equal(nextQaRound(['<!-- qa-round -->', 'chatter', '<!-- qa-round -->']), 3);
});

test('isMergeEligible true only for maintainer approval + qa + qa-passed', () => {
  assert.equal(isMergeEligible({ reviewState: 'approved', reviewerLogin: 'MohamedSerhan', labels: [{ name: 'qa' }, { name: 'qa-passed' }] }), true);
  assert.equal(isMergeEligible({ reviewState: 'approved', reviewerLogin: 'MohamedSerhan', labels: ['qa', 'qa-passed'] }), true, 'accepts string labels too');
});

test('isMergeEligible false for the disqualifying cases', () => {
  assert.equal(isMergeEligible({ reviewState: 'approved', reviewerLogin: 'someone-else', labels: ['qa', 'qa-passed'] }), false, 'other reviewer');
  assert.equal(isMergeEligible({ reviewState: 'commented', reviewerLogin: 'MohamedSerhan', labels: ['qa', 'qa-passed'] }), false, 'not approved');
  assert.equal(isMergeEligible({ reviewState: 'approved', reviewerLogin: 'MohamedSerhan', labels: ['qa-passed'] }), false, 'missing qa');
  assert.equal(isMergeEligible({ reviewState: 'approved', reviewerLogin: 'MohamedSerhan', labels: ['qa'] }), false, 'missing qa-passed');
  assert.equal(isMergeEligible({ reviewState: 'approved', reviewerLogin: 'MohamedSerhan', labels: [] }), false, 'no labels');
});
```

- [ ] **Step 2: Run, confirm failure** — `node --test scripts/qa-pipeline.test.mjs` (module missing).

- [ ] **Step 3: Implement** `scripts/qa-pipeline.mjs`:

```js
// scripts/qa-pipeline.mjs
// Pure helpers + thin CLI for the QA-review loop + approval-gated auto-merge
// (sub-project C+). Spec: docs/superpowers/specs/2026-05-29-qa-review-approval-merge-design.md
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

export const QA_ROUND_MARKER = '<!-- qa-round -->';
export const QA_MAX_ROUNDS = 5;
export const MAINTAINER_LOGIN = 'MohamedSerhan';

/** Next QA round number = (PR comments containing the round marker) + 1. */
export function nextQaRound(commentBodies) {
  const seen = (commentBodies || []).filter(
    (b) => typeof b === 'string' && b.includes(QA_ROUND_MARKER),
  ).length;
  return seen + 1;
}

/** Normalize a labels array (strings or {name}) to a string[]. */
function labelNames(labels) {
  return (labels || [])
    .map((l) => (typeof l === 'string' ? l : l && l.name))
    .filter(Boolean);
}

/** Auto-merge predicate. CI-green is NOT a pure input — it's checked at runtime by
 *  the merge workflow; this gates the human+label conditions only. */
export function isMergeEligible({ reviewState, reviewerLogin, labels }) {
  const names = labelNames(labels);
  return (
    reviewState === 'approved' &&
    reviewerLogin === MAINTAINER_LOGIN &&
    names.includes('qa') &&
    names.includes('qa-passed')
  );
}

function readStdin() {
  try { return readFileSync(0, 'utf-8'); } catch { return ''; }
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'cap') {
    console.log(QA_MAX_ROUNDS);
  } else if (cmd === 'round') {
    // stdin: a JSON array of comment bodies (or of {body} objects).
    let arr = [];
    try { arr = JSON.parse(readStdin() || '[]'); } catch { arr = []; }
    const bodies = Array.isArray(arr)
      ? arr.map((x) => (typeof x === 'string' ? x : x && x.body))
      : [];
    console.log(nextQaRound(bodies));
  } else if (cmd === 'merge-eligible') {
    // Reads the GitHub pull_request_review event JSON at $GITHUB_EVENT_PATH.
    // Exit 0 = eligible, 1 = not.
    const p = process.env.GITHUB_EVENT_PATH;
    let ev = {};
    try { ev = JSON.parse(readFileSync(p, 'utf-8')); } catch { ev = {}; }
    const ok = isMergeEligible({
      reviewState: ev?.review?.state,
      reviewerLogin: ev?.review?.user?.login,
      labels: ev?.pull_request?.labels,
    });
    console.log(ok ? 'eligible' : 'not-eligible');
    process.exit(ok ? 0 : 1);
  } else {
    console.error('usage: qa-pipeline.mjs round|cap|merge-eligible');
    process.exit(2);
  }
}
```

- [ ] **Step 4: Run tests, verify pass** — `node --test scripts/qa-pipeline.test.mjs` → all pass.

- [ ] **Step 5: Wire into CI's `check` job.** In `.github/workflows/build.yml`, after the existing `Test make-dev-icon script` step (or the last `node --test` step in the `check` job), add:

```yaml
      - name: Test qa-pipeline script
        run: node --test scripts/qa-pipeline.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add scripts/qa-pipeline.mjs scripts/qa-pipeline.test.mjs .github/workflows/build.yml
git commit -m "$(cat <<'EOF'
feat(qa): qa-pipeline.mjs — round-count + merge-eligibility helpers

Pure, tested helpers for the QA-review loop: nextQaRound (counts qa-round
markers, drives the 5-round cap) and isMergeEligible (approved + reviewer is
MohamedSerhan + qa + qa-passed). Thin CLI (round/cap/merge-eligible) for the
workflows. Wired into the check job.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Extend `claude-autofix.yml` — upfront tests+changelog, `qa` label, revise gate

**Goal:** The fix-bot's PR ships complete (fix + unit tests + changelog when user-facing) and enters the QA pipeline (`qa` label); the revise flow also serves `qa` PRs.

**Files:**
- Modify: `.github/workflows/claude-autofix.yml`

**Acceptance Criteria:**
- [ ] The `initiate` prompt instructs Claude to also write unit tests covering the fix, and to add ONE player-language `[Unreleased]` CHANGELOG bullet ONLY if the change is user-facing (obeying the CHANGELOG writing rules)
- [ ] The `initiate` post-step applies `qa` in addition to `dev-build` + `auto-fix`
- [ ] The `revise` job `if:` triggers on `@claude` comments on PRs labeled `auto-fix` **OR** `qa` (both `issue_comment` and `pull_request_review_comment` shapes)
- [ ] `claude-autofix.yml` parses as valid YAML; the actor-auth steps + structure are otherwise unchanged

**Verify:** `python -c "import yaml; yaml.safe_load(open('.github/workflows/claude-autofix.yml')); print('OK')"` → `OK`

**Steps:**

- [ ] **Step 1: Extend the `initiate` prompt.** Replace prompt steps 3–4 (the test + PR steps, lines ~60–66) with:

```
            3. Implement the fix AND write unit tests that cover it (follow the
               repo's test conventions — frontend: vitest; Rust: #[test]/cargo test).
               Run the relevant tests (`npm test` runs the frontend + Rust suites;
               Rust-only: `cargo test --manifest-path=src-tauri/Cargo.toml`) and iterate
               until they pass. CI also runs the full suite on the PR.
            4. If — and only if — the change is user-facing, add ONE concise, player-
               language bullet to the `[Unreleased]` section of CHANGELOG.md under the
               right heading (Added/Changed/Fixed/Security), following the CHANGELOG
               "Writing rules" (no file paths, function names, or dev-speak; one short
               active-voice sentence). Skip the changelog for internal-only changes.
            5. Open a pull request targeting `main` whose body STARTS with
               `Fixes #${{ github.event.issue.number }}`, summarizes the change, notes
               whether you added a changelog entry, and explains how to test it via the
               dev build. Do NOT apply any labels — a workflow step applies them after.
```

(The "branch named EXACTLY `auto-fix/<N>`" step 2 and the "if you cannot fix, comment instead" closing line stay unchanged.)

- [ ] **Step 2: Add `qa` to the post-step label set.** In the "Apply … labels" step, change the `gh pr edit` line:

```bash
          gh pr edit "$PR" --repo "$REPO" --add-label dev-build --add-label auto-fix --add-label qa
          echo "Labeled PR #$PR with dev-build + auto-fix + qa."
```

(Also update that step's `name:` to `Apply dev-build + auto-fix + qa labels (PAT so build + QA trigger)`.)

- [ ] **Step 3: Widen the `revise` gate to `auto-fix` OR `qa`.** Replace the `revise` job's `if:` block (lines ~92–99) with:

```yaml
    if: >-
      ${{ ((github.event_name == 'issue_comment'
              && github.event.issue.pull_request
              && (contains(github.event.issue.labels.*.name, 'auto-fix')
                  || contains(github.event.issue.labels.*.name, 'qa'))
              && contains(github.event.comment.body, '@claude'))
           || (github.event_name == 'pull_request_review_comment'
              && (contains(github.event.pull_request.labels.*.name, 'auto-fix')
                  || contains(github.event.pull_request.labels.*.name, 'qa'))
              && contains(github.event.comment.body, '@claude'))) }}
```

- [ ] **Step 4: Validate** — `python -c "import yaml; yaml.safe_load(open('.github/workflows/claude-autofix.yml')); print('OK')"` → `OK`. Confirm the actor-auth steps + the two-job structure are otherwise unchanged.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/claude-autofix.yml
git commit -m "$(cat <<'EOF'
feat(qa): autofix PRs ship complete + enter the QA pipeline

initiate now also writes unit tests + a player-language [Unreleased] changelog
bullet (user-facing changes only), labels its PR `qa` (alongside dev-build +
auto-fix), and the revise flow now serves `auto-fix` OR `qa` PRs so QA findings
auto-revise any qa PR.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `claude-autofix-qa.yml` — the QA-review loop

**Goal:** On a `qa` PR (opened/updated), an adversarial QA-Claude audits it: pass → `qa-passed` + ping; issues → `@claude` findings (triggers revise) with a round marker; cap 5 rounds → `qa-needs-human` + concerns.

**Files:**
- Create: `.github/workflows/claude-autofix-qa.yml`

**Acceptance Criteria:**
- [ ] Triggers on `pull_request` `[opened, synchronize, labeled]`, gated to PRs labeled `qa` and NOT `qa-needs-human`
- [ ] Computes the round via `qa-pipeline.mjs round` (counting `<!-- qa-round -->` markers); when round > cap (5), posts an escalation comment, adds `qa-needs-human`, and stops without invoking the reviewer
- [ ] Otherwise runs `claude-code-action@v1` with an adversarial-QA prompt (round number injected) that either: adds `qa-passed` + pings `@MohamedSerhan`, OR posts a `<!-- qa-round -->` + `@claude` findings comment
- [ ] Permissions: `contents: read, pull-requests: write, issues: write, id-token: write`
- [ ] `claude-autofix-qa.yml` parses as valid YAML

**Verify:** `python -c "import yaml; yaml.safe_load(open('.github/workflows/claude-autofix-qa.yml')); print('OK')"` → `OK`

**Steps:**

- [ ] **Step 1: Create `.github/workflows/claude-autofix-qa.yml`:**

```yaml
name: Claude auto-fix QA

# The QA-review loop for `qa`-labeled PRs (bot or human-authored). An adversarial
# QA-Claude audits the PR; on issues it posts `@claude <findings>` (which triggers
# the revise flow in claude-autofix.yml), looping until it passes or hits the
# 5-round cap (then it escalates to the maintainer). See the spec.
on:
  pull_request:
    types: [opened, synchronize, labeled]

jobs:
  qa:
    if: >-
      ${{ contains(github.event.pull_request.labels.*.name, 'qa')
          && !contains(github.event.pull_request.labels.*.name, 'qa-needs-human') }}
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
      id-token: write
    env:
      GH_TOKEN: ${{ secrets.DEV_BUILD_LABEL_TOKEN || secrets.GITHUB_TOKEN }}
      REPO: ${{ github.repository }}
      PR: ${{ github.event.pull_request.number }}
    steps:
      - name: Checkout
        uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - name: Setup Node
        uses: actions/setup-node@v5
        with:
          node-version: "22"
      - name: Compute QA round + enforce the cap
        id: round
        run: |
          BODIES=$(gh api "repos/${REPO}/issues/${PR}/comments" --paginate --jq '[.[].body]')
          ROUND=$(printf '%s' "$BODIES" | node scripts/qa-pipeline.mjs round)
          CAP=$(node scripts/qa-pipeline.mjs cap)
          echo "round=$ROUND" >> "$GITHUB_OUTPUT"
          echo "cap=$CAP" >> "$GITHUB_OUTPUT"
          if [ "$ROUND" -gt "$CAP" ]; then
            echo "over_cap=true" >> "$GITHUB_OUTPUT"
          else
            echo "over_cap=false" >> "$GITHUB_OUTPUT"
          fi
      - name: Escalate to human (cap reached)
        if: ${{ steps.round.outputs.over_cap == 'true' }}
        run: |
          gh pr edit "$PR" --repo "$REPO" --add-label qa-needs-human
          gh pr comment "$PR" --repo "$REPO" --body "$(printf '%s\n' \
            "QA reached the ${{ steps.round.outputs.cap }}-round cap without converging — escalating to @MohamedSerhan." \
            "" \
            "The automated review/revise loop has stopped. The latest QA findings above remain outstanding; please take it from here.")"
      - name: Run QA review
        if: ${{ steps.round.outputs.over_cap == 'false' }}
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          claude_args: |
            --allowedTools Read,Bash
            --max-turns 40
          prompt: |
            You are an INDEPENDENT QA reviewer for pull request #${{ github.event.pull_request.number }}
            in ${{ github.repository }}. This is QA round ${{ steps.round.outputs.round }} of a maximum
            of ${{ steps.round.outputs.cap }}. The PR head branch is
            `${{ github.event.pull_request.head.ref }}`.

            Review the PR diff and the surrounding code, then audit rigorously:
            - Does the change actually fix the issue it claims? (read the linked issue + PR body)
            - Correctness and edge cases; any regressions introduced?
            - Are there unit tests covering the change, and do they pass? RUN them
              (`npm test`, or `cargo test --manifest-path=src-tauri/Cargo.toml` for Rust-only).
            - Does it follow the codebase's patterns? Any obvious security problem?
            - If the change is user-facing, is there an appropriate `[Unreleased]` CHANGELOG bullet
              (player-language, no dev-speak)?

            Then ACT (use the `gh` CLI, which is authenticated):
            - If the PR is solid and ready for the maintainer's final review: run
              `gh pr edit ${{ github.event.pull_request.number }} --repo ${{ github.repository }} --add-label qa-passed`
              and post a brief comment:
              `gh pr comment ${{ github.event.pull_request.number }} --repo ${{ github.repository }} --body "✅ QA passed (round ${{ steps.round.outputs.round }}). @MohamedSerhan ready for your final check."`
              Do NOT post `@claude`.
            - If there are REAL problems: post ONE comment that begins with the exact marker
              `<!-- qa-round -->` on its own line, then `@claude`, then a concise NUMBERED list of the
              specific problems to fix. Use:
              `gh pr comment ${{ github.event.pull_request.number }} --repo ${{ github.repository }} --body "<!-- qa-round -->
              @claude <your numbered findings>"`
              Do NOT add any label. (This triggers an automated revision.)

            Be decisive: only block on real correctness / missing-test / security issues — each round
            costs a full CI build. Do not nitpick style. Choose exactly ONE of the two actions above.
```

- [ ] **Step 2: Validate** — `python -c "import yaml; yaml.safe_load(open('.github/workflows/claude-autofix-qa.yml')); print('OK')"` → `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/claude-autofix-qa.yml
git commit -m "$(cat <<'EOF'
feat(qa): QA-review loop workflow for qa-labeled PRs

An adversarial QA-Claude audits each qa PR (round number from qa-pipeline):
pass -> qa-passed + ping the maintainer; issues -> a <!-- qa-round --> @claude
findings comment that triggers the revise flow. Caps at 5 rounds, then adds
qa-needs-human + escalates. Read/review-scoped; the revise flow does the writing.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `claude-autofix-merge.yml` — merge on the maintainer's approval

**Goal:** When `MohamedSerhan` approves a `qa` + `qa-passed` PR and CI is green, merge it. No other approval acts; never merge a not-`qa-passed` or CI-red PR.

**Files:**
- Create: `.github/workflows/claude-autofix-merge.yml`

**Acceptance Criteria:**
- [ ] Triggers on `pull_request_review` `[submitted]`; a cheap `if:` pre-filters to `approved` reviews by `MohamedSerhan`
- [ ] An authoritative gate step runs `node scripts/qa-pipeline.mjs merge-eligible` (reads the event) — proceeds only when approved + reviewer is `MohamedSerhan` + labels include `qa` AND `qa-passed`
- [ ] A CI-green check (`gh pr checks`) confirms all checks pass before merging; if not green (or not eligible) it comments why and does NOT merge
- [ ] Merges via `gh pr merge --merge` on success
- [ ] Permissions: `contents: write, pull-requests: write`; `claude-autofix-merge.yml` parses as valid YAML

**Verify:** `python -c "import yaml; yaml.safe_load(open('.github/workflows/claude-autofix-merge.yml')); print('OK')"` → `OK`

**Steps:**

- [ ] **Step 1: Create `.github/workflows/claude-autofix-merge.yml`:**

```yaml
name: Claude auto-fix merge

# Auto-merge a qa-passed PR the moment the maintainer (and only the maintainer)
# approves it AND CI is green. No other reviewer's approval does anything.
on:
  pull_request_review:
    types: [submitted]

jobs:
  merge:
    # Cheap pre-filter; the authoritative gate is the qa-pipeline step below.
    if: >-
      ${{ github.event.review.state == 'approved'
          && github.event.review.user.login == 'MohamedSerhan' }}
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    env:
      GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      REPO: ${{ github.repository }}
      PR: ${{ github.event.pull_request.number }}
    steps:
      - name: Checkout
        uses: actions/checkout@v5
        with:
          fetch-depth: 1
      - name: Setup Node
        uses: actions/setup-node@v5
        with:
          node-version: "22"
      - name: Gate — approved by maintainer + qa + qa-passed
        id: gate
        run: |
          if node scripts/qa-pipeline.mjs merge-eligible; then
            echo "eligible=true" >> "$GITHUB_OUTPUT"
          else
            echo "eligible=false" >> "$GITHUB_OUTPUT"
            gh pr comment "$PR" --repo "$REPO" --body "Approved, but not auto-merging: this PR isn't \`qa\`+\`qa-passed\` yet (QA must pass first). Holding."
          fi
      - name: Require CI green
        if: ${{ steps.gate.outputs.eligible == 'true' }}
        id: ci
        run: |
          # `gh pr checks` exits non-zero if any check is failing/pending.
          if gh pr checks "$PR" --repo "$REPO"; then
            echo "green=true" >> "$GITHUB_OUTPUT"
          else
            echo "green=false" >> "$GITHUB_OUTPUT"
            gh pr comment "$PR" --repo "$REPO" --body "Approved + QA-passed, but CI isn't green yet — holding the merge until checks pass. Re-approve (or it'll merge once green if you re-trigger)."
          fi
      - name: Merge
        if: ${{ steps.gate.outputs.eligible == 'true' && steps.ci.outputs.green == 'true' }}
        run: |
          gh pr merge "$PR" --repo "$REPO" --merge
          echo "Merged PR #$PR (maintainer-approved, qa-passed, CI green)."
```

NOTE for the implementer: confirm `gh pr checks <PR>`'s exit-code semantics on the installed `gh` (it exits non-zero when checks are pending or failing, zero when all required checks pass). If the version differs, adapt the check (e.g. `gh pr checks "$PR" --json state --jq 'all(.[]; .state=="SUCCESS" or .state=="NEUTRAL")'`). The intent: merge only when nothing is failing/pending.

- [ ] **Step 2: Validate** — `python -c "import yaml; yaml.safe_load(open('.github/workflows/claude-autofix-merge.yml')); print('OK')"` → `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/claude-autofix-merge.yml
git commit -m "$(cat <<'EOF'
feat(qa): merge-on-approval workflow (maintainer-only, qa-passed + CI green)

On a pull_request_review approval by MohamedSerhan, the authoritative
qa-pipeline merge-eligible gate (approved + maintainer + qa + qa-passed) plus a
CI-green check decide the merge. No other approval acts; a not-eligible / CI-red
PR is held with a comment, never merged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Operator runbook (RELEASING.md)

**Goal:** Document the `qa` label workflow + its one-time label setup + the safety posture.

**Files:**
- Modify: `RELEASING.md` (extend the auto-fix bot section)

**Acceptance Criteria:**
- [ ] Documents: adding `qa` to any PR (bot stamps it automatically) runs the QA-review loop; the bot revises until QA passes or hits 5 rounds (`qa-needs-human`); then you do one final check and **your approval (only yours) merges it** when CI is green
- [ ] States that a `qa` PR — including your own — will be auto-revised by the bot during the loop
- [ ] Documents creating the `qa` / `qa-passed` / `qa-needs-human` labels
- [ ] Notes releases stay manual (changelog `[Unreleased]` is prepped, not published)

**Verify:** `grep -q "qa-passed" RELEASING.md && echo OK` → `OK`

**Steps:**

- [ ] **Step 1: Extend the auto-fix section of `RELEASING.md`** with a "### QA review + approval-merge (the `qa` label)" subsection covering: (a) **Use** — "Add `qa` to any PR (the fix-bot adds it to its own). A separate QA-Claude reviews + the bot revises until it passes (or hits 5 rounds → `qa-needs-human`, handed to you). When it's `qa-passed`, do your one final check and **approve** — your approval (and only yours) merges it once CI is green. Note: a `qa` PR, including your own, gets auto-revised by the bot during the loop."; (b) **One-time setup** — create the labels:

```bash
gh label create qa --color 1d76db --description "Run the QA-review loop + enable approval-merge" --repo MohamedSerhan/sts2-mod-manager
gh label create qa-passed --color 0e8a16 --description "QA satisfied — ready for the maintainer's final check" --repo MohamedSerhan/sts2-mod-manager
gh label create qa-needs-human --color b60205 --description "QA hit the round cap — needs the maintainer" --repo MohamedSerhan/sts2-mod-manager
```

(c) **Safety** — only `MohamedSerhan`'s approval merges; `qa-passed` + CI-green required; the 5-round cap + `qa-needs-human` escalation; releases stay your manual `release.sh`.

- [ ] **Step 2: Verify + commit**

```bash
grep -q "qa-passed" RELEASING.md && echo "runbook OK"
git add RELEASING.md
git commit -m "$(cat <<'EOF'
docs(qa): runbook for the QA-review loop + approval-merge

How the `qa` label works on any PR (QA loop, 5-round cap, your-approval-only
merge, auto-revise incl. your own PRs) + the one-time qa/qa-passed/
qa-needs-human label setup + the safety posture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: End-to-end verification (USER GATE)

**Goal:** Prove the full pipeline live on a throwaway `qa` PR: QA finds issues → bot revises → QA passes → `qa-passed` + ping → your approval merges (qa-passed + CI green); and the negatives hold (others' approval no-ops; not-qa-passed/CI-red doesn't merge; the 5-round cap escalates to `qa-needs-human`).

**USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:** None (operational verification, after this is merged to `main` — the workflows trigger only from the default branch + the PR head).

**Acceptance Criteria:**
- [ ] The `qa`, `qa-passed`, `qa-needs-human` labels exist
- [ ] A throwaway `qa`-labeled PR with a deliberately-improvable change triggers the QA loop: QA posts a `<!-- qa-round -->` `@claude` findings comment → the revise flow pushes a fix → QA re-runs → eventually adds `qa-passed` + pings `@MohamedSerhan`
- [ ] Approving that PR **as MohamedSerhan** merges it (it was `qa`+`qa-passed`, CI green)
- [ ] An approval by a non-`MohamedSerhan` account does NOT merge; an approval on a not-`qa-passed` (or CI-red) PR does NOT merge (a "holding" comment is posted)
- [ ] A PR driven to the 5-round cap gets `qa-needs-human` + an escalation comment and is NOT auto-merged on approval until re-passed
- [ ] A maintainer's OWN `qa`-labeled PR gets the same loop (the bot revises it)

**Verify:** (operational) the PR shows a `<!-- qa-round -->`→revision→`qa-passed` sequence; `gh pr view <N> --json state` is MERGED only after MohamedSerhan's approval; a non-maintainer approval leaves it OPEN.

**Steps:**
- [ ] **Step 1:** After this merges to `main`, create the three labels (Task 5 command).
- [ ] **Step 2:** Open a throwaway PR with a small, real, deliberately-improvable change (e.g. a fix missing a test); label it `qa`. Watch the QA loop: confirm a findings comment + an automated revision + eventual `qa-passed` + the ping.
- [ ] **Step 3:** As `MohamedSerhan`, approve → confirm it merges (PR state MERGED). Confirm `dev-build`-cleanup removed any dev-pr build.
- [ ] **Step 4:** Negatives — on a fresh throwaway `qa` PR: confirm an approval BEFORE `qa-passed` posts the "holding" comment + doesn't merge; (if feasible) confirm a non-maintainer approval no-ops. Force a no-converge change to hit the 5-round cap → confirm `qa-needs-human` + no auto-merge.
- [ ] **Step 5:** Open your OWN small PR, label `qa` → confirm the bot reviews + auto-revises it.

No commit (verification only).

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| `qa` label, any PR (bot stamps; human adds) | Task 2 (label) + Task 3/4 (key off it) |
| Upfront fix + unit tests + changelog (if user-facing) | Task 2 (initiate prompt) |
| QA-Claude adversarial review loop, reuse revise flow | Task 3 + Task 2 (revise gate `auto-fix`\|`qa`) |
| 5-round cap → qa-needs-human escalation | Task 1 (`nextQaRound`/cap) + Task 3 |
| Merge on MohamedSerhan's approval only, + qa-passed + CI green | Task 1 (`isMergeEligible`) + Task 4 |
| Auto-revise any qa PR incl. maintainer's own | Task 2 (revise gate) + Task 6 (verified) |
| Tested helpers (round-count, merge-gate predicate) | Task 1 |
| Releases stay manual (changelog prep only) | Task 2 (prompt) + Task 5 (doc) |
| claude.yml / D / E / release path untouched | (no task touches them) |
| Same-repo only (forks fail safe) | inherent (fork PRs lack secrets) + Task 5 doc |
| End-to-end verification | Task 6 |

All spec requirements covered. No placeholders; the one runtime unknown (loop-trigger tokens + marker round-count) is flagged + gate-verified + fail-safe (cap + merge gate). Type/name consistency: `nextQaRound`/`isMergeEligible`/`QA_MAX_ROUNDS`/`MAINTAINER_LOGIN`/`QA_ROUND_MARKER` (`<!-- qa-round -->`) consistent across Task 1 ↔ Tasks 3/4; labels `qa`/`qa-passed`/`qa-needs-human` consistent across Tasks 2/3/4/5/6; the merge gate predicate (approved ∧ MohamedSerhan ∧ qa ∧ qa-passed ∧ CI-green) consistent between Task 1's `isMergeEligible` (human+label part) + Task 4's CI-green step.

---

## Acknowledgements

Plan + spec live on `claude/qa-merge` (off `main` at `c0962c1`, which has A+D+E+C). Like C, the workflows only fire from the default branch (+ the PR head), so the gate (Task 6) runs **after this merges to main**. The QA↔revise loop-trigger + round-count is the single flagged unknown, fail-safe via the 5-round cap and the independent `qa-passed`+CI-green merge gate.
