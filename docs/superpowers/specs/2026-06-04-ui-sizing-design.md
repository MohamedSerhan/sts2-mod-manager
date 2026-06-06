# UI Sizing: Resizable Sidebar + Adjustable UI Scale Design

Resolves [#119](https://github.com/MohamedSerhan/sts2-mod-manager/issues/119) (folds #118).
Source: feature requests from **Saccharin** on Nexus, relayed by the maintainer.

## Goal

Two UI-sizing controls, both persisted across restarts:

1. The left nav sidebar is **user-resizable** by dragging, and a little wider by
   default — so long (e.g. Chinese) nav labels stop truncating.
2. A Settings control adjusts overall **UI scale** (text *and* layout grow
   together), so users who need larger text get it without the layout breaking.

Both ship translated for every locale and verified in light + dark.

## Product Behavior

### Resizable sidebar
- The sidebar default width is **248px** (up from 230px).
- A drag handle on the sidebar's inner edge lets the user resize it; width is
  clamped to **200–420px**.
- The chosen width **persists** (localStorage, `sts2mm-sidebar-width`) and is
  restored on next launch, re-clamped on load.
- The handle is keyboard-accessible (focusable `role="separator"`; ←/→ adjust by
  16px) and **double-click resets** to the 248px default.
- Direction-aware: in RTL (Arabic) the handle sits on the mirrored edge and drag
  direction is flipped.

### Adjustable UI scale
- Settings → General gains a **Display size** card with a slider.
- Range **80%–150%**, step **5%**, default **100%**, with a live `NN%` readout
  and a **Reset to 100%** button.
- Changing it scales the whole interface immediately; the value **persists**
  (localStorage, `sts2mm-ui-scale`) and is re-applied on launch, clamped on load.

## Architecture

Mirror the existing **theme** system (`src/theme/`), which is the proven pattern
for "a persisted preference applied to the DOM": a pure logic module + a context
provider that applies on change + a Settings control, all heavily unit-tested.

| New file | Mirrors | Responsibility |
|---|---|---|
| `src/display/uiScale.ts` | `theme/theme.ts` | Storage key, `DEFAULT`/`MIN`/`MAX`/`STEP`, `clampUiScale`, `loadUiScale`, `saveUiScale`, `applyUiScale`. Pure + DOM apply; no Tauri. |
| `src/display/UiScaleContext.tsx` | `theme/ThemeContext.tsx` | `UiScaleProvider` — holds the factor, applies + persists on every change, applies once on mount. `useUiScale()` hook. |
| `src/components/UiScaleSlider.tsx` | `components/ThemeSelect.tsx` | The `<input type="range">` + `%` readout + Reset button. |
| `src/display/sidebarWidth.ts` | `theme/theme.ts` | Storage key, `DEFAULT`/`MIN`/`MAX`/`STEP`, `clampSidebarWidth`, `loadSidebarWidth`, `saveSidebarWidth`. Pure. |
| `src/hooks/useResizableSidebar.ts` | (net-new) | Owns width state (init from `loadSidebarWidth`), exposes `width`, handle event props (mouse + keyboard), reset, and persists on commit. |
| `src/components/SidebarResizeHandle.tsx` | (net-new) | The `role="separator"` element wired to the hook. |

Wiring:
- `<UiScaleProvider>` is added to the App provider stack in `src/App.tsx`
  (alongside `ThemeProvider`), and `src/__test__/providers.tsx` (`AllProviders`).
- Sidebar width is local to `AppInner` via `useResizableSidebar()` — only the
  layout consumes it, so no global context is introduced.

### UI scale mechanism — CSS `zoom` (page zoom)

`applyUiScale(factor)` sets `document.documentElement.style.zoom = String(factor)`
(and clears it for `1`). This is the industry-standard "scale the whole UI"
model (browsers, Discord's in-app zoom): text and layout grow uniformly, which is
required because the UI uses ~100 hardcoded px font sizes (`src/styles.css`) and
`body` has no base `font-size` — a per-element or rem rewrite would be a large,
risky diff. Applying at the document root also scales the in-tree overlays
(toasts, confirm modals, dropzone); nothing portals to `body`, so none escape.

The apply is a synchronous one-liner — the exact parallel to `applyTheme` — and
is fully unit-testable in jsdom. **Decision (maintainer-approved):** use CSS
`zoom`, not Tauri's native `getCurrentWebview().setZoom()`. Native webview zoom is
equally "standard" but is async, needs a new `core:webview:allow-set-webview-zoom`
capability, and is not unit-testable in jsdom. If a webview engine ever mishandles
root `zoom`, only `applyUiScale` needs to change (swap to native `setZoom`).

### Sidebar resize mechanism

`.gf-sidebar` width becomes `var(--gf-sidebar-width, 248px)`; the hook sets the
custom property (e.g. on the sidebar element) from React state. The existing
`.gf-resize-handle`s are Tauri **window**-edge handles (`startResizeDragging`) and
are not reusable here, so the splitter is net-new JS:
- `mousedown` on the handle records start X + start width and attaches
  `mousemove`/`mouseup` to `document`; `mouseup` detaches and persists.
- `width = clampSidebarWidth(start + dx * dir)`, where `dir` is `-1` in RTL.
- During drag, `document.body` gets `user-select: none` + a `col-resize` cursor.
- Keyboard: ←/→ on the focused handle nudge by `STEP` (16px), RTL-aware; values
  exposed via `aria-valuenow/min/max`. Double-click resets to default.
- The handle lives at the sidebar's inline-end edge and is nowhere near the
  window-edge resize handles, so there is no hit-area conflict.

## UI

- Settings → General: a new **Display size** `<Card>` (lucide `ALargeSmall` icon)
  holding `<UiScaleSlider>`, placed near the Language/Theme cards in
  `src/views/Settings.tsx`.
- Sidebar: the drag handle is a thin (~6px) hover-highlighted strip on the
  sidebar's inner edge; no Settings control for width (drag-only, per decision).

## Internationalization

All new strings are added to **en, zh-Hans, ru, ar** with genuine translations
(the parity test fails on missing keys *and* on copied English). New keys:

- `settings.display.label` — card heading ("Display size")
- `settings.display.desc` — one-line description
- `settings.display.scaleLabel` — slider aria-label ("Interface scale")
- `settings.display.value` — `"{{percent}}%"` readout
- `settings.display.reset` — "Reset to 100%"
- `app.sidebar.resizeLabel` — separator aria-label ("Resize sidebar")

zh-Hans wording gets particular care (the original reporter is the Chinese user).
Arabic is verified in RTL (sidebar handle side + drag direction; see
`src/i18n/direction.test.ts`).

## Quality Gates

- `npm run build` keeps TypeScript checking (`tsc && vite build`).
- `npm run qa:unit` passes, including new suites:
  - `uiScale.test.ts` and `sidebarWidth.test.ts` mirror `theme.test.ts`: clamp,
    round-trip, invalid/NaN value, hostile storage (throwing `getItem`/`setItem`),
    absent `localStorage`, and (for uiScale) no-`document` apply guard.
  - `UiScaleContext` applies on mount + on change and persists; `UiScaleSlider`
    moves → updates → persists, and Reset returns to 100%.
  - Sidebar: drag (mousedown→move→up) changes width, persists, and clamps;
    keyboard ←/→ adjust; double-click resets; RTL flips direction.
  - Tests use loud queries and always assert visible behavior — no
    `if (el) { ... }` silent-skip branches.
- Locale **key parity** holds across en/zh-Hans/ru/ar, and non-English values are
  real translations (not copied English).
- Manual verification: light + dark themes at both extremes (80% / 150% scale,
  200px / 420px width) — sidebar, tables, and modals stay usable; nav labels fit.
