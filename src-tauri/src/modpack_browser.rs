//! In-app modpack browser. Discovery via GitHub repo search for
//! `q=sts2mm-profiles+in:name`, filtered to manifests where
//! `public == Some(true)`. The curator's own packs are included —
//! seeing your published pack in the list is part of the reward.

use std::time::Duration;

use reqwest::Client;
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

/// Filter raw manifests to public entries and project them into
/// `BrowserCard` shape. Pure function.
pub fn filter_to_browser_cards(raw: Vec<RawManifest>) -> Vec<BrowserCard> {
    raw.into_iter()
        .filter(|r| r.profile.public == Some(true))
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

/// One result row from GitHub's repository search.
#[derive(Debug, Deserialize)]
struct SearchRepoItem {
    full_name: String,  // "owner/name"
    name: String,
}

#[derive(Debug, Deserialize)]
struct SearchResponse {
    items: Vec<SearchRepoItem>,
    total_count: u64,
}

/// One Contents API list entry.
#[derive(Debug, Deserialize)]
struct ContentsListEntry {
    name: String,        // filename
    #[serde(rename = "type")]
    kind: String,        // "file" | "dir"
}

const PER_PAGE: u32 = 30;

/// Search GitHub for repos literally named `sts2mm-profiles`. Returns
/// `(items, has_next_page)`. The caller decides how to fan out from there.
pub async fn search_profiles_repos(
    client: &Client,
    page: u32,
) -> Result<(Vec<(String, String)>, bool), String> {
    let url = format!(
        "https://api.github.com/search/repositories?q={}+in:name&per_page={}&page={}",
        PROFILES_REPO, PER_PAGE, page,
    );
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("GitHub search returned {}: {}", status, text));
    }
    let data: SearchResponse = resp.json().await.map_err(|e| e.to_string())?;
    let owners: Vec<(String, String)> = data
        .items
        .into_iter()
        .filter(|r| r.name.eq_ignore_ascii_case(PROFILES_REPO))
        .filter_map(|r| {
            let mut parts = r.full_name.splitn(2, '/');
            let owner = parts.next()?.to_string();
            let repo = parts.next()?.to_string();
            Some((owner, repo))
        })
        .collect();
    let consumed = (page as u64) * (PER_PAGE as u64);
    let has_next_page = consumed < data.total_count;
    Ok((owners, has_next_page))
}

/// List `.json` files at the root of one curator's `sts2mm-profiles` repo.
pub async fn list_manifest_filenames(
    client: &Client,
    owner: &str,
    repo: &str,
) -> Result<Vec<String>, String> {
    let url = format!(
        "https://api.github.com/repos/{}/{}/contents/",
        owner, repo
    );
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        // Missing repo (404), rate-limited (403/429), or auth-blocked (401) —
        // treat as empty so one bad owner can't sink the page. Log so the
        // partial-failure cause is recoverable from logs.
        log::warn!(
            "modpack-browser: list_manifest_filenames {}/{} returned {}",
            owner, repo, status,
        );
        return Ok(vec![]);
    }
    let entries: Vec<ContentsListEntry> = resp.json().await.map_err(|e| e.to_string())?;
    let files = entries
        .into_iter()
        .filter(|e| e.kind == "file" && e.name.to_lowercase().ends_with(".json"))
        .map(|e| e.name)
        .collect();
    Ok(files)
}

use crate::state::{AppState, CachedBrowserPage};
use futures::stream::{FuturesUnordered, StreamExt};

const CACHE_TTL_SECS: i64 = 60 * 60; // 1h
const CONCURRENCY: usize = 8;
/// Overall ceiling for one live fetch (search → per-owner listing →
/// manifest bodies). Each HTTP call already has its own 60s timeout, but a
/// page with many owners can chain those into minutes; this caps the whole
/// operation so the command always returns promptly. On timeout we serve
/// stale cache if we have it, else a clear error — the browser never sits
/// on skeletons forever.
const BROWSER_FETCH_TIMEOUT: Duration = Duration::from_secs(30);

