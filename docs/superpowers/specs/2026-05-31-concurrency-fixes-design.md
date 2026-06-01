# Concurrency & duplication fixes for the auto-fix pipeline — design

**Date:** 2026-05-31
**Status:** approved (brainstorm), pending implementation

## Problem

Running several auto-fix PRs at once this session surfaced three independent
race/duplication bugs. None are in the *product* code — they're all in the
automation plumbing, on shared or race-prone surfaces:

- **A. Dev build cancelled by label churn.** `Build & Release`
  ([build.yml](../../../.github/workflows/build.yml)) uses one per-PR concurrency
  group with `cancel-in-progress: true`. When the QA bot toggles the `qa-passed`
  label, that bare `labeled` event starts a *skipped* Build run that cancels the
  real in-progress dev build — so a passing PR ends with no downloadable artifact.
- **B. CHANGELOG `[Unreleased]` is a shared-edit hotspot.** Every auto-fix PR and
  every release-prep commit edits the same `## [Unreleased]` block, so the first
  PR to merge makes the rest conflict, `main` moving (the 1.7.0 restructure)
  conflicts every open PR, and the bot resolves the conflict unreliably (it
  botched #98 into ~14 duplicated bullets + a resurrected `## [1.7.0]` heading).
- **C. One `@claude` comment fires two agents.**
  [claude.yml](../../../.github/workflows/claude.yml) (read-only investigate) and
  the revise job in
  [claude-autofix.yml](../../../.github/workflows/claude-autofix.yml) (write) both
  match `@claude` comments on auto-fix PRs, so two agents spin up for one comment.

## Goals

- Concurrent auto-fix PRs never conflict on the changelog.
- A passing PR always produces its dev-build artifact.
- One `@claude` comment triggers exactly one agent.
- No change to the released-changelog format the app's "What's new" card reads.
- Land low-risk workflow fixes fast; the bigger changelog change gets review + tests.

## Non-goals

- Reworking the release pipeline beyond the changelog step.
- Changing how releases are cut/tagged (still `workflow_dispatch` + `v*` tag).
- Auto-resolving arbitrary merge conflicts (the conflict-watcher still owns those;
  fragments simply remove the *changelog* class of conflict).

---

## Fix A — dev build survives label churn  *(PR 1)*

**Change:** make label events non-cancelling in the Build concurrency config
([build.yml](../../../.github/workflows/build.yml) lines ~25-27):

```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ !(github.event_name == 'pull_request' && github.event.action == 'labeled') }}
```

A real code push (`synchronize`) still cancels a stale in-progress build; a bare
`labeled`/`qa-passed` toggle no longer does. The build job's existing `if:`
already skips bare label events that aren't `dev-build`, so nothing new runs — we
just stop the needless cancellation.

**Test:** `actionlint`; then a live smoke on a throwaway PR — start a build, toggle
a label mid-build, confirm the build run is **not** cancelled and posts its
dev-build comment.

## Fix C — one agent per `@claude` comment  *(PR 1)*

**Change:** add a label guard to the `claude` job's `if:` in
[claude.yml](../../../.github/workflows/claude.yml) so the read-only investigate
bot stays out of auto-fix PRs (which the revise bot owns). Mirror the exact label
set the revise job keys on (confirm during implementation — `auto-fix`, and `qa`
if it also keys on that):

```yaml
if: >-
  (
    (github.event.issue && contains(github.event.issue.body, '@claude')) ||
    (github.event.comment && contains(github.event.comment.body, '@claude'))
  )
  && !contains(github.event.issue.labels.*.name, 'auto-fix')
  && !contains(github.event.pull_request.labels.*.name, 'auto-fix')
```

`issue_comment` carries the PR's labels under `github.event.issue.labels`;
`pull_request_review_comment` carries them under `github.event.pull_request.labels`
— guard both. Issues and non-auto-fix PRs still get the investigate bot.

**Test:** `actionlint`; live smoke — `@claude` on an auto-fix PR triggers exactly
one run (the revise bot); `@claude` on a normal issue still triggers the
investigate bot.

---

## Fix B — `changelog.d/` fragments  *(PR 2)*

The root-cause fix for B. Each change drops its **own new file**; nothing edits a
shared section, so two PRs can never conflict on the changelog. Files are
assembled into `CHANGELOG.md` at release time and deleted.

### Fragment format

- Path: `changelog.d/<category>-<slug>.md`
  - `<category>` ∈ `added | changed | fixed | security` (matches the `CHANGELOG.md`
    section set and the in-app renderer).
  - `<slug>` is a short kebab description; **bot-authored fragments prefix the
    issue number** for guaranteed uniqueness, e.g. `fixed-57-mod-source-sync.md`.
- Body: the one-line, player-facing bullet **without** a leading `- ` (the
  assembler adds it). Same "writing rules" as today's `[Unreleased]`.
- `changelog.d/.gitkeep` keeps the dir present when empty.

### `scripts/changelog-fragments.mjs` (new, tested)

Pure functions + a thin CLI (`node scripts/changelog-fragments.mjs <cmd>`):

- `listFragments(dir = "changelog.d")` → `[{category, slug, file, body}]` (ignores
  `.gitkeep`/`README.md`; errors on an unknown category or empty body).
- `assemble(fragments)` → markdown: for each non-empty category in order
  `Added, Changed, Fixed, Security`, a `### <Category>` header followed by `- `
  bullets. Returns the section body only (no `## [Unreleased]` header).
- `count(fragments)` → number. CLI `count`.
- `suggestedBump(fragments)` → `minor` if any `added`/`changed`, else `patch` if
  any `fixed`/`security`, else `null` (mirrors today's `ci-changes.mjs`
  patch/minor logic; `major` stays a manual choice in the release dropdown).
  CLI `suggested-bump`.
- `lint(text)` → reuse the dev-speak regexes (file-path / dev-word / type-name)
  currently inline in `release.sh`. **Extract those three patterns to a shared
  module** both `release.sh` (via a small node call) and this script use, so the
  rules live in one place. CLI `lint` (non-zero exit on a violation).
- CLI `assemble` prints the assembled block (used by `release.sh`).

### `scripts/release.sh`

- **Pre-flight gate** (today ~lines 43-105): replace "extract `[Unreleased]` &
  require a bullet" with: `assembled="$(node scripts/changelog-fragments.mjs assemble)"`;
  require `assembled` **or** the legacy `[Unreleased]` body to be non-empty; run
  the dev-speak lint on `assembled` + the legacy body.
- **Promotion** (today ~lines 269-287): instead of renaming `[Unreleased]` →
  `[version]`, build the new `## [<version>] - <date>` section from
  *legacy `[Unreleased]` body (if any) + assembled fragments*, insert it below the
  `## [Unreleased]` placeholder, then `git rm changelog.d/<category>-*.md`.
- After a bump, `[Unreleased]` is reset to a thin placeholder (one line pointing at
  `changelog.d/`). The release-body extraction in
  [build.yml](../../../.github/workflows/build.yml) `format-release` is unchanged
  (it reads the assembled `## [version]` section).

### Other touchpoints

- **CI changelog gate** ([ci.yml](../../../.github/workflows/ci.yml)) — a
  user-facing PR must add a `changelog.d/` fragment (was: an `[Unreleased]`
  bullet). This check can never conflict (per-PR files).
- **`scripts/ci-changes.mjs`** — `unreleasedBulletCount`/`suggestedBump` now read
  `changelog.d/` (delegate to `changelog-fragments.mjs`), keeping the
  `unreleased-count`/`suggested-bump` CLI contract for the workflows.
- **release-suggester** ([release-suggester.yml](../../../.github/workflows/release-suggester.yml))
  — count fragments + suggest the bump from fragment categories.
- **QA check** ([claude-autofix-qa.yml](../../../.github/workflows/claude-autofix-qa.yml))
  — "is there a `changelog.d/` fragment?" instead of an `[Unreleased]` bullet.
- **Auto-fix bot** ([claude-autofix.yml](../../../.github/workflows/claude-autofix.yml)
  + `CLAUDE.md` if the changelog instruction lives there) — instruct it to write a
  `changelog.d/<category>-<issue#>-<slug>.md` fragment, not a `CHANGELOG.md` bullet.
- **conflict-watcher** ([conflict-watcher.yml](../../../.github/workflows/conflict-watcher.yml))
  — its CHANGELOG-specific resolution sentence becomes dead weight (fragments don't
  conflict); trim it to a generic "resolve the conflict" so it doesn't mis-advise.
- **Frontend** (`src/lib/changelog.ts`, `WhatsNewCard.tsx`) — **unchanged**;
  released versions still live in `CHANGELOG.md`.

### Migration (per the approved decision)

- Leave the current `## [Unreleased]` (the staged 1.7.0 notes) **exactly as is** —
  it ships as 1.7.0. The first bump assembles *legacy `[Unreleased]` body +
  fragments* together, then resets `[Unreleased]` to the placeholder.
- In-flight #97/#98 keep their `[Unreleased]` bullets (they're part of 1.7.0).
- From the next change onward, the bot + humans write fragments only;
  `[Unreleased]` stays empty, so the conflict source is gone.

### Docs

- `changelog.d/README.md` — fragment format + how to add one.
- `CHANGELOG.md` writing-rules header — point pending changes at `changelog.d/`.
- `RELEASING.md` — note the assemble-and-delete step.

### Tests

- `scripts/changelog-fragments.test.mjs` (`node --test`) — `assemble` ordering &
  grouping, `count`, `suggestedBump` mapping, `lint` catches dev-speak, unknown
  category errors, empty dir. The conflict-freedom is structural (distinct files),
  so no test is needed for that property.
- Smoke `release.sh` in dry-run if feasible (it currently has no test coverage);
  at minimum assert the assembler output shape the promotion step depends on.

---

## PR plan

- **PR 1 — workflow concurrency/dedup (Fix A + Fix C).** Two small `if:` edits to
  `build.yml` and `claude.yml`. `actionlint` + live smoke. Low risk.
- **PR 2 — `changelog.d/` fragment system (Fix B).** The assembler + tests, the
  `release.sh`/`ci-changes.mjs`/workflow wiring, the bot prompt, docs, and the
  first fragment(s). Reviewed, with unit tests.

Both delivered as **PR + tests** (they touch the live release path) rather than
direct-to-`main`.

## Testing strategy

- Workflow changes: `actionlint` for syntax (CI `workflow-lint` enforces it on the
  PR) + targeted live smokes described per-fix above.
- Script changes: `node --test` unit tests run by CI `script-tests`.
- No silent caps: if a live smoke can't be run deterministically, say so in the PR.

## Appendix — touchpoint inventory

| Area | File | Role today |
|---|---|---|
| Pre-flight + dev-speak lint + promotion | `scripts/release.sh` (~43-105, 269-287) | extract/validate/rename `[Unreleased]` |
| Bump/count CLI | `scripts/ci-changes.mjs` | `unreleased-count`, `suggested-bump` |
| CI changelog gate | `.github/workflows/ci.yml` | require a changelog entry for app changes |
| Release notes body | `.github/workflows/build.yml` `format-release` | extract `## [version]` section |
| QA changelog check | `.github/workflows/claude-autofix-qa.yml` | assert an `[Unreleased]` bullet |
| Release suggester | `.github/workflows/release-suggester.yml` | suggest bump from `[Unreleased]` |
| Conflict watcher | `.github/workflows/conflict-watcher.yml` | CHANGELOG resolve instruction |
| Frontend parser (unchanged) | `src/lib/changelog.ts`, `WhatsNewCard.tsx` | render released versions; skips `[Unreleased]` |
| Frontend tests | `src/lib/changelog.test.ts` | heading/date parsing |
