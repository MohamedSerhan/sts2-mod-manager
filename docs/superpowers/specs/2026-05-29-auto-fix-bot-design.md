# Auto-fix bot (sub-project C) — Design

**Status:** Approved (brainstorm 2026-05-29)
**Roadmap:** A (Nexus triage ✅) → D (per-PR dev builds ✅) → E (build switcher ✅) → **C (auto-fix bot)**. B (Nexus reply drafts) is **dropped** — auto-drafting replies to real community members risks an AI misfire that lands badly; A still surfaces comments as triaged issues so the maintainer replies in their own voice.
**Builds on:** A (reactive `@claude` flow + triaged issues), D (the `dev-build` label → per-PR build), E (the in-app switcher to test those builds).

## Goal

Let the maintainer **opt a triaged bug/issue into an automated fix**: label it `auto-fix` → the Claude bot implements a fix on a branch, opens a `dev-build`-labeled PR, and (on `@claude` feedback) revises that PR — giving the full **label → dev build → test → feedback → re-test → merge** loop. Fixes are never auto-merged; the maintainer reviews + merges. Dependency/security fixes are handled by Dependabot's own PRs (auto-labeled `dev-build`), not the Claude bot.

## What exists today (context)

- **`.github/workflows/claude.yml`** runs `anthropics/claude-code-action@v1` on `@claude` mentions in issues / issue comments / PR review comments, with **`permissions: contents: read, issues: write, pull-requests: write, id-token: write`** + `secrets.CLAUDE_CODE_OAUTH_TOKEN`. `contents: read` means it can investigate + comment but **cannot push a branch or open a PR**. This is the live investigation flow A relies on — it stays unchanged.
- **A's triage** files a GitHub issue per non-kudos Nexus item, with an `@claude` investigation prompt in the body (so investigation already runs on triage), labeled by type (`bug`, etc.).
- **D** builds any PR carrying the `dev-build` label into a `dev-pr<N>` prerelease (Win/Mac/Linux, data-isolated, `latest.json` manifest).
- **E** lets the maintainer one-click switch between `dev-pr<N>` builds from inside a dev build to test them.
- The **Claude GitHub App** is installed on the repo (required for the action); the OAuth token is a repo secret.
- **No `.github/dependabot.yml`** exists yet.

## Decisions (from brainstorm)

1. **Opt-in per issue** via an `auto-fix` label (not auto-fix-everything, not drafts-for-all). Investigation stays automatic; *fixing* is maintainer-greenlit.
2. **Revise-on-feedback:** `@claude <what's wrong>` on an auto-fix PR pushes a revision to its branch (re-triggers the dev build). Full iterate loop.
3. **Dependabot opens its own security/version PRs**, auto-labeled `dev-build`. The Claude bot stays focused on code bugs/issues.
4. **Never auto-merge.** PRs target `main` for human review + dev-build testing.
5. **Trigger = label** (visible issue state, clean separation from the read-only investigate flow), not a chat command.

## Architecture

A new **write-scoped** workflow, `.github/workflows/claude-autofix.yml`, using the same `claude-code-action@v1` + OAuth token + GitHub App. It is deliberately separate from `claude.yml` so the broad `@claude`-investigate path keeps `contents: read`; only the two narrow auto-fix entry points get `contents: write`.

### Entry point 1 — Initiate fix

