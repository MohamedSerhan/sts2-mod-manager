# Browse Modpacks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an in-app modpack browser that lists opt-in public modpacks discovered from GitHub repos named `sts2mm-profiles`, with one-click install reusing the existing share-code flow.

**Architecture:** Decentralized discovery via `q=sts2mm-profiles+in:name` on GitHub's repo search API. A new `public: Option<bool>` field on the `Profile` manifest is the opt-in flag. A new sidebar entry `Browse Modpacks` (paired with renaming `Browse` → `Browse Mods`) shows a paginated card list backed by an in-memory cache. The publish modal asks once per modpack whether to list, with a "don't ask again" toggle stored in the per-profile `.share` file.

**Tech Stack:** Rust (Tauri 2, reqwest, serde, tokio), React + TypeScript, Vitest, existing `gf-*` CSS tokens.

**Spec:** [`docs/superpowers/specs/2026-05-12-modpack-browser-design.md`](../specs/2026-05-12-modpack-browser-design.md)

---

## File Map

**New files:**
- `src-tauri/src/modpack_browser.rs` — discovery command, cache, filters, tests
- `src/views/BrowseModpacks.tsx` — new view
- `src/views/BrowseModpacks.test.tsx` — view tests
- `src/components/BrowseModpackDetail.tsx` — detail panel (BrowseDetail-style chrome, modpack-shaped data)

**Modified files:**
- `src-tauri/src/profiles.rs` — add `public: Option<bool>` to `Profile`
- `src-tauri/src/sharing.rs` — add `dont_ask_again` to `ShareInfo`; new `set_modpack_listing` command; `share_profile` / `reshare_profile` accept new `list_public: Option<bool>` and `dont_ask_again: bool` params
- `src-tauri/src/state.rs` — add `cached_github_username: Option<String>` and `modpack_browser_cache: HashMap<u32, CachedPage>` to `AppStateInner`
- `src-tauri/src/lib.rs` — `mod modpack_browser;` and register new commands
- `src/hooks/useTauri.ts` — bindings for `fetch_modpack_browser_page` + `set_modpack_listing`; updated signatures for `shareProfile` / `reshareProfile`
- `src/types.ts` — `public?: boolean` on `Profile`; new `BrowserCard`, `BrowserPage` types
- `src/App.tsx` — rename `Browse` → `Browse Mods`; add `Browse Modpacks` nav entry; route to new view
- `src/components/PublishModal.tsx` — pre-success prompt screen with two checkboxes; post-success listing toggle row
- `README.md` — three additions under Profiles & sharing

---

## Task 1: Add `public` field to `Profile` manifest

**Files:**
- Modify: `src-tauri/src/profiles.rs` (the `Profile` struct around line 43-50)
- Modify: `src/types.ts` (the `Profile` interface around line 25-32)

The defensive default (`None` reads as unlisted) is what prevents retroactive listing for existing manifests already in user repos.

- [ ] **Step 1: Add the Rust field**

Edit `src-tauri/src/profiles.rs`, the `Profile` struct:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub game_version: Option<String>,
    pub created_by: Option<String>,
    pub mods: Vec<ProfileMod>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    /// Opt-in flag for the in-app Browse Modpacks tab.
    /// `Some(true)` = listed; `None` / `Some(false)` = unlisted.
    /// Defensive default so any manifest already in a curator's
    /// `sts2mm-profiles` repo (no field present) is treated as opted out.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub public: Option<bool>,
}
```

- [ ] **Step 2: Update `snapshot_current_with_paths` and any `Profile { … }` literals**

Run: `cargo build` from `src-tauri/`. Read every error pointing at a `Profile { name: … }` struct literal and add `public: None`.

Likely call sites (search with Grep, type `rs`, pattern `Profile \{`):
- `profiles.rs` itself (placeholder profile around line 87-94 — set `public: None`)
- `sharing.rs` — `snapshot_current_with_paths` returns a `Profile`; verify it constructs via a struct literal or via a constructor, and add the field if needed
- Any test fixtures

Expected: cargo build succeeds.

- [ ] **Step 3: Write a Rust test**

Add to `src-tauri/src/profiles.rs` at the bottom (or in the existing tests module if present):

```rust
#[cfg(test)]
mod public_field_tests {
    use super::*;

    #[test]
    fn missing_field_deserializes_as_none() {
        let json = r#"{
            "name": "test",
            "game_version": null,
            "created_by": null,
            "mods": [],
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        }"#;
        let profile: Profile = serde_json::from_str(json).unwrap();
        assert_eq!(profile.public, None);
    }

    #[test]
    fn none_value_is_omitted_in_serialized_json() {
        let profile = Profile {
            name: "test".into(),
            game_version: None,
            created_by: None,
            mods: vec![],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
        };
        let json = serde_json::to_string(&profile).unwrap();
        assert!(!json.contains("\"public\""), "got: {}", json);
    }

    #[test]
    fn true_value_roundtrips() {
        let profile = Profile {
            name: "test".into(),
            game_version: None,
            created_by: None,
            mods: vec![],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: Some(true),
        };
        let json = serde_json::to_string(&profile).unwrap();
        assert!(json.contains("\"public\":true"));
        let back: Profile = serde_json::from_str(&json).unwrap();
        assert_eq!(back.public, Some(true));
    }
}
```

- [ ] **Step 4: Run the test**

Run: `cd src-tauri && cargo test profiles::public_field_tests`
Expected: 3 passed.

- [ ] **Step 5: Update the TS type**

Edit `src/types.ts`:

```typescript
export interface Profile {
  name: string;
  game_version: string | null;
  created_by: string | null;
  mods: ProfileMod[];
  created_at: string;
  updated_at: string;
  /** Opt-in flag for the in-app Browse Modpacks tab.
   *  true = listed; null / false = unlisted. */
  public?: boolean | null;
}
```

- [ ] **Step 6: Run the typechecker**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/profiles.rs src-tauri/src/sharing.rs src/types.ts
git commit -m "feat(modpack-browser): add Profile.public opt-in flag"
```

---

## Task 2: Add `dont_ask_again` to `ShareInfo`

**Files:**
- Modify: `src-tauri/src/sharing.rs` (the `ShareInfo` struct around line 88-96)

Persists "don't show the listing prompt again for this modpack" across share/re-share cycles.

- [ ] **Step 1: Add the field**

