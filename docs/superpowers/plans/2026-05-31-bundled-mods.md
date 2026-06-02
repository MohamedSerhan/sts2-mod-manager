# Bundled Mods Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Treat a multi-mod download as one "bundle" — a single container folder under `mods/`, shown as one collapsible library row with one Nexus link and one version.

**Architecture:** The bundle *is* the container folder (STS2 loads mods nested under it — confirmed). A hidden `.sts2mm-bundle.json` sidecar inside the container carries the display name, Nexus link, and version; the filesystem is the source of truth for membership. Builds on `b41666e` (scan already descends into containers). No registry.

**Tech Stack:** Rust (Tauri backend), React + TypeScript (frontend), `serde`/`serde_json`, `react-i18next`, vitest.

**Base branch:** `feature/bundled-mods` (off `auto-fix/56` = `b41666e`).

**Verify commands:**
- Rust: `cargo test --manifest-path=src-tauri/Cargo.toml <filter>`
- Frontend: `npx vitest run <file>`

---

## Phase 1 — bundle visible as one row, linked, plus button removal

### Task 1: Remove the redundant Home "Switch modpack" button

**Goal:** Delete the Home view's "Switch modpack" button (it duplicates the always-visible topbar profile chip); switching still works via the chip.

**Files:**
- Modify: `src/views/Home.tsx:500-510` (the `gf-home-secondary-actions` block / the button)
- Modify: `src/views/Home.test.tsx:419-427` (remove the now-invalid test)
- Modify: `src/i18n/locales/en.json` (remove `home.secondary.switch`)
- Modify: `src/i18n/locales/zh-Hans.json` (remove the matching `home.secondary.switch`)

**Acceptance Criteria:**
- [ ] Home renders no "Switch modpack" button.
- [ ] If `gf-home-secondary-actions` has no remaining children, the wrapper `<div>` is removed too (check the surrounding JSX before deleting).
- [ ] The `onGoToProfiles` prop is left intact only if still used elsewhere in Home; if unused after removal, drop it from the component props and its call sites.
- [ ] Topbar profile chip still switches modpacks (untouched).
- [ ] `home.secondary.switch` removed from both locale files (and `home.secondary` object removed if empty).

**Verify:** `npx vitest run src/views/Home.test.tsx src/App.test.tsx` → PASS; `grep -rn "home.secondary.switch" src/` → no matches.

**Steps:**

- [ ] **Step 1: Read the exact JSX + surrounding block.** Read `src/views/Home.tsx` around lines 495–515 to see all children of `gf-home-secondary-actions` and whether `onGoToProfiles` is used elsewhere in the file.

- [ ] **Step 2: Update the failing test first.** In `src/views/Home.test.tsx`, delete the `it('Switch modpack routes to the Modpacks page', …)` block (419–427). Run `npx vitest run src/views/Home.test.tsx` and expect PASS (the suite no longer references the button).

- [ ] **Step 3: Remove the button.** Delete the `<button … onClick={() => onGoToProfiles?.()}> … {t('home.secondary.switch')}</button>` (Home.tsx ~503–509). If it was the only child of `gf-home-secondary-actions`, remove that wrapper div and its `activeProfile`-gated render. Remove the now-unused `Layers` import if nothing else uses it.

- [ ] **Step 4: Remove the i18n key.** Delete `"switch": "Switch modpack"` under `home.secondary` in `src/i18n/locales/en.json`; delete the matching key in `src/i18n/locales/zh-Hans.json`. If `home.secondary` is now empty in both, remove the empty object.

- [ ] **Step 5: Verify.** Run `npx vitest run src/views/Home.test.tsx src/App.test.tsx` → PASS. Run `grep -rn "home.secondary.switch" src/` → no matches.

- [ ] **Step 6: Commit.**
```bash
git add src/views/Home.tsx src/views/Home.test.tsx src/i18n/locales/en.json src/i18n/locales/zh-Hans.json
git commit -m "feat(home): remove redundant Switch modpack button (topbar chip is canonical)"
```

---

### Task 2: Bundle sidecar module

**Goal:** A backend module that defines the `.sts2mm-bundle.json` sidecar, reads/writes it, detects bundle containers, and computes a container name from an archive path.

