---
id: 001-baselib-bom-shows-real-version
title: BaseLib with a UTF-8 BOM in its manifest must surface version v3.1.2, not "vunknown"
tier: 1
user_class: player
flow: 1, 3, 8
historical_bug: 2
status: active
last_run: null
---

# 001 — BaseLib's BOM-prefixed manifest must yield the real version

> "BaseLib is in my mods folder. After the auto-installer updated it, the version in the manager reads `vunknown`. The manifest on disk clearly says `version: v3.1.2`." — JadeDemon report + me reproducing on my own install.

## Pre-conditions

- Fresh manager state (no `mod_sources.json`, no profiles).
- Fake game install at `<tmp>/Slay the Spire 2/` with a `release_info.json` declaring `version: "0.103.2"` and a writable `mods/` subfolder.

## Setup

1. Build a fresh tempdir from `qa/fixtures/game/`.
2. Create `<tmp>/Slay the Spire 2/mods/BaseLib/`.
3. Copy `qa/fixtures/manifests/baselib-bom.json` into the new folder as `BaseLib.json` — preserving the leading three bytes `EF BB BF`. **The harness must verify byte 0 of the destination file is `0xEF` before proceeding**; if any tooling silently strips the BOM, this scenario is testing nothing.
4. Drop a 1-byte file each at `BaseLib.dll` and `BaseLib.pck` (the scan needs them to exist; their contents don't matter).
5. Point the manager's `AppState.mods_path` at `<tmp>/Slay the Spire 2/mods/`.

## Action

1. Call `get_installed_mods` once.

## Assert

- The result contains exactly one entry whose `name == "BaseLib"`.
- That entry's `version == "v3.1.2"`. (Reject `"unknown"`, `"vunknown"`, `""`, and `"0.0.0"`.)
- `author == "Alchyr"`.
- `mod_id == "BaseLib"` (the manifest's `id` field).
- `folder_name == "BaseLib"`.
- `BaseLib.json` on disk is still byte-identical to the source fixture. (The manager must not have rewritten the manifest while reading it.)

## Notes

This is the scenario the v1.3.1 lenient-parse test missed. The unit test used a manifest with a malformed `dependencies` field — a different failure mode than the real one. Capturing the actual fixture closed that gap.

A regression in any of these would silently re-ship as v1.3.X+1:
- Removing `strip_utf8_bom` from `parse_manifest`.
- Changing the strict serde call to `serde_json::from_reader(BufReader::new(file))` without BOM handling.
- Refactoring `parse_manifest` to skip the lenient fallback.