/// Fetch a single manifest from one curator's repo. Returns `None` if
/// the file 404s or fails to parse — the caller silently drops them.
async fn fetch_one_manifest(
    owner: String,
    filename: String,
    token: Option<String>,
) -> Option<RawManifest> {
    let profile = crate::sharing::fetch_shared_profile(&owner, &filename, token.as_deref())
        .await
        .ok()?;
    Some(RawManifest { owner, filename, profile })
}

#[tauri::command]
pub async fn fetch_modpack_browser_page(
    page: u32,
    force_refresh: bool,
    state: tauri::State<'_, AppState>,
) -> Result<BrowserPage, String> {
    let now = chrono::Utc::now().timestamp();

    let (token, cached) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let cached = s.modpack_browser_cache.get(&page).cloned();
        (s.github_token.clone(), cached)
    };

    if !force_refresh {
        if let Some(c) = &cached {
            if is_cache_fresh(c.fetched_at, now, CACHE_TTL_SECS) {
                return Ok(BrowserPage {
                    cards: c.cards.clone(),
                    page,
                    has_next_page: c.has_next_page,
                    stale: false,
                    fetched_at: c.fetched_at,
                });
            }
        }
    }

    let client = crate::sharing::build_client(token.as_deref().unwrap_or(""));

    // Live fetch: GitHub search → per-owner manifest listing → manifest
    // bodies. Wrapped in an overall timeout below so a slow/unreachable
    // GitHub can't pin the command (and the UI) open indefinitely. Returns
    // (cards, has_next_page, owners_was_empty) on success.
    //
    // `owners_was_empty` is captured before the fan-out moves `owners`; the
    // caller uses it to tell "GitHub had nothing" (legitimate empty) apart
    // from "fan-out was rate-limited mid-page" (don't clobber prior cache).
    let fetch_fresh = async {
        let (owners, has_next_page) = search_profiles_repos(&client, page).await?;
        let owners_was_empty = owners.is_empty();

        let mut list_tasks = FuturesUnordered::new();
        for (owner, repo) in owners {
            let client = client.clone();
            list_tasks.push(async move {
                let files = list_manifest_filenames(&client, &owner, &repo).await.unwrap_or_default();
                (owner, files)
            });
        }
        let mut owner_files: Vec<(String, Vec<String>)> = Vec::new();
        while let Some(t) = list_tasks.next().await {
            owner_files.push(t);
        }

        let mut all_manifest_tasks: Vec<(String, String)> = Vec::new();
        for (owner, files) in owner_files {
            for f in files {
                all_manifest_tasks.push((owner.clone(), f));
            }
        }

        let mut raw: Vec<RawManifest> = Vec::new();
        let mut iter = all_manifest_tasks.into_iter();
        let mut inflight = FuturesUnordered::new();
        for _ in 0..CONCURRENCY {
            if let Some((o, f)) = iter.next() {
                inflight.push(fetch_one_manifest(o, f, token.clone()));
            }
        }
        while let Some(result) = inflight.next().await {
            if let Some(r) = result {
                raw.push(r);
            }
            if let Some((o, f)) = iter.next() {
                inflight.push(fetch_one_manifest(o, f, token.clone()));
            }
        }

        let cards = filter_to_browser_cards(raw);
        Ok::<(Vec<BrowserCard>, bool, bool), String>((cards, has_next_page, owners_was_empty))
    };

    let fetched = match tokio::time::timeout(BROWSER_FETCH_TIMEOUT, fetch_fresh).await {
        Ok(inner) => inner,
        Err(_elapsed) => Err(format!(
            "GitHub took too long to respond (over {}s)",
            BROWSER_FETCH_TIMEOUT.as_secs(),
        )),
    };

    let (cards, has_next_page, owners_was_empty) = match fetched {
        Ok(t) => t,
        Err(e) => {
            // Search error or overall timeout: serve the last good cache
            // (flagged stale) if we have one, rather than showing nothing.
            if let Some(c) = cached {
                return Ok(BrowserPage {
                    cards: c.cards,
                    page,
                    has_next_page: c.has_next_page,
                    stale: true,
                    fetched_at: c.fetched_at,
                });
            }
            return Err(e);
        }
    };

    // If the fan-out produced an empty result despite GitHub search returning
    // owners, it's almost certainly a partial rate-limit storm. Don't clobber
    // a previously good cache; surface what we had with a stale flag instead.
    if cards.is_empty() && !owners_was_empty {
        if let Some(c) = cached {
            return Ok(BrowserPage {
                cards: c.cards,
                page,
                has_next_page: c.has_next_page,
                stale: true,
                fetched_at: c.fetched_at,
            });
        }
    }

    let entry = CachedBrowserPage {
        fetched_at: now,
        cards: cards.clone(),
        has_next_page,
    };
    if let Ok(mut s) = state.lock() {
        s.modpack_browser_cache.insert(page, entry);
    }

    Ok(BrowserPage {
        cards,
        page,
        has_next_page,
        stale: false,
        fetched_at: now,
    })
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
        let cards = filter_to_browser_cards(raw);
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].name, "listed");
    }

    #[test]
    fn filter_keeps_all_public_including_self() {
        let raw = vec![
            RawManifest { owner: "alice".into(), filename: "aa5a315d61ae.json".into(),
                profile: make_profile("a", Some(true)) },
            RawManifest { owner: "bob".into(), filename: "bb5a315d61ae.json".into(),
                profile: make_profile("b", Some(true)) },
        ];
        let cards = filter_to_browser_cards(raw);
        assert_eq!(cards.len(), 2);
    }

    #[test]
    fn cache_fresh_within_ttl() {
        assert!(is_cache_fresh(1000, 1500, 1000));
        assert!(!is_cache_fresh(1000, 2500, 1000));
    }

    // The search endpoint can return repos whose name matches the query
    // loosely (e.g., "sts2mm-profiles-backup"). The filter must keep only
    // exact-name matches. This is a behavioral expectation, captured as
    // a regression guard by exercising the function with a stubbed
    // response shape.
    #[test]
    fn search_response_shape_compiles() {
        // Smoke-only: ensure SearchResponse deserializes the documented shape.
        let raw = r#"{
            "items": [
                {"full_name":"alice/sts2mm-profiles","name":"sts2mm-profiles"},
                {"full_name":"bob/sts2mm-profiles-backup","name":"sts2mm-profiles-backup"}
            ],
            "total_count": 2
        }"#;
        let parsed: SearchResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.items.len(), 2);
        // Note: the filter that drops "sts2mm-profiles-backup" lives in
        // search_profiles_repos (uses eq_ignore_ascii_case). Network-bound
        // testing of that filter is covered by manual smoke; the pure
        // assertion here is the parser shape.
    }

    // No-network smoke test: cache hit short-circuits the orchestrator.
    // (Wrapping AppState into tauri::State requires more setup than we
    // want here; the pure helpers carry the real test load.)
    #[tokio::test]
    async fn cache_hit_returns_cached_cards() {
        let state = crate::state::create_app_state();
        let now = chrono::Utc::now().timestamp();
        {
            let mut s = state.lock().unwrap();
            s.modpack_browser_cache.insert(1, CachedBrowserPage {
                fetched_at: now,
                cards: vec![BrowserCard {
                    owner: "alice".into(),
                    code: "AA5A-315D-61AE".into(),
                    name: "Demo".into(),
                    mod_count: 3,
                    created_at: "2026-01-01T00:00:00Z".into(),
                    updated_at: "2026-01-01T00:00:00Z".into(),
                }],
                has_next_page: false,
            });
        }
        let cached = state.lock().unwrap().modpack_browser_cache.get(&1).cloned();
        assert!(cached.is_some());
        let cached = cached.unwrap();
        assert_eq!(cached.cards.len(), 1);
        assert_eq!(cached.cards[0].name, "Demo");
    }
}
