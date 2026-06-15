# Changelog

What changed in each release, written for players — not developers.

## Writing rules (read before adding a changelog entry)

**New changes go in `changelog.d/`, not here.** Add a fragment file
`changelog.d/<category>-<slug>.md` (category = added/changed/fixed/security) with
one player-facing sentence — see [`changelog.d/README.md`](changelog.d/README.md).
`scripts/release.sh` assembles the fragments into a new version section here at
release time. (The `[Unreleased]` section below still holds the staged 1.7.0
notes; from 1.7.0 onward it stays a thin placeholder.) Per-file fragments mean
two PRs never conflict on the changelog.

These notes show up in two places, both seen by players:

1. The **"What's new" card** on the Home view (in-app, fires once per version).
2. The **GitHub release page** (auto-posted by `scripts/release.sh`).

Players don't care about our codebase. Rules (apply to every fragment):

- **Describe the change, not the implementation.** "The Mods view now shows which mods have updates" — yes. "Refactored audit state into a shared context provider" — no.
- **Skip internal-only changes.** New tests, new directories, refactors that don't change behavior — those belong in commit messages, not here.
- **Don't reference file paths, function names, or class names.** If you find yourself typing `src/...`, ``` `parse_manifest` ```, or "AppContext", stop and rewrite for what the player sees.
- **One short sentence per bullet.** If a second sentence is needed, it should explain why the player cares.
- **Active voice, present tense.** "Disabling a mod now moves it to..." not "Mods are now moved to..."

The release script lints fragments (and the legacy `[Unreleased]` body) for common dev-speak (file paths, words like "refactor"/"WebDriver"/"AppContext", etc.) and refuses to ship until it passes. Run `node scripts/changelog-fragments.mjs lint` to check your fragments.

## Releases follow [Semantic Versioning](https://semver.org/); entries follow [Keep a Changelog](https://keepachangelog.com/).

Pending changes accumulate as fragments in `changelog.d/`; the release script assembles them into a new version section on bump. (The `[Unreleased]` section below holds the staged 1.7.0 notes until that release ships.)

## [Unreleased]

_Changes are tracked as fragments in [`changelog.d/`](changelog.d/) and assembled here at release._

---

## [1.7.7] - 2026-06-15

### Fixed

- Windows app updates now install over the copy you launched, so old install records cannot leave shortcuts pointing at a missing app.

## [1.7.6] - 2026-06-15

### Fixed

- fixed: Nexus installs now keep each mod's source link tied to the correct Nexus file instead of letting a different mod overwrite it.
- fixed: Saving mod sources now keeps linked updates, displayed mod versions, and manager-only display names in sync, and display errors show a recovery screen instead of a blank window.
- fixed: Windows updates now use the same setup installer path as normal downloads, preventing parallel installs from reopening an older app.

## [1.7.5] - 2026-06-14

### Fixed

- Linux Direct launch now recognizes the game's shell launcher and explains how to fix missing execute permission.
- Load order saves now avoid changing the wrong game settings file when multiple saves are present and explain when the game settings were left unchanged.
- Recently launched modpacks now sort correctly after switching packs or launching the active pack.

## [1.7.4] - 2026-06-13

### Added

- You can now choose how many automatic backups the manager keeps — or turn backups off entirely — from Settings → Backups.
- Added sort options to the Modpacks list: recently launched, recently edited, recently created, name, and most mods.
- The Home screen now shows your recently launched modpacks for one-click switching.
- Sharing a modpack can now include your per-mod notes, links, and tags — with a checkbox to keep them private; friends' own notes are never overwritten.
- Searching inside a modpack now also filters the Add from Mod Library list, and search matches your tags too.
- You can now hide the Customize menu entry from each mod's ⋯ menu — reopen the customizer any time from Settings.
- Display settings now let you adjust text size separately from the overall interface scale.

### Changed

