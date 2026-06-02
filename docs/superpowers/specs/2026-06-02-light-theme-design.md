# Light theme for STS2 Mod Manager — design

- **Date:** 2026-06-02
- **Status:** Approved (brainstorming) → ready for implementation plan
- **Scope:** Frontend (`src/`). One cohesive PR.

## Context & goal

The app is currently **dark-only**. We want a fully working **light theme**
alongside the existing dark one, user-selectable in Settings, persisted across
launches, with an **Auto** option that follows the OS. Dark stays the default.

The blocker is that color is only partly tokenized: ~37 design tokens exist in
`src/styles.css` (a Tailwind `@theme` block of 14 `--color-*` tokens, plus a
`:root` block of ~21 raw tokens used by `.gf-*` utility classes), **but** ~154
hardcoded `oklch(...)` literals live directly in `styles.css` and ~40 more are
inline in JSX `style` props across ~12 components. Those literals will not
re-theme. Migrating them onto tokens is the bulk of the work.

## Assumptions & scope

- **No pending PRs.** `gh pr list` is empty; only `en.json` and `zh-Hans.json`
  exist. PR1/PR2/PR3 are not open, so there is nothing to rebase behind. Build
  on current `main`. Target **en + zh-Hans** only. If `ru/ar` land later the
  i18n parity test will flag the new keys and they get added then.
- **Single PR**, large diff acceptable (AGENTS.md: maintainer prefers single-PR
  landings for cohesive features).
- **Control:** a `<select>` dropdown with Auto / Dark / Light, mirroring the
  existing `LanguageSelect`.

## Non-goals

- No redesign of the dark theme's look. Dark output must be **pixel-identical**
  after migration (literals → equivalent tokens).
- No refactor of inline `style` callouts into new `.gf-*` classes. We retarget
  the color *values* to tokens and leave layout structure alone. (A future
  `.gf-callout` extraction is possible but out of scope — it would balloon the
  diff and risk regressions; theming is the goal.)
- No new third-party styling deps. CSS stays in `styles.css`; inline `style`
  props (already pervasive) are fine to reference CSS vars.

## Architecture

Mirror the language-preference pattern (`src/i18n/language.ts` +
`src/i18n/index.ts` + `LanguageSelect.tsx`).

### Theme module — `src/theme/`

`theme.ts` (structural twin of `language.ts`):

- `THEME_STORAGE_KEY = 'sts2mm-theme'`
- `DEFAULT_THEME_PREFERENCE = 'dark'`
- `SUPPORTED_THEMES = [{ value: 'dark' }, { value: 'light' }]`
- `type ThemeMode = 'dark' | 'light'`
- `type ThemePreference = ThemeMode | 'auto'`
- `isSupportedThemePreference(v): v is ThemePreference`
- `loadThemePreference(storage?) / saveThemePreference(pref, storage?)` — same
  `getStorage()` try/catch as `language.ts` (blocked storage must not crash).
- `resolveThemePreference(pref): ThemeMode` — `'auto'` reads
  `matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'`,
  **guarded** for environments without `matchMedia` (jsdom); otherwise returns
  the literal mode.
- `applyTheme(mode)` — sets `document.documentElement.dataset.theme = mode`.

`ThemeContext.tsx`:

- `ThemeProvider` holds `preference` state (init `loadThemePreference()`),
  exposes `{ preference, mode, setPreference }` via `useTheme()`.
- On mount and whenever `preference` changes: `applyTheme(resolveThemePreference(preference))`
  and `saveThemePreference(preference)`.
- **Only while `preference === 'auto'`**, subscribe to the `matchMedia` change
  event and re-apply, so an OS light/dark flip is live. Clean up on unmount /
  preference change. Guard `matchMedia` existence.

### Provider mounting — `src/App.tsx`

Wrap the existing tree in `<ThemeProvider>` as the **outermost** provider
(above `ToastProvider`). It only manages the `data-theme` attribute + storage;
nothing else depends on it except `ThemeSelect`.

### No-flash startup — `index.html`

Add a tiny **inline** script that runs before first paint:

