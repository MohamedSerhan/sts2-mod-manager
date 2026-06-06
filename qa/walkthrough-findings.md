# Real-user walkthrough — test coverage audit

This is a structured walk through the STS2 Mod Manager from a user's perspective, comparing what users actually do to what the test suite actually checks. It's the seed for the QA harness in `qa/scenarios/` and a punch list of integration tests we should add even before that harness exists.

**Why this exists:** the BaseLib BOM bug shipped in 1.3.1 despite a "lenient parse" test. The test exercised a synthetic failure (malformed `dependencies`), not the actual on-disk shape of a popular mod (UTF-8 BOM written by Windows tooling). Unit tests pass; users still see broken behavior. Integration coverage with **real fixtures** is what was missing.

## Scoring legend

- 🟢 Covered by an integration test that exercises the real code path with realistic input
- 🟡 Covered by unit tests, but not at the integration boundary where real inputs flow in
- 🔴 No coverage — a regression here will reach users before we notice

---

## Flow 1 — First-time setup
**User does:** Installs the manager. Onboarding overlay appears. Manager auto-detects the Steam path, scans the mods folder, shows the existing mods.

**Can break:**
- Steam install detection (registry lookup on Windows, hardcoded paths on macOS/Linux)
- Game path validation (release_info.json read)
- Initial scan of an existing mods folder that's been around for months — full of edge cases (BOM manifests, doubly-nested folders, loose DLLs at root, duplicate-named mods)
- `mod_sources.json` migration from older format
- Profile auto-creation on first scan

**Coverage:** 🔴
- No test for `detect_game_path`
- The scan logic now has 4 integration tests (folder identity, BOM, two-name collision, well-formed) but the **set** of fixtures is tiny. Real users have 15–30 mods with a mix of all the above quirks simultaneously, not one quirk per fixture.

**Action:** A scenario that builds a "kitchen sink" mods folder (BOM + nested + duplicate names + loose DLL + DLL-only mod + subdir mod whose manifest name differs from folder name) and scans it once, asserting every mod surfaces correctly.

---

## Flow 2 — Install from share code
**User does:** Pastes `xxsku/AbC12345Df` into Home → confirm → manager downloads the curator's `sts2mm-profiles/AbC12345Df.json`, fetches every mod listed, applies the profile.

**Can break:**
- Share-code parsing (covered)
- GitHub API rate limiting (no fallback)
- Missing mod re-download via `mod_sources.lookup_entry` — fixed but untested at integration
- Folder-keyed installed_version after install (fixed but untested)
- Mods listed in profile but the linked GitHub repo has no release with assets

**Coverage:** 🟡 share-code parsing has unit tests; the full install pipeline does not.

**Action:** A scenario that imports a real share code against a fixture profile.json hosted in a test repo (or a captured Nexus response file), with the network layer stubbed to return cached responses.

---

## Flow 3 — Install via Quick Add (GitHub URL)
**User does:** Paste `https://github.com/Alchyr/STS2-BaseLib` into Quick Add → manager fetches latest release → extracts to `mods/BaseLib/` → BaseLib appears with `v3.1.2`.

**Can break:**
- GitHub release fetch
- Asset selection (`.zip` vs `.dll` only)
- Zip extraction (wrap folder detection, doubly-nested folder handling)
- **Manifest parse on the extracted file (BOM, malformed deps, missing fields)**
- `download_github_mod` saving the source link under folder_name (now fixed, untested)
- Game-version compat walk-back if the latest release requires a newer STS2 build

**Coverage:** 🔴 The new BOM test is on `parse_manifest`; `install_mod_from_zip` is **not** tested with a BOM-manifest zip. If the install pipeline regresses but `parse_manifest` keeps working, BaseLib could break again.

**Action:** Build a fake zip in a temp dir with a BOM manifest + DLL + PCK, call `install_mod_from_zip`, assert version is `v3.1.2`, not `unknown`.

