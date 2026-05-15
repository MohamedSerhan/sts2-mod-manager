# Large Bundle Uploads via GitHub Releases — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop mod bundle uploads from failing for mods larger than ~50 MiB (issue #36, "The Cursed") by routing bundle uploads through GitHub's Releases API instead of the Contents API. As a side-benefit, make re-shares essentially free when nothing has changed by content-addressing each bundle with its SHA256.

**Architecture:** Bundles are uploaded as **release assets** attached to a single rolling `bundles` release in each curator's `sts2mm-profiles` repo. Asset filenames keep the existing `<safe_name>_<safe_version>.zip` shape so they're per-version-addressable. The profile manifest gains a new `bundle_sha256` field per mod; before uploading, the manager hashes the freshly-zipped bytes and compares to the prior hash — if the asset already exists on GitHub AND the hash matches, the upload is **skipped entirely** (re-share returns the existing `browser_download_url`). The profile manifest JSON (small) keeps using the Contents API — only the binary bundle path changes. `download_bundle` learns to recognize the new `github.com/<owner>/<repo>/releases/download/<tag>/<file>` URL shape alongside the legacy `raw.githubusercontent.com` shape so existing shared profiles keep working untouched.

**Why this is a minor release (v1.3.8 → v1.4.0):** New user-visible capability (mods previously rejected by Contents API now work), new schema field (`bundle_sha256`), measurable re-share performance change. Backward-compatible in both directions (old managers reading new manifests via `#[serde(default)]`; new managers downloading from legacy `raw.githubusercontent.com` URLs via the existing branch in `download_bundle`).

**Tech Stack:** Rust (`reqwest` + `sha2` already in use), `wiremock` (new dev-dep) for in-process HTTP testing, existing `qa-cassette` feature-flag for E2E playback, `vitest` for any frontend touch-ups.