```html
<script>
  try {
    var p = localStorage.getItem('sts2mm-theme');
    var m = p === 'light' ? 'light'
      : p === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
      : 'dark';
    document.documentElement.dataset.theme = m;
  } catch (e) { document.documentElement.dataset.theme = 'dark'; }
</script>
```

This guarantees `data-theme` is **always present before CSS resolves**, which is
what makes scoping the dark tokens under `:root[data-theme="dark"]` safe (tokens
never resolve to undefined). `ThemeProvider` reconciles at runtime; the storage
key string is duplicated here intentionally (pre-bundle, can't import).

## Token model & migration (the bulk)

### Restructure

- Move the existing raw `.gf-*` token definitions into `:root[data-theme="dark"]`
  and add a parallel `:root[data-theme="light"]` block overriding the same names.
- **Tailwind `@theme` tokens** (`--color-*`): Tailwind v4 emits these as custom
  properties on `:root` (their `@theme` literals stay the **dark** values and act
  as the always-present default), and its utilities reference them by `var()`
  (`bg-surface` → `background-color: var(--color-surface)`). So they are made
  theme-reactive by **overriding the same `--color-*` names inside
  `:root[data-theme="light"]`** — the override cascades into every generated
  utility. Dark values are also restated under `:root[data-theme="dark"]` so an
  explicit/auto-resolved dark selection is unambiguous. (No `@theme` value needs
  to be a `var()` reference; we override the emitted properties, not the
  `@theme` block.)
- Add `--app-color-scheme: dark|light` per block; replace the three hardcoded
  `color-scheme: dark` (styles.css `:37`, `:1519`, `:2416`) with
  `color-scheme: var(--app-color-scheme)`.

### Tokenize by semantic role, not per-literal

The 115 distinct CSS values + 29 distinct component values collapse into ~7 hue
families at a few lightness/alpha steps:

| Family | Hue | Roles |
| --- | --- | --- |
| Indigo neutrals | 250–285 | bg, sidebar, topbar, panel, elev, deep, border(s), text x3 |
| Gold (`gf`) | 70–85 | primary CTA, hover, ink, tint, line |
| Ember | 50–60 | state accent, tint, line |
| Danger | 25 | base, hover, **tint/line/text** (heavy callout use) |
| Success | 145–165 | base, **tint/line/text** |
| Info / blue | 250 | **new family** — base/tint/line/text (PublishModal callouts; no token today) |
| Scrim | n/a | black/alpha modal overlays → `--scrim`, `--scrim-strong` |

Grow the set from ~37 to ~55–65 named tokens. The recurring inline pattern
— `background: <accent>/0.10; border: 1px solid <accent>/0.3; color: <accent-text>`
— is captured by adding a **tint / line / text triple** per accent
(`--danger-tint`, `--danger-line`, `--danger-text`, etc.).

### Apply the migration

- **styles.css (154 literals):** each → nearest semantic token. Recurring alpha
  tints become named tokens; rare one-offs use
  `color-mix(in oklch, var(--token) N%, transparent)`.
- **Components (~40 inline `oklch`, ~12 files):** replace just the color *value*
  with `var(--token)` inside the existing `style={{…}}`. Files: AutoDetectModal,
  BrowseDetail, ConfirmDialog, LibraryRow, OnboardingOverlay, ProfileSwitcher,
  PublishModal, QuickAddModal, SourceEditor, ToastContext, Browse, Settings.
- **Hex (~8 literals):** tokenize themeable ones (`#f59e0b` amber → warning).
  Leave genuinely-fixed brand colors (GitHub label `#fbca04` / `#1a1a1a`, Google
  `#8ab4f8`) as literals — reviewed in context.

**Dark-output invariant:** after migration, every token's *dark* value equals the
literal it replaced, so dark mode renders identically. Verified by reading the
diff and by visual QA against the current build.

## Light palette

Author a hand-tuned light value for every token in `:root[data-theme="light"]`.
Direction:

- **Surfaces:** cool-neutral off-white (retain a trace of the indigo hue,
  ~oklch 0.97–0.99 L), not pure `#fff`, so the app keeps its identity. Sidebar /
  topbar / panel / elevation step *down* slightly in lightness instead of up.
- **Text:** invert to near-black indigo (~0.20–0.30 L) for `--ink`, muted/dim
  step lighter.
- **Accents — re-tuned, not lightness-flipped:** a 0.78 L gold is invisible on
  white, so gold/ember drop ~0.10–0.15 L and shed ~0.02–0.04 chroma; danger /
  success / info darken to ~0.45–0.55 L for AA contrast. Tints stay low-alpha
  but now read over light.
- `--scrim` stays a dark translucent black (modal overlays dim regardless of
  theme).

No auto-inversion — every value is chosen and visually QA'd.

## Theme control UI

`src/components/ThemeSelect.tsx` — near-copy of `LanguageSelect.tsx`: a labeled
`<select className="gf-set-input">` with options Auto / Dark / Light, driven by
`useTheme()`. Mounted in **Settings → General** as a new `<Card>` immediately
after the Language card (`src/views/Settings.tsx:555`).

New i18n keys in **both** locales:

- `settings.theme.label` — "Theme" / 主题
- `settings.theme.dark` — "Dark" / 深色
- `settings.theme.light` — "Light" / 浅色
- `settings.theme.auto` — "Auto" / 自动

(Standard, conventional CN UI terms — not invented prose.)

## Files

**New**

- `src/theme/theme.ts`
- `src/theme/theme.test.ts`
- `src/theme/ThemeContext.tsx`
- `src/components/ThemeSelect.tsx`
- `src/components/ThemeSelect.test.tsx`

**Modified**

- `index.html` — pre-paint inline theme script.
- `src/App.tsx` — wrap in `<ThemeProvider>`. (Startup is covered by the inline
  script + provider, so `src/main.tsx` needs no change.)
- `src/styles.css` — token restructure, `--app-color-scheme`, 154-literal
  migration, expanded token set, full light palette.
- `src/views/Settings.tsx` — Theme card after Language card.
- `src/i18n/locales/en.json`, `src/i18n/locales/zh-Hans.json` — 4 new keys.
- ~12 component files — inline `oklch`/hex → `var(--token)`.

## Testing & Definition of Done

- `src/theme/theme.test.ts` — load/save round-trip, `resolveThemePreference`
  for dark/light/auto (auto via a mocked `matchMedia`), bad-storage safety.
- `src/components/ThemeSelect.test.tsx` — renders 3 options; selecting Light
  persists `sts2mm-theme=light` and sets `documentElement[data-theme]=light`;
  mirror the loud-lookup / always-assert style of `LanguageSelect.test.tsx`
  (no silent `if (btn)` skips).
- Confirm `src/test/setup.ts` provides a `matchMedia` mock; add one if missing.
- `npm run qa:unit` and `npm run qa:i18n` pass; `npm run build`
  (`tsc && vite build`) is clean.
- **Visual QA:** run `npm run dev`, drive the UI with the browser/preview tool,
  screenshot Home / Library / Modpacks / Browse / Settings / a modal in **both**
  themes; scan for any dark literal leaking into light. Before/after screenshots
  go in the PR body.

## Risks & mitigations

- **Undefined tokens / FOUC** → pre-paint inline script guarantees `data-theme`
  before CSS resolves.
- **Tailwind `@theme` re-theming** → resolved: override the emitted `--color-*`
  properties inside the `[data-theme]` blocks (utilities reference them by
  `var()`); confirm with a smoke check that `bg-surface` flips in light.
- **Dark regressions from migration** → dark-output invariant + diff review +
  visual QA against current build.
- **Missed literal leaks into light** → there is no automated color-usage test;
  rely on a final `grep oklch`/`#hex` sweep of `src/` plus per-screen visual QA.
- **`matchMedia` absent in tests** → guard all call sites; mock in setup.

## Rollout / ordering

The original guidance was to land this last (after PR1/2/3) to minimize
conflicts. With no PRs open, that's moot — proceed on current `main`. If those
PRs materialize before merge, rebase then; conflicts would be in the same
component files and the i18n locale files.
