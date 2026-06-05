# Mod-row ⋯ Menu Customization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-mod ⋯ (kebab) menu in `LibraryRow.tsx` user-customizable (show/hide + drag-reorder), remove the legacy "Edit sources…" item, and fix the Copy-version double-`v` label/toast.

**Architecture:** A pure config module (`rowMenuConfig.ts`) holds the menu layout (ordered ids + hidden set) and persists to `localStorage`, fronted by a React Context (`RowMenuContext`) that mirrors the existing `ThemeContext` pattern. The kebab is refactored from hardcoded JSX into a descriptor map keyed by stable item ids; it renders the user's order (minus hidden, minus contextually-unavailable), with `delete` and a new `customize` footer pinned/locked at the bottom. A Settings card edits the config via native HTML5 drag-and-drop; a window `CustomEvent` deep-links the kebab's "Customize menu…" item to that card.

**Tech Stack:** React 18 + TypeScript, react-i18next (en/zh-Hans/ru/ar), Vitest + Testing Library, Tauri v2. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-04-mod-row-menu-customization-design.md`

---

## File Structure

**New**
- `src/lib/rowMenuConfig.ts` — pure types, defaults, `localStorage` load/save, and reorder/resolve helpers. The single source of truth for the menu model. Also exports `ROW_MENU_OPEN_EVENT`.
- `src/lib/rowMenuConfig.test.ts` — unit tests for every helper.
- `src/contexts/RowMenuContext.tsx` — `RowMenuProvider` + `useRowMenu()` hook.
- `src/contexts/RowMenuContext.test.tsx` — provider behavior + persistence tests.
- `src/components/RowMenuCustomizer.tsx` — the Settings card (drag-reorder list + show/hide toggles + reset).
- `src/components/RowMenuCustomizer.test.tsx` — component tests.

**Modified**
- `src/components/LibraryRow.tsx` — descriptor-driven flat kebab; remove Edit-sources; locked Delete + Customize footer; normalized Copy-version label; consume `useRowMenu()`.
- `src/components/LibraryRow.test.tsx` — drop Edit-sources test; add order/hide/lock/availability/customize-event/single-`v` tests.
- `src/hooks/useModLibrary.tsx` — normalized Copy-version toast (`useModLibrary.tsx:426`).
- `src/hooks/useModLibrary.test.tsx` — add Copy-version toast normalization test.
- `src/views/Settings.tsx` — render `<RowMenuCustomizer/>` in the General tab; accept `openRowMenuSettingsSignal` and scroll/highlight the card.
- `src/views/Settings.test.tsx` — signal scroll/highlight wiring.
- `src/App.tsx` — wrap `<RowMenuProvider>`; listen for `ROW_MENU_OPEN_EVENT`; own `openRowMenuSettingsSignal`.
- `src/App.test.tsx` — event → Settings navigation wiring.
- `src/__test__/providers.tsx` — add `RowMenuProvider` to `AllProviders`.
- `src/i18n/locales/{en,zh-Hans,ru,ar}.json` — new keys (Task 3 + Task 4), all four in lockstep (parity gate).
- `src/styles.css` — customizer list / drag-handle / locked-row / card-highlight styles.

**i18n note (applies to every task that adds a string):** `src/i18n/locales/parity.test.ts` fails if the four locales' key sets differ **or** if a non-English value equals the English one. So each new key must be added to **all four** files with a genuine (non-English) translation **in the same task**. Translations below are AI-generated, pending human verification (tracked in [#132](https://github.com/MohamedSerhan/sts2-mod-manager/issues/132)) — same status as the existing ru/ar locales.

---

### Task 0: Pure config module (`rowMenuConfig.ts`)

**Goal:** A dependency-free module that defines the menu model and all pure operations on it, fully unit-tested.

**Files:**
- Create: `src/lib/rowMenuConfig.ts`
- Test: `src/lib/rowMenuConfig.test.ts`

**Acceptance Criteria:**
- [ ] Exports `RowMenuItemId`, `DEFAULT_ROW_MENU_ORDER`, `RowMenuConfig`, `DEFAULT_ROW_MENU_CONFIG`, `ROW_MENU_STORAGE_KEY`, `ROW_MENU_OPEN_EVENT`.
- [ ] `normalizeConfig` returns a valid config for any input: drops unknown ids, de-dupes, appends missing known ids in default order, clamps `hidden`.
- [ ] `moveItem`, `toggleHidden`, `resolveRowMenuOrder` behave per tests.
- [ ] `loadRowMenuConfig`/`saveRowMenuConfig` round-trip via `localStorage` and never throw on storage failure.

**Verify:** `npm test -- src/lib/rowMenuConfig.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/rowMenuConfig.test.ts
import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_ROW_MENU_CONFIG,
  DEFAULT_ROW_MENU_ORDER,
  ROW_MENU_STORAGE_KEY,
  loadRowMenuConfig,
  moveItem,
  normalizeConfig,
  resolveRowMenuOrder,
  saveRowMenuConfig,
  toggleHidden,
  type RowMenuItemId,
} from './rowMenuConfig';

beforeEach(() => {
  try { localStorage.clear(); } catch { /* jsdom quirk */ }
});

describe('normalizeConfig', () => {
  it('returns the default config for null/garbage input', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULT_ROW_MENU_CONFIG);
    expect(normalizeConfig('nope')).toEqual(DEFAULT_ROW_MENU_CONFIG);
    expect(normalizeConfig({})).toEqual(DEFAULT_ROW_MENU_CONFIG);
  });

  it('drops unknown ids and de-dupes, then appends missing known ids in default order', () => {
    const out = normalizeConfig({ order: ['freeze', 'freeze', 'bogus', 'copyVersion'], hidden: [] });
    // freeze + copyVersion kept (first occurrence, in given order), rest appended in default order
    expect(out.order[0]).toBe('freeze');
    expect(out.order[1]).toBe('copyVersion');
    expect([...out.order].sort()).toEqual([...DEFAULT_ROW_MENU_ORDER].sort());
    expect(new Set(out.order).size).toBe(DEFAULT_ROW_MENU_ORDER.length);
  });

  it('clamps hidden to known customizable ids', () => {
    const out = normalizeConfig({ order: [...DEFAULT_ROW_MENU_ORDER], hidden: ['freeze', 'delete', 'bogus'] });
    expect(out.hidden).toEqual(['freeze']); // 'delete' is locked, 'bogus' unknown
  });
});

describe('moveItem', () => {
  it('moves an item from one index to another immutably', () => {
    const order: RowMenuItemId[] = ['copyVersion', 'openFolder', 'freeze'];
    const moved = moveItem(order, 2, 0);
    expect(moved).toEqual(['freeze', 'copyVersion', 'openFolder']);
    expect(order).toEqual(['copyVersion', 'openFolder', 'freeze']); // original untouched
  });

  it('returns the same order when indices are out of range', () => {
    const order: RowMenuItemId[] = ['copyVersion', 'openFolder'];
    expect(moveItem(order, -1, 5)).toEqual(order);
  });
});

describe('toggleHidden', () => {
  it('adds then removes an id from hidden', () => {
    const a = toggleHidden(DEFAULT_ROW_MENU_CONFIG, 'freeze');
    expect(a.hidden).toContain('freeze');
    const b = toggleHidden(a, 'freeze');
    expect(b.hidden).not.toContain('freeze');
  });

  it('ignores locked ids (delete/customize are not RowMenuItemId — guard at runtime)', () => {
    // @ts-expect-error locked id is not assignable; guard must no-op
    const out = toggleHidden(DEFAULT_ROW_MENU_CONFIG, 'delete');
    expect(out.hidden).toEqual(DEFAULT_ROW_MENU_CONFIG.hidden);
  });
});

