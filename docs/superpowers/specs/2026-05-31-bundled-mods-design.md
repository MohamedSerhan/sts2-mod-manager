# Bundled Mods Design — a multi-mod download is one folder, one library entry

## Purpose

Some Nexus / manual downloads ship **several independent mods in one archive** — the "Alice
Defect Visual Pack" zip contains `AliceDefectSkin`, `AliceDefectVoiceBridge`,
`AliceDefectVoicepack`, and `VoiceModFramework`. The user downloaded **one thing** and expects
it to stay one thing in the manager. Today the members show as separate rows, only one gets the
Nexus link (the rest read `UNLINKED`), and versioning is scattered across members that share a
single upstream release.

This design treats a multi-mod download as a **bundle**: one container folder, one library row,
one source link, one version, managed as a unit.

## Ground truth (verified)

STS2 **loads mods nested under a container folder.** The user's live game folder runs:

```
mods/<container>/
   ├─ AliceDefectSkin/          (.dll + .json + .pck)
   ├─ AliceDefectVoiceBridge/   (.dll + manifest)
   ├─ AliceDefectVoicepack/     (voicepack data)
   └─ VoiceModFramework V1.12/  (.dll framework)
```

…and it loads in-game. So a bundle can be a **real folder** that contains the member mods —
the simplest possible model, and the one the user expects. (This supersedes an earlier draft
that kept members at the top level with a separate metadata registry; that was based on an
incorrect assumption that the game only loads one level deep.)

The companion scan fix already in PR #97 (`b41666e`, "detect sub-mods inside multi-mod container
folders") makes the manager *see* the members inside a container. This design builds the rest of
the bundle experience on top of that.

## Terminology

- **Bundled mods / a bundle** — internal concept and identifiers (`bundle`, `bundle_*`). A
  container folder under `mods/` that holds member mod subfolders.
- The user **never sees** the words "bundle" or "pack" imposed by us; the row shows the
  **author's own name** for the download (the Nexus mod title, e.g. "Alice Defect Visual Pack").
- **Modpack** is the existing, unrelated concept (a user-curated set of mods to activate). The
  name "bundle" is chosen to avoid colliding with it. A bundle can belong to a modpack as a unit.

## Design Guardrails

- Not a visual redesign. Reuse `Button`, `Card`, `Badge`, `Toggle`, `KebabMenu`, `ConfirmDialog`,
  lucide icons. CSS in `src/styles.css`.
- All user-visible strings through `react-i18next`, `en.json` + `zh-Hans.json` updated together.
- **Non-bundled (single) mods behave exactly as today.**

## Data model — the folder *is* the bundle

A bundle is a container folder plus a small hidden sidecar written inside it,
`mods/<container>/.sts2mm-bundle.json`:

```
BundleSidecar {
  display_name: String,              // author's name (Nexus mod title; fallback cleaned archive stem)
  nexus_url, nexus_game_domain, nexus_mod_id,   // the single shared source (optional)
  github_repo,                        // for non-Nexus completeness (optional)
  installed_version: Option<String>, // the bundle's version (the Nexus mod version)
}
```

The **filesystem is the source of truth for membership** — the members are simply the mod
subfolders found inside the container (via the `b41666e` scan descent). There is **no separate
registry and no membership list to keep in sync**. The sidecar only carries what the folder
structure can't: the nice display name, the shared upstream link, and the version. The container
folder name on disk is the sanitized pack name (fallback: cleaned archive stem); the *displayed*
name always comes from the sidecar, so an ugly download filename never leaks to the UI.

## Install — wrap members into one named container

In the install pipeline (`src-tauri/src/mods/install.rs`):

- When an archive yields **two or more member mod folders**, extract them into a single container
  folder under `mods/`, named after the pack (sanitized Nexus mod title when known, else cleaned
  archive stem). This is the existing wrap path, refined to use a meaningful container name.
- Write the `.sts2mm-bundle.json` sidecar into the container. For Nexus / auto-installs,
  `src-tauri/src/downloads_watcher.rs` already resolves the Nexus title + version
  (`attach_pending_nexus_source` / `fetch_nexus_version_blocking`); it fills the sidecar's
  `display_name`, link, and `installed_version`. Manual installs get the cleaned archive stem and
  no upstream link.
- A single-folder archive is **not** a bundle (unchanged behavior).

## Scan — group a container into one bundle

`src-tauri/src/mods/scan.rs` already descends into container folders (`b41666e`). On top of that:

- A container that has a `.sts2mm-bundle.json` sidecar is a **bundle**. Its member subfolders are
  scanned as today, and each member `ModInfo` is tagged with `bundle_id` = the container folder
  name.
- `get_installed_mods` returns the flat mod list as today (members included, each carrying
  `bundle_id`); a sibling command `get_bundles` returns each container's sidecar data
  (`display_name`, link, version). The frontend composes rows from the two.

## Source linking at the bundle level

The Nexus link lives in the bundle sidecar, not on any member. So **no member reads `UNLINKED`** —
the link is owned by the container and shown once on the bundle row.

## Version management & updates

- The bundle version is the Nexus mod version (`installed_version` in the sidecar), shown once on
  the bundle row. Member manifest versions (0.1.31, 1.0.4 …) are internal.
- Update checks (`src-tauri/src/updater.rs`) run **once per bundle** against its link — the same
  path a single Nexus mod uses today.
- Applying an update re-acquires the archive the way a single Nexus mod updates today
  (user-initiated download → auto-install; API where available) and re-installs the container:
  replace the container's contents with the new archive and rewrite the sidecar. The
  downloads-watcher recognizes the same bundle by its `nexus_mod_id`.

## UI — one row per bundle

`src/components/LibraryTable.tsx`, `LibraryRow.tsx`, `src/views/Mods.tsx`:

