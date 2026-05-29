# Auto-fix bot (sub-project C) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Opt-in automated fixes: labeling a triaged issue `auto-fix` makes the Claude bot implement a fix + open a `dev-build`-labeled PR, and `@claude <feedback>` on that PR makes it revise — giving the label → dev-build → test → revise → merge loop (never auto-merged); plus Dependabot's own security PRs auto-labeled `dev-build`.

**Architecture:** A new write-scoped workflow `.github/workflows/claude-autofix.yml` using `anthropics/claude-code-action@v1` (same action/token/GitHub-App as the live read-only investigate flow in `claude.yml`, which stays untouched). Two entry points share one `on:` block: a label-triggered "initiate fix" job and a `@claude`-comment-triggered "revise" job scoped to `auto-fix`-labeled PRs. Dependabot config + an auto-label workflow route dependency PRs through D's `dev-build` pipeline.

**Tech Stack:** GitHub Actions YAML, `anthropics/claude-code-action@v1`, `gh` CLI, Dependabot, the existing Claude GitHub App + `CLAUDE_CODE_OAUTH_TOKEN` secret.

**Spec:** [`docs/superpowers/specs/2026-05-29-auto-fix-bot-design.md`](../specs/2026-05-29-auto-fix-bot-design.md)

---

## File Map

**Create:**
- `.github/workflows/claude-autofix.yml` — initiate-fix (label) + revise (comment) entry points, write-scoped
- `.github/dependabot.yml` — npm (root) + cargo (`/src-tauri`) security + version updates
- `.github/workflows/dependabot-label.yml` — auto-label Dependabot PRs `dev-build`

**Modify:**
- `RELEASING.md` — operator runbook: the `auto-fix` label workflow, creating the label, the Dependabot repo-setting toggle, the label-token requirement

**Untouched:** `.github/workflows/claude.yml` (investigate flow stays `contents: read`), build.yml/D, E, the release path.

---

## Action-interface note (read before Task 1)

`claude-code-action@v1` inputs used here (confirmed from the action's `docs/usage.md`): `claude_code_oauth_token`, `prompt` (automation instructions), `label_trigger` (run when a given label is added), `trigger_phrase` (default `@claude`), `claude_args` (passes `--allowedTools`, `--max-turns`, `--model`, etc.). The action runs Claude with `git` + `gh` available and authenticated as the Claude GitHub App, so the `prompt` can instruct it to commit, push, open a PR, and apply labels. **The implementer MUST confirm these input names + behavior against the live `anthropics/claude-code-action@v1` README/`docs/usage.md` before finalizing each workflow** (the action's interface is external and may have shifted) — adjust input names if they differ; the *intent* (label-triggered implement+PR; comment-triggered revise) is fixed. The exact PR-creation + label-application behavior is proven in the Task 4 gate (this is the documented "automation" capability; the gate is where the live end-to-end is confirmed, mirroring D's NSIS spike + E's manifest chain).

---

### Task 1: `claude-autofix.yml` — initiate-fix + revise entry points

**Goal:** A write-scoped workflow where the `auto-fix` label on an issue makes Claude implement a fix + open a `dev-build`+`auto-fix` PR, and `@claude` on an `auto-fix`-labeled PR makes Claude revise that PR's branch.

**Files:**
- Create: `.github/workflows/claude-autofix.yml`

**Acceptance Criteria:**
- [ ] `on:` covers `issues: [labeled]`, `issue_comment: [created]`, `pull_request_review_comment: [created]`
- [ ] An `initiate` job runs only when the added label is `auto-fix`, with `permissions: contents: write, pull-requests: write, issues: write, id-token: write`, invoking `claude-code-action@v1` with a prompt that implements the fix, runs tests, opens a PR (`Fixes #N`), and applies labels `dev-build` + `auto-fix`
- [ ] A `revise` job runs only on `@claude` comments on a PR carrying the `auto-fix` label (both `issue_comment` on a PR and `pull_request_review_comment`), with the same write permissions, pushing a revision to the PR branch
- [ ] Neither job touches `claude.yml`'s behavior; the investigate flow stays read-only
- [ ] `claude-autofix.yml` parses as valid YAML
- [ ] Action input names confirmed against `claude-code-action@v1` docs

