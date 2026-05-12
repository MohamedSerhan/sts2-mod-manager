---
id: 002-two-same-named-mods-stay-distinct
title: Two CardArtEditor folders must surface as two rows; disabling one must not move the other
tier: 1
user_class: player
flow: 1, 5, 6
historical_bug: 1
status: active
last_run: null
---

# 002 — Two CardArtEditor folders stay distinct

> "I had two CardArtEditor mods installed before installing the Mod Manager. It somehow permanently removed one of them. They were in different sub folders inside of the mod folder." — JadeDemon, Nexus comment.

## Pre-conditions

- Fresh manager state.
- Fake game install.

## Setup

1. Build a fresh tempdir from `qa/fixtures/game/`.
2. Create `<tmp>/.../mods/card_art_editor/` and `<tmp>/.../mods/card_art_editor_v2/`.
3. Drop `qa/fixtures/manifests/card-art-editor-v1.json` (renamed `manifest.json`) into the first folder; same for v2 into the second.
4. Drop 1-byte `card_art_editor.dll` files into each. Different bytes — the harness will sha256 them after the action to detect cross-contamination.
5. Point the manager at `<tmp>/.../mods/`.

## Action

1. Call `get_installed_mods` — record the result as `before`.
2. Call `toggle_mod(name="Card Art Editor", folder_name="card_art_editor_v2", enable=false)`.
3. Call `get_installed_mods` — record the result as `after_active`.
4. Call `scan_disabled_mods(<disabled_path>)` — record the result as `after_disabled`.

## Assert

`before`:
- Exactly two entries match `name == "Card Art Editor"`.
- Their `folder_name`s are the set `{"card_art_editor", "card_art_editor_v2"}`.
- Their `version`s are the set `{"1.0.0", "2.0.0"}`.

`after_active`:
- Exactly one entry matches `name == "Card Art Editor"`.
- Its `folder_name` is `"card_art_editor"` (the v1 one — the one we did NOT disable).
- Its `version` is `"1.0.0"`.

`after_disabled`:
- Exactly one entry matches `name == "Card Art Editor"`.
- Its `folder_name` is `"card_art_editor_v2"`.
- Its `version` is `"2.0.0"`.

On-disk:
- `<tmp>/.../mods/card_art_editor/` still exists and its DLL bytes are unchanged.
- `<tmp>/.../mods/card_art_editor_v2/` no longer exists.
- `<tmp>/.../mods_disabled/card_art_editor_v2/` exists and its DLL bytes match what was originally in v2.

## Notes

The pre-1.3.1 manager collapsed both into one entry via normalized-name dedup, and `toggle_mod` matched by stem, so a user disabling "Card Art Editor" could move *either* copy depending on filesystem iteration order. The assertion that the SPECIFIC v2 folder moved (and the v1 DLL hash is preserved) catches both halves of the regression.

Tier 2 follow-up: same scenario but driven through the Mods view. The UI must show both rows with the author/folder subtitle visible.
