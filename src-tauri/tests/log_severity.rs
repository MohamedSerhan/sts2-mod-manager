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
        let path = src_root().join(file);
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read {}: {}", path.display(), e));
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