---

## Flow 4 — Install via Nexus (browser → Slow Download → watcher catches)
**User does:** Paste Nexus URL → manager opens the Files tab → user clicks Slow Download → zip arrives in `~/Downloads` → manager's watcher detects it → installs → toast appears.

**Can break:**
- Nexus API (mod info lookup)
- Browser-open intent
- Watcher: file-finish detection (the 1.5s sleep heuristic)
- Watcher: `looks_like_mod_zip` filter
- Watcher: `peek_zip_identity` (BOM)
- Watcher: pin protection (now folder-keyed, fixed, untested integration)
- Watcher: replacing an existing mod (file removal + reinstall)

**Coverage:** 🔴 No test for the watcher path at all. This is high-stakes — auto-install over a pinned mod = data loss for the user.

**Action:** A scenario that drops a fixture zip into a test Downloads dir, asserts the pinned-mod block fires; another scenario that drops an unpinned-mod replacement zip and asserts the install completes.

---

## Flow 5 — Toggle a mod off/on
**User does:** Click toggle on a mod row → files move to `mods_disabled/` (off) or `mods/` (on) → toast → profile manifest refreshes.

**Can break:**
- Folder-name identity (covered ✓)
- Game-running guard
- Profile-snapshot refresh after toggle (orphan-detection edge case)
- The same mod existing in BOTH active + disabled (interrupted toggle)

**Coverage:** 🟢 `disabling_one_same_named_mod_leaves_the_other_active` covers the headline case; the interrupted-toggle case is 🔴.

---

## Flow 6 — Delete a mod
**User does:** Kebab → Remove mod → typed confirm → all files gone, parent dir cleaned up if empty.

**Can break:**
- Folder identity disambiguation (now fixed for delete, **no integration test**)
- Parent dir cleanup (e.g. mod nested under `mods/Foo/Bar/Foo.dll` — cleanup walks parents)
- Re-snapshot after delete

**Coverage:** 🔴 No test exercises `delete_mod_cmd` at all.

**Action:** Integration test that sets up two same-named mods, calls delete on one by folder, asserts the other is intact and on-disk state matches.

---

## Flow 7 — Pin survives a modpack apply
**User does:** Pin a mod → switch to a profile that doesn't include it → pinned mod stays enabled.

**Can break:**
- Pin DB key write (folder-keyed, fixed, **untested integration**)
- `apply_profile` reading pin via folder-first (fixed, **untested integration**)
- The actual mod file not being touched during apply (this is the user-visible promise)

**Coverage:** 🔴

**Action:** Scenario that creates a pinned mod, applies a profile that doesn't list it, asserts pin held + files present.

---

## Flow 8 — Update a single mod
**User does:** Settings → Audit row → Update button → walk-back → download → install → version refreshes in audit row.

**Can break:**
- `update_mod` resolving the right mod via folder_name (fixed, **untested**)
- BOM in updated manifest (now fixed, **untested in install path**)
- Walk-back when latest release requires a newer game version
- `installed_version` write under folder_name (fixed, **untested**)

**Coverage:** 🔴

---

