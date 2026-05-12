---
id: 004-downloads-watcher-respects-pin
title: Auto-install from the Downloads folder must not overwrite a pinned mod
tier: 1
user_class: player
flow: 4, 7
historical_bug: 32
status: active
last_run: null
---

# 004 — Downloads-watcher respects pin

> Internal regression caught during the 1.3.1 audit (not from a user report — yet). Before the fix, the watcher's pin check used name-only lookup in `mod_sources.json`. After 1.3.1, pins are folder-keyed. Name-only lookup missed them → a pinned mod could be silently overwritten by a new zip dropping into Downloads.

## Pre-conditions

- Fresh manager state.
- One installed mod: BaseLib v3.1.2 at `mods/BaseLib/`, pinned via the post-1.3.1 path (folder-keyed entry in `mod_sources.json`).
- Downloads watcher running, pointed at a fake Downloads folder under tempdir.

## Setup

1. Drop BaseLib into `mods/BaseLib/` using the BOM fixture.
2. `pin_mod(mod_name="BaseLib", folder_name="BaseLib")`.
3. Verify `mod_sources.json` contains an entry keyed by `"BaseLib"` (folder name) with `pinned: true`.
4. Build a fake replacement zip: `BaseLib.dll` (different bytes from the original) + `BaseLib.json` declaring `version: v9.9.9` (so any successful overwrite is detectable). Place it in the fake Downloads folder named `BaseLib-9.9.9.zip`.

## Action

1. Trigger the watcher (either wait the watcher's debounce duration with the file present, or call the watcher's identify-and-install path directly with the zip path).

## Assert

- The watcher emits a `mod-auto-install-failed` event whose error message names the pinned mod.
- `<mods>/BaseLib/BaseLib.dll` is unchanged (sha256 matches the original).
- `<mods>/BaseLib/BaseLib.json` is unchanged.
- `get_installed_mods()` still reports BaseLib at `v3.1.2`, not `v9.9.9`.
- `mod_sources.json` `BaseLib.pinned` is still `true`.

## Notes

This scenario is the canary for the entire "writes are folder-keyed; reads must be folder-first" contract. If any future code introduces a name-only `db.mods.get(&mod_name)` call on a read path that protects user state, this scenario will fail (because the pin entry it would have found lives under `"BaseLib"` which happens to also be the display name — but a same-named-collision variant of this scenario could catch the subtler case).

**Variant 004b**: same scenario but the pinned mod has `folder_name != name` (e.g. folder `card_art_editor`, manifest name `Card Art Editor`). Pin is folder-keyed under `card_art_editor`. The watcher then catches a different `Card Art Editor` zip and must still respect the pin via folder lookup. This catches the case where my downloads-watcher fix is correct but a future refactor regresses it.