describe('resolveRowMenuOrder', () => {
  it('returns ordered ids minus hidden, minus unavailable', () => {
    const cfg = { order: ['copyVersion', 'freeze', 'openFolder'] as RowMenuItemId[], hidden: ['freeze'] as RowMenuItemId[] };
    const available = new Set<RowMenuItemId>(['copyVersion', 'openFolder']); // freeze unavailable AND hidden
    expect(resolveRowMenuOrder(cfg, available)).toEqual(['copyVersion', 'openFolder']);
  });

  it('preserves the user order for available, visible ids', () => {
    const cfg = { order: ['openFolder', 'copyVersion'] as RowMenuItemId[], hidden: [] as RowMenuItemId[] };
    const available = new Set<RowMenuItemId>(['copyVersion', 'openFolder']);
    expect(resolveRowMenuOrder(cfg, available)).toEqual(['openFolder', 'copyVersion']);
  });
});

describe('load/save', () => {
  it('persists and reloads a config', () => {
    const cfg = toggleHidden(DEFAULT_ROW_MENU_CONFIG, 'autoDetect');
    saveRowMenuConfig(cfg);
    expect(loadRowMenuConfig()).toEqual(cfg);
  });

  it('returns default when storage is empty or malformed', () => {
    expect(loadRowMenuConfig()).toEqual(DEFAULT_ROW_MENU_CONFIG);
    localStorage.setItem(ROW_MENU_STORAGE_KEY, '{not json');
    expect(loadRowMenuConfig()).toEqual(DEFAULT_ROW_MENU_CONFIG);
  });

  it('never throws when storage is unavailable', () => {
    expect(() => saveRowMenuConfig(DEFAULT_ROW_MENU_CONFIG, undefined)).not.toThrow();
    expect(loadRowMenuConfig(undefined)).toEqual(DEFAULT_ROW_MENU_CONFIG);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/rowMenuConfig.test.ts`
Expected: FAIL — module `./rowMenuConfig` not found.

- [ ] **Step 3: Implement the module**

```ts
// src/lib/rowMenuConfig.ts

/**
 * Customizable per-mod ⋯ menu layout. The user can show/hide and reorder
 * these items; `delete` (disk-delete) and `customize` (the footer entry) are
 * LOCKED — pinned to the bottom, never part of this model. Persisted to
 * localStorage, mirroring src/theme/theme.ts.
 */
export const ROW_MENU_STORAGE_KEY = 'sts2mm-row-menu';

/** Window CustomEvent dispatched by the kebab's "Customize menu…" item. */
export const ROW_MENU_OPEN_EVENT = 'sts2mm:open-row-menu-settings';

export type RowMenuItemId =
  | 'membership'
  | 'copyVersion'
  | 'openFolder'
  | 'snooze'
  | 'autoDetect'
  | 'viewGithub'
  | 'viewNexus'
  | 'findGithub'
  | 'freeze'
  | 'repair'
  | 'rollback';

/** Default flat order. Freeze deliberately sits low (resolves #123). */
export const DEFAULT_ROW_MENU_ORDER: readonly RowMenuItemId[] = [
  'membership',
  'copyVersion',
  'openFolder',
  'snooze',
  'autoDetect',
  'viewGithub',
  'viewNexus',
  'findGithub',
  'freeze',
  'repair',
  'rollback',
];

const KNOWN_IDS: ReadonlySet<RowMenuItemId> = new Set(DEFAULT_ROW_MENU_ORDER);

function isKnownId(value: unknown): value is RowMenuItemId {
  return typeof value === 'string' && KNOWN_IDS.has(value as RowMenuItemId);
}

export interface RowMenuConfig {
  order: RowMenuItemId[];
  hidden: RowMenuItemId[];
}

export const DEFAULT_ROW_MENU_CONFIG: RowMenuConfig = {
  order: [...DEFAULT_ROW_MENU_ORDER],
  hidden: [],
};

/**
 * Coerce arbitrary stored/loaded data into a valid config. The resilience
 * boundary: unknown ids dropped, duplicates removed, any known id missing
 * from `order` appended in default-order position (so a future release's new
 * item appears rather than being silently hidden), `hidden` clamped to known
 * ids actually present in `order`.
 */
export function normalizeConfig(raw: unknown): RowMenuConfig {
  const rawOrder = (raw as { order?: unknown })?.order;
  const rawHidden = (raw as { hidden?: unknown })?.hidden;

  const seen = new Set<RowMenuItemId>();
  const order: RowMenuItemId[] = [];
  if (Array.isArray(rawOrder)) {
    for (const id of rawOrder) {
      if (isKnownId(id) && !seen.has(id)) {
        seen.add(id);
        order.push(id);
      }
    }
  }
  // Append any known id not yet present, in default order.
  for (const id of DEFAULT_ROW_MENU_ORDER) {
    if (!seen.has(id)) order.push(id);
  }

  const hidden: RowMenuItemId[] = [];
  if (Array.isArray(rawHidden)) {
    for (const id of rawHidden) {
      if (isKnownId(id) && !hidden.includes(id)) hidden.push(id);
    }
  }

  return { order, hidden };
}

/** Immutable array move. Returns the input unchanged on out-of-range indices. */
export function moveItem(
  order: readonly RowMenuItemId[],
  fromIndex: number,
  toIndex: number,
): RowMenuItemId[] {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= order.length ||
    toIndex >= order.length ||
    fromIndex === toIndex
  ) {
    return [...order];
  }
  const next = [...order];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}

/** Flip an id's hidden state. No-op for ids not in the customizable set. */
export function toggleHidden(config: RowMenuConfig, id: RowMenuItemId): RowMenuConfig {
  if (!isKnownId(id)) return config;
  const hidden = config.hidden.includes(id)
    ? config.hidden.filter((h) => h !== id)
    : [...config.hidden, id];
  return { ...config, hidden };
}

/**
 * The render contract: the user's order, filtered to ids that are available
 * for this mod (contextual predicates) AND not hidden.
 */
export function resolveRowMenuOrder(
  config: RowMenuConfig,
  availableIds: ReadonlySet<RowMenuItemId>,
): RowMenuItemId[] {
  const hidden = new Set(config.hidden);
  return config.order.filter((id) => availableIds.has(id) && !hidden.has(id));
}

function getStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

export function loadRowMenuConfig(
  storage: Storage | undefined = getStorage(),
): RowMenuConfig {
  if (!storage) return DEFAULT_ROW_MENU_CONFIG;
  try {
    const saved = storage.getItem(ROW_MENU_STORAGE_KEY);
    if (!saved) return DEFAULT_ROW_MENU_CONFIG;
    return normalizeConfig(JSON.parse(saved));
  } catch {
    return DEFAULT_ROW_MENU_CONFIG;
  }
}

export function saveRowMenuConfig(
  config: RowMenuConfig,
  storage: Storage | undefined = getStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(ROW_MENU_STORAGE_KEY, JSON.stringify(config));
  } catch {
    // A blocked storage write must not crash the customizer.
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/rowMenuConfig.test.ts`
Expected: PASS (all). Note the `@ts-expect-error` line in the `toggleHidden` locked-id test exercises the runtime guard.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rowMenuConfig.ts src/lib/rowMenuConfig.test.ts
git commit -m "feat(row-menu): pure config model + helpers for kebab customization"
```

---

### Task 1: Context provider + app/test wiring (`RowMenuContext`)

**Goal:** A `RowMenuProvider`/`useRowMenu()` that exposes the config and mutators, persists on change, is mounted in `App.tsx`, and is available to all component tests.

**Files:**
- Create: `src/contexts/RowMenuContext.tsx`
- Test: `src/contexts/RowMenuContext.test.tsx`
- Modify: `src/App.tsx` (wrap provider), `src/__test__/providers.tsx` (add to `AllProviders`)

**Acceptance Criteria:**
- [ ] `useRowMenu()` returns `{ config, setOrder, toggleHidden, reset }`.
- [ ] Mutating via the hook persists to `localStorage` (`sts2mm-row-menu`).
- [ ] `useRowMenu()` outside a provider falls back to `DEFAULT_ROW_MENU_CONFIG` (no throw) so stray renders are safe.
- [ ] `RowMenuProvider` wraps the app in `App.tsx` and is in `AllProviders`.

**Verify:** `npm test -- src/contexts/RowMenuContext.test.tsx` → all pass.

**Steps:**

- [ ] **Step 1: Write the failing tests**

```tsx
// src/contexts/RowMenuContext.test.tsx
import { describe, expect, it, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { RowMenuProvider, useRowMenu } from './RowMenuContext';
import { DEFAULT_ROW_MENU_CONFIG, loadRowMenuConfig } from '../lib/rowMenuConfig';

beforeEach(() => {
  try { localStorage.clear(); } catch { /* jsdom quirk */ }
});

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <RowMenuProvider>{children}</RowMenuProvider>
);

describe('useRowMenu', () => {
  it('starts from the default config', () => {
    const { result } = renderHook(() => useRowMenu(), { wrapper });
    expect(result.current.config).toEqual(DEFAULT_ROW_MENU_CONFIG);
  });

  it('toggleHidden updates config and persists', () => {
    const { result } = renderHook(() => useRowMenu(), { wrapper });
    act(() => result.current.toggleHidden('freeze'));
    expect(result.current.config.hidden).toContain('freeze');
    expect(loadRowMenuConfig().hidden).toContain('freeze');
  });

  it('setOrder updates config and persists', () => {
    const { result } = renderHook(() => useRowMenu(), { wrapper });
    const reversed = [...result.current.config.order].reverse();
    act(() => result.current.setOrder(reversed));
    expect(result.current.config.order).toEqual(reversed);
    expect(loadRowMenuConfig().order).toEqual(reversed);
  });

  it('reset restores the default config', () => {
    const { result } = renderHook(() => useRowMenu(), { wrapper });
    act(() => result.current.toggleHidden('freeze'));
    act(() => result.current.reset());
    expect(result.current.config).toEqual(DEFAULT_ROW_MENU_CONFIG);
  });

  it('falls back to default config when used without a provider', () => {
    const { result } = renderHook(() => useRowMenu());
    expect(result.current.config).toEqual(DEFAULT_ROW_MENU_CONFIG);
    // mutators are safe no-ops; calling them must not throw
    expect(() => act(() => result.current.toggleHidden('freeze'))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/contexts/RowMenuContext.test.tsx`
Expected: FAIL — `./RowMenuContext` not found.

- [ ] **Step 3: Implement the provider**

```tsx
// src/contexts/RowMenuContext.tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  DEFAULT_ROW_MENU_CONFIG,
  loadRowMenuConfig,
  saveRowMenuConfig,
  toggleHidden as toggleHiddenPure,
  type RowMenuConfig,
  type RowMenuItemId,
} from '../lib/rowMenuConfig';

interface RowMenuContextValue {
  config: RowMenuConfig;
  setOrder: (order: RowMenuItemId[]) => void;
  toggleHidden: (id: RowMenuItemId) => void;
  reset: () => void;
}

// Default value = safe fallback when a component renders outside the provider
// (e.g. an isolated unit test). Mutators are no-ops; config is the default.
const RowMenuContext = createContext<RowMenuContextValue>({
  config: DEFAULT_ROW_MENU_CONFIG,
  setOrder: () => {},
  toggleHidden: () => {},
  reset: () => {},
});

export function RowMenuProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<RowMenuConfig>(() => loadRowMenuConfig());

  useEffect(() => {
    saveRowMenuConfig(config);
  }, [config]);

  const value: RowMenuContextValue = {
    config,
    setOrder: (order) => setConfig((c) => ({ ...c, order })),
    toggleHidden: (id) => setConfig((c) => toggleHiddenPure(c, id)),
    reset: () => setConfig({ ...DEFAULT_ROW_MENU_CONFIG, order: [...DEFAULT_ROW_MENU_CONFIG.order] }),
  };

  return <RowMenuContext.Provider value={value}>{children}</RowMenuContext.Provider>;
}

export function useRowMenu(): RowMenuContextValue {
  return useContext(RowMenuContext);
}
```

- [ ] **Step 4: Wire the provider into `App.tsx`**

In `src/App.tsx`, add the import near the other context imports (after line 28):

```tsx
import { RowMenuProvider } from './contexts/RowMenuContext';
```

Wrap it just inside `ThemeProvider` (lines 80-88 become):

```tsx
  return (
    <ThemeProvider>
      <RowMenuProvider>
        <ToastProvider>
          <ConfirmProvider>
            <AppProvider>
              <AppInner />
            </AppProvider>
          </ConfirmProvider>
        </ToastProvider>
      </RowMenuProvider>
    </ThemeProvider>
  );
```

- [ ] **Step 5: Add the provider to `AllProviders`**

In `src/__test__/providers.tsx`, import and nest it so every component test gets it:

```tsx
import { RowMenuProvider } from '../contexts/RowMenuContext';
// ...
export function AllProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <RowMenuProvider>
        <ToastProvider>
          <ConfirmProvider>
            <AppProvider>{children}</AppProvider>
          </ConfirmProvider>
        </ToastProvider>
      </RowMenuProvider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 6: Run tests + full suite sanity**

Run: `npm test -- src/contexts/RowMenuContext.test.tsx`
Expected: PASS.
Run: `npm test -- src/App.test.tsx`
Expected: PASS (provider addition is transparent).

- [ ] **Step 7: Commit**

```bash
git add src/contexts/RowMenuContext.tsx src/contexts/RowMenuContext.test.tsx src/App.tsx src/__test__/providers.tsx
git commit -m "feat(row-menu): RowMenuProvider/useRowMenu + app + test wiring"
```

---

### Task 2: Fix Copy-version double-`v` (label + toast)

**Goal:** The Copy-version menu label and the post-copy toast each show a single `v`, regardless of whether `mod.version` already starts with `v`. Clipboard content is unchanged (raw `mod.version`).

**Files:**
- Modify: `src/components/LibraryRow.tsx:827` (label), `src/hooks/useModLibrary.tsx:426` (toast)
- Test: `src/components/LibraryRow.test.tsx`, `src/hooks/useModLibrary.test.tsx`

**Acceptance Criteria:**
- [ ] Menu label for a `v`-prefixed version reads `Copy version (v1.2.3)` (one `v`), and for a bare version also `Copy version (v1.2.3)`.
- [ ] Toast reads `Copied v1.0.0` for both `v1.0.0` and `1.0.0`.
- [ ] Clipboard still receives the raw `mod.version` value.
- [ ] No locale files changed.

**Verify:** `npm test -- src/components/LibraryRow.test.tsx src/hooks/useModLibrary.test.tsx` → all pass.

**Steps:**

- [ ] **Step 1: Write the failing label test** (add to `src/components/LibraryRow.test.tsx`, in the kebab `describe`)

```tsx
it('kebab → Copy version label strips a leading v (no double-v)', async () => {
  const user = userEvent.setup();
  renderRow({ mod: baseModInfo({ version: 'v1.2.3' }) });
  await user.click(screen.getByRole('button', { name: /mod actions/i }));
  const item = screen.getByRole('menuitem', { name: /copy version/i });
  expect(item).toHaveTextContent('Copy version (v1.2.3)');
  expect(item).not.toHaveTextContent('vv1.2.3');
});
```

> Note: `baseModInfo` is the existing `ModInfo` factory in this test file. If it doesn't accept `version`, extend it to spread overrides (it already takes `overrides`).

- [ ] **Step 2: Write the failing toast test** (add to `src/hooks/useModLibrary.test.tsx`)

```tsx
it('handleCopyVersion copies the raw version but shows a single-v toast', async () => {
  // jsdom 27: patch Clipboard.prototype.writeText, not navigator.clipboard.
  const writeText = vi.fn().mockResolvedValue(undefined);
  const proto = (globalThis.Clipboard && globalThis.Clipboard.prototype) as Clipboard | undefined;
  if (proto) {
    Object.defineProperty(proto, 'writeText', { configurable: true, value: writeText });
  } else {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  }

  const { result } = renderHook(() => useModLibrary(), { wrapper: AllProviders });
  await act(async () => {
    await result.current.handleCopyVersion(makeMod({ version: 'v1.0.0' }));
  });

  expect(writeText).toHaveBeenCalledWith('v1.0.0'); // clipboard unchanged: raw version
  await waitFor(() => expect(screen.getByText('Copied v1.0.0')).toBeInTheDocument());
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/components/LibraryRow.test.tsx src/hooks/useModLibrary.test.tsx`
Expected: FAIL — label shows `vv1.2.3`; toast shows `Copied vv1.0.0`.

- [ ] **Step 4: Fix the label** (`src/components/LibraryRow.tsx:827`)

```tsx
          <KebabItem icon={<Copy size={12} />} onClick={onCopyVersion}>
            {t('mods.copyVersion', { version: mod.version.replace(/^v/i, '') })}
          </KebabItem>
```

- [ ] **Step 5: Fix the toast** (`src/hooks/useModLibrary.tsx:424-429`)

```tsx
  async function handleCopyVersion(mod: ModInfo) {
    await copyToClipboard(mod.version, 'version', {
      successMessage: t('mods.toast.versionCopied', { version: mod.version.replace(/^v/i, '') }),
      failureMessage: 'mods.toast.couldNotCopy',
    });
  }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -- src/components/LibraryRow.test.tsx src/hooks/useModLibrary.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/LibraryRow.tsx src/hooks/useModLibrary.tsx src/components/LibraryRow.test.tsx src/hooks/useModLibrary.test.tsx
git commit -m "fix(mods): strip leading v from Copy-version label + toast (no double-v)"
```

---

### Task 3: Descriptor-driven kebab (remove Edit-sources, config order/hide, locked Delete + Customize footer)

**Goal:** Replace `LibraryRowKebab`'s hardcoded JSX with a descriptor map rendered in the user's configured order (minus hidden, minus unavailable) as a flat list; remove the legacy "Edit sources…" item; pin a locked Delete (packScoped) and a locked "Customize menu…" footer that dispatches the deep-link event.

**Files:**
- Modify: `src/components/LibraryRow.tsx` (the `LibraryRowKebab` function + imports)
- Modify: `src/components/LibraryRow.test.tsx` (remove Edit-sources test; add order/hide/lock/availability/customize-event tests)
- Modify: `src/i18n/locales/{en,zh-Hans,ru,ar}.json` (add `mods.customizeMenu`, `mods.customizeMenuDesc`)

**Acceptance Criteria:**
- [ ] No "Edit sources" item in the kebab; row-click still opens the SourceEditor (unchanged).
- [ ] Items render in `config.order`; hiding an id removes it; reordering reorders the DOM.
- [ ] Contextually-unavailable items don't render (no `github_url` → no "View on GitHub", etc.).
- [ ] In packScoped, "Delete from disk" is the last item before "Customize menu…", and is unaffected by config.
- [ ] "Customize menu…" is always present, always last, and dispatches `ROW_MENU_OPEN_EVENT`.
- [ ] Renders correctly in light theme (manual check — no hardcoded dark-only colors introduced).

**Verify:** `npm test -- src/components/LibraryRow.test.tsx` → all pass; `npm test -- src/i18n/locales/parity.test.ts` → pass.

**Steps:**

- [ ] **Step 1: Add the i18n keys (all four locales)**

`en.json` (in the `mods` object, near `copyVersion`):
```json
    "customizeMenu": "Customize menu…",
    "customizeMenuDesc": "Choose which items show and reorder them",
```
`zh-Hans.json`:
```json
    "customizeMenu": "自定义菜单…",
    "customizeMenuDesc": "选择显示哪些项目并重新排序",
```
`ru.json`:
```json
    "customizeMenu": "Настроить меню…",
    "customizeMenuDesc": "Выберите, какие пункты показывать, и измените порядок",
```
`ar.json`:
```json
    "customizeMenu": "تخصيص القائمة…",
    "customizeMenuDesc": "اختر العناصر التي تظهر وأعد ترتيبها",
```

- [ ] **Step 2: Update the failing kebab tests** in `src/components/LibraryRow.test.tsx`

Remove the existing `kebab → Edit sources fires onEditSources` test (~line 441). Add:

```tsx
import { ROW_MENU_STORAGE_KEY } from '../lib/rowMenuConfig';

it('kebab no longer shows a legacy Edit sources item', async () => {
  const user = userEvent.setup();
  renderRow({ mod: baseModInfo() });
  await user.click(screen.getByRole('button', { name: /mod actions/i }));
  expect(screen.queryByRole('menuitem', { name: /edit sources/i })).toBeNull();
});

it('kebab hides an item the user has hidden', async () => {
  localStorage.setItem(
    ROW_MENU_STORAGE_KEY,
    JSON.stringify({ order: ['copyVersion', 'freeze'], hidden: ['freeze'] }),
  );
  const user = userEvent.setup();
  renderRow({ mod: baseModInfo() });
  await user.click(screen.getByRole('button', { name: /mod actions/i }));
  expect(screen.getByRole('menuitem', { name: /copy version/i })).toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: /freeze this mod/i })).toBeNull();
});

it('kebab renders items in the user-configured order', async () => {
  localStorage.setItem(
    ROW_MENU_STORAGE_KEY,
    JSON.stringify({ order: ['freeze', 'copyVersion'], hidden: [] }),
  );
  const user = userEvent.setup();
  renderRow({ mod: baseModInfo() });
  await user.click(screen.getByRole('button', { name: /mod actions/i }));
  const items = screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');
  const freezeIdx = items.findIndex((t) => /freeze this mod/i.test(t));
  const copyIdx = items.findIndex((t) => /copy version/i.test(t));
  expect(freezeIdx).toBeGreaterThanOrEqual(0);
  expect(freezeIdx).toBeLessThan(copyIdx);
});

it('kebab omits contextual items when their predicate is false', async () => {
  const user = userEvent.setup();
  renderRow({ mod: baseModInfo({ github_url: null, nexus_url: null }) });
  await user.click(screen.getByRole('button', { name: /mod actions/i }));
  expect(screen.queryByRole('menuitem', { name: /view on github/i })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: /view on nexus/i })).toBeNull();
});

it('Customize menu… is always present, last, and dispatches the open event', async () => {
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  const user = userEvent.setup();
  renderRow({ mod: baseModInfo() });
  await user.click(screen.getByRole('button', { name: /mod actions/i }));
  const items = screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');
  expect(items[items.length - 1]).toMatch(/customize menu/i);
  await user.click(screen.getByRole('menuitem', { name: /customize menu/i }));
  expect(dispatch).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'sts2mm:open-row-menu-settings' }),
  );
  dispatch.mockRestore();
});