## Flow 9 — "Are any of my mods out of date?" (audit)
**User does:** Wants to know what to update. **Currently has to dig into Settings → Audit tab.** Should be on the Mods view (#3 in this batch).

**Can break:**
- Audit fetching releases for 30 mods sequentially with rate limits
- Nexus variant picker (BetterSpire2 vs BetterSpire2Lite)
- Pinned-mod exclusion
- Game-version compat flag

**Coverage:** 🔴 No test for `audit_mod_versions`.

**Action:** UX — move audit summary to Mods view. Test — cassette-based test that runs audit against captured GitHub/Nexus responses.

---

## Flow 10 — Create a modpack
**User does:** Modpacks → Create modpack → choose a starting strategy → name it → modpack manifest saved.

**Can break:**
- Folder-keyed source lookup in snapshot (fixed, **untested**)
- Bundle URL inheritance from existing share
- Disabled mods included in snapshot

**Coverage:** 🟢 `qa/runner/smoke.mjs::specCreateModpack`; see `qa/coverage-matrix.md`.

---

## Flow 11 — Switch modpacks
**User does:** Modpacks list → open another modpack → click Switch to → apply.

**Can break:**
- Re-download of missing mods via folder-keyed `github_repo` (fixed, **untested**)
- Enable/disable diffing
- Drift report (added/removed/version-changed)
- Pinned-mod exclusion from apply

**Coverage:** 🟢 `qa/runner/smoke.mjs::specModpackSwitchPreservesFreeze`; see `qa/coverage-matrix.md`.

---

## Flow 12 — Share a modpack (curator path)
**User does:** Modpacks → open a modpack → Share → manager creates `sts2mm-profiles` repo on the curator's GitHub → uploads profile.json + mod bundles → returns share code.

**Can break:**
- GitHub token validation
- Repo creation idempotency
- Bundle uploads (large files, retries on rate limit)
- Privacy: token is in OS keyring, never logged

**Coverage:** 🔴 — and harder to test because it mutates the user's actual GitHub.

**Action:** Mock GitHub API and run the publish flow against the mock.

---

## Flow 13 — Repair a broken mod
**User does:** Mod shows "vunknown" or won't load → kebab → Repair → fresh install from GitHub.

**Can break:**
- Folder-keyed lookup so repair targets the right copy (fixed, **untested**)
- Old-files deletion (every file in `info.files` + folder dir)
- Walk-back compat selection
- Source migration on rename

**Coverage:** 🔴

---

## Flow 14 — Drag-drop install
**User does:** Drags a .zip onto the window → install completes.

**Can break:**
- `file.path` access (Tauri-specific drop API)
- Same install pipeline as Quick Add — same BOM / wrap-folder / manifest concerns

**Coverage:** 🔴

---

## Flow 15 — Restore a backup
**User does:** Settings → Backups → Restore → mods folder reverts to backup snapshot.

**Can break:**
- Backup integrity
- File-locking (game running)
- Partial-restore on failure

**Coverage:** 🔴

---

## Flow 16 — Launch the game
**User does:** Top bar → Launch → auto-backup → Steam launches game.

**Can break:**
- Backup creation (disk full, permissions)
- Steam launch mode (Steam protocol vs direct binary — added recently)
- `is_game_running` polling

**Coverage:** 🔴

---

## Flow 17 — Onboarding wizard
**User does:** First launch → wizard → click through → manager ready.

**Can break:**
- localStorage detection (incognito-ish modes)
- Game-detect button retry
- Skip flow

**Coverage:** 🔴

---

## Flow 18 — Deep link (sts2mm:// in Discord/browser)
**User does:** Clicks a friend's share link in Discord → manager opens (or focuses) → confirm dialog → install.

**Can break:**
- Deep-link plugin (registration on each platform)
- Single-instance forwarding on Windows/Linux
- URL dedupe window (2s)
- Cold-start vs warm-start routing

**Coverage:** 🔴

---

## Flow 19 — Subscription updates
**User does:** Followed a curator's pack → background check finds an update → banner → click to apply.

**Can break:**
- Background poll cadence
- Diff computation
- Folder-keyed `github_repo` lookup during apply (fixed, **untested**)

**Coverage:** 🔴

---

## Flow 20 — Bulk operations
**User does:** Enable all / Disable all / Delete all.

**Can break:**
- Iteration order (filesystem fairness)
- Partial-failure handling
- Profile refresh

**Coverage:** 🔴

---

---

## Mod-author flows (a different user class entirely)

Mod authors use the manager differently from players. They iterate, break things on purpose, and ship to other users — which means their bugs become everyone else's bugs.

### Flow A1 — Iterate on a mod under development
**Author does:** Drops their dev build (just `.dll` + `.pck` + manifest) into `mods/MyMod/` → uses the manager to launch the game → finds a bug → quits the game → rebuilds the .dll → relaunches.

**Can break:**
- The manager keeping a file handle on `.dll` while the game is running, blocking the author's rebuild output
- "Mod not found" if the manager's scan sees a half-finished build mid-write
- Manifest JSON that the author is currently editing (incomplete brace, trailing comma) → "vunknown" stub appears
- Author writes manifest in Notepad (default Windows editor) → **BOM** in the file → exact BaseLib bug

**Coverage:** 🔴 No tests cover the "actively-being-edited" or "saved by Windows tools" cases. BOM is now handled on the read path, but the author's *experience* of seeing their mod broken in the manager isn't tested.

**Action:** Scenario where the manifest file is malformed in 5 common author-mistake ways (missing comma, extra comma, unclosed brace, BOM-prefixed, number-instead-of-string version) — each should produce a useful log message and a best-effort partial parse, not a silent stub.

### Flow A2 — Link the GitHub source for the curator's mod
**Author/curator does:** Their mod lives on `github.com/them/MyMod`. They open the Mods view, expand their mod, paste the URL into the source editor → manager remembers → audit table can now check for releases.

**Can break:**
- URL parsing (variants: with/without `.git`, with/without trailing slash, `git@` SSH form, organization vs user)
- Source-entry write under folder_name (fixed, **untested**)
- Subsequent audit picking up the link

**Coverage:** 🟡 URL parsing has some heuristic coverage in `parse_source_url` but no test.

### Flow A3 — Publish a release on GitHub, expect users to get the update
**Author does:** Tags `v1.4.0` on their repo → pushes assets → users open their managers → audit shows "update available" → they click Update → manager downloads + installs the new release.

**Can break:**
- Tag format the audit accepts (`v1.4.0`, `1.4.0`, `release-1.4.0`?)
- Release-with-no-assets (author forgot to upload the .dll → manager should skip and walk back)
- Asset name doesn't match expected `.zip`/`.dll`/`.pck` pattern
- Author renames the manifest's `name` field between versions → `migrate_source_entry` keeps the source link

**Coverage:** 🔴 None of these edges have tests.

### Flow A4 — Test the mod against an older STS2 build
**Author does:** Sets `min_game_version: "0.110.0"` in their manifest. User on `0.109.x` shouldn't load it. Author needs to verify the manager warns them correctly.

**Can break:**
- `gameVersionSatisfies` parse hiccups on quirky version strings
- "Walk back to compatible release" picking the wrong tag

**Coverage:** 🟡 `gameVersionSatisfies` is small and trivially correct, but the audit's walk-back path that uses it is 🔴.

### Flow A5 — Curate a modpack and share it
**Curator does:** Installs the 12 mods they like → Modpacks → Create modpack → name it → Share → manager creates `sts2mm-profiles` repo on their GitHub, uploads `profile.json` + bundles every mod whose source isn't reachable → returns share code → curator posts code in Discord.

**Can break:**
- GitHub repo creation (token scope, rate limits)
- Bundle uploads (large `.pck` files, retries)
- Token leaking into logs (security)
- Profile manifest with folder-keyed source entries — the share writer needs to encode both name + folder for downstream

**Coverage:** 🔴

### Flow A6 — Push an update to a published modpack
**Curator does:** Updates a mod in their modpack → Modpacks → open the pack → re-share → friends who subscribed see "update available" → apply.

**Can break:**
- Re-share idempotency (overwrite existing share code's data, don't generate a new one)
- Subscribers' `lookup_entry` finding the right folder-keyed source link
- Bundle re-upload (only changed mods)

**Coverage:** 🔴

### Flow A7 — Help a friend whose pack is broken
**Curator does:** Friend says "your modpack isn't loading X". Curator asks them to use Settings → Generate support bundle → friend pastes the redacted log. Curator reads the log and figures out what's wrong.

**Can break:**
- Support bundle missing relevant info
- Support bundle leaking secrets (Nexus API key, GitHub token — both should be redacted)
- Log format ambiguous for an author who isn't living in this codebase

**Coverage:** 🔴

### Flow A8 — Author's mod doesn't show up at all after install
**Author does:** Drops their `.dll`-only mod (no manifest) into `mods/` → manager should show it as a "DLL-only" mod with `version: "unknown"` (intentional fallback for mods without a manifest).

**Can break:**
- PASS 3 (DLL-only fallback) skipping their mod because a sibling .json with the same stem already counted
- DLL-only mod getting double-counted as both a manifest mod AND an orphan DLL

**Coverage:** 🟡 The dedup logic that prevents double-counting has comments referencing the bug but no test.

---

## The honest scorecard

| | Player flows | Mod-author / curator flows | Total |
|---|---|---|---|
| 🟢 Real integration coverage | 1 | 0 | 1 |
| 🟡 Unit-only coverage | 4 | 3 | 7 |
| 🔴 No coverage | 15 | 5 | 20 |

**28 user flows. 26 tests pass.** The tests cover the **logic of small helpers** (path safety, share-code parsing, BOM stripping, dedup keying, lenient JSON). They do **not** cover the **flows users actually run** — and mod authors are basically uncovered, despite being the source of every quirk that hurts players (BOM manifests, version-string variants, dev-iteration races).

## What this means for #2 (the QA harness)

The harness needs to exercise flows end-to-end with real fixtures, not synthetic ones:

1. **Real mod zips** — captured copies of BaseLib, RitsuLib, CardArtEditor, AutoPath, etc. ~10 popular mods in `qa/fixtures/zips/`. Their manifests carry every quirk in the wild (BOM, structured deps, full-art mode flags, etc.)
2. **Real Nexus API responses** — cassette files in `qa/fixtures/nexus/` recorded once, replayed offline. Never hit Nexus during test runs (rate-limited + flaky).
3. **Real GitHub release payloads** — same pattern in `qa/fixtures/github/`.
4. **Fake-but-realistic game install** — `qa/fixtures/game/` is a directory tree mirroring `Slay the Spire 2/mods/` + `release_info.json`. The harness clones it to a fresh tempdir per scenario so tests can't pollute each other.
5. **Scenario format** — Markdown with a YAML preamble, each scenario describes a single user flow + assertions. An AI agent reads the markdown, executes the Tauri commands via a thin Rust harness, and verifies the asserted state.

## Historical user-reported bugs

Every fix commit in `git log` represents a real user (or me-as-user) hitting something that shipped. Each one is a scenario the QA harness must own — a regression in any of these is a guaranteed repeat user report.

Status legend: ✅ has a test that locks the fix in · ⚠️ fix shipped but no test guards it · ❌ no fix yet

### Mods view / scan / install

| # | What broke | Reported by | Fix commit | Status |
|---|---|---|---|---|
| 1 | Two CardArtEditor folders collapsed into one entry — toggle/disable acted on wrong copy | JadeDemon (this batch) | f26f339 | ✅ |
| 2 | BaseLib auto-update showed "vunknown" because the BOM-prefixed manifest broke serde parse | JadeDemon + me reproducing | fd3489c | ✅ |
| 3 | "Where did my mod go?" — disabling moves to `mods_disabled/`, not delete; UI didn't explain | JadeDemon | fd3489c (tutorial copy) | ⚠️ (copy, no test) |
| 4 | RitsuLib mixed-layout zip (root files + `Translations/` subfolder) updated half-old/half-new because tracking was stem-based | RitsuLib install report | install_mod_from_zip wrap-folder logic | ⚠️ |
| 5 | STS2-ShowPlayerHandCards: structured-deps format (`[{"id": "X", "min_version": "1.0"}]`) broke strict parse → "vunknown" stub | hand-cards user | RawDependency `#[serde(untagged)]` | ⚠️ |
| 6 | BAKAOLC's `STS2-ShowPlayerHandCards` repo renamed its manifest `name` between versions → source link stranded under old name | rename user | `migrate_source_entry` | ⚠️ |
| 7 | Toggle moved wrong files because `move_mod_files` matched by stem alone | inferred from toggle comment | folder-first scan in `toggle_mod` | ✅ |
| 8 | DLL-only mod double-counted as both manifest + orphan DLL (+1 count vs game's) | scan-count discrepancy | `found_names` extra keys in PASS 1 + 2 | ⚠️ |
| 9 | Doubly-nested zip lands at `mods/Foo/Foo/Foo.dll`, scan only descends one level → mod invisible | packaging-quirk users | `single_same_named_child` recovery in PASS 2 | ⚠️ |
| 10 | `.NET ReflectionTypeLoadException` because installer filtered out non-.dll/.json/.pck dependency files | mod authors with deps | extract-everything change | ⚠️ |
| 11 | Hostile zip with `Name: "../.."` could redirect extraction outside mods folder | security audit | `sanitize_path_segment` + `path_is_inside` | ✅ |

### Update flow / audit

| # | What broke | Reported by | Fix commit | Status |
|---|---|---|---|---|
| 12 | Update button installed latest tag even when its `min_game_version` exceeded the user's STS2 → unloadable install | game-update mismatch | ab5fb7c (compat-aware Update) | ⚠️ |
| 13 | Red "needs update" LED firing for releases that had no installable assets ("gone" state) | curator audit | a38c499 | ⚠️ |
| 14 | Update button visible even when only Nexus flagged a release the user couldn't actually install | nexus-only update flow | f087a27 | ⚠️ |
| 15 | BetterSpire2 vs BetterSpire2Lite: Nexus page version is one number for the latest-uploaded variant — Lite installs got bogus mismatch warnings | variant users | `pick_version_for_local_mod` | ⚠️ |
| 16 | Auto-detect attached low-confidence StS-1 repos to STS2 mods that shared a name fragment (e.g. ModConfig) | bad-link reports | MIN_SCORE bump 70→80 + `is_sts2_related` gate | ⚠️ |
| 17 | Auto-detect kept overwriting user's deliberate Nexus-only choice with a guessed GitHub repo | "auto-detect keeps messing up" | Phase 0.5 removed, has-nexus skip in Phase 1 | ⚠️ |

### Profiles / subscriptions

| # | What broke | Reported by | Fix commit | Status |
|---|---|---|---|---|
| 18 | Phantom "curator pushed an update" banner right after install (fresh sub still appeared in update list) | post-install confusion | a2b2731 | ⚠️ |
| 19 | "Out of sync" banner stuck even after curator re-shared | re-share users | 5eb01dd | ⚠️ |
| 20 | Profile Repair didn't actually delete orphan disabled-folder files → drift kept showing up | orphan drift report | 3077c35 | ⚠️ |
| 21 | Game-version-skipped mods polluted the saved snapshot, so subscribers reapplying got phantom entries | subscription apply | 37df97f | ⚠️ |
| 22 | Switching profiles didn't remember toggle state — subsequent Repair undid the user's choice | "profile state not sticky" | `refresh_active_profile_manifest` after every mutation | ⚠️ |

### Deep links / sharing

| # | What broke | Reported by | Fix commit | Status |
|---|---|---|---|---|
| 23 | sts2mm:// URL spawned a new manager process every click instead of focusing existing one | Windows/Linux users | f48b367 (single-instance) | ⚠️ |
| 24 | Cold-start buffer + live event both fired for the same URL → two confirm dialogs back-to-back | deep-link race | 7ecf0df (URL routing dedupe) | ⚠️ |
| 25 | Permanent URL dedupe meant cancel-then-retry no-oped silently | retry-after-cancel | 9117179 (2s time-window dedupe) | ⚠️ |
| 26 | Share-code paste from Discord included extra prefix/URL → Rust install command got malformed input | paste-from-Discord users | 7ecf0df (canonicalShareCode) | ⚠️ |

### Detection / launch / Nexus

| # | What broke | Reported by | Fix commit | Status |
|---|---|---|---|---|
| 27 | Steam install on non-default drive (D:, E:) not auto-detected — hardcoded Program Files paths missed it | auto-detect failure reports | 7105e5a (registry lookup) | ⚠️ |
| 28 | Linux-specific issues on CachyOS (graphical glitches, deep-link missing) | CachyOS user | 6184609 (docs workarounds) | ⚠️ |
| 29 | Sticky Nexus "click Slow Download" toast lingered after install completed | UX report | a5dc76d (watcher dismisses sticky) | ⚠️ |
| 30 | "Mod Manager Download" deep link on Nexus didn't work — should tell users to use Slow Download | nexus install confusion | e18d334 (tutorial copy update) | ⚠️ (copy, no test) |
| 31 | Profile downloads using `mod_sources.json` re-download missed entries keyed by name after pin moved entries to folder-key | regression I caught during audit, not a user report — yet | f26f339 follow-up commits | ⚠️ |
| 32 | Downloads-watcher would overwrite a folder-keyed pinned mod because the pin lookup was name-only | same as #31 — caught in audit, not user report | f26f339 follow-up | ⚠️ |

### What the table reveals

- **30 distinct user-reported bugs** in the visible history (some commits bundle more than one fix).
- **Only 3 of them have a regression test that locks the fix in.** The other 27 are "the code is correct now, but a future change could undo it without anything failing."
- The pattern is consistent: fixes ship, comments document the bug, tests are an afterthought. The QA harness needs to backfill these — every bug in this table becomes a scenario.

### Priority for the harness backfill

Tier 1 (data-loss / silent corruption — must be regression-tested before next minor release):
- #1, #2, #4, #6, #11, #20, #21, #22, #32

Tier 2 (visible failure / user confusion — should be in the harness):
- #3, #5, #7, #9, #12, #18, #19, #24, #25, #29

Tier 3 (UX polish / edge case — backfill when time allows):
- #8, #10, #13, #14, #15, #16, #17, #23, #26, #27, #28, #30, #31

---

## Recent bugs this audit would have caught

| Bug | Flow it lives in | Why my unit test missed it |
|---|---|---|
| Two CardArtEditor mods collapsed | Flow 1 + 5 + 6 | I tested `upsert_mod_dedup` directly; never built a fixture mods-folder with two same-name folders and ran a full scan + toggle |
| `vunknown` after BaseLib update | Flow 3 + 4 + 8 | I tested `parse_manifest` with a synthetic malformed-dependencies manifest; the **real** manifest had a BOM, which my fixture didn't |
| Settings pin/unpin desync after Mods pin | Flow 7 | I didn't test the cross-surface pin lookup path at all |
| Downloads-watcher pin bypass (would have caused silent overwrite) | Flow 4 | I caught it during the regression audit, not from a test — pure luck |

## Immediate-value additions (before the harness lands)

Three integration tests in `src-tauri/src/mods.rs` that close the highest-risk gaps and don't require any new framework:

1. **`install_mod_from_zip_handles_bom_manifest`** — build a fake BaseLib-shaped zip in a tempdir, call install, assert version is recovered.
2. **`delete_targets_correct_folder_when_names_collide`** — same fixture as the disable test, call `delete_mod_cmd`'s underlying file-removal logic with folder_name.
3. **`scan_handles_kitchen_sink_mods_folder`** — one scan, every quirk simultaneously.

These can land before the AI harness exists and would close the loop on the recent regressions.
