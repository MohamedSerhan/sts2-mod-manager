# Audit & Update UX — Design

**Date:** 2026-05-12
**Status:** Approved for planning
**Scope:** Mods view toolbar + Settings → Audit tab + audit backend perf

## Problem

Three issues are tangled in the current "Check for updates" flow:

1. **Audit is slow.** `audit_mod_versions` walks installed mods sequentially, making one or more GitHub/Nexus network calls per mod. A 20-mod audit on a typical connection takes ~10–15s of mostly-idle network wait.
2. **Verb/noun collision on the toolbar button.** After audit, the Mods view button reads `N updates`. Users click it expecting it to *do* the update; it re-audits instead. The label communicates a count *and* invites an action that the button doesn't perform.
3. **No "Latest" signal.** Modpack creators sharing builds want at-a-glance confirmation that every mod is on its source's latest release. Today they have to read state out of the absence of an "Update available" pill.

## Goals

- Audit completes in roughly `(N / 8)` × per-mod-latency rather than `N` × per-mod-latency.
- The toolbar button's verb always matches what clicking it does.
- A user with multiple pending updates can update them all from the Mods view in one click (today this only exists in Settings).
- Up-to-date rows carry a visible "Latest" badge in both the Mods view audit data and the Settings → Audit tab.

## Non-goals