it('packScoped pins Delete from disk just above Customize menu…', async () => {
  const user = userEvent.setup();
  renderRow({ mod: baseModInfo(), packScoped: true, onDelete: vi.fn() });
  await user.click(screen.getByRole('button', { name: /mod actions/i }));
  const items = screen.getAllByRole('menuitem').map((el) => el.textContent ?? '');
  const delIdx = items.findIndex((t) => /delete from disk/i.test(t));
  const custIdx = items.findIndex((t) => /customize menu/i.test(t));
  expect(delIdx).toBeGreaterThanOrEqual(0);
  expect(delIdx).toBe(custIdx - 1);
});
```

- [ ] **Step 2b: Run tests to verify they fail**

Run: `npm test -- src/components/LibraryRow.test.tsx`
Expected: FAIL — Edit-sources still present, no Customize item, order/hide not honored.

- [ ] **Step 3: Replace `LibraryRowKebab`** in `src/components/LibraryRow.tsx`

Add imports: include `SlidersHorizontal` in the `lucide-react` import block, and at the top of the file add:
```tsx
import { useRowMenu } from '../contexts/RowMenuContext';
import {
  resolveRowMenuOrder,
  ROW_MENU_OPEN_EVENT,
  type RowMenuItemId,
} from '../lib/rowMenuConfig';
```

Replace the entire `LibraryRowKebab` function body (lines ~748-946) with:

```tsx
function LibraryRowKebab(props: LibraryRowKebabProps) {
  const { t } = useTranslation();
  const { config } = useRowMenu();
  const {
    mod,
    audit,
    modpackName,
    state,
    packScoped,
    isUpdating,
    isRepairing,
    isRollingBack,
    anyRecoveryInFlight,
    membershipSaving,
    gameRunning,
    onToggleMembership,
    onTogglePin,
    onSnooze,
    onUnsnooze,
    onCopyVersion,
    onOpenThisModFolder,
    onFindGithubFromNexus,
    onAutoDetectSource,
    onRepair,
    onRollback,
    onDelete,
    onOpenExternalUrl,
  } = props;

  // Membership classification (in / includedOff / notIn) — null hides the item.
  let membershipChip: 'in' | 'includedOff' | 'notIn' | null = null;
  if (modpackName && state) {
    if (!state.included) membershipChip = 'notIn';
    else if (state.enabled) membershipChip = 'in';
    else membershipChip = 'includedOff';
  }

  const canSnooze =
    !!audit?.snoozed ||
    (!!audit?.needs_update && !!audit.latest_release_with_assets_tag);

  // One descriptor per customizable id: contextual availability + how to render.
  const descriptors: Record<RowMenuItemId, { available: boolean; render: () => ReactNode }> = {
    membership: {
      available: !packScoped && !!modpackName && !!membershipChip,
      render: () => (
        <KebabItem
          key="membership"
          icon={membershipChip === 'notIn' ? <ToggleRight size={12} /> : <ToggleLeft size={12} />}
          onClick={onToggleMembership}
          disabled={membershipSaving || !state?.editable}
          description={
            membershipChip === 'notIn'
              ? t('mods.kebab.addToModpackDesc', { pack: modpackName })
              : t('mods.kebab.removeFromModpackDesc', { pack: modpackName })
          }
        >
          {membershipChip === 'notIn'
            ? t('mods.kebab.addToModpack', { pack: modpackName })
            : t('mods.kebab.removeFromModpack', { pack: modpackName })}
        </KebabItem>
      ),
    },
    copyVersion: {
      available: true,
      render: () => (
        <KebabItem key="copyVersion" icon={<Copy size={12} />} onClick={onCopyVersion}>
          {t('mods.copyVersion', { version: mod.version.replace(/^v/i, '') })}
        </KebabItem>
      ),
    },
    openFolder: {
      available: true,
      render: () => (
        <KebabItem key="openFolder" icon={<FolderOpen size={12} />} onClick={onOpenThisModFolder}>
          {t('mods.openThisModFolder')}
        </KebabItem>
      ),
    },
    snooze: {
      available: canSnooze,
      render: () =>
        audit?.snoozed ? (
          <KebabItem
            key="snooze"
            icon={<Check size={12} />}
            onClick={onUnsnooze}
            description={t('mods.unsnoozeDesc')}
          >
            {t('mods.unsnoozeUpdate')}
          </KebabItem>
        ) : (
          <KebabItem
            key="snooze"
            icon={<Clock size={12} />}
            onClick={onSnooze}
            description={t('mods.snoozeDesc', {
              version: audit?.latest_release_with_assets_tag?.replace(/^v/, '') ?? '?',
            })}
          >
            {t('mods.snoozeUpdate')}
          </KebabItem>
        ),
    },
    autoDetect: {
      available: true,
      render: () => (
        <KebabItem key="autoDetect" icon={<Search size={12} />} onClick={onAutoDetectSource}>
          {t('mods.autoDetectSourceOne')}
        </KebabItem>
      ),
    },
    viewGithub: {
      available: !!mod.github_url,
      render: () => (
        <KebabItem
          key="viewGithub"
          icon={<GitBranch size={12} />}
          onClick={() => onOpenExternalUrl(mod.github_url!)}
        >
          {t('mods.viewOnGitHubKebab')}
        </KebabItem>
      ),
    },
    viewNexus: {
      available: !!mod.nexus_url,
      render: () => (
        <KebabItem
          key="viewNexus"
          icon={<ExternalLink size={12} />}
          onClick={() => onOpenExternalUrl(mod.nexus_url!)}
        >
          {t('mods.viewOnNexusKebab')}
        </KebabItem>
      ),
    },
    findGithub: {
      available: !!mod.nexus_url && !mod.github_url,
      render: () => (
        <KebabItem key="findGithub" icon={<GitBranch size={12} />} onClick={onFindGithubFromNexus}>
          {t('mods.findGitHubFromNexus')}
        </KebabItem>
      ),
    },
    freeze: {
      available: true,
      render: () => (
        <KebabItem
          key="freeze"
          icon={mod.pinned ? <Sun size={12} /> : <Snowflake size={12} />}
          onClick={onTogglePin}
          description={mod.pinned ? t('mods.unpinDesc') : t('mods.pinDesc')}
        >
          {mod.pinned ? t('mods.unpinThisMod') : t('mods.pinThisMod')}
        </KebabItem>
      ),
    },
    repair: {
      available: true,
      render: () => (
        <KebabItem
          key="repair"
          icon={isRepairing ? <RefreshCw size={12} className="animate-spin" /> : <Wrench size={12} />}
          onClick={onRepair}
          disabled={gameRunning || anyRecoveryInFlight || !mod.github_url || isUpdating}
          description={mod.github_url ? t('mods.repairDesc') : t('mods.repairNeedSource')}
        >
          {isRepairing ? t('mods.repairing') : t('mods.repairThisMod')}
        </KebabItem>
      ),
    },
    rollback: {
      available: true,
      render: () => (
        <KebabItem
          key="rollback"
          icon={isRollingBack ? <RefreshCw size={12} className="animate-spin" /> : <RotateCcw size={12} />}
          onClick={onRollback}
          disabled={gameRunning || anyRecoveryInFlight || !mod.github_url || isUpdating}
          description={mod.github_url ? t('mods.rollbackDesc') : t('mods.rollbackNeedSource')}
        >
          {isRollingBack ? t('mods.rollingBack') : t('mods.rollBackOneVersion')}
        </KebabItem>
      ),
    },
  };

  const availableIds = new Set<RowMenuItemId>(
    (Object.keys(descriptors) as RowMenuItemId[]).filter((id) => descriptors[id].available),
  );
  const orderedIds = resolveRowMenuOrder(config, availableIds);

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <KebabMenu title={t('mods.modActions')}>
        <KebabSection>{orderedIds.map((id) => descriptors[id].render())}</KebabSection>
        {/* Locked danger item — disk delete, modpack view only, pinned bottom. */}
        {packScoped && (
          <>
            <KebabDivider />
            <KebabSection>
              <KebabItem
                danger
                icon={<Trash2 size={12} />}
                onClick={onDelete}
                disabled={gameRunning}
                description={t('mods.kebab.deleteFromDiskDesc')}
              >
                {t('mods.kebab.deleteFromDisk')}
              </KebabItem>
            </KebabSection>
          </>
        )}
        {/* Locked footer — always last; opens the Settings customizer. */}
        <KebabDivider />
        <KebabSection>
          <KebabItem
            icon={<SlidersHorizontal size={12} />}
            onClick={() => window.dispatchEvent(new CustomEvent(ROW_MENU_OPEN_EVENT))}
            description={t('mods.customizeMenuDesc')}
          >
            {t('mods.customizeMenu')}
          </KebabItem>
        </KebabSection>
      </KebabMenu>
    </div>
  );
}
```

Also: remove the now-unused `LinkIcon` import if nothing else in the file uses it (search the file for `LinkIcon`; the row's source pills use `GitBranch`/`ExternalLink`, not `LinkIcon` — confirm before deleting). The `onEditSources` prop stays in the interface (the row body still calls it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/components/LibraryRow.test.tsx src/i18n/locales/parity.test.ts`
Expected: PASS. If `tsc` flags `LinkIcon` unused, remove it from the import.

