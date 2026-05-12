---
id: 000-template
title: One short user-facing sentence describing the bug or flow
tier: 1  # 1 = IPC, 2 = WebDriver, 3 = computer-use. Pick the cheapest that proves the assertion.
user_class: player  # player | mod_author | curator
flow: 5  # walkthrough-findings.md flow number(s) this exercises
historical_bug: 1  # row number in the historical-bug table, or null
status: draft  # draft | active | quarantined
last_run: null
---

# 000 — Template scenario

> Replace this paragraph with one sentence in the user's voice. "I had two CardArtEditors and disabling one made the other disappear" — that voice. Not "verify that upsert_mod_dedup correctly handles folder collisions." The format exists to keep us honest about user-facing meaning.

## Pre-conditions

A bullet list of what must be true before this scenario starts. Examples:

- Fresh manager install (no `mod_sources.json`, no profiles, no `active_profile.txt`).
- Game install at `<fixture-root>/Slay the Spire 2/` with `release_info.json` declaring version `0.103.2`.
- `mods/` folder is empty.

Anything you DON'T list here, the harness leaves at default.

## Setup

Numbered steps the harness performs to build the world the user is about to interact with. Each step is concrete enough that a different person reading it would build the same state.

1. Copy `fixtures/game/` into a fresh tempdir as the fake game root.
2. Drop `fixtures/manifests/baselib-bom.json` (renamed `BaseLib.json`) plus a 1-byte dummy `BaseLib.dll` and `BaseLib.pck` into `<game>/mods/BaseLib/`.
3. Point the manager's state at `<game>/`.

## Action

Numbered steps the simulated user takes. **Tier 1** scenarios write these as Tauri IPC calls. **Tier 2** writes them as WebDriver clicks. **Tier 3** writes them as plain English ("Click the Mods tab → click toggle on BaseLib").

The action list MUST be deterministic. Don't say "click around"; say "click the toggle exactly once."

1. Call `get_installed_mods` (or open the Mods view if Tier ≥ 2).

## Assert

What MUST be true after the action runs. Each assertion is checkable — no "looks fine."

- `get_installed_mods` returns exactly one entry whose `name == "BaseLib"` AND `version == "v3.1.2"`.
- The returned entry's `version` is NOT `"unknown"` (or "vunknown" after the UI prefix).
- `<game>/mods/BaseLib/BaseLib.json` is byte-identical to the fixture (we didn't modify the user's manifest).

## Notes

Anything weird about this scenario — known flakes, fixtures that need refreshing, platform differences. Empty by default.
