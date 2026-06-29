//! End-to-end test for the `qa-cassette` HTTP intercept layer.
//!
//! Compiled only when the crate is built with `--features qa-cassette`.
//! That keeps env-var mutation (which is process-global) out of the
//! default test run, so this can't race the regular Rust suite.
//!
//! Pair this with `qa/runner/smoke.mjs` when `CASSETTE=1` — the smoke
//! exercises the same plumbing through a Tauri window, this one drives
//! the public `check_all_updates` entry point directly so a regression
//! in the intercept gets caught even when nobody installs WebView2.

#![cfg(feature = "qa-cassette")]

use std::collections::HashMap;
use std::path::PathBuf;

use sts2_mod_manager_lib::mod_sources::ModSourceEntry;
use sts2_mod_manager_lib::mods::ModInfo;
use sts2_mod_manager_lib::updater::check_all_updates;

/// Locate `qa/fixtures/` from inside the `src-tauri` test binary.
/// CARGO_MANIFEST_DIR points at `src-tauri/`, so the fixtures live one
/// level up.
fn fixtures_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("src-tauri has a parent")
        .join("qa")
        .join("fixtures")
}

fn install_cassette_env() {
    std::env::set_var("STS2_CASSETTE_DIR", fixtures_root());
}

/// Build a `ModInfo` shaped enough for `check_all_updates` to think
/// it's a real on-disk mod. Most fields are placeholders — only `name`,
/// `version`, and the source linkage actually matter.
fn make_mod(name: &str, version: &str, folder: &str) -> ModInfo {
    ModInfo {
        mod_version_id: None,
        name: name.to_string(),
        version: version.to_string(),
        description: String::new(),
        enabled: true,
        files: Vec::new(),
        source: None,
        hash: None,
        dependencies: Vec::new(),
        size_bytes: 0,
        folder_name: Some(folder.to_string()),
        mod_id: None,
        github_url: None,
        github_auto_detected: false,
        nexus_url: None,
        pinned: false,
        min_game_version: None,
        author: None,
        note: None,
        custom_url: None,
        display_name: None,
        display_description: None,
        tags: Vec::new(),
        bundle_members: vec![],
        bundle_member_ids: vec![],
        ..Default::default()
    }
}

fn entry_with_github(repo: &str) -> ModSourceEntry {
    let mut e = ModSourceEntry::default();
    e.github_repo = Some(repo.to_string());
    e
}

fn entry_with_nexus(domain: &str, mod_id: u64) -> ModSourceEntry {
    let mut e = ModSourceEntry::default();
    e.nexus_game_domain = Some(domain.to_string());
    e.nexus_mod_id = Some(mod_id);
    e.nexus_url = Some(format!(
        "https://www.nexusmods.com/{}/mods/{}",
        domain, mod_id
    ));
    e
}

/// Cassette HIT against `qa-fixture/test-mod` (latest = v2.0.0) reports
/// an update, while `qa-fixture/uptodate-mod` (latest = v1.0.0) does
/// not. Proves the intercept fires for *both* hits and that the
/// version-comparison downstream of the JSON still works.
#[tokio::test]
async fn cassette_reports_pending_github_update_only_for_stale_mod() {
    install_cassette_env();

    let stale = make_mod("QaTestMod", "1.0.0", "QaTestMod");
    let fresh = make_mod("UpToDateMod", "1.0.0", "UpToDateMod");

    let mut sources: HashMap<String, ModSourceEntry> = HashMap::new();
    sources.insert(
        "QaTestMod".to_string(),
        entry_with_github("qa-fixture/test-mod"),
    );
    sources.insert(
        "UpToDateMod".to_string(),
        entry_with_github("qa-fixture/uptodate-mod"),
    );

    let updates = check_all_updates(&[stale, fresh], &sources, None, None, None, None)
        .await
        .expect("check_all_updates against cassettes should succeed");

    // Exactly one pending update — the stale mod. The fresh mod's
    // installed version equals its cassette latest, so it must be
    // filtered out.
    assert_eq!(
        updates.len(),
        1,
        "expected 1 pending update, got {}: {:?}",
        updates.len(),
        updates
    );
    let u = &updates[0];
    assert_eq!(u.mod_name, "QaTestMod");
    assert_eq!(u.latest_version, "v2.0.0");
    assert_eq!(u.source_type, "github");
    assert_eq!(u.source_id, "qa-fixture/test-mod");
}

/// Cassette HIT against the Nexus side. The fixture at mod_id 99999
/// reports version 3.0.0; installed is 1.0.0, so we expect a pending
/// "nexus"-typed update. This exercises both `get_mod_info` AND
/// `get_mod_files` (the variant picker), since `check_all_updates`
/// itself only calls `get_mod_info` while the audit/full-fidelity path
/// calls both.
#[tokio::test]
async fn cassette_reports_pending_nexus_update_with_dummy_api_key() {
    install_cassette_env();

    let m = make_mod("NexusQaMod", "1.0.0", "NexusQaMod");
    let mut sources: HashMap<String, ModSourceEntry> = HashMap::new();
    sources.insert(
        "NexusQaMod".to_string(),
        entry_with_nexus("slaythespire2", 99999),
    );

    // A non-empty key is required to enter the Nexus phase of
    // `check_all_updates`; the cassette never actually sends it.
    let updates = check_all_updates(&[m], &sources, None, Some("qa-dummy-key"), None, None)
        .await
        .expect("check_all_updates against Nexus cassette should succeed");

    assert_eq!(
        updates.len(),
        1,
        "expected 1 Nexus update, got {:?}",
        updates
    );
    let u = &updates[0];
    assert_eq!(u.mod_name, "NexusQaMod");
    assert_eq!(u.latest_version, "3.0.0");
    assert_eq!(u.source_type, "nexus");
}

/// A mod with no linked source (neither GitHub nor Nexus) should
/// produce no update — the cassette layer isn't even consulted because
/// `resolve_github_repo` short-circuits before any URL is built. This
/// is a sanity test: it would still pass even if the cassette layer
/// were broken, but it catches the inverse regression — accidentally
/// reporting updates for mods that don't have a source.
#[tokio::test]
async fn unlinked_mod_produces_no_update() {
    install_cassette_env();

    let m = make_mod("Orphan", "1.0.0", "Orphan");
    let sources: HashMap<String, ModSourceEntry> = HashMap::new();
    let updates = check_all_updates(&[m], &sources, None, None, None, None)
        .await
        .expect("check_all_updates on an unlinked mod should not error");
    assert!(updates.is_empty(), "expected no updates, got {:?}", updates);
}