**Verify:** `python -c "import yaml; yaml.safe_load(open('.github/workflows/claude-autofix.yml')); print('OK')"` → `OK`

**Steps:**

- [ ] **Step 1: Confirm the action interface.** Open `https://github.com/anthropics/claude-code-action` (`docs/usage.md`) and confirm the input names `prompt`, `label_trigger`, `trigger_phrase`, `claude_args`, `claude_code_oauth_token`. If any differ in the current v1, adjust the YAML below accordingly (keep the behavior identical).

- [ ] **Step 2: Create `.github/workflows/claude-autofix.yml`:**

```yaml
name: Claude auto-fix

# Write-scoped companion to claude.yml (which stays read-only / investigate).
# Two entry points:
#   - initiate: maintainer labels an issue `auto-fix` -> implement + open a dev-build PR
#   - revise:   maintainer comments `@claude ...` on an auto-fix-labeled PR -> push a revision
# Actor authorization is enforced by claude-code-action (write/admin only).
on:
  issues:
    types: [labeled]
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

jobs:
  initiate:
    # Only when the just-added label is `auto-fix`.
    if: ${{ github.event_name == 'issues' && github.event.label.name == 'auto-fix' }}
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
    steps:
      - name: Checkout
        uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - name: Run Claude (implement fix + open PR)
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          claude_args: |
            --allowedTools Edit,Read,Write,Bash
            --max-turns 40
          prompt: |
            A maintainer labeled issue #${{ github.event.issue.number }} with `auto-fix`,
            greenlighting an automated fix. Repository: ${{ github.repository }}.

            Do the following:
            1. Read issue #${{ github.event.issue.number }} — its title, body, and any prior
               `@claude` investigation comment — to understand the bug or request.
            2. Investigate the codebase and implement a fix on a NEW branch named
               `auto-fix/${{ github.event.issue.number }}` (branch off the default branch).
            3. Run the relevant tests (`npm test` runs the frontend + Rust suites; for a
               Rust-only change `cargo test --manifest-path=src-tauri/Cargo.toml`). Iterate
               until they pass. CI will also run the full suite on the PR.
            4. Open a pull request targeting `main` whose body STARTS with
               `Fixes #${{ github.event.issue.number }}`, summarizes the change, and explains
               how to test it via the dev build.
            5. Apply the labels `dev-build` AND `auto-fix` to that PR (so it produces a dev
               build and is eligible for `@claude` revision).

            If you CANNOT produce a confident fix, do NOT open a PR — instead post a comment
            on the issue explaining precisely what blocks the fix.

  revise:
    # Only `@claude` comments on a PR that carries the `auto-fix` label.
    if: >-
      ${{ ((github.event_name == 'issue_comment'
              && github.event.issue.pull_request
              && contains(github.event.issue.labels.*.name, 'auto-fix')
              && contains(github.event.comment.body, '@claude'))
           || (github.event_name == 'pull_request_review_comment'
              && contains(github.event.pull_request.labels.*.name, 'auto-fix')
              && contains(github.event.comment.body, '@claude'))) }}
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      issues: write
      id-token: write
    steps:
      - name: Checkout
        uses: actions/checkout@v5
        with:
          fetch-depth: 0
      - name: Run Claude (revise the auto-fix PR)
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          claude_args: |
            --allowedTools Edit,Read,Write,Bash
            --max-turns 40
          # No explicit prompt: the action picks up the triggering @claude comment as the
          # instruction (tag mode). It checks out the PR branch, applies the requested change,
          # re-runs tests, and pushes to the same branch -> the dev build rebuilds.
