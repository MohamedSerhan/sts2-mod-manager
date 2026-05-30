# QA-review loop + approval-gated auto-merge (sub-project C+) — Design

**Status:** Approved (brainstorm 2026-05-29)
**Extends:** sub-project C (auto-fix bot) — shipped on `main`. Reuses C's `claude-autofix.yml` revise flow + the `DEV_BUILD_LABEL_TOKEN` PAT, and ties into D (dev builds) + E (switcher).

## Goal

Add a **`qa` label** (any PR, bot- or human-authored) that runs the bot's work through an automated **QA-Claude review loop until it's solid**, then **auto-merges on the maintainer's approval only** — so the maintainer does a single final check instead of constant back-and-forth. A `qa` PR is built complete (fix + unit tests + changelog when user-facing), QA-audited + revised until it passes (capped at 5 rounds, else escalated), and merged the moment `MohamedSerhan` approves it (and only then).

## Why label-driven on any PR

The existing labels are already author-agnostic: `dev-build` builds *any* PR, and the `@claude`-revise flow works on *any* `auto-fix`-labeled PR (neither checks the PR author). Only the new QA-loop + auto-merge piece needs an opt-in, so it's designed the same way: a `qa` label opts **any** PR in. The fix-bot stamps `qa` on its own PRs automatically; the maintainer adds `qa` to their own PRs to get the QA pass + single-final-check + auto-merge.

## Label model (after this change)

| Label | Level | Meaning | Applied by |
|---|---|---|---|
| `auto-fix` | issue | "bot, implement a fix + open a PR" (C, unchanged) | maintainer |
| `dev-build` | PR | build a `dev-pr<N>` dev build (D, unchanged) | bot / maintainer / Dependabot |
| **`qa`** | PR | **run the QA-review loop + enable approval-merge** (new) | bot (auto, on its fix PRs) / maintainer (on own PRs) |
| `qa-passed` | PR | QA is satisfied — ready for the maintainer's final check (new, bot-managed) | QA workflow |
| `qa-needs-human` | PR | QA hit the 5-round cap without converging — needs the maintainer (new, bot-managed) | QA workflow |

## Decisions (from brainstorm)

1. **Upfront-complete PR** — the fix-bot includes the fix **+ unit tests + a player-language `[Unreleased]` CHANGELOG bullet (only if user-facing)**. What the maintainer eventually approves is the whole change; nothing mutates after approval. "Release notes" = changelog prep, **never** cutting a release (`scripts/release.sh` stays manual).
2. **QA-Claude is a separate adversarial reviewer**; its findings drive the *existing* revise flow (DRY).
3. **Loop cap = 5 rounds**, then escalate to the maintainer (post outstanding concerns, `qa-needs-human`, do not merge).
4. **Merge is gated strictly on `MohamedSerhan`'s approval** — no other reviewer's approval does anything (`main` has no required-reviews protection, so the workflow enforces this, not GitHub).
5. **Auto-revise applies to any `qa` PR, including the maintainer's own hand-written PRs** — that's the point (it minimizes back-and-forth). Opting a PR into `qa` = consent for the bot to revise that branch until QA passes.

## Architecture

Three changes, all extending C; `claude.yml` (read-only investigate) stays untouched.

### 1. Upfront tests + changelog + `qa` label (extend C's `initiate` job)

`claude-autofix.yml`'s `initiate` prompt gains: write **unit tests covering the fix**, and — *only if the change is user-facing* — add one player-language bullet to CHANGELOG.md's `[Unreleased]` section (Added/Changed/Fixed/Security), obeying the CHANGELOG "writing rules" (no file paths / function names / dev-speak; one short active-voice sentence). The PAT label post-step now applies **`dev-build` + `auto-fix` + `qa`** (was `dev-build` + `auto-fix`) so the bot's PR enters the QA pipeline automatically.

### 2. QA-review loop (new `claude-autofix-qa.yml`)

