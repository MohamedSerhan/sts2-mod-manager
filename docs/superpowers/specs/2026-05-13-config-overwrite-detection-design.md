# Config-file overwrite detection (#35)

Closes [#35](https://github.com/MohamedSerhan/sts2-mod-manager/issues/35).

User feedback: when a mod is updated, any config files the user has edited inside the mod folder get overwritten by the new release's defaults, silently losing their edits.

## Goal

On update, preserve config files the user has edited — without prompting, without false alarms. Always-overwrite (current behavior) loses user work; always-preserve hides upstream's new defaults and missing keys. The sweet spot: **preserve only files that actually differ from what shipped**.

## Approach in one paragraph

At install time, hash every config-looking file in the new mod and stash the hashes in the mod's source entry. On the next update, before extracting the new archive, compare each on-disk config against the stored hash: any that differ are user-edited and get carried forward; the rest are safe to overwrite. After install completes, recompute the snapshot so the next update has a fresh baseline. The user sees a non-blocking toast naming the preserved files; everything else is invisible.

## Data shape

Single field on `ModSourceEntry` (Rust):

```rust
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ModSourceEntry {
    // … existing fields …
    /// SHA256 of each tracked config file at install time, keyed by the
    /// file's path relative to the mod folder (forward-slash separators,
    /// even on Windows, to match the rest of the codebase).
    ///
    /// Compared against on-disk hash during the next update to decide
    /// which files the user has edited and must be preserved. Rewritten
    /// at the end of every install — short-lived rolling cache, not a
    /// permanent audit log. Empty when the mod was last installed before
    /// this feature shipped, in which case no preservation runs (update
    /// behaves as today).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub config_hashes: std::collections::HashMap<String, String>,
}
```

TS mirror on `ModSourceEntry` and `ModInfo`. UI doesn't read this directly — it's backend bookkeeping that surfaces through the post-install toast.

## Tracked file set

Extension allowlist: `.cfg`, `.ini`, `.toml`, `.txt`.

Explicitly **not** tracking `.json`. In the STS2 modding ecosystem `.json` is game-readable manifest / data only — mods that expose user-tunable settings use one of the four extensions above. Tracking `.json` would risk preserving a stale manifest (declaring old version + dependencies) into a new install, which would confuse the game's loader and our audit. Keeping the allowlist tight to actual config formats removes that whole class of risk and eliminates the manifest-detection logic entirely.

Scope:

- Recursive walk under the mod folder. Most configs live at the top level but some mods (e.g. anything with localization or per-card overrides) ship configs in subfolders.
- Skip `.sts2mm-backup/` and any other `.sts2mm-*` sidecars we create.
- Skip files larger than 1 MiB. Configs are small; a multi-megabyte file with a config-shaped extension is more likely a packaged data blob than user-tunable settings. Avoids hashing-time blow-up on weird mods.

## When we snapshot

A single helper `snapshot_mod_configs(mod_folder, mods_path) -> HashMap<String, String>`:

- Walks the mod folder
- Filters by the allowlist above (with the manifest exclusion)
- Computes SHA256 of each file
- Returns `{rel_path: hash}`

Called from the install pipeline **after** a successful install — wraps `install_mod_from_archive`'s result. Writes into the mod's `ModSourceEntry.config_hashes` keyed folder-first (same pattern as `installed_version`).

## When we preserve

A new helper `preserve_user_edits(mod_folder, mods_path, stored_snapshot) -> Vec<PreservedFile>`:

- For each entry in `stored_snapshot`: if the file still exists on disk and its current hash differs from the stored hash → user-edited → read into memory, return as a `PreservedFile { rel_path, bytes }`.
- For each on-disk file in the tracked set NOT in `stored_snapshot`: the user created it after install → also preserved.
- Returns the list. Caller responsible for re-writing the bytes into the new folder after extract.

A companion `restore_preserved(mod_folder, preserved)` writes them back, creating parent directories as needed.

## Where it hooks into the install pipeline

Every "update existing mod" call site follows the same shape today:

1. Find old mod folder (`existing_mod` / `mod_info` / `installed.find(...)`)
2. Delete old files (`remove_dir_all` / per-file)
3. Call `install_mod_from_archive` (or `install_mod_from_zip` for GitHub release paths)

We add a wrapper around steps 2-3:

```rust
pub fn install_update_preserving_configs(
    archive_path: &Path,
    mods_path: &Path,
    config_path: &Path,
    old_folder: &str,        // folder to wipe
    old_name: &str,          // for snapshot lookup
) -> Result<UpdateResult> {
    // 1. Read snapshot from mod_sources entry
    let snapshot = load_snapshot(old_folder, old_name, config_path);

    // 2. Identify + read user-edited files
    let preserved = preserve_user_edits(
        &mods_path.join(old_folder),
        mods_path,
        &snapshot,
    );

    // 3. Delete + extract (existing behavior)
    fs::remove_dir_all(mods_path.join(old_folder))?;
    let info = install_mod_from_archive(archive_path, mods_path)?;

    // 4. Overlay preserved files into new folder
    let new_folder = info.folder_name.as_deref().unwrap_or(&info.name);
    restore_preserved(&mods_path.join(new_folder), &preserved)?;

    // 5. Refresh snapshot
    let new_snapshot = snapshot_mod_configs(&mods_path.join(new_folder), mods_path);
    write_snapshot(new_folder, new_name, new_snapshot, config_path);

    Ok(UpdateResult { info, preserved })
}
```

`UpdateResult.preserved` flows up to the frontend so the toast can name the files.

Call sites updated:

- `downloads_watcher.rs:200` — the auto-install-from-Downloads path
- `updater.rs::update_mod` — the per-mod Update button
- `updater.rs::repair_mod` — walk-back repair (preservation still desirable; user's tweaks shouldn't die because they're on the wrong release for a beat)
- `updater.rs::update_all_mods` — bulk update path

`install_mod_from_file` (manual file picker) and the initial-install paths (Quick Add, share-code import, `download_mod_from_github_release` for first-time installs) **don't** route through `install_update_preserving_configs` — there's nothing to preserve on a fresh install. They take the existing `install_mod_from_archive` path and only the snapshot-refresh step fires.

## When the snapshot is missing (rollout case)

A mod installed before this feature ships has no `config_hashes` entry. On its first update post-launch:

- `preserve_user_edits` sees an empty snapshot → returns empty
- Update proceeds exactly as today (everything in the old folder is wiped, new archive extracted)
- The post-install snapshot pass fires, so the *next* update has data to compare against

No migration code, no "assume everything is user-edited" heuristic. Users who already have edited configs lose those edits once (during the first update after this lands) — but every update from then on preserves them. Acceptable rollout cost; explicitly called out in the CHANGELOG entry.

## UX

Single toast after a successful update, only when at least one file was preserved:

> **Updated `<ModName>` — preserved 2 config files you edited**

With the filenames in the toast's `title` attribute (browser-style tooltip on hover) so curious users can confirm what was kept without us needing a separate modal. No clicks required, no confirmation prompts, no blocking dialogs — matches the "seamless update" intent.

When zero files are preserved: no toast (the existing update-success toast already fires).

Failure mode: if `restore_preserved` fails partway (disk full, permission denied), we surface a destructive-action toast with the failure reason. The preserved files' bytes are still in memory at that point; if the user retries the operation we can re-emit them.

## Tests

Rust (in `mod_sources.rs` and `mods.rs`):

- `snapshot_mod_configs` includes the four tracked extensions, walks recursively, skips files > 1 MiB and `.sts2mm-*` sidecars, ignores `.json` (we don't track it).
- `preserve_user_edits` returns files where hash differs, includes new files not in snapshot, skips files matching snapshot.
- Round-trip: install fixture → edit a config → snapshot has install-time hash → update fixture → user's edited config survives → new snapshot reflects the now-final state.
- Empty snapshot (rollout case): preserve returns nothing, update proceeds normally, post-install snapshot populates.

Vitest:

- ModSourceEntry / ModInfo type plumbing.
- Toast appears with correct count + filenames when an update preserves files.
- No toast when zero files preserved.

QA cassette / smoke:

- A new fixture: a mod with a `config.cfg` whose contents we mutate between "install" and "update" cassette frames. Smoke spec asserts the file's content matches the user-edited value, not the upstream default.

## Risk + rollout

- **Disk space.** Preserved files are held in memory between delete and restore. For a normal-sized config (few KB) this is fine. We refuse to preserve files > 1 MiB by the size-limit guard.
- **Backward compat.** `config_hashes` field uses `#[serde(default)]` and `skip_serializing_if = "HashMap::is_empty"`, so existing `mod_sources.json` files load unchanged.
- **Pinned mods.** Pinned mods don't auto-update, so this code path doesn't fire for them. Manual update of a pinned mod (user explicitly clicks Update on a pinned row) goes through the same preservation logic — no special handling needed.

## Out of scope

- Three-way merge (mod author adds a new key, user edited the file too). Hard problem; current design preserves the user's whole file and the user has to manually pull in upstream changes if they want them. The toast names the file so they can investigate.
- Format-aware merging (parse JSON / TOML and merge key-by-key). Same problem; same answer. Could be added later as a per-extension upgrade without changing the storage model.
- Restoring from a deleted-but-preserved file. The "I uninstalled the mod and want my old config back" recovery flow. Not in this design; if the user is uninstalling, they're saying they don't want the mod or its data.

## Release plan

Patch version bump. Tests pass full suite. Single PR / one merge to main. CHANGELOG entry:

> Updates no longer overwrite config files you've edited. If you changed a mod's `.cfg`, `.ini`, `.toml`, or `.txt` after installing it, the updater keeps your edits and a toast tells you which files were preserved. (Edits made before this version's release won't be detected once — the rolling snapshot starts fresh on the first update after upgrading.)
