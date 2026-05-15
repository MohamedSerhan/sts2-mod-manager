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

/// Mod-author flow A8 — DLL-only mod (no manifest) surfaces in the
/// scan as `version: "unknown"`. This is the EXPECTED behavior for
/// authors iterating without a manifest yet, and it's also the
/// fallback for installs where the manifest parse genuinely fails.
/// The scan must register the mod, must call it by its DLL stem, and
/// must NOT double-count it as both a manifest mod and an orphan DLL.
#[test]
fn author_a8_dll_only_mod_surfaces_correctly() {
    let mods_tmp = tempfile::tempdir().unwrap();
    let dir = mods_tmp.path().join("MyDevMod");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("MyDevMod.dll"), b"author-dev-bytes").unwrap();
    fs::write(dir.join("MyDevMod.pck"), b"author-dev-pck").unwrap();

    let scanned = scan_mods(mods_tmp.path());
    let entries: Vec<&ModInfo> = scanned.iter().filter(|m| m.name == "MyDevMod").collect();

    assert_eq!(
        entries.len(),
        1,
        "DLL-only mod must surface exactly once. Found {}.",
        entries.len()
    );
    let m = entries[0];
    assert_eq!(m.version, "unknown");
    assert_eq!(m.folder_name.as_deref(), Some("MyDevMod"));
    assert!(m.files.iter().any(|f| f.ends_with("MyDevMod.pck")));
}

/// Kitchen-sink scan: a real user's mods folder has many mods with
/// every quirk simultaneously. This is the test that the BaseLib bug
/// would have caught if it had existed in 1.3.0.
#[test]
fn kitchen_sink_scan_handles_every_quirk_at_once() {
    let mods_tmp = tempfile::tempdir().unwrap();
    let root = mods_tmp.path();

    // 1. BOM-prefixed manifest (BaseLib case).
    let baselib = root.join("BaseLib");
    fs::create_dir_all(&baselib).unwrap();
    let mut bom_manifest: Vec<u8> = vec![0xEF, 0xBB, 0xBF];
    bom_manifest.extend_from_slice(
        br#"{"id":"BaseLib","name":"BaseLib","version":"v3.1.2","author":"Alchyr"}"#,
    );
    fs::write(baselib.join("BaseLib.json"), &bom_manifest).unwrap();
    fs::write(baselib.join("BaseLib.dll"), b"dll").unwrap();

    // 2. Two CardArtEditor folders sharing the manifest name.
    let cae1 = root.join("card_art_editor");
    fs::create_dir_all(&cae1).unwrap();
    fs::write(
        cae1.join("manifest.json"),
        br#"{"name":"Card Art Editor","version":"1.0.0","author":"Alchyr"}"#,
    )
    .unwrap();
    fs::write(cae1.join("card_art_editor.dll"), b"v1").unwrap();
    let cae2 = root.join("card_art_editor_v2");
    fs::create_dir_all(&cae2).unwrap();
    fs::write(
        cae2.join("manifest.json"),
        br#"{"name":"Card Art Editor","version":"2.0.0","author":"Alchyr"}"#,
    )
    .unwrap();
    fs::write(cae2.join("card_art_editor.dll"), b"v2").unwrap();

    // 3. Structured-deps manifest.
    let shc = root.join("STS2-ShowPlayerHandCards");
    fs::create_dir_all(&shc).unwrap();
    fs::write(
        shc.join("manifest.json"),
        br#"{"name":"Show Player Hand Cards","version":"0.4.1","dependencies":[{"id":"RitsuLib","min_version":"0.2.0"},"BaseLib"]}"#,
    )
    .unwrap();
    fs::write(shc.join("STS2-ShowPlayerHandCards.dll"), b"dll").unwrap();

    // 4. Subdir mod whose folder name differs from manifest name.
    let ritsu = root.join("STS2-Ritsu");
    fs::create_dir_all(&ritsu).unwrap();
    fs::write(
        ritsu.join("manifest.json"),
        br#"{"name":"RitsuLib","version":"0.2.29"}"#,
    )
    .unwrap();
    fs::write(ritsu.join("RitsuLib.dll"), b"dll").unwrap();

    // 5. DLL-only mod (author dev iteration).
    let dev = root.join("MyDevMod");
    fs::create_dir_all(&dev).unwrap();
    fs::write(dev.join("MyDevMod.dll"), b"dll").unwrap();

    let scanned = scan_mods(root);
    assert_eq!(
        scanned.len(),
        6,
        "Expected 6 mods (BaseLib + 2 CAE + SHC + RitsuLib + MyDevMod), got {}.",
        scanned.len()
    );

    let baselib_e = scanned.iter().find(|m| m.folder_name.as_deref() == Some("BaseLib")).unwrap();
    assert_eq!(baselib_e.version, "v3.1.2");

    let cae_entries: Vec<&ModInfo> =
        scanned.iter().filter(|m| m.name == "Card Art Editor").collect();
    assert_eq!(cae_entries.len(), 2);

    let shc_e = scanned.iter().find(|m| m.name == "Show Player Hand Cards").unwrap();
    assert_eq!(shc_e.version, "0.4.1");
    assert!(shc_e.dependencies.contains(&"RitsuLib".to_string()));
    assert!(shc_e.dependencies.contains(&"BaseLib".to_string()));

    let ritsu_e = scanned.iter().find(|m| m.name == "RitsuLib").unwrap();
    assert_eq!(ritsu_e.folder_name.as_deref(), Some("STS2-Ritsu"));

    let dev_e = scanned.iter().find(|m| m.name == "MyDevMod").unwrap();
    assert_eq!(dev_e.version, "unknown");
}