**Files:**
- Create: `src-tauri/src/mods/bundle.rs`
- Modify: `src-tauri/src/mods/mod.rs` (add `pub mod bundle;` near the other `mod` declarations; re-export as needed)

**Acceptance Criteria:**
- [ ] `BundleSidecar` (serde) holds `display_name`, optional `nexus_url`/`nexus_game_domain`/`nexus_mod_id`/`github_repo`/`installed_version`.
- [ ] `SIDECAR_FILENAME` const = `.sts2mm-bundle.json`.
- [ ] `write_sidecar(container, &BundleSidecar)` and `read_sidecar(container) -> Option<BundleSidecar>` round-trip.
- [ ] `is_bundle_container(dir) -> bool` is true iff the sidecar file exists in `dir`.
- [ ] `bundle_container_name(archive_path) -> String` returns the sanitized, Nexus-suffix-stripped archive stem (reuse `strip_nexus_suffix` + `sanitize_path_segment`).

**Verify:** `cargo test --manifest-path=src-tauri/Cargo.toml mods::bundle` → all pass.

**Steps:**

- [ ] **Step 1: Write failing tests** in `src-tauri/src/mods/bundle.rs`:
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn sidecar_round_trips() {
        let dir = tempdir().unwrap();
        let s = BundleSidecar {
            display_name: "Alice Defect Visual Pack".into(),
            nexus_url: Some("https://www.nexusmods.com/slaythespire2/mods/979".into()),
            nexus_game_domain: Some("slaythespire2".into()),
            nexus_mod_id: Some(979),
            github_repo: None,
            installed_version: Some("2.0".into()),
        };
        write_sidecar(dir.path(), &s).unwrap();
        assert!(is_bundle_container(dir.path()));
        let back = read_sidecar(dir.path()).expect("sidecar reads back");
        assert_eq!(back.display_name, "Alice Defect Visual Pack");
        assert_eq!(back.nexus_mod_id, Some(979));
        assert_eq!(back.installed_version.as_deref(), Some("2.0"));
    }

    #[test]
    fn no_sidecar_is_not_a_bundle() {
        let dir = tempdir().unwrap();
        assert!(!is_bundle_container(dir.path()));
        assert!(read_sidecar(dir.path()).is_none());
    }

    #[test]
    fn container_name_strips_nexus_suffix_and_sanitizes() {
        // "AliceDefectSkin V2.0-979-2-1-1780132414 (1).zip" → nexus suffix stripped
        let name = bundle_container_name(std::path::Path::new(
            "AliceDefectSkin V2.0-979-2-1-1780132414 (1).zip",
        ));
        assert!(!name.contains("1780132414"), "nexus id suffix stripped, got {name}");
        assert!(!name.is_empty());
    }
}
```

- [ ] **Step 2: Run, expect FAIL** (`function not found`): `cargo test --manifest-path=src-tauri/Cargo.toml mods::bundle`

- [ ] **Step 3: Implement** `src-tauri/src/mods/bundle.rs`:
```rust
//! A "bundle" is a multi-mod download laid out as one container folder under
//! `mods/`, with member mods in subfolders. The container carries a hidden
//! `.sts2mm-bundle.json` sidecar holding what the folder structure can't:
//! the author's display name, the shared upstream link, and the version.
//! Membership is the filesystem (the member subfolders) — never a registry.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::install::strip_nexus_suffix; // make this `pub(super)` in install.rs
use super::state::sanitize_path_segment;

pub const SIDECAR_FILENAME: &str = ".sts2mm-bundle.json";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct BundleSidecar {
    /// Author's name for the whole download (shown as the row title).
    pub display_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_game_domain: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nexus_mod_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub github_repo: Option<String>,
    /// The bundle's version (the Nexus mod version when known).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_version: Option<String>,
}

fn sidecar_path(container: &Path) -> PathBuf {
    container.join(SIDECAR_FILENAME)
}

pub fn is_bundle_container(dir: &Path) -> bool {
    sidecar_path(dir).is_file()
}

pub fn read_sidecar(container: &Path) -> Option<BundleSidecar> {
    let body = fs::read_to_string(sidecar_path(container)).ok()?;
    serde_json::from_str(crate::mods::scan::strip_utf8_bom(&body)).ok()
}