- **Trigger:** `pull_request` `types: [opened, synchronize, labeled]`, gated to PRs carrying `qa` (and not `qa-needs-human`).
- **Reviewer:** a `claude-code-action@v1` invocation with a distinct **adversarial-QA prompt** — review the diff + surrounding code and audit: does it actually fix the referenced issue? correctness + edge cases, no regressions, **unit tests present + adequate + passing**, follows codebase patterns, no obvious security problem. It runs the tests. (Review-scoped: it comments + labels; it does NOT implement — the revise flow does.)
- **Round tracking:** count existing `<!-- qa-round:N -->` marker comments on the PR; this run is round `N+1`.
- **Verdict:**
  - **Pass** → post a `<!-- qa-round:N --> ✅ QA passed` summary, add the `qa-passed` label, and ping the maintainer ("ready for your final check").
  - **Issues + round ≤ 5** → post `<!-- qa-round:N -->` + `@claude <concrete, actionable findings>`. That `@claude` comment fires C's **existing revise flow** (gate extended — see #4) → the fix-bot revises the branch + pushes → the push (`synchronize`) re-triggers this QA workflow → round `N+1`.
  - **Issues + round = 5** → post the outstanding concerns, add `qa-needs-human`, and **stop** (no further `@claude`, no merge). The maintainer takes it from there.
- Idempotency/safety: never adds `qa-passed` while issues remain; the `labeled`-event run ignores its own `qa-passed`/`qa-needs-human` label adds.

### 3. Revise-flow gate extension (edit C's `revise` job)

The existing `revise` job (in `claude-autofix.yml`) gates `@claude` comments on the PR label `auto-fix`. **Extend it to `auto-fix` OR `qa`** so QA's findings auto-revise any `qa` PR — including the maintainer's own (per decision 5). Actor authorization (write/admin/maintain) is unchanged; the QA workflow posts as the App/PAT identity, which passes.

### 4. Merge-on-approval (new `claude-autofix-merge.yml`)