- [ ] **Step 5: Commit**

```bash
git add src/components/LibraryRow.tsx src/components/LibraryRow.test.tsx src/i18n/locales/en.json src/i18n/locales/zh-Hans.json src/i18n/locales/ru.json src/i18n/locales/ar.json
git commit -m "feat(row-menu): config-driven flat kebab; drop legacy Edit-sources; locked Delete + Customize footer"
```

---

### Task 4: Settings customizer card (`RowMenuCustomizer`)

**Goal:** A Settings → General card listing the 11 customizable items with a show/hide toggle and native drag-and-drop reorder, plus a Reset button and a locked-items caption. Edits flow through `useRowMenu()`.

**Files:**
- Create: `src/components/RowMenuCustomizer.tsx`
- Test: `src/components/RowMenuCustomizer.test.tsx`
- Modify: `src/views/Settings.tsx` (render the card in the General tab)
- Modify: `src/i18n/locales/{en,zh-Hans,ru,ar}.json` (add `settings.rowMenu.*`)
- Modify: `src/styles.css` (list + drag-handle + locked-row styles)

**Acceptance Criteria:**
- [ ] Lists all 11 customizable items, in `config.order`, each with an icon, a neutral label, and a visibility toggle.
- [ ] Toggling a row's switch hides/shows that id (persists).
- [ ] Dragging a row onto another reorders (persists) via `moveItem`.
- [ ] "Reset to default" restores `DEFAULT_ROW_MENU_CONFIG`.
- [ ] Locked items (Delete, Customize) appear as a disabled, non-draggable footer with an explanatory caption.
- [ ] Renders correctly in light theme (manual check).

