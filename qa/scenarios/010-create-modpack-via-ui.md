---
id: 010-create-modpack-via-ui
title: "Create modpack" creates a modpack and shows it in the list
tier: 2
user_class: player
flow: 10
historical_bug: null
status: active
last_run: 2026-06-06
---

# 010 - Creating a modpack via the UI

> I clicked "Create modpack", picked a starting point, typed a name, hit Create - and the modpack didn't appear in the list. Or it appeared but switching to it did nothing.

The simplest modpack-flow spec proves the guided create flow does not blow up and the new modpack lands in the list. Switch/apply semantics have their own owners because those paths carry separate historical hazards.

## Pre-conditions

- Fixture game tree.
- Fresh `$STS2_CONFIG_DIR` so the modpack name we pick cannot collide with previous state.

## Setup

Identical to scenarios 006-009.

## Action

WebDriver-driven via `specCreateModpack`:

1. Click **Modpacks** in the sidebar.
2. Click **Create modpack**.
3. Choose **Start from my active mods**.
4. Continue through the health step.
5. Type a unique name (`QA Smoke <timestamp-suffix>`) into the input.
6. Click **Create modpack**.

## Assert

- A card or detail title matching the typed name renders in the modpack UI within 10 seconds.

## Notes

- Switching to the new modpack is not part of this spec; switching has its own historical hazards, so it deserves a dedicated owner.
- The unique suffix protects against collision when the fixture config dir is reused.
