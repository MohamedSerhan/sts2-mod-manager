# Light Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a user-selectable, OS-aware light theme alongside the existing dark-only UI, persisted across launches, with every color flowing through theme-reactive tokens.

**Architecture:** Mirror the language-preference pattern — a `src/theme/` module (load/save/resolve + `ThemeProvider`/`useTheme`) sets `data-theme` on `<html>`; CSS tokens are scoped under `:root[data-theme="dark"]` with a `:root[data-theme="light"]` override block; `color-scheme` is driven by a per-theme `--app-color-scheme` var; ~194 hardcoded `oklch`/hex literals are migrated onto semantic tokens. A pre-paint inline script in `index.html` guarantees `data-theme` exists before CSS resolves (no flash, no undefined tokens).

**Tech Stack:** React + TypeScript, Tailwind v4 (`@theme`), `react-i18next`, Vitest + Testing Library, Tauri 2 (WebView2/Chromium).

**Spec:** [docs/superpowers/specs/2026-06-02-light-theme-design.md](../specs/2026-06-02-light-theme-design.md)

**Conventions (from AGENTS.md):** every user-facing string is i18n in **both** `en.json` + `zh-Hans.json`; CSS lives only in `src/styles.css`; tests sit next to source; commit cohesively.

**Dark-output invariant (applies to Tasks 3–5):** migrating a literal onto a token must not change dark rendering — each token's **dark** value equals the literal it replaced. Dark mode is byte-identical after migration; only the light block introduces new values.

---

### Task 1: Theme preference module

**Goal:** A pure `src/theme/theme.ts` (no React) that loads/saves a theme preference and resolves `auto` against the OS — the structural twin of `src/i18n/language.ts`.

**Files:**
- Create: `src/theme/theme.ts`
- Test: `src/theme/theme.test.ts`

**Acceptance Criteria:**
- [ ] `THEME_STORAGE_KEY='sts2mm-theme'`, `DEFAULT_THEME_PREFERENCE='dark'`.
- [ ] `isSupportedThemePreference` accepts `'dark'|'light'|'auto'`, rejects anything else and `null`.
- [ ] `loadThemePreference` returns the stored value, or `'dark'` when empty/invalid/blocked-storage.
- [ ] `saveThemePreference` writes, and never throws on blocked storage.
- [ ] `resolveThemePreference` maps `dark→dark`, `light→light`, and `auto→light|dark` via `matchMedia`; `prefersLight()` returns `false` when `matchMedia` is absent.
- [ ] `applyTheme(mode)` sets `document.documentElement.dataset.theme`.

**Verify:** `npx vitest run src/theme/theme.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Write the failing test** — `src/theme/theme.test.ts`

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_STORAGE_KEY,
  applyTheme,
  isSupportedThemePreference,
  loadThemePreference,
  prefersLight,
  resolveThemePreference,
  saveThemePreference,
} from './theme';

afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

describe('theme preference', () => {
  it('recognises only dark/light/auto', () => {
    expect(isSupportedThemePreference('dark')).toBe(true);
    expect(isSupportedThemePreference('light')).toBe(true);
    expect(isSupportedThemePreference('auto')).toBe(true);
    expect(isSupportedThemePreference('french')).toBe(false);
    expect(isSupportedThemePreference(null)).toBe(false);
  });

  it('defaults to dark and round-trips a saved preference', () => {
    expect(loadThemePreference()).toBe(DEFAULT_THEME_PREFERENCE);
    saveThemePreference('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(loadThemePreference()).toBe('light');
  });

  it('falls back to dark on an invalid stored value', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'rainbow');
    expect(loadThemePreference()).toBe('dark');
  });

  it('resolves explicit modes verbatim', () => {
    expect(resolveThemePreference('dark')).toBe('dark');
    expect(resolveThemePreference('light')).toBe('light');
  });

  it('resolves auto from prefers-color-scheme', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: true, media: q, addEventListener() {}, removeEventListener() {} }));
    expect(prefersLight()).toBe(true);
    expect(resolveThemePreference('auto')).toBe('light');
    vi.stubGlobal('matchMedia', (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    expect(resolveThemePreference('auto')).toBe('dark');
  });

  it('applyTheme writes the data-theme attribute', () => {
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails** — `npx vitest run src/theme/theme.test.ts` → FAIL (`Cannot find module './theme'`).

- [ ] **Step 3: Implement** — `src/theme/theme.ts`

```ts
export const THEME_STORAGE_KEY = 'sts2mm-theme';

export type ThemeMode = 'dark' | 'light';
export type ThemePreference = ThemeMode | 'auto';

export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'dark';
const THEME_PREFERENCES: readonly string[] = ['dark', 'light', 'auto'];
const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function isSupportedThemePreference(value: string | null): value is ThemePreference {
  return value !== null && THEME_PREFERENCES.includes(value);
}

function getStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadThemePreference(storage: Storage | undefined = getStorage()): ThemePreference {
  if (!storage) return DEFAULT_THEME_PREFERENCE;
  try {
    const saved = storage.getItem(THEME_STORAGE_KEY);
    return isSupportedThemePreference(saved) ? saved : DEFAULT_THEME_PREFERENCE;
  } catch {
    return DEFAULT_THEME_PREFERENCE;
  }
}

export function saveThemePreference(
  preference: ThemePreference,
  storage: Storage | undefined = getStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A blocked storage write must not crash the theme selector.
  }
}