```

- [ ] **Step 3: Validate YAML** — `python -c "import yaml; yaml.safe_load(open('.github/workflows/claude-autofix.yml')); print('OK')"` → `OK` (try `python3` if needed).

- [ ] **Step 4: Sanity-check the gating logic.** Confirm: a label other than `auto-fix` → `initiate` does not run; an `@claude` comment on a non-`auto-fix` PR (or a plain issue) → `revise` does not run (so it falls through to the read-only `claude.yml`); a label/comment from a non-maintainer → the action's actor-authorization blocks it (no workflow change needed — this is built into `claude-code-action`).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/claude-autofix.yml
git commit -m "$(cat <<'EOF'
feat(autofix): claude-autofix workflow — label-to-fix-PR + @claude revise

Write-scoped companion to the read-only investigate flow. Labeling an issue
`auto-fix` makes claude-code-action implement a fix on auto-fix/<N>, run tests,
open a PR (Fixes #N) labeled dev-build + auto-fix. `@claude` on an auto-fix
PR revises its branch. Actor-authorized; never auto-merges.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Dependabot config + auto-label workflow

**Goal:** Dependabot opens its own security/version PRs for npm + cargo, and those PRs are auto-labeled `dev-build` so they flow through D's build + E's switcher.

**Files:**
- Create: `.github/dependabot.yml`
- Create: `.github/workflows/dependabot-label.yml`

**Acceptance Criteria:**
- [ ] `dependabot.yml` configures `npm` (directory `/`) + `cargo` (directory `/src-tauri`), weekly schedule, grouped minor/patch updates
- [ ] `dependabot-label.yml` triggers on `pull_request_target: [opened]`, and when `github.actor == 'dependabot[bot]'` adds the `dev-build` label
- [ ] The label is applied with a token that triggers downstream workflows (see the label-token note); falls back gracefully if not configured
- [ ] Both files parse as valid YAML

**Verify:** `python -c "import yaml; yaml.safe_load(open('.github/dependabot.yml')); yaml.safe_load(open('.github/workflows/dependabot-label.yml')); print('OK')"` → `OK`

**Steps:**

- [ ] **Step 1: Create `.github/dependabot.yml`:**

```yaml
version: 2
updates:
  # Frontend (npm) — package.json at the repo root.
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
    groups:
      npm-minor-patch:
        update-types: ["minor", "patch"]

  # Rust (cargo) — the Tauri backend.
  - package-ecosystem: "cargo"
    directory: "/src-tauri"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
    groups:
      cargo-minor-patch:
        update-types: ["minor", "patch"]

  # Keep the GitHub Actions themselves current.
  - package-ecosystem: "github-actions"
    directory: "/"
    schedule:
      interval: "weekly"
```

(Note: this configures *version* updates + is the file Dependabot reads. **Security** updates also require the repo setting Settings → Code security → "Dependabot security updates" = enabled — an operator step documented in Task 3.)

- [ ] **Step 2: Create `.github/workflows/dependabot-label.yml`:**

```yaml
name: Label Dependabot PRs

# Auto-label Dependabot PRs `dev-build` so D builds them and E can switch to them.
# Uses pull_request_target so it has write access even for the bot's PR.
on:
  pull_request_target:
    types: [opened]

permissions:
  pull-requests: write

jobs:
  label:
    if: ${{ github.actor == 'dependabot[bot]' }}
    runs-on: ubuntu-latest
    steps:
      - name: Add dev-build label
        env:
          # Prefer a PAT (DEV_BUILD_LABEL_TOKEN) so the label event triggers the build
          # workflow; the default GITHUB_TOKEN does NOT trigger downstream workflows
          # (anti-recursion). If the secret is absent, fall back to GITHUB_TOKEN — the
          # label still applies, but you may need to re-apply it manually to start a build.
          GH_TOKEN: ${{ secrets.DEV_BUILD_LABEL_TOKEN || secrets.GITHUB_TOKEN }}
          PR: ${{ github.event.pull_request.number }}
          REPO: ${{ github.repository }}
        run: gh pr edit "$PR" --repo "$REPO" --add-label dev-build