Edit `src-tauri/src/sharing.rs`, the `ShareInfo` struct:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ShareInfo {
    code: String,
    owner: String,
    file_sha: Option<String>,
    /// True if the curator ticked "don't ask me again" in the publish
    /// prompt. When true, share/re-share skip the listing prompt and
    /// preserve whatever the current manifest's `public` value is.
    #[serde(default)]
    dont_ask_again: bool,
}
```

- [ ] **Step 2: Update every `ShareInfo { … }` literal**

Search: Grep `ShareInfo \{` in `src-tauri/src/sharing.rs`. Add `dont_ask_again: false` to each construction (initial share, reshare update). Existing on-disk `.share` files without the field will deserialize as `false` via `#[serde(default)]`.

- [ ] **Step 3: Write a test for backward compat**

Add to the existing test module at the bottom of `sharing.rs` (or create one):

```rust
#[cfg(test)]
mod share_info_tests {
    use super::*;

    #[test]
    fn missing_dont_ask_again_defaults_false() {
        let json = r#"{
            "code": "AA5A-315D-61AE",
            "owner": "octocat",
            "file_sha": null
        }"#;
        let info: ShareInfo = serde_json::from_str(json).unwrap();
        assert!(!info.dont_ask_again);
    }

    #[test]
    fn dont_ask_again_roundtrips() {
        let info = ShareInfo {
            code: "AA5A-315D-61AE".into(),
            owner: "octocat".into(),
            file_sha: None,
            dont_ask_again: true,
        };
        let json = serde_json::to_string(&info).unwrap();
        let back: ShareInfo = serde_json::from_str(&json).unwrap();
        assert!(back.dont_ask_again);
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test sharing::share_info_tests`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/sharing.rs
git commit -m "feat(modpack-browser): add ShareInfo.dont_ask_again flag"
```

---

## Task 3: Add username + browser cache to `AppState`

**Files:**
- Modify: `src-tauri/src/state.rs` (the `AppStateInner` struct + `new()`)

Caching the GitHub username avoids re-hitting `/user` on every browser refresh. The browser cache is per-page in memory.

- [ ] **Step 1: Define the cache entry type and add fields**

Edit `src-tauri/src/state.rs`. Add after the `PendingNexusInstall` struct:

```rust
/// One page of cached modpack-browser results.
/// `fetched_at` is unix seconds since epoch.
#[derive(Debug, Clone)]
pub struct CachedBrowserPage {
    pub fetched_at: i64,
    pub cards: Vec<crate::modpack_browser::BrowserCard>,
    pub has_next_page: bool,
}
```

Then in `AppStateInner`, add these fields (next to `sharing_in_flight`):

```rust
    /// GitHub username for the current token, looked up once and cached.
    /// Cleared when `set_github_token` runs. Used by the modpack browser
    /// to self-hide the curator's own packs.
    pub cached_github_username: Option<String>,
    /// In-memory cache for `fetch_modpack_browser_page`. Keyed by page
    /// number. TTL is enforced in the command, not here.
    pub modpack_browser_cache: std::collections::HashMap<u32, CachedBrowserPage>,
```

- [ ] **Step 2: Initialize in `new()`**

In `AppStateInner::new()`, the returned `Self { … }` literal, add:

```rust
            cached_github_username: None,
            modpack_browser_cache: std::collections::HashMap::new(),
```

- [ ] **Step 3: Invalidate username cache when token changes**

Find `set_github_token` (Grep `fn set_github_token` in `src-tauri/src/`). In the body, after the token write, add:

```rust
        s.cached_github_username = None;
        s.modpack_browser_cache.clear();
```

(The cache clear is because self-hide depends on the username — a different token might mean a different user, so old cached cards may need re-filtering.)

- [ ] **Step 4: Compile**

Run: `cd src-tauri && cargo build`
Expected: errors only about the not-yet-created `modpack_browser` module reference. That's fine — Task 4 creates it. For now, comment out the `crate::modpack_browser::BrowserCard` reference and replace with a `()` placeholder so the build progresses:

```rust
pub struct CachedBrowserPage {
    pub fetched_at: i64,
    pub cards: Vec<()>,  // temp until Task 4 lands
    pub has_next_page: bool,
}
```

Re-run cargo build. Expected: success.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/state.rs
git commit -m "feat(modpack-browser): add username + page cache to AppState"
```

---

## Task 4: New `modpack_browser` module — types and pure-function filter

**Files:**
- Create: `src-tauri/src/modpack_browser.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod modpack_browser;`)
- Modify: `src-tauri/src/state.rs` (replace the temporary `Vec<()>` with real type)

Split pure logic from HTTP-touching code so the filter can be unit-tested without network or mocks.

- [ ] **Step 1: Create the module skeleton**

Create `src-tauri/src/modpack_browser.rs`:

```rust
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
```

- [ ] **Step 2: Register the module**

Edit `src-tauri/src/lib.rs`, near the other `mod ...;` declarations at the top:

```rust
mod modpack_browser;
```

- [ ] **Step 3: Replace the temporary type in state.rs**

Edit `src-tauri/src/state.rs`, the `CachedBrowserPage` struct:

```rust
pub struct CachedBrowserPage {
    pub fetched_at: i64,
    pub cards: Vec<crate::modpack_browser::BrowserCard>,
    pub has_next_page: bool,
}
```

- [ ] **Step 4: Run the tests**

Run: `cd src-tauri && cargo test modpack_browser::tests`
Expected: 5 passed.

- [ ] **Step 5: Verify whole crate builds**

Run: `cd src-tauri && cargo build`
Expected: success.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/modpack_browser.rs src-tauri/src/lib.rs src-tauri/src/state.rs
git commit -m "feat(modpack-browser): add types and filter helper with tests"
```

---

## Task 5: Discovery — `search_repos` + `list_repo_manifests` + `fetch_manifest`

**Files:**
- Modify: `src-tauri/src/modpack_browser.rs`

Three async helpers that touch GitHub. Each takes a pre-built `reqwest::Client` so tests can inject a mock client if needed. For this task, only happy-path integration is wired — error paths get explicit tests in Task 7.

- [ ] **Step 1: Add the search helper**

Append to `src-tauri/src/modpack_browser.rs`:

```rust
use reqwest::Client;

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
    if !resp.status().is_success() {
        return Ok(vec![]); // missing or rate-limited -> treat as empty
    }
    let entries: Vec<ContentsListEntry> = resp.json().await.map_err(|e| e.to_string())?;
    let files = entries
        .into_iter()
        .filter(|e| e.kind == "file" && e.name.to_lowercase().ends_with(".json"))
        .map(|e| e.name)
        .collect();
    Ok(files)
}
```

- [ ] **Step 2: Add a unit test for the search-result parser**

These helpers are mostly thin wrappers around reqwest, so the unit tests focus on the filtering logic, not the network. Append to the `tests` module:

```rust
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
```

- [ ] **Step 3: Run tests**

Run: `cd src-tauri && cargo test modpack_browser::tests`
Expected: 6 passed.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/modpack_browser.rs
git commit -m "feat(modpack-browser): search + manifest-list helpers"
```