- Not changing the audit's data model, error taxonomy, or per-row affordances (Pin / Edit sources / Repair stay as-is).
- Not changing the Nexus flow — Nexus updates still require manual browser download. Bulk update only touches GitHub-sourced rows with installable assets, same as today.
- Not adding background / scheduled audits. Manual trigger only.
- Not touching the AboutCard "Check for updates" button (that's the app updater, distinct from mod audit).

## Section 1 — Audit backend parallelism

### Current state

`src-tauri/src/updater.rs:1207` — `audit_mod_versions(only, state)` reads paths/token from state once, scans enabled + disabled mod folders, then runs a synchronous `for m in &all_mods` loop. Each iteration may issue paginated GitHub releases fetches, Nexus file/version fetches, and parse manifest data.

### Change

Replace the sequential loop with a bounded-concurrency stream:

```rust
use futures::stream::{self, StreamExt};

const AUDIT_CONCURRENCY: usize = 8;

let results: Vec<ModAuditEntry> = stream::iter(all_mods.into_iter())
    .map(|m| audit_one_mod(m, &shared_ctx))
    .buffer_unordered(AUDIT_CONCURRENCY)
    .collect()
    .await;
```

Extract the existing per-mod body into `async fn audit_one_mod(m: ModInfo, ctx: &AuditCtx) -> ModAuditEntry`. `AuditCtx` is a borrow-friendly bundle of the immutable state read at the top of `audit_mod_versions` today: `sources_db`, `nexus_api_key`, `user_game_version`, `cache_path`, `github_token`. No locks are held across the await.

### Concurrency cap rationale

GitHub's documented secondary rate limit kicks in around 10 concurrent requests per repo and ~100/min unauthenticated. 8 is empirically the sweet spot: high enough to saturate latency-bound work, low enough to leave headroom under the secondary limit and avoid stair-stepping into 403 responses. The constant lives at module top with a comment so it's easy to tune.

### Ordering

Result order today is the scan order of `all_mods`. `buffer_unordered` returns results as they complete, which breaks that contract. We re-sort the result vector by `mod_name.to_lowercase()` before returning so the UI's render order is stable across runs.

### Error isolation

Per-mod errors are already captured into `ModAuditEntry.error` (not bubbled). That contract is preserved — one mod's failure does not cancel the stream.

## Section 2 — Mods view toolbar (rename + action split)

### Current state

`src/views/Mods.tsx:411–430` — one `<Button>` with a label that cycles:

- never audited → `Check for updates`
- auditing → `Checking…` (disabled)
- N=0 → `Up to date`
- N>0 → `N updates`

All four states call `handleCheckUpdates` (which calls `runAudit`). This is the bug.

### New state machine

Replace the single button with a button-group whose composition depends on audit phase:

| Phase | Primary button | Secondary control |
|---|---|---|
| Never audited | `Audit mods` (calls `runAudit`) | — |
| Auditing | `Auditing…` (disabled, spinner icon) | — |
| Done, N=0 | `Up to date` (subtle, non-clickable; styled as a status pill rather than a button) | icon-only ↻ button "Re-audit" (calls `runAudit`) |
| Done, N>0 | `Update N mod(s)` (primary, calls new `handleUpdateAll`) | icon-only ↻ button "Re-audit" (calls `runAudit`) |
| Updating | `Updating N…` (disabled, spinner) | — |

Tooltips:

- `Audit mods` → `Check each mod against its source for updates.`
- `Update N mods` → `Update every GitHub-linked mod with a pending update. Pinned mods are skipped.`
- ↻ → `Re-audit`

### `handleUpdateAll` extraction

The bulk-update logic in `src/views/Settings.tsx:299` (`handleUpdateAll`) is moved verbatim into `AppContext` so both views share it. Behavior preserved:

- Confirms before kicking off (multi-download, modifies disk).
- Iterates updates via `updateMod`, collects successes.
- Toasts a summary including failure count when non-zero.
- Calls `refreshAll` then a targeted `refreshAuditEntries` of the union of requested names and post-rename names.

### Exclusions from N

The `N` shown on the button matches what `handleUpdateAll` will actually attempt:

```ts
auditResults.filter(r =>
  r.needs_update && r.github_repo && r.latest_release_with_assets_tag
).length
```

Same predicate already used in `Settings.tsx:726` so the count and the action stay aligned. Pinned mods are excluded by the backend; we surface that in the confirm dialog body, not by filtering here.

### Empty / error states

If `auditResults` is null and `auditing` is true, only `Auditing…` shows. If audit threw, the existing toast error path runs and the button returns to its prior state (`Audit mods` if no prior result, otherwise the last result's phase).

## Section 3 — "Latest" badge

### Predicate

A row qualifies for the `Latest` badge when **all** of:

- `(github_repo || nexus_url)` — source is linked
- `!needs_update`
- `!(error && !github_auto_detected)` — no real error
- `!(latest_release_tag && !latest_release_with_assets_tag)` — not "release exists but ships no assets"
- `!game_version_too_old`

This is the same predicate that drives the `okCount` footer stat in `Settings.tsx:1045`. Extract it to a helper `isUpToDate(entry: ModAuditEntry): boolean` in the audit-entry utilities so the footer count and the badge render can never diverge.

### Rendering

Render as a `<span className="gf-pill">Latest</span>` with green-leaning styling. Two render sites:

1. **Settings → Audit tab row** (`Settings.tsx` around line 829): inline next to the mod name, after the audit LED and mod name, before the `Pinned` pill if present.
2. **Mods view row** (`Mods.tsx`, the audit-data area of each `ModCard` / row): same placement convention.

CSS — add `.gf-pill-latest` to `src/styles.css` mirroring the existing pill tokens but with the success/ok color (`var(--ok)` or equivalent — match the LED-ok green for consistency).

### Pinned interaction

`Pinned` and `Latest` are not mutually exclusive: a pinned mod can still be on the source's latest release. Both pills render when both apply. The order is `Latest` then `Pinned` (status first, lock-state second).

## Section 4 — Settings → Audit tab alignment

### Current state

`Settings.tsx:760` — `<Button variant="secondary">` for `Re-audit` / `Run audit`.
`Settings.tsx` — `Update all` button (the green one in the toolbar above the rows) is rendered as a secondary action.

### Change

Mirror the Mods view hierarchy:

- When `N > 0`, `Update all (N)` becomes the **primary** variant and `Re-audit` demotes to `ghost` / `secondary`.
- When `N == 0` or `auditResults == null`, the audit-trigger button stays as today.
- The Latest badge from Section 3 renders on each row.

No backend changes, no copy changes beyond the variant swap. The `Update all` confirm-and-toast flow is unchanged because it's the same function the Mods view will now also call.

## Architecture summary

```
                     ┌────────────────────────┐
                     │  AppContext            │
                     │  ───────────────────   │
                     │  runAudit              │
                     │  refreshAuditEntries   │
                     │  updateAllGithub  ◀──┐ │  (NEW — extracted from Settings)
                     │  ...                 │ │
                     └──────────────────────┼─┘
                                            │
        ┌───────────────────────────────────┴────────────────────────┐
        │                                                            │
┌──────────────────┐                                       ┌──────────────────────┐
│  Mods view       │                                       │  Settings → Audit    │
│  toolbar         │                                       │  tab                 │
│  ──────────────  │                                       │  ──────────────────  │
│  Audit mods      │                                       │  Run audit/Re-audit  │
│  Update N mods   │                                       │  Update all (N) ★    │
│  ↻ Re-audit      │                                       │  per-row Update      │
│  Latest pill ★   │                                       │  Latest pill ★       │
└──────────────────┘                                       └──────────────────────┘
                                            │
                         ┌──────────────────┴─────────────────┐
                         │  Rust: audit_mod_versions          │
                         │  ───────────────────────────────   │
                         │  buffer_unordered(8) over mods ★   │
                         │  audit_one_mod(m, &ctx)            │
                         │  re-sort by name before returning  │
                         └────────────────────────────────────┘

★ = changed by this design
```

## Testing

### Backend (Rust)

- Unit test: `audit_mod_versions` over a fixture of N mods returns results sorted by `mod_name` regardless of completion order. Use a stub HTTP layer that randomizes per-mod delay.
- Unit test: one mod erroring does not affect other mods' entries (existing contract — add explicit coverage if missing).
- Cassette playback continues to work — `buffer_unordered` does not change the request shape, only timing.

### Frontend (Vitest + Testing Library)

- `Mods.test.tsx` — update the existing `Check for updates` button tests to the new labels. New test: after audit returns N>0, the button renders `Update N mods` and clicking it triggers the bulk-update path (mock `updateMod`), not a re-audit.
- `Mods.test.tsx` — new test: ↻ re-audit icon button calls `runAudit`.
- `Settings.test.tsx` — new test: Latest pill renders on rows that match `isUpToDate`. Update existing footer-count tests if they assert on exact pill counts.
- `AppContext.test.tsx` — new test: `updateAllGithub` is callable from context and runs the confirm + toast path.

### Manual QA checklist

- 0 mods → `Audit mods` available, click → empty state (no rows), button returns to idle.
- 1 mod with update → click `Audit mods` → button becomes `Update 1 mod` → click → confirm → mod updates → button settles to `Up to date`.
- 3 mods, 2 with updates, 1 pinned with update → `Update 2 mods` (pinned excluded by backend; copy in confirm dialog states pinned skipped).
- Audit while game running, audit with no network — error toast surfaces, button reverts.
- Re-audit ↻ during N>0 — does not trigger update.

## Risks & open questions

- **Sort cost** — re-sorting by lowercase name on a typical 10–50 mod list is negligible (<1ms). Not a concern.
- **GitHub rate limit at concurrency 8** — if users with unauthenticated tokens trip the secondary limit on very large mod lists (50+), we may want to expose `AUDIT_CONCURRENCY` as a config knob. Out of scope for this design; the constant can move to settings later if reports come in.
- **"Up to date" as a non-button** — visually distinguishing it from clickable buttons matters; using a `gf-pill` style instead of a `Button` removes the affordance ambiguity. Confirm with a quick visual pass during implementation.
- **Latest pill on Mods view rows** — depends on audit data being present for that row. If a row has no audit entry yet (never audited or filtered out), no pill — same rule the rest of the audit-derived row UI already follows.

## Out of scope follow-ups

- Background audit on app launch (would let the toolbar show `Update N` without an explicit click).
- Per-source concurrency tuning (different caps for GitHub vs Nexus).
- A `Re-audit failed rows only` action.
