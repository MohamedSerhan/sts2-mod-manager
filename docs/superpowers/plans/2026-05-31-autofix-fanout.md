# Auto-fix Fanout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the auto-fix bot implement large multi-file issues by having the `initiate` job's orchestrator decompose the work into ≤N disjoint-scope pieces, implement them with parallel `Task` subagents, reconcile onto one branch, and open one PR through the existing QA + CI gate.

**Architecture:** Single `claude-code-action` job (Approach B). The existing STEP-0 scope gauge is kept; the CONTAINED path is byte-identical to today; only the LARGE path changes — from "post a plan and STOP" to "decompose → spawn parallel subagents → integrate → open one PR." Everything downstream (label step, QA loop, approval-merge, CI Gate) is untouched.

**Tech Stack:** GitHub Actions, `anthropics/claude-code-action@v1`, Claude Code `Task` (subagent) tool, `gh` CLI, `actionlint`/`yaml` for workflow validation.

**Spec:** `docs/superpowers/specs/2026-05-31-autofix-fanout-design.md`

**Note on merge path:** the Task-2 change to `claude-autofix.yml` must reach `main` before Task 3, because `on: issues: labeled` runs the workflow from the default branch. Since `main` requires 1 review and there is a single maintainer (who cannot self-approve), that PR lands via **maintainer admin-merge after CI Gate (`workflow-lint`) is green** — same as PR #89. This is an execution detail, surfaced here so it isn't a surprise.

---

### Task 1: Spike — confirm `claude-code-action` runs parallel `Task` subagents

**Goal:** Empirically settle the one load-bearing assumption — whether `claude-code-action` can run `Task` subagents in parallel over a shared workspace — before investing in the orchestrator prompt. The finding decides whether Task 2's prompt says "in parallel" or "one at a time."

**Files:**
- Create (throwaway, on a scratch branch only — never merged): `.github/workflows/_fanout-spike.yml`