/// Flow 10 - profile snapshot captures every installed mod with its
/// identity, source, and enabled state. The snapshot is the contract
/// between the curator's profile and the friend's apply.
#[test]
fn flow_10_profile_snapshot_captures_folder_identity_and_source() {
    use sts2_mod_manager_lib::profiles::snapshot_current_with_paths;

    let mods_tmp = tempfile::tempdir().unwrap();
    let disabled_tmp = tempfile::tempdir().unwrap();
    let profiles_tmp = tempfile::tempdir().unwrap();
    let config_tmp = tempfile::tempdir().unwrap();

    install_baselib_with_bom(mods_tmp.path());

    // Seed a folder-keyed source so the snapshot must look it up via
    // lookup_entry (folder-first).
    let mut db = ModSourcesDb::default();
    let mut entry = ModSourceEntry::default();
    entry.github_repo = Some("Alchyr/STS2-BaseLib".into());
    db.mods.insert("BaseLib".into(), entry);
    save_sources(&db, config_tmp.path()).unwrap();

    let profile = snapshot_current_with_paths(
        "my-pack",
        mods_tmp.path(),
        disabled_tmp.path(),
        profiles_tmp.path(),
        Some(config_tmp.path()),
        None,
    )
    .expect("snapshot must succeed");

    assert_eq!(profile.name, "my-pack");
    assert_eq!(profile.mods.len(), 1);
    let pm = &profile.mods[0];
    assert_eq!(pm.name, "BaseLib");
    assert_eq!(pm.version, "v3.1.2");
    assert_eq!(pm.folder_name.as_deref(), Some("BaseLib"));
    assert_eq!(pm.mod_id.as_deref(), Some("BaseLib"));
    assert!(pm.enabled);
    assert_eq!(
        pm.source.as_deref(),
        Some("github:Alchyr/STS2-BaseLib"),
        "snapshot must look up source via folder-first lookup_entry."
    );

    assert!(profiles_tmp.path().join("my-pack.json").exists());
}

/// Flow 11 + scenario 003 (full integration) — apply_profile_with_pins
/// preserves a pinned mod's enabled state even when the profile lists
/// it as disabled. THE player promise.
#[test]
fn flow_11_apply_profile_pins_override_profile_state() {
    use sts2_mod_manager_lib::profiles::{apply_profile_with_pins, Profile, ProfileMod};

    let mods_tmp = tempfile::tempdir().unwrap();
    let disabled_tmp = tempfile::tempdir().unwrap();
    install_baselib_with_bom(mods_tmp.path());

    let baselib_dll_path = mods_tmp.path().join("BaseLib").join("BaseLib.dll");
    let baselib_dll_before = fs::read(&baselib_dll_path).unwrap();

    let now = chrono::Utc::now();
    let profile = Profile {
        name: "off-pack".into(),
        game_version: Some("0.103.2".into()),
        created_by: None,
        mods: vec![ProfileMod {
            name: "BaseLib".into(),
            version: "v3.1.2".into(),
            source: None,
            hash: None,
            files: Vec::new(),
            folder_name: Some("BaseLib".into()),
            mod_id: Some("BaseLib".into()),
            enabled: false,
            bundle_url: None,
            bundle_sha256: None,
        }],
        created_at: now,
        updated_at: now,
        public: None,
    };

    let mut pinned = std::collections::HashSet::new();
    pinned.insert("BaseLib".to_string());

    apply_profile_with_pins(&profile, mods_tmp.path(), disabled_tmp.path(), &pinned)
        .expect("apply with pin must succeed");

    assert!(
        baselib_dll_path.exists(),
        "Pinned BaseLib must stay in mods/ even when the applied profile says enabled=false."
    );
    assert_eq!(
        fs::read(&baselib_dll_path).unwrap(),
        baselib_dll_before,
        "Pinned mod's bytes must be untouched by apply."
    );
}

