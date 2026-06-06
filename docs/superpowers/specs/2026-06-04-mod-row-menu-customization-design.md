# Mod-row ⋯ menu — cleanup, double-`v` fix, and customization

Resolves [#134](https://github.com/MohamedSerhan/sts2-mod-manager/issues/134). Supersedes
[#123](https://github.com/MohamedSerhan/sts2-mod-manager/issues/123) (Freeze item too high — the
user can now move it themselves). New strings tracked for translation in
[#132](https://github.com/MohamedSerhan/sts2-mod-manager/issues/132).

## Purpose

One agent owns the per-mod row ⋯ (kebab) menu in `LibraryRow.tsx`. Three changes, smallest →
largest:

1. **Remove the legacy "Edit sources…" kebab item.** Clicking the row already opens the same
   inline `SourceEditor` (`LibraryRow.tsx:310`), so the menu item is redundant. Maintainer
   confirmed it only survived for legacy reasons.
2. **Fix the Copy-version double-`v` (`vv1.0.7`).** Two display strings hardcode a `v` prefix
   while `mod.version` *sometimes* already starts with `v`. Normalize the interpolated value.
3. **Add ⋯-menu customization** — let users **show/hide** items and **reorder** them via
   drag-and-drop, reached from Settings and from a "Customize menu…" entry in the menu itself.
   This is the big piece.

## Design guardrails

- Not a visual redesign. Reuse existing primitives (`Card`, `Button`, `Toggle`, `KebabMenu`/
  `KebabItem`/`KebabDivider`, lucide icons). New CSS goes in `src/styles.css`.
- Persistence mirrors the **theme pattern**: a pure `*.ts` module with `localStorage` load/save +
  a React Context provider (see `src/theme/theme.ts` + `src/theme/ThemeContext.tsx`).
- All user-visible strings go through `react-i18next`. **Every new key must be added to all four
  locales** (`en`, `zh-Hans`, `ru`, `ar`) with genuine (non-English) translations — the
  `src/i18n/locales/parity.test.ts` gate fails on key-set drift *and* on copied-English prose.
- Non-customized behavior is unchanged: a fresh install shows the same items, in a sensible
  default order, with no extra configuration required.
- Coverage gate is 96/96/90 (statements/branches/functions per the release gate). New logic must
  be tested; pure helpers carry the testable weight so DnD wiring stays thin.

---

## Task 1 — remove the legacy "Edit sources…" item

`LibraryRowKebab` (`src/components/LibraryRow.tsx`) currently renders, inside the `Sources`
section:

```tsx
<KebabItem icon={<LinkIcon size={12} />} onClick={onEditSources}>
  {t('mods.editSources')}
</KebabItem>
```

**Change:** delete this `KebabItem`. The `onEditSources` callback prop stays (the whole row still
calls it on click/Enter — `LibraryRow.tsx:310,323`, and the strings `mods.rowEditSourcesAria` /
`mods.rowClickEditSources` continue to describe that row-click affordance).

**Orphaned key:** `mods.editSources` becomes unused after this change. It is **left in place** in
all four locales — the parity gate only compares locales to each other (it does not flag
code-unused keys), so leaving it is zero-risk and avoids four-file churn. (Removing it is optional
cleanup, out of scope here.) The same applies to the section-head keys `mods.sources` and
`mods.recovery`, which the flat menu (Task 2) stops using.

**Test impact:** remove `LibraryRow.test.tsx`'s `kebab → Edit sources fires onEditSources` test
(line ~441). Row-click → `onEditSources` is already covered elsewhere in that file.

---

## Task 2 — ⋯-menu customization

### Item inventory

After Task 1 removes "Edit sources", the kebab exposes these actions. Each has a stable id, a
**contextual availability** predicate (when it can render at all), and a default position:

| id            | Label (en)                         | Available when                                   | Customizable |
|---------------|------------------------------------|--------------------------------------------------|--------------|
| `membership`  | Add/Remove from `<pack>`           | `!packScoped && modpackName && membershipChip`   | yes          |
| `copyVersion` | Copy version (v…)                  | always                                           | yes          |
| `openFolder`  | Open this mod's folder             | always                                           | yes          |
| `snooze`      | Snooze/Unsnooze update             | `audit.snoozed` OR (`needs_update` + a tag)      | yes          |
| `autoDetect`  | Auto-detect source                 | always                                           | yes          |
| `viewGithub`  | View on GitHub                     | `mod.github_url`                                 | yes          |
| `viewNexus`   | View on Nexus                      | `mod.nexus_url`                                  | yes          |
| `findGithub`  | Find GitHub from Nexus             | `mod.nexus_url && !mod.github_url`               | yes          |
| `freeze`      | Freeze/Unfreeze this mod (pin)     | always                                           | yes          |
| `repair`      | Repair this mod                    | always (disabled w/o source / while busy)        | yes          |
| `rollback`    | Roll back one version              | always (disabled w/o source / while busy)        | yes          |
| `delete`      | Delete from disk                   | `packScoped`                                     | **LOCKED**   |
| `customize`   | Customize menu…                    | always                                           | **LOCKED**   |

- **Customizable set (11):** everything except `delete` and `customize`.
- **`delete`** (the only destructive kebab action — note "Remove from pack" is a *visible row
  button*, never in the kebab) is **pinned to the bottom, non-hideable, non-reorderable**. This
  keeps the only disk-delete affordance from being hidden or shuffled under the cursor.
- **`customize`** is a meta footer item: **always present, always last**, after `delete`.

### Default order — Freeze moved down

The default flat order (resolving #123 by demoting Freeze from its current 2nd slot):

```
membership, copyVersion, openFolder, snooze, autoDetect,
viewGithub, viewNexus, findGithub, freeze, repair, rollback
```

…then the locked tail: `delete` (if `packScoped`) → `customize`. The exact `freeze` slot is a
one-line default and users can re-drag it; placing it just above the recovery pair reads as
"lower, but not buried."

### Data model — `src/lib/rowMenuConfig.ts` (pure, no React)

```ts
export const ROW_MENU_STORAGE_KEY = 'sts2mm-row-menu';

export type RowMenuItemId =
  | 'membership' | 'copyVersion' | 'openFolder' | 'snooze' | 'autoDetect'
  | 'viewGithub' | 'viewNexus' | 'findGithub' | 'freeze' | 'repair' | 'rollback';

/** Locked ids are intentionally NOT part of this union. */
export const DEFAULT_ROW_MENU_ORDER: readonly RowMenuItemId[] = [
  'membership', 'copyVersion', 'openFolder', 'snooze', 'autoDetect',
  'viewGithub', 'viewNexus', 'findGithub', 'freeze', 'repair', 'rollback',
];

export interface RowMenuConfig {
  order: RowMenuItemId[];   // every known id, exactly once
  hidden: RowMenuItemId[];  // subset the user has hidden
}

export const DEFAULT_ROW_MENU_CONFIG: RowMenuConfig;
```

Pure helpers (all unit-tested):

- `normalizeConfig(raw: unknown): RowMenuConfig` — the resilience boundary. Drops unknown/locked
  ids, de-dupes, then **appends any known id missing from `order`** in default-order position
  (so a future release that adds a new item shows it rather than silently hiding it). Clamps
  `hidden` to known ids. Returns a fresh valid config for any malformed input.
- `loadRowMenuConfig(storage?) / saveRowMenuConfig(config, storage?)` — `localStorage` JSON
  round-trip, both wrapped in try/catch (a blocked/again-quota storage must never crash the row),
  exactly like `theme.ts`.
- `moveItem(order, fromIndex, toIndex): RowMenuItemId[]` — immutable array move for DnD reorder.
- `toggleHidden(config, id): RowMenuConfig` — flip an id's hidden state (locked ids are no-ops).
- `resolveRowMenuOrder(config, availableIds: Set<RowMenuItemId>): RowMenuItemId[]` — the render
  contract: `config.order` filtered to ids that are **available for this mod** AND **not hidden**.

The config is **global** — one menu layout for every row everywhere (All-Mods and Modpack views).
Per-row differences are handled entirely by the availability predicates, not by per-row config.

### State — `src/contexts/RowMenuContext.tsx`

A `RowMenuProvider` + `useRowMenu()` hook mirroring `ThemeContext`:

```ts
interface RowMenuContextValue {
  config: RowMenuConfig;
  setOrder(order: RowMenuItemId[]): void;   // persists
  toggleHidden(id: RowMenuItemId): void;     // persists
  reset(): void;                             // back to DEFAULT_ROW_MENU_CONFIG
}
```

Initialize from `loadRowMenuConfig()`; persist via `saveRowMenuConfig` in an effect on change.
Wire `<RowMenuProvider>` into `App.tsx` next to `ThemeProvider` (outermost is fine — it has no
dependency on Toast/Confirm/App data).

### Kebab refactor — `LibraryRow.tsx`

Convert `LibraryRowKebab`'s hardcoded conditional JSX into a **descriptor-driven** render:

```ts
// Built inside LibraryRowKebab from props (so each render() closes over the
// right callbacks/labels). Locked ids live in their own constants.
type KebabDescriptor = {
  available: boolean;            // contextual predicate for THIS mod
  render: () => ReactNode;       // a <KebabItem …>
};
const descriptors: Record<RowMenuItemId, KebabDescriptor> = { … };
```

Render flow:

1. `const available = new Set(ids where descriptors[id].available)`.
2. `const ordered = resolveRowMenuOrder(config, available)` (from `useRowMenu()`).
3. Render `ordered.map(id => descriptors[id].render())` as a **flat list — no section headers**
   (the `Sources`/`Recovery` heads are dropped; the flat order subsumes grouping).
4. If `packScoped`: a `<KebabDivider/>` + the locked **Delete from disk** danger item.
5. Always: a `<KebabDivider/>` + the locked **Customize menu…** footer item.

Per-item `description` secondary lines (the plain-language hints) are preserved in each `render()`.
Label/icon state that flips with mod state (Freeze↔Unfreeze, Snooze↔Unsnooze, Add↔Remove) stays
inside that item's `render()`.

If `useRowMenu()` is somehow unavailable (e.g. a test renders the row without the provider), the
hook falls back to `DEFAULT_ROW_MENU_CONFIG` so the menu always renders. (We still add the provider
to the shared test wrapper — see Testing.)

### Settings customizer — `src/components/RowMenuCustomizer.tsx`

A new `<Card>` rendered in **Settings → General** (under Theme, since it's a UI/appearance
preference). Contents:

- A short title + description (`settings.rowMenu.title` / `.desc`).
- The **11 customizable items** in `config.order`, each row: a **drag handle** (`GripVertical`),
  the item's icon + label, and a **show/hide `Toggle`** on the right. Hidden rows render dimmed.
- **Reorder** by native HTML5 drag-and-drop, mirroring the load-order pattern already in
  `LibraryTable`/`LibraryRow` (`draggable`, `onDragStart/Over/Drop`, drop → `moveItem` →
  `setOrder`). **No new dependency.**
- Below a divider: the **locked items** (`Delete from disk`, `Customize menu…`) shown as disabled
  rows with a small "always pinned to the bottom" caption — so the user understands why they
  aren't draggable.
- A **"Reset to default"** `Button` → `reset()`.

The same icons used in the kebab are reused here (imported from lucide), so the Settings list reads
as a faithful preview of the menu.

### Navigation deep-link — "Customize menu…" → Settings

The kebab is four levels below `AppInner` (`ModsView → LibraryTable → LibraryRow →
LibraryRowKebab`). Rather than prop-drill a navigation callback through all of them for a *global*
action, use a window `CustomEvent` (lightweight intra-app pub/sub; the app already leans on
event-driven wiring):

- **Kebab** "Customize menu…" `onClick` → `window.dispatchEvent(new CustomEvent(ROW_MENU_OPEN_EVENT))`
  (`KebabItem` closes the popover first, then runs onClick).
- **`AppInner`** adds a `useEffect` listening for `ROW_MENU_OPEN_EVENT` → `setActiveView('settings')`
  + bump a new `openRowMenuSettingsSignal` (the same one-shot counter pattern as
  `openActiveModpackSignal` / `focusModpacksCodeBarSignal`).
- **`SettingsView`** gains an `openRowMenuSettingsSignal?: number` prop. On bump: select the
  `general` tab, then `scrollIntoView` the customizer card (held via a `ref`) and toggle a brief
  highlight class on it. This follows the same one-shot-signal convention as the Quick-Add focus
  pump, but the scroll + highlight is a few lines local to `SettingsView` (no shared component).

`ROW_MENU_OPEN_EVENT = 'sts2mm:open-row-menu-settings'` is exported from `rowMenuConfig.ts` so both
ends share the constant.

---

## Task 3 — Copy-version double-`v`

Root cause: two strings hardcode a literal `v`, and `mod.version` is inconsistent (some manifests
ship `v1.0.7`, some `1.0.7`):

- `mods.copyVersion` = `"Copy version (v{{version}})"` — the menu **label** (`LibraryRow.tsx:827`).
- `mods.toast.versionCopied` = `"Copied v{{version}}"` — the **toast** after copying
  (`useModLibrary.tsx:426`). Same bug; fixed together so the whole flow is consistent.

**Fix:** strip a leading `v` from the interpolated value at both sites (the existing house idiom in
this file, e.g. `LibraryRow.tsx:469,528`):

```ts
// LibraryRow.tsx:827
{t('mods.copyVersion', { version: mod.version.replace(/^v/i, '') })}
// useModLibrary.tsx:426
t('mods.toast.versionCopied', { version: mod.version.replace(/^v/i, '') })
```

- Locale strings are **unchanged** — they keep their literal `v` (so the display still reads
  `v1.0.7`). Fixing the value, not the templates, means **no four-locale edit** and covers all
  languages at once.
- **Clipboard content is unchanged** — `copyToClipboard(mod.version, …)` still copies the raw
  manifest version. Least-surprise: we're fixing a doubled-`v` *display* bug, not redefining what
  lands on the clipboard.

---

## Files touched

**New**
- `src/lib/rowMenuConfig.ts` — pure model + helpers + event constant.
- `src/lib/rowMenuConfig.test.ts` — helper unit tests.
- `src/contexts/RowMenuContext.tsx` — provider + hook.
- `src/components/RowMenuCustomizer.tsx` — Settings card.
- `src/components/RowMenuCustomizer.test.tsx` — component tests.

**Modified**
- `src/components/LibraryRow.tsx` — remove Edit-sources item; descriptor-driven flat kebab +
  locked Delete/Customize; double-`v` label fix; consume `useRowMenu()`.
- `src/components/LibraryRow.test.tsx` — drop Edit-sources test; add order/hide/lock/availability
  tests; assert single-`v` label.
- `src/hooks/useModLibrary.tsx` — double-`v` toast fix.
- `src/views/Settings.tsx` — render `<RowMenuCustomizer/>` in General; accept + honor
  `openRowMenuSettingsSignal`.
- `src/App.tsx` — `<RowMenuProvider>`; `ROW_MENU_OPEN_EVENT` listener; `openRowMenuSettingsSignal`
  state → `SettingsView`.
- `src/i18n/locales/{en,zh-Hans,ru,ar}.json` — new strings (customizer card, item labels for the
  Settings list, "Customize menu…", reset, locked caption), in all four locales.
- `src/styles.css` — customizer list + drag-handle + locked-row + highlight-pulse styles.

## Testing strategy (96/96/90)

- **`rowMenuConfig.test.ts`** — `normalizeConfig` (unknown/locked/duplicate/missing-id append,
  malformed input), `moveItem`, `toggleHidden` (incl. locked no-op), `resolveRowMenuOrder`
  (hidden + availability filtering), load/save round-trip incl. storage-throws fallback.
- **`LibraryRow.test.tsx`** — default order renders; a hidden id is absent; a reordered config
  reorders the DOM; `delete` stays last + non-hideable; `customize` always present + last;
  contextual items hide when their predicate is false (no `github_url`, etc.); Copy-version label
  shows a single `v` for both `1.0.7` and `v1.0.7`; "Customize menu…" dispatches the event.
- **`RowMenuCustomizer.test.tsx`** — toggling hide updates config; drag (`fireEvent.dragStart/
  dragOver/drop` with a `dataTransfer` stub, like the load-order tests) reorders; Reset restores
  default; locked rows are disabled.
- **`Settings.test.tsx` / `App.test.tsx`** — signal/event wiring: dispatching `ROW_MENU_OPEN_EVENT`
  routes to Settings → General and surfaces the card.
- Add `RowMenuProvider` to the shared test wrapper (`src/__test__` / `AllProviders`) so existing
  row/table tests keep rendering with a real provider.

## Out of scope

- Per-view or per-mod menu layouts (one global config only).
- Changing what the Copy-version action writes to the clipboard.
- Removing orphaned locale keys (`mods.editSources`, `mods.sources`, `mods.recovery`).
- Customizing menus other than the mod row's (profile kebab, etc. unchanged).