**Verify:** `npm test -- src/components/RowMenuCustomizer.test.tsx src/i18n/locales/parity.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Add the i18n keys (all four locales)**

`en.json` — add a `rowMenu` object inside `settings`:
```json
    "rowMenu": {
      "title": "Mod menu",
      "desc": "Choose which actions appear in each mod's ⋯ menu, and drag to reorder them.",
      "reset": "Reset to default",
      "lockedCaption": "Delete and Customize are always pinned to the bottom.",
      "visibleAria": "Show {{item}} in the menu",
      "dragAria": "Drag to reorder {{item}}",
      "items": {
        "membership": "Add / remove from modpack",
        "copyVersion": "Copy version",
        "openFolder": "Open mod folder",
        "snooze": "Snooze update",
        "autoDetect": "Auto-detect source",
        "viewGithub": "View on GitHub",
        "viewNexus": "View on Nexus",
        "findGithub": "Find GitHub from Nexus",
        "freeze": "Freeze",
        "repair": "Repair",
        "rollback": "Roll back one version",
        "delete": "Delete from disk",
        "customize": "Customize menu"
      }
    },
```
`zh-Hans.json`:
```json
    "rowMenu": {
      "title": "模组菜单",
      "desc": "选择每个模组的 ⋯ 菜单中显示哪些操作，并拖动以重新排序。",
      "reset": "恢复默认",
      "lockedCaption": "“删除”和“自定义”始终固定在底部。",
      "visibleAria": "在菜单中显示{{item}}",
      "dragAria": "拖动以重新排序{{item}}",
      "items": {
        "membership": "添加/移出整合包",
        "copyVersion": "复制版本",
        "openFolder": "打开模组文件夹",
        "snooze": "暂缓更新",
        "autoDetect": "自动检测来源",
        "viewGithub": "在 GitHub 上查看",
        "viewNexus": "在 Nexus 上查看",
        "findGithub": "从 Nexus 查找 GitHub",
        "freeze": "冻结",
        "repair": "修复",
        "rollback": "回滚一个版本",
        "delete": "从磁盘删除",
        "customize": "自定义菜单"
      }
    },
