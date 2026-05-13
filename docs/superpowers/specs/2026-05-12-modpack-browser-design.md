# Browse Modpacks (in-app modpack discovery)

Add an in-app browser that surfaces public modpacks people have opted into listing. Keeps the project's "no server, no telemetry" ethos by reusing the standardized `sts2mm-profiles` repo name as the discovery primitive. Privacy model is **unlisted by default** — existing curators are not retroactively listed, and even after a pack is listed the share-by-code flow is unchanged.

## Goals

- A new sidebar tab `Browse Modpacks` that lists opted-in public modpacks from across GitHub.
- One-click install on a card, reusing the existing `install_shared_profile` smart-import flow.
- Zero retroactive listing: every existing pack is treated as unlisted until the curator explicitly opts in on their next Share / Re-share.
- No central registry, no server the project has to operate.

## Non-goals (v1)

- Pack descriptions, screenshots, tags (richer card content). Add later as optional manifest fields if curators ask.
- Search / filter / sort within the browser. The list is naturally bounded at this scale; revisit when it isn't.
- Featured / curated list. Decentralized only.
- Truly private packs (collaborator-gated repos). The unlisted model is the only privacy story — see "Privacy model" below.

## Privacy model

Two distinct concepts people might mean by "private":

1. **Unlisted** — `sts2mm-profiles` repo stays public, the manifest carries an opt-in flag, the browser respects it. Share-by-code still works (the manifest is publicly fetchable by anyone with the code).
2. **Truly private** — repo is private; only collaborators can install. Breaks the casual paste-a-code-in-Discord flow because friends are not collaborators on the curator's repo. Out of scope.

This design ships (1) only. The publish prompt and README both make this explicit so curators are not misled into thinking "unlisted" means "no stranger can see this."

## Architecture overview

Three changes:

1. **Manifest field** — `Profile` gains `public: Option<bool>`. Treated as not-listed unless exactly `Some(true)`.
2. **Discovery command** — a new Tauri command in a new module `src-tauri/src/modpack_browser.rs` that searches GitHub for repos literally named `sts2mm-profiles`, lists each repo's manifest JSONs, fetches them, filters to those flagged public, and returns minimal card data. Results cached in memory.
3. **UI** — rename the existing `Browse` sidebar entry to `Browse Mods`, add a new `Browse Modpacks` entry below it. New view `src/views/BrowseModpacks.tsx`. Card click opens a detail panel that reuses the existing `BrowseDetail` chrome and triggers `install_shared_profile`.

## Manifest opt-in flag

**Profile field** (Rust, `src-tauri/src/profiles.rs` — the `Profile` struct):

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub public: Option<bool>,
```

- Reading: "listed" = exactly `Some(true)`. `None` and `Some(false)` both mean unlisted. Defensive default so any manifest already in someone's `sts2mm-profiles` repo (no field present) is treated as opted out.
- Writing: set only by the publish prompt or the manual toggle. The manifest JSON is re-uploaded via the existing `upsert_file` path; no mod re-bundling.
- Re-share: the value is preserved across `reshare_profile` calls unless the prompt or toggle overrides it.

Mirror in TS as optional `public?: boolean` on the `Profile` type.

## Local state — `.share` file

The existing per-profile `.share` file (in `profiles_path`) already stores `code`, `owner`, `file_sha`. Add one field:

```rust
#[serde(default)]
dont_ask_again: bool,
```

- `false` / missing → publish/re-share prompt runs.
- `true` → prompt is skipped; the existing manifest's `public` value is preserved unchanged.

## Discovery + caching

**Module:** `src-tauri/src/modpack_browser.rs`.

**One Tauri command:**

```rust
#[tauri::command]
pub async fn fetch_modpack_browser_page(
    page: u32,
    force_refresh: bool,
    state: tauri::State<'_, AppState>,
) -> Result<BrowserPage, String>;
```

**Returned shape:**

```rust
pub struct BrowserPage {
    pub cards: Vec<BrowserCard>,
    pub page: u32,
    pub has_next_page: bool,
    pub stale: bool,        // true if network failed and we returned cached
    pub fetched_at: i64,    // unix seconds
}