- **Comfortable view:** the bundle's `display_name` as the row title, the Nexus badge + link, the
  bundle version, the standard row controls; beneath the title, a compact, aligned list of member
  mod names in small text — a single column that wraps into additional columns to the right when
  vertical space is tight.
- **Minified view:** the `display_name` only.
- A subtle "N mods" affordance (existing `Badge` styling) signals it contains several mods, without
  imposing the word "pack" or "bundle".
- Controls are **bundle-level**: the Active-in-game / Stored toggle, delete, and add/remove-modpack
  act on the whole container.

Frontend grouping: members share a `bundle_id`; they collapse under one bundle row built from the
`get_bundles` sidecar data. Everything without a `bundle_id` renders exactly as today. The `Mod`
type and a new `Bundle` type live in `src/types.ts`.

## Operations — operate on the container folder

Bundle-aware commands in `src-tauri/src/mods/mod.rs`:

- **Toggle (Active in game / Stored):** move the whole container folder between `mods/` and
  `mods_disabled/`. (`scan_disabled_mods` uses the same descent, so members stay visible while stored.)
- **Delete:** remove the container folder. Because the container *is* the bundle, this removes
  exactly the members inside it and **nothing outside the folder** — there is no member list to
  consult and no way to touch an unrelated mod. The confirm dialog names what's inside.
- **Modpack add/remove:** the container is one member of a modpack. (`src/components/ModpackDetail.tsx`
  and the profiles module operate on the container folder.)

## Home "Switch modpack" button removal (folded into this work)

The Home view still renders a "Switch modpack" action that duplicates the always-visible topbar
profile chip (the 1.7.0 cleanup removed the hero copy but one remains). Remove the remaining Home
button and update its tests (`src/views/Home.tsx`, `src/views/Home.test.tsx`, and any assertion in
`src/App.test.tsx`). The topbar chip remains the single way to switch modpacks.

## Existing installs → re-install to convert

No auto-detection. A folder already on disk doesn't carry a sidecar, so it shows as today
(individual members, or a plain container). Re-installing the download once writes the sidecar and
the nice container name, converting it to a managed bundle. Documented in Help / FAQ.

## Edge cases & limitations

- **Shared frameworks:** a framework like `VoiceModFramework` that lives inside the bundle's
  container is removed when the bundle is deleted (it is "inside the folder") — and is
  re-installable. If the user wants it standalone too, they install it separately, where it lives
  as its own top-level mod folder, untouched by the bundle's container.
- **Mixed enable state:** not reachable through the UI (the container moves as one). External edits
  are reflected on next scan.
- **Single-folder downloads:** never a bundle.
- **Non-Nexus bundles:** still grouped via the sidecar (members + cleaned archive-stem name); they
  simply have no upstream version/update source.

## Affected components

Backend:
- `src-tauri/src/mods/bundle.rs` (new) — `BundleSidecar` type, read/write, is-bundle detection.
- `src-tauri/src/mods/install.rs` — name the container after the pack; write the sidecar for
  ≥2-member archives.
- `src-tauri/src/mods/scan.rs` — recognize a sidecar container as a bundle; tag members with
  `bundle_id`.
- `src-tauri/src/downloads_watcher.rs` — fill the sidecar (display name + link + version) on
  Nexus / auto-install.
- `src-tauri/src/mods/mod.rs` — `get_bundles`; `bundle_id` on `ModInfo`; bundle-aware toggle/delete.
- `src-tauri/src/updater.rs` — bundle-level update check + whole-container re-install.
- profiles module — bundle (container) as a modpack member unit.
- `src-tauri/src/lib.rs` — register new commands.

Frontend:
- `src/types.ts` — `Mod.bundle_id?`, a `Bundle` type.
- `src/components/LibraryTable.tsx`, `LibraryRow.tsx` — group + render bundle rows + member list.
- `src/views/Mods.tsx`, `src/hooks/useModLibrary.tsx`, `src/contexts/AppContext.tsx`,
  `src/hooks/useTauri.ts` — fetch + thread bundle data and actions.
- `src/components/ModpackDetail.tsx` — bundle as one modpack member.
- `src/views/Home.tsx` (+ `Home.test.tsx`, `App.test.tsx`) — remove the redundant "Switch modpack" button.
- `src/styles.css` — member-list layout.
- `src/i18n/locales/en.json` + `zh-Hans.json` — new/removed strings (added together).

## Suggested implementation phasing

1. **Sidecar + install naming + scan grouping + read-only one-row display + linking.** Resolves
   `UNLINKED` and "one row" immediately. Includes the Home button removal (small, independent).
2. **Bundle operations** — container-level toggle, delete, modpack add/remove.
3. **Bundle updates** — bundle-level update check + whole-container re-install in `updater.rs`.

## Testing strategy

- **Rust** (extend `install.rs`, new `bundle` tests, `scan.rs`, `tests/qa_scenarios.rs`):
  installing a ≥2-member archive creates one named container with a sidecar; the source lands in
  the sidecar (no member `UNLINKED`); scan groups the container into one bundle with its members
  tagged; a single-folder archive creates no bundle; bundle delete removes the container and only
  the container; bundle toggle moves the container; an update replaces container contents + rewrites
  the sidecar.
- **Frontend (vitest):** `LibraryTable` groups members under one bundle row; comfortable shows the
  member list, minified shows the name only; bundle controls invoke the bundle commands; the Home
  "Switch modpack" button is gone and switching still works via the topbar chip; non-bundled mods
  unchanged. Loud-lookup conventions — no `if (btn) { click(btn) }` silent-skips.

## Out of scope (future)

- Auto-detecting bundles for already-installed (sidecar-less) folders.
- Per-member controls (toggle/delete a single member).
- Author-declared bundle manifests inside the archive.
