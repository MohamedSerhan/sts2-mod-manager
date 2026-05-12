---
id: 010-create-profile-via-ui
title: "New profile" creates a profile and shows it in the list
tier: 2
user_class: player
flow: 10
historical_bug: null
status: active
last_run: 2026-05-12
---

# 010 — Creating a profile via the UI

> I clicked "New profile", typed a name, hit Create — and the profile didn't appear in the list. Or it appeared but switching to it did nothing.

The simplest profile-flow spec we can land before tackling the harder ones (snapshot, switch, apply with pin survival). Proves the create handler doesn't blow up and the new profile lands in the list.

## Pre-conditions

- Fixture game tree.
- Fresh `$STS2_CONFIG_DIR` so the profile name we pick can't collide with previous state.

## Setup

Identical to scenarios 006-009.

## Action

WebDriver-driven via `specCreateProfile`:

1. Click **Profiles** in the sidebar.
2. Click **New profile**.
3. Type a unique name (`QA Smoke <timestamp-suffix>`) into the input.
4. Click **Create**.

## Assert

- A card matching the typed name renders in the profile list within 8 seconds.

## Notes

- Switching to the new profile is **not** part of this spec — `handleCreate` deliberately doesn't activate the new profile (see Profiles.tsx line 148). Switching has its own historical hazards (active-profile-restoration on startup), so it deserves a dedicated spec.
- The unique suffix protects against collision when the fixture config dir is reused (it isn't today, but a future smoke flag might).