pub struct BrowserCard {
    pub owner: String,      // GitHub username
    pub code: String,       // formatted code: AA5A-315D-61AE
    pub name: String,       // profile.name
    pub mod_count: usize,
    pub created_at: String, // ISO timestamp from profile.created_at
    pub updated_at: String, // ISO timestamp from profile.updated_at (re-share refreshes this)
}
```

**Steps inside the command:**

1. `GET https://api.github.com/search/repositories?q=sts2mm-profiles+in:name&per_page=30&page={page}`. Authed if `state.github_token` is present; anonymous otherwise. Reuses the `build_client` helper pattern from `sharing.rs`.
2. For each repo result, GET its Contents API to list `.json` files at the repo root.
3. For each `.json`, fetch via `fetch_shared_profile`-style API path (so the CDN-bypass + raw fallback are preserved). Parse into `Profile`.
4. Filter to `profile.public == Some(true)`.
5. Drop entries where `owner` matches the authed user's GitHub username (via `get_github_username` on the cached token — username is cached in `AppState` after first lookup to avoid extra requests).
6. Return `BrowserPage`.

**Concurrency.** Manifest fetches across the 30 repos on a page run with a bounded semaphore (size 8) — keeps page-1 cold-cache load snappy without bursting past rate limits.

**Cache.** In-memory map on `AppState`, keyed by `page`, value `{ fetched_at, cards }`. TTL 1 hour. `force_refresh: true` (refresh button) bypasses. No disk persistence in v1 — cheap to rebuild, avoids stale-data bugs.

**Failure modes:**

- Network failure → return cached page with `stale: true` if available; otherwise return the error.
- HTTP 403 / 429 → return the error verbatim. UI shows the rate-limit message (see UI section).
- Individual manifest fetches that 404 (curator deleted the file mid-page) → skip silently, log warn.
- Unparseable JSON → skip silently, log warn.

**Rate-limit math.** Cold page-1 load with 30 repos × 3 packs avg = 1 search + 30 contents-list + ~90 manifest fetches ≈ 121 requests. Authed limit is 5,000/hr — single-digit % of budget. Acceptable.

## UI

**Sidebar.** `Browse` becomes `Browse Mods`. New entry `Browse Modpacks` added directly below it. Update wherever the sidebar items are defined (likely `App.tsx` or a sidebar component).

**Browse Modpacks view** (`src/views/BrowseModpacks.tsx`):

- Vertical card list using the existing `gf-card` visual vocabulary.
- Each card: pack name, curator (`@username`), mod count, "Updated 3d ago" (relative time from `updated_at` — `Profile` already carries this; `reshare_profile` refreshes it via the snapshot).
- Top-right of the view: manual refresh icon + small "Last refreshed Xm ago" label driven by `fetched_at`.
- Skeleton cards while loading.
- Empty state when search returns no public packs: *"No public modpacks found yet — be the first to share one!"* with a link to Profiles → Share.
- Rate-limit state (403/429 from the command): *"GitHub is rate-limiting us — try again in a minute, or connect a GitHub token in Settings for a higher limit."* (Token field already exists.)
- Stale state (`stale: true`): banner *"Showing cached results — couldn't reach GitHub."*

**Card click → detail panel.** A new component (likely `BrowseModpackDetail.tsx`) using the same visual styling/layout pattern as `BrowseDetail` (panel chrome, header, body, action footer) — not literally the same component, since `BrowseDetail` today is mod-shaped. Content:

- Full mod list (name + version per row).
- Curator link (opens `https://github.com/{owner}`).
- "Created" + "Updated" timestamps from manifest.
- Install button at the bottom → calls `install_shared_profile("{owner}/{code}")`.
- Smart-import logic kicks in automatically (already-have / update / install / already-on-it toasts) — no UI work here, the existing path handles it.

**Self-hide.** The curator's own packs are filtered server-side in the Tauri command (step 5 above), so they never see their own packs back.

## Publish / Re-share prompt + manual toggle

**Prompt — inline in `PublishModal`, not a separate dialog.**

When the user shares or re-shares, after the bundling-progress phase but before the final success state, show one screen:

```
List this modpack on Browse Modpacks?

Anyone using the app can find and install it. Your share code still
works either way — this only controls whether it's discoverable.

  [ ] List in Browse Modpacks
  [ ] Don't ask me again for this modpack

  [ Continue ]
```

