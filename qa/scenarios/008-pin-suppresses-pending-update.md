---
id: 008-pin-suppresses-pending-update
title: Pinning a mod drops it from the audit's pending count
tier: 2
user_class: player
flow: 7, 9
historical_bug: null
status: active
last_run: 2026-05-12
---

# 008 — Pinning suppresses the pending-update count

> I pinned QaTestMod because I'm happy with my current version and don't want auto-updates to touch it. The "1 update" badge stayed up anyway and kept nagging me.

The audit reports `needs_update` for every linked mod with a newer release, but the toolbar count must filter pinned rows (Mods.tsx:122, `auditResults.filter((a) => a.needs_update && !a.pinned).length`). This spec locks the contract.

## Pre-conditions

Same as [007](007-audit-count-against-cassette.md) — cassette binary + fixture game tree + cassette fixtures.

## Setup

Identical to scenario 007.

## Action

WebDriver-driven via `specPinSuppressesPendingUpdate`:

1. Click **Mods**.
2. Open the kebab menu on the `QaTestMod` row.
3. Click **Pin this mod**.
4. Re-click **Check for updates** (the audit doesn't re-run on pin-state change today; reproduce the user behavior of clicking again).
5. Wait for the toolbar to settle.

## Assert

- Toolbar button text reads exactly `Up to date` (case-insensitive). The only mod with a pending update is pinned → count collapses to 0.

## Notes

- Companion spec [007](007-audit-count-against-cassette.md) runs first and confirms the count was 1 before pinning. So a pass here means the pin specifically caused the count drop, not pre-existing state.
- The on-disk pin lives in `$STS2_CONFIG_DIR/mod_sources.json` keyed by `folder_name` (per the v1.3.1 folder-first refactor). The smoke's config dir is a fresh tempdir per run; the pin is wiped at teardown.