export function prefersLight(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(LIGHT_QUERY).matches;
  } catch {
    return false;
  }
}

export function resolveThemePreference(preference: ThemePreference): ThemeMode {
  if (preference === 'auto') return prefersLight() ? 'light' : 'dark';
  return preference;
}

export function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = mode;
}
```

- [ ] **Step 4: Run the test, confirm it passes** — `npx vitest run src/theme/theme.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/theme/theme.ts src/theme/theme.test.ts
git commit -m "feat(theme): add theme preference module (load/save/resolve)"
```

---

### Task 2: ThemeProvider, no-flash startup, and test plumbing

**Goal:** A `ThemeProvider`/`useTheme` context that applies + persists the theme and follows the OS live while on `auto`; wire it into `App.tsx`; guarantee no flash via an inline script; add the `matchMedia` mock so the whole suite stays green.

**Files:**
- Create: `src/theme/ThemeContext.tsx`, `src/theme/ThemeContext.test.tsx`
- Modify: `src/App.tsx` (wrap in `<ThemeProvider>`), `index.html` (inline script), `src/__test__/setup.ts` (matchMedia mock), `src/__test__/providers.tsx` (add ThemeProvider to `AllProviders`)

**Acceptance Criteria:**
- [ ] On mount, `data-theme` matches the resolved stored preference; default `dark`.
- [ ] `setPreference('light')` sets `data-theme="light"` and persists `sts2mm-theme=light`.
- [ ] While `preference==='auto'`, a `matchMedia` `change` updates `mode`/`data-theme`; the listener is removed when leaving `auto` / on unmount.
- [ ] `useTheme()` outside a provider throws.
- [ ] `index.html` sets `documentElement.dataset.theme` before the module script.
- [ ] Full suite passes (no test crashes from missing `matchMedia`).

**Verify:** `npx vitest run src/theme/ThemeContext.test.tsx` → pass; `npx vitest run` → all green.

**Steps:**

- [ ] **Step 1: Write the failing test** — `src/theme/ThemeContext.test.tsx`

```tsx
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider, useTheme } from './ThemeContext';
import { THEME_STORAGE_KEY } from './theme';