```
`ru.json`:
```json
    "rowMenu": {
      "title": "Меню мода",
      "desc": "Выберите, какие действия отображаются в меню ⋯ каждого мода, и перетащите для изменения порядка.",
      "reset": "Сбросить по умолчанию",
      "lockedCaption": "«Удалить» и «Настроить» всегда закреплены внизу.",
      "visibleAria": "Показывать «{{item}}» в меню",
      "dragAria": "Перетащите, чтобы изменить порядок «{{item}}»",
      "items": {
        "membership": "Добавить / убрать из сборки",
        "copyVersion": "Копировать версию",
        "openFolder": "Открыть папку мода",
        "snooze": "Отложить обновление",
        "autoDetect": "Автоопределение источника",
        "viewGithub": "Открыть на GitHub",
        "viewNexus": "Открыть на Nexus",
        "findGithub": "Найти GitHub по Nexus",
        "freeze": "Заморозить",
        "repair": "Восстановить",
        "rollback": "Откатить на версию назад",
        "delete": "Удалить с диска",
        "customize": "Настроить меню"
      }
    },
```
`ar.json`:
```json
    "rowMenu": {
      "title": "قائمة التعديل",
      "desc": "اختر الإجراءات التي تظهر في قائمة ⋯ لكل تعديل، واسحب لإعادة الترتيب.",
      "reset": "إعادة التعيين إلى الافتراضي",
      "lockedCaption": "‏«حذف» و«تخصيص» مثبّتان دائمًا في الأسفل.",
      "visibleAria": "إظهار {{item}} في القائمة",
      "dragAria": "اسحب لإعادة ترتيب {{item}}",
      "items": {
        "membership": "إضافة / إزالة من الحزمة",
        "copyVersion": "نسخ النسخة",
        "openFolder": "فتح مجلد التعديل",
        "snooze": "تأجيل التحديث",
        "autoDetect": "اكتشاف المصدر تلقائيًا",
        "viewGithub": "عرض على GitHub",
        "viewNexus": "عرض على Nexus",
        "findGithub": "البحث عن GitHub من Nexus",
        "freeze": "تجميد",
        "repair": "إصلاح",
        "rollback": "التراجع نسخة واحدة",
        "delete": "حذف من القرص",
        "customize": "تخصيص القائمة"
      }
    },
```
> If a sibling key like `settings.theme` follows `settings.rowMenu` alphabetically, placement inside `settings` doesn't matter to i18next — only that all four files contain the identical key set. Run the parity test after editing.

- [ ] **Step 2: Write the failing component tests**

```tsx
// src/components/RowMenuCustomizer.test.tsx
import { describe, expect, it, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RowMenuCustomizer } from './RowMenuCustomizer';
import { AllProviders } from '../__test__/providers';
import { ROW_MENU_STORAGE_KEY, loadRowMenuConfig } from '../lib/rowMenuConfig';

beforeEach(() => {
  try { localStorage.clear(); } catch { /* jsdom quirk */ }
});

function renderCustomizer() {
  return render(<AllProviders><RowMenuCustomizer /></AllProviders>);
}