**Acceptance Criteria:**
- [ ] The spike workflow runs to completion on a scratch branch (push-triggered, no `main` involvement).
- [ ] The run log shows three `Task` subagents executed and the three files `scratch/sub-1.txt`, `scratch/sub-2.txt`, `scratch/sub-3.txt` were created with their content.
- [ ] We record the finding: did the three subagents run **in parallel** or **sequentially**? (Either outcome is acceptable — it only tunes Task 2's wording. Total failure of the `Task` tool is the only blocking result.)
- [ ] The scratch branch + workflow are deleted afterward (no residue on the repo).

**Verify:** `gh run list --branch autofix-fanout-spike --workflow=_fanout-spike.yml` shows one `completed/success` run whose logs contain the three subagent reports + file contents.

**Steps:**

- [ ] **Step 1: Create the spike workflow on a scratch branch**

Create a branch `autofix-fanout-spike` off `main`, and add `.github/workflows/_fanout-spike.yml` with this exact content:

```yaml
name: _fanout-spike
# THROWAWAY capability spike — delete after observing. Push-triggered on the
# scratch branch so it needs no presence on the default branch.
on:
  push:
    branches: [autofix-fanout-spike]
jobs:
  spike:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      id-token: write
    steps:
      - uses: actions/checkout@v5
      - name: Spike — parallel Task subagents over a shared workspace
        uses: anthropics/claude-code-action@v1
        with:
          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}
          claude_args: |
            --allowedTools Read,Write,Task
            --max-turns 20
          prompt: |
            This is a capability spike. Do EXACTLY this and nothing else.

            Use the Task tool to spawn THREE subagents IN PARALLEL (issue all three
            Task calls in a SINGLE message). Instruct each subagent to create exactly
            one file and then stop:
              - subagent 1 → write `scratch/sub-1.txt`
              - subagent 2 → write `scratch/sub-2.txt`
              - subagent 3 → write `scratch/sub-3.txt`
            Each file must contain its subagent number and a one-line note.

            After they return, report: (a) did all three subagents run, (b) were they
            invoked in parallel or sequentially, (c) the contents of the three files.

            Do NOT commit, push, open a PR, or touch any file outside `scratch/`.
```

- [ ] **Step 2: Push the branch to trigger the run**

```bash
git push -u origin autofix-fanout-spike
```

- [ ] **Step 3: Watch the run and read the logs**

```bash
RID=$(gh run list --branch autofix-fanout-spike --workflow=_fanout-spike.yml --limit 1 --json databaseId --jq '.[0].databaseId')
gh run watch "$RID" --exit-status
gh run view "$RID" --log | grep -iE 'sub-[123]|subagent|parallel'
```
Expected: evidence that three subagents ran and the three files were produced. Note whether the action invoked them in parallel or serialized them.

- [ ] **Step 4: Record the finding**

Write one line into the plan's Task-2 notes (below) stating the observed behavior, e.g. *"Spike: parallel Task subagents confirmed"* or *"Spike: Task subagents run sequentially — Task 2 prompt says 'one at a time, each its own context'."*

- [ ] **Step 5: Tear down the scratch branch (no residue)**

```bash
git push origin --delete autofix-fanout-spike
git branch -D autofix-fanout-spike   # if a local copy exists
```

---

### Task 2: Implement fanout in `claude-autofix.yml` `initiate`

**Goal:** Replace the LARGE branch's "post a plan and STOP" with the decompose → parallel-subagents → integrate → one-PR flow; enable the `Task` tool; bump the orchestrator turn budget; add the `N` cap knob. The CONTAINED path is left byte-identical.

**Files:**
- Modify: `.github/workflows/claude-autofix.yml` (the `initiate` job only — `claude_args`, the prompt's LARGE branch, and a new job-level `env`)
- Modify: `RELEASING.md` (one short subsection documenting fanout behavior for the operator runbook)

**Acceptance Criteria:**
- [ ] `initiate` job gains `env: FANOUT_MAX_PIECES: "5"` (the tunable cap).
- [ ] `claude_args` `--allowedTools` includes `Task` (becomes `Edit,Read,Write,Bash,Task`).
- [ ] `claude_args` `--max-turns` is raised from `60` to `100` (orchestrator now also coordinates + integrates).
- [ ] The prompt's LARGE branch instructs: decompose into ≤ `${{ env.FANOUT_MAX_PIECES }}` disjoint-scope pieces, post the plan, create `auto-fix/<issue>`, spawn one subagent per piece via `Task` (parallel/sequential per the Task-1 finding), run an integration pass over the glue files, run `npm test` to green, open ONE PR; with the retry/never-silently-drop and "too tangled → fall back to plan + STOP" rules.
- [ ] The CONTAINED branch, the label step, the error-report step, and the `revise` job are unchanged.
- [ ] `RELEASING.md` has a short "Auto-fix fanout" note explaining that large issues now fan out into one integrated PR and still require maintainer approval to merge.

**Verify:** `python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/claude-autofix.yml')); print('YAML OK')"` prints `YAML OK`, and `actionlint .github/workflows/claude-autofix.yml` (if installed locally; otherwise the CI `workflow-lint` job on the PR) reports no errors. Manual read confirms the LARGE branch fans out and the CONTAINED branch is unchanged.

**Steps:**

- [ ] **Step 1: Add the cap knob + enable `Task` + raise turns**

In the `initiate` job, add a job-level `env` (alongside `runs-on`/`permissions`):

```yaml
    env:
      FANOUT_MAX_PIECES: "5"   # max parallel sub-task pieces for a LARGE issue
```

In the "Run Claude (implement fix + open PR)" step, change `claude_args` from:

```yaml
          claude_args: |
            --allowedTools Edit,Read,Write,Bash
            --max-turns 60
```
to:
```yaml
          claude_args: |
            --allowedTools Edit,Read,Write,Bash,Task
            --max-turns 100
```

- [ ] **Step 2: Replace the LARGE branch of the prompt**

Find the bullet beginning `• If it is LARGE:` and replace that entire bullet (down to `Then STOP — do not open a PR. You are done.`) with:

```text
            • If it is LARGE — do NOT try to implement it all in this one context
              (you will run out of turns). Instead, FAN OUT:

              1. Decompose the work into AT MOST ${{ env.FANOUT_MAX_PIECES }}
                 INDEPENDENT pieces, each owning a DISJOINT set of files (ideally its
                 own new modules + tests). Never assign the same file to two pieces.
                 Reserve shared "glue" files (a router, a types file, an index /
                 registry, settings wiring) for YOURSELF — no piece may edit them.
                 If the work will not partition into <= ${{ env.FANOUT_MAX_PIECES }}
                 disjoint pieces, take the most independent pieces up to that cap and
                 record the rest as remaining work.
              2. Post ONE issue comment with the plan: each piece, its file scope, and
                 the glue you will wire yourself.
              3. Create the branch `auto-fix/${{ github.event.issue.number }}` off the
                 default branch (this EXACT name — a later step finds the PR by it).
              4. Spawn one subagent per piece using the Task tool. Give each subagent
                 EXACTLY its piece: the goal, its disjoint file scope, and "implement
                 it AND write tests (frontend: vitest; Rust: cargo test), touch nothing
                 outside your files, and report what you changed." Each subagent has its
                 own context + turn budget — that is how this fits where one linear pass
                 would not.
              5. INTEGRATION PASS (you, after every subagent returns): edit the glue
                 files to wire the pieces together, then run the full suite (`npm test`
                 runs frontend + Rust) and fix any integration breakage until it passes.
              6. Open ONE pull request on `auto-fix/${{ github.event.issue.number }}`
                 exactly as the contained path would: the body STARTS with
                 `Fixes #${{ github.event.issue.number }}`, summarizes each piece, notes
                 whether you added a changelog entry, and — if any piece was blocked or
                 deferred — includes a "Remaining work" checklist. Do NOT apply labels.

              If a subagent fails or returns incomplete, retry it once or finish that
              piece yourself — never silently drop a piece. If the work is genuinely too
              tangled to split into disjoint pieces safely, fall back to the old
              behavior: post the plan as an issue comment and STOP (no PR).
```

(If the Task-1 spike found subagents run sequentially, change "Spawn one subagent per piece" in point 4 to "Implement the pieces one subagent at a time" — capability is unchanged, only wording.)

- [ ] **Step 3: Validate the YAML locally**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/claude-autofix.yml')); print('YAML OK')"
```
Expected: `YAML OK`. If `actionlint` is available: `actionlint .github/workflows/claude-autofix.yml` → no output.

- [ ] **Step 4: Add the RELEASING.md note**

Under the auto-fix section of `RELEASING.md`, add:

```markdown
### Auto-fix fanout (large issues)

When an `auto-fix` issue is too large for a single pass, the bot fans out: it
decomposes the work into up to `FANOUT_MAX_PIECES` (default 5) independent pieces,
implements them with parallel subagents, reconciles them onto `auto-fix/<issue>`,
and opens ONE integrated PR. That PR goes through the same `qa` → your approval →
CI Gate → merge path as any other auto-fix PR — nothing merges or releases without
your approval. Tune the cap via the `FANOUT_MAX_PIECES` env in `claude-autofix.yml`.
```

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/claude-autofix.yml RELEASING.md
git commit -m "feat(auto-fix): fan out large issues into parallel subagents + one PR"
```

- [ ] **Step 6: Land it on `main`** (prerequisite for Task 3)

Open a PR, let CI `workflow-lint` go green, then the maintainer admin-merges it (single-maintainer self-approval exception, post-CI-green — same as #89). Task 3 cannot run until this is on `main`.

---

### Task 3: End-to-end validation on a real large issue (USER GATE)

**Goal:** Prove the whole fanout path works on a genuinely large issue: auto-detect → fan out into multiple pieces → one integrated PR → QA loop → maintainer approval → CI Gate → merge, with no release to users.

> **USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:** none (operational validation against the live workflow).

**Acceptance Criteria:**
- [ ] A genuinely large issue exists and is labeled `auto-fix` (candidate: the configurable Nexus download-folder feature behind #55 — settings field + persistence + UI + the file-watcher + tests).
- [ ] The `initiate` run **fanned out** — observable in the issue comment (the posted piece plan) and the run log (multiple `Task` subagents), not a single-pass implementation.
- [ ] Exactly **one** PR opened on `auto-fix/<issue>`, integrating the pieces, with the full test suite green.
- [ ] The PR went through the existing gate: `qa` label applied → QA loop → maintainer approval → CI Gate green → merged.
- [ ] **No release to users:** the latest GitHub release tag is unchanged after the merge.

**Verify:** `gh pr view <pr> --json state,mergedAt` shows `MERGED`; the issue shows the fan-out plan comment + multiple subagents in the run log; `gh release view --json tagName` is unchanged from before the run.

**Steps:**

- [ ] **Step 1: Prepare a large issue**

Identify or open a large `auto-fix` issue. The configurable download-folder feature is the recommended candidate; otherwise pick any real issue that clearly spans several files/modules. Apply the `auto-fix` label.

- [ ] **Step 2: Observe the fan-out**

Watch the `initiate` run. Confirm (a) the issue gets a piece-plan comment, (b) the run log shows multiple `Task` subagents, (c) one PR opens on `auto-fix/<issue>` with the suite green.

```bash
gh run list --workflow=claude-autofix.yml --limit 1
gh pr list --head "auto-fix/<issue>" --json number,title
```

- [ ] **Step 3: Drive it through the gate**

Let the `qa` QA loop run; once `qa-passed` + CI Gate green, approve the PR; confirm the merge workflow merges it.

- [ ] **Step 4: Confirm no release + capture evidence**

```bash
gh release view --json tagName --jq '.tagName'   # unchanged from before
gh pr view <pr> --json state,mergedAt
```
Capture, in the close, evidence from BOTH axes: that the run **fanned out** (subagents / pieces) AND that it **merged with no release**.

---

## Self-Review

- **Spec coverage:** orchestration flow → Task 2; decomposition/isolation/reconciliation → Task 2 prompt; bounds (N) → Task 2 `FANOUT_MAX_PIECES`; failure handling → Task 2 prompt rules; reuse-vs-change → Task 2 (only `initiate` touched); validation (spike + e2e) → Tasks 1 + 3; no-release safety → Task 3 AC. All spec sections map to a task.
- **Placeholder scan:** no TBD/TODO; the spike YAML and the LARGE prompt block are given in full; the only intentional variability (parallel vs sequential wording) is conditioned on the Task-1 finding with both wordings supplied.
- **Type/identifier consistency:** `FANOUT_MAX_PIECES`, branch name `auto-fix/<issue>`, and `npm test` are used consistently across tasks and match the existing workflow's conventions.