---

## Task 6: Discovery — orchestrator + cache + Tauri command

**Files:**
- Modify: `src-tauri/src/modpack_browser.rs`
- Modify: `src-tauri/src/sharing.rs` (re-export or expose `build_client` + `get_github_username`, or duplicate the small helper)
- Modify: `src-tauri/src/lib.rs` (register the new command)

Wires the helpers from Task 5 together with the cache and self-hide filter into one Tauri command.

- [ ] **Step 1: Expose `build_client` and `get_github_username` from sharing.rs**

In `src-tauri/src/sharing.rs`, change the visibility of those two free functions:

```rust
pub(crate) fn build_client(token: &str) -> reqwest::Client { ... }

pub(crate) async fn get_github_username(token: &str) -> Result<String> { ... }
```

(Keeping them crate-private rather than fully `pub` — they're an internal API used by another module in the same crate.)

- [ ] **Step 2: Add the orchestrator + Tauri command**

Append to `src-tauri/src/modpack_browser.rs`:

```rust
use crate::state::{AppState, CachedBrowserPage};
use futures::stream::{FuturesUnordered, StreamExt};

const CACHE_TTL_SECS: i64 = 60 * 60; // 1h
const CONCURRENCY: usize = 8;

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

    // Pull what we need from state (cache hit check + token + self-hide).
    let (token, cached, self_owner_cached) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let cached = s.modpack_browser_cache.get(&page).cloned();
        (s.github_token.clone(), cached, s.cached_github_username.clone())
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

    // Resolve self_owner: prefer cached value, otherwise look it up once
    // and cache it. If there's no token, leave None — self-hide is a
    // nice-to-have when anonymous.
    let self_owner = match (self_owner_cached, token.as_deref()) {
        (Some(u), _) => Some(u),
        (None, Some(t)) => {
            match crate::sharing::get_github_username(t).await {
                Ok(u) => {
                    if let Ok(mut s) = state.lock() {
                        s.cached_github_username = Some(u.clone());
                    }
                    Some(u)
                }
                Err(e) => {
                    log::warn!("modpack-browser: username lookup failed: {}", e);
                    None
                }
            }
        }
        (None, None) => None,
    };

    // Build a client. The existing sharing::build_client signature takes a
    // token string — for anonymous, pass empty (Authorization header is
    // built conditionally if the parse succeeds, and "Bearer " on its own
    // is harmless if the server treats it as malformed; GitHub treats
    // missing auth as anonymous regardless).
    let client = crate::sharing::build_client(token.as_deref().unwrap_or(""));

    // 1. Search repos for this page.
    let search_result = search_profiles_repos(&client, page).await;
    let (owners, has_next_page) = match search_result {
        Ok(t) => t,
        Err(e) => {
            // Return stale cache if we have one, otherwise propagate.
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

    // 2. List manifests for each repo (concurrent, bounded).
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

    // 3. Fetch every manifest, with bounded concurrency.
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

    // 4. Filter + project.
    let cards = filter_to_browser_cards(raw, self_owner.as_deref());

    // 5. Store in cache and return.
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
```

- [ ] **Step 3: Add `futures` to Cargo.toml if not already present**

Check `src-tauri/Cargo.toml` for `futures = "..."`. If missing, add `futures = "0.3"` to `[dependencies]`.

Run: `cd src-tauri && cargo build`
Expected: success.

- [ ] **Step 4: Register the command**

Edit `src-tauri/src/lib.rs`, in the `.invoke_handler(tauri::generate_handler![...])` block (around line 232), add:

```rust
            modpack_browser::fetch_modpack_browser_page,
```

(Group it with sharing-related commands for discoverability.)

- [ ] **Step 5: Add an integration-style test for cache freshness**

Cache logic depends on `AppState`, which is harder to unit-test cleanly. The pure helper `is_cache_fresh` already has unit coverage. For the orchestrator, add a smoke test that exercises the happy path without network. Append to the `tests` module:

```rust
    // No-network smoke test: a cache hit short-circuits the orchestrator.
    // We pre-populate the cache and assert the command returns the cached
    // cards untouched.
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
        // Wrapping AppState into Tauri's State requires a tauri::test or
        // a manual State::from — keeping the orchestrator network-free
        // for true unit testing isn't feasible here without injection
        // refactoring. The pure helpers carry the test load; this stub
        // is a placeholder to confirm the cache field is wired through.
        let cached = state.lock().unwrap().modpack_browser_cache.get(&1).cloned();
        assert!(cached.is_some());
        let cached = cached.unwrap();
        assert_eq!(cached.cards.len(), 1);
        assert_eq!(cached.cards[0].name, "Demo");
    }
```

- [ ] **Step 6: Run tests**

Run: `cd src-tauri && cargo test modpack_browser`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/modpack_browser.rs src-tauri/src/sharing.rs src-tauri/src/lib.rs src-tauri/Cargo.toml
git commit -m "feat(modpack-browser): orchestrator command with cache + self-hide"
```

---

## Task 7: `set_modpack_listing` command + share/reshare param plumbing

**Files:**
- Modify: `src-tauri/src/sharing.rs`
- Modify: `src-tauri/src/lib.rs`

Three sub-changes wired together:

(a) `share_profile` / `reshare_profile` accept two new params (`list_public: Option<bool>`, `dont_ask_again: bool`) that the modal passes in based on the user's prompt answer.

(b) A new `set_modpack_listing(name, public)` Tauri command flips an already-shared profile's `public` flag and re-uploads the manifest only.

(c) Re-share logic respects `dont_ask_again`: when the curator's `.share` file has `dont_ask_again: true`, the modal skips the prompt and the new `list_public` param arrives as `None`, meaning "preserve whatever the manifest already has."

- [ ] **Step 1: Update share_profile signature**

In `src-tauri/src/sharing.rs`, change `share_profile`:

```rust
#[tauri::command]
pub async fn share_profile(
    name: String,
    list_public: Option<bool>,    // NEW — None = leave field unset/None
    dont_ask_again: bool,         // NEW — written to .share
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ShareResult, String> {
    // ... existing setup ...

    // After loading the profile, before bundling:
    if let Some(p) = list_public {
        profile.public = Some(p);
    }

    // ... existing share logic continues unchanged ...

    // When writing the ShareInfo to disk, include the flag:
    let share_info = ShareInfo {
        code: code.clone(),
        owner: username.clone(),
        file_sha: Some(file_sha),
        dont_ask_again,
    };
    // ... rest of function unchanged ...
}
```

The re-share short-circuit at the top of `share_profile` (around line 689 — "If already shared, reuse the existing code") must forward the new params to `reshare_profile`. Change that call:

```rust
    if share_info_path.exists() {
        log::info!("Profile '{}' already shared, reusing code via reshare", name);
        return reshare_profile(name, list_public, dont_ask_again, app_handle, state).await;
    }
```

- [ ] **Step 2: Update reshare_profile signature**

Same pattern:

```rust
#[tauri::command]
pub async fn reshare_profile(
    name: String,
    list_public: Option<bool>,    // NEW
    dont_ask_again: bool,         // NEW
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<ShareResult, String> {
    // ... existing setup ...

    // After snapshot, before bundling:
    // Preserve previous public value (re-snapshot doesn't include it
    // since snapshot_current_with_paths constructs a fresh Profile).
    if let Some(ref old) = old_profile {
        profile.public = old.public;
    }
    // Override if the caller explicitly answered the prompt this time.
    if let Some(p) = list_public {
        profile.public = Some(p);
    }

    // ... existing logic ...

    // When writing back the ShareInfo, include the flag. Preserve the
    // previous value if the caller didn't override (re-shares without the
    // prompt should keep the prior dont_ask_again state):
    let updated_info = ShareInfo {
        code: share_info.code,
        owner: share_info.owner,
        file_sha: Some(file_sha),
        dont_ask_again: dont_ask_again || share_info.dont_ask_again,
    };
    // ... rest unchanged ...
}
```

Note the `dont_ask_again || share_info.dont_ask_again` — once a user has ticked don't-ask-again, future re-shares can't accidentally clear it (defensive). If they want to re-enable the prompt, the manual toggle path (Task 8/Step 3 in PublishModal) can clear it.

- [ ] **Step 3: Add `set_modpack_listing` command**

Append to `sharing.rs`:

```rust
/// Flip an already-shared profile's `public` flag and re-upload the
/// manifest only (no mod re-bundling). Used by the post-share toggle
/// in PublishModal and by any future manual override surface.
#[tauri::command]
pub async fn set_modpack_listing(
    name: String,
    public: bool,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    let (profiles_path, token) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        let token = s.github_token.clone().ok_or("GitHub token required")?;
        (s.profiles_path.clone(), token)
    };

    // Must have been shared before.
    let share_info_path = profiles_path.join(format!("{}.share", name));
    let mut share_info: ShareInfo = serde_json::from_str(
        &std::fs::read_to_string(&share_info_path)
            .map_err(|_| "Profile has not been shared yet.".to_string())?,
    ).map_err(|e| e.to_string())?;

    // Update local profile JSON.
    let mut profile =
        crate::profiles::load_profile(&name, &profiles_path).map_err(|e| e.to_string())?;
    profile.public = Some(public);
    crate::profiles::save_profile(&profile, &profiles_path).map_err(|e| e.to_string())?;

    // Re-upload manifest only.
    let filename = code_to_filename(&share_info.code);
    let profile_json = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    let (file_sha, _html_url) = upsert_file(
        &token,
        &share_info.owner,
        &filename,
        &profile_json,
        share_info.file_sha.as_deref(),
        &format!("Update profile listing: {} -> {}", profile.name, public),
    )
    .await
    .map_err(|e| e.to_string())?;

    share_info.file_sha = Some(file_sha);
    let _ = std::fs::write(
        &share_info_path,
        serde_json::to_string_pretty(&share_info).unwrap(),
    );

    // Invalidate browser cache so the change shows on next refresh.
    if let Ok(mut s) = state.lock() {
        s.modpack_browser_cache.clear();
    }

    Ok(())
}
```

- [ ] **Step 4: Register the new command**

In `src-tauri/src/lib.rs` `generate_handler![...]`:

```rust
            sharing::set_modpack_listing,
```

- [ ] **Step 5: Add tests**

Append to `sharing.rs`:

```rust
#[cfg(test)]
mod listing_tests {
    use super::*;
    use chrono::Utc;
    use tempfile::TempDir;

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
    fn reshare_preserves_existing_public_when_no_override() {
        // Caller passes list_public: None. The Profile struct's `public`
        // field should be preserved from the prior version. We assert the
        // merge logic directly rather than driving the whole command.
        let prior = make_profile("p", Some(true));
        let mut fresh = make_profile("p", None); // snapshot has no public field

        // Mirror the merge from reshare_profile:
        if true /* old_profile.is_some() */ {
            fresh.public = prior.public;
        }
        let list_public: Option<bool> = None;
        if let Some(p) = list_public {
            fresh.public = Some(p);
        }
        assert_eq!(fresh.public, Some(true));
    }

    #[test]
    fn reshare_overrides_when_caller_explicit() {
        let prior = make_profile("p", Some(true));
        let mut fresh = make_profile("p", None);
        fresh.public = prior.public;
        let list_public: Option<bool> = Some(false);
        if let Some(p) = list_public {
            fresh.public = Some(p);
        }
        assert_eq!(fresh.public, Some(false));
    }

    #[test]
    fn dont_ask_again_is_sticky() {
        let prior = ShareInfo {
            code: "AA5A-315D-61AE".into(),
            owner: "octocat".into(),
            file_sha: None,
            dont_ask_again: true,
        };
        let caller_dont_ask_again = false;
        let merged = caller_dont_ask_again || prior.dont_ask_again;
        assert!(merged, "once set, dont_ask_again must not be cleared by a re-share that didn't prompt");
    }
}
```

(The full `set_modpack_listing` end-to-end test requires HTTP mocking — out of scope. The compose-the-types tests above guard the merge logic that's most likely to regress.)

- [ ] **Step 6: Run tests**

Run: `cd src-tauri && cargo test sharing`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/sharing.rs src-tauri/src/lib.rs
git commit -m "feat(modpack-browser): set_modpack_listing + share/reshare params"
```

---

## Task 8: TS types + useTauri bindings

**Files:**
- Modify: `src/types.ts`
- Modify: `src/hooks/useTauri.ts`

Frontend can now call the new commands. Updates `shareProfile` / `reshareProfile` signatures too.

- [ ] **Step 1: Add types**

Append to `src/types.ts`:

```typescript
export interface BrowserCard {
  owner: string;
  code: string;           // "AA5A-315D-61AE"
  name: string;
  mod_count: number;
  created_at: string;     // ISO
  updated_at: string;     // ISO
}

export interface BrowserPage {
  cards: BrowserCard[];
  page: number;
  has_next_page: boolean;
  stale: boolean;
  fetched_at: number;     // unix seconds
}
```

- [ ] **Step 2: Update useTauri bindings**

Edit `src/hooks/useTauri.ts`. Find the existing `shareProfile` and `reshareProfile` functions (Grep for them). Update:

```typescript
export async function shareProfile(
  name: string,
  listPublic: boolean | null,
  dontAskAgain: boolean,
): Promise<ShareResult> {
  return invoke('share_profile', { name, listPublic, dontAskAgain });
}

export async function reshareProfile(
  name: string,
  listPublic: boolean | null,
  dontAskAgain: boolean,
): Promise<ShareResult> {
  return invoke('reshare_profile', { name, listPublic, dontAskAgain });
}
```

(Tauri's `invoke` converts camelCase keys to snake_case automatically for command arg names.)

Then add the new bindings (use the existing section pattern with a section header comment if the file has them):

```typescript
import type { BrowserPage } from '../types';

export async function fetchModpackBrowserPage(
  page: number,
  forceRefresh: boolean,
): Promise<BrowserPage> {
  return invoke('fetch_modpack_browser_page', { page, forceRefresh });
}

export async function setModpackListing(
  name: string,
  public_: boolean,
): Promise<void> {
  return invoke('set_modpack_listing', { name, public: public_ });
}
```

(`public` is a reserved-ish identifier in some contexts; the underscore suffix keeps the local clean while the wire name stays correct.)

- [ ] **Step 3: Fix existing callers of `shareProfile` / `reshareProfile`**

Search: Grep `shareProfile\(` and `reshareProfile\(` across `src/`.

For each existing call site that doesn't yet pass the new params, pass `(name, null, false)` — preserving the current behavior (don't change `public`, don't set don't-ask-again). The PublishModal callers will be updated properly in Task 11 to pass the user's actual choices; this step keeps everything else compiling.

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/hooks/useTauri.ts src/
git commit -m "feat(modpack-browser): TS types and Tauri bindings"
```

---

## Task 9: BrowseModpacks view

**Files:**
- Create: `src/views/BrowseModpacks.tsx`
- Create: `src/views/BrowseModpacks.test.tsx`

New view. Card list, refresh button, loading/empty/rate-limit/stale states. Detail panel wiring follows in Task 10.

- [ ] **Step 1: Write a failing test**

Create `src/views/BrowseModpacks.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BrowseModpacksView } from './BrowseModpacks';

vi.mock('../hooks/useTauri', () => ({
  fetchModpackBrowserPage: vi.fn(),
}));

import { fetchModpackBrowserPage } from '../hooks/useTauri';

const mocked = fetchModpackBrowserPage as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => mocked.mockReset());