function Probe() {
  const { preference, mode, setPreference } = useTheme();
  return (
    <div>
      <span data-testid="mode">{mode}</span>
      <span data-testid="pref">{preference}</span>
      <button onClick={() => setPreference('light')}>light</button>
      <button onClick={() => setPreference('auto')}>auto</button>
    </div>
  );
}

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe('<ThemeProvider>', () => {
  it('defaults to dark and applies data-theme', () => {
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });

  it('persists and applies a manual switch to light', async () => {
    const user = userEvent.setup();
    render(<ThemeProvider><Probe /></ThemeProvider>);
    await user.click(screen.getByText('light'));
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('initialises from a stored preference', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('follows the OS while on auto', async () => {
    const listeners = new Set<() => void>();
    let matches = false;
    vi.stubGlobal('matchMedia', (q: string) => ({
      get matches() { return matches; },
      media: q,
      addEventListener: (_: string, cb: () => void) => listeners.add(cb),
      removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    }));
    const user = userEvent.setup();
    render(<ThemeProvider><Probe /></ThemeProvider>);
    await user.click(screen.getByText('auto'));
    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    act(() => { matches = true; listeners.forEach((cb) => cb()); });
    expect(screen.getByTestId('mode')).toHaveTextContent('light');
    vi.unstubAllGlobals();
  });

  it('throws when useTheme is used outside a provider', () => {
    function Bare() { useTheme(); return null; }
    expect(() => render(<Bare />)).toThrow(/ThemeProvider/);
  });
});
```

- [ ] **Step 2: Run, confirm failure** — `npx vitest run src/theme/ThemeContext.test.tsx` → FAIL (`Cannot find module './ThemeContext'`).

- [ ] **Step 3: Implement** — `src/theme/ThemeContext.tsx`

```tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  applyTheme,
  loadThemePreference,
  resolveThemePreference,
  saveThemePreference,
  type ThemeMode,
  type ThemePreference,
} from './theme';

interface ThemeContextValue {
  preference: ThemePreference;
  mode: ThemeMode;
  setPreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<ThemePreference>(() => loadThemePreference());
  const [mode, setMode] = useState<ThemeMode>(() => resolveThemePreference(loadThemePreference()));

  // Apply + persist on every preference change.
  useEffect(() => {
    const resolved = resolveThemePreference(preference);
    setMode(resolved);
    applyTheme(resolved);
    saveThemePreference(preference);
  }, [preference]);

  // While following the OS, react to live light/dark flips.
  useEffect(() => {
    if (preference !== 'auto') return;
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(LIGHT_QUERY);
    const onChange = () => {
      const resolved = resolveThemePreference('auto');
      setMode(resolved);
      applyTheme(resolved);
    };
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [preference]);

  return (
    <ThemeContext.Provider value={{ preference, mode, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
```

- [ ] **Step 4: Add the `matchMedia` mock** — in `src/__test__/setup.ts`, right after the `scrollIntoView` stub (after line ~126):

```ts
// jsdom doesn't implement matchMedia; ThemeProvider and prefers-color-scheme
// lookups need it. Default to "no light preference" (resolves to dark). Tests
// that exercise auto/light override window.matchMedia themselves.
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  // @ts-expect-error - minimal MediaQueryList stub for jsdom
  window.matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}
```

- [ ] **Step 5: Add ThemeProvider to `AllProviders`** — `src/__test__/providers.tsx`

```tsx
import { type ReactNode } from 'react';

import { AppProvider } from '../contexts/AppContext';
import { ConfirmProvider } from '../components/ConfirmDialog';
import { ToastProvider } from '../contexts/ToastContext';
import { ThemeProvider } from '../theme/ThemeContext';

export function AllProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ConfirmProvider>
          <AppProvider>{children}</AppProvider>
        </ConfirmProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 6: Wrap the app** — `src/App.tsx`, add import and wrap the return (lines 78–86):

```tsx
// add with the other context imports (near line 25)
import { ThemeProvider } from './theme/ThemeContext';

// replace the App() return body:
export default function App() {
  return (
    <ThemeProvider>
      <ToastProvider>
        <ConfirmProvider>
          <AppProvider>
            <AppInner />
          </AppProvider>
        </ConfirmProvider>
      </ToastProvider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 7: No-flash inline script** — `index.html`, add inside `<head>` after the `<title>` (line 7):

```html
    <title>STS2 Mod Manager</title>
    <script>
      // Set the theme attribute before any CSS resolves so there is no flash
      // and tokens (scoped under :root[data-theme=...]) are never undefined.
      // Mirrors src/theme/theme.ts; the storage key is duplicated because this
      // runs before the bundle loads.
      try {
        var p = localStorage.getItem('sts2mm-theme');
        var m = p === 'light' ? 'light'
          : p === 'auto' ? (window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
          : 'dark';
        document.documentElement.dataset.theme = m;
      } catch (e) { document.documentElement.dataset.theme = 'dark'; }
    </script>
```

- [ ] **Step 8: Run tests** — `npx vitest run src/theme/ThemeContext.test.tsx` → PASS; `npx vitest run` → all green. If any pre-existing test crashed on `matchMedia`, the setup mock fixes it.

- [ ] **Step 9: Commit**

```bash
git add src/theme/ThemeContext.tsx src/theme/ThemeContext.test.tsx src/App.tsx index.html src/__test__/setup.ts src/__test__/providers.tsx
git commit -m "feat(theme): ThemeProvider + no-flash startup + test plumbing"
```

---

### Task 3: CSS token architecture + reactive color-scheme

**Goal:** Restructure `src/styles.css` so the existing tokens live under `:root[data-theme="dark"]`, add a `:root[data-theme="light"]` block (seeded as a copy of dark so nothing is ever undefined — real light values come in Task 6), drive `color-scheme` from `--app-color-scheme`, and set `accent-color`. Dark output is unchanged.

> No automated color test exists (per spec). Verification for Tasks 3–6 is: `npm run build` clean, existing `npx vitest run` stays green, a `grep` gate on literals, and visual checks. The **dark-output invariant** keeps dark identical.

**Files:**
- Modify: `src/styles.css` (token blocks `:8-64`; `color-scheme` at `:37`, `:1519`, `:2416`)

**Acceptance Criteria:**
- [ ] Existing raw tokens (`--gf*`, `--indigo-*`, `--ink*`, `--ember`, `--ok`, `--warn`, `--danger`, `--gold*`) are defined under `:root[data-theme="dark"]`, with identical values.
- [ ] A `:root[data-theme="light"]` block exists defining the same token names (Task-3 seed = dark values).
- [ ] Tailwind `@theme` `--color-*` are overridden inside both `[data-theme]` blocks so `bg-surface`/`text-text` re-theme.
- [ ] `--app-color-scheme` is `dark`/`light` per block; all three `color-scheme: dark` become `color-scheme: var(--app-color-scheme)`.
- [ ] `accent-color: var(--gf)` is set on `:root` (or `body`).
- [ ] Default (`data-theme="dark"`) renders identically to pre-change; `npm run build` is clean.

**Verify:** `npm run build` → clean; load app (defaults dark) → visually identical; toggling `document.documentElement.dataset.theme='light'` in devtools shows the (still dark-valued) light block resolve without undefined-token breakage.

**Steps:**

- [ ] **Step 1: Restructure the token blocks.** Replace the current `:root { color-scheme: dark; --gf: …; … --gold-2: …; }` block (`styles.css:33-64`) with three blocks. Move every existing raw token verbatim into the dark block; copy the same lines into the light block (Task 6 retunes them); pull `color-scheme` out to a shared rule:

```css
:root[data-theme="dark"] {
  --app-color-scheme: dark;
  --gf:        oklch(0.78 0.13 80);
  --gf-hov:    oklch(0.83 0.13 80);
  --gf-ink:    oklch(0.18 0.04 285);
  --gf-tint:   oklch(0.78 0.13 80 / 0.18);
  --gf-line:   oklch(0.78 0.13 80 / 0.40);

  --indigo-bg:    oklch(0.16 0.04 280);
  --indigo-side:  oklch(0.12 0.04 280);
  --indigo-top:   oklch(0.14 0.04 280);
  --indigo-panel: oklch(0.20 0.04 280);
  --indigo-elev:  oklch(0.24 0.05 280);
  --indigo-deep:  oklch(0.10 0.04 280);
  --indigo-line:  oklch(0.28 0.05 280);

  --ink:        oklch(0.92 0.02 285);
  --ink-mute:   oklch(0.72 0.02 285);
  --ink-dim:    oklch(0.55 0.02 285);

  --ember:      oklch(0.65 0.16 50);
  --ok:         oklch(0.74 0.11 165);
  --warn:       oklch(0.78 0.13 75);
  --danger:     oklch(0.65 0.18 25);

  --gold:       var(--gf);
  --gold-2:     oklch(0.83 0.13 80);
}

/* Task 6 retunes these to real light values; seeded = dark so no token is
   ever undefined while the migration is in progress. */
:root[data-theme="light"] {
  --app-color-scheme: light;
  --gf:        oklch(0.78 0.13 80);
  --gf-hov:    oklch(0.83 0.13 80);
  --gf-ink:    oklch(0.18 0.04 285);
  --gf-tint:   oklch(0.78 0.13 80 / 0.18);
  --gf-line:   oklch(0.78 0.13 80 / 0.40);
  --indigo-bg:    oklch(0.16 0.04 280);
  --indigo-side:  oklch(0.12 0.04 280);
  --indigo-top:   oklch(0.14 0.04 280);
  --indigo-panel: oklch(0.20 0.04 280);
  --indigo-elev:  oklch(0.24 0.05 280);
  --indigo-deep:  oklch(0.10 0.04 280);
  --indigo-line:  oklch(0.28 0.05 280);
  --ink:        oklch(0.92 0.02 285);
  --ink-mute:   oklch(0.72 0.02 285);
  --ink-dim:    oklch(0.55 0.02 285);
  --ember:      oklch(0.65 0.16 50);
  --ok:         oklch(0.74 0.11 165);
  --warn:       oklch(0.78 0.13 75);
  --danger:     oklch(0.65 0.18 25);
  --gold:       var(--gf);
  --gold-2:     oklch(0.83 0.13 80);
}

:root {
  color-scheme: var(--app-color-scheme);
  accent-color: var(--gf);
}
```

- [ ] **Step 2: Make the `@theme` utilities re-theme.** Leave the `@theme { --color-*: … }` block (`styles.css:8-30`) in place (it emits the dark defaults Tailwind needs). Add the `--color-*` overrides into BOTH `[data-theme]` blocks so utilities flip. Append to the dark block and (with the same values for now) the light block:

```css
/* inside :root[data-theme="dark"] — append */
  --color-background: var(--indigo-bg);
  --color-surface: var(--indigo-panel);
  --color-surface-hover: var(--indigo-elev);
  --color-border: var(--indigo-line);
  --color-primary: var(--gf);
  --color-primary-hover: var(--gf-hov);
  --color-primary-ink: var(--gf-ink);
  --color-accent: var(--ember);
  --color-success: var(--ok);
  --color-warning: var(--warn);
  --color-danger: var(--danger);
  --color-text: var(--ink);
  --color-text-muted: var(--ink-mute);
  --color-text-dim: var(--ink-dim);
```

Copy the identical 14 lines into the light block. Because each aliases a raw token, retuning the raw tokens in Task 6 re-themes the utilities automatically. (Smoke check: a `bg-surface` element's computed `background-color` changes when `data-theme` flips.)

- [ ] **Step 3: Reactive `color-scheme` at the two element-level spots.** Replace `color-scheme: dark;` at `styles.css:1519` and `styles.css:2416` with `color-scheme: var(--app-color-scheme);` (the `:37` one is removed — it now lives in the shared `:root` rule from Step 1). Keep the surrounding comments.

- [ ] **Step 4: Build + visual check.** `npm run build` → clean. Run `npm run dev`, confirm dark is unchanged. In devtools set `document.documentElement.dataset.theme='light'` — layout intact, native `<select>` popups now light (color text dark), no undefined-token fallbacks.

- [ ] **Step 5: Commit**

```bash
git add src/styles.css
git commit -m "refactor(theme): scope tokens under data-theme, reactive color-scheme + accent-color"
```

---

### Task 4: Expand token set + migrate styles.css literals

**Goal:** Replace the ~154 hardcoded `oklch(...)` (and themeable hex) literals in `src/styles.css` with semantic tokens, adding the new tokens (accent tint/line/text triples, an `info` family, scrims) the literals require. Dark output stays identical.

> **Why this task is specified as rules + a gate, not 154 line edits:** enumerating every line would be brittle and order-fragile. The complete specification is: (a) the full set of new tokens with real dark values, (b) a mapping table from literal-family → token, (c) the one-off rule, and (d) a hard `grep` gate proving zero un-tokenized literals remain. Apply the map to every literal.

**Files:**
- Modify: `src/styles.css` (add tokens to both `[data-theme]` blocks; migrate all literals)

**Acceptance Criteria:**
- [ ] New tokens added to BOTH `[data-theme]` blocks (dark = real values below; light = same seed, retuned in Task 6).
- [ ] `grep -nE 'oklch\(' src/styles.css` returns **0** (every literal tokenized or `color-mix`'d).
- [ ] Remaining hex in `styles.css` is only the allowlisted fixed brand colors (GitHub label `#fbca04`/`#1a1a1a`, Google `#8ab4f8`); `#f59e0b` is replaced by `var(--warn)`.
- [ ] Each token's dark value equals the literal it replaced (dark unchanged); `npm run build` clean; `npx vitest run` green.

**Verify:** `grep -nE 'oklch\(' src/styles.css | wc -l` → `0`; `npm run build` → clean; dark app visually identical.

**Steps:**

- [ ] **Step 1: Add the new tokens.** Append to the dark block (and copy to the light block as seed):

```css
  /* accent support ramps (tint = fill, line = border, text = legible on tint) */
  --gf-text:      oklch(0.86 0.13 82);
  --ember-tint:   oklch(0.65 0.16 50 / 0.14);
  --ember-line:   oklch(0.60 0.16 60 / 0.40);
  --ok-tint:      oklch(0.74 0.11 165 / 0.15);
  --ok-line:      oklch(0.74 0.11 165 / 0.35);
  --ok-text:      oklch(0.66 0.13 165);
  --danger-hover: oklch(0.55 0.18 25);
  --danger-tint:  oklch(0.65 0.18 25 / 0.10);
  --danger-line:  oklch(0.55 0.16 25 / 0.30);
  --danger-text:  oklch(0.86 0.10 25);
  --info:         oklch(0.55 0.13 250);
  --info-tint:    oklch(0.55 0.13 250 / 0.10);
  --info-line:    oklch(0.55 0.13 250 / 0.30);
  --info-text:    oklch(0.85 0.07 250);
  --scrim:        oklch(0 0 0 / 0.25);
  --scrim-strong: oklch(0 0 0 / 0.45);
```

- [ ] **Step 2: Migrate by mapping table.** For each `oklch` literal in `styles.css`, substitute the token. Core mappings (cover the recurring values; the dark token value equals the literal so the render is unchanged):

| Literal family | Token |
| --- | --- |
| `0.16 0.04 280` | `var(--indigo-bg)` |
| `0.12 0.04 280` | `var(--indigo-side)` |
| `0.14 0.04 280` | `var(--indigo-top)` |
| `0.20 0.04 280` | `var(--indigo-panel)` |
| `0.24 0.05 280` | `var(--indigo-elev)` |
| `0.10 0.04 280` | `var(--indigo-deep)` |
| `0.28 0.05 280` | `var(--indigo-line)` |
| `0.92 0.02 285` | `var(--ink)` |
| `0.72 0.02 285` | `var(--ink-mute)` |
| `0.55 0.02 285` | `var(--ink-dim)` |
| `0.78 0.13 80` | `var(--gf)` |
| `0.83 0.13 80` | `var(--gf-hov)` / `var(--gold-2)` |
| `0.18 0.04 285` | `var(--gf-ink)` |
| `0.78 0.13 80 / 0.18` | `var(--gf-tint)` |
| `0.78 0.13 80 / 0.40` | `var(--gf-line)` |
| `0.65 0.16 50` | `var(--ember)` |
| `0.74 0.11 165` | `var(--ok)` |
| `0.74 0.11 165 / 0.15..0.18` | `var(--ok-tint)` |
| `0.74 0.11 165 / 0.30..0.50` | `var(--ok-line)` |
| `0.78 0.13 75` | `var(--warn)`; `#f59e0b` → `var(--warn)` |
| `0.65 0.18 25` | `var(--danger)` |
| `0.65 0.18 25 / 0.06..0.12` | `var(--danger-tint)` |
| `0.55 0.16 25 / 0.15..0.45` | `var(--danger-line)` |
| `0.85/0.86 0.10..0.12 25` | `var(--danger-text)` |
| `0.55 0.13 250` | `var(--info)` |
| `0.55 0.13 250 / 0.10..0.14` | `var(--info-tint)` |
| `0.55 0.13 250 / 0.3..0.4` | `var(--info-line)` |
| `0.85 0.07 250` | `var(--info-text)` |
| `0 0 0 / 0.25` | `var(--scrim)` |
| `0 0 0 / 0.45` | `var(--scrim-strong)` |
| `0.10 0.02 270 / x`, `0.06 0.02 270 / x` (deep wells) | `color-mix(in oklch, var(--indigo-deep) <100·x>%, transparent)` |

- [ ] **Step 3: One-off rule.** For any literal not in the table, replace with the nearest semantic token by hue+lightness, or — when it's an alpha variant of a base token — `color-mix(in oklch, var(--token) N%, transparent)` where `N` = the literal's alpha ×100. Never leave a raw `oklch`.

- [ ] **Step 4: Gate + build.** Run `grep -nE 'oklch\(' src/styles.css` → expect no output. `npm run build` → clean. `npx vitest run` → green (component tests assert classes/behavior, not colors, so they're unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/styles.css
git commit -m "refactor(theme): tokenize all styles.css color literals"
```

---

### Task 5: Migrate inline component colors

**Goal:** Replace the ~40 inline `oklch`/hex literals in JSX `style={{…}}` across ~12 components with `var(--token)` references, so callouts/badges/borders re-theme. Layout/structure untouched.

**Files:**
- Modify: `src/views/Browse.tsx`, `src/views/Settings.tsx`, `src/contexts/ToastContext.tsx`, `src/components/AutoDetectModal.tsx`, `src/components/BrowseDetail.tsx`, `src/components/ConfirmDialog.tsx`, `src/components/LibraryRow.tsx`, `src/components/OnboardingOverlay.tsx`, `src/components/ProfileSwitcher.tsx`, `src/components/PublishModal.tsx`, `src/components/QuickAddModal.tsx`, `src/components/SourceEditor.tsx`

**Acceptance Criteria:**
- [ ] `grep -rnE 'oklch\(' src --include=*.tsx` returns **0**.
- [ ] Inline hex colors that are themeable are tokenized; only intentional fixed brand hex remains (justify in the diff).
- [ ] Same token mapping as Task 4; the danger/info/success callout pattern (`background:<accent>/0.10; border:1px solid <accent>/0.3; color:<accent-text>`) becomes `var(--*-tint)`/`var(--*-line)`/`var(--*-text)`.
- [ ] `npx vitest run` green; `npm run build` clean.

**Verify:** `grep -rnE 'oklch\(' src --include=*.tsx | wc -l` → `0`; `npx vitest run` → all green.

**Steps:**

- [ ] **Step 1: Apply per-file.** In each file, `grep -n 'oklch('`, and replace each literal value inside the `style` object with the mapped `var(--token)` (keep all other style properties). Worked example — `src/components/ConfirmDialog.tsx` (the destructive callout, lines ~101–203):

```tsx
// background tint on the modal head:
style={pending.destructive ? { background: 'var(--danger-tint)' } : undefined}
// the warning callout box:
background: 'var(--danger-tint)',
border: '1px solid var(--danger-line)',
// the icon + text:
<AlertTriangle size={16} style={{ color: 'var(--danger)', flexShrink: 0, marginTop: 1 }} />
<div style={{ fontSize: 12, color: 'var(--danger-text)' }}>{pending.warning}</div>
// typed-phrase hint:
<div style={{ fontSize: 12.5, color: 'var(--danger-text)' }}>
// the destructive confirm button (keep #fff ink on the solid danger fill):
style={pending.destructive && pending.typedPhrase ? { background: 'var(--danger)', color: '#fff', border: 0 } : undefined}
```

Worked example — `src/components/PublishModal.tsx` info callouts (lines ~393–399, 491–497) and danger callout (~529–535):

```tsx
// info callout:
background: 'var(--info-tint)',
border: '1px solid var(--info-line)',
color: 'var(--info-text)',
// danger callout:
background: 'var(--danger-tint)',
border: '1px solid var(--danger-line)',
color: 'var(--danger-text)',
```

- [ ] **Step 2: Mapping for the remaining components.** Use the Task 4 table plus: green `0.62 0.14 145 / x` → `var(--ok-tint)`/`var(--ok-line)`; dark scrim `0.10 0.04 280 / x` (OnboardingOverlay/Toast backdrops) → `color-mix(in oklch, var(--indigo-deep) <100·x>%, transparent)` or `var(--scrim-strong)`; brand-red brights `0.82 0.16 25`/`0.75 0.13 25` → `var(--danger)`.

- [ ] **Step 3: Gate.** `grep -rnE 'oklch\(' src --include=*.tsx` → no output. `npx vitest run` → green. `npm run build` → clean.

- [ ] **Step 4: Commit**

```bash
git add src/views src/components src/contexts
git commit -m "refactor(theme): tokenize inline component colors"
```

---

### Task 6: Author the light palette

**Goal:** Replace the seeded (dark) values in `:root[data-theme="light"]` with a hand-tuned light palette for every token, then visually QA each major screen in light.

**Files:**
- Modify: `src/styles.css` (`:root[data-theme="light"]` block only)

**Acceptance Criteria:**
- [ ] Every token in the light block has a purpose-chosen light value (surfaces off-white, text near-black indigo, accents darkened/de-chroma'd for AA contrast on light, scrims unchanged).
- [ ] No dark surface/illegible accent on any major screen in light; dark is unaffected (only the light block changed).
- [ ] `npm run build` clean; `npx vitest run` green.

**Verify:** `npm run dev`; in devtools `localStorage.setItem('sts2mm-theme','light')` then reload (Task 7 adds the UI toggle); walk Home / Library / Modpacks / Browse / Settings / a modal — all legible.

**Steps:**

- [ ] **Step 1: Set the light values.** Replace the light block's token values with:

```css
:root[data-theme="light"] {
  --app-color-scheme: light;

  /* surfaces — cool off-white, cards near-white, wells slightly grey */
  --indigo-bg:    oklch(0.965 0.006 280);
  --indigo-side:  oklch(0.945 0.008 280);
  --indigo-top:   oklch(0.975 0.005 280);
  --indigo-panel: oklch(0.995 0.003 280);
  --indigo-elev:  oklch(0.975 0.006 280);
  --indigo-deep:  oklch(0.920 0.010 280);
  --indigo-line:  oklch(0.880 0.012 280);

  /* text — near-black indigo */
  --ink:        oklch(0.25 0.03 285);
  --ink-mute:   oklch(0.45 0.02 285);
  --ink-dim:    oklch(0.58 0.02 285);

  /* gold primary — darkened so it reads on white; dark ink on the fill */
  --gf:        oklch(0.66 0.12 80);
  --gf-hov:    oklch(0.60 0.12 80);
  --gf-ink:    oklch(0.22 0.03 285);
  --gf-tint:   oklch(0.66 0.12 80 / 0.16);
  --gf-line:   oklch(0.66 0.12 80 / 0.40);
  --gf-text:   oklch(0.45 0.10 80);
  --gold:      var(--gf);
  --gold-2:    oklch(0.60 0.12 80);

  /* ember / success / warning / danger / info — darker, slightly de-chroma'd */
  --ember:      oklch(0.58 0.16 50);
  --ember-tint: oklch(0.58 0.16 50 / 0.14);
  --ember-line: oklch(0.58 0.16 50 / 0.38);
  --ok:         oklch(0.52 0.12 165);
  --ok-tint:    oklch(0.52 0.12 165 / 0.14);
  --ok-line:    oklch(0.52 0.12 165 / 0.35);
  --ok-text:    oklch(0.40 0.10 165);
  --warn:       oklch(0.62 0.13 70);
  --danger:       oklch(0.55 0.20 25);
  --danger-hover: oklch(0.50 0.20 25);
  --danger-tint:  oklch(0.55 0.20 25 / 0.10);
  --danger-line:  oklch(0.55 0.20 25 / 0.30);
  --danger-text:  oklch(0.45 0.18 25);
  --info:       oklch(0.52 0.15 255);
  --info-tint:  oklch(0.52 0.15 255 / 0.10);
  --info-line:  oklch(0.52 0.15 255 / 0.30);
  --info-text:  oklch(0.42 0.14 255);

  /* overlays dim regardless of theme */
  --scrim:        oklch(0 0 0 / 0.25);
  --scrim-strong: oklch(0 0 0 / 0.45);

  /* @theme aliases re-point automatically (they reference the raw tokens) */
  --color-background: var(--indigo-bg);
  --color-surface: var(--indigo-panel);
  --color-surface-hover: var(--indigo-elev);
  --color-border: var(--indigo-line);
  --color-primary: var(--gf);
  --color-primary-hover: var(--gf-hov);
  --color-primary-ink: var(--gf-ink);
  --color-accent: var(--ember);
  --color-success: var(--ok);
  --color-warning: var(--warn);
  --color-danger: var(--danger);
  --color-text: var(--ink);
  --color-text-muted: var(--ink-mute);
  --color-text-dim: var(--ink-dim);
}
```

- [ ] **Step 2: Visual QA + tune.** Reload in light; inspect each screen. Adjust any low-contrast token (e.g. nudge `--gf` lightness down if focus rings/badges wash out; raise `--indigo-line` if borders vanish). Re-check dark is untouched.

- [ ] **Step 3: Commit**

```bash
git add src/styles.css
git commit -m "feat(theme): author the light palette"
```

---

### Task 7: Theme toggle in Settings (UI + i18n)

**Goal:** A `ThemeSelect` dropdown (Auto / Dark / Light) mounted in Settings → General next to the Language card, with i18n keys in both locales.

**Files:**
- Create: `src/components/ThemeSelect.tsx`, `src/components/ThemeSelect.test.tsx`
- Modify: `src/i18n/locales/en.json`, `src/i18n/locales/zh-Hans.json`, `src/views/Settings.tsx`

**Acceptance Criteria:**
- [ ] `settings.theme.{label,dark,light,auto}` added to en + zh-Hans (`主题/深色/浅色/自动`); `npm run qa:i18n` passes.
- [ ] `ThemeSelect` renders Auto/Dark/Light, defaults to `dark`, persists + applies on change, ignores unsupported values; uses `useTheme()`.
- [ ] A Theme `<Card>` appears immediately after the Language card in Settings → General.
- [ ] `npx vitest run src/components/ThemeSelect.test.tsx` passes; `npm run build` clean.

**Verify:** `npm run qa:i18n` → pass; `npx vitest run src/components/ThemeSelect.test.tsx` → pass.

**Steps:**

- [ ] **Step 1: i18n keys.** In `src/i18n/locales/en.json`, after the `settings.language` block (closes at line 1104), add:

```json
    "theme": {
      "label": "Theme",
      "dark": "Dark",
      "light": "Light",
      "auto": "Auto"
    },
```

In `src/i18n/locales/zh-Hans.json`, same location:

```json
    "theme": {
      "label": "主题",
      "dark": "深色",
      "light": "浅色",
      "auto": "自动"
    },
```

(`auto` differs from English `Auto`, so the parity "copied English" check passes; no allowlist entry needed.)

- [ ] **Step 2: Write the failing test** — `src/components/ThemeSelect.test.tsx`

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ThemeProvider } from '../theme/ThemeContext';
import { THEME_STORAGE_KEY } from '../theme/theme';
import { ThemeSelect } from './ThemeSelect';

function renderSelect() {
  return render(<ThemeProvider><ThemeSelect /></ThemeProvider>);
}

describe('<ThemeSelect>', () => {
  beforeEach(() => {
    localStorage.clear();
    delete document.documentElement.dataset.theme;
  });

  it('renders Auto, Dark, and Light choices, defaulting to Dark', () => {
    renderSelect();
    expect(screen.getByLabelText('Theme')).toHaveValue('dark');
    expect(screen.getByRole('option', { name: 'Auto' })).toHaveValue('auto');
    expect(screen.getByRole('option', { name: 'Dark' })).toHaveValue('dark');
    expect(screen.getByRole('option', { name: 'Light' })).toHaveValue('light');
  });

  it('persists a switch to Light and applies data-theme', async () => {
    const user = userEvent.setup();
    renderSelect();
    await user.selectOptions(screen.getByLabelText('Theme'), 'light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('ignores change events with unsupported values', () => {
    renderSelect();
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'rainbow' } });
    expect(localStorage.getItem(THEME_STORAGE_KEY)).not.toBe('rainbow');
  });
});
```

- [ ] **Step 3: Run, confirm failure** — `npx vitest run src/components/ThemeSelect.test.tsx` → FAIL (`Cannot find module './ThemeSelect'`).

- [ ] **Step 4: Implement** — `src/components/ThemeSelect.tsx`

```tsx
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { isSupportedThemePreference, type ThemePreference } from '../theme/theme';

const OPTIONS: Array<{ value: ThemePreference; labelKey: string }> = [
  { value: 'auto', labelKey: 'settings.theme.auto' },
  { value: 'dark', labelKey: 'settings.theme.dark' },
  { value: 'light', labelKey: 'settings.theme.light' },
];

export function ThemeSelect() {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  const id = useId();

  function handleChange(value: string) {
    if (!isSupportedThemePreference(value)) return;
    setPreference(value);
  }

  return (
    <div className="gf-language-select">
      <label htmlFor={id} className="gf-field-label">
        {t('settings.theme.label')}
      </label>
      <select
        id={id}
        className="gf-set-input"
        value={preference}
        onChange={(event) => handleChange(event.target.value)}
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {t(option.labelKey)}
          </option>
        ))}
      </select>
    </div>
  );
}
```

- [ ] **Step 5: Mount in Settings** — `src/views/Settings.tsx`. Add `Palette` to the lucide import, import `ThemeSelect`, and insert a Card after the Language card (after line 561):

```tsx
// import additions
import { ThemeSelect } from '../components/ThemeSelect';
// add Palette to the existing `lucide-react` import list

// after the Language <Card> (…line 561):
<Card className="space-y-4" style={{ marginTop: 8 }}>
  <h3 className="text-base font-semibold text-text flex items-center gap-2">
    <Palette size={16} />
    {t('settings.theme.label')}
  </h3>
  <ThemeSelect />
</Card>
```

- [ ] **Step 6: Run tests** — `npx vitest run src/components/ThemeSelect.test.tsx` → PASS; `npm run qa:i18n` → PASS; `npm run build` → clean.

- [ ] **Step 7: Commit**

```bash
git add src/components/ThemeSelect.tsx src/components/ThemeSelect.test.tsx src/i18n/locales/en.json src/i18n/locales/zh-Hans.json src/views/Settings.tsx
git commit -m "feat(theme): add Auto/Dark/Light toggle to Settings"
```

---

### Task 8: Definition-of-Done verification + screenshots + PR

**Goal:** **USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured — including before/after screenshots in **both** dark and light.

**Files:**
- No source changes (verification + PR). Screenshots attached to the PR.

**Acceptance Criteria:**
- [ ] `npm run qa:unit` passes (captured output).
- [ ] `npm run qa:i18n` passes (captured output).
- [ ] `npm run build` is clean (captured output).
- [ ] Literal sweep: `grep -rnE 'oklch\(' src/styles.css src --include=*.tsx` → 0; remaining hex justified as fixed brand colors.
- [ ] **Light** renders correctly on Home / Library / Modpacks / Browse / Settings / a modal — captured screenshots.
- [ ] **Dark** still renders correctly on the same screens — captured screenshots (regression check).
- [ ] Native controls verified in light: every `<select>` popup is a light popup with dark option text; checkbox/radio legible; input caret + focus ring visible; scrollbar has contrast.
- [ ] PR opened with before/after screenshots in both themes.

**Verify:** `npm run qa:unit && npm run qa:i18n && npm run build` → all succeed; screenshots captured in dark AND light; PR created.

**Steps:**

- [ ] **Step 1: Automated gates.**

```bash
npm run qa:unit
npm run qa:i18n
npm run build
grep -rnE 'oklch\(' src/styles.css ; grep -rnE 'oklch\(' src --include=*.tsx
```

Expect: vitest + parity pass, build clean, both greps empty.

- [ ] **Step 2: Visual QA in both themes.** `npm run dev`; drive with the browser/preview tool. For **dark** (default) and **light** (`localStorage.setItem('sts2mm-theme','light')` or the new Settings toggle), screenshot Home, Library, Modpacks, Browse, Settings, and one modal. Exercise native controls in light: open each `<select>` popup (Language, Theme, Mods sort, LibraryTable, ModMultiSelect, CreateModpackWizard), toggle a checkbox/radio, focus an input/textarea, scroll a long list.

- [ ] **Step 3: Open the PR** with before/after screenshots in both themes and a summary linking the spec.

```bash
git push -u origin claude/flamboyant-noether-7bcc63
gh pr create --title "feat: light theme" --body "<summary + before/after screenshots (dark & light) + link to spec>"
```

---

## Self-review notes

- **Spec coverage:** §Architecture→T1/T2; §No-flash→T2; §Native controls & color-scheme→T3 (+ verified in T8); §Token model/migration→T3/T4/T5; §Light palette→T6; §Theme control UI + i18n→T7; §Testing & DoD→T1/T2/T7 tests + T8 gate. All sections mapped.
- **Type consistency:** `ThemePreference`/`ThemeMode`, `loadThemePreference`/`saveThemePreference`/`resolveThemePreference`/`prefersLight`/`applyTheme`, `useTheme().{preference,mode,setPreference}`, `isSupportedThemePreference` — names identical across T1/T2/T7.
- **Ordering:** strictly sequential T1→T8; the dark-output invariant keeps every intermediate commit shippable in dark.