- When a share can't finish, the recovery panel now leads with "Try sharing again" for the common upload-hiccup case, keeping "Repair these mods" as a clearly-labeled fallback for genuinely broken files.
- Renamed the Browse tabs to Browse modpacks and Browse mods so it's clear what each one shows.
- The Windows installer now carries publisher information, which reduces antivirus false alarms; a new help section explains how to verify a download and report false positives.
- The Home recent modpacks section now shows last-played context and mod counts for each pack.
- Switching modpacks now turns on every unfrozen pack mod, and automatic backups keep two copies by default with options up to ten.
- Modpacks with unsaved active-mod changes now explain what changed without using manifest terminology.
- Re-sharing a modpack now skips rebuilding mod bundles whose files have not changed since the last successful share.
- Windows update and download prompts now explain how to verify Defender false-positive warnings before allowing the installer.

### Fixed

- The three-dot menu on a mod row no longer hides behind the row below it, so its options are always clickable.
- Sharing a modpack now automatically retries mod uploads that hit a temporary network or GitHub hiccup, instead of failing a random mod each attempt.
- Sharing a modpack now uploads every file of a mod — including its info file — so friends' games recognize mods that previously installed incomplete.
- Mod updates now pick the right download for your game build when you're on a Steam beta version (this fixes RitsuLib installing the wrong variant).
- Fixed the modpack drift and out-of-sync banners sometimes not coming back (or wrongly disappearing) after saving changes or removing mods from a shared modpack.
- Re-sharing your own modpack no longer makes it show as having updates on your own machine.
- Re-sharing a modpack now skips re-uploading mods that haven't changed, making re-shares much faster.
- The modpack header's active-mod count now stays correct after you reinstall one of the pack's mods.
- If repairing a mod fails partway, your existing mod files are now restored instead of being lost.
- Sharing a modpack now works after you delete and reinstall one of its mods — the share picks up the mod's new files instead of failing with "missing bundles".
- Modpack activation screens now show the modpack name instead of its internal ID.
- Fixed the active modpack count in the top bar so it shows that modpack's own mods instead of the whole library.
- Sharing now recovers when GitHub reports a duplicate uploaded bundle under a renamed asset filename.
- Nexus mods installed from a queued download now stay linked and can be added to modpacks even when their folder name changes.
- Publishing a modpack with a missing local mod now offers to remove that mod from the pack or reinstall it before retrying.
- Updating mods from a modpack now saves the modpack immediately and only asks you to re-share published changes.
- Switching modpacks now retries activating each included mod and warns if any installed mod still cannot be enabled.
- Mods installed from Nexus with broken manifests now keep their Nexus badge and known file version instead of showing as unlinked and unknown.
- Importing your own share code now points to the existing published modpack instead of creating a duplicate copy.
- Modpacks now keep the same identity across sharing, imports, saves, and activation so duplicate names no longer create duplicate active or shared cards.
- Modpacks now keep a stable identity through renames and show warnings when activation only partially succeeds.
- Modpacks now keep working correctly after renames by using stable local profile IDs while share codes stay tied to the shared pack.
- Sharing a modpack that isn't currently active no longer removes its stored mods from the pack.
- Repeat modpack sharing is faster for unchanged packs, publishing can be canceled from the progress window, and duplicated packs no longer keep the original curator name.
- Switching modpacks from the top bar now updates the Home screen's Recent modpacks list, just like switching from the Modpacks page.
- Modpacks with mods that have apostrophes in their names can be shared again without getting stuck.
- Publishing a modpack now updates stale local mod details so shared bundle links match the version shown in the pack.
- Sharing a modpack now reuses unchanged mod bundles before upload, including matching bundles already published by your other packs, making large shares much faster.
- Share upload failures now explain that GitHub upload or rate-limit errors should be retried instead of repaired.
- Published modpacks no longer show a duplicate empty card named after their internal ID.
- Uploads and downloads now block accidental navigation and automatically retry brief transfer failures before showing an error.
- Sharing large mod files is more resilient, and similarly named mods like BetterSpire2 and BetterSpire2 Lite are no longer treated as the same mod.

## [1.7.3] - 2026-06-07

### Fixed

