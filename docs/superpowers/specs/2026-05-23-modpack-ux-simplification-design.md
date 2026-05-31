# STS2 Mod Manager 1.7.0 UX Simplification Design

## Purpose

Recent releases added useful mod-management features, but the app now asks users to understand too much of the implementation model. Version 1.7.0 should make the app feel like a simple modpack launcher first, while still preserving the durable behavior needed by creators, large mod libraries, and power users.

The direction is **Launcher First + Creator Workflows**:

- Players can choose a modpack, sync updates, and launch without learning source links, profile membership, or GitHub details.
- Creators can build, audit, maintain, and share modpacks through guided flows that explain each step when it becomes relevant.
- Existing behavior stays intact unless a test proves a behavior change is safe.

## Design Guardrails

This is not a visual redesign. Keep the current visual identity as the design sheet:

- Reuse the existing dark palette, typography scale, button styles, badges, card radius, icons, spacing, and `gf-*` CSS conventions.
- Prefer existing shared components: `Button`, `Card`, `Badge`, `Toggle`, `KebabMenu`, `ConfirmDialog`, existing form controls, and lucide icons.
- Do not introduce a new color system, new button look, new card style, or new decorative visual language.
- Improve consistency by replacing one-off inline styles and inconsistent action placement with existing patterns.
- Keep CSS in `src/styles.css`.
- Keep every user-visible string in `react-i18next`, with English and Simplified Chinese updated together.

## User-Facing Language

Replace user-facing **Profile** language with **Modpack** across the app.

The internal Rust/TypeScript model may continue using `profile` names where renaming storage, commands, or files would create migration risk. The UI should not expose that term unless an old file format or imported JSON explicitly contains it.

Preferred terms:

- **Modpack**: a named set of mods the user can activate, launch, sync, and share.
- **Active modpack**: the modpack currently applied to the game folder.
- **All installed mods**: the durable local library of files across all modpacks.
- **Stored** or **Inactive in game**: installed files kept outside the active game folder.
- **In this modpack**: included in the selected modpack.
- **Included, off in this modpack**: part of a modpack but disabled there.
- **Freeze**: keep a mod's current version and on/off state unchanged.
- **Skip this update**: hide one specific update until a newer release appears.
- **Help**: the support/FAQ area. Do not use “Learn” as a main nav label.

Avoid ambiguous terms:

- Do not use **Disable in game** as the primary label.
- Do not let **Mods** imply “active modpack mods” if the screen shows all installed mods.
- Do not use GitHub-token language before the user has chosen to share.

## Navigation

Use this information architecture:

- **Home**: launcher-first status and next actions.
- **Modpacks**: create, switch, update, publish, and manage modpacks.
- **All installed mods**: all local mod files, active/stored state, individual mod actions.
- **Browse** or the existing Browse Mods/Browse Modpacks split if merging is too risky for 1.7.0.
- **Help**: FAQ and task-based guidance.
- **Settings**: app/game/account/backups/advanced settings.

The exact sidebar grouping can remain close to the current app to avoid churn, but labels and page headings must make the mental model clear.

## Home

Home should behave like the simple launcher surface inspired by Paradox:

- Show the active modpack as the primary first-viewport signal.
- Primary action: **Play**.
- Secondary actions: **Switch modpack**, **Create modpack**, and **Review updates** when relevant.
- Show readiness state: game detected, mod count, pending sync/update state, and whether the active modpack is local or shared.
- When no modpack exists, guide the user toward either pasting a friend's code, browsing modpacks, or creating a new local modpack.
- When a creator has an unpublished active modpack, offer **Share modpack** as a contextual action.

Home must not become a dashboard of every feature. It should answer: “What can I play right now, and what is the next obvious action?”

## Modpacks

The current Profiles view becomes the Modpacks workspace.

Normal actions:

- Switch/activate a modpack.
- Create a modpack.
- Add a friend's code.
- Review followed modpack updates.
- Share or re-share a modpack.

Advanced or secondary actions:

- Import/export JSON.
- Duplicate/snapshot.
- Load order editing.
- Delete.
- Repair/re-apply exact manifest.

Actions should be grouped consistently. Primary row actions should be limited to what most users need; rare actions belong in menus or advanced sections.

## Create Modpack Flow

New users need help making a modpack. Creating a modpack should be a guided workflow, not just an empty name field.

Recommended steps:

1. **Start**
   - Options: start from current active mods, start empty, or clone an existing modpack.
   - Explain that a modpack is a saved set of mods.

2. **Choose Mods**
   - Use the installed mod library with search and sorting.
   - Make the selected count obvious.
   - Preserve scroll/focus while toggling membership.

3. **Check Health**
   - Summarize missing sources, available updates, frozen mods, skipped updates, and game-version warnings.
   - Let users proceed locally even when sources are missing.

4. **Finish**
   - Create the local modpack without requiring GitHub.
   - Offer **Share now** as an optional next step.

GitHub must not be required to create or use a local modpack.

## Share Setup

GitHub setup appears when the user chooses to share a modpack.

The share flow should explain, in friendly language:

- Sharing needs a place to host the modpack code and any bundled files.
- The app uses a small public GitHub repo named `sts2mm-profiles` that it manages for the user.
- The GitHub token lets the app create/update that repo.
- The token is stored in the OS keyring.
- Friends use the share code or install link; they do not need the creator's GitHub token.

The user should see a guided setup panel with:

- What will happen.
- Why GitHub is needed.
- A button to create the correct scoped token.
- The token input and save action.
- A clear retry path if the token fails.

Do not show raw implementation detail before it is needed.

## All Installed Mods

Rename or frame the Mods view so users understand it shows the whole local library, not just the active modpack.