describe('<RowMenuCustomizer>', () => {
  it('lists all 11 customizable items', () => {
    renderCustomizer();
    const list = screen.getByTestId('row-menu-customizer-list');
    expect(within(list).getAllByTestId(/^row-menu-item-/)).toHaveLength(11);
  });

  it('toggling a switch hides that id and persists', async () => {
    const user = userEvent.setup();
    renderCustomizer();
    const toggle = screen.getByRole('switch', { name: /show freeze in the menu/i });
    await user.click(toggle);
    expect(loadRowMenuConfig().hidden).toContain('freeze');
  });

  it('reset restores the default config', async () => {
    localStorage.setItem(ROW_MENU_STORAGE_KEY, JSON.stringify({ order: ['freeze'], hidden: ['freeze'] }));
    const user = userEvent.setup();
    renderCustomizer();
    await user.click(screen.getByRole('button', { name: /reset to default/i }));
    expect(loadRowMenuConfig().hidden).toEqual([]);
  });

  it('drag-drop reorders and persists', () => {
    renderCustomizer();
    const rows = screen.getAllByTestId(/^row-menu-item-/);
    const firstId = rows[0].getAttribute('data-item-id')!;
    const thirdId = rows[2].getAttribute('data-item-id')!;
    const dt = { setData: () => {}, getData: () => '', dropEffect: '', effectAllowed: '' };
    // drag row 0 onto row 2
    fireEvent.dragStart(rows[0], { dataTransfer: dt });
    fireEvent.dragOver(rows[2], { dataTransfer: dt });
    fireEvent.drop(rows[2], { dataTransfer: dt });
    const order = loadRowMenuConfig().order;
    expect(order.indexOf(firstId as never)).toBeGreaterThan(order.indexOf(thirdId as never));
  });

  it('shows locked items as a disabled footer', () => {
    renderCustomizer();
    const locked = screen.getByTestId('row-menu-locked');
    expect(within(locked).getByText(/delete from disk/i)).toBeInTheDocument();
    expect(within(locked).getByText(/customize menu/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/components/RowMenuCustomizer.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 4: Implement `RowMenuCustomizer`**

```tsx
// src/components/RowMenuCustomizer.tsx
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Copy, FolderOpen, Clock, Search, GitBranch, ExternalLink, Snowflake,
  Wrench, RotateCcw, ToggleRight, Trash2, SlidersHorizontal, GripVertical,
} from 'lucide-react';
import { Button } from './Button';
import { Toggle } from './Toggle';
import { useRowMenu } from '../contexts/RowMenuContext';
import { moveItem, type RowMenuItemId } from '../lib/rowMenuConfig';

const ITEM_ICONS: Record<string, ReactNode> = {
  membership: <ToggleRight size={13} />,
  copyVersion: <Copy size={13} />,
  openFolder: <FolderOpen size={13} />,
  snooze: <Clock size={13} />,
  autoDetect: <Search size={13} />,
  viewGithub: <GitBranch size={13} />,
  viewNexus: <ExternalLink size={13} />,
  findGithub: <GitBranch size={13} />,
  freeze: <Snowflake size={13} />,
  repair: <Wrench size={13} />,
  rollback: <RotateCcw size={13} />,
  delete: <Trash2 size={13} />,
  customize: <SlidersHorizontal size={13} />,
};

const LOCKED_IDS = ['delete', 'customize'] as const;

export function RowMenuCustomizer() {
  const { t } = useTranslation();
  const { config, setOrder, toggleHidden, reset } = useRowMenu();
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  const label = (id: string) => t(`settings.rowMenu.items.${id}`);

  function handleDrop(targetIndex: number) {
    if (dragIndex === null || dragIndex === targetIndex) return;
    setOrder(moveItem(config.order, dragIndex, targetIndex));
    setDragIndex(null);
  }

  return (
    <div className="space-y-3">
      <div className="gf-set-desc" style={{ marginTop: -6 }}>{t('settings.rowMenu.desc')}</div>
      <ul className="gf-row-menu-list" data-testid="row-menu-customizer-list">
        {config.order.map((id, index) => {
          const hidden = config.hidden.includes(id);
          return (
            <li
              key={id}
              data-testid={`row-menu-item-${id}`}
              data-item-id={id}
              className={`gf-row-menu-item${hidden ? ' is-hidden' : ''}`}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => handleDrop(index)}
              onDragEnd={() => setDragIndex(null)}
            >
              <span
                className="gf-row-menu-grip"
                aria-label={t('settings.rowMenu.dragAria', { item: label(id) })}
              >
                <GripVertical size={14} />
              </span>
              <span className="gf-row-menu-ico">{ITEM_ICONS[id]}</span>
              <span className="gf-row-menu-label">{label(id)}</span>
              <Toggle
                checked={!hidden}
                onChange={() => toggleHidden(id as RowMenuItemId)}
                ariaLabel={t('settings.rowMenu.visibleAria', { item: label(id) })}
              />
            </li>
          );
        })}
      </ul>

      <div className="gf-row-menu-locked" data-testid="row-menu-locked">
        {LOCKED_IDS.map((id) => (
          <div key={id} className="gf-row-menu-item is-locked" aria-disabled>
            <span className="gf-row-menu-grip" aria-hidden><GripVertical size={14} /></span>
            <span className="gf-row-menu-ico">{ITEM_ICONS[id]}</span>
            <span className="gf-row-menu-label">{label(id)}</span>
          </div>
        ))}
        <div className="gf-help muted"><span>{t('settings.rowMenu.lockedCaption')}</span></div>
      </div>

      <Button variant="secondary" size="sm" onClick={reset}>
        {t('settings.rowMenu.reset')}
      </Button>
    </div>
  );
}
```

> Verify the `Toggle` component's prop names before finalizing — `LibraryRow.tsx` uses `<Toggle checked onChange ariaLabel title />`. If `Toggle` exposes `role="switch"`, the test's `getByRole('switch')` works; if not, change the test to query by the toggle's accessible name via `getByLabelText`. Open `src/components/Toggle.tsx` to confirm.

- [ ] **Step 5: Render the card in Settings → General**

In `src/views/Settings.tsx`, import the component (near the other component imports):
```tsx
import { RowMenuCustomizer } from '../components/RowMenuCustomizer';
import { SlidersHorizontal } from 'lucide-react'; // add to the existing lucide import
```
Add a `<Card>` in the `tab === 'general'` block, after the Theme card (after line ~571) and before `<AboutCard />`:
```tsx
            <Card className="space-y-4" style={{ marginTop: 8 }}>
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <SlidersHorizontal size={16} />
                {t('settings.rowMenu.title')}
              </h3>
              <RowMenuCustomizer />
            </Card>
```

- [ ] **Step 6: Add styles** to `src/styles.css` (append near other `gf-` component styles; uses theme CSS vars so light theme works):

```css
.gf-row-menu-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.gf-row-menu-item {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 7px;
  border: 1px solid var(--indigo-line); background: var(--indigo-panel);
}
.gf-row-menu-item.is-hidden { opacity: 0.55; }
.gf-row-menu-item.is-locked { opacity: 0.6; cursor: default; }
.gf-row-menu-grip { display: inline-flex; cursor: grab; color: var(--ink-mute); }
.gf-row-menu-item.is-locked .gf-row-menu-grip { cursor: default; visibility: hidden; }
.gf-row-menu-ico { display: inline-flex; color: var(--ink-mute); }
.gf-row-menu-label { flex: 1; min-width: 0; font-size: 13px; color: var(--ink); }
.gf-row-menu-locked { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- src/components/RowMenuCustomizer.test.tsx src/i18n/locales/parity.test.ts`
Expected: PASS. If the drag test is flaky in jsdom, assert against the `setOrder`-persisted `loadRowMenuConfig().order` (as written) rather than DOM position.

- [ ] **Step 8: Commit**

```bash
git add src/components/RowMenuCustomizer.tsx src/components/RowMenuCustomizer.test.tsx src/views/Settings.tsx src/styles.css src/i18n/locales/en.json src/i18n/locales/zh-Hans.json src/i18n/locales/ru.json src/i18n/locales/ar.json
git commit -m "feat(row-menu): Settings customizer card (drag reorder + show/hide + reset)"
```

---

### Task 5: Deep-link "Customize menu…" → Settings (event receiver + scroll/highlight)

**Goal:** Dispatching `ROW_MENU_OPEN_EVENT` (from the kebab's Customize item) routes the app to Settings → General and scrolls/highlights the customizer card.

**Files:**
- Modify: `src/App.tsx` (event listener + `openRowMenuSettingsSignal` state → `SettingsView`)
- Modify: `src/views/Settings.tsx` (accept the signal; ref + scroll + highlight the card)
- Modify: `src/App.test.tsx` (event navigates to Settings)
- Modify: `src/views/Settings.test.tsx` (signal scrolls/highlights the card)
- Modify: `src/styles.css` (highlight-pulse keyframe)

**Acceptance Criteria:**
- [ ] Dispatching `ROW_MENU_OPEN_EVENT` switches `activeView` to `settings`.
- [ ] On signal bump, `SettingsView` selects the `general` tab and scrolls the customizer card into view with a brief highlight.
- [ ] No regression to existing App/Settings tests.

**Verify:** `npm test -- src/App.test.tsx src/views/Settings.test.tsx` → all pass.

**Steps:**

- [ ] **Step 1: Write the failing App test** (add to `src/App.test.tsx`)

```tsx
import { ROW_MENU_OPEN_EVENT } from '../lib/rowMenuConfig';

it('opening the row-menu customizer event navigates to Settings', async () => {
  render(<App />); // App self-wraps providers
  act(() => { window.dispatchEvent(new CustomEvent(ROW_MENU_OPEN_EVENT)); });
  expect(await screen.findByRole('heading', { name: /mod menu/i })).toBeInTheDocument();
});
```
> Match the existing App.test render/setup (it may use a helper). Reuse the file's conventions; the assertion is what matters: the "Mod menu" card heading appears (proves Settings → General rendered).

- [ ] **Step 2: Write the failing Settings test** (add to `src/views/Settings.test.tsx`)

```tsx
it('scrolls + highlights the customizer card when the open signal bumps', () => {
  const scrollSpy = vi.fn();
  Element.prototype.scrollIntoView = scrollSpy;
  const { rerender } = render(<AllProviders><SettingsView openRowMenuSettingsSignal={0} /></AllProviders>);
  rerender(<AllProviders><SettingsView openRowMenuSettingsSignal={1} /></AllProviders>);
  expect(scrollSpy).toHaveBeenCalled();
  expect(screen.getByTestId('row-menu-card')).toHaveClass('gf-row-menu-card-flash');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/App.test.tsx src/views/Settings.test.tsx`
Expected: FAIL — no listener / no signal prop.

- [ ] **Step 4: Implement the App side** (`src/App.tsx`)

Add state near the other signals (after line ~117):
```tsx
  const [openRowMenuSettingsSignal, setOpenRowMenuSettingsSignal] = useState(0);
```
Add a listener effect (near the other `useEffect`s; import `ROW_MENU_OPEN_EVENT` from `./lib/rowMenuConfig`):
```tsx
  useEffect(() => {
    function onOpen() {
      setActiveView('settings');
      setOpenRowMenuSettingsSignal((n) => n + 1);
    }
    window.addEventListener(ROW_MENU_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(ROW_MENU_OPEN_EVENT, onOpen);
  }, []);
```
Pass the signal to the Settings view (line ~971):
```tsx
            {activeView === 'settings' && (
              <SettingsView openRowMenuSettingsSignal={openRowMenuSettingsSignal} />
            )}
```

- [ ] **Step 5: Implement the Settings side** (`src/views/Settings.tsx`)

Change the signature + add a ref + effect:
```tsx
export function SettingsView({ openRowMenuSettingsSignal = 0 }: { openRowMenuSettingsSignal?: number }) {
  // ...existing hooks...
  const rowMenuCardRef = useRef<HTMLDivElement>(null);
  const [rowMenuFlash, setRowMenuFlash] = useState(false);

  useEffect(() => {
    if (openRowMenuSettingsSignal === 0) return;
    setTab('general');
    // Defer one frame so the general tab content is mounted before we scroll.
    const id = setTimeout(() => {
      rowMenuCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setRowMenuFlash(true);
      setTimeout(() => setRowMenuFlash(false), 1200);
    }, 0);
    return () => clearTimeout(id);
  }, [openRowMenuSettingsSignal]);
```
Add `useRef` to the React import. Give the customizer `<Card>` the ref + flash class + testid:
```tsx
            <Card
              ref={rowMenuCardRef}
              data-testid="row-menu-card"
              className={`space-y-4${rowMenuFlash ? ' gf-row-menu-card-flash' : ''}`}
              style={{ marginTop: 8 }}
            >
```
> Confirm `Card` forwards `ref` + `data-testid`. If `Card` does not forward refs, wrap it in a `<div ref={rowMenuCardRef} data-testid="row-menu-card" className={rowMenuFlash ? 'gf-row-menu-card-flash' : ''}>…</div>` instead and move the testid/flash to that div. Check `src/components/Card.tsx` first.

- [ ] **Step 6: Add the highlight keyframe** to `src/styles.css`:
```css
@keyframes gf-row-menu-flash {
  0% { box-shadow: 0 0 0 0 color-mix(in oklch, var(--gf) 55%, transparent); }
  100% { box-shadow: 0 0 0 8px transparent; }
}
.gf-row-menu-card-flash { animation: gf-row-menu-flash 1.1s ease-out; }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npm test -- src/App.test.tsx src/views/Settings.test.tsx`
Expected: PASS.

- [ ] **Step 8: Full suite + typecheck + coverage**

Run: `npm test`
Run: `npm run build` (or the repo's `tsc`/lint script — check `package.json`)
Expected: all tests pass; coverage stays ≥ 96/96/90.

- [ ] **Step 9: Commit**

```bash
git add src/App.tsx src/views/Settings.tsx src/App.test.tsx src/views/Settings.test.tsx src/styles.css
git commit -m "feat(row-menu): deep-link Customize menu… to Settings customizer card"
```

---

## Manual verification (after Task 5)

- [ ] Launch the app (`npm run tauri dev` or the project's run skill). Open a mod's ⋯ menu → confirm flat list, no "Edit sources", Freeze sits low, Customize menu… is last.
- [ ] Copy version on a `v`-prefixed and a bare-version mod → label + toast show a single `v`.
- [ ] Click "Customize menu…" → lands on Settings → General, card highlighted. Hide an item + drag to reorder → reopen a menu and confirm it reflects the change. Reset → back to default.
- [ ] Toggle to **light theme** (Settings → General → Theme) and re-check the menu + customizer card render cleanly.

## Self-Review Notes

- **Spec coverage:** Task 1 (remove Edit-sources) → Task 3. Task 2 fix (double-`v`) → Task 2. Task 2 feature (customization: model→Task 0, state→Task 1, kebab→Task 3, settings UI→Task 4, nav→Task 5). i18n parity honored per-task. Light-theme check in manual verification + per-task ACs.
- **Type consistency:** `RowMenuItemId`, `RowMenuConfig`, `resolveRowMenuOrder`, `moveItem`, `toggleHidden`, `ROW_MENU_OPEN_EVENT`, `ROW_MENU_STORAGE_KEY` are defined in Task 0 and used verbatim in Tasks 1/3/4/5.
- **Known verify-before-coding spots flagged inline:** `Toggle` prop/role, `Card` ref forwarding, `LinkIcon` unused import, `baseModInfo` version override, `App.test` render helper. Each step says to confirm against the real file before finalizing.
