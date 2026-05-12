//! Cross-module integration tests that mirror the scenarios in
//! `qa/scenarios/`. Each test here corresponds to one markdown scenario
//! and is the Tier-1 (IPC) realization of it. The markdown stays as
//! the human-readable spec; this file is the machine-readable check.
//!
//! Scenarios that need Tauri state (active profile, app handle) currently
//! live as `#[test]` next to their owning function in `src-tauri/src/`
//! because they need access to private helpers. This file holds the
//! ones whose execution surface is public.

use std::fs;
use std::path::Path;

use sts2_mod_manager_lib::mods::{install_mod_from_zip, scan_mods, ModInfo};
use sts2_mod_manager_lib::mod_sources::{load_sources, lookup_entry, save_sources, ModSourceEntry, ModSourcesDb};

/// Fixture: drop a BaseLib install into `mods/BaseLib/` with its BOM-
/// prefixed manifest. Returns the tempdir so callers own its lifetime.
fn install_baselib_with_bom(mods_path: &Path) {
    let dir = mods_path.join("BaseLib");
    fs::create_dir_all(&dir).unwrap();

    let mut bytes: Vec<u8> = vec![0xEF, 0xBB, 0xBF];
    bytes.extend_from_slice(
        br#"{
  "id": "BaseLib",
  "name": "BaseLib",
  "author": "Alchyr",
  "version": "v3.1.2",
  "has_pck": true,
  "has_dll": true,
  "dependencies": []
}"#,
    );
    fs::write(dir.join("BaseLib.json"), &bytes).unwrap();
    fs::write(dir.join("BaseLib.dll"), b"original-dll-bytes").unwrap();
    fs::write(dir.join("BaseLib.pck"), b"original-pck-bytes").unwrap();
}

fn pin_mod_in_sources(config_path: &Path, key: &str) {
    let mut db = ModSourcesDb::default();
    let mut entry = ModSourceEntry::default();
    entry.pinned = true;
    db.mods.insert(key.to_string(), entry);
    save_sources(&db, config_path).unwrap();
}

/// Scenario 004 — Downloads watcher must respect a folder-keyed pin.
///
/// The pre-1.3.1 watcher looked the pin up by display name only. After
/// 1.3.1, `pin_mod` writes folder-keyed entries. A name-only watcher
/// lookup would miss the pin entirely and silently overwrite the
/// pinned install. The fix routes the lookup through `lookup_entry`.
///
/// This test reproduces the exact lookup the watcher performs and
/// asserts it finds the pin. It also asserts that a hypothetical
/// name-only lookup (the old code) would have missed the pin — proving
/// the fix is doing real work, not duck-typing past the bug.
#[test]
fn scenario_004_downloads_watcher_pin_lookup_finds_folder_keyed_pin() {
    let mods_tmp = tempfile::tempdir().unwrap();
    let config_tmp = tempfile::tempdir().unwrap();

    // Step 1: BaseLib installed on disk.
    install_baselib_with_bom(mods_tmp.path());

    // Step 2: Pin BaseLib under its folder_name (post-1.3.1 path).
    pin_mod_in_sources(config_tmp.path(), "BaseLib");

    // Step 3: scan_mods produces the ModInfo the watcher would compare against.
    let scanned: Vec<ModInfo> = scan_mods(mods_tmp.path());
    let baselib = scanned
        .iter()
        .find(|m| m.name == "BaseLib")
        .expect("BaseLib must be discoverable by scan");

    // Sanity: BOM didn't break the read (this is also scenario 001's invariant).
    assert_eq!(baselib.version, "v3.1.2");
    assert_eq!(baselib.folder_name.as_deref(), Some("BaseLib"));

    // Step 4: simulate the watcher's pin lookup using the same folder-
    // first chain the real code uses.
    let db = load_sources(config_tmp.path());
    let entry = lookup_entry(
        &db.mods,
        baselib.folder_name.as_deref(),
        &baselib.name,
        baselib.mod_id.as_deref(),
    );
    assert!(
        entry.is_some_and(|e| e.pinned),
        "lookup_entry must find the folder-keyed pin and report pinned=true. \
         If this fails, the watcher would auto-install over a pinned mod."
    );
}

