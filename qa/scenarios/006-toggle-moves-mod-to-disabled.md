---
id: 006-toggle-moves-mod-to-disabled
title: Toggling a mod off physically moves it to mods_disabled/
tier: 2
user_class: player
flow: 5
historical_bug: null
status: active
last_run: 2026-05-12
---

# 006 — Toggling a mod off physically moves it to `mods_disabled/`

> I clicked the toggle on QaTestMod expecting it to be disabled next launch, but the file ended up in the wrong folder. Or worse, a copy stayed in `mods/` and the game loaded the disabled mod anyway.

This is the simplest spec we can write that proves the toggle UX wired through to the disk operation — i.e. the contract that everything else in the manager assumes.

## Pre-conditions

- Fixture game tree at `$STS2_FIXTURE_GAME_PATH` with `mods/` and `mods_disabled/` directories.
- One mod seeded at `mods/QaTestMod/` with a manifest and a placeholder `QaTestMod.dll`.
- A clean (empty) `$STS2_CONFIG_DIR` so `mod_sources.json` doesn't override anything.

## Setup

Handled by `makeFixtureGameTree()` in `qa/runner/smoke.mjs`:

1. Tempdir + env-var redirects for game / config / cache.
2. `seedQaTestMod()` writes `QaTestMod.json` + `QaTestMod.dll` into `mods/QaTestMod/`.
3. App launches against the redirected paths.

## Action

WebDriver-driven via `specToggleMovesQaTestModToDisabled` in `qa/runner/smoke.mjs`:

1. Click the **Mods** nav button.
2. Find the row labeled `QaTestMod`.
3. Click the toggle switch inside that row (was `aria-checked="true"`).
4. Wait for the on-disk state to converge — poll `mods_disabled/QaTestMod` exists AND `mods/QaTestMod` no longer exists.

## Assert

- `mods_disabled/QaTestMod/` directory exists with the manifest + DLL.
- `mods/QaTestMod/` no longer exists (move, not copy).
- The toggle's `aria-checked` reads `"false"`.

## Notes

The fixture seeding always runs in both cassette and non-cassette modes — having two mods on disk is what makes Tier 2 tests possible. The spec only runs in non-cassette mode (where `auditPendingCount` isn't part of the suite).
