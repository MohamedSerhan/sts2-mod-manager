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

- You can now choose which folder the app watches for Nexus mod downloads in Settings → General. The change takes effect after restarting the app.

### Changed

- Reporting a bug now shows you the full report and asks you to confirm before anything is uploaded or linked publicly.
- The mod picker for modpacks now loads large libraries in pages, staying responsive even with hundreds of mods.

### Fixed

- Mods installed from an imported or subscribed modpack now correctly show their GitHub or Nexus source links instead of appearing as unlinked.
- If you haven't installed Slay the Spire 2 yet, the welcome guide no longer disappears for good — skip it for now and it comes back next launch.
- When a mod update can't restore config files you'd edited, the manager now names exactly which ones to redo instead of dropping them quietly.
- Changing a mod in your active modpack now keeps the modpack and your loaded mods in step, even when the game is running or a file can't be moved.
- Pressing Enter or Space on a button inside a mod row or modpack card no longer also opens that row or card.
- The Help panel now keeps keyboard focus inside it while open and closes on Escape, like the app's other dialogs.
- The bug report's active-modpack name and the development-build label now follow your chosen language instead of always showing English.

### Security

---

## [1.7.0] - 2026-05-29

A UX simplification release. The app feels like a launcher first: pick a modpack, click Play. Power-user tools are still there, just behind progressive disclosure so they don't compete with the normal flow.

### Added

- A first-run welcome flow asks whether you want to play modpacks others made or make your own, then walks you through the relevant path.
- A guided Create Modpack wizard takes you from picking mods to checking they're healthy to finishing — no GitHub knowledge required.
- A Help button in the top bar opens a slide-out drawer with a player quick-start, a creator quick-start, and an FAQ covering frozen mods, skipped updates, Nexus manual downloads, and more.
- Small "?" tooltips throughout the app explain confusing wording in place — what "Stored" means, why GitHub is needed for sharing, why an update is blocked, and more.
- Each modpack now opens to its own detail page for managing that one pack: the mod list, a one-line status showing how many mods are active versus stored (and whether the game is running), an updates check scoped to just that modpack, a share button, and an "Add mods" menu to paste a URL, import a .zip, or open the mods folder. An "Edit" button adds or removes mods in bulk using the same picker as the Create wizard, and dragging a mod .zip onto the page adds it to that modpack.
- Sharing a modpack now sets up GitHub inside the share flow with a plain-language explanation, instead of sending you to Settings first.
- When a share fails because some mods can't be bundled, the app now offers to repair those mods inline and retry the share automatically.
- "Report a bug" replaces the old support-bundle export: it builds a redacted report — app and game version, your installed mods, the active modpack's load order, and recent logs — and opens a prefilled GitHub issue. The full report is attached automatically so nothing important is cut off, and you never need a token.

### Changed

- "Profile" is now called "Modpack" everywhere a player sees it.
- The sidebar shrinks from seven items to four: Home, Modpacks, Mod Library, Settings.
- Browse Modpacks and Browse Mods are now tabs inside Modpacks and Mod Library, not separate sidebar items.
- Home shows the active modpack and Play, and nothing else. Pasting a friend's code moves to the Modpacks page where modpack management already lives.
- The Mods view is now called "All installed mods" with a clearer subtitle. Each row shows whether a mod is active in game or stored on disk, and whether it belongs to the current modpack.
- Each mod row now opens an inline drawer when you click it, with sources, audit details, and per-mod actions all in one place. The kebab menu carries every per-mod action.
- "Disable in game" wording is replaced with "Stored" (and "Active in game" for the other state), and the per-row storage toggle moves into the kebab where it doesn't compete with modpack switching.
- Power-user actions (delete, rollback, repair, source editing, import/export JSON, snapshot, load order) group under an Advanced disclosure inside each modpack's detail.
- Network requests now time out after sixty seconds with a ten-second connect timeout so a stalled GitHub or Nexus connection no longer hangs forever.
- Inside a modpack, removing a mod is now "Remove from pack" — it stays in your library — while deleting it from disk moved into the mod's menu. Checking for updates there audits only that modpack's mods.
- Auto-detect sources (matching installed mods to their GitHub pages) moved into each modpack's Advanced menu and now scans stored mods too.
- Buttons always show a label instead of a bare icon, a mod's tags and badges sit beside its name where there's more room, and the leftover "beta" tags were removed.

