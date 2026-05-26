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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  GripVertical,
  Play,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Card } from './Card';
import { Button } from './Button';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import {
  getProfileMemberships,
  setProfileLoadOrder,
  setProfileModMembership,
  toggleMod,
} from '../hooks/useTauri';
import type {
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
   *  getProfileMemberships grid. */
  modpackName: string;
  /** Fired after a membership / storage / load-order mutation so the
   *  parent (ProfilesView) can re-pull share-info, drift, profile list. */
  onMembershipChanged?: () => void;
  onLoadOrderChanged?: () => void;
  /** Initial value of the search filter. Useful for tests + deep-links. */
  initialSearch?: string;
  /** Page size for the "show more" pagination footer. Defaults to 100. */
  pageSize?: number;
}

function membershipRowKey(row: ProfileMembershipMod): string {
  return row.folder_name ?? row.mod_id ?? row.name;
}

function membershipDisplayName(row: ProfileMembershipMod): string {
  return row.display_name?.trim() || row.name;
}

function libraryStorageKey(row: ProfileMembershipMod): string {
  return `storage::${membershipRowKey(row)}`;
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
  pageSize = DEFAULT_PAGE_SIZE,
}: LibraryTableProps) {
  const { t } = useTranslation();
  const toastCtx = useToast();
  const { refreshAll } = useApp();

  const [grid, setGrid] = useState<ProfileMembershipGrid | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState(initialSearch);
  const [sort, setSort] = useState<LibrarySortMode>('inPackFirst');
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

  /** Resolve the focused profile's state row for a given mod row. */
  function focusedState(row: ProfileMembershipMod) {
    return row.profiles.find((p) => p.profile_name === modpackName);
  }

  /** Rows that have this modpack in their `profiles` array (so the
   *  table can show the in-pack subset for drag reorder + counts). */
  const inPackRowKeys = useMemo(() => {
    if (!grid) return new Set<string>();
    const set = new Set<string>();
    for (const row of grid.mods) {
      const state = row.profiles.find((p) => p.profile_name === modpackName);
      if (state?.included) set.add(membershipRowKey(row));
    }
    return set;
  }, [grid, modpackName]);

  // Build the load-order draft from the grid + modpackName whenever
  // the grid updates. The draft is what the drag handles reorder; on
  // commit we send it to setProfileLoadOrder.
  useEffect(() => {
    if (!grid) {
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
    const rows = query
      ? grid.mods.filter((row) => {
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
      : grid.mods;
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
  }, [grid, filter, sort, inPackRowKeys]);

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
    if (loadOrderSaving) return;
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
              <option value="inPackFirst">
                {t('profiles.library.sort.inPackFirst')}
              </option>
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
          const membershipKey = `${membershipRowKey(row)}::${modpackName}`;
          const saving = membershipSaving === membershipKey;
          return (
            <Card
              key={membershipRowKey(row)}
              className={`gf-profile-library-row ${inPack ? 'in-pack' : ''} ${dragOverIndex === inPackIndex && inPack ? 'drag-over' : ''}`}
              draggable={inPack && !loadOrderSaving && inPackIndex >= 0}
              onDragStart={(event) => {
                if (!inPack || loadOrderSaving) return;
                setDraggedIndex(inPackIndex);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', String(inPackIndex));
              }}
              onDragOver={(event) => {
                if (!inPack || loadOrderSaving || inPackIndex < 0) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDragOverIndex(inPackIndex);
              }}
              onDragLeave={() => {
                if (dragOverIndex === inPackIndex) setDragOverIndex(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (!inPack || loadOrderSaving) return;
                const from
                  = draggedIndex
                    ?? Number.parseInt(event.dataTransfer.getData('text/plain'), 10);
                if (Number.isFinite(from) && from !== inPackIndex) {
                  // Optimistic local reorder, then commit.
                  setLoadOrderDraft((prev) => {
                    if (
                      from < 0
                      || from >= prev.length
                      || inPackIndex < 0
                      || inPackIndex >= prev.length
                    ) {
                      return prev;
                    }
                    const next = [...prev];
                    const [moved] = next.splice(from, 1);
                    next.splice(inPackIndex, 0, moved);
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
            >
              <div className="gf-profile-library-main">
                {inPack && (
                  <div
                    className="gf-load-order-drag"
                    title={t('profiles.loadOrder.dragHandle')}
                    aria-label={t('profiles.loadOrder.dragHandle')}
                  >
                    <GripVertical size={14} />
                  </div>
                )}
                <div className="min-w-0">
                  <h3 className="gf-profile-library-title">
                    {row.display_name?.trim() || row.name}
                    {row.display_name && (
                      <span className="ml-1.5 text-[10px] font-normal text-text-dim">
                        {row.name}
                      </span>
                    )}
                  </h3>
                  <div className="gf-profile-library-meta">
                    <span>{row.version}</span>
                    {row.folder_name && <span>{row.folder_name}</span>}
                    <span
                      className={`gf-profile-library-storage ${row.installed_enabled ? 'active' : 'stored'}`}
                    >
                      {row.installed_enabled
                        ? t('profiles.library.storageActive')
                        : t('profiles.library.storageDisabled')}
                    </span>
                    {inPack && inPackIndex >= 0 && (
                      <span className="gf-load-order-rank-inline">
                        #{inPackIndex + 1}
                      </span>
                    )}
                  </div>
                </div>
                <div className="gf-profile-library-storage-actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleToggleStorage(row)}
                    disabled={storageSaving !== null || membershipSaving !== null}
                    aria-label={
                      row.installed_enabled
                        ? t('profiles.library.storeAria', {
                            mod: membershipDisplayName(row),
                          })
                        : t('profiles.library.activateAria', {
                            mod: membershipDisplayName(row),
                          })
                    }
                    title={
                      row.installed_enabled
                        ? t('profiles.library.storeAria', {
                            mod: membershipDisplayName(row),
                          })
                        : t('profiles.library.activateAria', {
                            mod: membershipDisplayName(row),
                          })
                    }
                  >
                    {storageSaving === libraryStorageKey(row) ? (
                      <RefreshCw size={13} className="animate-spin" />
                    ) : row.installed_enabled ? (
                      <Download size={13} />
                    ) : (
                      <Play size={13} />
                    )}
                    {row.installed_enabled
                      ? t('profiles.library.storeAction')
                      : t('profiles.library.activateAction')}
                  </Button>
                </div>
              </div>
              <div className="gf-profile-memberships">
                {state ? (
                  <label
                    className={`gf-profile-membership ${state.included ? 'active' : ''}`}
                    title={
                      !state.editable
                        ? t('profiles.library.readOnlyTitle')
                        : undefined
                    }
                  >
                    <input
                      type="checkbox"
                      checked={state.included}
                      disabled={
                        !state.editable
                        || membershipSaving !== null
                        || storageSaving !== null
                      }
                      onChange={() => handleToggleMembership(row)}
                      aria-label={t('libraryTable.membershipCheckbox', {
                        mod: membershipDisplayName(row),
                        modpack: modpackName,
                      })}
                    />
                    <span className="gf-profile-membership-name">
                      {state.included
                        ? t('libraryTable.inPack', { modpack: modpackName })
                        : t('libraryTable.notInPack', { modpack: modpackName })}
                    </span>
                    {!state.editable && (
                      <span className="gf-profile-membership-note">
                        {t('profiles.library.readOnly')}
                      </span>
                    )}
                    {saving && <RefreshCw size={12} className="animate-spin" />}
                  </label>
                ) : (
                  <span className="gf-profile-library-muted">
                    {t('libraryTable.modpackMissing')}
                  </span>
                )}
              </div>
            </Card>
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