- Modpacks created from your active mods no longer include mods that require a newer Slay the Spire 2 version.
- Creating a modpack from active mods now waits for the mod list to load before choosing the starting selection.
- Translated release notes now appear in Russian, Arabic, and Simplified Chinese instead of falling back to English.
- Published modpacks you download again now stay editable when they drift, so you can save and share your changes normally.

## [1.7.2] - 2026-06-06

### Added

- Added a Send feedback option — in the About footer, the bug-report window, and the logs view — that opens the mod's Nexus page, so you can send feedback without a GitHub account.
- Added display-size controls and a resizable sidebar so players can make the manager easier to read.
- The Mod Library tag picker can now show only mods without manager tags.
- Settings now lets you choose whether new installs are added to the current modpack automatically.

### Changed

- Changed modpack sharing so players can import and export local .sts2pack files and see when a shared pack needs re-sharing.
- Clarified GitHub token setup and the choices shown when enabling a mod that is not saved in the active modpack.
- The Mod Library now shows the Nexus version used for update checks when it differs from the mod manifest.

### Fixed

- Russian text now uses human-reviewed wording for modpacks, settings, update guidance, and help.
- Russian mod counts now use the correct grammatical form — for example «2 мода» and «5 модов» — instead of falling back to the English wording for some numbers.
- Clicking the "STS2 detected" status now opens Settings on the General tab even when another Settings tab is already open, instead of doing nothing.
- Searching in the Load order window no longer drags the dimmed background into view as it jumps to a matching mod.
- Nexus-only update suggestions can now be skipped until a newer version appears.
- Linked mods now show a clear current status when one source has no installable update.
- Active modpack rows now keep their active toggle and remove button when extra source details are unavailable.
- Bundle rows now keep showing the pack version instead of falling back to unknown.
- Reordering mod menus and load orders now feels smoother, and shared modpacks keep their Re-share warning until they are uploaded again.
- Newly installed mods now stay in the Mod Library unless you turn on adding installs to the current modpack.

## [1.7.1] - 2026-06-03

### Added

- Added Russian and Arabic as language options in Settings → Language, and the app now lays out right-to-left when Arabic is selected.
- Modpacks now have "Enable all" and "Disable all" buttons to switch every mod in the pack on or off at once.
- Each mod's ⋯ menu now has "Open this mod's folder" to open just that mod's folder.
- The app now has a light theme — open Settings → General and choose Light, Dark, or Auto (match your system), and your choice is remembered the next time you launch.
- A modpack that isn't active now explains why its per-mod on/off switches are hidden, with a one-click way to switch to it so you can manage what loads.
- You can now rename a modpack from its menu — its share link keeps working and your active modpack follows the new name.
- On the mod library, picking a tag now floats that tag's mods to the top (with the rest ordered by tag) instead of hiding the others; inside a modpack you can still filter its mods by tag.
- On the Create-modpack screen you can now expand each summary count to see exactly which mods it refers to, and peek the full list of mods you've selected.
- Each mod row's kebab (⋯) menu now has an "Auto-detect source" item that runs a scoped GitHub search for just that one mod; selecting it on a bundle (pack of several mods) shows a toast explaining that auto-linking isn't supported for bundles.
- Downloads that contain several mods (like the Alice Defect pack) now install and appear as a single pack — enable, disable, delete, or add it to a modpack as one unit, and rename it like any other mod.

### Fixed