```

- [ ] **Step 3: Validate YAML** — `python -c "import yaml; yaml.safe_load(open('.github/dependabot.yml')); yaml.safe_load(open('.github/workflows/dependabot-label.yml')); print('OK')"` → `OK`.

- [ ] **Step 4: Commit**

```bash
git add .github/dependabot.yml .github/workflows/dependabot-label.yml
git commit -m "$(cat <<'EOF'
feat(autofix): Dependabot config + auto-label dev-build

Dependabot opens npm + cargo (+ actions) version/security PRs; a small
workflow labels its PRs dev-build so they flow through the per-PR dev build +
switcher. Prefers a PAT so the label triggers the build (GITHUB_TOKEN can't).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Operator runbook (RELEASING.md)

**Goal:** Document how to drive the auto-fix bot + the one-time setup it needs (the `auto-fix` label, the Dependabot repo toggle, the label-trigger token), so the maintainer (and future sessions) can operate it.

**Files:**
- Modify: `RELEASING.md` (append an "Auto-fix bot (sub-project C)" section)

**Acceptance Criteria:**
- [ ] A new section documents: labeling an issue `auto-fix` to start a fix; commenting `@claude <feedback>` on the PR to revise; that PRs are never auto-merged (you review + merge)
- [ ] Documents the one-time setup: create the `auto-fix` label; enable "Dependabot security updates" in repo settings; the `DEV_BUILD_LABEL_TOKEN` PAT (why it's needed — GITHUB_TOKEN doesn't trigger the build — + the minimal scope)
- [ ] Notes the safety posture (opt-in, actor-authorized, tests gate, write-scoped to auto-fix flows)

**Verify:** `grep -q "auto-fix" RELEASING.md && echo OK` → `OK` (and read the section to confirm it covers the three operational points + setup)

**Steps:**

- [ ] **Step 1: Append to `RELEASING.md`** an "## Auto-fix bot (sub-project C)" section with: (a) **Use** — "Add the `auto-fix` label to a triaged issue → the bot implements a fix and opens a PR labeled `dev-build` (which builds a dev build you can switch to via Settings → Dev Builds) + `auto-fix`. To iterate, comment `@claude <what's still wrong>` on the PR — it revises the branch and the dev build rebuilds. Review + merge yourself; the bot never merges."; (b) **One-time setup** — `gh label create auto-fix --color 5319e7 --description "Have the Claude bot implement a fix + open a dev-build PR"`; enable Settings → Code security → Dependabot security updates; create a fine-grained PAT with `contents:read` + `pull-requests:write` on this repo, store as the `DEV_BUILD_LABEL_TOKEN` secret (needed because the default GITHUB_TOKEN can't trigger the build workflow when applying the `dev-build` label); (c) **Safety** — opt-in only, the action only obeys repo write/admin actors, every fix PR runs the `check` test job, write access is limited to the auto-fix flows (the `@claude` investigate flow stays read-only).

- [ ] **Step 2: Verify + commit**

```bash
grep -q "auto-fix" RELEASING.md && echo "runbook OK"
git add RELEASING.md
git commit -m "$(cat <<'EOF'
docs(autofix): operator runbook for the auto-fix bot

How to drive it (auto-fix label, @claude revise, manual merge) + one-time
setup (create the label, enable Dependabot security updates, the
DEV_BUILD_LABEL_TOKEN PAT) + the safety posture.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: End-to-end verification (USER GATE)

**Goal:** Prove the full auto-fix loop on a throwaway issue: label `auto-fix` → bot opens a `dev-build`+`auto-fix` PR that closes the issue → D builds a `dev-pr<N>` for it → `@claude` feedback revises the branch → D rebuilds → close the PR without merging → cleanup deletes the prerelease; and the read-only investigate flow + non-auto-fix PRs are unaffected.

**USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:** None (operational verification using `gh` + a throwaway issue/PR).

**Acceptance Criteria:**
- [ ] The `auto-fix` label exists in the repo + the `DEV_BUILD_LABEL_TOKEN` secret is configured (or the maintainer accepts manual re-labeling)
- [ ] Labeling a throwaway issue `auto-fix` triggers `claude-autofix` → a PR is opened that contains `Fixes #<issue>`, is labeled `dev-build` + `auto-fix`, and contains a real code change
- [ ] That PR triggers D → a `dev-pr<N>` prerelease is produced (confirms the label-token integration risk is resolved)
- [ ] Commenting `@claude <small tweak>` on the PR triggers `claude-autofix` revise → a new commit lands on the PR branch → D rebuilds the `dev-pr<N>`
- [ ] The `check` test job ran on the PR
- [ ] Closing the PR (without merging) → D cleanup deletes the `dev-pr<N>`
- [ ] An `@claude` comment on a NON-`auto-fix` PR/issue does NOT trigger a write/PR action (only the read-only investigate flow), and a label other than `auto-fix` does not trigger the bot

**Verify:** (operational) `gh pr view <N> --json labels,body` shows `dev-build`+`auto-fix` and `Fixes #<issue>`; `gh release view dev-pr<N>` lists assets while open and "not found" after close; the PR's commit list grows by one after the `@claude` revise.

**Steps:**
- [ ] **Step 1:** One-time setup — `gh label create auto-fix …`; create + store `DEV_BUILD_LABEL_TOKEN`; ensure Dependabot security updates enabled. (Coordinator + maintainer.)
- [ ] **Step 2:** Open a throwaway issue describing a small, real, low-risk bug/improvement (something the bot can plausibly fix). Label it `auto-fix`.
- [ ] **Step 3:** Watch `claude-autofix` run → confirm a PR opens with `Fixes #<issue>`, labels `dev-build`+`auto-fix`, and a real diff. Confirm D builds a `dev-pr<N>`.
- [ ] **Step 4:** Comment `@claude <a small tweak>` on the PR → confirm a revision commit lands + D rebuilds.
- [ ] **Step 5:** Confirm the `check` job ran (tests). Confirm an `@claude` comment on an unrelated issue still only investigates (read-only).
- [ ] **Step 6:** Close the PR without merging (and close the issue) → confirm D cleanup deletes the `dev-pr<N>`.

No commit (verification only).

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Initiate fix via `auto-fix` label → implement + dev-build PR | Task 1 (initiate job) |
| Revise via `@claude` on auto-fix PR | Task 1 (revise job) |
| Write access scoped to the two entry points; claude.yml untouched | Task 1 |
| Actor authorization | Task 1 (action built-in; sanity-checked) |
| Dependabot own security/version PRs, auto-labeled dev-build | Task 2 |
| Label-token integration risk (GITHUB_TOKEN can't trigger build) | Task 2 (PAT) + Task 3 (doc) + Task 4 (verify) |
| Operator runbook + one-time setup (label, repo toggle, PAT) | Task 3 |
| Never auto-merge / tests gate / opt-in | Task 1 (prompt) + Task 3 (doc) + inherent (PRs to main) |
| End-to-end verification | Task 4 |
| B dropped | (no task) |

All spec requirements covered. No placeholders — the one external unknown (exact `claude-code-action@v1` input names + PR-creation mechanics) is flagged with a confirm-against-docs step (Task 1 Step 1) and proven live in the gate, mirroring D/E's handled unknowns.

**Type/name consistency:** label names `auto-fix` + `dev-build` consistent across Tasks 1/2/3/4; branch `auto-fix/<N>`; secret `DEV_BUILD_LABEL_TOKEN` consistent across Task 2 + Task 3 + Task 4; the `revise` gate handles both `issue_comment` (PR) and `pull_request_review_comment` event shapes.

---

## Acknowledgements

Plan + spec live on `claude/auto-fix-bot` (stacked on E's `claude/build-switcher`, since C uses D+E and #60 merges after C). At the end: merge E (#60) then C. C is mostly CI/automation config — its real proof is the live end-to-end gate (Task 4), with the `claude-code-action@v1` interface + the label-token trigger as the two flagged unknowns confirmed there.