- **Trigger:** `on: issues: types: [labeled]`.
- **Gate (`if`):** `github.event.label.name == 'auto-fix'`. (Actor authorization is enforced by `claude-code-action`, which only proceeds for users with write/admin permission — so a non-maintainer can't drive the bot even if they could apply a label.)
- **Permissions:** `contents: write, pull-requests: write, issues: write, id-token: write`.
- **Action prompt (explicit, since there's no `@claude` comment):** instruct Claude to: read issue #N and any prior `@claude` investigation comment; implement a fix on a new branch `auto-fix/<N>`; run the test suite (`npm test` / `cargo test`) and iterate until green; open a PR to `main` titled for the issue with body `Fixes #N` + a summary of the change and how to test it; apply labels `dev-build` **and** `auto-fix` to the PR. **If a confident fix isn't possible**, post a comment on the issue explaining the blocker and do **not** open a PR.

### Entry point 2 — Revise fix

- **Trigger:** `on: issue_comment: types: [created]` and `pull_request_review_comment: types: [created]`.
- **Gate (`if`):** comment body contains `@claude` **AND** the comment is on a PR that carries the `auto-fix` label. (This scopes write-access to bot-created fix PRs — `@claude` on an arbitrary PR/issue still routes to the read-only `claude.yml`. Plus actor authorization as above.)
- **Permissions:** `contents: write, pull-requests: write, issues: write, id-token: write`.
- **Behavior:** the action checks out the PR branch, applies the requested change, re-runs tests, and pushes to the same branch → D rebuilds the `dev-pr<N>` → maintainer re-tests via E.

### Dependabot

- Add **`.github/dependabot.yml`**: ecosystems `npm` (root) + `cargo` (`/src-tauri`), with security + version update PRs (sensible schedule, grouped where reasonable).
- Auto-label Dependabot PRs `dev-build` so they flow through D+E. Mechanism: a tiny `dependabot-label.yml` workflow on `pull_request: [opened]` that, when `github.actor == 'dependabot[bot]'`, adds the `dev-build` label — applied with a token that triggers D (see the integration risk below). (Operator note: GitHub repo setting "Dependabot security updates" must also be enabled in repo Settings → Code security; the `dependabot.yml` covers version updates + the alerts config.)

## Data flow (the C+D+E loop)

```
issue (triaged by A, investigated by @claude)
  │  maintainer adds `auto-fix` label
  ▼
claude-autofix (initiate) ── implements on auto-fix/<N>, tests, opens PR ──►  PR (labels: dev-build, auto-fix; "Fixes #N")
  │                                                                              │ dev-build label
  ▼                                                                              ▼
maintainer tests via E ◄──── E switch to dev-pr<N> ◄──── D builds dev-pr<N> ◄────┘
  │  if wrong: `@claude <feedback>` on the PR
  ▼
claude-autofix (revise) ── pushes revision to auto-fix/<N> ──► D rebuilds ──► re-test
  │  when good
  ▼
maintainer reviews + merges manually (NEVER auto-merged) ──► PR close ──► D cleanup deletes dev-pr<N>
```

## Safety / guardrails

- **Opt-in only** (label / `@claude` comment); **never auto-merge**; PRs target `main` for human review.
- **Write access is scoped** to the two auto-fix entry points (label `== auto-fix`; `@claude` on an `auto-fix`-labeled PR). The general `@claude` investigate flow (`claude.yml`) stays `contents: read`.
- **Actor authorization:** `claude-code-action` only proceeds for actors with write/admin permission — a random commenter can't trigger the bot.
- **Tests gate:** the existing `check` job runs on every fix PR; the bot also runs tests in-session before opening/updating the PR. A failing fix is visible before merge.
- **Cost is bounded** by opt-in — the maintainer chooses which issues to fix.
- **Confidence floor:** no junk PRs — if the bot can't fix confidently, it comments on the issue instead.

## Integration risk to verify at the gate

GitHub suppresses workflow triggers from events created with the default `GITHUB_TOKEN` (anti-recursion). The bot's `dev-build` label (and the Dependabot auto-label) must be applied via a token that **does** trigger workflows — the **GitHub App installation token** that `claude-code-action` uses qualifies; the default `GITHUB_TOKEN` does **not**. So the auto-fix PR's `dev-build` label should be applied by the action (App token) when it opens the PR. If a label applied this way still fails to trigger D, the fallback is a fine-grained PAT (repo secret) used solely to apply the `dev-build` label. This is verified in the end-to-end gate (mirroring D's NSIS spike + E's manifest-chain unknowns). For the Dependabot auto-label workflow, the same applies — use the App/PAT path, not `GITHUB_TOKEN`, or accept that the dev build for a Dependabot PR is triggered by a manual label.

## Testing strategy

- **Static:** `claude-autofix.yml`, `dependabot-label.yml`, and `dependabot.yml` parse as valid YAML (CI `check` job + a local parse). Any helper logic (e.g., the gating expression, or a label script) is unit-tested if non-trivial.
- **Manual end-to-end (USER GATE — non-skippable):** on a throwaway issue, label it `auto-fix` → confirm the bot opens a fix PR labeled `dev-build`+`auto-fix` that closes the issue → confirm D builds a `dev-pr<N>` for it (the label-trigger integration risk resolved) → comment `@claude <tweak>` on the PR → confirm the bot pushes a revision + D rebuilds → confirm tests run → close the PR without merging → confirm D cleanup deletes the prerelease. Also confirm the read-only `claude.yml` investigate flow is unaffected, and that a non-`auto-fix` PR does NOT get write-capable `@claude` behavior.

## Non-goals

- No auto-merge; no auto-fix without the `auto-fix` opt-in label.
- No custom Claude-API fix pipeline (reuse `claude-code-action`).
- No fixing on fork PRs (the bot works in-repo; fork PRs are out of scope).
- No changes to the read-only `claude.yml` investigate flow.
- B (Nexus reply drafts) — dropped from the roadmap.

## File map (for the plan)

**Create:**
- `.github/workflows/claude-autofix.yml` — the two write-scoped entry points (initiate + revise)
- `.github/dependabot.yml` — npm (root) + cargo (`/src-tauri`) security + version updates
- `.github/workflows/dependabot-label.yml` — auto-label Dependabot PRs `dev-build` (App/PAT token so D triggers)

**Modify:**
- `RELEASING.md` (or the operator runbook) — document the `auto-fix` label workflow, the Dependabot repo-setting toggle, and the label-token requirement
- (create the `auto-fix` label in the repo — an operator/gate step, like D's `dev-build` label)

**Untouched:** `claude.yml` (investigate flow stays read-only), build.yml/D, E, the release path.