**Root cause evidence (from investigation):** The Cursed contains a 61.5 MB `TheCursedMod.pck` (Godot's already-compressed pack format). The manager re-zips with Deflate at `sharing.rs:357`; the `.pck` doesn't recompress, leaving the bundle at ~58 MB. The Contents API base64-encodes the body (`sharing.rs:418`) → ~77 MB JSON payload → GitHub's documented `422 "Sorry, the file is too large to be processed"` rejection. LegacySpire is reported as larger on disk but its contents Deflate well, so its bundle lands under the threshold. The 422 retry loop at `sharing.rs:452-458` treats every 422 as a SHA conflict and retries futilely, masking the real error with `"Upload conflict ... retrying with fresh SHA"` — this whole function goes away by the end of Task 4, taking the misleading log with it.

**Why no DELETE on re-share:** an earlier version of this plan used DELETE-then-POST to replace existing assets (releases-API has no PUT-replace). That has a 30–60-second atomicity gap during which a friend hitting the URL gets 404, and a permanent breakage if the POST fails mid-upload. The current plan sidesteps the problem entirely: asset names are stable per `<mod>_v<version>`, content-hash decides skip-vs-upload, and we never delete. If the hash differs (mod author edited locally without bumping the version), we *still* don't DELETE — we just re-upload, which fails with 422 because the name already exists. **TODO note for Task 3:** in that one case we *do* need to replace, so we use a POST-then-rename pattern: POST under a temp suffix → PATCH old asset to `.old` → PATCH new asset to canonical. See Task 3 Step 9 for details.

**Out of scope:** Migrating already-shared profiles (their `raw.githubusercontent.com` URLs keep working). LFS, Git Data API. Extending preserve-configs to the bundle-install path (that path already clobbers configs today; not a regression introduced by this change).

---

## File Structure

**Modified:**
- `src-tauri/src/sharing.rs` — main change surface. Adds release uploader functions, replaces `upload_mod_bundle` body, teaches `download_bundle` about release URLs.
- `src-tauri/src/profiles.rs` — adds `bundle_sha256: Option<String>` to `ProfileMod` (line 15-35 region).
- `src-tauri/src/qa_cassette.rs` — `url_to_path` learns to map `github.com/.../releases/download/...` URLs to fixture zips under a `github-releases/` bucket.
- `src-tauri/Cargo.toml` + `src-tauri/tauri.conf.json` — version bump 1.3.8 → 1.4.0; `Cargo.toml` adds `wiremock` and `urlencoding` under `[dev-dependencies]` / `[dependencies]` respectively.
- `src-tauri/tests/qa_scenarios.rs` — adds a release-bundle install scenario.
- `qa/fixtures/github-releases/` — new fixture bucket. Add one small zip used by the cassette E2E test.
- `qa/runner/smoke.mjs` — adds a smoke step exercising the release-download path through the WebDriver harness (optional but explicitly requested by user).
- `CHANGELOG.md` — user-facing note.

**No new files needed.** All Rust logic lives in `sharing.rs`; tests live in the existing `#[cfg(test)] mod` blocks at the bottom of that file plus `src-tauri/tests/qa_scenarios.rs`.

---

## Pre-flight

- [ ] **Step 0a: Create a worktree** (per user preference for multi-commit work)

```powershell
# Use EnterWorktree tool from the .claude harness, or fall back to:
git worktree add .claude/worktrees/large-bundle-releases -b large-bundle-releases
```

- [ ] **Step 0b: Confirm starting state**

```powershell
git status
# expected: clean working tree on `large-bundle-releases` branch
cargo build --manifest-path src-tauri/Cargo.toml
# expected: builds clean
```

---

### Task 1: Add wiremock dev-dep, urlencoding dep, and base-URL indirection

**Files:**
- Modify: `src-tauri/Cargo.toml` (`[dependencies]` and `[dev-dependencies]`)
- Modify: `src-tauri/src/sharing.rs` (`build_client` and the upload helpers — they currently hardcode `https://api.github.com`)

**Why this task:** `wiremock` runs a real `MockServer` on a local port; tests configure it to expect specific PUT/POST/DELETE/GET calls and assert payloads. To point our reqwest calls at the mock, every `https://api.github.com/...` literal needs to resolve through a single overridable base. `urlencoding` is used by `upload_release_asset` in Task 3 to encode the `?name=<filename>` query param when posting to `uploads.github.com`.

- [ ] **Step 1: Add deps to Cargo.toml**

Append to `[dependencies]`:

```toml
# Used by sharing.rs::upload_release_asset to safely encode asset
# filenames into the `?name=<...>` query param of GitHub's release-asset
# upload endpoint. Pure-Rust, no transitive bloat — smaller than pulling
# in a full url-builder.
urlencoding = "2"
```

Append to `[dev-dependencies]`:

```toml
# In-process HTTP server for testing sharing.rs upload paths. The
# qa-cassette layer (src/qa_cassette.rs) is GET-only by design — wiremock
# covers POST/PUT/PATCH/DELETE so the release uploader has E2E coverage
# without burning real GitHub rate limits.
wiremock = "0.6"
```

- [ ] **Step 2: Verify it resolves**

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --tests
```

Expected: builds.

- [ ] **Step 3: Add `github_api_base()` indirection**

Edit `src-tauri/src/sharing.rs`. Just above `pub(crate) fn build_client(...)` (around line 194), add:

```rust
/// Base URL for GitHub's REST API. Tests override via the
/// `STS2_GITHUB_API_BASE` env var so wiremock can intercept; production
/// always reads the literal default (the env var is only set by tests).
///
/// Pulled out instead of threading a `base_url: &str` parameter through
/// every upload helper because (a) the prod code never varies it and (b)
/// the helpers already form URLs by `format!`, so a single base swap is
/// the minimum surface change for testability.
pub(crate) fn github_api_base() -> String {
    std::env::var("STS2_GITHUB_API_BASE")
        .unwrap_or_else(|_| "https://api.github.com".to_string())
}
```

- [ ] **Step 4: Route the hardcoded `api.github.com` literals through it**

Replace each occurrence in `sharing.rs`:

| Line (approx) | Function | Change |
|---|---|---|
| 222 | `get_github_username` | `&format!("{}/user", github_api_base())` |
| 244-246 | `ensure_profiles_repo` (GET) | `&format!("{}/repos/{}/{}", github_api_base(), username, PROFILES_REPO)` |
| 263 | `ensure_profiles_repo` (POST) | `&format!("{}/user/repos", github_api_base())` |
| 296-298 | `upsert_file` | `&format!("{}/repos/{}/{}/contents/{}", github_api_base(), username, PROFILES_REPO, filename)` |
| 413-416 | `upload_mod_bundle` | (will be deleted in Task 4; still wire it up so refactor is clean) |
| 494-497 | `download_bundle` | `&format!("{}/repos/{}/{}/contents/{}", github_api_base(), owner, repo, path)` |
| 591 (search for `/contents/`) | other Contents API site | same pattern |

`grep` for `https://api.github.com` inside `sharing.rs` to catch any missed.

- [ ] **Step 5: Run existing tests to confirm zero behavior change**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib sharing
```

Expected: same set of tests pass as before (the parse/format and listing tests).

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/Cargo.toml src-tauri/src/sharing.rs
git commit -m "refactor(sharing): inject github api base for test interception"
```

---

### Task 2: Add `bundle_sha256` to ProfileMod

**Files:**
- Modify: `src-tauri/src/profiles.rs` (`ProfileMod` struct at line 15)

**Why:** The hash field has to land in the serde schema *before* the uploader writes to it. Marked `#[serde(default, skip_serializing_if = "Option::is_none")]` so:
- Old profile JSONs (no field) deserialize fine (treated as `None`).
- New profile JSONs without an uploaded bundle (e.g. mod has a GitHub source and was never bundled) don't bloat the manifest with `"bundle_sha256": null`.
- Friends running older managers reading new manifests ignore the unknown field (serde's default behavior on extra fields).

- [ ] **Step 1: Write a serde round-trip test that proves backward-compat**

Append to `src-tauri/src/profiles.rs` under the existing `#[cfg(test)]` blocks (or create one if none exist at the bottom of the file — grep first):

```rust
#[cfg(test)]
mod profile_schema_compat_tests {
    use super::*;

    #[test]
    fn legacy_profile_without_bundle_sha256_deserializes() {
        // This is a manifest as it exists on real curators' GitHub repos
        // today (pre-v1.4.0). Must round-trip without error and produce
        // None for the new field.
        let legacy = r#"{
            "name": "test",
            "version": "1.0.0",
            "source": null,
            "hash": null,
            "files": [],
            "bundle_url": "https://raw.githubusercontent.com/x/y/main/mods/a.zip"
        }"#;
        let pm: ProfileMod = serde_json::from_str(legacy).expect("legacy deserializes");
        assert_eq!(pm.bundle_sha256, None);
        assert_eq!(pm.bundle_url.as_deref(), Some("https://raw.githubusercontent.com/x/y/main/mods/a.zip"));
    }

    #[test]
    fn profile_without_sha_serializes_without_the_field() {
        let pm = ProfileMod {
            name: "test".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec![],
            folder_name: None,
            mod_id: None,
            enabled: true,
            bundle_url: None,
            bundle_sha256: None,
        };
        let json = serde_json::to_string(&pm).unwrap();
        // skip_serializing_if must drop the field entirely so old readers
        // don't see an unfamiliar key.
        assert!(!json.contains("bundle_sha256"), "expected field to be omitted: {}", json);
    }

    #[test]
    fn profile_with_sha_round_trips() {
        let pm = ProfileMod {
            name: "test".into(),
            version: "1.0.0".into(),
            source: None,
            hash: None,
            files: vec![],
            folder_name: None,
            mod_id: None,
            enabled: true,
            bundle_url: Some("https://github.com/x/y/releases/download/bundles/a_v1.0.0.zip".into()),
            bundle_sha256: Some("deadbeef".into()),
        };
        let json = serde_json::to_string(&pm).unwrap();
        let round: ProfileMod = serde_json::from_str(&json).unwrap();
        assert_eq!(round.bundle_sha256.as_deref(), Some("deadbeef"));
    }
}
```

- [ ] **Step 2: Run — expect compile failure (field doesn't exist)**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib profiles::profile_schema_compat
```

Expected: `error[E0560]: struct 'ProfileMod' has no field named 'bundle_sha256'`.

- [ ] **Step 3: Add the field**

Edit `profiles.rs`, in the `ProfileMod` struct (line 15-35), add immediately after the `bundle_url` field:

```rust
    /// SHA256 hex digest of the bundle zip's bytes at upload time. Used
    /// by re-share to skip uploads when the bundle hasn't changed
    /// (content-addressing — mod authors who edit a mod without bumping
    /// `version` still get a fresh upload because the hash differs).
    /// `None` for mods without a bundle, or for profiles written by
    /// manager versions before v1.4.0.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_sha256: Option<String>,
```

- [ ] **Step 4: Run the schema tests — expect 3 pass**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib profiles::profile_schema_compat
```

Expected: 3 passed.

- [ ] **Step 5: Confirm rest of the suite still compiles + passes**

Other call sites that construct `ProfileMod` (search for `ProfileMod {`) need the new field. Should be a handful in `profiles.rs` itself (lines 246, 272 from our earlier grep). Add `bundle_sha256: None` to each.

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib
```

Expected: full lib suite green.

- [ ] **Step 6: Commit**

```powershell
git add src-tauri/src/profiles.rs
git commit -m "feat(profiles): add bundle_sha256 to ProfileMod schema"
```

---

### Task 3: Implement release-based bundle uploader with hash-skip logic

**Files:**
- Modify: `src-tauri/src/sharing.rs` — adds 4 new helpers + 1 orchestrator
- Test: same file, new `#[cfg(test)] mod release_upload_tests` block (wiremock-driven)

**Why:** This is the meat of the change. We build the release-based uploader as an isolated new function (`upload_mod_bundle_via_release`) without yet swapping callers. That lets us TDD it against wiremock in full, then flip the callsite in Task 4 as a single small commit.

**API shape we're targeting:**

```
GET  {api}/repos/{owner}/{repo}/releases/tags/bundles
  → 404 means we need to POST it
  → 200 returns { id, upload_url: "https://uploads.github.com/.../{id}/assets{?name,label}", assets: [...] }

POST {api}/repos/{owner}/{repo}/releases
  body: { tag_name: "bundles", name: "Mod bundles", body: "...", draft: false, prerelease: false }
  → 201 returns same shape as above

POST {upload_url stripped of {?name,label}}?name={filename}
  Content-Type: application/zip
  body: raw zip bytes (NOT base64)
  → 201 returns { id, name, browser_download_url, ... }
```

Reference: https://docs.github.com/en/rest/releases (assets endpoint is on `uploads.github.com`, not `api.github.com`).

**Decision logic the orchestrator implements:**

```
local_hash = sha256(zip_data)
asset_present = release.assets.iter().any(|a| a.name == asset_name)
hash_matches  = prior_sha256.map(|p| p == &local_hash).unwrap_or(false)

if asset_present && hash_matches:
    SKIP. Reuse existing browser_download_url.
else if asset_present && !hash_matches:
    REPLACE via POST-then-rename (rare path; mod author iterated locally).
else:
    POST under canonical name. (Normal first-upload path.)

Return (download_url, local_hash) so the caller can persist the hash.
```

- [ ] **Step 1: Add types**

Insert near the existing `ContentsResponse` and `UserResponse` types (find them around line 60-90 in `sharing.rs`):

```rust
#[derive(Debug, Clone, Deserialize)]
struct ReleaseResponse {
    id: u64,
    /// Template like `https://uploads.github.com/repos/<o>/<r>/releases/<id>/assets{?name,label}`.
    /// We strip the `{?name,label}` suffix and append `?name=<filename>` ourselves.
    upload_url: String,
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct ReleaseAsset {
    id: u64,
    name: String,
    browser_download_url: String,
}

const BUNDLES_RELEASE_TAG: &str = "bundles";
```

- [ ] **Step 2: Write the first wiremock test (fetch-or-create release, create branch)**

Append a new test module at the end of `sharing.rs`:

```rust
#[cfg(test)]
mod release_upload_tests {
    use super::*;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Helper: spin up a mock GitHub API and point sharing.rs at it via env.
    /// Each test gets its own MockServer on a random port, so they're isolated.
    async fn mock_github() -> MockServer {
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());
        server
    }

    /// Compute the SHA256 hex digest the same way the uploader does.
    /// Test helper so each test can assert on the returned hash.
    fn sha256_hex(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut h = Sha256::new();
        h.update(bytes);
        format!("{:x}", h.finalize())
    }

    #[tokio::test]
    async fn ensure_bundles_release_creates_release_when_404() {
        let server = mock_github().await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server)
            .await;

        let client = build_client("test-token");
        let release = ensure_bundles_release(&client, "octo", "sts2mm-profiles")
            .await
            .expect("should create release");
        assert_eq!(release.id, 42);
        assert!(release.assets.is_empty());
    }

    #[tokio::test]
    async fn ensure_bundles_release_reuses_when_200() {
        let server = mock_github().await;

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 7,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/7/assets{{?name,label}}", server.uri()),
                "assets": [{
                    "id": 100,
                    "name": "OldMod_v0.1.zip",
                    "browser_download_url": "https://example/old"
                }]
            })))
            .mount(&server)
            .await;

        let client = build_client("test-token");
        let release = ensure_bundles_release(&client, "octo", "sts2mm-profiles")
            .await
            .expect("should reuse release");
        assert_eq!(release.id, 7);
        assert_eq!(release.assets.len(), 1);
    }
}
```

- [ ] **Step 3: Run — expect compile failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib sharing::release_upload_tests
```

