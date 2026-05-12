# Fixtures

Realistic inputs for QA scenarios. Three rules: no synthetic happy-path content, capture once and replay forever, every file has a provenance header.

## What lives here

| Subdir | Contents | How to refresh |
|---|---|---|
| `manifests/` | Hand-captured / hand-crafted `manifest.json` files for popular mods. Each file's leading comment names the source and the quirk it exhibits. | Drop in a new `.json`; write a provenance header before the JSON body. |
| `zips/` | Pre-built `.zip` archives used by install-pipeline scenarios. Built lazily by `harness/build-fixtures.sh` (TODO). | Keep `.gitkeep`; don't check in large binaries. The build script reconstructs them from `manifests/` + placeholder DLL bytes. |
| `nexus/` | HTTP cassettes from the Nexus API. One JSON file per request, named `mods-<id>.json`. | `cargo run --bin capture-nexus -- 103` (TODO) — would call the Nexus API once, save the response, redact the key. |
| `github/` | HTTP cassettes from GitHub releases. One JSON file per repo, named `<owner>-<repo>.json`. | Same shape; capture via `gh api` + redaction. |
| `game/` | A directory tree mirroring a Slay the Spire 2 install (`release_info.json` + empty `mods/` + empty `mods_disabled/`). Cloned per scenario. | Update `release_info.json` when the game's manifest schema changes. |

## Provenance headers

Every manifest fixture needs a leading-comment-style line that names:
1. The mod's identity (name + version).
2. Where the file came from (Nexus mod ID, GitHub repo + tag, etc.).
3. The date captured.
4. What quirk this fixture exhibits — i.e. why we kept it.

JSON doesn't support comments, but the harness reads these files raw before any parser touches them, so a JS-style `//` line at the top is fine. Where a fixture must be byte-exact (e.g. `baselib-bom.json` whose first three bytes are `EF BB BF`), the provenance lives in a separate `<name>.md` sidecar with the same stem instead.

## Refresh policy

- Capture once at the time of the bug report. Don't refresh on a schedule — yesterday's BaseLib manifest is the bug, today's might be fixed upstream.
- When a mod author *fixes* their quirk (e.g. Alchyr strips the BOM from BaseLib's manifest in v3.1.3), do NOT update our fixture — it's still the manifest that broke the manager, and we want to keep proving we handle it. Add a new fixture for the fixed version if relevant.

## What doesn't live here

- Real DLLs. Even when a scenario needs `BaseLib.dll` present, we use a 1-byte placeholder. The manager never loads or executes mod DLLs — it only scans + moves them.
- The user's actual `mod_sources.json` / `profile manifests`. Those are per-user state; scenarios build them from scratch.
- Anything copyrighted. The manifests are config files written by mod authors and are not protected.
