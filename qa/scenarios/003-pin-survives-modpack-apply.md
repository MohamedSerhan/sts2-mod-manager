---
id: 003-pin-survives-modpack-apply
title: A pinned mod must keep its enabled state and files when a profile that doesn't list it is applied
tier: 1
user_class: player
flow: 7, 11
historical_bug: null  # the pin promise predates the bug tracker; this guards against future regressions
status: active
last_run: null
---

# 003 — Pin survives modpack apply

> Player promise: "I pinned BaseLib so it stays enabled no matter what profile I switch to." If applying a curator's modpack disables or removes a pinned mod, the manager has violated its core contract.

## Pre-conditions

- Fresh manager state.
- One mod installed: BaseLib at `mods/BaseLib/` (use `qa/fixtures/manifests/baselib-bom.json`).
- One profile saved: `pack-A` with an empty mod list (snapshot taken before BaseLib was installed, OR a curator's pack that genuinely doesn't include BaseLib).

## Setup

1. Drop BaseLib into `mods/BaseLib/`.
2. Call `pin_mod(mod_name="BaseLib", folder_name="BaseLib")`.
3. Write `<config>/profiles/pack-A.json` with `mods: []`.
4. Active profile is anything other than `pack-A` (e.g. unset).

## Action

1. Verify pin state: `get_installed_mods()` returns BaseLib with `pinned == true`.
2. Call `switch_profile(name="pack-A")`.

## Assert

- `switch_profile` completes without error.
- `get_installed_mods()` still returns BaseLib.
- BaseLib's `enabled == true` (it was active before; the empty profile didn't list it but the pin overrode the apply).
- BaseLib's `pinned == true` (state preserved across apply).
- `<mods>/BaseLib/BaseLib.dll` still exists and is byte-identical to before.
- `mod_sources.json` still contains a pin entry keyed by `folder_name == "BaseLib"`.

## Notes

Closely related Tier 1 scenarios to add next:
- **004**: same scenario but the curator's pack-A *explicitly* lists BaseLib with `enabled: false`. Pin still wins → BaseLib stays enabled.
- **005**: same as 003 but pin is keyed by display name (legacy `mod_sources.json` shape from pre-1.3.1). Folder-first lookup must still find it.

This scenario forms the regression suite that any future change to `apply_profile`, pin logic, or `mod_sources` keying has to clear.