/// Companion to scenario 004 — proves the regression is real, not theoretical.
///
/// If we revert to a name-only lookup (the pre-1.3.1 watcher code), the
/// folder-keyed pin entry is invisible to it. This test makes that
/// explicit so a future refactor that re-introduces `db.mods.get(&m.name)`
/// would fail in the obvious place rather than ship a silent regression.
#[test]
fn scenario_004b_name_only_lookup_misses_folder_keyed_pin_when_name_differs() {
    let mods_tmp = tempfile::tempdir().unwrap();
    let config_tmp = tempfile::tempdir().unwrap();

    // Mod whose folder_name differs from its display name — the case
    // where folder-keyed pin and name-keyed lookup diverge.
    let dir = mods_tmp.path().join("card_art_editor_v2");
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("manifest.json"),
        br#"{"name": "Card Art Editor", "version": "2.0.0", "author": "Alchyr"}"#,
    )
    .unwrap();
    fs::write(dir.join("card_art_editor.dll"), b"v2-dll-bytes").unwrap();

    // Pin under folder_name (the post-1.3.1 write path).
    pin_mod_in_sources(config_tmp.path(), "card_art_editor_v2");

    let scanned = scan_mods(mods_tmp.path());
    let cae = scanned.iter().find(|m| m.name == "Card Art Editor").unwrap();

    let db = load_sources(config_tmp.path());

    // Old code path: name-only.
    let old_lookup = db.mods.get(&cae.name);
    assert!(
        old_lookup.is_none(),
        "Name-only lookup must MISS the folder-keyed pin — that's the bug. \
         If this assertion fires, the test setup is wrong (pin got written to the wrong key)."
    );

    // New code path: folder-first.
    let new_lookup = lookup_entry(
        &db.mods,
        cae.folder_name.as_deref(),
        &cae.name,
        cae.mod_id.as_deref(),
    );
    assert!(
        new_lookup.is_some_and(|e| e.pinned),
        "Folder-first lookup must FIND the pin. If this fires, the fix is broken."
    );
}

/// Scenario 003 — Pin survives a profile apply that doesn't list the
/// pinned mod. The profile-apply pin-preservation contract is a player-
/// facing promise: "pinned mods are mine, modpacks can't touch them."
///
/// This test exercises the same lookup chain `apply_profile` uses to
/// decide whether to skip a mod. Full `apply_profile` execution is
/// covered by a higher-tier scenario that drives the Tauri command —
/// this Tier-1 test confirms the underlying decision is correct.
#[test]
fn scenario_003_pin_lookup_preserves_state_across_apply_decision() {
    let mods_tmp = tempfile::tempdir().unwrap();
    let config_tmp = tempfile::tempdir().unwrap();

    install_baselib_with_bom(mods_tmp.path());
    pin_mod_in_sources(config_tmp.path(), "BaseLib");

    let scanned = scan_mods(mods_tmp.path());
    let baselib = scanned.iter().find(|m| m.name == "BaseLib").unwrap();

    // The apply logic asks: "is this installed mod pinned?" If yes, the
    // mod is excluded from the apply's enable/disable/delete actions.
    // The same lookup_entry chain runs there.
    let db = load_sources(config_tmp.path());
    let entry = lookup_entry(
        &db.mods,
        baselib.folder_name.as_deref(),
        &baselib.name,
        baselib.mod_id.as_deref(),
    );
    let is_pinned = entry.is_some_and(|e| e.pinned);
    assert!(
        is_pinned,
        "BaseLib must be reported as pinned. apply_profile's \
         `if pinned {{ skip }}` branch depends on this returning true."
    );

    // On-disk files are still where we put them — neither this test nor
    // any side effect of the lookup touched them.
    assert!(mods_tmp.path().join("BaseLib").join("BaseLib.dll").exists());
    assert!(mods_tmp.path().join("BaseLib").join("BaseLib.json").exists());
}