/// Direct unit test for the `lookup_entry` precedence chain that
/// underpins every read of mod_sources.json across the codebase. If
/// this precedence ever drifts, every regression in the watcher + audit
/// + apply + enrich code paths becomes silent. So we lock it down
/// explicitly.
///
/// Order: folder_name → display name → mod_id.
#[test]
fn lookup_entry_precedence_is_folder_then_name_then_mod_id() {
    use sts2_mod_manager_lib::mod_sources::{lookup_entry, ModSourceEntry};
    use std::collections::HashMap;

    // Same mod has THREE possible identifiers, each pointing at a
    // different entry so we can see which one wins.
    let mut db: HashMap<String, ModSourceEntry> = HashMap::new();
    let mut folder_entry = ModSourceEntry::default();
    folder_entry.github_repo = Some("folder/repo".into());
    db.insert("the-folder".into(), folder_entry);

    let mut name_entry = ModSourceEntry::default();
    name_entry.github_repo = Some("name/repo".into());
    db.insert("Display Name".into(), name_entry);

    let mut mod_id_entry = ModSourceEntry::default();
    mod_id_entry.github_repo = Some("mod-id/repo".into());
    db.insert("the.mod.id".into(), mod_id_entry);

    // All three identifiers present → folder wins.
    let all_three =
        lookup_entry(&db, Some("the-folder"), "Display Name", Some("the.mod.id")).unwrap();
    assert_eq!(all_three.github_repo.as_deref(), Some("folder/repo"));

    // No folder → name wins.
    let no_folder = lookup_entry(&db, None, "Display Name", Some("the.mod.id")).unwrap();
    assert_eq!(no_folder.github_repo.as_deref(), Some("name/repo"));

    // No folder, no name match → mod_id wins.
    let only_mod_id = lookup_entry(&db, None, "no-match", Some("the.mod.id")).unwrap();
    assert_eq!(only_mod_id.github_repo.as_deref(), Some("mod-id/repo"));

    // Folder present but doesn't match any entry → name fallback.
    let unknown_folder =
        lookup_entry(&db, Some("unknown-folder"), "Display Name", Some("the.mod.id"))
            .unwrap();
    assert_eq!(unknown_folder.github_repo.as_deref(), Some("name/repo"));

    // Nothing matches → None.
    let none = lookup_entry(&db, Some("nope"), "nope", Some("nope"));
    assert!(none.is_none());
}

/// migrate_source_entry must NOT clobber existing destination state.
/// The old entry's fields fill IN where the new entry is empty, but
/// never overwrite. This is the contract that lets us migrate after a
/// manifest rename without losing fields a user already set on the
/// new name (e.g. they re-linked the GitHub before we noticed the
/// rename).
#[test]
fn migrate_source_entry_does_not_overwrite_existing_destination() {
    use sts2_mod_manager_lib::mod_sources::{
        load_sources, migrate_source_entry, save_sources, ModSourceEntry, ModSourcesDb,
    };

    let config_tmp = tempfile::tempdir().unwrap();

    // Source: full state.
    let mut db = ModSourcesDb::default();
    let mut src_entry = ModSourceEntry::default();
    src_entry.github_repo = Some("OLD/repo".into());
    src_entry.pinned = true;
    src_entry.installed_version = Some("v0.1.0".into());
    db.mods.insert("Old Name".into(), src_entry);

    // Destination: user already set a different github_repo manually.
    // We must NOT overwrite their pick on migration.
    let mut dest_entry = ModSourceEntry::default();
    dest_entry.github_repo = Some("USER-PICK/repo".into());
    db.mods.insert("New Name".into(), dest_entry);
    save_sources(&db, config_tmp.path()).unwrap();

    migrate_source_entry("Old Name", "New Name", config_tmp.path());

    let after = load_sources(config_tmp.path());
    let new_entry = after.mods.get("New Name").unwrap();

    assert_eq!(
        new_entry.github_repo.as_deref(),
        Some("USER-PICK/repo"),
        "User's manual github_repo on the destination MUST survive — \
         migration is fill-in-blanks, not overwrite."
    );
    // The pinned + installed_version fields were empty on dest → migrated.
    assert!(new_entry.pinned);
    assert_eq!(new_entry.installed_version.as_deref(), Some("v0.1.0"));
}

