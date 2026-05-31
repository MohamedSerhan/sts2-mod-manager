# Release Trigger + Release-Worthiness Suggester — Design

**Date:** 2026-05-31
**Status:** Approved in brainstorming — pending spec review → implementation plan
**Author:** Claude, brainstormed with @MohamedSerhan

## Summary

Three small, independent pieces that make cutting a release a guided, low-error,
one-dropdown action — and surface "this is release-worthy" right in the PR:

1. A `workflow_dispatch` **release workflow** with a patch/minor/major dropdown that
   wraps `scripts/release.sh` → bumps the version, tags, and triggers the existing
   release pipeline.
2. A **release-worthiness definition** in `RELEASING.md` (user-facing = adds a
   CHANGELOG `[Unreleased]` bullet).
3. A **release-suggester workflow** that comments on any PR adding a user-facing
   CHANGELOG entry, with a suggested bump + the exact release-trigger URL.

No auto-release: the bot only suggests + links; the maintainer clicks Run. Merging
never releases — user-facing work accumulates on `main` until the maintainer triggers
a release, which ships the whole `[Unreleased]` batch at once.

## Background

- **Releases today:** push a `v*` tag (via the manual `scripts/release.sh
  [patch|minor|major]`) → `build.yml` (`on: push: tags: ["v*"]`) runs the publish
  pipeline (`publish-updater`, `format-release`, `publish-nexus`). Nothing releases on
  merge to `main`.
- `scripts/release.sh` already: pre-flights (on `main`, clean tree, in sync with
  origin), enforces a non-empty CHANGELOG `[Unreleased]` section + a dev-speak lint,
  runs the full cross-platform QA suite, bumps the 5 version files, commits, tags
  `v<next>`, and pushes. `SKIP_QA=1` bypasses **only** the QA suite — the
  changelog/dev-speak gates still run.
- **Existing "user-facing" signal:** the CHANGELOG `[Unreleased]` bullet.
  `ci.yml`'s `changelog` job and `scripts/ci-changes.mjs` (`unreleasedBulletCount`)
  already detect it; the auto-fix bot adds one only for user-facing changes.

## Decisions (from brainstorming)

- **Release-worthy = user-facing** = the change adds a CHANGELOG `[Unreleased]`
  bullet. Internal-only (CI, build, tests, refactors, docs, chore) is not. Codified in
  `RELEASING.md`.
- **Suggest-only, never auto-release.** The bot posts a comment + link; the maintainer
  manually triggers and picks the bump.