Expected: `cannot find function 'ensure_bundles_release'`.

- [ ] **Step 4: Implement `ensure_bundles_release`**

Insert in `sharing.rs` between `upload_mod_bundle` (line ~395) and the existing `fetch_existing_sha` helper:

```rust
/// Ensure the rolling `bundles` release exists on the profiles repo,
/// creating it on first share. Returns the release as it exists after
/// this call — assets included so the caller can dedupe without a
/// second round-trip.
///
/// Why a single rolling release instead of one per share: asset names
/// carry the version (`<mod>_v<ver>.zip`), so versioning happens at the
/// asset layer. One release = one stable tag (`bundles`) = one stable
/// URL prefix for every shared bundle.
async fn ensure_bundles_release(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
) -> Result<ReleaseResponse> {
    let base = github_api_base();
    let tag_url = format!("{}/repos/{}/{}/releases/tags/{}", base, owner, repo, BUNDLES_RELEASE_TAG);

    let resp = client.get(&tag_url).send().await?;
    if resp.status().is_success() {
        return Ok(resp.json::<ReleaseResponse>().await?);
    }
    if resp.status().as_u16() != 404 {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Could not check for bundles release on {}/{} ({}): {}",
            owner, repo, status, text
        )));
    }

    let create_url = format!("{}/repos/{}/{}/releases", base, owner, repo);
    let body = serde_json::json!({
        "tag_name": BUNDLES_RELEASE_TAG,
        "name": "Mod bundles",
        "body": "Auto-managed by STS2 Mod Manager. Holds binary mod bundles attached to shared profiles.",
        "draft": false,
        "prerelease": false,
    });
    let resp = client.post(&create_url).json(&body).send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Could not create bundles release on {}/{} ({}): {}",
            owner, repo, status, text
        )));
    }
    Ok(resp.json::<ReleaseResponse>().await?)
}
```

- [ ] **Step 5: Run the two ensure-release tests — expect pass**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib sharing::release_upload_tests::ensure_bundles_release
```

Expected: both pass.

- [ ] **Step 6: Add an asset-upload test**

Append to `release_upload_tests`:

```rust
    #[tokio::test]
    async fn upload_release_asset_posts_raw_bytes_with_filename_query() {
        let server = mock_github().await;

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "TheCursedMod_v0.2.7.zip"))
            .and(header("content-type", "application/zip"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 999,
                "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let upload_url_template = format!(
            "{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}",
            server.uri()
        );
        let client = build_client("test-token");
        let asset = upload_release_asset(
            &client,
            &upload_url_template,
            "TheCursedMod_v0.2.7.zip",
            b"PK\x03\x04...fake-zip-bytes",
        ).await.expect("upload should succeed");
        assert_eq!(
            asset.browser_download_url,
            "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
        );
    }
```

- [ ] **Step 7: Implement `upload_release_asset`**

Insert below `ensure_bundles_release`:

```rust
/// Upload a single binary asset to a release. `upload_url_template` is
/// the `upload_url` field returned by the GitHub release endpoint —
/// a URI Template like `https://uploads.github.com/.../assets{?name,label}`.
/// We strip the `{?name,label}` suffix and append `?name=<filename>`.
///
/// Returns the freshly-created `ReleaseAsset` (caller wants `.browser_download_url`
/// for the manifest, but also `.id` and `.name` for any subsequent
/// rename/replace flow — see `upload_mod_bundle_via_release` below).
///
/// Unlike the Contents API, this endpoint takes raw bytes (no base64).
/// That's what removes the ~50 MiB Contents-API ceiling: the asset
/// endpoint accepts up to 2 GB per file.
async fn upload_release_asset(
    client: &reqwest::Client,
    upload_url_template: &str,
    filename: &str,
    data: &[u8],
) -> Result<ReleaseAsset> {
    let base = upload_url_template
        .split_once('{')
        .map(|(b, _)| b)
        .unwrap_or(upload_url_template);
    let encoded_name = urlencoding::encode(filename);
    let url = format!("{}?name={}", base, encoded_name);

    let resp = client
        .post(&url)
        .header(reqwest::header::CONTENT_TYPE, "application/zip")
        .body(data.to_vec())
        .send()
        .await?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Failed to upload release asset '{}' ({}): {}",
            filename, status, text
        )));
    }
    Ok(resp.json::<ReleaseAsset>().await?)
}
```

- [ ] **Step 8: Run upload-asset test — expect pass**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib sharing::release_upload_tests::upload_release_asset
```