/// Scenario 005 — install a bundled mod from a github.com release-asset
/// URL, served from the QA cassette.
///
/// This is the friend-install path for large bundles introduced in v1.4.0:
/// the curator's profile manifest points `bundle_url` at
/// `https://github.com/<owner>/sts2mm-profiles/releases/download/bundles/<name>.zip`,
/// and on import the friend's manager calls `download_bundle(...)` against
/// that URL. With `--features qa-cassette` and `STS2_CASSETTE_DIR` pointed
/// at `qa/fixtures`, the network call short-circuits to a fixture zip
/// under `github-releases/<owner>/sts2mm-profiles/releases/download/bundles/`.
/// The test asserts the zip's inner file lands in the mods dir — proving
/// the full release-URL download + extract path works end to end without
/// touching the wire.
///
/// Gated on `qa-cassette` because outside that feature `intercept_get`
/// returns `None` and the test would fall through to the network and fail.
#[cfg(feature = "qa-cassette")]
#[tokio::test]
async fn scenario_005_install_from_release_url() {
    use std::path::PathBuf;
    use sts2_mod_manager_lib::sharing::download_bundle;

    let fixtures = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("CARGO_MANIFEST_DIR (src-tauri) must have a parent (repo root)")
        .join("qa")
        .join("fixtures");
    std::env::set_var("STS2_CASSETTE_DIR", &fixtures);

    let tmp = tempfile::tempdir().unwrap();
    download_bundle(
        "https://github.com/qa-fixture/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip",
        "TheCursedMod",
        tmp.path(),
    )
    .await
    .expect("cassette-backed release download must succeed");

    assert!(
        tmp.path().join("TheCursedMod").join("TheCursedMod.json").exists(),
        "extract must produce TheCursedMod/TheCursedMod.json under the mods dir. \
         If this fails: either the cassette URL→path mapping is off (see \
         qa_cassette::url_to_path), the fixture zip is missing/empty, or the \
         release-asset branch in download_bundle isn't honoring intercept_get."
    );
}

/// Flow 11 negative case — same profile apply without the pin actually
/// moves the mod. Proves apply is doing real work and the pin test is
/// not a false positive (e.g. apply silently no-oping).
fn install_future_mod(mods_path: &Path, name: &str, min_game_version: &str) {
    let dir = mods_path.join(name);
    fs::create_dir_all(&dir).unwrap();
    let manifest = format!(
        r#"{{
  "id": "{name}",
  "name": "{name}",
  "author": "future",
  "version": "v1.0.0",
  "min_game_version": "{min_game_version}",
  "has_pck": false,
  "has_dll": true,
  "dependencies": []
}}"#,
        name = name,
        min_game_version = min_game_version,
    );
    fs::write(dir.join(format!("{}.json", name)), manifest).unwrap();
    fs::write(dir.join(format!("{}.dll", name)), b"future-dll-bytes").unwrap();
}

#[test]
fn snapshot_filter_strips_incompatible_when_enabled_preserves_when_none() {
    use sts2_mod_manager_lib::profiles::snapshot_current_with_paths;

    let mods_tmp = tempfile::tempdir().unwrap();
    let disabled_tmp = tempfile::tempdir().unwrap();
    let profiles_tmp = tempfile::tempdir().unwrap();

    install_baselib_with_bom(mods_tmp.path());
    install_future_mod(mods_tmp.path(), "FutureMod", "999.0.0");

    let filtered = snapshot_current_with_paths(
        "publish-pack",
        mods_tmp.path(),
        disabled_tmp.path(),
        profiles_tmp.path(),
        None,
        Some("0.105.0"),
    )
    .expect("snapshot must succeed");
    assert!(
        filtered.mods.iter().any(|m| m.name == "BaseLib"),
        "BaseLib (no min_game_version) must always survive."
    );
    assert!(
        !filtered.mods.iter().any(|m| m.name == "FutureMod"),
        "FutureMod must be stripped when the publish-time filter is enabled."
    );

    let preserved = snapshot_current_with_paths(
        "non-publishing-snapshot",
        mods_tmp.path(),
        disabled_tmp.path(),
        profiles_tmp.path(),
        None,
        None,
    )
    .expect("snapshot must succeed");
    assert!(
        preserved.mods.iter().any(|m| m.name == "BaseLib"),
        "BaseLib must survive."
    );
    assert!(
        preserved.mods.iter().any(|m| m.name == "FutureMod"),
        "FutureMod MUST survive when filter is off (None) — \
         this is the non-publishing snapshot path where stripping = silent data loss."
    );
}

