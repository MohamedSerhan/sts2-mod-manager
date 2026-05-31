# CI gate: change-aware required checks for autonomous-merge safety — Design

**Status:** Approved (brainstorm 2026-05-30)
**Builds on:** C+ (QA-review loop + approval-gated auto-merge), now on `main`.

## Context

C+ lets the auto-fix bot merge to `main` on the maintainer's approval when "CI is green." But today's CI is thin: `build.yml`'s `check` job runs only `tsc --noEmit` + `cargo check` + a few automation-script tests. **No CI job runs the app's own test suites (frontend vitest, `cargo test`) or builds the app on all platforms**, and there is no enforced release-notes check. So "CI green" currently means *it compiles*, not *it works* — unsafe for autonomously shipping Nexus-sourced fixes to all users.

## Goal

Every merge to `main` — the bot's auto-merge **and** the maintainer's manual merges — must pass a **required, change-aware CI gate** that exercises what actually changed: the app test suites, a 3-platform build, type/compile checks, and a release-notes (CHANGELOG) check — while skipping work the change doesn't warrant (no 3-platform build for a docs- or scripts-only PR).

## Problem: "conditional" vs "required" conflict

GitHub branch protection's *required status checks* expect a fixed-name check to report success. A path-skipped job never reports, so a *skipped* required check leaves the PR blocked forever ("Expected — Waiting for status"). We therefore cannot mark each conditional job "required."

**Solution — a single always-on gatekeeper.** One job, **`CI Gate`**, always runs, depends on every conditional check job, and computes pass/fail from their results: a job that was *correctly skipped* = N/A = pass; a job that was *relevant and failed/cancelled* = fail. Only `CI Gate` is required in branch protection. Conditionality lives inside the gate, not in branch protection.

## Architecture

### 1. Change detection (`changes` job)
A fast first job classifies the PR's changed files into boolean outputs (via a path filter such as `dorny/paths-filter`, or a `git diff --name-only` against the base run through a tiny tested classifier). Buckets:

| Output | Globs |
|---|---|
| `app` | `src/**`, `src-tauri/**` (excluding `src-tauri/target/**`), `package.json`, `package-lock.json`, `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock`, `src-tauri/tauri.conf.json` |
| `scripts` | `scripts/**` |
| `workflows` | `.github/workflows/**` |
| (docs/other) | anything not matched → no checks |

On `push` to `main` (post-merge) and `workflow_dispatch`, treat all buckets as changed (run everything — cheap insurance).

### 2. Conditional check jobs

| Job | Runs when | What it does |
|---|---|---|
| `compile` | `app` OR `scripts` OR `workflows` changed | `tsc --noEmit` + `cargo check` |
| `test-frontend` | `app` changed | `npm test` (vitest) |
| `test-rust` | `app` changed | `cargo test --manifest-path=src-tauri/Cargo.toml` |
| `app-build` | `app` changed | 3-platform Tauri bundle (windows / macOS-universal / ubuntu) — confirms it builds everywhere |
| `script-tests` | `scripts` changed | `node --test` for the automation scripts |
| `workflow-lint` | `workflows` changed | YAML parse + `actionlint` on changed workflow files |
| `changelog` | `app` changed AND PR NOT labeled `no-changelog` | assert the diff adds ≥1 line under `CHANGELOG.md`'s `[Unreleased]` section |

### 3. The gatekeeper (`CI Gate` job)
`if: always()`, `needs:` every job above. Fails if any needed job's `result` is `failure` or `cancelled`; `skipped`/`success` are acceptable. Prints a summary of what ran/why. **This is the only check branch protection requires.**

### 4. Enforcement (maintainer action)
Add `CI Gate` as a **required status check** on `main`. Changing branch protection is outside what this automation may do (safety boundary), so the runbook gives the exact `gh api`/UI steps for the maintainer to apply once.