Expected: passes.

- [ ] **Step 9: Add a `replace_release_asset_via_rename` helper for the edit-without-version-bump case**

The releases API rejects POST when the asset name already exists. To replace without a DELETE atomicity gap, we POST under a temp suffix, PATCH the old asset to a `.stale` name (freeing the canonical name), then PATCH our new asset onto the canonical name. If the final PATCH fails we leave both around — friends still get a working `.stale` asset via the old `bundle_url`, and the next re-share GCs the stale one. **Failures here are bounded to "a small amount of orphan storage."**

Append test:

```rust
    #[tokio::test]
    async fn replace_release_asset_via_rename_swaps_old_for_new() {
        let server = mock_github().await;
        let upload_url_template = format!(
            "{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}",
            server.uri()
        );

        // Upload of the new asset under a temp name (`-new` suffix).
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "TheCursed_v0.2.7.zip.new"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 1001,
                "name": "TheCursed_v0.2.7.zip.new",
                "browser_download_url": "https://example/new"
            })))
            .expect(1)
            .mount(&server)
            .await;

        // Rename the old asset out of the way.
        Mock::given(method("PATCH"))
            .and(path("/repos/octo/sts2mm-profiles/releases/assets/555"))
            .and(wiremock::matchers::body_json_string(
                r#"{"name":"TheCursed_v0.2.7.zip.stale"}"#,
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 555,
                "name": "TheCursed_v0.2.7.zip.stale",
                "browser_download_url": "https://example/old-renamed"
            })))
            .expect(1)
            .mount(&server)
            .await;

        // Rename the new asset onto the canonical name.
        Mock::given(method("PATCH"))
            .and(path("/repos/octo/sts2mm-profiles/releases/assets/1001"))
            .and(wiremock::matchers::body_json_string(
                r#"{"name":"TheCursed_v0.2.7.zip"}"#,
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 1001,
                "name": "TheCursed_v0.2.7.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursed_v0.2.7.zip"
            })))
            .expect(1)
            .mount(&server)
            .await;

        let client = build_client("test-token");
        let url = replace_release_asset_via_rename(
            &client, "octo", "sts2mm-profiles", &upload_url_template,
            "TheCursed_v0.2.7.zip", 555, b"new-bytes"
        ).await.expect("rename swap should succeed");
        assert!(url.contains("releases/download/bundles/TheCursed_v0.2.7.zip"));
    }
```

- [ ] **Step 10: Implement `replace_release_asset_via_rename` + `rename_release_asset`**

Insert below `upload_release_asset`:

```rust
/// PATCH a release asset's name. Used by the replace-via-rename flow
/// to free the canonical name without ever DELETEing the old asset
/// (which would create an atomicity gap during which the URL 404s).
async fn rename_release_asset(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    asset_id: u64,
    new_name: &str,
) -> Result<ReleaseAsset> {
    let url = format!(
        "{}/repos/{}/{}/releases/assets/{}",
        github_api_base(), owner, repo, asset_id
    );
    let body = serde_json::json!({ "name": new_name });
    let resp = client.patch(&url).json(&body).send().await?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AppError::Other(format!(
            "Failed to rename release asset {} to '{}': {} {}",
            asset_id, new_name, status, text
        )));
    }
    Ok(resp.json::<ReleaseAsset>().await?)
}

/// Replace a release asset without a DELETE atomicity gap. Used only
/// when a mod author iterates locally without bumping `version` (the
/// hash differs but the asset name is still occupied).
///
/// Steps:
///   1. POST new bytes under `<canonical>.new`
///   2. PATCH old asset to `<canonical>.stale` (frees the canonical name)
///   3. PATCH new asset to `<canonical>` (claims it)
///
/// If step 3 fails, the canonical name briefly resolves to a 404 — but
/// the old `bundle_url` in any already-distributed manifest still points
/// at the old asset, which now lives at `<canonical>.stale` and *no*
/// shared manifest references that name. So the worst case is one
/// orphan asset until the next re-share, never a broken URL for friends.
async fn replace_release_asset_via_rename(
    client: &reqwest::Client,
    owner: &str,
    repo: &str,
    upload_url_template: &str,
    canonical_name: &str,
    old_asset_id: u64,
    data: &[u8],
) -> Result<String> {
    let new_tmp_name = format!("{}.new", canonical_name);
    let stale_name = format!("{}.stale", canonical_name);

    let new_asset = upload_release_asset(client, upload_url_template, &new_tmp_name, data).await?;
    rename_release_asset(client, owner, repo, old_asset_id, &stale_name).await?;
    let renamed = rename_release_asset(client, owner, repo, new_asset.id, canonical_name).await?;
    Ok(renamed.browser_download_url)
}
```