#[test]
fn non_publishing_snapshot_preserves_incompatible_mod_already_in_profile() {
    use sts2_mod_manager_lib::profiles::{
        load_profile, save_profile, snapshot_current_with_paths, Profile, ProfileMod,
    };

    let mods_tmp = tempfile::tempdir().unwrap();
    let disabled_tmp = tempfile::tempdir().unwrap();
    let profiles_tmp = tempfile::tempdir().unwrap();

    install_baselib_with_bom(mods_tmp.path());
    install_future_mod(mods_tmp.path(), "FutureMod", "999.0.0");

    let now = chrono::Utc::now();
    let existing = Profile {
        name: "active".into(),
        game_version: None,
        created_by: None,
        mods: vec![ProfileMod {
            name: "FutureMod".into(),
            version: "v1.0.0".into(),
            source: None,
            hash: None,
            files: Vec::new(),
            folder_name: Some("FutureMod".into()),
            mod_id: Some("FutureMod".into()),
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
        }],
        created_at: now,
        updated_at: now,
        public: None,
    };
    save_profile(&existing, profiles_tmp.path()).expect("seed profile");

    // Simulate a non-publishing snapshot: filter = None.
    let refreshed = snapshot_current_with_paths(
        "active",
        mods_tmp.path(),
        disabled_tmp.path(),
        profiles_tmp.path(),
        None,
        None,
    )
    .expect("snapshot must succeed");

    assert!(
        refreshed.mods.iter().any(|m| m.name == "FutureMod"),
        "FutureMod was already in the profile and is still on disk — \
         a non-publishing snapshot MUST NOT strip it (filter=None). \
         Stripping here causes the mutation → drift → Repair-deletes \
         silent data loss loop described in the bug report."
    );

    let on_disk = load_profile("active", profiles_tmp.path()).expect("reload");
    assert!(
        on_disk.mods.iter().any(|m| m.name == "FutureMod"),
        "FutureMod must persist in the on-disk profile JSON after the snapshot."
    );
}

#[test]
fn flow_11_apply_profile_without_pin_moves_mod_as_directed() {
    use sts2_mod_manager_lib::profiles::{apply_profile_with_pins, Profile, ProfileMod};

    let mods_tmp = tempfile::tempdir().unwrap();
    let disabled_tmp = tempfile::tempdir().unwrap();
    install_baselib_with_bom(mods_tmp.path());

    let now = chrono::Utc::now();
    let profile = Profile {
        name: "off-pack".into(),
        game_version: Some("0.103.2".into()),
        created_by: None,
        mods: vec![ProfileMod {
            name: "BaseLib".into(),
            version: "v3.1.2".into(),
            source: None,
            hash: None,
            files: Vec::new(),
            folder_name: Some("BaseLib".into()),
            mod_id: Some("BaseLib".into()),
            enabled: false,
            bundle_url: None,
            bundle_sha256: None,
        }],
        created_at: now,
        updated_at: now,
        public: None,
    };

    let empty_pins = std::collections::HashSet::new();
    apply_profile_with_pins(&profile, mods_tmp.path(), disabled_tmp.path(), &empty_pins)
        .expect("apply must succeed");

    let active_baselib = mods_tmp.path().join("BaseLib").join("BaseLib.dll");
    let disabled_baselib = disabled_tmp.path().join("BaseLib").join("BaseLib.dll");
    assert!(
        !active_baselib.exists(),
        "Without pin, BaseLib should have moved out of mods/."
    );
    assert!(
        disabled_baselib.exists(),
        "Without pin, BaseLib should be in mods_disabled/."
    );
}
