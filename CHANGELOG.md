# Changelog

What changed in each release, written for players — not developers.

## Writing rules (read before editing `[Unreleased]`)

These notes show up in two places, both seen by players:

1. The **"What's new" card** on the Home view (in-app, fires once per version).
2. The **GitHub release page** (auto-posted by `scripts/release.sh`).

Players don't care about our codebase. Rules:

- **Describe the change, not the implementation.** "The Mods view now shows which mods have updates" — yes. "Refactored audit state into a shared context provider" — no.
- **Skip internal-only changes.** New tests, new directories, refactors that don't change behavior — those belong in commit messages, not here.
- **Don't reference file paths, function names, or class names.** If you find yourself typing `src/...`, ``` `parse_manifest` ```, or "AppContext", stop and rewrite for what the player sees.
- **One short sentence per bullet.** If a second sentence is needed, it should explain why the player cares.
- **Active voice, present tense.** "Disabling a mod now moves it to..." not "Mods are now moved to..."

The release script lints `[Unreleased]` for common dev-speak (file paths, words like "refactor"/"WebDriver"/"AppContext", etc.) and refuses to ship until it passes. Run `scripts/release.sh patch` to see what it caught.

## Releases follow [Semantic Versioning](https://semver.org/); entries follow [Keep a Changelog](https://keepachangelog.com/).

The `Unreleased` section is the working scratchpad for the next version. The release script renames it to the tagged version on bump.

## [Unreleased]

### Added

### Changed

### Fixed

### Security

---

## [1.3.4] - 2026-05-12

### Added

- The Mods view now shows which of your installed mods have updates available. Look for a green "Update available" pill on the row; click it to update that mod in place without leaving the Mods view.
- A "What's new" card on Home tells you about each new release in plain language. Dismiss it once you've read it; the next version brings it back.

### Changed

- Checking for updates now works from the Mods view too — same data as the Settings → Audit tab, no more tab-hopping just to see what's outdated.

### Fixed

- If you had two mods with the same name (e.g. two `CardArtEditor` installs), the "update available" notice would only appear on one row. Each one now gets its own.

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