- [ ] **Step 11: Run the rename-swap test — expect pass**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib sharing::release_upload_tests::replace_release_asset_via_rename
```

Expected: passes.

- [ ] **Step 12: Add orchestrator tests (4 cases: first upload, skip-on-match, re-upload-on-differ, replace-on-differ)**

Append:

```rust
    #[tokio::test]
    async fn upload_mod_bundle_via_release_first_upload_records_hash() {
        let server = mock_github().await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "TheCursedMod_v0.2.7.zip"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 100,
                "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
            })))
            .expect(1)
            .mount(&server).await;

        let bytes = b"fake-zip-bytes";
        let (url, hash) = upload_mod_bundle_via_release(
            "test-token", "octo", "TheCursedMod", "0.2.7", bytes, None
        ).await.expect("first upload should succeed");
        assert!(url.contains("releases/download/bundles/TheCursedMod_v0.2.7.zip"));
        assert_eq!(hash, sha256_hex(bytes));
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_skips_when_hash_matches() {
        let server = mock_github().await;
        let bytes = b"fake-zip-bytes";
        let prior_hash = sha256_hex(bytes);

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": [{
                    "id": 555,
                    "name": "TheCursedMod_v0.2.7.zip",
                    "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
                }]
            })))
            .mount(&server).await;

        // CRITICAL: any POST/PATCH means we regressed. wiremock fails on
        // unstubbed requests, so if the orchestrator tries to upload we'll
        // see it fail.

        let (url, hash) = upload_mod_bundle_via_release(
            "test-token", "octo", "TheCursedMod", "0.2.7", bytes, Some(&prior_hash)
        ).await.expect("skip should succeed");
        assert_eq!(url, "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip");
        assert_eq!(hash, prior_hash, "hash returned to caller must match what was on disk");
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_replaces_when_hash_differs_but_name_matches() {
        // The mod-author case: edited locally without bumping version.
        let server = mock_github().await;
        let bytes = b"fresh-bytes-after-edit";
        let stale_prior_hash = sha256_hex(b"original-bytes");

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": [{
                    "id": 555,
                    "name": "TheCursedMod_v0.2.7.zip",
                    "browser_download_url": "https://example/old"
                }]
            })))
            .mount(&server).await;

        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "TheCursedMod_v0.2.7.zip.new"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 1001,
                "name": "TheCursedMod_v0.2.7.zip.new",
                "browser_download_url": "https://example/new-tmp"
            })))
            .expect(1)
            .mount(&server).await;

        Mock::given(method("PATCH"))
            .and(path("/repos/octo/sts2mm-profiles/releases/assets/555"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 555, "name": "TheCursedMod_v0.2.7.zip.stale", "browser_download_url": "x"
            })))
            .expect(1)
            .mount(&server).await;

        Mock::given(method("PATCH"))
            .and(path("/repos/octo/sts2mm-profiles/releases/assets/1001"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 1001, "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
            })))
            .expect(1)
            .mount(&server).await;

        let (url, hash) = upload_mod_bundle_via_release(
            "test-token", "octo", "TheCursedMod", "0.2.7", bytes, Some(&stale_prior_hash)
        ).await.expect("replace path should succeed");
        assert!(url.contains("releases/download/bundles/TheCursedMod_v0.2.7.zip"));
        assert_eq!(hash, sha256_hex(bytes));
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_re_uploads_when_no_prior_hash_but_name_collision() {
        // Edge case: fresh install (no prior hash in profile JSON) but
        // canonical name already exists on the release (curator re-installed
        // app and lost local manifest). Must take the replace path, not
        // the skip path — we can't trust an asset's hash without checking it.
        let server = mock_github().await;
        let bytes = b"data";

        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": [{
                    "id": 555,
                    "name": "TheCursedMod_v0.2.7.zip",
                    "browser_download_url": "https://example/whatever"
                }]
            })))
            .mount(&server).await;

        // Expect the replace flow (POST.new, PATCH old, PATCH new).
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 1001, "name": "TheCursedMod_v0.2.7.zip.new",
                "browser_download_url": "https://example/new"
            })))
            .expect(1)
            .mount(&server).await;
        Mock::given(method("PATCH"))
            .and(path("/repos/octo/sts2mm-profiles/releases/assets/555"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 555, "name": "TheCursedMod_v0.2.7.zip.stale",
                "browser_download_url": "x"
            })))
            .expect(1)
            .mount(&server).await;
        Mock::given(method("PATCH"))
            .and(path("/repos/octo/sts2mm-profiles/releases/assets/1001"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 1001, "name": "TheCursedMod_v0.2.7.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip"
            })))
            .expect(1)
            .mount(&server).await;

        let (_, _) = upload_mod_bundle_via_release(
            "test-token", "octo", "TheCursedMod", "0.2.7", bytes, None
        ).await.expect("no-prior-hash + name-collision must replace");
    }

    #[tokio::test]
    async fn upload_mod_bundle_via_release_sanitizes_filename() {
        let server = mock_github().await;
        Mock::given(method("GET"))
            .and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;
        Mock::given(method("POST"))
            .and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .and(query_param("name", "My_Cool_Mod_v1.2.3.zip"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 999, "name": "My_Cool_Mod_v1.2.3.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/My_Cool_Mod_v1.2.3.zip"
            })))
            .expect(1)
            .mount(&server).await;

        let _ = upload_mod_bundle_via_release(
            "test-token", "octo", "My Cool/Mod", "v1.2.3", b"data", None
        ).await.expect("ok");
    }
```

- [ ] **Step 13: Implement the orchestrator**

Insert below `replace_release_asset_via_rename`:

```rust
/// Upload a mod's zip bundle as a release asset on the curator's
/// `sts2mm-profiles` repo. Returns (download_url, sha256_hex) so the
/// caller can persist the hash to the profile manifest for next-share
/// content-addressing.
///
/// Skip semantics:
///   - If `prior_sha256` is Some AND matches the freshly-computed local
///     hash AND the canonical asset name is present in the release →
///     skip the upload entirely, return the existing browser_download_url.
///   - If the name collides but the hash differs (or no prior hash to
///     compare to) → replace via the POST-then-rename flow.
///   - If the name doesn't exist on the release → POST under canonical name.
pub(crate) async fn upload_mod_bundle_via_release(
    token: &str,
    username: &str,
    mod_name: &str,
    version: &str,
    zip_data: &[u8],
    prior_sha256: Option<&str>,
) -> Result<(String, String)> {
    use sha2::{Digest, Sha256};

    let client = build_client(token);
    let safe_name = mod_name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect::<String>();
    let safe_ver = version
        .trim_start_matches('v')
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' { c } else { '_' })
        .collect::<String>();
    let asset_name = format!("{}_v{}.zip", safe_name, safe_ver);

    let mut hasher = Sha256::new();
    hasher.update(zip_data);
    let local_hash = format!("{:x}", hasher.finalize());

    let release = ensure_bundles_release(&client, username, PROFILES_REPO).await?;

    if let Some(existing) = release.assets.iter().find(|a| a.name == asset_name) {
        let hash_matches = prior_sha256.map(|p| p == local_hash.as_str()).unwrap_or(false);
        if hash_matches {
            log::info!(
                "Bundle for '{}' v{} unchanged (sha256 match) — reusing existing release asset",
                mod_name, version
            );
            return Ok((existing.browser_download_url.clone(), local_hash));
        }
        // Name collision but content differs (or we can't prove it doesn't).
        // Replace via rename so the canonical URL never 404s.
        log::info!(
            "Bundle for '{}' v{} content changed since last share — replacing release asset",
            mod_name, version
        );
        let url = replace_release_asset_via_rename(
            &client, username, PROFILES_REPO, &release.upload_url,
            &asset_name, existing.id, zip_data,
        ).await?;
        return Ok((url, local_hash));
    }

    // Net-new upload.
    let asset = upload_release_asset(&client, &release.upload_url, &asset_name, zip_data).await?;
    Ok((asset.browser_download_url, local_hash))
}
```

- [ ] **Step 14: Run all release-upload tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib sharing::release_upload_tests
```

Expected: all 8 tests pass.

- [ ] **Step 15: Run the full sharing test suite to confirm no regressions**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib sharing
```

Expected: green.

- [ ] **Step 16: Commit**

```powershell
git add src-tauri/src/sharing.rs
git commit -m "feat(sharing): release-based bundle uploader with content-hash skip"
```

---

### Task 4: Swap share/reshare to release uploader; plumb hash through

**Files:**
- Modify: `src-tauri/src/sharing.rs` lines 743 and 951 (callsites) + the surrounding loop to read/write `bundle_sha256`
- Test: same file, new `share_via_releases_e2e_tests` module

**Why:** Flip the callsites. Keep the old `upload_mod_bundle` function intact until step 5 of this task so the swap is reviewable as a contained behavior change, then delete it once the e2e test is green.

- [ ] **Step 1: Extract a non-IPC `share_profile_impl`**

`share_profile` at `sharing.rs` (around line 658) is a `#[tauri::command]` that takes `AppHandle` for `emit`. Extract the body into:

```rust
async fn share_profile_impl(
    profile: Profile,
    mods_path: &std::path::Path,
    profiles_path: &std::path::Path,
    token: &str,
    emit: Option<&dyn Fn(&str, ShareProgress)>,
) -> Result<ShareResult> {
    // ... existing body, with every `app_handle.emit("share-progress", X)` replaced by:
    //     if let Some(e) = emit { e("share-progress", X); }
    // ...
}
```

The `#[tauri::command]` becomes a one-liner shim. Same shape for `reshare_profile` (around line 870).

- [ ] **Step 2: Write the end-to-end test**

Append:

```rust
#[cfg(test)]
mod share_via_releases_e2e_tests {
    use super::*;
    use wiremock::matchers::{method, path, path_regex};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    /// Verifies: user lookup -> repo exists -> bundle uploaded via releases
    /// (not Contents API) -> manifest written via Contents API with both
    /// `bundle_url` and `bundle_sha256` set on the persisted profile.
    #[tokio::test]
    async fn share_profile_routes_bundles_through_releases_and_persists_hash() {
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());

        Mock::given(method("GET")).and(path("/user"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"login": "octo"})))
            .mount(&server).await;

        Mock::given(method("GET")).and(path("/repos/octo/sts2mm-profiles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"name": "sts2mm-profiles"})))
            .mount(&server).await;

        Mock::given(method("GET")).and(path("/repos/octo/sts2mm-profiles/releases/tags/bundles"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "id": 42,
                "upload_url": format!("{}/repos/octo/sts2mm-profiles/releases/42/assets{{?name,label}}", server.uri()),
                "assets": []
            })))
            .mount(&server).await;

        Mock::given(method("POST")).and(path("/repos/octo/sts2mm-profiles/releases/42/assets"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "id": 100, "name": "TestMod_v1.0.0.zip",
                "browser_download_url": "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TestMod_v1.0.0.zip"
            })))
            .expect(1)   // exactly one bundle upload — pins the route
            .mount(&server).await;

        Mock::given(method("GET")).and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server).await;
        Mock::given(method("PUT")).and(path_regex(r"/repos/octo/sts2mm-profiles/contents/.+\.json"))
            .respond_with(ResponseTemplate::new(201).set_body_json(serde_json::json!({
                "content": {"sha": "abc", "html_url": "https://github.com/octo/sts2mm-profiles/blob/main/x.json"}
            })))
            .expect(1)
            .mount(&server).await;

        // Build a minimal Profile with one mod that has a file on disk.
        let tmpdir = tempfile::tempdir().unwrap();
        let mods_path = tmpdir.path().join("mods");
        let mod_dir = mods_path.join("TestMod");
        std::fs::create_dir_all(&mod_dir).unwrap();
        std::fs::write(mod_dir.join("TestMod.json"), b"{}").unwrap();

        let profiles_path = tmpdir.path().join("profiles");
        std::fs::create_dir_all(&profiles_path).unwrap();

        let profile = Profile {
            name: "test".into(),
            game_version: None,
            created_by: None,
            mods: vec![crate::profiles::ProfileMod {
                name: "TestMod".into(),
                version: "1.0.0".into(),
                source: None,
                hash: None,
                files: vec!["TestMod".into()],
                folder_name: Some("TestMod".into()),
                mod_id: None,
                enabled: true,
                bundle_url: None,
                bundle_sha256: None,
            }],
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            public: None,
        };

        let result = share_profile_impl(profile, &mods_path, &profiles_path, "test-token", None)
            .await
            .expect("share should succeed");

        assert!(result.repo_url.contains("sts2mm-profiles"));
        assert!(result.failed_uploads.is_empty(), "expected no failures, got {:?}", result.failed_uploads);

        // Verify the persisted profile got both bundle_url and bundle_sha256.
        let saved_path = profiles_path.join("test.json");
        let saved_text = std::fs::read_to_string(&saved_path).unwrap();
        let saved: Profile = serde_json::from_str(&saved_text).unwrap();
        let m = &saved.mods[0];
        assert!(m.bundle_url.as_deref().map(|u| u.contains("releases/download/bundles/TestMod_v1.0.0.zip")).unwrap_or(false),
            "expected release URL, got {:?}", m.bundle_url);
        assert!(m.bundle_sha256.is_some(), "expected hash to be persisted");
    }
}
```

- [ ] **Step 3: Run — expect the e2e test to fail because bundles still hit Contents API**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib sharing::share_via_releases_e2e_tests
```

Expected: failure — wiremock reports unexpected `PUT /repos/octo/sts2mm-profiles/contents/mods/TestMod_v1.0.0.zip` (the old code path).

- [ ] **Step 4: Swap the two callsites**

In `sharing.rs` `share_profile_impl` (the loop that today calls `upload_mod_bundle`, formerly around line 743):

Find the existing zip-and-upload block:

```rust
match zip_mod_files(&pm.name, &pm.files, &mods_path) {
    Ok(zip_data) => {
        match upload_mod_bundle(&token, &username, &pm.name, &pm.version, &zip_data).await {
            Ok(url) => {
                pm.bundle_url = Some(url);
                log::info!("Bundled mod '{}' successfully ({} bytes)", pm.name, zip_data.len());
            }
            Err(e) => { ... }
        }
    }
    Err(e) => { ... }
}
```

Replace the `upload_mod_bundle` call with:

```rust
match upload_mod_bundle_via_release(
    &token, &username, &pm.name, &pm.version, &zip_data,
    pm.bundle_sha256.as_deref(),
).await {
    Ok((url, hash)) => {
        pm.bundle_url = Some(url);
        pm.bundle_sha256 = Some(hash);
        log::info!("Bundled mod '{}' successfully ({} bytes)", pm.name, zip_data.len());
    }
    Err(e) => { ... }   // same as before
}
```

Apply the same change to the reshare loop (around line 951): use `share_info.owner` (or whatever it's named) in place of `username`.

- [ ] **Step 5: Run — expect e2e green**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib sharing
```

Expected: green.

- [ ] **Step 6: Delete obsolete code**

Now-unused:
- `async fn upload_mod_bundle(...)` (the old Contents-API uploader)
- `async fn fetch_existing_sha(...)` (only used by the deleted uploader — verify with grep first)
- `struct ContentsResponse` (verify; `upsert_file` may still use it for the manifest path)

```powershell
Select-String -Path src-tauri/src -Pattern "upload_mod_bundle\b" -Recurse
Select-String -Path src-tauri/src -Pattern "fetch_existing_sha\b" -Recurse
Select-String -Path src-tauri/src -Pattern "ContentsResponse\b" -Recurse
```

Delete only what has zero remaining references.

- [ ] **Step 7: Final test sweep**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: full suite green.

- [ ] **Step 8: Commit**

```powershell
git add src-tauri/src/sharing.rs
git commit -m "feat(sharing): route bundle uploads through GitHub releases (#36)"
```

---

### Task 5: Teach `download_bundle` about release-download URLs

**Files:**
- Modify: `src-tauri/src/sharing.rs` `download_bundle` (lines 478-566)
- Test: same file, new `download_bundle_url_routing_tests` module

**Why:** Existing already-shared profiles point at `raw.githubusercontent.com/.../mods/X.zip` — these must keep working. New shares write `github.com/.../releases/download/bundles/X.zip`. Both shapes need a working download path; non-GitHub URLs still hit the existing direct-GET branch.

- [ ] **Step 1: Write tests for all three URL shapes**

Append:

