//! Guardrail: any code path that rewrites the on-disk mods folder to match
//! a profile manifest MUST also claim the active-profile slot.
//!
//! Background: a prior bug had `install_shared_profile` apply the imported
//! pack's loadout to disk while leaving `state.active_profile` /
//! `active_profile.txt` pointing at whatever profile was active before.
//! Re-share of that "active" profile then snapshotted the imported
//! loadout into the wrong profile's JSON and pushed it out to subscribers.
//!
//! `apply_subscription_update` already had the active-profile write; the
//! same operation in `install_shared_profile` was missing. This test pins
//! both so a future refactor can't drop one again.
//!
//! It is intentionally a static-source check rather than an end-to-end
//! run: the production paths are async + require Tauri state + GitHub
//! mocking, so an integration test would carry far more setup cost than
//! the one-line invariant being enforced.

use std::path::PathBuf;

fn read_source(rel_path: &str) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src").join(rel_path);
    std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("read {}: {}", path.display(), e))
}

fn function_body<'a>(source: &'a str, signature: &str) -> &'a str {
    let start = source
        .find(signature)
        .unwrap_or_else(|| panic!("function signature not found: {}", signature));
    let from = &source[start..];
    let brace = from
        .find('{')
        .unwrap_or_else(|| panic!("no opening brace for {}", signature));
    let mut depth = 0i32;
    let bytes = from.as_bytes();
    for (i, &b) in bytes.iter().enumerate().skip(brace) {
        match b {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return &from[..=i];
                }
            }
            _ => {}
        }
    }
    panic!("unterminated function body for {}", signature);
}

#[test]
fn install_shared_profile_claims_active_profile_slot() {
    let source = read_source("sharing/mod.rs");
    let body = function_body(&source, "pub async fn install_shared_profile(");
    assert!(
        body.contains("s.active_profile = Some(profile.name.clone())"),
        "install_shared_profile must set state.active_profile after apply_profile_with_pins; \
         otherwise the previously-active profile is silently drifted (see bug where Re-share \
         snapshotted an imported loadout into the wrong profile's JSON)."
    );
    assert!(
        body.contains("active_profile.txt"),
        "install_shared_profile must persist active_profile.txt so the next launch restores \
         the imported pack rather than the pre-import profile."
    );
}

#[test]
fn apply_subscription_update_claims_active_profile_slot() {
    let source = read_source("subscriptions.rs");
    let body = function_body(&source, "async fn apply_subscription_update_inner(");
    assert!(
        body.contains("s.active_profile = Some(remote.name.clone())"),
        "apply_subscription_update_inner must set state.active_profile after \
         apply_profile_with_pins (same invariant as install_shared_profile)."
    );
    assert!(
        body.contains("active_profile.txt"),
        "apply_subscription_update_inner must persist active_profile.txt."
    );
}
