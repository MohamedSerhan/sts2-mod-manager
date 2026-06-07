//! Static guardrails for log severity.
//!
//! The logger is part of the support surface: users attach `sts2mm.log`
//! when reporting upload/install/update failures. Recoverable fallbacks
//! should be WARN; terminal failures for the requested operation should be
//! ERROR. This test pins the messages that have regressed before.

use std::path::PathBuf;

fn src_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src")
}

/// Read a source file by path relative to `src/`. If the bare `<name>.rs`
/// file no longer exists (the module was split into a directory of
/// the same stem), concatenate the contents of every `*.rs` under that
/// directory so the phrase scan still finds messages that have moved
/// between the new sub-files.
///
/// Why: the historic single-file modules `sharing.rs`, `mods.rs`
/// became directories during the 1.7.0 re-architecture. The test cases
/// below still spell the original filename (intentional — that's the
/// stable identity callers know), so the loader picks up whichever
/// shape exists on disk.
fn read_module_source(rel_path: &str) -> String {
    let direct = src_root().join(rel_path);
    if direct.exists() {
        return std::fs::read_to_string(&direct)
            .unwrap_or_else(|e| panic!("read {}: {}", direct.display(), e));
    }
    // Strip the `.rs` so `sharing.rs` becomes the `sharing/` directory.
    let stem = rel_path.trim_end_matches(".rs");
    let dir = src_root().join(stem);
    if !dir.is_dir() {
        panic!(
            "neither {} nor a corresponding directory exist; \
             update the log-severity test to track the new layout",
            direct.display()
        );
    }
    let mut combined = String::new();
    for entry in
        std::fs::read_dir(&dir).unwrap_or_else(|e| panic!("read_dir {}: {}", dir.display(), e))
    {
        let entry = entry.expect("dir entry");
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) == Some("rs") {
            combined.push_str(
                &std::fs::read_to_string(&path)
                    .unwrap_or_else(|e| panic!("read {}: {}", path.display(), e)),
            );
            combined.push('\n');
        }
    }
    combined
}

#[test]
fn terminal_failure_messages_are_not_warn_level() {
    let cases = [
        ("profiles.rs", "Profile apply: profile expects"),
        ("profiles.rs", "GitHub download also failed for"),
        (
            "profiles.rs",
            "No download source for mod '{}' -- cannot restore",
        ),
        ("subscriptions.rs", "Repair: failed to remove"),
        ("subscriptions.rs", "GitHub download also failed for"),
        (
            "subscriptions.rs",
            "No download source for mod '{}' in subscription update",
        ),
        (
            "subscriptions.rs",
            "Failed to persist active_profile.txt after subscription update",
        ),
        ("mods.rs", "Some mods failed to enable"),
        ("mods.rs", "Some mods failed to disable"),
        ("mods.rs", "Skipping preserve of"),
        ("mods.rs", "Failed to refresh active profile manifest"),
        ("game.rs", "Couldn't persist launch_mode"),
        (
            "downloads_watcher.rs",
            "Downloads watcher: failed to install",
        ),
        (
            "quick_add.rs",
            "Quick add: failed to persist GitHub source for",
        ),
        ("sharing.rs", "Could not download {} mods"),
        (
            "sharing.rs",
            "Failed to persist active_profile.txt after install_shared_profile",
        ),
        ("updater.rs", "produced an unhealthy ModInfo"),
    ];

    for (file, phrase) in cases {
        let source = read_module_source(file);
        let pattern = format!(r#"(?s)log::warn!\s*\(\s*"[^"]*{}"#, regex::escape(phrase));
        let re = regex::Regex::new(&pattern).unwrap();
        assert!(
            !re.is_match(&source),
            "{} logs terminal failure phrase {:?} at WARN; use log::error! instead",
            file,
            phrase
        );
    }
}
