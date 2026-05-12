---
id: 005-install-pipeline-preserves-bom-version
title: install_mod_from_zip on a BOM-manifest zip must return a ModInfo with the real version
tier: 1
user_class: player
flow: 3, 4
historical_bug: 2
status: active
last_run: null
---

# 005 — Install pipeline preserves the BaseLib version

> Closes the second half of the BaseLib gap. The 1.3.3 fix made `parse_manifest` BOM-tolerant — scenario 001 covers that read path. This scenario covers the **install** path: extracting a zip whose internal manifest has a BOM must produce a ModInfo with the right version, not a `"unknown"` stub.

## Pre-conditions

- Fresh manager state, no installed mods.

## Setup

1. Build a zip in a tempdir with this internal layout:
   ```
   BaseLib/
     BaseLib.json   <-- BOM-prefixed; from qa/fixtures/manifests/baselib-bom.json
     BaseLib.dll    <-- 1-byte placeholder
     BaseLib.pck    <-- 1-byte placeholder
   ```
2. Verify the zip entry for `BaseLib/BaseLib.json` starts with bytes `EF BB BF` after extraction (the harness can extract to a side tempdir and check).
3. Point the manager at a fresh `mods/` tempdir.

## Action

1. Call `install_mod_from_zip(zip_path, mods_path)` directly. (Tier 1 — no UI involved.)

## Assert

- `install_mod_from_zip` returns `Ok(info)`.
- `info.name == "BaseLib"`.
- `info.version == "v3.1.2"`.
- `info.version` is NOT `"unknown"`.
- `info.author == Some("Alchyr")`.
- `info.mod_id == Some("BaseLib")`.
- After install, `<mods>/BaseLib/BaseLib.json` byte-0 is still `0xEF` (we didn't rewrite the manifest, just read it).

## Notes

This is the scenario the v1.3.1 fix would have failed (it covered only `parse_manifest`, not the `install_mod_from_zip` → `parse_manifest` chain). Pre-1.3.3 the install path could still produce a `"unknown"` stub even after `parse_manifest` itself was lenient.

After this scenario passes, the BaseLib regression is closed end-to-end:
- Scenario 001 covers scan (read path).
- Scenario 005 covers install (write path).
- The shared `strip_utf8_bom` helper unit tests cover the helper in isolation.

Three layers of coverage on the same root cause is appropriate for a bug that escaped twice already.