- Fixed rare data-loss cases — a crash while the app was saving could wipe your saved mod sources, subscriptions, or profiles, and a failed backup-restore or modpack repair could leave your mods folder empty.
- Fixed a bug where a mod that appeared in both the active and disabled folders would show up twice in a saved modpack, causing the mod count to be higher than the number of installed mods.
- Adding a mod from "Add from your library" no longer jumps the list back to the top.
- Deleting the modpack that's currently active no longer leaves it still marked as active.
- Deleting the active modpack now clears its mods out of the game folder, so the next launch is genuinely mod-free instead of loading leftover mods with errors.
- A modpack's "drifted" banner no longer stays stuck after a successful Repair when a mod's content matches the modpack but only its version label differs.
- A modpack's drift banner and "(N missing)" indicator now update as soon as you change its mods, instead of only after leaving the page and coming back.
- Fixed "Enable all" / "Disable all" so the mod switches update right away instead of only after you leave and come back to the page.
- Fixed "Find GitHub from Nexus" — the repo it finds now appears in the source editor right away and is no longer wiped out when you save.
- Hovering the "(N missing)" count on a modpack now shows exactly which mods are listed in the pack but not installed.
- A modpack that lists mods which aren't installed now shows "(N missing)" next to its count, so the header matches the mods actually on disk.
- Fixed "Enable all" / "Disable all" inside a modpack failing with a "mod not found" error — it now reliably switches every mod in the pack and tells you by name if any couldn't be found.
- A modpack's bulk actions (Open mods folder, Enable all, Disable all) now sit on their own bar under the toolbar, so they no longer crowd the search row or get cut off on a narrow window.
- "Open mods folder" moved out of the "+ Add mods" menu and now sits as a button next to Enable all / Disable all in both the Mod Library and a modpack.
- The public/private listing toggle for a published modpack now stays correct when you reopen the publish dialog.
- Quick Add no longer keeps a previously-typed link in the box when you reopen it.
- Switching or repairing a modpack no longer risks losing a mod if a re-download fails — your installed copy is kept and restored, and the summary now names the mods that were updated, kept, or couldn't be downloaded.
- "Save changes" on a modpack now lists the mods it added to or dropped from the pack, so you can see exactly what changed.
- Auto-detect sources no longer silently shows "no candidates" for mods when GitHub's search quota runs out mid-scan; a banner now explains the rate-limit and mods that weren't searched are marked "not checked" so you know to run the scan again.
- Bundled packs and Nexus-linked mods now show their real Nexus version (the file version) instead of an unrelated version number taken from one of the mods inside the pack. Existing packs correct themselves the next time you install or update them.
- Clicking Update on a Nexus-only mod now opens the mod's Nexus page so you can download the new version — the app auto-installs it when the zip lands in your Downloads folder, instead of showing an error.

### Security

- Hardened how shared modpacks are downloaded and how Nexus and dev-build links are validated, so a malicious modpack can't steer the app at unexpected addresses.
- Backups now include your profiles and settings alongside your mods, and shared modpack bundles are verified for integrity before being installed.

## [1.7.0] - 2026-06-02

A UX simplification release. The app feels like a launcher first: pick a modpack, click Play. Power-user tools are still there, just behind progressive disclosure so they don't compete with the normal flow.

### Added

