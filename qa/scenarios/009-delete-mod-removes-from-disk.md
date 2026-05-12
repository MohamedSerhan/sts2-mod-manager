---
id: 009-delete-mod-removes-from-disk
title: Deleting a mod removes both the row and the folder
tier: 2
user_class: player
flow: 6
historical_bug: null
status: active
last_run: 2026-05-12
---

# 009 — Deleting a mod removes it from disk too

> I clicked Remove mod and the row disappeared but the folder stayed in `mods/`. Next time I scanned the mod came back like a zombie.

The destructive path. UI removal and filesystem removal must agree; the confirm modal must intercept accidental clicks; both halves of the operation must succeed atomically.

## Pre-conditions

- Fixture game tree with `mods/UpToDateMod/` populated (the smoke seeds this).

## Setup

Same `makeFixtureGameTree()` setup as scenarios 006-008.

## Action

WebDriver-driven via `specDeleteUpToDateMod`:

1. Click **Mods**.
2. Open the kebab on the `UpToDateMod` row.
3. Click **Remove mod…**.
4. In the confirm modal, click **Delete**.

## Assert

- Within 10 seconds, no row matching `UpToDateMod` renders.
- Within 5 seconds, `<fixture-game>/mods/UpToDateMod/` no longer exists.

## Notes

We delete `UpToDateMod` (not `QaTestMod`) so this composes with scenarios 006 (toggles `QaTestMod`) and 008 (pins `QaTestMod`) in any order — each target mod is distinct. If both QA and a future spec wanted to operate on the same mod, the suite would have to enforce ordering or reseed between specs.
