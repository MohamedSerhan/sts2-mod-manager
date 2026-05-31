# Design brief — Modpack detail view: declutter the action area

## What this is

STS2 Mod Manager is a desktop app (Tauri + React) for managing Slay the
Spire 2 mods. A **modpack** is a named, ordered set of mods. The **modpack
detail view** is the page you land on after clicking a modpack — it shows
that pack's mods and the actions for managing them.

That view has accumulated too many buttons and now reads as a wall of
controls. **We need a clean layout for its header + action area.** The mod
*rows* themselves are being fixed separately — focus on the area above the
list.

## The problem (current state)

Top to bottom, the view currently stacks four rows of controls before you
even see a mod:

1. **Header:** `← Back to modpacks` · **Pack name** · `SHARED` badge · `▶ Switch to` · `⚹ Re-share` · `⋯`
2. **Toolbar:** `📂 Open folder` · `⬆ Import mod` · `🔗 Quick add URL` · `🔎 Auto-detect sources` · `☑ Audit mods` · `🔄 Refresh`
3. **Section line:** `In this modpack (20)` · `✎ Edit` · `≣ Load order` · `🗑 Delete all`
4. **Filter line:** search box · "No unused active mods" · `Sort ▾`

That's ~14 controls competing for attention. It overwhelms and confuses.

## What we need from you

A clean, calm layout for the **header + action area** of this view that:

- Establishes a clear visual hierarchy: the pack identity + the one or two
  primary actions stand out; everything else recedes (grouped menus,
  overflow, or a secondary row).
- Keeps **every** action below reachable (they can live in dropdowns /
  overflow menus — they don't all need to be top-level buttons).
- Stays consistent with the rest of the app (same components, spacing,
  tone). The **All Mods** view has a similar toolbar; ideally the two feel
  like siblings.

Deliverable: an annotated layout/wireframe showing where each action goes
(top-level vs. grouped vs. overflow), plus any spacing/grouping notes.

## The actions that must stay reachable

**Pack-level (identity + whole-pack operations):**
- Back to modpacks
- Switch to (activate this pack in the game) — *primary action*
- Share / Re-share
- Snapshot from current install
- Duplicate
- Export JSON
- Repair (only shown when the pack has drifted from disk)
- Delete modpack (destructive)

**Mod-management (acting on this pack's mod list):**
- Add mods, via any of: Quick add URL · Import from file · Open mods folder · Auto-detect sources *(these four are variations on "get a mod in" — strong candidates to collapse into one "Add mods ▾" control)*
- Edit (opens a checkbox picker to bulk add/remove mods)
- Load order (opens a reorder modal — this is the only way to reorder)
- Audit this pack (checks the pack's mods for updates)
- Refresh
- Delete all in pack (destructive, pack-scoped)

**Always visible:** the "In this modpack (N)" count + a search box over the
pack's mods.

## Hard constraints — keep the theme & colors

Use the existing design tokens and components. **Do not introduce new
colors, fonts, or button styles.**

**Color tokens (CSS custom properties, oklch):**
- `--gf` gold `oklch(0.78 0.13 80)` — primary accent (the brand gold); `--gf-hov`, `--gf-ink` (text on gold)
- `--ok` green `oklch(0.74 0.11 165)` — success / active
- `--warn` amber `oklch(0.78 0.13 75)` — warnings / drift
- `--danger` red `oklch(0.65 0.18 25)` — destructive
- Surfaces (dark indigo): `--indigo-bg` `0.16`, `--indigo-top` `0.14`, `--indigo-panel` `0.20`, `--indigo-elev` `0.24`, `--indigo-deep` `0.10`, `--indigo-line` `0.28` (all hue 280)
- Text: `--ink` `0.92`, `--ink-mute` `0.72`, `--ink-dim` `0.55`

**Button styles (existing classes):**
- `.gf-btn` — primary, filled gold (use sparingly: 1 primary per zone, e.g. "Switch to")
- `.gf-btn-2` — secondary, slate fill
- `.gf-btn-3` — tertiary / ghost
- Kebab/overflow menus already exist (`KebabMenu`) for grouped actions.

**Other rules:**
- **Every button must have a text label — no icon-only buttons.** Icons are fine *alongside* text.
- Rounded corners ~6–8px; system font stack; dark theme throughout.
- It must look at home next to the existing All Mods toolbar.

## Out of scope (handled separately)

- The mod **row** design (toggle, badges, kebab, remove). We're already
  moving source/audit tags next to the mod name and reworking the
  remove/delete affordance.
- Sorting (being removed from this view — the list always shows load order).
- The "In Modpack" per-row badge (being removed — redundant here).
