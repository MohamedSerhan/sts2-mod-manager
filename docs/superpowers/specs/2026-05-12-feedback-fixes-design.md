# User-feedback fixes (#1, #3, #4, #5)

Driven by user feedback. Six items came in; two (#2 mod load order, #6 config-overwrite detection) need their own design passes and are filed as GitHub issues #34 and #35. This spec covers the four small/bounded items that ship together.

## Scope

- **#1** — Accept `.7z` and `.rar` archives in addition to `.zip` at install
- **#3** — Free-form note + custom (non-Nexus/GitHub) link per mod
- **#4** — Snooze the audit's update suggestion until the next release
- **#5** — Fix: Nexus link association resets on update *(bug)*

Out of scope (filed separately):
- **#2** mod load order — needs reverse-engineering `settings.save` or recommending LoadOrderManager. Issue [#34](https://github.com/MohamedSerhan/sts2-mod-manager/issues/34).
- **#6** config-file overwrite detection — needs snapshot/diff design. Issue [#35](https://github.com/MohamedSerhan/sts2-mod-manager/issues/35).

## #5 — Fix: Nexus link reset on update

**Root cause.** Two paths in `src-tauri/src/downloads_watcher.rs` write/read source entries by **display name** while everywhere else uses **folder-first** keying (since v1.3+):

- `transfer_mod_sources(old_name, new_name, …)` at line 580 — uses `db.mods.remove(old_name)` and `db.mods.insert(new_name, …)`. If the existing entry is folder-keyed, removal misses and the new entry is empty.
- `attach_pending_nexus_source(installed_name, …)` at line 664 — writes `db.mods.entry(installed_name).or_default()`, creating a name-keyed entry that gets shadowed by folder-first reads.

Result: on a Nexus update, the user's Nexus URL ends up in a different DB key from the folder-keyed entry. `enrich_mods_with_sources` returns the folder-keyed entry (no Nexus URL) → audit reports "no source" → user re-enters.

**Fix.**
- `transfer_mod_sources` → take `(old_folder, new_folder, old_name, new_name, config_path)`. Look up entry via `lookup_entry` (folder-first). Write to new folder key.
- `attach_pending_nexus_source` → take `(installed_name, folder_name, …)`. Look up existing entry folder-first; write to folder key when available.
- Update both call sites in `downloads_watcher.rs` (≈ line 200-220) to pass folder names from `existing_mod` and `mod_info`.
- Optional cleanup: a one-shot "fold split keys" migration that on next launch merges any (name-keyed, folder-keyed) pair pointing at the same mod into a single folder-keyed entry. Deferred unless trivial.

**Tests.**
- `mod_sources.rs` unit test: transfer where source entry is folder-keyed.
- `mod_sources.rs` unit test: `attach_pending_nexus_source` writes folder-keyed when folder is provided.
- Regression test for: install → set Nexus URL → simulate Nexus update (new zip dropped) → assert Nexus URL still resolves via `enrich_mods_with_sources`.

## #3 — Free-form note + custom link

**Data.** Add two fields to `ModSourceEntry` (Rust, in `mod_sources.rs`):

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub note: Option<String>,
#[serde(default, skip_serializing_if = "Option::is_none")]
pub custom_url: Option<String>,
```

Mirror in TS as optional fields on `ModInfo`, `ModSourceEntry`, and `ModAuditEntry`.

Single `custom_url` (string) — not a list — keeps UI simple. Forward-compatible: `Vec<{label, url}>` can be added later as a second field while keeping `custom_url` as a shorthand alias.

**Backend.** New Tauri command `set_mod_extras(mod_name, folder_name, note, custom_url)`. Empty strings clear. Folder-keyed write. `enrich_mods_with_sources` plumbs `note` and `custom_url` onto `ModInfo`.

**UI.** Extend `src/components/SourceEditor.tsx` with two more fields below the existing GitHub/Nexus grid:
- "Note" — textarea (1–3 lines), free text
- "Other link" — single URL input, format hint: any URL (X, Patreon, Discord, etc.)

When `custom_url` is set, the mod row shows an external-link button (alongside the existing GitHub/Nexus chips).

**Tests.** Roundtrip persistence; empty-string-clears; folder-keyed-write; UI test that the field round-trips through save.

## #4 — Snooze audit update suggestion until next release

**Distinct from pin.** Pin = hard freeze (no auto-update, no auto-install, opaque to audit). Snooze = "don't bug me about this specific upstream version; if I trigger Update myself it still works; when a newer release appears the snooze auto-expires."

**Data.** Add to `ModSourceEntry`:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub snoozed_until_tag: Option<String>,
```

**Backend.** In the audit pipeline (where `ModAuditEntry` is assembled):

- Add `snoozed: bool` to `ModAuditEntry`.
- `snoozed = entry.snoozed_until_tag.as_deref() == latest_release_with_assets_tag.as_deref() && snoozed_until_tag.is_some()`.
- Do **not** mutate `needs_update` in the backend — keep it source-of-truth. Frontend filters on `snoozed`.

**Frontend.** `src/lib/auditState.ts`:

- `isUpToDate(entry)` returns true when `entry.snoozed` is true (in addition to existing conditions).
- `countGithubUpdates(entries)` skips entries where `entry.snoozed` is true.

**UI.** Per-row "Snooze update" menu action in the audit row's kebab. When snoozed: muted "snoozed until next release" badge + "Unsnooze" affordance. Snooze action stores the *current* `latest_release_with_assets_tag` into `snoozed_until_tag`. Unsnooze clears the field.

**Tests.** `auditState.test.ts`:
- `isUpToDate` returns true when snoozed.
- `countGithubUpdates` skips snoozed.
- Snooze expires automatically when `latest_release_with_assets_tag` advances past the stored tag.
- Snooze + pin interaction: pin wins (pinned mods stay out of audit entirely).

## #1 — Accept `.7z` and `.rar` archives

**Approach.** Refactor the install entrypoint to dispatch by extension.

- Rename `install_mod_from_zip` → `install_mod_from_archive` (and add a `pub use install_mod_from_zip = install_mod_from_archive` shim if needed — there are ~6 callers within the crate, all updateable in one pass).
- Dispatch:
  - `.zip` → existing `zip` crate path
  - `.7z` → `sevenz-rust2` crate (pure Rust, MIT)
  - `.rar` → `unrar` crate (Rust wrapper around RARLab's official unrar C source — license permits decompression; built statically)
  - Anything else → existing "not a mod archive" error.
- All three extractors funnel through one shared helper that does the wrap-folder logic and zip-slip safety. Extract the helper from the current `install_mod_from_zip` body so the three archive readers each just produce `(safe_relative_path, file_bytes)` iterators.

**License + crate verification.** Before adding deps, verify on crates.io (live) that:
- `sevenz-rust2` is the current maintained 7z extractor and is MIT/Apache-2.
- `unrar` (Rust crate) is current and its license terms are compatible with our shipped binaries.
- If either fails verification, fallback is bundling a per-OS 7-Zip CLI as a Tauri sidecar and shelling out for non-zip archives. Decided at implementation time; documented in the implementation plan.

**Tests.** Add fixtures under `qa/fixtures/zips/`:
- `test.7z` — same content as an existing zip fixture for parity testing.
- `test.rar` — same.

Mirror `install_mod_from_zip_handles_bom_manifest` for each archive format. Add a test that an unsupported extension returns the existing error.

## Risk + rollout

- **Backward compatible.** All `ModSourceEntry` additions are optional with serde defaults — existing `mod_sources.json` files continue to load. No migration script required.
- **Binary size.** `sevenz-rust2` and `unrar` together add roughly 500 KB–1 MB to the installer. Acceptable.
- **Sidecar fallback.** If a crate fails license verification, bundling 7-Zip CLI is the alternative — adds ~1.5 MB per-OS but covers more formats.
- **No `settings.save` writes.** Stays clear of #2's risk surface.

## Release

- One worktree, four commits (one per item, in order #5 → #3 → #4 → #1), single PR to `main`.
- Patch version bump.
- Run `scripts/release.sh` after merge.
- Release blockers: `cargo test`, `cargo build --release`, `npm test`, `npm run build` all clean.

## Implementation order

1. **#5** first — pure bug fix, smallest blast radius, no schema change.
2. **#3** — additive schema change, exercises the migration-safety of `ModSourceEntry`.
3. **#4** — second additive schema change, depends on the same plumbing as #3.
4. **#1** — largest refactor, isolated to install pipeline. Do last so earlier items aren't blocked by it.
