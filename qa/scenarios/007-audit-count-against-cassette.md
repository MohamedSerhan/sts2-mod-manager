---
id: 007-audit-count-against-cassette
title: "Check for updates" reports the expected pending count against cassettes
tier: 2
user_class: player
flow: 9
historical_bug: null
status: active
last_run: 2026-05-12
---

# 007 — Audit count matches cassette response exactly

> I clicked "Check for updates" expecting to see the pending count update. If the cassette layer or version-comparison logic regresses, this is where it shows.

The cassette playback layer is what unblocks deterministic UI tests against the update flow. This scenario pins the contract: with one stale and one current mod (paired to specific cassette responses), the audit must report exactly one pending update — not zero, not two.

## Pre-conditions

- Build the manager with `--features qa-cassette`.
- `$STS2_CASSETTE_DIR` set to `qa/fixtures/`.
- Two mods seeded:
  - `QaTestMod` at v1.0.0, linked via manifest `source: "github:qa-fixture/test-mod"`. Cassette latest = v2.0.0 → stale.
  - `UpToDateMod` at v1.0.0, linked to `qa-fixture/uptodate-mod`. Cassette latest = v1.0.0 → current.

## Setup

Handled by `makeFixtureGameTree()` + the cassette fixtures committed at `qa/fixtures/github/repos/qa-fixture/{test-mod,uptodate-mod}/releases/{latest.json,releases.json}`.

1. Build the cassette binary once: `npm run tauri build -- --no-bundle --features qa-cassette`.
2. Smoke harness exports `STS2_CASSETTE_DIR`, `STS2_FIXTURE_GAME_PATH`, `STS2_CONFIG_DIR`, `STS2_CACHE_DIR`.

## Action

WebDriver-driven via `specAuditAgainstCassettesShowsOnePending`:

1. Click **Mods**. Verify both fixture mod rows render (proves the fixture game path took).
2. Click **Check for updates**.
3. Wait for the audit to settle.

## Assert

- Toolbar button text matches `/^1 update$/i` exactly.
- An "Update available" pill renders on the `QaTestMod` row (catches the case where the count is right but the per-row UI didn't update).

## Notes

If the cassette doesn't load (e.g. the binary was built without `--features qa-cassette`), this spec fails with either a timeout or a much-larger count from a real GitHub response. Both diagnoses are clearer than a generic "audit broken" message.