- A first-run welcome flow asks whether you want to play modpacks others made or make your own, then walks you through the relevant path.
- A guided Create Modpack wizard takes you from picking mods to checking they're healthy to finishing — no GitHub knowledge required.
- A Help button in the top bar opens a slide-out drawer with a player quick-start, a creator quick-start, and an FAQ covering frozen mods, skipped updates, Nexus manual downloads, and more.
- Small "?" tooltips throughout the app explain confusing wording in place — what "Stored" means, why GitHub is needed for sharing, why an update is blocked, and more.
- Each modpack now opens to its own detail page for managing that one pack: the mod list, a one-line status showing how many mods are active versus stored (and whether the game is running), an updates check scoped to just that modpack, a share button, and an "Add mods" menu to paste a URL, import a .zip, or open the mods folder. An "Edit" button adds or removes mods in bulk using the same picker as the Create wizard, and dragging a mod .zip onto the page adds it to that modpack.
- Sharing a modpack now sets up GitHub inside the share flow with a plain-language explanation, instead of sending you to Settings first.
- When a share fails because some mods can't be bundled, the app now offers to repair those mods inline and retry the share automatically.
- "Report a bug" replaces the old support-bundle export: it builds a redacted report — app and game version, your installed mods, the active modpack's load order, and recent logs — and opens a prefilled GitHub issue. The full report is attached automatically so nothing important is cut off, and you never need a token. You see the full report and confirm it before anything is uploaded or linked publicly.
- You can now choose which folder the app watches for Nexus mod downloads in Settings → General. The change takes effect after restarting the app.
- Modpacks you shared before this update now show a "Re-share recommended" hint so you can re-publish them and pass along the new source links to people who install them. You can dismiss the hint per pack if you'd rather not.
- Each mod row's kebab (⋯) menu now has an "Auto-detect source" item that runs a scoped GitHub search for just that one mod; selecting it on a bundle (pack of several mods) shows a toast explaining that auto-linking isn't supported for bundles.
- Downloads that contain several mods (like the Alice Defect pack) now install and appear as a single pack — enable, disable, delete, or add it to a modpack as one unit, and rename it like any other mod.

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
- The mod picker for modpacks now loads large libraries in pages, staying responsive even with hundreds of mods.
- The Installed / Browse switch sits at the top of the Mod Library and Modpacks pages, where it reads as the primary view toggle.

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
- If you haven't installed Slay the Spire 2 yet, the welcome guide no longer disappears for good — skip it for now and it comes back next launch.
- When a mod update can't restore config files you'd edited, the manager now names exactly which ones to redo instead of dropping them quietly.
- Changing a mod in your active modpack now keeps the modpack and your loaded mods in step, even when the game is running or a file can't be moved.
- Pressing Enter or Space on a button inside a mod row or modpack card no longer also opens that row or card.
- The Help panel now keeps keyboard focus inside it while open and closes on Escape, like the app's other dialogs.
- The bug report's active-modpack name and the development-build label now follow your chosen language instead of always showing English.
- Skin, asset, and voice mods that ship as a resource-pack file with no code now appear in the Mod Library and install correctly from Nexus.
- Mods installed from an imported or subscribed modpack now show their GitHub or Nexus source links instead of appearing as unlinked — including mods that were already installed, which the previous fix skipped. Existing links, notes, and saved settings on those mods are left untouched.
- Sharing a modpack now carries each mod's GitHub or Nexus link to the people who install it, so a shared pack arrives linked instead of unlinked even when the mod's own files don't name a source.
- You can edit a modpack you published again. Sharing a pack quietly subscribed you to your own copy, which then locked it as if it belonged to someone else; modpacks you published now stay editable — including adding mods to them by pasting a URL or importing a file — while ones you only follow remain protected.
- Adding a mod that's already active to a modpack with the bulk Edit dialog no longer fails with a "mod not found" error and silently drops the change; the edit now saves and the already-active mod is left as-is.
- The modpack mod picker now shows each mod's on-disk folder name when it differs from the display name, and you can search by that folder name (or mod id) — so mods that install under an unusual folder are easy to find and tell apart.
- Fixed rare data-loss cases — a crash while the app was saving could wipe your saved mod sources, subscriptions, or profiles, and a failed backup-restore or modpack repair could leave your mods folder empty.
- Auto-detect sources no longer silently shows "no candidates" for mods when GitHub's search quota runs out mid-scan; a banner now explains the rate-limit and mods that weren't searched are marked "not checked" so you know to run the scan again.
- Bundled packs and Nexus-linked mods now show their real Nexus version (the file version) instead of an unrelated version number taken from one of the mods inside the pack. Existing packs correct themselves the next time you install or update them.
- Clicking Update on a Nexus-only mod now opens the mod's Nexus page so you can download the new version — the app auto-installs it when the zip lands in your Downloads folder, instead of showing an error.

### Security

- GitHub personal access tokens and query-string API keys are stripped from diagnostic bundles automatically.
- The share-link parser now accepts only `import`, `install`, and `load` action prefixes; unknown actions are rejected rather than silently coerced.
- Updated bundled dependencies to clear security advisories (the `openssl` library and the `tmp` test helper).
- Hardened how shared modpacks are downloaded and how Nexus and dev-build links are validated, so a malicious modpack can't steer the app at unexpected addresses.

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