### Fixed

- Sharing a modpack with mods that are missing bundled copies now offers a one-click repair-and-retry instead of failing with a wall-of-text error.
- Deep links that arrive with an unknown action prefix now show a friendly "didn't recognize" instead of being silently rewritten.
- Diagnostic bundles now redact GitHub tokens and API keys in URLs before they're copied to the clipboard.
- The bug report no longer truncates your logs: the full report is uploaded and linked in the issue, or — when no upload endpoint is configured — copied to your clipboard with a one-tap prompt to paste it in, instead of being cut down to fit a URL.
- Quick-adding a mod that's already active in the game no longer reports a false failure.
- Creating a modpack now includes only the mods you picked, instead of sometimes pulling in your whole install.
- Saving a modpack's drift applies only what differs from disk rather than re-snapshotting the whole install.
- Browse Modpacks no longer loads forever when the source is slow or unreachable, and newly added mods appear in a modpack's list right after a refresh.
- Narrow windows no longer squeeze the top bar off-screen or break headings onto one word per line.

### Security

- GitHub personal access tokens and query-string API keys are stripped from diagnostic bundles automatically.
- The share-link parser now accepts only `import`, `install`, and `load` action prefixes; unknown actions are rejected rather than silently coerced.
- Updated bundled dependencies to clear security advisories (the `openssl` library and the `tmp` test helper).

---

## [1.6.1] - 2026-05-23

### Added

- The Mods tab now has a Mod Library shortcut for assigning installed mods to profiles.
- Mod Library can keep unused mods installed but inactive, and can disable unused active mods in one action.
- Mods now support manager-only tags so you can organize and filter large libraries.
- Audit now lets you skip a specific update until a newer release appears.

### Changed

- "Pin" is now "Freeze" with clearer hints about keeping a mod's version and on/off state unchanged.
- Mod Library now labels profile membership separately from whether a mod is active in the game folder.
- Large Mod Library lists now start in smaller batches with search, sort, and "show more" controls.

### Fixed

- Publishing a profile no longer includes every installed mod by default; it uses the mods selected for that profile.
- Mod Library membership stays separate from enable/disable state, so unused mods can stay stored without cluttering shared profiles.
- Update audit now clearly marks updates blocked by your current STS2 version.
- Toast notifications no longer block quick follow-up clicks in menus.

### Security

---

## [1.6.0] - 2026-05-21

### Added

- Mod Library lets you see installed mods across profiles and add or remove them without switching profiles.
- Profiles now include a load-order editor so you can arrange how a profile's mods load.
- Mods can now have custom names and descriptions in the manager without changing their installed files.
- The Mods list now has sort options for name, enabled state, and size.

### Changed

- Browse Modpacks now fits fully in the sidebar next to the Beta badge.
- The Mods list now explains that sorting the list does not change the game's load order.

### Fixed

- Archive installs now fail clearly when the selected file only contains another archive or hides the mod behind too many folders.
- Failed nested or over-wrapped archive installs now clean up extracted files instead of leaving invisible mods behind.
- Saving or clearing source links no longer removes custom mod names or descriptions.
- Updating active profile load order now backs up the game's settings file and restores it if the write fails.

### Security

---

## [1.5.0] - 2026-05-17

### Added

- Simplified Chinese (简体中文) translation, plus an Auto / English / 简体中文 picker in onboarding and Settings → General. Auto follows your system language.
- The Browse Modpacks list now collapses duplicate publishes from the same curator down to the newest one, so you no longer see the same pack twice.

### Changed

- Bumped to 1.5.0 for the language work.

### Fixed