- **Comment-centric flow** (maintainer's confirmed flow): open PR → see the comment →
  review + approve → (PR merges within seconds, CI already green) → click the URL →
  pick the bump → release.
- **A release ships the whole `[Unreleased]` batch** on `main`, not a single PR.
  Forgetting to bump is safe by design: user-facing work sits on `main` (CI-Gate
  tested) until released, then ships together with comprehensive notes.
- **Reuse `scripts/release.sh`** in the workflow (don't reinvent bump/tag logic);
  `SKIP_QA=1` (the required CI Gate already validated everything merged to `main`),
  keep the changelog/dev-speak gates.

## Non-goals (v1)

- No auto-release / no AI-triggered release of any kind.
- No pre-filling the `workflow_dispatch` dropdown via URL (GitHub can't).
- No comment on fork PRs (the read-only fork token can't comment — best-effort; fine
  for an internal pipeline).
- No periodic "you have N unreleased changes" nudge (a possible future enhancement;
  out of scope for v1).

## Component A — Release workflow (`.github/workflows/release.yml`)

- **Trigger:** `workflow_dispatch` with input `bump` (`type: choice`, options:
  `patch` / `minor` / `major`) — renders as the dropdown in the Actions "Run workflow"
  form.
- **Permissions:** `contents: write`.
- **Steps:** checkout `main` **with the PAT** (`token: ${{
  secrets.DEV_BUILD_LABEL_TOKEN }}`) so the eventual tag push is PAT-authored and
  triggers `build.yml` (a `GITHUB_TOKEN` tag push would not, by anti-recursion); set up
  Node + Rust as `release.sh` needs; run `SKIP_QA=1 scripts/release.sh "${{
  inputs.bump }}"`.
- **Result:** `release.sh` enforces the CHANGELOG `[Unreleased]` gate (refuses if there
  are no release notes), bumps the 5 version files, commits, tags `v<next>`, pushes →
  `build.yml`'s publish pipeline fires.
- **Maintainer-only** by nature (`workflow_dispatch` requires write access).
- **Why `SKIP_QA`:** everything on `main` already passed the required CI Gate
  (3-platform build + smoke + frontend/Rust tests) at merge, and the Windows smoke
  can't run on this runner anyway. The changelog/dev-speak gates (which guarantee real
  release notes) are NOT skipped.

## Component B — Release-worthiness definition (`RELEASING.md` section)

Add a "What's release-worthy" section that states, plainly:

> A change is **release-worthy** iff it is **user-facing** — i.e. it adds a
> `CHANGELOG.md` `[Unreleased]` bullet under Added / Changed / Fixed / Security.
> Internal-only changes (CI, build, tests, refactors, docs, chore) are **not**
> release-worthy and don't, on their own, warrant a release.

This is the single source of truth the release-suggester cites, and it matches the
rule the auto-fix bot's changelog step already follows.

## Component C — Release-suggester workflow (`.github/workflows/release-suggester.yml`)

- **Trigger:** `pull_request` (types: `opened`, `synchronize`, `reopened`) targeting
  `main`.
- **Permissions:** `contents: read`, `pull-requests: write` (isolated in this small
  workflow so `ci.yml` stays read-only).
- **Logic:**
  1. Detect whether the PR adds a NEW `[Unreleased]` bullet: compare
     `unreleasedBulletCount` of HEAD's `CHANGELOG.md` vs the base — reuse
     `scripts/ci-changes.mjs unreleased-count` (the same method `ci.yml`'s changelog
     job uses).
  2. If a new bullet was added (**release-worthy**):
     - Suggest a bump from the `[Unreleased]` sections: a `Removed` section or a
       `BREAKING` marker → **major**; `Added` / `Changed` → **minor**; only `Fixed` /
       `Security` → **patch**. (This adds a small helper — e.g. `ci-changes.mjs
       suggested-bump` — that reads which `### ` headings appear under `[Unreleased]`;
       the existing `unreleased-count` only counts bullets.)
     - Post-or-update ONE comment marked `<!-- release-suggester -->`:
       > 🚀 **Release-worthy** — this PR adds a user-facing change (see
       > [what's release-worthy](RELEASING.md)). Suggested bump: **\<X\>**. Once this
       > merges, ship it (plus anything else queued on `main`) → **Run the Release
       > workflow**: `https://github.com/<owner>/<repo>/actions/workflows/release.yml`
  3. If there is no new bullet (internal-only): delete the marker comment if one
     exists (so a PR that drops its changelog entry doesn't keep a stale suggestion);
     otherwise do nothing.
- Single, marker-edited comment so repeated `synchronize` events update rather than
  spam.

## Flow (end to end)

1. A PR opens (auto-fix or the maintainer's own) → release-suggester runs → if it's
   user-facing, the comment appears with the URL + a suggested bump.
2. The maintainer reviews and approves → the PR merges within seconds (CI already
   green).
3. The maintainer clicks the comment's URL → Actions "Run workflow" → picks the bump →
   Run.
4. `release.yml` runs `release.sh` → tags `v<next>` (PAT) → `build.yml` publishes the
   release (all accumulated `[Unreleased]` changes).

## Safety

- **No release without the maintainer clicking Run** on `release.yml`. No path
  auto-releases.
- A release still only ever happens on a `v*` tag push (unchanged). Merging to `main`
  never releases.
- `release.sh`'s changelog gate blocks a release with no notes; the required CI Gate
  already guarantees `main` is build/test/smoke-green.
- The release-suggester only comments — it has no release power and no privileged
  token beyond `pull-requests: write`.

## Validation

1. Open a PR that adds a user-facing `[Unreleased]` bullet → the comment appears with
   the correct suggested bump + the release URL. Open an internal-only PR (no bullet,
   or `no-changelog`) → no comment.
2. Run `release.yml` with `bump=patch` against a `main` that has an `[Unreleased]`
   entry → all 5 version files bump, a `v<next>` tag is pushed, and `build.yml`
   publishes. Against an EMPTY `[Unreleased]` → `release.sh` refuses (changelog gate).
3. Confirm no release fires from any merge — only from the manual workflow.

## Risks / open questions

- **Fork PRs:** the `pull_request` token is read-only for forks → no comment.
  Acceptable (internal pipeline; rare). `pull_request_target` would fix it but is
  security-sensitive — not worth it for a convenience comment.
- The URL lands on the Run page; GitHub can't pre-select the bump via URL. The comment
  states the suggested value so the maintainer picks it.
- `release.sh` runs in CI with `SKIP_QA=1` — it trusts the CI Gate. If someone
  admin-bypassed the CI Gate when merging, `main` could be unvalidated; the changelog
  gate still applies. Acceptable, since the CI Gate is a required check.

## Future (out of scope)

- A periodic ("weekly") "`main` has N unreleased user-facing changes — ship here"
  nudge, as a guardrail against forgetting to release.
