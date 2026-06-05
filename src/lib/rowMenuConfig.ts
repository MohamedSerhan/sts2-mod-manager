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
