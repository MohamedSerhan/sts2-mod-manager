# Issue #135 — Modpack Detail & Share-Flow Fixes Design

GitHub issue: https://github.com/MohamedSerhan/sts2-mod-manager/issues/135
(Supersedes #117. Translation tracking: #132.)

## Purpose

A batch of testing-feedback fixes that all touch the **modpack detail view / share
flow** (`ModpackDetail.tsx`, `PublishModal.tsx`, `AddModsMenu.tsx`,
`CreateModpackWizard.tsx`, the Advanced kebab, `profiles/`, `sharing/`). Bundled so
one change owns this surface and avoids conflicts.

Six sub-tasks:

1. **Out-of-sync / Re-share detection** — after editing a shared modpack, surface
   that it has unpublished changes and let the user push them.
2. **Remove the Snapshot feature** — drop the buggy "Snapshot" actions; replaced by
   a wizard option (item 3).
3. **"Start with all installed mods"** — a 4th Create-Modpack wizard strategy.
4. **Dedupe "Auto-detect sources"** — it appears twice in the Mod Library view.
5. **Share-code layout fix** — the code wraps one char per line in non-English locales.
6. **`.sts2pack` local export/import** — export/import a modpack as a self-contained
   offline archive (manifest + bundled mod files).

## Design Guardrails

- Not a visual redesign. Reuse the dark palette, `gf-*` CSS conventions, and existing
  shared components (`Button`, `Card`, `Badge`, `KebabMenu`, `KebabItem`,
  `ConfirmDialog`, lucide icons). Keep CSS in `src/styles.css`.
- Every user-visible string goes through `react-i18next`. **All four locales**
  (`en`, `ru`, `zh-Hans`, `ar`) are updated together so the `qa:i18n` parity test stays
  green. #132 tracks any later polish.
- Verify light theme and RTL (Arabic) for any layout change.
- Tests follow house style: loud element lookups, always assert visible behavior, no
  `if (btn) { click(btn) }` silent-skip patterns.

## Decisions (locked with maintainer)

- **Out-of-sync mechanism:** store a published-content fingerprint in `.share`; compare
  the current manifest against it. (Not drift — drift is manifest-vs-disk and only
  exists for the active pack.)
- **Export format:** `.sts2pack` — a zip archive that bundles the manifest **and** the
  mod files (offline sharing), not bare JSON.
- **Export/Import placement:** the new file flows **take over** the existing
  "Export JSON" (clipboard) kebab item and "Import JSON" (paste) list-page button. The
  old clipboard/paste flows are removed.
- **i18n:** translate all new strings in this PR for every locale.
- **Delivery:** one PR, clean per-item commits, in the order in this document. Item 6 is
  separable if it needs to move to a follow-up.

---

## Item 2 — Remove the Snapshot feature *(do first; clears the surface)*

Snapshot was buggy (it captured all installed mods regardless of enabled state) and is
superseded by the wizard option in item 3.

**Backend**

- Delete the `snapshot_profile` command (`src-tauri/src/profiles/mod.rs:527`) and its
  registration in `src-tauri/src/lib.rs:338`.
- **Keep** `snapshot_current_with_sources` / `snapshot_current_with_paths` /
  `snapshot_current_inner` in `apply.rs`. `create_profile` calls
  `snapshot_current_with_sources` directly — these are generic "capture current disk
  state" helpers, not snapshot-command-specific. Removing the command does **not** break
  create.

**Frontend**

- Remove the `snapshotProfile` wrapper (`src/hooks/useTauri.ts:178`).
- Remove `handleSnapshot` and the "Snapshot active modpack" header button in
  `src/views/Profiles.tsx`, plus the `onSnapshot` wiring passed to `ModpackDetail`.
- Remove the `onSnapshot` prop + "Snapshot from current install" kebab item in
  `src/components/ModpackDetail.tsx:631`. Drop the now-unused `Camera` icon import if
  nothing else uses it.

**i18n / tests**

- Remove the 5 snapshot keys from all 4 locales: `profiles.actions.snapshotCurrent`,
  `profiles.prompt.snapshotName`, `profiles.kebab.snapshotFromCurrent`,
  `profiles.toast.snapshotCreated`, `profiles.toast.snapshotFailed`.
- Remove the snapshot tests: blocks in `Profiles.test.tsx`, `ModpackDetail.test.tsx`,
  `useTauri.test.ts`, and the 3 Rust tests in `src-tauri/tests/qa_scenarios.rs`
  (`flow_10_…`, `snapshot_filter_strips_incompatible_…`,
  `non_publishing_snapshot_preserves_incompatible_…`). Keep create-from-enabled and
  drift tests.

**Acceptance:** no "Snapshot" affordance anywhere; `create_profile` and the wizard still
work; all suites green after key/test deletions.

---

## Item 3 — "Start with all installed mods" wizard option

The Snapshot replacement, as a 4th starting strategy in `CreateModpackWizard.tsx`.

- Add `Strategy = 'allInstalled'` alongside `'fromActive' | 'empty' | 'clone'`.
- In `applyStrategyAndAdvance`, seed `selectedMods` with **every** installed mod
  (`mods.map(m => m.folder_name ?? m.name)`) — enabled **and** disabled — versus
  `fromActive` which is enabled-only.
- Render a `StrategyOption` tile between "From my active mods" and "Empty".
- No backend change: `handleCreate` already snapshots the whole install and prunes to the
  selection, so "all installed" just means a pre-selected select-all.
- New i18n keys `createModpack.step1AllInstalled` + `createModpack.step1AllInstalledDesc`
  (×4 locales).

**Acceptance:** picking the option lands on step 2 with all installed mods checked; the
created pack contains exactly them.

---

## Item 4 — Dedupe "Auto-detect sources"

**Correction to the issue's file pointer.** The modpack **detail** view is already
deduped: `ModpackDetail.tsx:460` renders `<AddModsMenu lib={lib} />` with the default
`includeAutoDetect={false}`, so auto-detect there lives only in the Advanced kebab
(`ModpackDetail.tsx:668`). The genuine duplication is in the **Mod Library** view —
auto-detect renders both as a standalone toolbar button (`src/views/Mods.tsx:233`) **and**
inside the "+ Add mods" menu (`src/components/ModLibraryToolbar.tsx:37` passes
`includeAutoDetect`).

**Fix**

- Remove `includeAutoDetect` from `ModLibraryToolbar.tsx:37` (keep the standalone button).
- No caller then sets `includeAutoDetect={true}`, so delete the dead `includeAutoDetect`
  prop and its `KebabItem` branch from `AddModsMenu.tsx`.
- Update `Mods.test.tsx` to assert auto-detect appears exactly once (the standalone
  button), not in the "+ Add mods" menu.

**Acceptance:** in the Mod Library, "Auto-detect sources" appears once.

---

## Item 5 — Share-code layout bug (non-English locales)

**Root cause.** `.gf-share-code` (`src/styles.css:2532`) is a single flex row holding the
code text (`flex: 1; min-width: 0`) plus three copy buttons. Longer translated button
labels (e.g. Russian "Скопировать код") widen the buttons, collapse the code column, and
`.gf-share-code-value { word-break: break-all }` then wraps the code one character per
line.

**Fix (layout-level, robust across locales).**

- In `PublishModal.tsx:461`, wrap the three copy buttons in a
  `<div className="gf-share-code-actions">`.
- CSS:
  - `.gf-share-code { flex-wrap: wrap }`
  - `.gf-share-code-text { flex: 1 1 160px }` (a flex-basis so the code keeps a readable
    width; buttons wrap below when cramped instead of crushing it)
  - `.gf-share-code-value`: replace `word-break: break-all` with
    `overflow-wrap: anywhere` (break only when genuinely necessary, not per char)
  - `.gf-share-code-actions { display: flex; gap: 8px; flex-wrap: wrap }`
- Verify light theme and RTL (Arabic). Colors already use CSS vars, so light theme should
  carry over; confirm visually.

**Acceptance:** the share code stays on one readable line (wrapping only for an unusually
long owner), with copy buttons wrapping to a second row when space is tight, in en/ru/ar
and both themes.

---

## Item 1 — Out-of-sync / Re-share detection

**Problem.** After editing a shared modpack, the tester saw no "you have unpushed changes"
cue and had no obvious way to push the update. Drift (`profiles/drift.rs`) is the wrong
signal: it compares the manifest to the live `mods/` folder and is only computed for the
**active** pack, so editing a non-active shared pack never registers. And nothing records
what was last published, so "has this changed since publish?" is unanswerable today.

**Mechanism: store a published-content fingerprint.**

- Add `published_signature: Option<String>` to `ShareInfo` (the `.share` file,
  `src-tauri/src/sharing/mod.rs:174`), `#[serde(default)]` for back-compat with existing
  `.share` files.
- A pure `fn profile_publish_signature(&Profile) -> String` computes a sha256 over the
  pack's **stable publishable content**:
  - mods sorted by `mod_key`, each contributing `name`, `version`, `folder_name`,
    `mod_id`, `enabled`, `source`, `hash`;
  - plus `name`, `created_by`, `public`.
  - **Excludes** `created_at` / `updated_at` (volatile) and `bundle_url` /
    `bundle_sha256` (publish-side artifacts). So a plain re-share doesn't count as a
    change, but a membership/version/enabled edit does.
- Set `published_signature` in both `share_profile` and `reshare_profile` after the final
  profile is built, writing it into the `.share` file.
- Add `out_of_sync: bool` to `ShareResult` (`#[serde(default)]`). `get_share_info`
  loads the current profile, recomputes the signature, and sets
  `out_of_sync = signature != stored` — but `false` when `published_signature` is `None`
  (old `.share`: don't nag until the next share establishes a baseline).

**Frontend.**

- `ShareResult` TS type gains `out_of_sync?: boolean`.
- `ModpackDetail.tsx` renders an **"Out of sync — you have changes you haven't pushed"**
  banner (reuse `gf-banner gf-banner-warn`, consistent with the existing drift banner)
  with a **Re-share** button (calls the existing `onShare(profile)`), shown whenever
  `shareInfo?.out_of_sync`. Works for any owned share, active or not. Kept visually and
  textually distinct from the list-page drift banner.
- The Share-button label already flips to "Re-share" off `isShared` (`!!shareInfo`).
  Ensure the parent updates `shareInfoMap[name]` after a successful share/re-share (via
  `onShared`) so the detail view reflects the new state (button + banner) immediately,
  without a full reload.

**Tests.**

- Rust: signature changes when a mod is added/removed/toggled/version-bumped; is stable
  across a re-share with no content change; `out_of_sync` is `false` for a `.share` with
  no `published_signature`.
- Vitest: banner renders when `shareInfo.out_of_sync` is true and the Re-share button
  calls `onShare`; banner is absent when false/!shared.

**Acceptance:** edit a shared pack → "Out of sync" banner appears and Share reads
"Re-share"; push via Re-share → banner clears.

---

## Item 6 — `.sts2pack` local export/import

A self-contained offline modpack archive: hand a `.sts2pack` file to a friend; importing
it installs the mods and creates the pack, no GitHub required. Reuses the existing
share/bundle machinery.

### Archive format

A zip (outer compression `Stored`, since contents are already compressed) containing:

```
profile.json            # the Profile manifest (serde_json pretty)
mods/<key>.zip          # one Deflated per-mod zip, key = sanitized folder_name ?? name
```

Per-mod zips are produced by the existing
`zip_profile_mod_files(pm, mods_path, disabled_path)`
(`src-tauri/src/sharing/upload.rs:148`), which already validates files and handles the
enabled/disabled split. Each mod also carries `bundle_sha256` in the manifest for
import-time integrity (optional but cheap).

### Backend — new module `src-tauri/src/export_import.rs`

- `export_profile_to_sts2pack(name: String, dest_path: String, state) -> Result<()>`
  1. Load the profile.
  2. For each mod, `zip_profile_mod_files(...)` → write to a temp staging dir as
     `mods/<key>.zip`.
  3. Write `profile.json` into staging.
  4. Zip staging → `dest_path` (reuse `repack_dir_as_zip` from
     `src-tauri/src/mods/install.rs:88`, or a direct `ZipWriter` with `Stored`).
- `import_sts2pack(src_path: String, state) -> Result<Profile>`
  1. Extract `src_path` to a temp dir (the `zip::ZipArchive` pattern from
     `download_bundle`, with the same zip-slip guards).
  2. Read + parse `profile.json`.
  3. For each `mods/*.zip`, `install_mod_from_archive(zip, mods_path)`
     (`src-tauri/src/mods/install.rs:225`) — reuses all extraction/safety/wrap logic.
  4. Rebuild the profile from the install results (corrected `folder_name`/`files`),
     keyed by the manifest, mirroring `install_shared_profile`.
  5. Resolve name collisions by auto-suffixing (`"Pack (2)"`), preserve `created_by`
     for attribution, save the profile. **No** `.share`, **no** auto-subscribe (it's a
     local import). Do not auto-activate (leave the user's active pack alone) — match how
     a freshly created pack behaves; confirm against current create UX during
     implementation.
- Register both commands in `lib.rs`. Add `exportProfileToFile` / `importSts2pack`
  wrappers in `useTauri.ts`.

### Frontend — take over the existing buttons

- Detail Advanced kebab: the "Export JSON" item (today copies manifest JSON to clipboard
  via `handleExport`) becomes **"Export to file…"** → `@tauri-apps/plugin-dialog` `save()`
  with a `.sts2pack` filter + suggested filename `<pack>.sts2pack` →
  `exportProfileToFile(name, path)` → success toast. Remove the clipboard path.
- Modpacks list page: the "Import JSON" button + paste textarea (`handleImport` /
  `importProfile`) becomes **"Import from file…"** → `open()` with a `.sts2pack` filter →
  `importSts2pack(path)` → refresh profiles + success toast. Remove the paste panel and
  the `import_profile_cmd` paste path if it has no other caller (verify;
  `export_profile_cmd`/`import_profile_cmd` may be removable).
- New i18n keys for both flows + progress/error/success copy (×4 locales).

### Tests

- Rust: export→import round-trip in a temp game dir — a 2-mod pack (one enabled, one
  disabled) exports, then imports into a fresh dir, and the resulting profile + installed
  mods match (folders, enabled state, membership). Name-collision suffixing.
- Vitest: "Export to file" opens the save dialog and calls `exportProfileToFile` with the
  chosen path; "Import from file" opens the open dialog and calls `importSts2pack` then
  refreshes. Mock `@tauri-apps/plugin-dialog`.

**Acceptance:** export a pack to `.sts2pack`, import it on a clean install → identical
mods + pack, no network.

---

## Cross-cutting

- **i18n parity:** every new key added to `en`, `ru`, `zh-Hans`, `ar` with real
  translations; removed keys deleted from all four. `npm run qa:i18n` stays green.
- **Test discipline:** loud lookups, assert visible behavior, no silent-skip; reuse the
  `setup.ts` / `AllProviders` Tauri-mock plumbing.
- **Verification before completion:** `npm test` (Vitest), `npm run qa:i18n`, and
  `cargo test` (workspace) all green; manual light-theme + RTL check for items 5 and 1.

## Out of scope

- Changing the existing list-page drift (manifest-vs-disk) banner.
- File-association registration for `.sts2pack` (double-click-to-open) — future work.
- Remote/published-manifest fetching for out-of-sync (local fingerprint only).
