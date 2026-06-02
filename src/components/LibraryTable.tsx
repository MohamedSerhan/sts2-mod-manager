/**
 * LibraryTable — per-modpack mod editor.
 *
 * Extracted from the old standalone "Mod Library workspace" inside
 * ProfilesView (1.7.0 T16). The standalone workspace was a profile×mod
 * grid showing every installed mod against every modpack; users
 * complained the page felt like a spreadsheet. T16 collapses that into
 * a focused per-modpack table: the user clicks a modpack card, sees a
 * detail page, and the table inside shows just that modpack's mods +
 * a column of checkboxes to add/remove mods from this pack.
 *
 * Responsibilities:
 *  - Fetches `getProfileMemberships` and filters the focused modpack's
 *    column.
 *  - Search + sort + paginated rendering preserved from the legacy
 *    workspace (we still need to handle 100+ mod libraries cleanly).
 *  - Membership toggle calls `setProfileModMembership` against the
 *    focused modpack.
 *  - Storage toggle (active in game ⇄ stored) calls `toggleMod` —
 *    surfaced via the per-row Active/stored switch + the bulk "store
 *    unused" action.
 *  - Drag-reorder of the in-pack mods calls `setProfileLoadOrder`,
 *    gated behind `enableReorder` (ModpackDetail only).
 *
 * Used by the Library ("All Mods") view in `<Mods>`. Designed to be
 * testable standalone — accepts callbacks for parent refresh so the
 * view can re-pull after a mutation without leaking into LibraryTable
 * state.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Card } from './Card';
import { Button } from './Button';
import {
  LibraryRow,
  libraryStorageKey,
  membershipDisplayName,
  membershipRowKey,
} from './LibraryRow';
import { ModViewToggle, useModListDensity } from './ModViewToggle';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmDialog';
import {
  getProfileMemberships,
  setProfileLoadOrder,
  setProfileModMembership,
  toggleMod,
} from '../hooks/useTauri';
import type {
  ModAuditEntry,
  ModInfo,
  Profile,
  ProfileMembershipGrid,
  ProfileMembershipMod,
} from '../types';

const DEFAULT_PAGE_SIZE = 100;

export type LibrarySortMode =
  | 'nameAsc'
  | 'nameDesc'
  | 'inPackFirst'
  | 'activeFirst'
  | 'storedFirst'
  | 'tagAsc';

export interface LibraryTableProps {
  /** The modpack whose membership column we focus on. The table
   *  filters / highlights this profile's column from the
   *  getProfileMemberships grid.
   *
   *  When null, the table runs in *no-focus library mode*: rows render
   *  without the per-modpack checkbox or drag handle, the default sort
   *  becomes nameAsc, and the "in this modpack first" sort option is
   *  hidden. This is what the Library view uses to render the same row
   *  component as ModpackDetail without anchoring it to a specific
   *  modpack. */
  modpackName: string | null;
  /** Fired after a membership / storage / load-order mutation so the
   *  parent (ProfilesView) can re-pull share-info, drift, profile list. */
  onMembershipChanged?: () => void;
  onLoadOrderChanged?: () => void;
  /** Initial value of the search filter. Useful for tests + deep-links. */
  initialSearch?: string;
  /** Initial sort mode. Defaults to 'inPackFirst' when modpackName is
   *  set; 'nameAsc' when modpackName is null. */
  initialSort?: LibrarySortMode;
  /** Page size for the "show more" pagination footer. Defaults to 100. */
  pageSize?: number;
  /** Whether rows live in a load-order context (ModpackDetail). When
   *  true, in-pack rows show the drag handle + rank chip and the
   *  table's drag handlers commit a reorder. When false (Library view),
   *  the handle/chip stay hidden and the drag handlers no-op — there's
   *  no load order to set across the all-installed-mods list. */
  enableReorder?: boolean;
  /** Couple membership with the active loadout: when true AND this table
   *  is focused on the *active* modpack, adding/removing a mod via the
   *  kebab also enables/disables it in the game folder. The modpack detail
   *  view sets this so "the pack is the live loadout" — removing a mod from
   *  your active pack actually unloads it. All Mods leaves it off (default),
   *  keeping membership and on-disk state independent there. */
  coupleActiveStorage?: boolean;
  /** Dedicated modpack view (shows only this pack's mods). Hides the sort
   *  control + the "store unused" bulk action + the checkbox/drag explainer
   *  (all redundant or wrong there), and switches each row's visible action
   *  to "Remove from pack". */
  packScoped?: boolean;
  /** Extra controls rendered in the toolbar, to the right of the search box
   *  (where sort/store-unused sit in the All Mods view). The modpack view
   *  puts its "+ Add mods" / Edit / Load order actions here so they share
   *  the search row. */
  toolbarActions?: ReactNode;
  /** External re-fetch trigger. When this value changes, the focused-mode
   *  membership grid is re-pulled. Lets a parent that mutates membership
   *  outside this table (e.g. the modpack view's "Add from your Library"
   *  section) keep the in-pack rows in sync. */
  reloadToken?: string | number;
  /** Pre-filter the rows from the membership grid before sorting +
   *  rendering. Used by the Library view to apply tag / extra filters
   *  on top of the table's own search. */
  filterRow?: (row: ProfileMembershipMod) => boolean;

  // ─── ModRow-style per-row action surface (optional) ──────────────
  // When supplied, these are forwarded to LibraryRow's kebab menu.

  /** ModInfo lookup keyed by `folder_name ?? name`. Provides
   *  github_url, tags, pinned, etc. — everything the row's kebab needs
   *  beyond what ProfileMembershipMod carries. */
  modInfoByKey?: Map<string, ModInfo>;
  /** Audit lookup keyed by `folder_name ?? mod_name`. */
  auditByKey?: Map<string, ModAuditEntry>;
  gameRunning?: boolean;
  gameVersion?: string | null;
  /** Per-row in-flight tracker for inline Update. */
  updatingKey?: string | null;
  /** Per-row in-flight tracker for Repair. */
  repairingKey?: string | null;
  /** Per-row in-flight tracker for Rollback. */
  rollingBackKey?: string | null;
  /** True when ANY row is currently updating (disables this row's
   *  update button to prevent two simultaneous installs). */
  anyUpdating?: boolean;
  /** True when ANY row is repairing or rolling back. */
  anyRecoveryInFlight?: boolean;

  onUpdate?: (mod: ModInfo) => void;
  onTogglePin?: (mod: ModInfo) => void;
  onSnooze?: (mod: ModInfo, audit: ModAuditEntry | undefined) => void;
  onUnsnooze?: (mod: ModInfo) => void;
  onRepair?: (mod: ModInfo) => void;
  onRollback?: (mod: ModInfo) => void;
  onDelete?: (mod: ModInfo) => void;
  onCopyVersion?: (mod: ModInfo) => void;
  onOpenModsFolder?: () => void;
  onEditSources?: (mod: ModInfo) => void;
  onFindGithubFromNexus?: (mod: ModInfo) => void;
  onOpenExternalUrl?: (url: string, mod: ModInfo) => void;
  onAutoDetectSource?: (mod: ModInfo) => void;
  /** Render-prop for the inline source editor: when a row's key
   *  matches, the parent returns the editor JSX to slot inside the
   *  row. Returns null otherwise. */
  renderSourceEditor?: (mod: ModInfo) => ReactNode;
}

