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
 *  - "Store" / "Activate" preserved (calls `toggleMod`).
 *  - Drag-reorder of the in-pack mods calls `setProfileLoadOrder`.
 *
 * Used inside `<ModpackDetail>`. Designed to be testable standalone —
 * accept callbacks for parent refresh so ProfilesView can re-pull
 * after a mutation without leaking into LibraryTable state.
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Card } from './Card';
import { Button } from './Button';
import {
  LibraryRow,
  libraryStorageKey,
  membershipDisplayName,
  membershipRowKey,
} from './LibraryRow';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
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
const BULK_STORAGE_KEY = '__bulk_storage__';

export type LibrarySortMode =
  | 'nameAsc'
  | 'nameDesc'
  | 'inPackFirst'
  | 'activeFirst'
  | 'storedFirst';

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

export function LibraryTable({
  modpackName,
  onMembershipChanged,
  onLoadOrderChanged,
  initialSearch = '',
  initialSort,
  pageSize = DEFAULT_PAGE_SIZE,
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
  renderSourceEditor,
}: LibraryTableProps) {
  const { t } = useTranslation();
  const toastCtx = useToast();
  const { refreshAll } = useApp();

  const [grid, setGrid] = useState<ProfileMembershipGrid | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState(initialSearch);
  const [sort, setSort] = useState<LibrarySortMode>(
    initialSort ?? (modpackName ? 'inPackFirst' : 'nameAsc'),
  );
  const [visibleLimit, setVisibleLimit] = useState(pageSize);
  const [membershipSaving, setMembershipSaving] = useState<string | null>(null);
  const [storageSaving, setStorageSaving] = useState<string | null>(null);

  // Drag-and-drop reorder state for the in-pack mods. Indices refer
  // to the filtered "in this modpack" list, not the full grid.
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [loadOrderSaving, setLoadOrderSaving] = useState(false);

  // Local optimistic profile state — the in-pack mod list keeps a
  // load-order draft so drags can settle visually before the backend
  // confirms. The grid still drives the rest of the rendering.
  const [loadOrderDraft, setLoadOrderDraft] = useState<Profile['mods']>([]);

  const load = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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
    if (!grid || modpackName == null) return new Set<string>();
    const set = new Set<string>();
    for (const row of grid.mods) {
      const state = row.profiles.find((p) => p.profile_name === modpackName);
      if (state?.included) set.add(membershipRowKey(row));
    }
    return set;
  }, [grid, modpackName]);

  // Build the load-order draft from the grid + modpackName whenever
  // the grid updates. The draft is what the drag handles reorder; on
  // commit we send it to setProfileLoadOrder. Skipped when there's no
  // focused modpack (no-focus library mode has no drag-reorder).
  useEffect(() => {
    if (!grid || modpackName == null) {
      setLoadOrderDraft([]);
      return;
    }
    // Use the order from the matching profile (the membership grid
    // backend already orders mods consistently). Falls back to grid
    // order if for some reason we can't find the profile in the user
    // grid.
    const inPack = grid.mods.filter((row) =>
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
  }, [grid, modpackName]);

  // Filtered + sorted rows for the table body.
  const filteredRows = useMemo(() => {
    if (!grid) return [] as ProfileMembershipMod[];
    const query = filter.trim().toLowerCase();
    // External pre-filter (e.g. Library view's tag filter) is applied
    // first so the table's own search runs against an already-narrowed
    // set.
    const preFiltered = filterRow ? grid.mods.filter(filterRow) : grid.mods;
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
      return compareMembershipDisplayName(a, b);
    });
    return sorted;
  }, [grid, filter, sort, inPackRowKeys, filterRow]);

  const visibleRows = filteredRows.slice(0, visibleLimit);

  const unusedActiveRows = useMemo(() => {
    if (!grid) return [] as ProfileMembershipMod[];
    return grid.mods.filter(
      (row) =>
        row.installed_enabled
        && row.profiles.filter((p) => p.included).length === 0,
    );
  }, [grid]);

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
      setMembershipSaving(key);
      await setProfileModMembership(
        modpackName,
        row.name,
        row.folder_name,
        row.mod_id,
        nextIncluded,
      );
      patchRowMembership(membershipRowKey(row), nextIncluded);
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
    const key = libraryStorageKey(row);
    try {
      setStorageSaving(key);
      await toggleMod(row.name, row.folder_name, nextEnabled);
      patchRowStorage(membershipRowKey(row), nextEnabled);
      await refreshAll();
      toastCtx.success(
        nextEnabled
          ? t('profiles.library.toastActivated', {
              mod: membershipDisplayName(row),
            })
          : t('profiles.library.toastStored', {
              mod: membershipDisplayName(row),
            }),
      );
      onMembershipChanged?.();
    } catch (e) {
      toastCtx.error(
        t('profiles.library.toastStorageFailed', {
          mod: membershipDisplayName(row),
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setStorageSaving(null);
    }
  }

  async function handleStoreUnused() {
    if (unusedActiveRows.length === 0 || storageSaving || membershipSaving)
      return;
    const stored = new Set<string>();
    const failed: string[] = [];
    try {
      setStorageSaving(BULK_STORAGE_KEY);
      for (const row of unusedActiveRows) {
        try {
          await toggleMod(row.name, row.folder_name, false);
          stored.add(membershipRowKey(row));
        } catch {
          failed.push(membershipDisplayName(row));
        }
      }
      if (stored.size > 0) {
        setGrid((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            mods: prev.mods.map((mod) =>
              stored.has(membershipRowKey(mod))
                ? { ...mod, installed_enabled: false }
                : mod,
            ),
          };
        });
        await refreshAll();
      }
      if (failed.length > 0) {
        toastCtx.error(
          t('profiles.library.toastBulkStorageFailed', {
            stored: stored.size,
            total: unusedActiveRows.length,
            mods: failed.slice(0, 3).join(', '),
          }),
        );
      } else {
        toastCtx.success(
          t('profiles.library.toastBulkStored', { count: stored.size }),
        );
      }
      onMembershipChanged?.();
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

  if (!grid) {
    return (
      <div className="flex items-center justify-center py-16 text-text-dim">
        <p className="text-sm">{t('profiles.library.loading')}</p>
      </div>
    );
  }

  if (grid.mods.length === 0) {
    return (
      <div className="gf-empty">
        <div className="gf-empty-title">{t('profiles.library.empty.title')}</div>
        <div className="gf-empty-sub">{t('profiles.library.empty.hint')}</div>
      </div>
    );
  }

  return (
    <div className="gf-profile-library" data-testid="library-table">
      <div className="gf-profile-library-toolbar">
        <label className="gf-profile-library-search">
          <Search size={13} />
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('profiles.library.searchPlaceholder', {
              count: grid.mods.length,
            })}
            aria-label={t('profiles.library.searchLabel')}
          />
        </label>
        <div className="gf-profile-library-toolbar-actions">
          <Button
            variant="secondary"
            size="sm"
            disabled={
              unusedActiveRows.length === 0
              || storageSaving !== null
              || membershipSaving !== null
            }
            onClick={handleStoreUnused}
            aria-label={
              unusedActiveRows.length === 0
                ? t('profiles.library.bulkStoreNone')
                : t('profiles.library.bulkStoreUnused', {
                    count: unusedActiveRows.length,
                  })
            }
          >
            {storageSaving === BULK_STORAGE_KEY ? (
              <RefreshCw size={13} className="animate-spin" />
            ) : (
              <Download size={13} />
            )}
            {unusedActiveRows.length === 0
              ? t('profiles.library.bulkStoreNone')
              : t('profiles.library.bulkStoreUnused', {
                  count: unusedActiveRows.length,
                })}
          </Button>
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
            </select>
          </label>
        </div>
      </div>
      <div className="gf-profile-library-help">
        {t('profiles.library.storageHelp')}
      </div>
      {filteredRows.length === 0 ? (
        <div className="gf-empty">
          <div className="gf-empty-title">
            {t('profiles.library.noMatches.title')}
          </div>
          <div className="gf-empty-sub">
            {t('profiles.library.noMatches.hint')}
          </div>
        </div>
      ) : (
        visibleRows.map((row) => {
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
              isDragOver={dragOverIndex === inPackIndex && inPack}
              loadOrderSaving={loadOrderSaving}
              membershipSaving={membershipSaving}
              storageSaving={storageSaving}
              onDragStart={(event, index) => {
                if (!inPack || loadOrderSaving) return;
                setDraggedIndex(index);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(index));
              }}
              onDragOver={(event, index) => {
                // Only intercept events that look like an in-app reorder
                // (we're hovering an in-pack row + load order isn't saving).
                // Anything else — including the user dragging a .zip from
                // the OS — falls through to the document-level handler in
                // App.tsx so the file-install dropzone overlay shows.
                if (!inPack || loadOrderSaving || index < 0) return;
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
                if (!inPack || loadOrderSaving) return;
                if (!event.dataTransfer.types.includes('text/plain')) return;
                event.preventDefault();
                const from
                  = draggedIndex
                    ?? Number.parseInt(
                      event.dataTransfer.getData('text/plain'),
                      10,
                    );
                if (Number.isFinite(from) && from !== index) {
                  // Optimistic local reorder, then commit.
                  setLoadOrderDraft((prev) => {
                    if (
                      from < 0
                      || from >= prev.length
                      || index < 0
                      || index >= prev.length
                    ) {
                      return prev;
                    }
                    const next = [...prev];
                    const [moved] = next.splice(from, 1);
                    next.splice(index, 0, moved);
                    commitLoadOrder(next);
                    return next;
                  });
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
              sourceEditorSlot={sourceEditorSlot}
            />
          );
        })
      )}
      {filteredRows.length > visibleRows.length && (
        <div className="gf-profile-library-footer">
          <span>
            {t('profiles.library.showing', {
              shown: visibleRows.length,
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
                filteredRows.length - visibleRows.length,
              ),
            })}
          </Button>
        </div>
      )}
    </div>
  );
}