```rust
#[cfg(test)]
mod download_bundle_url_routing_tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn make_tiny_zip(inner_name: &str) -> Vec<u8> {
        let buf = std::io::Cursor::new(Vec::new());
        let mut zw = zip::ZipWriter::new(buf);
        zw.start_file(inner_name, zip::write::SimpleFileOptions::default()).unwrap();
        zw.write_all(b"hello").unwrap();
        zw.finish().unwrap().into_inner()
    }

    #[tokio::test]
    async fn download_bundle_handles_raw_githubusercontent_url() {
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_API_BASE", server.uri());

        let zip_bytes = make_tiny_zip("OldMod.json");
        Mock::given(method("GET"))
            .and(path("/repos/owner/sts2mm-profiles/contents/mods/OldMod_v1.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_bytes))
            .mount(&server).await;

        let tmp = tempfile::tempdir().unwrap();
        download_bundle(
            "https://raw.githubusercontent.com/owner/sts2mm-profiles/main/mods/OldMod_v1.zip",
            "OldMod", tmp.path()
        ).await.expect("legacy URL must still work");

        assert!(tmp.path().join("OldMod.json").exists());
    }

    #[tokio::test]
    async fn download_bundle_handles_release_download_url() {
        let server = MockServer::start().await;
        std::env::set_var("STS2_GITHUB_RELEASES_BASE", server.uri());

        let zip_bytes = make_tiny_zip("NewMod.json");
        Mock::given(method("GET"))
            .and(path("/owner/sts2mm-profiles/releases/download/bundles/NewMod_v1.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_bytes))
            .mount(&server).await;

        let tmp = tempfile::tempdir().unwrap();
        download_bundle(
            "https://github.com/owner/sts2mm-profiles/releases/download/bundles/NewMod_v1.zip",
            "NewMod", tmp.path()
        ).await.expect("release URL must work");

        assert!(tmp.path().join("NewMod.json").exists());
    }

    #[tokio::test]
    async fn download_bundle_handles_arbitrary_https_url() {
        let server = MockServer::start().await;
        let zip_bytes = make_tiny_zip("ExternalMod.json");
        Mock::given(method("GET"))
            .and(path("/some/path/ExternalMod.zip"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(zip_bytes))
            .mount(&server).await;

        let tmp = tempfile::tempdir().unwrap();
        download_bundle(
            &format!("{}/some/path/ExternalMod.zip", server.uri()),
            "ExternalMod", tmp.path()
        ).await.expect("non-github URL must work");

        assert!(tmp.path().join("ExternalMod.json").exists());
    }
}
```

- [ ] **Step 2: Add the release-URL branch in `download_bundle`**

Insert above the existing `raw.githubusercontent.com` block:

```rust
let bytes = if url.starts_with("https://github.com/") && url.contains("/releases/download/") {
    // Release-asset download. github.com 302-redirects to
    // objects.githubusercontent.com; reqwest follows redirects by
    // default. No API auth needed — release assets in a public repo
    // are public.
    //
    // For test interception we honor STS2_GITHUB_RELEASES_BASE — if set,
    // we replace the `https://github.com` prefix with it so wiremock
    // can answer. Production never sets this var.
    let effective = if let Ok(base) = std::env::var("STS2_GITHUB_RELEASES_BASE") {
        url.replacen("https://github.com", &base, 1)
    } else {
        url.to_string()
    };
    log::info!("Downloading release bundle '{}' from {}", mod_name, effective);
    let resp = client.get(&effective).send().await?;
    if !resp.status().is_success() {
        return Err(AppError::Other(format!(
            "Failed to download release bundle for '{}': {}",
            mod_name, resp.status()
        )));
    }
    resp.bytes().await?
} else if url.contains("raw.githubusercontent.com") {
    // ... existing branch unchanged ...
```

- [ ] **Step 3: Run the routing tests — expect 3 pass**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib sharing::download_bundle_url_routing_tests
```

Expected: green.

- [ ] **Step 4: Full sweep + commit**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib sharing
git add src-tauri/src/sharing.rs
git commit -m "feat(sharing): download_bundle handles release-asset URLs"
```

---

### Task 6: QA cassette + scenarios for release-asset downloads

**Files:**
- Modify: `src-tauri/src/qa_cassette.rs` (`url_to_path` — add a github.com bucket)
- Create: `qa/fixtures/github-releases/<owner>/<repo>/releases/download/bundles/<name>.zip` (a small fixture zip)
- Modify: `src-tauri/tests/qa_scenarios.rs` — add `scenario_005_install_from_release_url`
- Modify: `qa/runner/smoke.mjs` — add a smoke step

- [ ] **Step 1: Write the failing cassette mapping test**

Append to the existing `mod tests` block at the bottom of `qa_cassette.rs`:

```rust
    #[test]
    fn maps_release_asset_download_to_github_releases_bucket() {
        let dir = Path::new("/fixtures");
        let p = url_to_path(
            dir,
            "https://github.com/octo/sts2mm-profiles/releases/download/bundles/TheCursed_v0.2.7.zip",
        ).unwrap();
        assert_eq!(
            p,
            Path::new("/fixtures/github-releases/octo/sts2mm-profiles/releases/download/bundles/TheCursed_v0.2.7.zip"),
        );
    }
```

- [ ] **Step 2: Run — expect failure**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib qa_cassette --features qa-cassette
```

Expected: `None` returned from `url_to_path` for `github.com`.

- [ ] **Step 3: Extend `url_to_path`**

In `qa_cassette.rs` `url_to_path`, add `github.com` to the host matcher:

```rust
let bucket = match host {
    "api.github.com" => "github",
    "api.nexusmods.com" => "nexus",
    "raw.githubusercontent.com" => "github-raw",
    "github.com" => "github-releases",
    _ => return None,
};
```

- [ ] **Step 4: Run — green**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib qa_cassette --features qa-cassette
```

- [ ] **Step 5: Wire cassette into `download_bundle`'s release branch**

At the top of the release branch in `download_bundle`, before the network call:

```rust
let bytes = if url.starts_with("https://github.com/") && url.contains("/releases/download/") {
    if let Some(cached) = crate::qa_cassette::intercept_get(url) {
        reqwest::Body::from(cached); // adjust based on actual `bytes` type
        bytes::Bytes::from(cached)
    } else {
        // ... existing fetch ...
    }
}
```

(Check the actual `bytes` variable type — it's `bytes::Bytes` per reqwest. Adjust accordingly.)

- [ ] **Step 6: Add the fixture zip**

```powershell
$dir = "qa/fixtures/github-releases/qa-fixture/sts2mm-profiles/releases/download/bundles"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$src = New-Item -ItemType Directory -Force -Path "$env:TEMP/scenario005-src/TheCursedMod" | Out-Null
"manifest-stub" | Out-File -Encoding utf8 "$env:TEMP/scenario005-src/TheCursedMod/TheCursedMod.json"
Compress-Archive -Path "$env:TEMP/scenario005-src/TheCursedMod" -DestinationPath "$dir/TheCursedMod_v0.2.7.zip" -Force
```

- [ ] **Step 7: Add `scenario_005` to `qa_scenarios.rs`**

```rust
#[cfg(feature = "qa-cassette")]
#[tokio::test]
async fn scenario_005_install_from_release_url() {
    use sts2_mod_manager_lib::sharing::download_bundle;
    use std::path::PathBuf;
    std::env::set_var(
        "STS2_CASSETTE_DIR",
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("qa").join("fixtures"),
    );

    let tmp = tempfile::tempdir().unwrap();
    download_bundle(
        "https://github.com/qa-fixture/sts2mm-profiles/releases/download/bundles/TheCursedMod_v0.2.7.zip",
        "TheCursedMod",
        tmp.path()
    ).await.expect("cassette-backed release download must succeed");

    assert!(tmp.path().join("TheCursedMod/TheCursedMod.json").exists());
}
```

- [ ] **Step 8: Run scenario**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --features qa-cassette --test qa_scenarios scenario_005
```

- [ ] **Step 9: Add a smoke runner step (optional)**

Open `qa/runner/smoke.mjs`. Append a scenario that drives the share-install IPC from the WebDriver side with a fixture profile pointing at the release URL above. If the smoke harness doesn't yet have a friend-install path, leave a `// TODO scenario-005` placeholder — Rust-side coverage in step 7 is sufficient for shipping.

- [ ] **Step 10: Commit**

```powershell
git add src-tauri/src/qa_cassette.rs src-tauri/src/sharing.rs src-tauri/tests/qa_scenarios.rs qa/fixtures/github-releases qa/runner/smoke.mjs
git commit -m "test(qa): cassette + scenario coverage for release-asset downloads"
```

---

### Task 7: Manual smoke with The Cursed

- [ ] **Step 1: Build and run**

```powershell
npm run tauri dev
```

- [ ] **Step 2: Install The Cursed**

Use the manager's install-from-zip flow with `C:\Users\xxsku\Downloads\TheCursedMod - for STS2 Main (v0.103.2)-388-0-2-7-1778374781.zip`.

- [ ] **Step 3: Create a profile with only The Cursed, share it**

Note the share code. The log should show `Bundled mod 'TheCursedMod' successfully (~60MB bytes)` with **no** `Upload conflict` warnings.

- [ ] **Step 4: Verify on GitHub**

Open `https://github.com/<your-username>/sts2mm-profiles/releases/tag/bundles`. Confirm `TheCursedMod_v0.2.7.zip` is listed.

- [ ] **Step 5: Re-share without editing — confirm skip path**

Re-share the same profile. Log should show `Bundle for 'TheCursedMod' v0.2.7 unchanged (sha256 match) — reusing existing release asset`. Operation should be nearly instantaneous (one GET for the release listing, one PUT for the manifest).

- [ ] **Step 6: Edit a small file in The Cursed without bumping version — confirm replace path**

Open `<mods>/TheCursedMod/TheCursedMod.json`, add a space. Re-share. Log should show `content changed since last share — replacing release asset`. Browser should show `TheCursedMod_v0.2.7.zip.stale` and a new `TheCursedMod_v0.2.7.zip` on the release.

- [ ] **Step 7: Friend install**

Wipe a fresh mods dir (or use a tempdir). Import the share code. Confirm The Cursed installs and loads in-game.

- [ ] **Step 8: Capture log evidence for the PR description**

---

### Task 8: Bump to v1.4.0 + changelog

- [ ] **Step 1: Bump version in `src-tauri/Cargo.toml`**

```toml
version = "1.4.0"
```

- [ ] **Step 2: Bump version in `src-tauri/tauri.conf.json`**

```json
"version": "1.4.0",
```

- [ ] **Step 3: Update `Cargo.lock`**

```powershell
cargo update -p sts2-mod-manager --manifest-path src-tauri/Cargo.toml
```

- [ ] **Step 4: Add changelog entry**

Edit `CHANGELOG.md`, prepend:

```markdown
## [1.4.0]

### Added

- Profile manifests now record a SHA256 hash of each bundled mod. Re-shares skip the upload entirely when the bundle's bytes haven't changed, making re-share of an unchanged profile near-instantaneous regardless of size. Mod authors who edit a mod's bytes without bumping its `version` will still get a fresh upload — the hash detects the change.

### Fixed

- Sharing now succeeds for profiles containing mods larger than ~50 MB (e.g. The Cursed). Bundles are uploaded as release assets on the curator's `sts2mm-profiles` repo (limit: 2 GB per asset) instead of as repository files (limit: ~50 MiB). Existing already-shared profiles continue to work unchanged — only new shares use the new path. ([#36](https://github.com/MohamedSerhan/sts2-mod-manager/issues/36))
- The misleading "Upload conflict ... retrying with fresh SHA" warning no longer fires on hard upload failures. (It only ever fired because the old code path treated every 422 as a SHA race; that code path is gone.)
```

- [ ] **Step 5: Commit**

```powershell
git add src-tauri/Cargo.toml src-tauri/tauri.conf.json src-tauri/Cargo.lock CHANGELOG.md
git commit -m "release: v1.4.0 — large bundle support + hash-skip re-shares"
```

---

## Wrap-up

- [ ] **Step 1: Run the full test suite one more time**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml --features qa-cassette
npm test
```

Expected: all green.

- [ ] **Step 2: Open a PR**

Use the `superpowers:finishing-a-development-branch` skill. Reference issue #36 in the PR description and include the manual-smoke evidence from Task 7.

---

## Self-Review

**Spec coverage:**
- Issue #36 (Contents API size limit): Task 3 + 4 swap to Releases. ✓
- E2E test coverage (explicit user request): Task 1 adds wiremock; Tasks 3, 4, 5, 6 add 14+ wiremock/cassette tests covering the new paths. ✓
- Zero-friction migration: Task 5 keeps `raw.githubusercontent.com` branch; old profiles untouched. ✓
- Mod-author flow (edit without version bump): Task 2 adds `bundle_sha256`; Task 3 implements the replace-via-rename path; Task 7 step 6 manually verifies it. ✓
- Bandwidth/perf win for re-shares: Task 3's skip-on-hash-match path. ✓
- No DELETE atomicity gap: replace-via-rename uses POST → PATCH → PATCH instead. The canonical URL is never momentarily 404. ✓

**Placeholder scan:**
- Task 4 Step 1 (`share_profile_impl` extraction) requires the engineer to read `sharing.rs:658-820` first and mechanically lift `app_handle.emit(...)` calls into the new `emit` parameter. This is the one judgment-call step; the body is too large to inline. If `share_profile` does more `app_handle` work than `emit` (it may also call `crate::profiles::save_profile`), only the emit calls need to change.
- Task 6 Step 5: cassette wiring into `download_bundle` references `bytes` type without pinning — engineer should verify against reqwest's actual return type in the existing function.
- Task 6 Step 9: smoke runner step is explicitly optional with a fallback.

**Type consistency:**
- `ReleaseResponse` / `ReleaseAsset` / `BUNDLES_RELEASE_TAG` consistent across Task 3.
- `upload_mod_bundle_via_release` returns `(String, String)` (url, hash) — Task 4 destructures matches.
- `bundle_sha256: Option<String>` in `ProfileMod` (Task 2) is read via `.as_deref()` in Task 4, persisted via `Some(hash)`. Consistent.
- `STS2_GITHUB_API_BASE` (api.github.com override, Task 1) and `STS2_GITHUB_RELEASES_BASE` (github.com override, Task 5) are distinct env vars by design — different hosts in production. Tests in Task 5 use the releases one explicitly.

**Risk register:**
- **Asset upload to `uploads.github.com`:** in production the `upload_url` template points at `uploads.github.com`, not `api.github.com`. Our `STS2_GITHUB_API_BASE` override rewrites `api.github.com` only — the `uploads.github.com` host is reached via the template returned in the release JSON, so tests naturally point uploads at the mock without a separate env var. Confirmed by Task 3 tests via the upload-url template construction.
- **PATCH-rename failures:** if the final PATCH (canonical-name claim) fails, the canonical name briefly resolves to 404. The old asset still exists at `<canonical>.stale` and the previously-distributed `bundle_url` still references the old asset directly. So friends already running with a cached profile manifest keep working; only new arrivals after a failed rename see the 404, and the next re-share repairs it. Worth a sentence in the PR description.
- **Stale `.stale` assets accumulate:** if many edits-without-bumps happen, the release tab fills with `*.stale` assets. Easy follow-up: opportunistic GC of `.stale` assets during the next `ensure_bundles_release`. Skipped here to keep scope tight; not load-bearing for correctness.