function compareMembershipDisplayName(
  a: ProfileMembershipMod,
  b: ProfileMembershipMod,
): number {
  const byName = membershipDisplayName(a).localeCompare(
    membershipDisplayName(b),
    undefined,
    { sensitivity: 'base', numeric: true },
  );
  if (byName !== 0) return byName;
  return membershipRowKey(a).localeCompare(membershipRowKey(b), undefined, {
    sensitivity: 'base',
    numeric: true,
  });
}

/** Alphabetically-first tag of a row's ModInfo (lowercased), or null when
 *  untagged. `null` sorts AFTER any tag. */
function firstTagKey(
  row: ProfileMembershipMod,
  modInfoByKey?: Map<string, ModInfo>,
): string | null {
  const info = modInfoByKey?.get(membershipRowKey(row)) ?? modInfoByKey?.get(row.name);
  const tags = (info?.tags ?? []).map((tg) => tg.trim().toLowerCase()).filter(Boolean);
  if (tags.length === 0) return null;
  return tags.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }))[0];
}

export function LibraryTable({
  modpackName,
  onMembershipChanged,
  onLoadOrderChanged,
  initialSearch = '',
  initialSort,
  pageSize = DEFAULT_PAGE_SIZE,
  enableReorder = false,
  coupleActiveStorage = false,
  packScoped = false,
  toolbarActions,
  reloadToken,
  filterRow,
  modInfoByKey,
  auditByKey,
  gameRunning,
  gameVersion,
  updatingKey,
  repairingKey,
  rollingBackKey,
  anyUpdating,
  anyRecoveryInFlight,
  onUpdate,
  onTogglePin,
  onSnooze,
  onUnsnooze,
  onRepair,
  onRollback,
  onDelete,
  onCopyVersion,
  onOpenModsFolder,
  onEditSources,
  onFindGithubFromNexus,
  onOpenExternalUrl,
  onAutoDetectSource,
  renderSourceEditor,
}: LibraryTableProps) {
  const { t } = useTranslation();
  const toastCtx = useToast();
  const confirm = useConfirm();
  const { mods: appMods, refreshAll, activeProfile } = useApp();

  const [grid, setGrid] = useState<ProfileMembershipGrid | null>(null);
  const [loading, setLoading] = useState(modpackName != null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState(initialSearch);
  const [sort, setSort] = useState<LibrarySortMode>(
    initialSort ?? (modpackName ? 'inPackFirst' : 'nameAsc'),
  );
  const [visibleLimit, setVisibleLimit] = useState(pageSize);
  const [membershipSaving, setMembershipSaving] = useState<string | null>(null);
  const [storageSaving, setStorageSaving] = useState<string | null>(null);
  // Comfortable / compact row density (persisted, shared with the modpack view).
  const [density, setDensity] = useModListDensity();

  const rootRef = useRef<HTMLDivElement>(null);

  // Safety net so the user is NEVER scrolled against their will when a row
  // mutates. The root cause we know of is focus-loss on the toggled control
  // (fixed in LibraryRow by not disabling it mid-save), but a row mutation
  // triggers a refreshAll + full re-render, and we don't want ANY engine /
  // layout quirk to be able to yank the page. This briefly re-pins the
  // nearest scrollable ancestor to where it was when the mutation began.
  // Inert under jsdom (scrollHeight/clientHeight are 0 there), so it doesn't
  // touch the test suite.
  const pinScroll = useCallback(() => {
    let el: HTMLElement | null = rootRef.current?.parentElement ?? null;
    while (el) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && el.scrollHeight > el.clientHeight) {
        break;
      }
      el = el.parentElement;
    }
    if (!el) return;
    const scroller = el;
    const top = scroller.scrollTop;
    let frame = 0;
    const hold = () => {
      if (scroller.scrollTop !== top) scroller.scrollTop = top;
      // ~12 frames (~200ms) covers the synchronous re-render plus any async
      // focus-driven scroll the engine schedules just after.
      if (++frame < 12) requestAnimationFrame(hold);
    };
    requestAnimationFrame(hold);
  }, []);

  // Drag-and-drop reorder state for the in-pack mods. Indices refer
  // to the filtered "in this modpack" list, not the full grid.
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [loadOrderSaving, setLoadOrderSaving] = useState(false);

  // Local optimistic profile state — the in-pack mod list keeps a
  // load-order draft so drags can settle visually before the backend
  // confirms. The grid still drives the rest of the rendering.
  const [loadOrderDraft, setLoadOrderDraft] = useState<Profile['mods']>([]);

  // Stable signature of the *set* of installed mods (identity only, not
  // enabled-state/version). Changes when a mod is installed or deleted —
  // which is exactly when the focused-mode grid must re-fetch so a newly
  // added mod shows up without a remount. Toggles/version bumps don't
  // change this, so they don't clobber the table's optimistic patches.
  const installedIdentitySignal = useMemo(
    // NUL-join (\u0000): an unambiguous separator that can't appear in a mod
    // name, so the signal changes only when the set of installed identities
    // does. Written as an escape, not a literal NUL byte — a raw NUL made the
    // whole file read as binary to ripgrep/grep.
    () => appMods.map((m) => m.folder_name ?? m.name).sort().join('\u0000'),
    [appMods],
  );

  const load = useCallback(async () => {
    if (modpackName == null) {
      // No-focus mode — rows are synthesized from the AppContext mods
      // array (see the synthesizedGrid useMemo below). No need to round-
      // trip through getProfileMemberships.
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError(null);
      const result = await getProfileMemberships();
      setGrid(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
    // installedIdentitySignal + reloadToken are intentionally deps: re-pull
    // the grid when the installed set changes (install/delete) or when a
    // parent signals an external membership change via reloadToken.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modpackName, installedIdentitySignal, reloadToken]);

  useEffect(() => {
    load();
  }, [load]);

  // No-focus mode: synthesize a membership grid from AppContext's
  // `mods` array so we can share the same rendering pipeline as
  // modpack-focused mode. Each synthesized row has an empty profiles
  // array (LibraryRow renders no checkbox when modpackName is null,
  // so the empty profiles list is invisible).
  const synthesizedGrid = useMemo<ProfileMembershipGrid | null>(() => {
    if (modpackName != null) return null;
    return {
      profiles: [],
      mods: appMods.map((mod) => ({
        name: mod.name,
        version: mod.version,
        folder_name: mod.folder_name,
        mod_id: mod.mod_id,
        display_name: mod.display_name,
        installed_enabled: mod.enabled,
        profiles: [],
      })),
    };
  }, [modpackName, appMods]);

  const effectiveGrid = modpackName == null ? synthesizedGrid : grid;

  // Reset pagination when the filter or sort changes, otherwise the
  // user can be looking at "showing 20 of 200" but the visible page
  // starts at 100+ filtered out.
  useEffect(() => {
    setVisibleLimit(pageSize);
  }, [filter, sort, pageSize]);

  /** Resolve the focused profile's state row for a given mod row.
   *  Returns undefined when modpackName is null (no-focus mode). */
  function focusedState(row: ProfileMembershipMod) {
    if (modpackName == null) return undefined;
    return row.profiles.find((p) => p.profile_name === modpackName);
  }

  /** Rows that have this modpack in their `profiles` array (so the
   *  table can show the in-pack subset for drag reorder + counts).
   *  Empty when modpackName is null (no concept of "in pack"). */
  const inPackRowKeys = useMemo(() => {
    if (!effectiveGrid || modpackName == null) return new Set<string>();
    const set = new Set<string>();
    for (const row of effectiveGrid.mods) {
      const state = row.profiles.find((p) => p.profile_name === modpackName);
      if (state?.included) set.add(membershipRowKey(row));
    }
    return set;
  }, [effectiveGrid, modpackName]);

  // Build the load-order draft from the grid + modpackName whenever
  // the grid updates. The draft is what the drag handles reorder; on
  // commit we send it to setProfileLoadOrder. Skipped when there's no
  // focused modpack (no-focus library mode has no drag-reorder).
  useEffect(() => {
    if (!effectiveGrid || modpackName == null) {
      setLoadOrderDraft([]);
      return;
    }
    // Use the order from the matching profile (the membership grid
    // backend already orders mods consistently). Falls back to grid
    // order if for some reason we can't find the profile in the user
    // grid.
    const inPack = effectiveGrid.mods.filter((row) =>
      row.profiles.find((p) => p.profile_name === modpackName)?.included,
    );
    setLoadOrderDraft(
      inPack.map((row) => ({
        name: row.name,
        version: row.version,
        source: null,
        hash: null,
        files: [],
        enabled: row.installed_enabled,
        bundle_url: null,
        folder_name: row.folder_name,
        mod_id: row.mod_id,
      })),
    );
  }, [effectiveGrid, modpackName]);

  // Filtered + sorted rows for the table body.
  const filteredRows = useMemo(() => {
    if (!effectiveGrid) return [] as ProfileMembershipMod[];
    const query = filter.trim().toLowerCase();
    // External pre-filter (e.g. Library view's tag filter) is applied
    // first so the table's own search runs against an already-narrowed
    // set.
    const preFiltered = filterRow ? effectiveGrid.mods.filter(filterRow) : effectiveGrid.mods;
    const rows = query
      ? preFiltered.filter((row) => {
          const haystack = [
            row.name,
            row.display_name ?? '',
            row.folder_name ?? '',
            row.mod_id ?? '',
            row.version,
          ]
            .join(' ')
            .toLowerCase();
          return haystack.includes(query);
        })
      : preFiltered;
    const sorted = [...rows];
    sorted.sort((a, b) => {
      const aIn = inPackRowKeys.has(membershipRowKey(a));
      const bIn = inPackRowKeys.has(membershipRowKey(b));
      if (sort === 'nameDesc') return compareMembershipDisplayName(b, a);
      if (sort === 'inPackFirst') {
        if (aIn !== bIn) return Number(bIn) - Number(aIn);
        return compareMembershipDisplayName(a, b);
      }
      if (sort === 'activeFirst') {
        return (
          Number(b.installed_enabled) - Number(a.installed_enabled)
          || compareMembershipDisplayName(a, b)
        );
      }
      if (sort === 'storedFirst') {
        return (
          Number(a.installed_enabled) - Number(b.installed_enabled)
          || compareMembershipDisplayName(a, b)
        );
      }
      if (sort === 'tagAsc') {
        const at = firstTagKey(a, modInfoByKey);
        const bt = firstTagKey(b, modInfoByKey);
        if (at !== bt) {
          if (at === null) return 1;   // untagged after tagged
          if (bt === null) return -1;
          const byTag = at.localeCompare(bt, undefined, { sensitivity: 'base', numeric: true });
          if (byTag !== 0) return byTag;
        }
        return compareMembershipDisplayName(a, b);
      }
      return compareMembershipDisplayName(a, b);
    });
    return sorted;
  }, [effectiveGrid, filter, sort, inPackRowKeys, filterRow, modInfoByKey]);

  const visibleItems = filteredRows.slice(0, visibleLimit);

  function patchRowMembership(
    rowKey: string,
    nextIncluded: boolean,
  ) {
    setGrid((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        mods: prev.mods.map((mod) => {
          if (membershipRowKey(mod) !== rowKey) return mod;
          return {
            ...mod,
            profiles: mod.profiles.map((p) =>
              p.profile_name === modpackName
                ? {
                    ...p,
                    included: nextIncluded,
                    enabled: nextIncluded ? mod.installed_enabled : false,
                  }
                : p,
            ),
          };
        }),
      };
    });
  }

  function patchRowStorage(rowKey: string, installedEnabled: boolean) {
    setGrid((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        mods: prev.mods.map((mod) =>
          membershipRowKey(mod) === rowKey
            ? { ...mod, installed_enabled: installedEnabled }
            : mod,
        ),
      };
    });
  }

  async function handleToggleMembership(row: ProfileMembershipMod) {
    if (modpackName == null) return;
    const state = focusedState(row);
    if (!state || !state.editable || membershipSaving || storageSaving) return;
    const nextIncluded = !state.included;
    const key = `${membershipRowKey(row)}::${modpackName}`;
    try {
      pinScroll();
      setMembershipSaving(key);
      // When the modpack view treats the pack as the live loadout, mirror the
      // membership change onto the active game folder. Do the disk toggle
      // FIRST: toggle_mod guards on the game running (and can fail the move)
      // while the membership write doesn't — toggling first keeps the two in
      // sync, so a running game aborts before the manifest is touched. Only
      // for the *active* pack and only when disk state needs to change.
      const mirrorsToDisk =
        coupleActiveStorage
        && modpackName === activeProfile
        && row.installed_enabled !== nextIncluded;
      if (mirrorsToDisk) {
        await toggleMod(row.name, row.folder_name, nextIncluded);
        patchRowStorage(membershipRowKey(row), nextIncluded);
      }
      await setProfileModMembership(
        modpackName,
        row.name,
        row.folder_name,
        row.mod_id,
        nextIncluded,
      );
      patchRowMembership(membershipRowKey(row), nextIncluded);
      if (mirrorsToDisk) await refreshAll();
      toastCtx.success(
        nextIncluded
          ? t('profiles.library.toastAdded', {
              mod: membershipDisplayName(row),
              profile: modpackName,
            })
          : t('profiles.library.toastRemoved', {
              mod: membershipDisplayName(row),
              profile: modpackName,
            }),
      );
      onMembershipChanged?.();
    } catch (e) {
      toastCtx.error(
        t('profiles.library.toastFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setMembershipSaving(null);
    }
  }

  async function handleToggleStorage(row: ProfileMembershipMod) {
    if (storageSaving || membershipSaving) return;
    const nextEnabled = !row.installed_enabled;
    const displayName = membershipDisplayName(row);
    const state = focusedState(row);

    // Enabling a stored mod that isn't in the active modpack: ask whether
    // to also add it to the pack, just enable it on its own, or back out
    // and keep it stored. Only when there's an editable active pack to add
    // to — otherwise enabling proceeds straight through.
    let alsoAddToPack = false;
    if (nextEnabled && modpackName != null && state && !state.included && state.editable) {
      const result = await confirm({
        title: t('profiles.library.enableNotInPack.title', { mod: displayName }),
        body: t('profiles.library.enableNotInPack.body', { pack: modpackName }),
        cancelLabel: t('profiles.library.enableNotInPack.keepStored'),
        width: 560,
        choices: [
          {
            value: 'enableAndAdd',
            label: t('profiles.library.enableNotInPack.enableAndAdd', { pack: modpackName }),
            variant: 'primary',
          },
          {
            value: 'enableOnly',
            label: t('profiles.library.enableNotInPack.enableOnly'),
            variant: 'secondary',
          },
        ],
      });
      if (!result) return; // backed out — the mod stays stored
      alsoAddToPack = result.choice === 'enableAndAdd';
    }

    // Enabling a mod that isn't in the active pack, when that pack is a
    // followed / non-editable one, can't add it (you don't own its manifest).
    // Flag it so the toast explains instead of silently enabling.
    const enabledOutsideFollowedPack =
      nextEnabled && modpackName != null && state != null && !state.included && !state.editable;

    const key = libraryStorageKey(row);
    try {
      pinScroll();
      setStorageSaving(key);
      await toggleMod(row.name, row.folder_name, nextEnabled);
      patchRowStorage(membershipRowKey(row), nextEnabled);
      if (alsoAddToPack && modpackName != null) {
        await setProfileModMembership(
          modpackName,
          row.name,
          row.folder_name,
          row.mod_id,
          true,
        );
        patchRowMembership(membershipRowKey(row), true);
      }
      await refreshAll();
      if (!nextEnabled) {
        toastCtx.success(t('profiles.library.toastStored', { mod: displayName }));
      } else if (alsoAddToPack) {
        toastCtx.success(
          t('profiles.library.toastActivatedAndAdded', { mod: displayName, pack: modpackName }),
        );
      } else if (enabledOutsideFollowedPack) {
        toastCtx.info(
          t('profiles.library.toastActivatedFollowed', { mod: displayName, pack: modpackName }),
        );
      } else {
        toastCtx.success(t('profiles.library.toastActivated', { mod: displayName }));
      }
      onMembershipChanged?.();
    } catch (e) {
      toastCtx.error(
        t('profiles.library.toastStorageFailed', {
          mod: displayName,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setStorageSaving(null);
    }
  }

  // ── Drag reorder for the in-pack list ─────────────────────────────
  // The drag handles only appear on rows that are in the modpack. The
  // reorder commits via setProfileLoadOrder which persists the order
  // on the modpack manifest + writes settings if the modpack is active.

  async function commitLoadOrder(nextDraft: Profile['mods']) {
    if (loadOrderSaving || modpackName == null) return;
    try {
      setLoadOrderSaving(true);
      await setProfileLoadOrder(
        modpackName,
        nextDraft.map((mod) => ({
          name: mod.name,
          folder_name: mod.folder_name,
          mod_id: mod.mod_id,
        })),
      );
      onLoadOrderChanged?.();
      toastCtx.success(t('profiles.loadOrder.toastSavedApplied', { name: modpackName }));
    } catch (e) {
      toastCtx.error(
        t('profiles.loadOrder.toastFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
      // Re-pull the grid so we don't strand the draft in a wrong state.
      await load();
    } finally {
      setLoadOrderSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-text-dim">
        <p className="text-sm">{t('profiles.library.loading')}</p>
      </div>
    );
  }

  if (error) {
    return (
      <Card className="text-center py-8">
        <p className="text-danger text-sm">{error}</p>
        <Button variant="secondary" size="sm" className="mt-3" onClick={load}>
          {t('common.retry')}
        </Button>
      </Card>
    );
  }

  if (!effectiveGrid) {
    return (
      <div className="flex items-center justify-center py-16 text-text-dim">
        <p className="text-sm">{t('profiles.library.loading')}</p>
      </div>
    );
  }

  if (effectiveGrid.mods.length === 0 && !packScoped) {
    return (
      <div className="gf-empty">
        <div className="gf-empty-title">{t('profiles.library.empty.title')}</div>
        <div className="gf-empty-sub">{t('profiles.library.empty.hint')}</div>
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className={`gf-profile-library${density === 'compact' ? ' is-compact' : ''}`}
      data-testid="library-table"
    >
      <div className="gf-profile-library-toolbar">
        <label className="gf-profile-library-search">
          <Search size={13} />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={
              packScoped
                ? t('profiles.library.searchPackPlaceholder')
                : t('profiles.library.searchPlaceholder', { count: effectiveGrid.mods.length })
            }
            aria-label={t('profiles.library.searchLabel')}
          />
        </label>
        {/* Modpack view: the caller's actions (+ Add mods / Edit / Load
            order) share the search row, where sort/store-unused sit in the
            All Mods view. */}
        {packScoped && (
          <div className="gf-profile-library-toolbar-actions">
            <ModViewToggle density={density} onChange={setDensity} />
            {toolbarActions}
          </div>
        )}
        {/* The sort control is hidden in the dedicated modpack view: the list
            always shows load order there (sorting would fight it). */}
        {!packScoped && (
          <div className="gf-profile-library-toolbar-actions">
            <ModViewToggle density={density} onChange={setDensity} />
            <label className="gf-sort-control gf-profile-library-sort">
              <span>{t('profiles.library.sort.label')}</span>
              <select
                value={sort}
                onChange={(event) =>
                  setSort(event.target.value as LibrarySortMode)
                }
                aria-label={t('profiles.library.sort.label')}
              >
                {/* "In this modpack first" only makes sense when a modpack
                    is focused. In the no-focus Library view, this option
                    is hidden so the user doesn't see a sort option that
                    has no effect. */}
                {modpackName != null && (
                  <option value="inPackFirst">
                    {t('profiles.library.sort.inPackFirst')}
                  </option>
                )}
                <option value="nameAsc">{t('profiles.library.sort.nameAsc')}</option>
                <option value="nameDesc">{t('profiles.library.sort.nameDesc')}</option>
                <option value="activeFirst">
                  {t('profiles.library.sort.activeFirst')}
                </option>
                <option value="storedFirst">
                  {t('profiles.library.sort.storedFirst')}
                </option>
                <option value="tagAsc">{t('profiles.library.sort.tagAsc')}</option>
              </select>
            </label>
          </div>
        )}
      </div>
      {/* The checkbox/drag explainer only applies to the All Mods view. The
          modpack view carries its own "listed in load order" note. */}
      {!packScoped && (
        <div className="gf-profile-library-help">
          {enableReorder
            ? t('profiles.library.explainerModpack')
            : t('profiles.library.explainerLibrary')}
        </div>
      )}
      {filteredRows.length === 0 ? (
        <div className="gf-empty">
          {packScoped && !filter.trim() ? (
            <>
              <div className="gf-empty-title">{t('profiles.library.packEmpty.title')}</div>
              <div className="gf-empty-sub">{t('profiles.library.packEmpty.hint')}</div>
            </>
          ) : (
            <>
              <div className="gf-empty-title">
                {t('profiles.library.noMatches.title')}
              </div>
              <div className="gf-empty-sub">
                {t('profiles.library.noMatches.hint')}
              </div>
            </>
          )}
        </div>
      ) : (
        visibleItems.map((row) => {
          const state = focusedState(row);
          const inPack = !!state?.included;
          const inPackIndex = loadOrderDraft.findIndex(
            (m) =>
              (m.folder_name ?? m.mod_id ?? m.name)
              === (row.folder_name ?? row.mod_id ?? row.name),
          );
          const rowKey = membershipRowKey(row);
          const modInfo
            = modInfoByKey?.get(rowKey) ?? modInfoByKey?.get(row.name);
          const audit = auditByKey?.get(rowKey) ?? auditByKey?.get(row.name);
          const sourceEditorSlot
            = modInfo && renderSourceEditor
              ? renderSourceEditor(modInfo)
              : undefined;
          return (
            <LibraryRow
              key={rowKey}
              row={row}
              modpackName={modpackName}
              state={state}
              inPack={inPack}
              inPackIndex={inPackIndex}
              enableReorder={enableReorder}
              packScoped={packScoped}
              packActive={modpackName != null && modpackName === activeProfile}
              isDragOver={dragOverIndex === inPackIndex && inPack}
              loadOrderSaving={loadOrderSaving}
              membershipSaving={membershipSaving}
              storageSaving={storageSaving}
              onDragStart={(event, index) => {
                if (!enableReorder || !inPack || loadOrderSaving) return;
                setDraggedIndex(index);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(index));
              }}
              onDragOver={(event, index) => {
                // Only intercept events that look like an in-app reorder
                // (reorder is enabled, we're hovering an in-pack row, and
                // load order isn't saving). Anything else — including the
                // user dragging a .zip from the OS, or any drag in the
                // Library view where reorder is off — falls through to the
                // document-level handler in App.tsx so the file-install
                // dropzone overlay shows.
                if (!enableReorder || !inPack || loadOrderSaving || index < 0) return;
                if (!event.dataTransfer.types.includes('text/plain')) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDragOverIndex(index);
              }}
              onDragLeave={(index) => {
                if (dragOverIndex === index) setDragOverIndex(null);
              }}
              onDrop={(event, index) => {
                // Same rule as onDragOver — only handle the in-app reorder
                // case. Returning BEFORE preventDefault lets file drops
                // (the user dragging a mod archive from File Explorer)
                // bubble up to App.tsx's installModFromFile handler.
                if (!enableReorder || !inPack || loadOrderSaving) return;
                if (!event.dataTransfer.types.includes('text/plain')) return;
                event.preventDefault();
                const from
                  = draggedIndex
                    ?? Number.parseInt(
                      event.dataTransfer.getData('text/plain'),
                      10,
                    );
                if (
                  Number.isFinite(from)
                  && from !== index
                  && from >= 0
                  && from < loadOrderDraft.length
                  && index >= 0
                  && index < loadOrderDraft.length
                ) {
                  // Optimistic local reorder, then commit. Build `next` OUTSIDE
                  // any setState updater so the commit side-effect runs exactly
                  // once — a side-effect inside an updater double-fires under
                  // React StrictMode in dev.
                  const next = [...loadOrderDraft];
                  const [moved] = next.splice(from, 1);
                  next.splice(index, 0, moved);
                  setLoadOrderDraft(next);
                  commitLoadOrder(next);
                }
                setDraggedIndex(null);
                setDragOverIndex(null);
              }}
              onDragEnd={() => {
                setDraggedIndex(null);
                setDragOverIndex(null);
              }}
              onToggleMembership={handleToggleMembership}
              onToggleStorage={handleToggleStorage}
              mod={modInfo}
              audit={audit}
              gameRunning={gameRunning}
              gameVersion={gameVersion}
              isUpdating={!!modInfo && updatingKey === rowKey}
              isRepairing={!!modInfo && repairingKey === rowKey}
              isRollingBack={!!modInfo && rollingBackKey === rowKey}
              anyUpdating={anyUpdating}
              anyRecoveryInFlight={anyRecoveryInFlight}
              onUpdate={modInfo && onUpdate ? () => onUpdate(modInfo) : undefined}
              onTogglePin={modInfo && onTogglePin ? () => onTogglePin(modInfo) : undefined}
              onSnooze={modInfo && onSnooze ? () => onSnooze(modInfo, audit) : undefined}
              onUnsnooze={modInfo && onUnsnooze ? () => onUnsnooze(modInfo) : undefined}
              onRepair={modInfo && onRepair ? () => onRepair(modInfo) : undefined}
              onRollback={modInfo && onRollback ? () => onRollback(modInfo) : undefined}
              onDelete={modInfo && onDelete ? () => onDelete(modInfo) : undefined}
              onCopyVersion={modInfo && onCopyVersion ? () => onCopyVersion(modInfo) : undefined}
              onOpenModsFolder={onOpenModsFolder}
              onEditSources={modInfo && onEditSources ? () => onEditSources(modInfo) : undefined}
              onFindGithubFromNexus={modInfo && onFindGithubFromNexus ? () => onFindGithubFromNexus(modInfo) : undefined}
              onOpenExternalUrl={modInfo && onOpenExternalUrl ? (url: string) => onOpenExternalUrl(url, modInfo) : undefined}
              onAutoDetectSource={modInfo && onAutoDetectSource ? () => onAutoDetectSource(modInfo) : undefined}
              sourceEditorSlot={sourceEditorSlot}
            />
          );
        })
      )}
      {filteredRows.length > visibleItems.length && (
        <div className="gf-profile-library-footer">
          <span>
            {t('profiles.library.showing', {
              shown: visibleItems.length,
              total: filteredRows.length,
            })}
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setVisibleLimit((limit) => limit + pageSize)}
          >
            {t('profiles.library.showMore', {
              count: Math.min(
                pageSize,
                filteredRows.length - visibleItems.length,
              ),
            })}
          </Button>
        </div>
      )}
    </div>
  );
}
