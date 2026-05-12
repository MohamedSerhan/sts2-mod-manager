# Changelog

All notable user-facing changes to STS2 Mod Manager are recorded here. Releases follow [Semantic Versioning](https://semver.org/) and entries follow the [Keep a Changelog](https://keepachangelog.com/) shape.

The `Unreleased` section is the working scratchpad for the next version. The release script (`scripts/release.sh`) renames it to the tagged version on bump.

## [Unreleased]

### Added

### Changed

### Fixed

### Security

---

## [1.3.4] - 2026-05-12

### Added

- `Changelog` system: this file, plus an in-app "What's new in vX.Y.Z" card on Home that shows the latest entry once per version.
- Mod audit surface on the Mods view: a "Check for updates" button in the toolbar and a per-row "Update available → vX.Y.Z" pill on mods that have a newer compatible GitHub release. Audit results are shared with the Settings → Audit tab.
- Internal QA harness under `qa/` (not shipped): user-flow scenarios, fixture mod zips, coverage-audit doc tracking 32 historical user-reported bugs.
- 13 cross-module integration tests in `src-tauri/tests/qa_scenarios.rs` covering BaseLib BOM at the install layer, two-CardArtEditor collapse, pin-survives-apply (both with-pin and without-pin variants), folder-keyed watcher pin lookup, zip-slip refusal, RitsuLib mixed-layout zip wrapping, manifest-rename source migration (incl. don't-overwrite-existing-destination), profile snapshot+apply, kitchen-sink scan with every quirk simultaneously, DLL-only mod surfacing, `lookup_entry` precedence chain.
- End-to-end WebDriver smoke test in `qa/runner/smoke.mjs` driving the real production binary via `tauri-driver 2.0.6` + `msedgedriver 147`. Six specs cover: main window renders, onboarding overlay dismisses, Mods nav reaches the new audit toolbar button, audit button clickable at rest, WhatsNewCard renders correctly, Settings → Audit tab still loads after the AppContext refactor.
- `src-tauri/.tauriignore` documents which trees are dev-only and stops `tauri dev`'s file watcher from rebuilding on `qa/` / `dist/` / `target/` changes.

### Changed

- `Settings` and `Mods` now share a single audit state via `AppContext`, so running an audit from one surfaces the same results in the other.

### Fixed

- `auditByKey` in the Mods view keyed on display name only — two same-named CardArtEditor rows would have shared one audit pill. Now keyed on `folder_name ?? mod_name` matching the row's React key.
- `WhatsNewCard` markdown parser rendered `---` separators between CHANGELOG sections as literal "---" paragraphs. Horizontal rules are now dropped.
- `scripts/release.sh` GitHub-release-body extraction used `[1.3.3]` as a regex which was being interpreted as a character class matching one of `1.3`. Now parses the version token explicitly via `match($0, /^## \[([^\]]+)\]/, m)`.

---

## [1.3.3] - 2026-05-11

### Fixed

- BaseLib (and any other mod whose manifest is written by Windows tooling) showed `vunknown` after auto-update. Cause: the manifest started with a UTF-8 BOM (`EF BB BF`) and `serde_json` refused to parse it. The lenient fallback added in 1.3.1 inherited the same parser and failed too. Both paths now strip the BOM before parsing; every other manifest-read site (zip preview, dependency check, min-game-version peek, downloads watcher) got the same treatment.

---

## [1.3.2] - 2026-05-11

### Security

- Bumped `tauri` 2.11.0 → 2.11.1 (GHSA: Origin Confusion lets remote pages invoke local-only IPC commands).
- Bumped `openssl` 0.10.78 → 0.10.79 (GHSA: heap buffer overflow in AES key-wrap-with-padding; UB in `X509Ref::ocsp_responders` for non-UTF-8 OCSP URLs).

---

## [1.3.1] - 2026-05-11

### Fixed

- Two mods with the same display name (e.g. two `CardArtEditor` installs in different folders) collapsed into one entry. Toggling, deleting, or pinning one could act on the wrong copy — looked like silent data loss. Identity throughout the manager is now folder-path-based; same-named mods stay distinct, and the UI shows an author/folder subtitle on rows whose names collide.
- Manifests with one malformed field (e.g. a new `dependencies` shape) threw the entire row away and the install fell through to a `vunknown` stub. The parser now has a lenient `serde_json::Value` fallback that salvages `name` / `version` / `description` / `author` when the strict struct parse fails.

### Changed

- Tutorial Step 5 spells out that disabling moves files to `mods_disabled/` rather than deleting them.

---

## [1.3.0] - 2026-04-XX

### Added

- Launch mode setting: choose between launching Slay the Spire 2 through Steam (with overlay, achievements) or directly via the game binary. Useful when Steam isn't running or the user wants a faster cold launch.

---

## [1.2.0] - 2026-04-XX

### Fixed

- Subscription apply was writing game-version-skipped mods into the locally-saved profile snapshot, so the snapshot drifted from what was actually on disk.

---

## [1.1.x] (rollup — 2026-03/04)

Stabilization arc around modpack sharing + Nexus install UX. Highlights:

### Added

- `sts2mm://` deep links so curators can post clickable share links in Discord. Single-instance forwarding so a click focuses an existing manager window instead of spawning a second copy.
- Clickable HTTPS install bridge — links work even for users who don't have the manager installed yet.
- "Slow Download / Manual" guidance throughout the Nexus install flow; sticky "click Slow Download" toast that dismisses once the downloads watcher catches the file.

### Fixed

- Same share URL firing twice (cold-start buffer + live event) showed two confirm dialogs. Time-window dedupe (2s) replaced the previous permanent dedupe, which had a separate bug where cancel-then-retry no-oped silently.
- "Curator pushed an update" banner appeared right after install for the freshly-installed pack. Filter on `has_update` lifted into context.
- Re-share didn't clear the "out of sync" banner.

---

## [1.0.x] (rollup — 2026-02/03)

Initial public releases. Core feature set:

- Game auto-detect (Windows registry lookup + Program Files fallbacks; macOS + Linux platform-aware validation).
- Mod scan / toggle / delete with multi-pass folder + DLL detection.
- Profile snapshot / switch / share via auto-created `sts2mm-profiles` GitHub repo.
- Mod source linking (GitHub + Nexus) with auto-detect and manual override.
- Audit table: GitHub + Nexus version checks, walk-back to game-compatible releases, pin to opt out of updates.
- Backups before every launch + Vanilla launch mode.
- Onboarding wizard, custom titlebar, drag-drop install.

---

[Unreleased]: https://github.com/MohamedSerhan/sts2-mod-manager/compare/v1.3.3...HEAD
[1.3.3]: https://github.com/MohamedSerhan/sts2-mod-manager/compare/v1.3.2...v1.3.3
[1.3.2]: https://github.com/MohamedSerhan/sts2-mod-manager/compare/v1.3.1...v1.3.2
[1.3.1]: https://github.com/MohamedSerhan/sts2-mod-manager/compare/v1.3.0...v1.3.1
[1.3.0]: https://github.com/MohamedSerhan/sts2-mod-manager/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/MohamedSerhan/sts2-mod-manager/compare/v1.1.11...v1.2.0