/// Historical bug #11 — zip-slip refusal. A malicious zip with a
/// `..` traversal entry must NOT escape the mods folder. The fix in
/// `install_mod_from_zip` uses `entry.enclosed_name()` + a
/// belt-and-braces `path_is_inside` check after the destination path
/// is computed. This test fires both gates by including an entry whose
/// name attempts to escape.
#[test]
fn historical_11_zip_slip_traversal_is_refused() {
    use std::io::Write as _;
    use zip::write::SimpleFileOptions;

    let src_tmp = tempfile::tempdir().unwrap();
    let zip_path = src_tmp.path().join("hostile.zip");
    {
        let f = std::fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        // A safe entry — the install should produce SOMETHING valid.
        zw.start_file("SafeMod/manifest.json", opts).unwrap();
        zw.write_all(br#"{"name":"SafeMod","version":"0.1.0"}"#).unwrap();
        zw.start_file("SafeMod/SafeMod.dll", opts).unwrap();
        zw.write_all(b"safe-bytes").unwrap();
        // The traversal entry — must be silently dropped, not extracted.
        zw.start_file("../../escaped.txt", opts).unwrap();
        zw.write_all(b"PWNED").unwrap();
        zw.finish().unwrap();
    }

    let mods_tmp = tempfile::tempdir().unwrap();
    let info =
        install_mod_from_zip(&zip_path, mods_tmp.path()).expect("install should succeed for the safe content");
    assert_eq!(info.name, "SafeMod");

    // The escaped file must NOT exist anywhere outside mods_tmp.
    let escaped_at_root = mods_tmp.path().parent().unwrap().join("escaped.txt");
    assert!(
        !escaped_at_root.exists(),
        "zip-slip succeeded: an entry escaped the mods folder. Found file at {}",
        escaped_at_root.display()
    );
    // Sibling check too — different traversal depth.
    let escaped_sibling = mods_tmp.path().parent().unwrap().parent().map(|p| p.join("escaped.txt"));
    if let Some(p) = escaped_sibling {
        assert!(!p.exists(), "zip-slip succeeded (deeper escape): {}", p.display());
    }
}

/// Historical bug #4 — RitsuLib's zip layout (root .dll + .json plus a
/// `Translations/` subdirectory) used to spill files at `mods/`'s root.
/// The fix wraps everything in a single folder so updates can clean
/// the install fully. This test checks the wrap behavior holds.
#[test]
fn historical_4_mixed_layout_zip_lands_under_one_folder() {
    use std::io::Write as _;
    use zip::write::SimpleFileOptions;

    let src_tmp = tempfile::tempdir().unwrap();
    let zip_path = src_tmp.path().join("RitsuLib.zip");
    {
        let f = std::fs::File::create(&zip_path).unwrap();
        let mut zw = zip::ZipWriter::new(f);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        // Root-level mod files (this is the bad pattern).
        zw.start_file("RitsuLib.dll", opts).unwrap();
        zw.write_all(b"dll-bytes").unwrap();
        zw.start_file("RitsuLib.json", opts).unwrap();
        zw.write_all(br#"{"name":"RitsuLib","version":"0.2.29"}"#).unwrap();
        // A side subdirectory in the same zip — exactly the RitsuLib case.
        zw.start_file("Translations/en.txt", opts).unwrap();
        zw.write_all(b"english strings").unwrap();
        zw.finish().unwrap();
    }

    let mods_tmp = tempfile::tempdir().unwrap();
    let info = install_mod_from_zip(&zip_path, mods_tmp.path()).expect("install should succeed");

    // The wrap folder name should be derived from the manifest's id /
    // dll stem (one of them is "RitsuLib"). Either way, NOTHING should
    // be at the mods root other than that wrap directory.
    let root_entries: Vec<_> =
        std::fs::read_dir(mods_tmp.path()).unwrap().filter_map(|e| e.ok()).collect();
    assert_eq!(
        root_entries.len(),
        1,
        "Mixed-layout zip must wrap into a single folder. Found {} entries at mods root: {:?}",
        root_entries.len(),
        root_entries.iter().map(|e| e.file_name()).collect::<Vec<_>>()
    );
    let wrap = &root_entries[0].path();
    assert!(wrap.is_dir(), "the single root entry must be a directory");
    assert!(wrap.join("RitsuLib.dll").exists(), "DLL must be inside the wrap folder");
    assert!(wrap.join("RitsuLib.json").exists(), "manifest must be inside the wrap folder");
    assert!(
        wrap.join("Translations").join("en.txt").exists(),
        "Translations subdir must be preserved INSIDE the wrap folder. \
         If this fails, an update can't fully clean the old install — \
         see install_mod_from_zip's strategy comment."
    );
    assert_eq!(info.name, "RitsuLib");
}

/// Historical bug #6 — manifest-name rename between versions stranded
/// the source link.
///
/// Real-world reproducer: BAKAOLC ships `STS2-ShowPlayerHandCards` for a
/// while, the manifest declares `Name: "STS2-ShowPlayerHandCards"`. They
/// rebuild and now the manifest says `Name: "Show Player Hand Cards"`.
/// Without `migrate_source_entry`, the audit looks up the new name in
/// `mod_sources.json`, finds no entry, and reports "no source linked"
/// even though the user explicitly attached the GitHub repo months ago.
///
/// This test asserts the migration carries `github_repo`, `pinned`,
/// `nexus_url`, and `installed_version` from old key to new key.
#[test]
fn historical_6_source_entry_migrates_on_manifest_rename() {
    use sts2_mod_manager_lib::mod_sources::{migrate_source_entry, save_sources, ModSourceEntry, ModSourcesDb};

    let config_tmp = tempfile::tempdir().unwrap();

    // Seed mod_sources.json with an entry under the OLD name.
    let mut db = ModSourcesDb::default();
    let mut entry = ModSourceEntry::default();
    entry.github_repo = Some("BAKAOLC/STS2-ShowPlayerHandCards".into());
    entry.pinned = true;
    entry.nexus_url = Some("https://www.nexusmods.com/slaythespire2/mods/42".into());
    entry.nexus_mod_id = Some(42);
    entry.nexus_game_domain = Some("slaythespire2".into());
    entry.installed_version = Some("v0.4.0".into());
    db.mods.insert("STS2-ShowPlayerHandCards".into(), entry);
    save_sources(&db, config_tmp.path()).unwrap();

    // Manifest rename: new name lands in mod_sources.json with nothing.
    migrate_source_entry(
        "STS2-ShowPlayerHandCards",
        "Show Player Hand Cards",
        config_tmp.path(),
    );

    let after = load_sources(config_tmp.path());
    let new_entry = after.mods.get("Show Player Hand Cards").expect(
        "the new name must have an entry after migrate — otherwise the audit reports 'no source' \
         and the user's pin / GitHub link / version-stamp all stranded.",
    );

    assert_eq!(new_entry.github_repo.as_deref(), Some("BAKAOLC/STS2-ShowPlayerHandCards"));
    assert!(new_entry.pinned, "pinned state must survive the rename");
    assert_eq!(new_entry.nexus_url.as_deref(), Some("https://www.nexusmods.com/slaythespire2/mods/42"));
    assert_eq!(new_entry.nexus_mod_id, Some(42));
    assert_eq!(new_entry.installed_version.as_deref(), Some("v0.4.0"));

    // The old entry stays — see migrate_source_entry's docstring. Other
    // parts of the app (exported modpacks, subscription manifests) may
    // still reference it. Two entries pointing at the same repo is
    // harmless; an empty new entry is not.
    assert!(
        after.mods.contains_key("STS2-ShowPlayerHandCards"),
        "old entry must remain so legacy references don't break"
    );
}
