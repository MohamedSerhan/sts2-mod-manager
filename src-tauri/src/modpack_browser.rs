//! In-app modpack browser. Discovery via GitHub repo search for
//! `q=sts2mm-profiles+in:name`, filtered to manifests where
//! `public == Some(true)`. The curator's own packs are filtered out
//! using the cached authed username.

use serde::{Deserialize, Serialize};

use crate::profiles::Profile;

const PROFILES_REPO: &str = "sts2mm-profiles";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowserCard {
    pub owner: String,
    pub code: String,
    pub name: String,
    pub mod_count: usize,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct BrowserPage {
    pub cards: Vec<BrowserCard>,
    pub page: u32,
    pub has_next_page: bool,
    pub stale: bool,
    pub fetched_at: i64,
}

/// A raw (owner, filename, parsed manifest) tuple as gathered from the
/// search-then-fetch pipeline. Kept separate from `BrowserCard` so this
/// filter is a pure function with no HTTP dependency.
pub struct RawManifest {
    pub owner: String,
    pub filename: String,
    pub profile: Profile,
}

/// Filter raw manifests to public, non-self entries, and project them
/// into `BrowserCard` shape. Pure function.
pub fn filter_to_browser_cards(
    raw: Vec<RawManifest>,
    self_owner: Option<&str>,
) -> Vec<BrowserCard> {
    raw.into_iter()
        .filter(|r| r.profile.public == Some(true))
        .filter(|r| match self_owner {
            Some(me) => !r.owner.eq_ignore_ascii_case(me),
            None => true,
        })
        .map(|r| BrowserCard {
            owner: r.owner,
            code: filename_to_code(&r.filename),
            name: r.profile.name,
            mod_count: r.profile.mods.len(),
            created_at: r.profile.created_at.to_rfc3339(),
            updated_at: r.profile.updated_at.to_rfc3339(),
        })
        .collect()
}

/// Turn "aa5a315d61ae.json" into "AA5A-315D-61AE".
fn filename_to_code(filename: &str) -> String {
    let stem = filename.trim_end_matches(".json");
    let upper: String = stem.chars().filter(|c| c.is_ascii_alphanumeric()).take(12).collect();
    if upper.len() >= 12 {
        format!("{}-{}-{}", &upper[0..4], &upper[4..8], &upper[8..12]).to_uppercase()
    } else {
        upper.to_uppercase()
    }
}

/// True iff cached page is still within TTL. Pure function.
pub fn is_cache_fresh(fetched_at: i64, now_secs: i64, ttl_secs: i64) -> bool {
    now_secs.saturating_sub(fetched_at) < ttl_secs
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    fn make_profile(name: &str, public: Option<bool>) -> Profile {
        Profile {
            name: name.into(),
            game_version: None,
            created_by: None,
            mods: vec![],
            created_at: Utc::now(),
            updated_at: Utc::now(),
            public,
        }
    }

    #[test]
    fn filename_to_code_formats_with_dashes() {
        assert_eq!(filename_to_code("aa5a315d61ae.json"), "AA5A-315D-61AE");
    }

    #[test]
    fn filter_drops_unlisted_manifests() {
        let raw = vec![
            RawManifest { owner: "alice".into(), filename: "aa5a315d61ae.json".into(),
                profile: make_profile("listed", Some(true)) },
            RawManifest { owner: "bob".into(), filename: "bb5a315d61ae.json".into(),
                profile: make_profile("unlisted-none", None) },
            RawManifest { owner: "carol".into(), filename: "cc5a315d61ae.json".into(),
                profile: make_profile("unlisted-false", Some(false)) },
        ];
        let cards = filter_to_browser_cards(raw, None);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].name, "listed");
    }

    #[test]
    fn filter_drops_self_owner_case_insensitive() {
        let raw = vec![
            RawManifest { owner: "Alice".into(), filename: "aa5a315d61ae.json".into(),
                profile: make_profile("mine", Some(true)) },
            RawManifest { owner: "bob".into(), filename: "bb5a315d61ae.json".into(),
                profile: make_profile("theirs", Some(true)) },
        ];
        let cards = filter_to_browser_cards(raw, Some("alice"));
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].name, "theirs");
    }

    #[test]
    fn filter_keeps_all_when_no_self_owner() {
        let raw = vec![
            RawManifest { owner: "alice".into(), filename: "aa5a315d61ae.json".into(),
                profile: make_profile("a", Some(true)) },
            RawManifest { owner: "bob".into(), filename: "bb5a315d61ae.json".into(),
                profile: make_profile("b", Some(true)) },
        ];
        let cards = filter_to_browser_cards(raw, None);
        assert_eq!(cards.len(), 2);
    }

    #[test]
    fn cache_fresh_within_ttl() {
        assert!(is_cache_fresh(1000, 1500, 1000));   // 500s old, ttl 1000 -> fresh
        assert!(!is_cache_fresh(1000, 2500, 1000));  // 1500s old, ttl 1000 -> stale
    }
}