- Both checkboxes default unchecked.
- "List in Browse Modpacks" checked → manifest written with `public: Some(true)`. Unchecked → `public: Some(false)`. (Explicit `Some(false)` rather than `None` once the user has answered, so subsequent re-shares preserve the decision.)
- "Don't ask me again" checked → `.share` file gets `dont_ask_again: true`. Future re-shares skip the prompt and keep whatever the current manifest has.
- If `dont_ask_again` is already true on entry, the prompt screen is skipped entirely.

**Manual toggle — success state of `PublishModal`.**

The existing post-share success view (share code, repo link, re-share button) gains one new row:

```
Listed in Browse Modpacks:  [ Off | On ]
```

- State reflects the current local manifest's `public` value.
- Flipping calls a new Tauri command `set_modpack_listing(name: String, public: bool)` that:
  1. Loads the local profile JSON.
  2. Sets `public = Some(value)`.
  3. Re-uploads manifest only via `upsert_file` (using the stored `file_sha` from `.share`).
  4. Saves the updated profile back to local JSON.
- No mod re-bundling. Cheap.
- This is also the path a user takes to change their answer after ticking don't-ask-again.

## Tauri command surface (summary)

New:

- `fetch_modpack_browser_page(page, force_refresh) -> BrowserPage`
- `set_modpack_listing(name, public) -> ()`

Unchanged but reused:

- `install_shared_profile(code)` — driven by card click.
- `share_profile` / `reshare_profile` — gain a new pre-success step in the modal that writes `public` into the manifest before upload, and writes `dont_ask_again` to `.share`.

## Tests

**Rust:**

- `modpack_browser.rs`:
  - filter drops manifests with `public != Some(true)`
  - filter drops the authed user's own owner
  - cache TTL respected; `force_refresh: true` bypasses
  - 403/429 propagate as errors; cached page returned with `stale: true` on network error when cache exists
  - malformed JSON in a single manifest does not break the whole page
- `sharing.rs`:
  - `set_modpack_listing` flips `public` and re-uploads only the manifest
  - re-share preserves `public` value when prompt is skipped (`dont_ask_again`)

**Frontend:**

- `BrowseModpacks.tsx`: skeleton → cards transition; empty state; rate-limit state; stale banner
- `PublishModal`: prompt appears on first Share, skipped when `dont_ask_again` is true; manual toggle round-trips through the backend
- Card click → BrowseDetail → Install routes through `install_shared_profile` (mock the command, assert called with `owner/code`)

## Docs (README)

Three small additions under **Profiles & sharing**:

1. After the existing share-code bullets:

   > **The `sts2mm-profiles` repo on your GitHub stays public.** The manager creates it that way and your share codes only work for friends because the manifest is publicly fetchable. Don't flip it to private on GitHub — your friends will get "Profile not found" when they try to install your code.

2. For solo users:

   > **If you never publish a pack, no repo is created.** The `sts2mm-profiles` repo only appears on your GitHub the first time you hit Share. Solo users who only consume friends' packs never have anything written to their account.

3. New bullet describing Browse Modpacks:

   > **Browse Modpacks.** Sidebar → Browse Modpacks shows public modpacks people have opted into listing. Each pack is one click to install (same smart-import flow as paste-a-code). Your own packs default to unlisted — when you Share or Re-share, the Publish dialog asks once whether to list this pack on Browse Modpacks. You can flip the answer anytime from the Publish dialog.

## Open questions / risks

- **Topic noise.** `q=sts2mm-profiles+in:name` could theoretically match unrelated repos that happen to be named `sts2mm-profiles` for some other reason. Mitigated by the strict manifest-shape filter (must parse as a valid `Profile` with `public: true`). Worst case: a malformed repo wastes a manifest fetch and is skipped.
- **Rate limits for anonymous users.** Anon search is ~10 req/min. A user without a token who refreshes aggressively could hit it. Acceptable for v1 — the error message points at the existing token field.
- **Username cache invalidation.** If the user changes their PAT to a different account mid-session, the self-hide filter uses the cached old username. Acceptable — token changes are rare and the worst outcome is seeing your own packs in the list until the app restarts.