- Mod names with Chinese characters (or any non-ASCII text) now keep those characters when their bundles upload to GitHub release assets — they previously collapsed to underscores. (#44)
- Sidebar Beta pill on Browse Modpacks no longer overlaps neighbouring nav rows when the label is wider than the English original.
- Language picker dropdown now uses readable text on Windows dark themes.

### Security

---

## [1.4.5] - 2026-05-16

### Added

### Changed

### Fixed

- Linux AppImage buttons now keep working after updating from inside the app, including browser links, folders, support, update checks, and game launch.

### Security

---

## [1.4.4] - 2026-05-16

### Added

### Changed

### Fixed

- Linux AppImage buttons now open Steam, folders, browser links, and support links using the system environment instead of the bundled app environment.

### Security

---

## [1.4.3] - 2026-05-16

### Added

### Changed

- Advanced mode now puts Remove mod directly on each mod row so cleanup takes one click.
- The launch overlay now says Steam may take a moment when Steam was not already running.

### Fixed

- Pasting `github.com/owner/repo` into the source editor now saves the correct GitHub repo.
- Saving a corrected GitHub source now keeps that source visible after you close and reopen the editor.
- Updating after a rollback now checks the saved installed version correctly instead of getting blocked by stale mod details.
- Launching through Steam is more reliable on Windows and macOS when Steam was closed.
- The source editor's Note field now matches the rest of the dark editor styling.

### Security

---

## [1.4.2] - 2026-05-16

### Added

- Mods with a GitHub source linked now have a "Roll back one version" action in their kebab menu, marked Beta. Use it to recover when a newly released mod breaks your saves — it reinstalls the closest lower compatible release while keeping your configs.
- Settings and the first-run onboarding now offer a shortcut to create a scoped GitHub token, so you can paste it in once and stop hitting rate limits.

### Changed

- A small "Beta" badge now marks the new rollback action, the Audit mods button, and the Browse Modpacks tab so you can see which features are still being tuned.

### Fixed

- Launching the game on Linux now falls back to native Steam, Flatpak Steam, and Snap Steam launch commands when the steam:// shortcut can't open, instead of silently failing.
- The "Send to support" and "Get help" links now open even when the auto-generated GitHub URL would be too long for the system opener to handle.

### Security

---

## [1.4.1] - 2026-05-15

> **Hotfix patch over 1.4.0.** This release rolls up everything from 1.4.0 and adds the four fixes called out below, addressing modpack profile-tracking and audit-pill issues reported right after 1.4.0 shipped. Players on 1.3.x updating now will see the full 1.4.0 + hotfix changes in one step.

### Fixed (hotfix)

- Installing a shared pack now makes it the active pack. Previously the previously-active pack stayed marked as active while its saved manifest silently fell out of sync with disk — a later Re-share could then publish the imported pack's mods under the original pack's share code.
- The Publish dialog now previews exactly what will be uploaded by reading your current install, instead of the last saved snapshot. Curators who toggled mods after their last share no longer see stale counts that made re-sharing feel risky.
- Disabled mods in a shared pack are now labeled "installed off" in the Publish dialog instead of "will be excluded" — disabled mods are still shipped to your friends, just installed disabled. The old wording was the opposite of what actually happens.
- The Mods view now shows a "Download from Nexus" button next to mods that have a newer version on Nexus, matching what the Settings audit already shows.

### Added

- Installing a pack from Browse Modpacks now shows live download progress, including which mod is downloading and how far through the pack you are.
- The app now remembers a manually selected game folder across restarts, including when you launch the game directly instead of through Steam.

### Changed

- Switching or repairing a pack now keeps your disabled mod library intact. Extra active mods are moved out of the way instead of being deleted, while missing bundled mods are restored from the pack manifest.
- Pack repair now ignores disabled library mods that are not part of the selected pack, so they no longer create false drift warnings.
- The "What's new" card now hides empty sections and renders emphasis as styled text instead of showing raw markdown markers.

### Fixed

- Deleting mods no longer rewrites the active pack manifest to an empty or partial list. Only Share or Re-share updates the saved publish manifest.
- Re-importing or switching back to a shared pack now restores missing bundled mods more reliably, including pinned mods that were deleted from disk.
- Shared packs installed from Browse Modpacks now keep the curator's name instead of showing the app's name as the creator.
- Large shared packs are more reliable to upload, download, and repair, including packs with many bundled mods.
- Mods with missing or sparse metadata are less likely to lose their saved source, version, or bundle link during snapshots and re-shares.
- Release notes no longer show empty headings such as Security when that section has no entries.

### Security

- Archive installs and repair cleanup are stricter about staying inside the intended mod folders, protecting the game folder and the user's mod library from unsafe paths.

---

## [1.4.0] - 2026-05-15

### Added

- Installing a pack from Browse Modpacks now shows live download progress, including which mod is downloading and how far through the pack you are.
- The app now remembers a manually selected game folder across restarts, including when you launch the game directly instead of through Steam.

### Changed

- Switching or repairing a pack now keeps your disabled mod library intact. Extra active mods are moved out of the way instead of being deleted, while missing bundled mods are restored from the pack manifest.
- Pack repair now ignores disabled library mods that are not part of the selected pack, so they no longer create false drift warnings.
- The "What's new" card now hides empty sections and renders emphasis as styled text instead of showing raw markdown markers.

### Fixed

- Deleting mods no longer rewrites the active pack manifest to an empty or partial list. Only Share or Re-share updates the saved publish manifest.
- Re-importing or switching back to a shared pack now restores missing bundled mods more reliably, including pinned mods that were deleted from disk.
- Shared packs installed from Browse Modpacks now keep the curator's name instead of showing the app's name as the creator.
- Large shared packs are more reliable to upload, download, and repair, including packs with many bundled mods.
- Mods with missing or sparse metadata are less likely to lose their saved source, version, or bundle link during snapshots and re-shares.
- Release notes no longer show empty headings such as Security when that section has no entries.

### Security

- Archive installs and repair cleanup are stricter about staying inside the intended mod folders, protecting the game folder and the user's mod library from unsafe paths.

---

## [1.3.8] - 2026-05-13

### Added

- **Browse Modpacks.** A new sidebar tab that shows public modpacks people have shared. One click to install any pack — same smart-import flow as paste-a-code.
- **Visibility on publish.** The Publish dialog now has a Friends-only / Public choice. Friends-only is the default — your share code still works either way, this only controls whether the pack is discoverable in Browse Modpacks. You can flip it anytime from the same dialog.

### Changed

- The **Browse** sidebar tab is now **Browse Mods** to make room for **Browse Modpacks**.

### Fixed

### Security

---

## [1.3.7] - 2026-05-13

### Added

### Changed

- Updates no longer overwrite config files you've edited. If you tweaked a mod's `.cfg`, `.ini`, `.toml`, or `.txt` after installing, your edits are kept across updates and a toast tells you which files survived. (Edits made before this release won't be detected once — the comparison starts fresh on your first update after upgrading.)

### Fixed

### Security

---

## [1.3.6] - 2026-05-13

### Added

### Changed

- Settings and the onboarding wizard now spell out which GitHub token permissions you need to publish modpacks, instead of hiding them until after you've saved a token.

### Fixed

### Security

---

## [1.3.5] - 2026-05-13

### Added

- Install mods packaged as `.7z` or `.rar`, not just `.zip`. Drag-drop, the file picker, and the Downloads watcher all accept the new formats; the manager unpacks them the same way it handles a zip.
- Per-mod note + "Other link" fields. Open a mod's source editor in advanced mode to jot down where you got the file (Patreon, X, Discord) and stash a URL. The note shows up under the mod's description and the link becomes a clickable chip on the row.
- Snooze an "update available" suggestion for one mod from its kebab menu. Useful when the website's version number doesn't actually match what's inside the file. The snooze clears itself the next time the source publishes a newer release.

### Changed

### Fixed

- Linking a mod to Nexus, then updating it from a fresh Nexus download, no longer wipes the Nexus link. The manager now tracks links by mod folder, so an update doesn't strand the old entry under a different key.
- Saving sources in the editor preserves your pin and installed-version markers — previously a save would silently clear them.

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