### 5. Interaction with the auto-merge gate
`claude-autofix-merge.yml` already holds the merge until `gh pr checks` is green, so it inherits `CI Gate` automatically. Tighten its CI step to require the `CI Gate` check is specifically `SUCCESS` (not merely "nothing failing"), so an empty/vacuous check set can't read as green.

## The release-notes (changelog) check — detail
- Runs only when `app` changed and the PR is NOT labeled `no-changelog`.
- Passes iff `git diff <base>...<head> -- CHANGELOG.md` adds ≥1 content line within the `## [Unreleased]` section.
- The auto-fix bot already adds a player-language `[Unreleased]` bullet for user-facing fixes (C+ Task 2), so its user-facing PRs pass automatically. For genuinely internal app changes (refactors, internal-only or test-only changes), the author applies `no-changelog` to opt out.
- A `no-changelog` label is created one-time.

## Conditional matrix (what runs for a given PR)
- **docs / `.claude` / non-app config only** → `changes` + `CI Gate` only → fast green.
- **scripts-only** → `compile` + `script-tests`.
- **workflows-only** → `compile` + `workflow-lint`.
- **app change** → `compile` + `test-frontend` + `test-rust` + `app-build` (3 platforms) + `changelog` (unless opted out).
- **mixed** → the union.

## Cost
The expensive `app-build` (3 parallel Tauri builds, ~6–8 min) runs only on `app` changes; scripts/docs/workflow PRs stay fast. App-touching auto-fix PRs build all 3 platforms + run both suites before they can merge — the intended cost of "can't break the app for everyone." `concurrency: cancel-in-progress` avoids stacked runs on rapid pushes.

## Relationship to existing `build.yml`
`build.yml` keeps its two roles: per-PR **dev-build** delivery (`dev-build`-labeled PRs) and the **release** path (`publish-updater` / `format-release` / `publish-nexus` on `v*` tags). The gate is a **separate `ci.yml`** so the always-required `CI Gate` is isolated from release machinery. The gate's `app-build` confirms it *builds*; the dev-build's build *delivers* an installable artifact — distinct purposes. **Plan decision:** share the build steps via a composite action vs. accept a focused duplication; and whether to remove the now-redundant `check` job from `build.yml` (the gate's `compile` + `script-tests` supersede it).

## Testing / verification strategy
- **Static:** all new workflow YAML parses; `actionlint` clean.
- **Unit:** any extracted classifier / changelog-detector helper gets `node --test` coverage (pure functions: path→bucket; diff→has-`[Unreleased]`-entry).
- **Live (USER GATE — post-merge; workflows fire only from the default branch):** after this merges to `main` and `CI Gate` is set required:
  - docs-only PR → only `CI Gate` runs, fast green, merge allowed.
  - scripts-only PR → `script-tests` run, no app build.
  - app PR with a deliberately failing vitest/cargo test → `CI Gate` RED → merge blocked (auto **and** manual).
  - app PR with no changelog entry → `changelog` RED → blocked; adding `no-changelog` → green.
  - app PR that breaks one platform's build → `app-build` RED → blocked.
  - the auto-fix bot's app-touching PR runs the full gate before its approval-merge.

## Non-goals
- No runtime/E2E/smoke test that launches the app (build success + unit suites only).
- No change to the release/tag path or the dev-build delivery.
- No auto-application of branch protection (maintainer applies the required-check setting).
- No replacement of QA-Claude's review — the gate is a deterministic floor under the AI's judgment.

## File map (for the plan)
**Create:**
- `.github/workflows/ci.yml` — change detection + conditional checks + `CI Gate` gatekeeper.
- `scripts/ci-changes.mjs` (+ `.test.mjs`) — *if* a custom classifier / changelog-detector is used instead of a marketplace action (plan decides).

**Modify:**
- `.github/workflows/claude-autofix-merge.yml` — require the `CI Gate` check is `SUCCESS`.
- `RELEASING.md` — document the gate, buckets, the `no-changelog` label, and the one-time branch-protection + label setup.
- `.github/workflows/build.yml` — possibly trim the now-redundant `check` job (plan decides).