- **Trigger:** `pull_request_review` `types: [submitted]`.
- **Gate (`if`):** `github.event.review.state == 'approved'` **AND** `github.event.review.user.login == 'MohamedSerhan'` **AND** the PR carries `qa` + `qa-passed`. (No other login's approval matches — "only my approval merges.")
- **Pre-merge check:** confirm CI is green (the latest commit's check-runs/statuses all succeeded; `main` enforces nothing, so the workflow checks via `gh pr checks` / the commit status API). If approved-but-not-green or not-`qa-passed`, post a comment explaining why it's holding and **do not merge**.
- **Merge:** `gh pr merge --merge` (merge commit, matching the project's convention). Merging closes the PR → D's `dev-build-cleanup` deletes its `dev-pr<N>`. The fix (with its tests + changelog) lands on `main`.

## Data flow

```
[bot] auto-fix issue ──► fix PR: fix + tests + changelog, labels dev-build+auto-fix+qa
[human] own PR + `qa` label  ───────────────────────────────────────────┐
                                                                          ▼
                                          QA-review loop (claude-autofix-qa)
                                          review+audit+run tests ── issues? ──► @claude findings
                                             ▲                                      │
                                             │                              revise flow (qa|auto-fix)
                                             │                              fix-bot edits branch, pushes
                                             └────── re-review (round≤5) ◄───────────┘
                                                 │ pass                 │ round 5, unresolved
                                                 ▼                      ▼
                                          qa-passed + ping        qa-needs-human + concerns (stop)
                                                 ▼
                                   maintainer FINAL CHECK → approve (MohamedSerhan)
                                                 ▼
                          merge-on-approval: qa-passed ∧ CI green ∧ approver==MohamedSerhan → merge
```

## Safety / guardrails

- **Auto-merge to `main` is the serious escalation** — gated by FOUR conditions, all required: approver is `MohamedSerhan`, PR is `qa` + `qa-passed`, CI is green. Approval by anyone else, or on a non-qa-passed / red PR, does **not** merge (it comments why).
- **QA loop is bounded** (5 rounds) and **fails safe** — a non-converging PR is escalated to the human, never merged automatically and never loops forever.
- **QA is read/review-scoped**; only the revise flow writes, and only via the App/PAT identity with the actor-auth gate.
- **`auto-revise on `qa` PRs is opt-in** (the `qa` label) and explicit in the runbook — a human who doesn't want the bot touching their branch simply doesn't add `qa` (their PR still builds via `dev-build` and can be revised on-demand via `@claude`, as today).
- It's still **AI reviewing AI** — QA-Claude is independent context but not a substitute for the human gate. The maintainer's final check + approval remains the real gate; QA just minimizes the round-trips to reach it.

## Integration risk to verify at the gate

The QA↔revise loop only turns if QA's `@claude` comment triggers the revise job **and** the fix-bot's push triggers the QA workflow — and `GITHUB_TOKEN`-authored events do **not** trigger workflows. So QA must comment via a triggering identity (the Claude App token, or `DEV_BUILD_LABEL_TOKEN`), and the fix-bot's pushes (via `claude-code-action`'s App token) must trigger `synchronize`. Same token-recursion family as the already-proven `dev-build` label trigger. The 5-round cap means a mis-wired loop fails cheaply (it just won't advance), and the merge gate independently requires `qa-passed`, so a broken loop can't cause a bad merge. Confirmed in the end-to-end gate.

## Testing strategy

- **Pure helpers (unit-tested where extractable):** round-count from `<!-- qa-round:N -->` markers; the merge-gate predicate (`approved ∧ user==MohamedSerhan ∧ has(qa) ∧ has(qa-passed) ∧ ci_green`).
- **Static:** all workflow YAML parses; the revise-gate `if` covers `auto-fix` OR `qa`.
- **Manual end-to-end (USER GATE — non-skippable):** a throwaway `qa` PR with a deliberately-improvable change → QA finds issues → fix-bot revises (≥1 round) → QA passes → `qa-passed` + ping → maintainer approves → it merges (qa-passed + CI green). Plus negatives: a non-`MohamedSerhan` approval does NOT merge; an approval on a not-`qa-passed` (or CI-red) PR does NOT merge (comments why); a PR pushed to the 5-round cap gets `qa-needs-human` and is NOT merged on approval until re-passed. Also confirm a maintainer's OWN `qa` PR gets the same loop (the bot revises it).

## Non-goals

- No cutting/publishing of releases (changelog `[Unreleased]` prep only; `release.sh` stays manual).
- No auto-merge without `MohamedSerhan`'s approval; no bypass of the qa-passed / CI-green gates.
- No change to `claude.yml` (read-only investigate), to D/E, or to the release/tag path.
- No QA loop on PRs lacking the `qa` label (they behave exactly as today).
- **Same-repo PRs only.** Fork PRs run with a read-only token and no secret access, so the loop (revise/comment) + merge can't function on them — they fail safe (nothing happens). The maintainer's own PRs are same-repo, so fully supported; the bot's PRs are same-repo branches.

## File map (for the plan)

**Create:**
- `.github/workflows/claude-autofix-qa.yml` — the QA-review loop (review → pass/label+ping, or `@claude` findings + round-count, 5-cap escalate)
- `.github/workflows/claude-autofix-merge.yml` — merge-on-approval (gated: MohamedSerhan + qa + qa-passed + CI green)

**Modify:**
- `.github/workflows/claude-autofix.yml` — `initiate` prompt: add unit tests + changelog (if user-facing); post-step also applies `qa`; `revise` gate: `auto-fix` → `auto-fix` OR `qa`
- `RELEASING.md` — document the `qa` label (any PR), the QA loop + 5-round cap, the approve→merge (your approval only), and the `qa`-on-own-PR auto-revise behavior + the `qa`/`qa-passed`/`qa-needs-human` labels to create