pub fn write_sidecar(container: &Path, sidecar: &BundleSidecar) -> std::io::Result<()> {
    let json = serde_json::to_string_pretty(sidecar)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
    fs::write(sidecar_path(container), json)
}

/// Container folder name for a downloaded archive: the file stem with any
/// Nexus upload-id suffix stripped, sanitized to a safe single path segment.
pub fn bundle_container_name(archive_path: &Path) -> String {
    let stem = archive_path
        .file_stem()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();
    sanitize_path_segment(&strip_nexus_suffix(&stem))
}
```
Make `strip_nexus_suffix` `pub(super)` in `install.rs` (it is currently private). Add `pub mod bundle;` to `src-tauri/src/mods/mod.rs`.

- [ ] **Step 4: Run, expect PASS:** `cargo test --manifest-path=src-tauri/Cargo.toml mods::bundle`

- [ ] **Step 5: Commit.**
```bash
git add src-tauri/src/mods/bundle.rs src-tauri/src/mods/mod.rs src-tauri/src/mods/install.rs
git commit -m "feat(bundle): sidecar module — read/write .sts2mm-bundle.json + container naming"
```

---

### Task 3: Install lays a multi-member archive into one named container + minimal sidecar

**Goal:** When an archive contains ≥2 member mod folders, extract them into one container named by `bundle_container_name`, and write a minimal sidecar (so manual installs are bundles too). Single-folder installs are unchanged.

**Files:**
- Modify: `src-tauri/src/mods/install.rs` (the layout branch in `install_mod_from_zip` — the `wrap_folder_name` / multi-top-dir path around lines 379–511, post-`b41666e` state)
- Test: `src-tauri/src/mods/install.rs` (`archive_dispatch_tests`)

**Acceptance Criteria:**
- [ ] An archive with ≥2 top-level member folders extracts to `mods/<bundle_container_name>/<member>/…` and the container has a `.sts2mm-bundle.json` (display_name defaults to the container name).
- [ ] The install no longer rolls back for such archives (works with `b41666e` scan).
- [ ] A single-folder archive (one mod) creates **no** sidecar and is unchanged.
- [ ] The container is named from the archive stem (not the first member's manifest id).

**Verify:** `cargo test --manifest-path=src-tauri/Cargo.toml mods::install` → all pass.

**Steps:**

- [ ] **Step 1: Write failing test** in `archive_dispatch_tests` (reuse the `write_zip_file` helper):
```rust
#[test]
fn multi_member_archive_becomes_one_bundle_container_with_sidecar() {
    use crate::mods::bundle::{is_bundle_container, read_sidecar};
    let tmp = tempfile::tempdir().unwrap();
    let zip = tmp.path().join("Alice Defect Visual Pack-979-2-1.zip");
    write_zip_file(&zip, vec![
        ("AliceDefectSkin/AliceDefectSkin.json",
            br#"{"id":"AliceDefectSkin","name":"Alice Defect Skin","version":"0.1.31"}"#.to_vec()),
        ("AliceDefectSkin/AliceDefectSkin.dll", b"dll".to_vec()),
        ("AliceDefectVoiceBridge/mod_manifest.json",
            br#"{"id":"AliceDefectVoiceBridge","name":"Alice Defect Voice Bridge","version":"1.0.4"}"#.to_vec()),
        ("AliceDefectVoiceBridge/AliceDefectVoiceBridge.dll", b"dll".to_vec()),
    ]);
    let mods = tempfile::tempdir().unwrap();
    install_mod_from_archive(&zip, mods.path()).expect("multi-member installs");

    // exactly one top-level container, and it's a bundle
    let tops: Vec<_> = fs::read_dir(mods.path()).unwrap().flatten()
        .filter(|e| e.path().is_dir()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
    assert_eq!(tops.len(), 1, "one container, got {tops:?}");
    let container = mods.path().join(&tops[0]);
    assert!(is_bundle_container(&container), "container has a sidecar");
    assert!(container.join("AliceDefectSkin").is_dir());
    assert!(container.join("AliceDefectVoiceBridge").is_dir());
    let _ = read_sidecar(&container).expect("sidecar parses");
}

#[test]
fn single_member_archive_is_not_a_bundle() {
    use crate::mods::bundle::is_bundle_container;
    let tmp = tempfile::tempdir().unwrap();
    let zip = tmp.path().join("Solo.zip");
    write_zip_file(&zip, vec![
        ("Solo/Solo.json", br#"{"id":"Solo","name":"Solo","version":"1.0.0"}"#.to_vec()),
        ("Solo/Solo.dll", b"dll".to_vec()),
    ]);
    let mods = tempfile::tempdir().unwrap();
    install_mod_from_archive(&zip, mods.path()).expect("single installs");
    assert!(!is_bundle_container(&mods.path().join("Solo")));
}
```

- [ ] **Step 2: Run, expect FAIL:** `cargo test --manifest-path=src-tauri/Cargo.toml mods::install::archive_dispatch_tests::multi_member`

- [ ] **Step 3: Implement.** In `install_mod_from_zip`: compute `member_top_dirs` = distinct top-level dirs among entries where every file is under some top dir (the existing `all_top_dirs` when `all_entries.iter().all(|n| n.contains('/'))`). When `member_top_dirs.len() >= 2`, set the wrap container to `bundle::bundle_container_name(zip_path)` instead of `wrap_folder_name`, and after the extraction loop write a minimal sidecar:
```rust
let is_bundle = all_top_dirs.len() >= 2 && all_entries.iter().all(|n| n.contains('/'));
let container = if is_bundle {
    super::bundle::bundle_container_name(zip_path)
} else {
    wrap_folder_name.clone() // existing single-mod wrap name
};
// … in the rel_path match, the wrap arm uses `container` instead of `wrap_folder_name` …
// after extraction:
if is_bundle {
    let dir = mods_path.join(&container);
    let _ = super::bundle::write_sidecar(&dir, &super::bundle::BundleSidecar {
        display_name: container.clone(),
        ..Default::default()
    });
}
```
Keep the single-mod wrap path (root-files / RitsuLib case) exactly as it is — only the ≥2-member case changes name + writes the sidecar.

- [ ] **Step 4: Run, expect PASS:** `cargo test --manifest-path=src-tauri/Cargo.toml mods::install`

- [ ] **Step 5: Commit.**
```bash
git add src-tauri/src/mods/install.rs
git commit -m "feat(install): lay multi-member archives into one named bundle container + sidecar"
```

---

### Task 4: Scan tags bundle members + `get_bundles` command

**Goal:** During scan, tag each member of a sidecar container with `bundle_id` (the container folder name). Add a `get_bundles` command returning each container's sidecar metadata.

**Files:**
- Modify: `src-tauri/src/mods/mod.rs` (add `bundle_id: Option<String>` to `ModInfo`; add `get_bundles` command + a `BundleInfo` return type)
- Modify: `src-tauri/src/mods/scan.rs` (in the PASS-2 container-descent added by `b41666e`, set `bundle_id` on members when the container has a sidecar; default `None` in all `ModInfo` constructors)
- Modify: `src-tauri/src/lib.rs` (register `get_bundles` in the invoke handler)
- Test: `src-tauri/src/mods/scan.rs`

**Acceptance Criteria:**
- [ ] `ModInfo` has `bundle_id: Option<String>` (serde), defaulting `None` in `parse_manifest`, `dll_only_mod`, `pck_only_mod`, the install stub, and any test builders.
- [ ] Scanning a sidecar container sets each member's `bundle_id` to the container folder name.
- [ ] A container WITHOUT a sidecar leaves members' `bundle_id = None` (current behavior).
- [ ] `get_bundles(mods_path)` returns `Vec<BundleInfo>` with `{ bundle_id, display_name, nexus_url, version, member_count }`, one per sidecar container.

**Verify:** `cargo test --manifest-path=src-tauri/Cargo.toml mods::scan` → all pass.

**Steps:**

- [ ] **Step 1: Write failing tests** in `scan.rs` (build a sidecar container on disk with `write_bytes` + `bundle::write_sidecar`):
```rust
#[test]
fn sidecar_container_tags_members_with_bundle_id() {
    let tmp = tempfile::tempdir().unwrap();
    let mods = tmp.path();
    write_bytes(&mods.join("Pack").join("ModA").join("ModA.dll"), b"");
    write_bytes(&mods.join("Pack").join("ModB").join("ModB.dll"), b"");
    crate::mods::bundle::write_sidecar(&mods.join("Pack"),
        &crate::mods::bundle::BundleSidecar { display_name: "Pretty Pack".into(), ..Default::default() }).unwrap();
    let scanned = scan_mods_inner(mods, true);
    assert!(scanned.iter().all(|m| m.bundle_id.as_deref() == Some("Pack")),
        "every member tagged with bundle_id=Pack: {:?}", scanned.iter().map(|m|(&m.name,&m.bundle_id)).collect::<Vec<_>>());
}

#[test]
fn container_without_sidecar_has_no_bundle_id() {
    let tmp = tempfile::tempdir().unwrap();
    let mods = tmp.path();
    write_bytes(&mods.join("Pack").join("ModA").join("ModA.dll"), b"");
    write_bytes(&mods.join("Pack").join("ModB").join("ModB.dll"), b"");
    let scanned = scan_mods_inner(mods, true);
    assert!(scanned.iter().all(|m| m.bundle_id.is_none()));
}
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.**
  - Add `pub bundle_id: Option<String>,` to `ModInfo` in `mods/mod.rs`; set `bundle_id: None` in every constructor (compiler will list them).
  - In `scan.rs` PASS-2 container-descent (the `b41666e` block iterating a container's subdirs), before descending, compute `let bundle = crate::mods::bundle::is_bundle_container(&path).then(|| path.file_name()…to_string());`. After each member is loaded into `mods`, set its `bundle_id = bundle.clone()` (tag the entries appended for this container).
  - Add to `mods/mod.rs`:
```rust
#[derive(serde::Serialize)]
pub struct BundleInfo {
    pub bundle_id: String,        // container folder name
    pub display_name: String,
    pub nexus_url: Option<String>,
    pub version: Option<String>,
    pub member_count: usize,
}

#[tauri::command]
pub fn get_bundles(state: tauri::State<'_, AppState>) -> Result<Vec<BundleInfo>, String> {
    let mods_path = state.mods_path().map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&mods_path) {
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() && crate::mods::bundle::is_bundle_container(&p) {
                if let Some(s) = crate::mods::bundle::read_sidecar(&p) {
                    let member_count = std::fs::read_dir(&p).map(|d| d.flatten()
                        .filter(|x| x.path().is_dir()).count()).unwrap_or(0);
                    out.push(BundleInfo {
                        bundle_id: p.file_name().unwrap_or_default().to_string_lossy().to_string(),
                        display_name: s.display_name, nexus_url: s.nexus_url,
                        version: s.installed_version, member_count,
                    });
                }
            }
        }
    }
    Ok(out)
}
```
  (Use the same `mods_path()` accessor the other commands use — match `get_installed_mods`.) Register `get_bundles` in `lib.rs`'s `generate_handler!`.

- [ ] **Step 4: Run, expect PASS:** `cargo test --manifest-path=src-tauri/Cargo.toml mods::`

- [ ] **Step 5: Commit.**
```bash
git add src-tauri/src/mods/mod.rs src-tauri/src/mods/scan.rs src-tauri/src/lib.rs
git commit -m "feat(scan): tag bundle members with bundle_id; add get_bundles command"
```

---

### Task 5: Downloads-watcher enriches the sidecar with the Nexus link + version

**Goal:** On Nexus / auto-install of a bundle, fill the sidecar's `display_name`, Nexus link fields, and `installed_version` from the already-resolved Nexus info, so the bundle row shows the link and no member reads UNLINKED.

**Files:**
- Modify: `src-tauri/src/downloads_watcher.rs` (the post-install block ~276–337 where `attach_pending_nexus_source` / `fetch_nexus_version_blocking` already run)
- Test: `src-tauri/src/downloads_watcher.rs` or `src-tauri/tests/qa_scenarios.rs`

**Acceptance Criteria:**
- [ ] After auto-installing a bundle zip, `mods/<container>/.sts2mm-bundle.json` has `display_name` = the resolved Nexus title (fallback the container name), the Nexus URL/domain/mod_id, and `installed_version`.
- [ ] A non-bundle (single mod) install does not create a sidecar.
- [ ] The Nexus source is attached at the bundle level (not to an individual member).

**Verify:** `cargo test --manifest-path=src-tauri/Cargo.toml downloads_watcher` (+ any added qa_scenario) → pass.

**Steps:**

- [ ] **Step 1: Write a failing test** that installs a 2-member zip via `install_mod_from_archive`, then calls a new pure helper `enrich_bundle_sidecar(mods_path, archive_path, display_name, nexus_url, nexus_game_domain, nexus_mod_id, version)` and asserts the sidecar fields. (Keep the watcher's I/O-heavy parts out of the unit by testing the pure helper.)

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement** a pure helper in `bundle.rs`:
```rust
pub fn enrich_bundle_sidecar(
    mods_path: &Path, archive_path: &Path, display_name: Option<&str>,
    nexus_url: Option<String>, nexus_game_domain: Option<String>,
    nexus_mod_id: Option<u64>, version: Option<String>,
) -> bool {
    let container = mods_path.join(bundle_container_name(archive_path));
    if !is_bundle_container(&container) { return false; }
    let mut s = read_sidecar(&container).unwrap_or_default();
    if let Some(n) = display_name { if !n.is_empty() { s.display_name = n.to_string(); } }
    if nexus_url.is_some() { s.nexus_url = nexus_url; }
    if nexus_game_domain.is_some() { s.nexus_game_domain = nexus_game_domain; }
    if nexus_mod_id.is_some() { s.nexus_mod_id = nexus_mod_id; }
    if version.is_some() { s.installed_version = version; }
    write_sidecar(&container, &s).is_ok()
}
```
Call it from `downloads_watcher.rs` right after the Nexus version/source resolution, passing the resolved title/link/version. (The Nexus title comes from the same lookup used for `attach_pending_nexus_source`; if no title is resolved, leave the install-time default.)

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Commit.**
```bash
git add src-tauri/src/mods/bundle.rs src-tauri/src/downloads_watcher.rs src-tauri/tests/qa_scenarios.rs
git commit -m "feat(bundle): enrich sidecar with Nexus link + version on auto-install"
```

---

### Task 6: Frontend — render a bundle as one collapsible row

**Goal:** Group members sharing a `bundle_id` into one row showing the bundle's display name, Nexus link, and version; comfortable view lists member names beneath (aligned, wrapping into side columns), compact shows the name only.

**Files:**
- Modify: `src/types.ts` (add `bundle_id?: string | null` to `ModInfo`; add `Bundle` interface mirroring `BundleInfo`)
- Modify: `src/hooks/useTauri.ts` (add `getBundles(): Promise<Bundle[]>` invoking `get_bundles`)
- Modify: `src/contexts/AppContext.tsx` (fetch + store `bundles` alongside `mods` in `refreshMods`)
- Modify: `src/hooks/useModLibrary.tsx` (expose `bundles`; build a `bundlesById` map)
- Modify: `src/components/LibraryTable.tsx` (collapse rows whose `bundle_id` matches a bundle into a single synthetic bundle row; render member names from the grid)
- Create: `src/components/BundleRow.tsx` (the bundle row presentation: title = `display_name`, Nexus badge/link, version, member-name list; respects `density`)
- Modify: `src/styles.css` (member-name list: small, aligned, `column`-wrapping)
- Modify: `src/i18n/locales/en.json` + `zh-Hans.json` (`bundle.memberCount`, etc.)
- Test: `src/components/LibraryTable.test.tsx`, `src/components/BundleRow.test.tsx`

**Acceptance Criteria:**
- [ ] Members sharing a `bundle_id` render as ONE row; non-bundled mods render exactly as today.
- [ ] Comfortable density shows the member-name list beneath the title; compact shows the title only.
- [ ] The bundle row shows the Nexus link (from the bundle) and the bundle version; no member shows an `UNLINKED` badge.
- [ ] Search matches the bundle display name and any member name.

**Verify:** `npx vitest run src/components/LibraryTable.test.tsx src/components/BundleRow.test.tsx` → PASS.

**Steps:**

- [ ] **Step 1: Types + fetch.** Add `bundle_id?: string | null` to `ModInfo` (src/types.ts) and a `Bundle` interface `{ bundle_id: string; display_name: string; nexus_url: string | null; version: string | null; member_count: number }`. Add `getBundles()` to `useTauri.ts` (mirror `getInstalledMods` at lines 81–83). Thread `bundles` through `AppContext.refreshMods` (lines 169–176) and expose via `useModLibrary`.

- [ ] **Step 2: Failing test** in `src/components/LibraryTable.test.tsx`: render the table with two mods carrying `bundle_id: "Pack"` plus a matching `Bundle`, and assert ONE row with the display name appears and both member names are present in comfortable view (loud lookups — `getByText`, no `if (el)` guards). Run → FAIL.

- [ ] **Step 3: Implement grouping** in `LibraryTable.tsx`: when building `filteredRows`, partition rows by `bundle_id`; for each bundle present in `bundlesById`, emit a single synthetic bundle entry (carrying its member rows) instead of the individual members; render it via `<BundleRow>`. Implement `BundleRow.tsx` using existing `Badge`/`Toggle` components and `density` from `useModListDensity`. Add the member-list CSS to `styles.css`. Add i18n keys to both locale files.

- [ ] **Step 4: Run, expect PASS:** `npx vitest run src/components/LibraryTable.test.tsx src/components/BundleRow.test.tsx`

- [ ] **Step 5: Commit.**
```bash
git add src/types.ts src/hooks/useTauri.ts src/contexts/AppContext.tsx src/hooks/useModLibrary.tsx src/components/LibraryTable.tsx src/components/BundleRow.tsx src/styles.css src/i18n/locales/en.json src/i18n/locales/zh-Hans.json src/components/LibraryTable.test.tsx src/components/BundleRow.test.tsx
git commit -m "feat(library): render a multi-mod bundle as one collapsible row"
```

---

### Task 7: Phase 1 verification gate (real bundle install + display)

**Goal:** Prove the end-to-end Phase 1 result on the real Alice zip: it installs as one container, scans as one bundle, and shows as one linked row.

**USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:** none (verification only).

**Acceptance Criteria:**
- [ ] `cargo test --manifest-path=src-tauri/Cargo.toml` → 0 failed.
- [ ] `npx vitest run` → 0 failed.
- [ ] Installing the real `C:\Users\xxsku\Downloads\AliceDefectSkin V2.0-979-2-1-1780132414 (1).zip` into a temp mods dir (throwaway `#[ignore]` test, then removed) yields exactly one container with a sidecar, four member subfolders, and `get_bundles` returns one entry; remove the throwaway test before closing.
- [ ] App built and the Alice pack shows as ONE row with a Nexus link and a version, members listed in comfortable view (run the app per the `run` skill or a dev build; capture a screenshot).

**Verify:** `cargo test --manifest-path=src-tauri/Cargo.toml` and `npx vitest run` both green; app screenshot shows the single linked bundle row.

**Steps:**
- [ ] Run the full Rust + vitest suites; capture pass counts.
- [ ] Add a temporary `#[ignore]` test that installs the real zip + asserts one bundle container + `get_bundles` len 1; run with `--ignored --nocapture`; capture output; delete the test.
- [ ] Launch the app (or dev build), confirm the single linked row + member list; capture a screenshot.

---

## Future phases (planned in detail after Phase 1 lands)

These depend on Phase 1's exact `BundleInfo`/grouping shapes; they get their own task detail once Phase 1 is merged.

- **Task 8 — Bundle operations (Phase 2):** container-level toggle (move the whole container between `mods/` and `mods_disabled/`) and delete (remove the container only) in `src-tauri/src/mods/mod.rs`; wire the bundle row's toggle/delete in `BundleRow.tsx`. Tests: toggling/deleting a bundle moves/removes exactly the container.
- **Task 9 — Bundle modpack membership (Phase 2):** treat a bundle container as one modpack member in the profiles module + `src/components/ModpackDetail.tsx`.
- **Task 10 — Bundle updates (Phase 3):** bundle-level update check against the sidecar's Nexus link + whole-container re-install in `src-tauri/src/updater.rs`.

---

## Self-review notes

- Spec coverage: linking (T5), one-row display (T6), install grouping (T2/T3), scan grouping (T4), button removal (T1), verification (T7); operations/updates deferred to T8–T10 per the spec's phasing.
- Each task is independently committable and testable. T1 is independent; T2→T3→T4 are ordered (sidecar → install → scan); T5/T6 depend on T2–T4; T7 gates the phase.