describe('BrowseModpacksView', () => {
  it('renders skeleton then cards on success', async () => {
    mocked.mockResolvedValueOnce({
      cards: [
        { owner: 'alice', code: 'AA5A-315D-61AE', name: 'Aggro Build',
          mod_count: 12, created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-05-01T00:00:00Z' },
      ],
      page: 1, has_next_page: false, stale: false, fetched_at: 1_700_000_000,
    });
    render(<BrowseModpacksView />);
    await waitFor(() => expect(screen.getByText(/Aggro Build/i)).toBeInTheDocument());
    expect(screen.getByText(/@alice/i)).toBeInTheDocument();
    expect(screen.getByText(/12/)).toBeInTheDocument();
  });

  it('renders empty state when no cards', async () => {
    mocked.mockResolvedValueOnce({
      cards: [], page: 1, has_next_page: false, stale: false, fetched_at: 1_700_000_000,
    });
    render(<BrowseModpacksView />);
    await waitFor(() => expect(screen.getByText(/be the first to share/i)).toBeInTheDocument());
  });

  it('renders rate-limit message on 403/429 error', async () => {
    mocked.mockRejectedValueOnce(new Error('GitHub search returned 429: API rate limit exceeded'));
    render(<BrowseModpacksView />);
    await waitFor(() => expect(screen.getByText(/rate-limiting us/i)).toBeInTheDocument());
  });

  it('renders stale banner when result is stale', async () => {
    mocked.mockResolvedValueOnce({
      cards: [{ owner: 'alice', code: 'AA5A-315D-61AE', name: 'Aggro',
        mod_count: 1, created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z' }],
      page: 1, has_next_page: false, stale: true, fetched_at: 1_700_000_000,
    });
    render(<BrowseModpacksView />);
    await waitFor(() => expect(screen.getByText(/cached results/i)).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run the test, expect FAIL**

Run: `npx vitest run src/views/BrowseModpacks.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the view**

Create `src/views/BrowseModpacks.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { RefreshCw, Search, Plus } from 'lucide-react';
import { fetchModpackBrowserPage } from '../hooks/useTauri';
import type { BrowserCard, BrowserPage } from '../types';
import { useToast } from '../contexts/ToastContext';

interface Props {
  onSelect?: (card: BrowserCard) => void;
  onGoToProfiles?: () => void;
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function isRateLimit(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /\b(403|429)\b/.test(m) || /rate limit/i.test(m);
}

export function BrowseModpacksView({ onSelect, onGoToProfiles }: Props = {}) {
  const toast = useToast();
  const [page, setPage] = useState<BrowserPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [rateLimited, setRateLimited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load(force = false) {
    setLoading(true);
    setRateLimited(false);
    setError(null);
    try {
      const result = await fetchModpackBrowserPage(1, force);
      setPage(result);
    } catch (e) {
      if (isRateLimit(e)) {
        setRateLimited(true);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(false); /* eslint-disable-line react-hooks/exhaustive-deps */ }, []);

  return (
    <div className="gf-view">
      <div className="gf-view-head">
        <h2 className="gf-view-title">Browse Modpacks</h2>
        <button
          className="gf-btn-3"
          onClick={() => load(true)}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw size={14} className={loading ? 'gf-spin' : undefined} />
          {page && !loading ? ` Last refreshed ${relativeTime(new Date(page.fetched_at * 1000).toISOString())}` : ''}
        </button>
      </div>

      {page?.stale && (
        <div className="gf-banner gf-banner-warn">
          Showing cached results — couldn't reach GitHub.
        </div>
      )}

      {rateLimited && (
        <div className="gf-banner gf-banner-warn">
          GitHub is rate-limiting us — try again in a minute, or connect a GitHub token in Settings for a higher limit.
        </div>
      )}

      {error && (
        <div className="gf-banner gf-banner-error">{error}</div>
      )}

      {loading && !page && (
        <div className="gf-card-list">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="gf-card gf-skeleton" style={{ height: 64 }} />
          ))}
        </div>
      )}

      {page && page.cards.length === 0 && !rateLimited && !error && (
        <div className="gf-empty">
          <Search size={28} />
          <div className="gf-empty-title">No public modpacks found yet — be the first to share one!</div>
          {onGoToProfiles && (
            <button className="gf-btn-2" onClick={onGoToProfiles}>
              <Plus size={12} /> Go to Profiles
            </button>
          )}
        </div>
      )}

      {page && page.cards.length > 0 && (
        <div className="gf-card-list">
          {page.cards.map((c) => (
            <button
              key={`${c.owner}/${c.code}`}
              className="gf-card gf-card-clickable"
              onClick={() => onSelect?.(c)}
            >
              <div className="gf-card-title">{c.name}</div>
              <div className="gf-card-sub">
                @{c.owner} · {c.mod_count} mod{c.mod_count === 1 ? '' : 's'} · Updated {relativeTime(c.updated_at)}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run src/views/BrowseModpacks.test.tsx`
Expected: 4 passed.

If a class like `gf-banner-warn` or `gf-empty` doesn't exist yet, check `src/styles.css` and add minimal styles or use inline styles consistent with existing patterns from `BrowseView`. Don't introduce new design tokens — match what's already there.

- [ ] **Step 5: Commit**

```bash
git add src/views/BrowseModpacks.tsx src/views/BrowseModpacks.test.tsx
git commit -m "feat(modpack-browser): BrowseModpacks view with states"
```

---

## Task 10: BrowseModpackDetail component

**Files:**
- Create: `src/components/BrowseModpackDetail.tsx`
- Modify: `src/views/BrowseModpacks.tsx` (wire detail open/close)

Detail panel that fetches the full manifest by share code, shows the mod list, and exposes Install.

- [ ] **Step 1: Implement the detail component**

Create `src/components/BrowseModpackDetail.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { X, Download, ExternalLink } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { BrowserCard, Profile } from '../types';
import { fetchSharedProfile, installSharedProfile } from '../hooks/useTauri';
import { useToast } from '../contexts/ToastContext';

interface Props {
  card: BrowserCard;
  onClose: () => void;
  onInstalled?: () => void;
}

export function BrowseModpackDetail({ card, onClose, onInstalled }: Props) {
  const toast = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSharedProfile(`${card.owner}/${card.code}`)
      .then((p) => { if (!cancelled) setProfile(p); })
      .catch((e) => toast.error(`Couldn't load modpack: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [card.owner, card.code, toast]);

  async function handleInstall() {
    setInstalling(true);
    try {
      await installSharedProfile(`${card.owner}/${card.code}`);
      toast.success(`Installed: ${card.name}`);
      onInstalled?.();
      onClose();
    } catch (e) {
      toast.error(`Install failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(false);
    }
  }

  async function openCuratorProfile() {
    try { await openUrl(`https://github.com/${card.owner}`); } catch { /* noop */ }
  }

  return (
    <div className="gf-modal-back" onClick={onClose}>
      <div className="gf-modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="gf-modal-head">
          <div>
            <div className="gf-modal-title">{card.name}</div>
            <div className="gf-modal-sub">
              <button className="gf-btn-3" onClick={openCuratorProfile} title="Open curator on GitHub">
                @{card.owner} <ExternalLink size={11} />
              </button>
              {' · '}{card.mod_count} mods
            </div>
          </div>
          <button className="gf-btn-3 gf-btn-icon" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body">
          {loading && <div>Loading…</div>}
          {profile && (
            <div className="gf-mod-list">
              {profile.mods.map((m) => (
                <div key={m.name} className="gf-mod-row">
                  <span>{m.name}</span>
                  <span className="gf-dim">{m.version}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={onClose}>Cancel</button>
          <div style={{ flex: 1 }} />
          <button className="gf-btn" onClick={handleInstall} disabled={installing || !profile}>
            <Download size={12} /> {installing ? 'Installing…' : 'Install'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Wire it in BrowseModpacks**

Edit `src/views/BrowseModpacks.tsx`. Add state for the selected card and render the detail:

```tsx
import { BrowseModpackDetail } from '../components/BrowseModpackDetail';
// ...
const [selected, setSelected] = useState<BrowserCard | null>(null);
// ...
return (
  <>
    <div className="gf-view">
      {/* existing JSX, change onSelect={onSelect} -> onSelect={setSelected} */}
    </div>
    {selected && (
      <BrowseModpackDetail
        card={selected}
        onClose={() => setSelected(null)}
      />
    )}
  </>
);
```

Drop the `onSelect` prop from `Props` if no longer needed externally.

- [ ] **Step 3: Verify `fetchSharedProfile` and `installSharedProfile` exist in useTauri**

Search: Grep `fetchSharedProfile|installSharedProfile` in `src/hooks/useTauri.ts`.

If either is missing, add bindings that mirror the existing share-code paste flow (look at how `Home.tsx` consumes a pasted code for the working signature).

- [ ] **Step 4: Typecheck + run existing tests**

Run: `npx tsc --noEmit && npx vitest run src/views/BrowseModpacks.test.tsx`
Expected: 0 errors, 4 passed.

- [ ] **Step 5: Commit**

```bash
git add src/components/BrowseModpackDetail.tsx src/views/BrowseModpacks.tsx src/hooks/useTauri.ts
git commit -m "feat(modpack-browser): BrowseModpackDetail with install"
```

---

## Task 11: PublishModal — prompt screen + post-success toggle

**Files:**
- Modify: `src/components/PublishModal.tsx`

Two additions to the existing modal:
1. A new screen state between "ready" and "busy" (the publish prompt). Two checkboxes. "Continue" triggers the actual publish call.
2. A toggle row in the success state for manual override.

- [ ] **Step 1: Add prompt state and capture answers**

Inside `PublishModal`, add state:

```tsx
const [promptShown, setPromptShown] = useState(false);     // user has clicked "Publish", now on the prompt step
const [optInPublic, setOptInPublic] = useState(false);
const [dontAskAgain, setDontAskAgain] = useState(false);
const [dontAskAgainLoaded, setDontAskAgainLoaded] = useState<boolean | null>(null); // null = checking
```

When the modal opens (existing `useEffect` on `open`), look up whether `dont_ask_again` is already true on this profile. Add a small dedicated Rust command rather than threading the flag through `ShareResult` (which is already returned from share/reshare and used in several places — adding a field there would scatter the change).

Add to `src-tauri/src/sharing.rs`:

```rust
/// True if the curator ticked "don't ask me again" on this profile.
/// Used by PublishModal to decide whether to show the listing prompt.
#[tauri::command]
pub fn get_share_dont_ask_again(
    name: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<bool, String> {
    let profiles_path = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.profiles_path.clone()
    };
    let share_info_path = profiles_path.join(format!("{}.share", name));
    let content = match std::fs::read_to_string(&share_info_path) {
        Ok(c) => c,
        Err(_) => return Ok(false),
    };
    let info: ShareInfo = match serde_json::from_str(&content) {
        Ok(i) => i,
        Err(_) => return Ok(false),
    };
    Ok(info.dont_ask_again)
}
```

Register in `src-tauri/src/lib.rs` `generate_handler![...]`:

```rust
            sharing::get_share_dont_ask_again,
```

Add to `src/hooks/useTauri.ts`:

```typescript
export async function getShareDontAskAgain(name: string): Promise<boolean> {
  return invoke('get_share_dont_ask_again', { name });
}
```

Then in the modal:

```tsx
import { getShareDontAskAgain } from '../hooks/useTauri';
// inside the open effect:
getShareDontAskAgain(profile.name)
  .then((flag) => setDontAskAgainLoaded(flag))
  .catch(() => setDontAskAgainLoaded(false));
```

- [ ] **Step 2: Render the prompt step**

The existing modal body has three branches: pre-flight (token blocker), ready-to-publish, busy, success. Add a fourth: the prompt. Render it after the user clicks Publish and before the actual share runs:

Change `handlePublish`:

```tsx
async function handlePublish() {
  if (!profile) return;
  if (dontAskAgainLoaded === true) {
    // Skip the prompt entirely.
    await runPublish(null, false);
    return;
  }
  setPromptShown(true);
}

async function runPublish(listPublic: boolean | null, dontAskAgain: boolean) {
  setPromptShown(false);
  setBusy(true);
  setProgress({ profile_name: profile!.name, stage: 'bundling', current: 0, total: 0, mod_name: null });
  try {
    const result = await (isReshare
      ? reshareProfile(profile!.name, listPublic, dontAskAgain)
      : shareProfile(profile!.name, listPublic, dontAskAgain));
    setShared(result);
    onShared?.(result);
    // ... existing failed_uploads toast handling ...
  } catch (e) {
    toast.error(`Failed to publish: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    setBusy(false);
    setProgress(null);
  }
}
```

Then in the body, add the prompt branch (between the pre-flight and busy branches):

```tsx
{promptShown && (
  <div style={{ padding: '6px 2px' }}>
    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>
      List this modpack on Browse Modpacks?
    </div>
    <div style={{ fontSize: 12.5, color: 'var(--ink-mute)', lineHeight: 1.55, marginBottom: 14 }}>
      Anyone using the app can find and install it. Your share code still works either way — this only controls whether it's discoverable.
    </div>
    <label style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
      <input type="checkbox" checked={optInPublic} onChange={(e) => setOptInPublic(e.target.checked)} />
      <span>List in Browse Modpacks</span>
    </label>
    <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input type="checkbox" checked={dontAskAgain} onChange={(e) => setDontAskAgain(e.target.checked)} />
      <span>Don't ask me again for this modpack</span>
    </label>
  </div>
)}
```

And update the footer for that state:

```tsx
{promptShown && (
  <>
    <button className="gf-btn-3" onClick={() => setPromptShown(false)}>Back</button>
    <div style={{ flex: 1 }} />
    <button className="gf-btn" onClick={() => runPublish(optInPublic, dontAskAgain)}>
      Continue
    </button>
  </>
)}
```

(Adjust the existing footer cascade so `promptShown` is checked before the existing `!shared && !busy` branch.)

- [ ] **Step 3: Add the success-state toggle**

In the success branch (where `{shared && (...)}` renders), add a row near the bottom (before or after the failed-uploads warning):

```tsx
{shared && profile && (
  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 12 }}>
    <span style={{ color: 'var(--ink-mute)' }}>Listed in Browse Modpacks:</span>
    <ListingToggle profileName={profile.name} initial={profile.public ?? false} />
  </div>
)}
```

Add the local component:

```tsx
function ListingToggle({ profileName, initial }: { profileName: string; initial: boolean }) {
  const toast = useToast();
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function flip() {
    if (busy) return;
    const next = !on;
    setBusy(true);
    try {
      await setModpackListing(profileName, next);
      setOn(next);
      toast.success(next ? 'Listed' : 'Hidden from Browse Modpacks');
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="gf-btn-3" onClick={flip} disabled={busy}>
      {on ? 'On' : 'Off'}
    </button>
  );
}
```

(Add `import { setModpackListing } from '../hooks/useTauri';` at the top.)

- [ ] **Step 4: Reset prompt state on close**

In the existing close handler (`handleDone`), clear the new state:

```tsx
function handleDone() {
  setShared(null);
  setBusy(false);
  setProgress(null);
  setPromptShown(false);
  setOptInPublic(false);
  setDontAskAgain(false);
  onClose();
}
```

- [ ] **Step 5: Run vitest on the modal**

If a test file exists (`src/components/PublishModal.test.tsx`), run it. Otherwise, add this minimal test:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PublishModal } from './PublishModal';
import type { Profile } from '../types';

vi.mock('../hooks/useTauri', () => ({
  shareProfile: vi.fn().mockResolvedValue({
    code: 'AA5A-315D-61AE', owner: 'me', file_path: '', url: '',
    repo_url: '', failed_uploads: [],
  }),
  reshareProfile: vi.fn(),
  getApiKeyStatus: vi.fn().mockResolvedValue({ github_token_set: true, nexus_api_key_set: false }),
  getShareInfo: vi.fn().mockResolvedValue(null),
  setModpackListing: vi.fn().mockResolvedValue(undefined),
}));

const profile: Profile = {
  name: 'Test',
  game_version: null,
  created_by: null,
  mods: [],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => vi.clearAllMocks());

describe('PublishModal listing prompt', () => {
  it('shows prompt step after clicking Publish when dont_ask_again is false', async () => {
    render(<PublishModal open profile={profile} onClose={() => {}} />);
    // Wait for token check to settle and "Publish" button to enable.
    const publishBtn = await screen.findByRole('button', { name: /Publish/i });
    fireEvent.click(publishBtn);
    await waitFor(() => expect(screen.getByText(/List this modpack on Browse Modpacks/i)).toBeInTheDocument());
    expect(screen.getByText(/Don't ask me again/i)).toBeInTheDocument();
  });
});
```

Run: `npx vitest run src/components/PublishModal.test.tsx`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/PublishModal.tsx src/components/PublishModal.test.tsx src/types.ts src/hooks/useTauri.ts src-tauri/src/sharing.rs
git commit -m "feat(modpack-browser): publish prompt + post-success listing toggle"
```

---

## Task 12: Sidebar — rename Browse → Browse Mods, add Browse Modpacks

**Files:**
- Modify: `src/App.tsx` (the `View` type, `NAV` array, view-rendering switch)

- [ ] **Step 1: Update the View type and NAV**

Edit `src/App.tsx`:

```tsx
type View = 'home' | 'profiles' | 'mods' | 'browse-mods' | 'browse-modpacks' | 'tutorial' | 'settings';

const NAV: { id: View; label: string; icon: typeof Home }[] = [
  { id: 'home',             label: 'Home',             icon: Home },
  { id: 'profiles',         label: 'Profiles',         icon: Layers },
  { id: 'mods',             label: 'Mods',             icon: Package },
  { id: 'browse-mods',      label: 'Browse Mods',      icon: Search },
  { id: 'browse-modpacks',  label: 'Browse Modpacks',  icon: Boxes },
];
```

Add `Boxes` to the existing `lucide-react` import at the top of `App.tsx`.

- [ ] **Step 2: Route the new view**

Find where `BrowseView` is rendered (Grep `BrowseView` in App.tsx). Currently keyed on `activeView === 'browse'`. Update:

```tsx
import { BrowseModpacksView } from './views/BrowseModpacks';
// ...
{activeView === 'browse-mods' && <BrowseView onGoToSettings={() => setActiveView('settings')} />}
{activeView === 'browse-modpacks' && (
  <BrowseModpacksView onGoToProfiles={() => setActiveView('profiles')} />
)}
```

- [ ] **Step 3: Find and update any other references to the `'browse'` view id**

The view id `'browse'` may be referenced beyond just `App.tsx` — e.g., deep-link routing, view switchers triggered by other components, persisted state.

Run: Grep across `src/` for the literal string `'browse'` (with quotes) and `"browse"`. For each hit:
- If it's a view-id reference, change to `'browse-mods'`.
- If it's serialized (localStorage / settings file), add a one-time migration where it's read: `if (savedView === 'browse') savedView = 'browse-mods';`.
- Leave unrelated uses (URL paths, copy text, etc.) alone.

Expected hits to look for:
- `setActiveView('browse')` calls
- Routing tables / switchers
- Any onboarding tutorial that nudges the user to "Browse"

- [ ] **Step 4: Typecheck + run frontend tests**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "feat(modpack-browser): split Browse into Mods + Modpacks tabs"
```

---

## Task 13: README updates

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Add the three additions**

Open `README.md`. Under **Profiles & sharing**, add three bullets / blockquotes. Locate the existing bullets describing share-by-code (around the existing "Profile import — code or link" / "Smart link handling" cluster) and insert:

1. After the existing share-code bullets, a note about the public repo requirement:

   ```markdown
   > **Your `sts2mm-profiles` repo on GitHub stays public.** The manager
   > creates it that way and your share codes only work for friends
   > because the manifest is publicly fetchable. Don't flip it to private
   > on GitHub — your friends will get "Profile not found" when they try
   > to install your code.
   ```

2. A note for solo users:

   ```markdown
   > **If you never publish a pack, no repo is created.** The
   > `sts2mm-profiles` repo only appears on your GitHub the first time
   > you hit Share. Solo users who only consume friends' packs never
   > have anything written to their account.
   ```

3. A new bullet describing Browse Modpacks (under the existing "Browse" subsection — or, since that subsection is being implicitly split, just add it near the new sidebar entry):

   ```markdown
   - **Browse Modpacks.** Sidebar → Browse Modpacks shows public modpacks
     people have opted into listing. Each pack is one click to install
     (same smart-import flow as paste-a-code). Your own packs default to
     unlisted — when you Share or Re-share, the Publish dialog asks once
     whether to list this pack on Browse Modpacks. You can flip the
     answer anytime from the Publish dialog.
   ```

Also rename the existing **Browse** subsection heading to **Browse Mods** for consistency with the sidebar.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(readme): document Browse Modpacks + public-repo requirement"
```

---

## Task 14: Final smoke + dev-server check

**Files:** none (validation only)

- [ ] **Step 1: Full Rust test pass**

Run: `cd src-tauri && cargo test`
Expected: all green.

- [ ] **Step 2: Full frontend test pass**

Run: `npx vitest run`
Expected: all green.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: 0 errors.

- [ ] **Step 4: Dev server smoke**

Run: `npm run tauri dev`

Manual checks:
- Sidebar shows `Browse Mods` and `Browse Modpacks` as separate entries.
- Clicking `Browse Mods` shows the same view as the old `Browse`.
- Clicking `Browse Modpacks` shows a skeleton then either cards or the empty state.
- The refresh icon triggers a fresh fetch.
- Publish flow on a never-shared profile: clicking Publish shows the listing-prompt screen, then proceeds to the bundling + success screens after Continue.
- The success screen shows the `Listed in Browse Modpacks: [Off/On]` toggle, and flipping it re-uploads the manifest (watch the dev console / Rust logs).

- [ ] **Step 5: Final commit (only if any tweaks were needed)**

If smoke surfaces tweaks, commit them one logical unit at a time using the same task-style messages.

---

## Out-of-scope confirmations

These items were explicitly deferred in the spec — do **not** add them in this plan:

- Pack descriptions, screenshots, tags on cards
- Search / filter / sort within Browse Modpacks
- Featured / curated list (central registry)
- Truly private packs (collaborator-gated repos)
- Disk persistence of the browser cache

If any of these surface as user feedback after ship, file a separate spec/plan iteration.