The screen should distinguish:

- Active in game folder.
- Stored/inactive but still installed.
- Included in the active modpack, if known.
- Not included in the active modpack.
- Included but off in a modpack.

Normal actions:

- Search/sort/filter.
- Toggle active/stored state for a mod.
- Review update pills.
- Open the installed mods folder.

Advanced actions:

- Source editing.
- Repair.
- Rollback.
- Freeze/unfreeze if it is not already contextual.
- Remove mod.
- Bulk enable/disable/delete.
- Tags, unless a simple use is made clear.

The “sort does not change load order” explanation remains important.

## Mod Library

The Mod Library concept should be kept but reframed.

Purpose:

- It is the durable list of installed files across all modpacks.
- Modpack membership decides what belongs to a modpack.
- Stored mods remain installed without cluttering shared modpacks.

The UI must make the two axes visible:

- Storage state: active in game vs stored/inactive.
- Modpack membership: in this modpack vs not in this modpack vs included off.

Large-library requirements from `AGENTS.md` remain mandatory:

- Search, sort, pagination/windowing, or incremental rendering.
- At least 100-mod test coverage when practical.
- Preserve scroll and focus during membership toggles.
- Do not publish every installed mod by default.

## Audit and Source Health

Audit should be taught as “check whether your modpack can be maintained and updated,” not as a technical report.

For players:

- Surface only actionable updates and clear warnings.
- Explain game-version-blocked updates and skipped updates in plain language.

For creators:

- Show missing sources before sharing.
- Explain why sources matter: linked sources help friends get canonical updates; unlinked mods may need bundled copies.
- Provide auto-detect and source-edit actions in the creator/advanced context.

FAQ/help topics must include:

- Why beta mod updates may require switching STS2 beta branches.
- What **Skip this update** does.
- What **Freeze** does.
- Why source links matter.
- Why Nexus-only mods may require manual download.
- What happens to bundled mods when sharing.

## Help

Use **Help** as the navigation label.

Help should include:

- Player quick start.
- Creator quick start.
- FAQ.
- Troubleshooting.
- Short explanations reused by contextual help panels.

The existing Tutorial view can be renamed and reorganized instead of rebuilt from scratch. It should be secondary to organic guidance, not the only way to learn.

Contextual help should appear in confusing places as small links or panels such as:

- “What does stored mean?”
- “Why do I need GitHub to share?”
- “Why is this update blocked?”
- “Why is this mod not in my modpack?”

## Advanced Disclosure

Power-user actions should be available but less prominent:

- Repair mod.
- Roll back one version.
- Edit sources and manager-only metadata.
- Import/export raw JSON.
- Bulk destructive actions.
- Open raw folders/logs.
- Advanced update and diagnostic tools.

Advanced does not mean hidden forever. It means shown from the task that needs it, with clear warnings and confirmation where appropriate.

## Responsive Requirements

The app is a resizable desktop window. Every updated surface must work at wide, medium, and narrow widths.

Wide windows:

- May use side-by-side task and help panels.
- May show richer metadata inline.

Medium windows:

- Keep primary actions visible.
- Move secondary actions into menus or collapsible panels.
- Wrap toolbars cleanly.

Narrow windows:

- Stack content.
- Use full-width primary actions where useful.
- Shorten labels or use icon buttons with tooltips.
- Avoid horizontal scrolling for core workflows.

All sizes:

- Long modpack names, mod names, paths, and share codes must truncate cleanly.
- Buttons must not overflow their containers.
- Onboarding, create-modpack, share setup, Mod Library, audit, and modal layouts must remain usable.

Verification should include screenshots or visual checks at representative wide, laptop, and narrow window sizes.

## Consistency Pass

While implementing the above, clean up inconsistency only where it serves the 1.7 goal.

Targets:

- Standardize action placement across Home, Modpacks, All installed mods, Audit, and Share setup.
- Replace one-off inline button styles with existing button variants where feasible.
- Keep badge naming, warning color, update pills, and disabled states consistent.
- Prefer the same empty-state pattern for “no modpacks,” “no installed mods,” and “no audit yet.”
- Use the same Help/FAQ wording in onboarding, contextual panels, and Help pages.

Avoid unrelated visual redesigns.

## Testing and Regression Strategy

Use test-first changes for behavior and UI flows.

Required coverage areas:

- `Profile` to `Modpack` language conversions in major views.
- Create modpack flow for local creation without GitHub.
- Share setup introduces GitHub only at share time.
- Publishing still uses selected modpack membership, not every installed mod.
- Mod Library large count behavior remains bounded.
- Membership toggles preserve scroll/focus as much as practical.
- All installed mods clearly identifies storage state vs modpack membership.
- Help/FAQ renders player and creator topics.
- i18n parity with Simplified Chinese.

Run:

- `npm run qa:i18n`
- Focused Vitest suites for changed views/components.
- Broader `npx vitest run` when the UI changes are integrated.
- Rust tests only if command behavior changes.

## Non-Goals

- Do not change the app's visual theme.
- Do not remove working features just to make the UI smaller.
- Do not require GitHub for local modpack creation.
- Do not rename internal storage/command APIs unless needed and covered by migration tests.
- Do not build a marketing-style landing page.
- Do not replace in-app guidance with an external video.

## Open Decisions

- Whether Browse Mods and Browse Modpacks should remain separate in 1.7.0 or be grouped under Browse with internal tabs.
- Whether source tags should remain advanced-only or become a simple creator organization tool.
- Whether Load Order should be a normal Modpack action or an advanced action.
- Whether the current Tutorial route should be renamed in code now or only user-facing labels should change to Help.
