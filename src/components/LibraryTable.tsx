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
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Card } from './Card';
import { Button } from './Button';
import {
  LibraryRow,
  libraryStorageKey,
  membershipDisplayName,
  membershipRowKey,
  type StoredVersionGuidance,
} from './LibraryRow';
import { ModViewToggle, useModListDensity } from './ModViewToggle';
import { usePinScroll } from '../hooks/usePinScroll';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmDialog';
import { projectProviderUpdates } from '../lib/auditState';
import { logicalModKey, modVersionSortValue } from '../lib/modGrouping';
import { isWorkshopOwned, isWorkshopSource } from '../lib/modIdentity';
import { profileDisplayName } from '../lib/profileDisplay';
import { Select } from './Select';
import {
  getLibraryVersionOptions,
  getProfileMemberships,
  executeLibraryVersionCleanup,
  previewLibraryModVersionRemoval,
  previewLibraryVersionCleanup,
  removeLibraryModVersion,
  removeLibraryModVersionManual,
  selectLibraryModVersion,
  setProfileLoadOrder,
  setProfileModMembership,
  toggleMod,
} from '../hooks/useTauri';
import type {
  ModAuditEntry,
  ModInfo,
  LocalModVersionOption,
  LocalModVersionRemovalPreview,
  ManualModVersionRemovalMode,
  ManualModVersionProfileReplacement,
  Profile,
  ProfileMembershipGrid,
  ProfileMembershipMod,
  UpdatePlanItem,
} from '../types';

const DEFAULT_PAGE_SIZE = 100;
export const NO_TAGS_FILTER_VALUE = '__no_tags__';

export type LibrarySortMode =
  | 'loadOrder'
  | 'updatesFirst'
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
  modpackLabel?: string | null;
  /** Fired after a membership / storage / load-order mutation so the
   *  parent (ProfilesView) can re-pull share-info, drift, profile list. */
  onMembershipChanged?: () => void;
  onLoadOrderChanged?: () => void;
  /** Initial value of the search filter. Useful for tests + deep-links. */
  initialSearch?: string;
  /** Fired whenever the table's search query changes. The modpack detail
   *  view uses it to drive its "Add from Mod Library" filter from the
   *  same box, so one search covers both sections (Solo, 2026-06-10). */
  onSearchChange?: (query: string) => void;
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
  /** Couple membership additions with the active loadout: when true AND this
   *  table is focused on the *active* modpack, adding a stored mod via the
   *  kebab also enables it in the game folder. Removing from a pack remains a
   *  pure membership edit; the storage switch owns active/stored state. */
  coupleActiveStorage?: boolean;
  /** Dedicated modpack view (shows only this pack's mods). Hides the sort
   *  control + the "store unused" bulk action + the checkbox/drag explainer
   *  (all redundant or wrong there), and switches each row's visible action
   *  to "Remove from pack". */
  packScoped?: boolean;
  /** In the dedicated modpack view, allow presentation-only sorts from the
   *  Mod Library. When false, pack rows always render in saved load order and
   *  ignore priorityTag/sort UI state. */
  packVisualSortEnabled?: boolean;
  /** Extra controls rendered in the toolbar, to the right of the search box
   *  (where sort/store-unused sit in the All Mods view). The modpack view
   *  puts its "+ Add mods" / Edit / Load order actions here so they share
   *  the search row. */
  toolbarActions?: ReactNode;
  /** A dedicated second row rendered UNDER the toolbar (search + toolbarActions)
   *  for the pack's bulk actions, so they don't crowd or wrap into the search
   *  row. (FB2-A.) */
  bulkActionsBar?: ReactNode;
  /** External re-fetch trigger. When this value changes, the focused-mode
   *  membership grid is re-pulled. Lets a parent that mutates membership
   *  outside this table (e.g. the modpack view's "Add from your Library"
   *  section) keep the in-pack rows in sync. */
  reloadToken?: string | number;
  /** Pre-filter the rows from the membership grid before sorting +
   *  rendering. Used by the Library view to apply tag / extra filters
   *  on top of the table's own search. */
  filterRow?: (row: ProfileMembershipMod) => boolean;
  /** Tag to prioritise in the ordering (from the page Tag picker). When set,
   *  mods carrying this tag sort to the top, then the rest order by their first
   *  tag A–Z (untagged last); ties by display name. OVERRIDES the sort mode
   *  while a tag is chosen, and hides nothing — it only reorders. */
  priorityTag?: string;
  /** Additional rows supplied by the parent when the backend membership grid
   *  cannot represent a saved manifest entry, e.g. a missing modpack member. */
  extraRows?: ProfileMembershipMod[];

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
  /** Fired when the user clicks a provider-evidence update pill on a row
   *  that has pending update plans. Opens the update review sheet so the
   *  user can pick + apply — never silently applies. Optional so the
   *  Library view keeps the pills inert when nothing else is wired. */
  onReviewUpdates?: (plans: UpdatePlanItem[]) => void;
  onTogglePin?: (mod: ModInfo) => void;
  onSnooze?: (mod: ModInfo, audit: ModAuditEntry | undefined) => void;
  onUnsnooze?: (mod: ModInfo) => void;
  onRepair?: (mod: ModInfo) => void;
  onRollback?: (mod: ModInfo) => void;
  onDelete?: (mod: ModInfo, removableLocalVersion?: StoredVersionGuidance) => Promise<void> | void;
  onCopyVersion?: (mod: ModInfo) => void;
  onOpenThisModFolder?: (mod: ModInfo) => void;
  onEditSources?: (mod: ModInfo) => void;
  onFindGithubFromNexus?: (mod: ModInfo) => void;
  onOpenExternalUrl?: (url: string, mod: ModInfo) => void;
  onAutoDetectSource?: (mod: ModInfo) => void;
  onSelectProfileVersion?: (
    current: ProfileMembershipMod,
    selected: LocalModVersionOption,
    applyToDisk: boolean,
    targetEnabled?: boolean,
  ) => Promise<void> | void;
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
    {
      sensitivity: 'base',
      numeric: true,
    },
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
  const info =
    modInfoByKey?.get(membershipRowKey(row)) ?? modInfoByKey?.get(row.name);
  const tags = (info?.tags ?? [])
    .map((tg) => tg.trim().toLowerCase())
    .filter(Boolean);
  if (tags.length === 0) return null;
  return tags.sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }),
  )[0];
}

/** Whether a row's ModInfo carries the given (already case-folded) tag. */
function rowHasTag(
  row: ProfileMembershipMod,
  lowerTag: string,
  modInfoByKey?: Map<string, ModInfo>,
): boolean {
  const info =
    modInfoByKey?.get(membershipRowKey(row)) ?? modInfoByKey?.get(row.name);
  return (info?.tags ?? []).some(
    (tg) => tg.trim().toLocaleLowerCase() === lowerTag,
  );
}

/** Whether a row has at least one manager tag after trimming whitespace. */
function rowHasAnyTags(
  row: ProfileMembershipMod,
  modInfoByKey?: Map<string, ModInfo>,
): boolean {
  const info =
    modInfoByKey?.get(membershipRowKey(row)) ?? modInfoByKey?.get(row.name);
  return (info?.tags ?? []).some((tg) => tg.trim().length > 0);
}

function sourceHintForRow(
  row: ProfileMembershipMod,
  modInfoByKey?: Map<string, ModInfo>,
): string | null {
  const info =
    modInfoByKey?.get(membershipRowKey(row)) ?? modInfoByKey?.get(row.name);
  return (
    info?.workshop_url ??
    row.workshop_url ??
    row.source ??
    info?.source ??
    info?.github_url ??
    info?.nexus_url ??
    null
  );
}

function conflictNormalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase();
}

function duplicateSourceFamilyKey(
  row: ProfileMembershipMod,
  info?: ModInfo,
): string {
  const modId = conflictNormalize(info?.mod_id ?? row.mod_id);
  if (modId) return `mod_id:${modId}`;
  return `name:${conflictNormalize(info?.name ?? row.name)}`;
}

function duplicateSourceBucket(
  row: ProfileMembershipMod,
  info?: ModInfo,
): 'workshop' | 'local' {
  if (isWorkshopOwned(info) || isWorkshopOwned(row)) {
    return 'workshop';
  }
  return 'local';
}

function activeRepresentativePriority(
  row: ProfileMembershipMod,
  info?: ModInfo,
): number {
  if (!row.installed_enabled) return 0;
  return duplicateSourceBucket(row, info) === 'local' ? 2 : 1;
}

function cleanDisplayVersion(version: string): string {
  const cleaned = version.trim().replace(/^v/i, '');
  return cleaned || '?';
}

function versionOptionIdentity(option: LocalModVersionOption): string {
  return (option.mod_id ?? option.folder_name ?? option.name)
    .trim()
    .toLocaleLowerCase();
}

function versionOptionSourceIdentity(option: LocalModVersionOption): string {
  // Version records can inherit Workshop linkage from the logical mod even
  // when this particular artifact came from Nexus/GitHub. Artifact-owned
  // provenance must win; otherwise one Steam item appears as several
  // selectable "Steam Workshop versions".
  if (isWorkshopOwned(option)) {
    return `workshop:${option.workshop_item_id ?? option.workshop_url ?? option.folder_name ?? 'unknown'}`;
  }
  if (option.nexus_url || sourceHasNexus(option.source)) {
    return `nexus:${option.nexus_url ?? option.source ?? option.mod_version_id}`;
  }
  if (option.github_url || sourceHasGithub(option.source)) {
    return `github:${option.github_url ?? option.source ?? option.mod_version_id}`;
  }
  if (isWorkshopSource(option)) {
    return `workshop:${option.workshop_item_id ?? option.workshop_url ?? option.folder_name ?? 'unknown'}`;
  }
  return [
    option.source,
    option.folder_name,
    option.mod_version_id,
  ]
    .map((part) => part?.trim())
    .find((part) => part)
    ?? 'local:unknown';
}

function sourceUrlHostname(source: string | null | undefined): string | null {
  const value = source?.trim();
  if (!value) return null;

  try {
    return new URL(value).hostname.toLocaleLowerCase();
  } catch {
    try {
      return new URL(`https://${value}`).hostname.toLocaleLowerCase();
    } catch {
      return null;
    }
  }
}

function hostMatchesDomain(hostname: string | null, domain: string): boolean {
  return hostname === domain || hostname?.endsWith(`.${domain}`) === true;
}

function sourceHasGithub(source: string | null | undefined): boolean {
  const value = source?.trim().toLocaleLowerCase() ?? '';
  return value.startsWith('github:') || hostMatchesDomain(sourceUrlHostname(source), 'github.com');
}

function sourceHasNexus(source: string | null | undefined): boolean {
  const value = source?.trim().toLocaleLowerCase() ?? '';
  return value.startsWith('nexus:') || hostMatchesDomain(sourceUrlHostname(source), 'nexusmods.com');
}

function versionOptionSourceKeys(
  option: LocalModVersionOption,
): Array<'steamWorkshop' | 'gitHub' | 'nexus' | 'link' | 'manual'> {
  if (isWorkshopOwned(option)) {
    return ['steamWorkshop'];
  }
  const keys: Array<'gitHub' | 'nexus'> = [];
  if (option.github_url || sourceHasGithub(option.source)) keys.push('gitHub');
  if (option.nexus_url || sourceHasNexus(option.source)) keys.push('nexus');
  if (keys.length > 0) return keys;
  if (isWorkshopSource(option)) return ['steamWorkshop'];
  if (option.source?.trim()) return ['link'];
  return ['manual'];
}

function rowSourceIdentity(row: ProfileMembershipMod, info?: ModInfo): string {
  if (isWorkshopSource(row) || isWorkshopSource(info)) {
    return `workshop:${row.workshop_item_id ?? info?.workshop_item_id ?? row.workshop_url ?? info?.workshop_url ?? row.folder_name ?? 'unknown'}`;
  }
  return [
    info?.github_url,
    row.github_url,
    info?.nexus_url,
    row.nexus_url,
    row.source,
    info?.source,
    row.folder_name,
    row.mod_version_id,
  ]
    .map((part) => part?.trim())
    .find((part) => part)
    ?? 'local:unknown';
}

function versionOptionVariantIdentity(option: LocalModVersionOption): string {
  return `${modVersionSortValue(option.version)}::${versionOptionSourceIdentity(option)}`;
}

function rowVariantIdentity(row: ProfileMembershipMod, info?: ModInfo): string {
  return `${modVersionSortValue(row.version)}::${rowSourceIdentity(row, info)}`;
}

function versionOptionForSourceLabel(
  option: LocalModVersionOption,
  row: ProfileMembershipMod,
  info?: ModInfo | null,
): LocalModVersionOption {
  if (isWorkshopOwned(option)) return option;
  return {
    ...option,
    github_url: option.github_url ?? info?.github_url ?? row.github_url ?? null,
    nexus_url: option.nexus_url ?? info?.nexus_url ?? row.nexus_url ?? null,
  };
}

function dedupeVersionOptions(
  options: LocalModVersionOption[],
): LocalModVersionOption[] {
  const sorted = [...options].sort((a, b) => {
    const byVersion = modVersionSortValue(b.version).localeCompare(
      modVersionSortValue(a.version),
      undefined,
      { sensitivity: 'base', numeric: true },
    );
    return (
      byVersion ||
      Number(b.installed_enabled) - Number(a.installed_enabled) ||
      Number(b.installed) - Number(a.installed) ||
      Number(b.cached) - Number(a.cached) ||
      (b.used_by_profiles?.length ?? 0) - (a.used_by_profiles?.length ?? 0) ||
      a.name.localeCompare(b.name, undefined, {
        sensitivity: 'base',
        numeric: true,
      })
    );
  });
  const seen = new Set<string>();
  return sorted.filter((option) => {
    const key = `${versionOptionIdentity(option)}::${modVersionSortValue(option.version)}::${versionOptionSourceIdentity(option)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface VersionRemovalWizardState {
  row: ProfileMembershipMod;
  option: LocalModVersionOption;
  preview: LocalModVersionRemovalPreview;
  mode: ManualModVersionRemovalMode;
  activeReplacementId: string;
  profileReplacementIds: Record<string, string>;
  committing: boolean;
}

export function LibraryTable({
  modpackName,
  modpackLabel,
  onMembershipChanged,
  onLoadOrderChanged,
  initialSearch = '',
  onSearchChange,
  initialSort,
  pageSize = DEFAULT_PAGE_SIZE,
  enableReorder = false,
  coupleActiveStorage = false,
  packScoped = false,
  packVisualSortEnabled = false,
  toolbarActions,
  bulkActionsBar,
  reloadToken,
  filterRow,
  priorityTag = '',
  extraRows = [],
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
  onReviewUpdates,
  onTogglePin,
  onSnooze,
  onUnsnooze,
  onRepair,
  onRollback,
  onDelete,
  onCopyVersion,
  onOpenThisModFolder,
  onEditSources,
  onFindGithubFromNexus,
  onOpenExternalUrl,
  onAutoDetectSource,
  onSelectProfileVersion,
  renderSourceEditor,
}: LibraryTableProps) {
  const { t } = useTranslation();
  const toastCtx = useToast();
  const confirm = useConfirm();
  const {
    mods: appMods,
    refreshAll,
    activeProfile,
    activeProfileId,
  } = useApp();
  const focusedProfileLabel = profileDisplayName(
    modpackLabel ?? modpackName,
    t('quickAdd.unknown'),
  );

  const [grid, setGrid] = useState<ProfileMembershipGrid | null>(null);
  const [libraryVersionOptionsById, setLibraryVersionOptionsById] = useState<
    Map<string, LocalModVersionOption[]>
  >(new Map());
  const [loading, setLoading] = useState(modpackName != null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState(initialSearch);
  const [sort, setSort] = useState<LibrarySortMode>(
    initialSort ??
      (packScoped ? 'loadOrder' : modpackName ? 'inPackFirst' : 'nameAsc'),
  );
  const [visibleLimit, setVisibleLimit] = useState(pageSize);
  const [guidedDelete, setGuidedDelete] = useState<{ rowKey: string; versionKey: string } | null>(null);

  useEffect(() => {
    if (!guidedDelete) return;
    const timeout = window.setTimeout(() => setGuidedDelete(null), 6000);
    return () => window.clearTimeout(timeout);
  }, [guidedDelete]);

  useEffect(() => {
    setGuidedDelete(null);
  }, [reloadToken]);
  const [membershipSaving, setMembershipSaving] = useState<string | null>(null);
  const [storageSaving, setStorageSaving] = useState<string | null>(null);
  const [removingVersionKey, setRemovingVersionKey] = useState<string | null>(
    null,
  );
  const [keepingOnlyVersionKey, setKeepingOnlyVersionKey] = useState<string | null>(
    null,
  );
  const [versionRemovalWizard, setVersionRemovalWizard] =
    useState<VersionRemovalWizardState | null>(null);
  const [selectedVersionKeyByRow, setSelectedVersionKeyByRow] = useState<
    Map<string, string>
  >(new Map());
  // Comfortable / compact row density (persisted, shared with the modpack view).
  const [density, setDensity] = useModListDensity();

  useEffect(() => {
    if (packScoped && !packVisualSortEnabled) setSort('loadOrder');
  }, [packScoped, packVisualSortEnabled]);

  // Scroll-pin safety net (shared with ModpackDetail via usePinScroll):
  // a row mutation triggers refreshAll + a full re-render, and we don't want
  // any engine/layout quirk to yank the page. pinScroll() re-pins the nearest
  // scrollable ancestor to where it was when the mutation began.
  const { ref: rootRef, pinScroll } = usePinScroll<HTMLDivElement>();

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
    () =>
      appMods
        .map((m) => m.folder_name ?? m.name)
        .sort()
        .join('\u0000'),
    [appMods],
  );

  const load = useCallback(async () => {
    if (modpackName == null) {
      // No-focus mode — rows are synthesized from the AppContext mods
      // array (see the synthesizedGrid useMemo below). Fetch only the compact
      // version-option map so promoted/downloaded versions can appear here without
      // pulling the full profile-by-mod membership grid.
      try {
        setLoading(true);
        setError(null);
        const result = await getLibraryVersionOptions();
        setLibraryVersionOptionsById(new Map(Object.entries(result)));
      } catch (e) {
        setLibraryVersionOptionsById(new Map());
        console.debug('getLibraryVersionOptions failed:', e);
      } finally {
        setLoading(false);
      }
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
        mod_version_id: mod.mod_version_id ?? null,
        name: mod.name,
        version: mod.version,
        folder_name: mod.folder_name,
        mod_id: mod.mod_id,
        display_name: mod.display_name,
        source: mod.source,
        github_url: mod.github_url,
        nexus_url: mod.nexus_url,
        install_source: mod.install_source,
        workshop_item_id: mod.workshop_item_id ?? null,
        workshop_url: mod.workshop_url ?? null,
        installed: true,
        cached: false,
        installed_enabled: mod.enabled,
        version_options: mod.mod_version_id
          ? (libraryVersionOptionsById.get(mod.mod_version_id) ?? [])
          : [],
        profiles: [],
      })),
    };
  }, [modpackName, appMods, libraryVersionOptionsById]);

  const baseGrid = modpackName == null ? synthesizedGrid : grid;
  const effectiveGrid = useMemo<ProfileMembershipGrid | null>(() => {
    if (!baseGrid || extraRows.length === 0) return baseGrid;
    const seen = new Set(baseGrid.mods.map((row) => membershipRowKey(row)));
    const appended = extraRows.filter((row) => {
      const key = membershipRowKey(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (appended.length === 0) return baseGrid;
    return { ...baseGrid, mods: [...baseGrid.mods, ...appended] };
  }, [baseGrid, extraRows]);

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
    return row.profiles.find(
      (p) => p.profile_id === modpackName || p.profile_name === modpackName,
    );
  }

  const modInfoForRow = useCallback(
    (row: ProfileMembershipMod) => {
      const rowKey = membershipRowKey(row);
      const exact = modInfoByKey?.get(rowKey);
      if (exact) return exact;
      if (row.installed === false || row.mod_version_id) return undefined;
      return (
        modInfoByKey?.get(row.folder_name ?? '') ??
        modInfoByKey?.get(row.mod_id ?? '') ??
        modInfoByKey?.get(row.name)
      );
    },
    [modInfoByKey],
  );

  const logicalRowsByKey = useMemo(() => {
    const groups = new Map<string, ProfileMembershipMod[]>();
    for (const row of effectiveGrid?.mods ?? []) {
      const key = logicalModKey(row, modInfoForRow(row));
      const group = groups.get(key) ?? [];
      group.push(row);
      groups.set(key, group);
    }
    return groups;
  }, [effectiveGrid, modInfoForRow]);

  const groupRowsFor = useCallback((row: ProfileMembershipMod) =>
    logicalRowsByKey.get(logicalModKey(row, modInfoForRow(row))) ?? [row],
  [logicalRowsByKey, modInfoForRow]);

  const versionOptionsByKey = useMemo(() => {
    const map = new Map<string, LocalModVersionOption[]>();
    if (!effectiveGrid) return map;
    for (const row of effectiveGrid.mods) {
      const options = dedupeVersionOptions(row.version_options ?? []);
      const variantCount = new Set(options.map(versionOptionVariantIdentity)).size;
      if (options.length > 1 && variantCount > 1) {
        map.set(membershipRowKey(row), options);
      }
    }
    const groups = new Map<string, ProfileMembershipMod[]>();
    for (const row of effectiveGrid.mods) {
      if (map.has(membershipRowKey(row))) continue;
      const info = modInfoForRow(row);
      const groupKey = logicalModKey(row, info);
      const existing = groups.get(groupKey);
      if (existing) existing.push(row);
      else groups.set(groupKey, [row]);
    }
    for (const group of groups.values()) {
      const variantCount = new Set(
        group.map((row) => rowVariantIdentity(row, modInfoForRow(row))),
      ).size;
      const canSelectVersions = group.every((row) => !!row.mod_version_id);
      if (group.length < 2 || variantCount < 2 || !canSelectVersions) continue;
      const sortedGroup = [...group].sort((a, b) => {
        const byVersion = modVersionSortValue(b.version).localeCompare(
          modVersionSortValue(a.version),
          undefined,
          { sensitivity: 'base', numeric: true },
        );
        return byVersion || compareMembershipDisplayName(a, b);
      });
      const fallbackOptions = dedupeVersionOptions(
        sortedGroup.map((option) => ({
          mod_version_id: membershipRowKey(option),
          name: option.name,
          version: option.version,
          folder_name: option.folder_name,
          mod_id: option.mod_id,
          display_name: option.display_name,
          source: option.source,
          github_url: option.github_url,
          nexus_url: option.nexus_url,
          install_source: option.install_source,
          workshop_item_id: option.workshop_item_id,
          workshop_url: option.workshop_url,
          installed: option.installed ?? true,
          installed_enabled: option.installed_enabled,
          cached: option.cached ?? false,
          pinned: false,
          used_by_profiles: option.profiles
            .filter((profile) => profile.included)
            .map((profile) => profile.profile_name),
        })),
      );
      for (const row of group) {
        if (map.has(membershipRowKey(row))) continue;
        map.set(membershipRowKey(row), fallbackOptions);
      }
    }
    return map;
  }, [effectiveGrid, modInfoByKey, modInfoForRow]);

  const groupAuditsFor = useCallback((row: ProfileMembershipMod) => {
    const seen = new Set<ModAuditEntry>();
    const entries: ModAuditEntry[] = [];
    for (const member of groupRowsFor(row)) {
      const memberKey = membershipRowKey(member);
      const loadedOptions = versionOptionsByKey.get(memberKey) ?? [];
      for (const candidate of [
        member,
        ...(member.version_options ?? []),
        ...loadedOptions,
      ]) {
        const audit = auditByKey?.get(candidate.mod_version_id ?? '') ??
          auditByKey?.get(candidate.folder_name ?? '') ?? auditByKey?.get(candidate.name);
        if (audit && !seen.has(audit)) {
          seen.add(audit);
          entries.push(audit);
        }
      }
    }
    return entries;
  }, [auditByKey, groupRowsFor, versionOptionsByKey]);

  const duplicateSourceConflictKeys = useMemo(() => {
    if (!effectiveGrid) return new Set<string>();
    const groups = new Map<
      string,
      { buckets: Set<'workshop' | 'local'>; keys: Set<string> }
    >();
    for (const row of effectiveGrid.mods) {
      const info = modInfoForRow(row);
      if (row.installed === false && !info) continue;
      if (!row.installed_enabled) continue;
      const key = `${duplicateSourceFamilyKey(row, info)}::${modVersionSortValue(row.version)}`;
      const group =
        groups.get(key) ??
        { buckets: new Set<'workshop' | 'local'>(), keys: new Set<string>() };
      group.buckets.add(duplicateSourceBucket(row, info));
      group.keys.add(membershipRowKey(row));
      groups.set(key, group);
    }
    const conflicts = new Set<string>();
    for (const group of groups.values()) {
      if (group.buckets.has('workshop') && group.buckets.has('local')) {
        for (const key of group.keys) conflicts.add(key);
      }
    }
    return conflicts;
  }, [effectiveGrid, modInfoForRow]);

  const activeBundleOwnerByRuntimeId = useMemo(() => {
    const owners = new Map<string, string>();
    for (const row of effectiveGrid?.mods ?? []) {
      if (!row.installed_enabled) continue;
      const info = modInfoForRow(row);
      const memberIds = info?.bundle_member_ids ?? row.bundle_member_ids ?? [];
      if (memberIds.length === 0) continue;
      const bundleName =
        info?.display_name?.trim() ||
        row.display_name?.trim() ||
        info?.name ||
        row.name;
      for (const runtimeId of memberIds) {
        const key = conflictNormalize(runtimeId);
        if (key && !owners.has(key)) owners.set(key, bundleName);
      }
    }
    return owners;
  }, [effectiveGrid, modInfoForRow]);

  /** Rows that have this modpack in their `profiles` array (so the
   *  table can show the in-pack subset for drag reorder + counts).
   *  Empty when modpackName is null (no concept of "in pack"). */
  const inPackRowKeys = useMemo(() => {
    if (!effectiveGrid || modpackName == null) return new Set<string>();
    const set = new Set<string>();
    for (const row of effectiveGrid.mods) {
      const state = row.profiles.find(
        (p) => p.profile_id === modpackName || p.profile_name === modpackName,
      );
      if (state?.included) set.add(membershipRowKey(row));
    }
    return set;
  }, [effectiveGrid, modpackName]);

  // Build the load-order draft from the grid + modpackName whenever
  // the grid updates. The backend sends each profile row's saved manifest
  // index so pack-scoped views follow the real modpack order even when the
  // installed library scan returns rows alphabetically.
  useEffect(() => {
    if (!effectiveGrid || modpackName == null) {
      setLoadOrderDraft([]);
      return;
    }
    const inPack = effectiveGrid.mods
      .map((row, gridIndex) => ({
        row,
        gridIndex,
        state: row.profiles.find(
          (p) => p.profile_id === modpackName || p.profile_name === modpackName,
        ),
      }))
      .filter(({ state }) => state?.included)
      .sort((a, b) => {
        const ai =
          typeof a.state?.order_index === 'number'
            ? a.state.order_index
            : Number.MAX_SAFE_INTEGER;
        const bi =
          typeof b.state?.order_index === 'number'
            ? b.state.order_index
            : Number.MAX_SAFE_INTEGER;
        return ai - bi || a.gridIndex - b.gridIndex;
      })
      .map(({ row }) => row);
    setLoadOrderDraft(
      inPack.map((row) => ({
        name: row.name,
        version: row.version,
        source: null,
        hash: null,
        files: [],
        enabled: row.installed_enabled,
        bundle_url: null,
        mod_version_id: row.mod_version_id ?? null,
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
    const externallyFiltered = filterRow
      ? effectiveGrid.mods.filter(filterRow)
      : effectiveGrid.mods;
    const visualSortActive = !packScoped || packVisualSortEnabled;
    const preFiltered =
      visualSortActive && priorityTag === NO_TAGS_FILTER_VALUE
        ? externallyFiltered.filter((row) => !rowHasAnyTags(row, modInfoByKey))
        : externallyFiltered;
    const loadOrderIndex = (row: ProfileMembershipMod) => {
      const rowKey = membershipRowKey(row);
      const idx = loadOrderDraft.findIndex(
        (pm) =>
          (pm.mod_version_id ?? pm.folder_name ?? pm.mod_id ?? pm.name) ===
            rowKey ||
          (!!row.mod_version_id && pm.mod_version_id === row.mod_version_id) ||
          (!!row.folder_name && pm.folder_name === row.folder_name) ||
          (!!row.mod_id && pm.mod_id === row.mod_id) ||
          pm.name === row.name,
      );
      if (idx !== -1) return idx;
      const savedIndex = focusedState(row)?.order_index;
      return typeof savedIndex === 'number'
        ? savedIndex
        : Number.MAX_SAFE_INTEGER;
    };
    const compareLoadOrder = (
      a: ProfileMembershipMod,
      b: ProfileMembershipMod,
    ) =>
      loadOrderIndex(a) - loadOrderIndex(b) ||
      compareMembershipDisplayName(a, b);
    const searchedRows = query
      ? preFiltered.filter((row) => {
          // Tags are part of the haystack so "anime" finds every mod the
          // user tagged that way, not just name matches (Solo, 2026-06-10).
          const info = modInfoForRow(row);
          const haystack = [
            row.name,
            row.display_name ?? '',
            row.folder_name ?? '',
            row.mod_id ?? '',
            row.version,
            ...(info?.tags ?? []),
          ]
            .join(' ')
            .toLowerCase();
          return haystack.includes(query);
        })
      : preFiltered;
    const groups = new Map<string, ProfileMembershipMod[]>();
    for (const row of searchedRows) {
      const info = modInfoForRow(row);
      const groupKey = logicalModKey(row, info);
      const existing = groups.get(groupKey);
      if (existing) existing.push(row);
      else groups.set(groupKey, [row]);
    }
    const rows = [...groups.values()].flatMap((group) => {
      const canSelectVersions = group.every((row) => !!row.mod_version_id);
      if (group.length === 1 || !canSelectVersions) return group;
      return [
        [...group].sort((a, b) => {
          if (packScoped) return compareLoadOrder(a, b);
          if (a.installed_enabled !== b.installed_enabled) {
            return Number(b.installed_enabled) - Number(a.installed_enabled);
          }
          const aInfo = modInfoForRow(a);
          const bInfo = modInfoForRow(b);
          const byEffectiveSource =
            activeRepresentativePriority(b, bInfo) -
            activeRepresentativePriority(a, aInfo);
          if (a.installed_enabled && b.installed_enabled) {
            const byActiveVersion = modVersionSortValue(b.version).localeCompare(
              modVersionSortValue(a.version),
              undefined,
              { sensitivity: 'base', numeric: true },
            );
            if (byActiveVersion) return byActiveVersion;
          }
          if (byEffectiveSource) return byEffectiveSource;
          const byVersion = modVersionSortValue(b.version).localeCompare(
            modVersionSortValue(a.version),
            undefined,
            { sensitivity: 'base', numeric: true },
          );
          return byVersion || compareMembershipDisplayName(a, b);
        })[0],
      ];
    });
    const sorted = [...rows];
    sorted.sort((a, b) => {
      const aIn = inPackRowKeys.has(membershipRowKey(a));
      const bIn = inPackRowKeys.has(membershipRowKey(b));
      if (packScoped && !packVisualSortEnabled) return compareLoadOrder(a, b);
      // Tag-priority ordering (the page Tag picker) OVERRIDES the sort mode
      // while a tag is chosen: that tag's mods first, then the rest by first
      // tag A–Z (untagged last); ties by display name. Nothing is hidden.
      if (priorityTag && priorityTag !== NO_TAGS_FILTER_VALUE) {
        const key = priorityTag.toLocaleLowerCase();
        const aHas = rowHasTag(a, key, modInfoByKey);
        const bHas = rowHasTag(b, key, modInfoByKey);
        if (aHas !== bHas) return aHas ? -1 : 1;
        const at = firstTagKey(a, modInfoByKey);
        const bt = firstTagKey(b, modInfoByKey);
        if (at !== bt) {
          /* v8 ignore start -- sort comparator call direction is engine-dependent; ordering behavior is tested. */
          if (at === null) return 1; // untagged after tagged
          if (bt === null) return -1;
          const byTag = at.localeCompare(bt, undefined, {
            sensitivity: 'base',
            numeric: true,
          });
          if (byTag !== 0) return byTag;
          /* v8 ignore stop */
        }
        return compareMembershipDisplayName(a, b);
      }
      if (sort === 'updatesFirst') {
        const au = projectProviderUpdates(groupAuditsFor(a)).hasPending;
        const bu = projectProviderUpdates(groupAuditsFor(b)).hasPending;
        if (au !== bu) return au ? -1 : 1;
        return compareMembershipDisplayName(a, b);
      }
      if (sort === 'loadOrder') return compareLoadOrder(a, b);
      if (sort === 'nameDesc') return compareMembershipDisplayName(b, a);
      if (sort === 'inPackFirst') {
        if (aIn !== bIn) return Number(bIn) - Number(aIn);
        return compareMembershipDisplayName(a, b);
      }
      if (sort === 'activeFirst') {
        return (
          Number(b.installed_enabled) - Number(a.installed_enabled) ||
          compareMembershipDisplayName(a, b)
        );
      }
      if (sort === 'storedFirst') {
        return (
          Number(a.installed_enabled) - Number(b.installed_enabled) ||
          compareMembershipDisplayName(a, b)
        );
      }
      return compareMembershipDisplayName(a, b);
    });
    return sorted;
  }, [
    effectiveGrid,
    filter,
    sort,
    priorityTag,
    inPackRowKeys,
    filterRow,
    modInfoByKey,
    modInfoForRow,
    loadOrderDraft,
    auditByKey,
    groupAuditsFor,
    packScoped,
    packVisualSortEnabled,
  ]);

  const visibleItems = filteredRows.slice(0, visibleLimit);

  async function handleSelectRowVersion(
    row: ProfileMembershipMod,
    selectedKey: string,
  ) {
    /* v8 ignore next -- rendered selects only emit real option changes. */
    if (!effectiveGrid || selectedKey === membershipRowKey(row)) return;
    const rowKey = membershipRowKey(row);
    const options = versionOptionsByKey.get(rowKey) ?? [];
    const selected = options.find(
      (option) => option.mod_version_id === selectedKey,
    );
    /* v8 ignore next -- selectedKey comes from the rendered option list. */
    if (!selected) return;
    const packActive =
      modpackName != null &&
      (modpackName === activeProfileId ||
        (!activeProfileId && modpackName === activeProfile));
    try {
      pinScroll();
      setSelectedVersionKeyByRow((prev) => {
        const next = new Map(prev);
        next.set(rowKey, selectedKey);
        return next;
      });
      if (packScoped && modpackName) {
        await onSelectProfileVersion?.(row, selected, packActive);
        await onMembershipChanged?.();
        await onLoadOrderChanged?.();
      } else {
        await selectLibraryModVersion(
          {
            mod_version_id: row.mod_version_id ?? null,
            folder_name: row.folder_name ?? null,
            mod_id: row.mod_id ?? null,
            install_source: row.install_source,
            workshop_item_id: row.workshop_item_id ?? null,
            workshop_url: row.workshop_url ?? null,
            name: row.name,
          },
          {
            mod_version_id: selected.mod_version_id,
            folder_name: selected.folder_name ?? null,
            mod_id: selected.mod_id ?? null,
            install_source: selected.install_source,
            workshop_item_id: selected.workshop_item_id ?? null,
            workshop_url: selected.workshop_url ?? null,
            name: selected.name,
          },
        );
      }
      await refreshAll();
      await load();
      toastCtx.success(
        t('profiles.library.versionSelectToast', {
          name: selected.display_name?.trim() || selected.name,
          version: selected.version,
        }),
      );
    } catch (e) {
      toastCtx.error(
        t('profiles.library.versionSelectFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setSelectedVersionKeyByRow((prev) => {
        if (!prev.has(rowKey)) return prev;
        const next = new Map(prev);
        next.delete(rowKey);
        return next;
      });
    }
  }

  async function handleRestoreCachedRow(row: ProfileMembershipMod) {
    if (!row.mod_version_id || storageSaving || membershipSaving) return;
    const selected: LocalModVersionOption = {
      mod_version_id: row.mod_version_id,
      name: row.name,
      version: row.version,
      folder_name: row.folder_name,
      mod_id: row.mod_id,
      display_name: row.display_name,
      source: row.source,
      github_url: row.github_url,
      nexus_url: row.nexus_url,
      install_source: row.install_source,
      workshop_item_id: row.workshop_item_id,
      workshop_url: row.workshop_url,
      bundle_member_ids: row.bundle_member_ids,
      installed: false,
      installed_enabled: false,
      cached: true,
      pinned: false,
      used_by_profiles: [],
    };
    const packActive =
      modpackName != null &&
      (modpackName === activeProfileId ||
        (!activeProfileId && modpackName === activeProfile));
    try {
      pinScroll();
      setStorageSaving(libraryStorageKey(row));
      await onSelectProfileVersion?.(row, selected, packActive, true);
      await onMembershipChanged?.();
      await onLoadOrderChanged?.();
      await refreshAll();
      await load();
      toastCtx.success(
        t('profiles.library.versionSelectToast', {
          name: selected.display_name?.trim() || selected.name,
          version: selected.version,
        }),
      );
    } catch (e) {
      toastCtx.error(
        t('profiles.library.versionSelectFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setStorageSaving(null);
    }
  }

  async function handleRemoveRowVersion(
    row: ProfileMembershipMod,
    option: LocalModVersionOption,
  ) {
    const displayVersion = cleanDisplayVersion(option.version);
    try {
      setRemovingVersionKey(option.mod_version_id);
      const preview = await previewLibraryModVersionRemoval(
        option.mod_version_id,
      );
      if (!preview.can_delete_directly) {
        const defaultReplacement =
          preview.replacement_candidates[0]?.mod_version_id ?? '';
        setVersionRemovalWizard({
          row,
          option,
          preview,
          mode:
            preview.replacement_candidates.length > 0
              ? 'remap'
              : 'remove_from_packs',
          activeReplacementId: defaultReplacement,
          profileReplacementIds: Object.fromEntries(
            preview.affected_profiles.map((profile) => [
              profile.profile_id,
              defaultReplacement,
            ]),
          ),
          committing: false,
        });
        return;
      }

      const ok = await confirm({
        title: t('mods.versionRemoveConfirmTitle', {
          mod: option.display_name?.trim() || membershipDisplayName(row),
          version: displayVersion,
        }),
        body: preview.installed
          ? t('mods.versionRemoveConfirmDiskBody')
          : t('mods.versionRemoveConfirmCacheBody'),
        warning: t('mods.versionRemoveConfirmWarning'),
        confirmLabel: t('mods.versionRemoveConfirm'),
        destructive: true,
      });
      if (!ok) return;
      pinScroll();
      await removeLibraryModVersion(option.mod_version_id);
      await refreshAll();
      await load();
      toastCtx.success(
        t('mods.toast.versionRemoved', {
          name: option.display_name?.trim() || membershipDisplayName(row),
          version: displayVersion,
        }),
      );
    } catch (e) {
      toastCtx.error(
        t('mods.toast.versionRemoveFailed', {
          version: displayVersion,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setRemovingVersionKey(null);
    }
  }

  async function handleKeepOnlyRowVersion(
    row: ProfileMembershipMod,
    keeperId: string,
  ): Promise<boolean> {
    const displayName = membershipDisplayName(row);
    try {
      setKeepingOnlyVersionKey(keeperId);
      const cleanup = await previewLibraryVersionCleanup();
      const family = cleanup.families.find((candidateFamily) =>
        candidateFamily.candidates.some(
          (candidate) => candidate.option.mod_version_id === keeperId,
        ));
      const keeper = family?.candidates.find(
        (candidate) => candidate.option.mod_version_id === keeperId,
      );
      if (!family || !keeper) {
        throw new Error(t('mods.versionKeepOnlyUnavailable'));
      }

      const removals = family.candidates.filter(
        (candidate) => candidate.option.mod_version_id !== keeperId,
      );
      const blocked = removals.some((candidate) =>
        candidate.option.pinned
        || candidate.reasons.includes('steam_managed')
        || (candidate.protected && !candidate.replacement_candidates.some(
          (replacement) => replacement.mod_version_id === keeperId,
        )));
      if (removals.length === 0 || blocked) {
        throw new Error(t('mods.versionKeepOnlyUnavailable'));
      }

      const ok = await confirm({
        title: t('mods.versionKeepOnlyConfirmTitle', {
          mod: displayName,
          version: cleanDisplayVersion(keeper.option.version),
        }),
        body: t('mods.versionKeepOnlyConfirmBody'),
        warning: t('mods.versionCleanup.confirmWarning'),
        confirmLabel: t('mods.versionKeepOnlyConfirm'),
        destructive: true,
      });
      if (!ok) return false;

      pinScroll();
      const results = await executeLibraryVersionCleanup(removals.map((candidate) => ({
        mod_version_id: candidate.option.mod_version_id,
        replacement_mod_version_id: candidate.protected ? keeperId : null,
      })));
      const failed = results.filter((result) => !result.success);
      if (failed.length > 0) {
        throw new Error(
          failed.map((result) => result.error || t('mods.versionKeepOnlyItemFailed')).join('; '),
        );
      }

      await refreshAll();
      await load();
      toastCtx.success(t('mods.toast.versionKeptOnly', {
        name: displayName,
        version: cleanDisplayVersion(keeper.option.version),
      }));
      return true;
    } catch (e) {
      toastCtx.error(t('mods.toast.versionKeepOnlyFailed', {
        error: e instanceof Error ? e.message : String(e),
      }));
      return false;
    } finally {
      setKeepingOnlyVersionKey(null);
    }
  }

  async function commitVersionRemovalWizard() {
    if (!versionRemovalWizard || versionRemovalWizard.committing) return;
    const {
      option,
      row,
      preview,
      mode,
      profileReplacementIds,
      activeReplacementId,
    } = versionRemovalWizard;
    const replacements: ManualModVersionProfileReplacement[] =
      preview.affected_profiles.map((profile) => ({
        profile_id: profile.profile_id,
        mod_version_id: profileReplacementIds[profile.profile_id] ?? '',
      }));
    try {
      pinScroll();
      setVersionRemovalWizard((current) =>
        current ? { ...current, committing: true } : current,
      );
      setRemovingVersionKey(option.mod_version_id);
      const result = await removeLibraryModVersionManual(
        option.mod_version_id,
        mode,
        mode === 'remap' ? replacements : [],
        mode === 'remap' && preview.active ? activeReplacementId : null,
      );
      await refreshAll();
      await load();
      setVersionRemovalWizard(null);
      toastCtx.success(
        t('mods.toast.versionManualRemoved', {
          name: option.display_name?.trim() || membershipDisplayName(row),
          version: cleanDisplayVersion(option.version),
          profiles:
            result.mode === 'remap'
              ? (result.remapped_profiles?.length ?? 0)
              : (result.removed_profiles?.length ?? 0),
        }),
      );
    } catch (e) {
      setVersionRemovalWizard((current) =>
        current ? { ...current, committing: false } : current,
      );
      toastCtx.error(
        t('mods.toast.versionRemoveFailed', {
          version: cleanDisplayVersion(option.version),
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setRemovingVersionKey(null);
    }
  }

  function patchRowMembership(rowKey: string, nextIncluded: boolean) {
    setGrid((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        mods: prev.mods.map((mod) => {
          if (membershipRowKey(mod) !== rowKey) return mod;
          return {
            ...mod,
            profiles: mod.profiles.map((p) =>
              p.profile_id === modpackName || p.profile_name === modpackName
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
      // Adding a stored mod to the active pack should activate it before the
      // manifest edit. Removing from a pack is a membership-only action: the
      // storage toggle is the explicit way to move the installed mod between
      // mods/ and mods_disabled/.
      const mirrorsToDisk =
        coupleActiveStorage &&
        (modpackName === activeProfileId ||
          (!activeProfileId && modpackName === activeProfile)) &&
        nextIncluded &&
        row.installed_enabled !== nextIncluded;
      if (mirrorsToDisk) {
        await toggleMod(row.name, row.folder_name, nextIncluded);
        patchRowStorage(membershipRowKey(row), nextIncluded);
      }
      await setProfileModMembership(
        modpackName,
        row.name,
        row.mod_version_id ?? null,
        row.folder_name,
        row.mod_id,
        nextIncluded,
        sourceHintForRow(row, modInfoByKey),
      );
      patchRowMembership(membershipRowKey(row), nextIncluded);
      if (mirrorsToDisk) await refreshAll();
      toastCtx.success(
        nextIncluded
          ? t('profiles.library.toastAdded', {
              mod: membershipDisplayName(row),
              profile: focusedProfileLabel,
            })
          : t('profiles.library.toastRemoved', {
              mod: membershipDisplayName(row),
              profile: focusedProfileLabel,
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
    if (
      nextEnabled &&
      modpackName != null &&
      state &&
      !state.included &&
      state.editable
    ) {
      const result = await confirm({
        title: t('profiles.library.enableNotInPack.title', {
          mod: displayName,
        }),
        body: t('profiles.library.enableNotInPack.body', {
          pack: focusedProfileLabel,
        }),
        cancelLabel: t('profiles.library.enableNotInPack.keepStored'),
        width: 560,
        choices: [
          {
            value: 'enableOnly',
            label: t('profiles.library.enableNotInPack.enableOnly'),
            variant: 'primary',
          },
          {
            value: 'enableAndAdd',
            label: t('profiles.library.enableNotInPack.enableAndAdd', {
              pack: focusedProfileLabel,
            }),
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
      nextEnabled &&
      modpackName != null &&
      state != null &&
      !state.included &&
      !state.editable;

    const key = libraryStorageKey(row);
    try {
      pinScroll();
      setStorageSaving(key);
      await toggleMod(row.name, row.folder_name, nextEnabled);
      patchRowStorage(membershipRowKey(row), nextEnabled);
      if (
        (alsoAddToPack || (state?.included && state.editable)) &&
        modpackName != null
      ) {
        await setProfileModMembership(
          modpackName,
          row.name,
          row.mod_version_id ?? null,
          row.folder_name,
          row.mod_id,
          true,
          sourceHintForRow(row, modInfoByKey),
        );
        if (alsoAddToPack) patchRowMembership(membershipRowKey(row), true);
      }
      await refreshAll();
      if (!nextEnabled) {
        toastCtx.success(
          t('profiles.library.toastStored', { mod: displayName }),
        );
      } else if (alsoAddToPack) {
        toastCtx.success(
          t('profiles.library.toastActivatedAndAdded', {
            mod: displayName,
            pack: focusedProfileLabel,
          }),
        );
      } else if (enabledOutsideFollowedPack) {
        toastCtx.info(
          t('profiles.library.toastActivatedFollowed', {
            mod: displayName,
            pack: focusedProfileLabel,
          }),
        );
      } else {
        toastCtx.success(
          t('profiles.library.toastActivated', { mod: displayName }),
        );
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
      toastCtx.success(
        t('profiles.loadOrder.toastSavedApplied', {
          name: focusedProfileLabel,
        }),
      );
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
        <div className="gf-empty-title">
          {t('profiles.library.empty.title')}
        </div>
        <div className="gf-empty-sub">{t('profiles.library.empty.hint')}</div>
      </div>
    );
  }

  const versionRemovalReplacementOptions = versionRemovalWizard
    ? versionRemovalWizard.preview.replacement_candidates.map((candidate) => ({
        value: candidate.mod_version_id,
        label: t('mods.versionReplacementOption', {
          version: cleanDisplayVersion(candidate.version),
          state: candidate.installed_enabled
            ? t('mods.versionActiveStatus')
            : candidate.installed
              ? t('mods.versionStoredOnDiskStatus')
              : candidate.cached
                ? t('mods.versionSavedStatus')
                : t('mods.versionStoredStatus'),
        }),
      }))
    : [];
  const versionRemovalCanCommit =
    !!versionRemovalWizard &&
    !versionRemovalWizard.committing &&
    !versionRemovalWizard.preview.pinned &&
    (versionRemovalWizard.mode === 'remove_from_packs' ||
      (versionRemovalWizard.preview.replacement_candidates.length > 0 &&
        (!versionRemovalWizard.preview.active ||
          !!versionRemovalWizard.activeReplacementId) &&
        versionRemovalWizard.preview.affected_profiles.every(
          (profile) =>
            !!versionRemovalWizard.profileReplacementIds[profile.profile_id],
        )));

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
            onChange={(event) => {
              setFilter(event.target.value);
              onSearchChange?.(event.target.value);
            }}
            placeholder={
              packScoped
                ? t('profiles.library.searchPackPlaceholder')
                : t('profiles.library.searchPlaceholder', {
                    count: effectiveGrid.mods.length,
                  })
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
            {packVisualSortEnabled && (
              <label className="gf-sort-control gf-profile-library-sort">
                <span>{t('profiles.library.sort.label')}</span>
                <Select
                  value={sort}
                  onChange={(v) => setSort(v as LibrarySortMode)}
                  aria-label={t('profiles.library.sort.label')}
                  options={[
                    {
                      value: 'loadOrder',
                      label: t('profiles.library.sort.loadOrder'),
                    },
                    {
                      value: 'updatesFirst',
                      label: t('profiles.library.sort.updatesFirst'),
                    },
                    {
                      value: 'nameAsc',
                      label: t('profiles.library.sort.nameAsc'),
                    },
                    {
                      value: 'nameDesc',
                      label: t('profiles.library.sort.nameDesc'),
                    },
                    {
                      value: 'activeFirst',
                      label: t('profiles.library.sort.activeFirst'),
                    },
                    {
                      value: 'storedFirst',
                      label: t('profiles.library.sort.storedFirst'),
                    },
                  ]}
                />
              </label>
            )}
            {toolbarActions}
          </div>
        )}
        {!packScoped && (
          <div className="gf-profile-library-toolbar-actions">
            <ModViewToggle density={density} onChange={setDensity} />
            <label className="gf-sort-control gf-profile-library-sort">
              <span>{t('profiles.library.sort.label')}</span>
              <Select
                value={sort}
                onChange={(v) => setSort(v as LibrarySortMode)}
                aria-label={t('profiles.library.sort.label')}
                options={[
                  // "In this modpack first" only makes sense when a modpack
                  // is focused. In the no-focus Library view, this option is
                  // omitted so the user doesn't see a sort with no effect.
                  ...(modpackName != null
                    ? [
                        {
                          value: 'inPackFirst',
                          label: t('profiles.library.sort.inPackFirst'),
                        },
                      ]
                    : []),
                  {
                    value: 'updatesFirst',
                    label: t('profiles.library.sort.updatesFirst'),
                  },
                  {
                    value: 'nameAsc',
                    label: t('profiles.library.sort.nameAsc'),
                  },
                  {
                    value: 'nameDesc',
                    label: t('profiles.library.sort.nameDesc'),
                  },
                  {
                    value: 'activeFirst',
                    label: t('profiles.library.sort.activeFirst'),
                  },
                  {
                    value: 'storedFirst',
                    label: t('profiles.library.sort.storedFirst'),
                  },
                ]}
              />
            </label>
          </div>
        )}
      </div>
      {bulkActionsBar && (
        <div className="gf-profile-library-bulk-bar">{bulkActionsBar}</div>
      )}
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
              <div className="gf-empty-title">
                {t('profiles.library.packEmpty.title')}
              </div>
              <div className="gf-empty-sub">
                {t('profiles.library.packEmpty.hint')}
              </div>
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
              (m.folder_name ?? m.mod_id ?? m.name) ===
              (row.folder_name ?? row.mod_id ?? row.name),
          );
          const rowKey = membershipRowKey(row);
          const modInfo = modInfoForRow(row);
          const activeBundleName = !row.installed_enabled
            ? activeBundleOwnerByRuntimeId.get(
                conflictNormalize(modInfo?.mod_id ?? row.mod_id),
              )
            : undefined;
          const audit = auditByKey?.get(rowKey) ?? auditByKey?.get(row.name);
          const updatePlans = projectProviderUpdates(groupAuditsFor(row)).pendingPlans;
          const sourceEditorSlot =
            modInfo && renderSourceEditor
              ? renderSourceEditor(modInfo)
              : undefined;
          const versionRows = versionOptionsByKey.get(rowKey) ?? [];
          const representativeIsWorkshop = isWorkshopSource(modInfo) || isWorkshopSource(row);
          const removableLocalOption = representativeIsWorkshop
            ? versionRows.find((option) => !!option.github_url || !!option.nexus_url || option.install_source === 'local')
            : undefined;
          const removableLocalRow = representativeIsWorkshop && !removableLocalOption
            ? groupRowsFor(row).find((member) => {
                if (membershipRowKey(member) === rowKey) return false;
                const info = modInfoForRow(member);
                return member.install_source !== 'steam_workshop' && info?.install_source !== 'steam_workshop';
              })
            : undefined;
          const removableLocalInfo = removableLocalRow ? modInfoForRow(removableLocalRow) : undefined;
          const removableSourceKeys = [
            removableLocalOption?.github_url || removableLocalInfo?.github_url || removableLocalRow?.github_url ? 'gitHub' : null,
            removableLocalOption?.nexus_url || removableLocalInfo?.nexus_url || removableLocalRow?.nexus_url ? 'nexus' : null,
          ].filter((key): key is string => !!key);
          const removableLocalVersion = removableLocalOption || removableLocalRow ? {
            key: removableLocalOption?.mod_version_id ?? membershipRowKey(removableLocalRow!),
            version: removableLocalOption?.version ?? removableLocalRow!.version,
            sourceLabel: removableSourceKeys.length
              ? removableSourceKeys.map((key) => t(`mods.versionSource.${key}`)).join(t('mods.versionSource.joiner'))
              : t('mods.local'),
          } : undefined;
          const rowActionHandlers = modInfo
            ? {
                onUpdate: onUpdate ? () => onUpdate(modInfo) : undefined,
                onTogglePin: onTogglePin
                  ? () => onTogglePin(modInfo)
                  : undefined,
                onSnooze: onSnooze ? () => onSnooze(modInfo, audit) : undefined,
                onUnsnooze: onUnsnooze ? () => onUnsnooze(modInfo) : undefined,
                onRepair: onRepair ? () => onRepair(modInfo) : undefined,
                onRollback: onRollback ? () => onRollback(modInfo) : undefined,
                onDelete: onDelete ? async () => {
                  await onDelete(modInfo, removableLocalVersion);
                  if (representativeIsWorkshop && removableLocalVersion) {
                    setGuidedDelete({ rowKey, versionKey: removableLocalVersion.key });
                  }
                } : undefined,
                onCopyVersion: onCopyVersion
                  ? () => onCopyVersion(modInfo)
                  : undefined,
                onOpenThisModFolder: onOpenThisModFolder
                  ? () => onOpenThisModFolder(modInfo)
                  : undefined,
                onEditSources: onEditSources
                  ? () => onEditSources(modInfo)
                  : undefined,
                onFindGithubFromNexus: onFindGithubFromNexus
                  ? () => onFindGithubFromNexus(modInfo)
                  : undefined,
                onOpenExternalUrl: onOpenExternalUrl
                  ? (url: string) => onOpenExternalUrl(url, modInfo)
                  : undefined,
                onAutoDetectSource: onAutoDetectSource
                  ? () => onAutoDetectSource(modInfo)
                  : undefined,
              }
            : {};
          return (
            <LibraryRow
              key={rowKey}
              row={row}
              modpackName={modpackName}
              modpackLabel={focusedProfileLabel}
              state={state}
              inPack={inPack}
              inPackIndex={inPackIndex}
              enableReorder={enableReorder}
              packScoped={packScoped}
              packActive={
                modpackName != null &&
                (modpackName === activeProfileId ||
                  (!activeProfileId && modpackName === activeProfile))
              }
              isDragOver={dragOverIndex === inPackIndex && inPack}
              isDragging={draggedIndex === inPackIndex && inPack}
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
                /* v8 ignore next -- drag guard permutations depend on browser DnD event shape; reorder behavior is tested. */
                if (!enableReorder || !inPack || loadOrderSaving || index < 0)
                  return;
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
                /* v8 ignore next -- drag guard permutations depend on browser DnD event shape; reorder behavior is tested. */
                if (!enableReorder || !inPack || loadOrderSaving) return;
                if (!event.dataTransfer.types.includes('text/plain')) return;
                event.preventDefault();
                const from =
                  draggedIndex ??
                  Number.parseInt(event.dataTransfer.getData('text/plain'), 10);
                if (
                  Number.isFinite(from) &&
                  from !== index &&
                  from >= 0 &&
                  from < loadOrderDraft.length &&
                  index >= 0 &&
                  index < loadOrderDraft.length
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
              onRestoreCached={
                packScoped &&
                row.installed === false &&
                row.cached &&
                onSelectProfileVersion
                  ? handleRestoreCachedRow
                  : undefined
              }
              mod={modInfo}
              audit={audit}
              updatePlans={updatePlans}
              onReviewUpdates={updatePlans.length > 0 ? onReviewUpdates : undefined}
              removableLocalVersion={guidedDelete?.rowKey === rowKey && guidedDelete.versionKey === removableLocalVersion?.key ? removableLocalVersion : undefined}
              onClearDeleteGuidance={() => setGuidedDelete(null)}
              gameRunning={gameRunning}
              gameVersion={gameVersion}
              isUpdating={!!modInfo && updatingKey === rowKey}
              isRepairing={!!modInfo && repairingKey === rowKey}
              isRollingBack={!!modInfo && rollingBackKey === rowKey}
              anyUpdating={anyUpdating}
              anyRecoveryInFlight={anyRecoveryInFlight}
              {...rowActionHandlers}
              selectedVersionKey={selectedVersionKeyByRow.get(rowKey) ?? rowKey}
              versionOptions={versionRows.map((option) => {
                const isSelectedVersion = option.mod_version_id ===
                  (selectedVersionKeyByRow.get(rowKey) ?? rowKey);
                const sourceLabelOption = versionOptionForSourceLabel(
                  option,
                  row,
                  modInfo,
                );
                return {
                  key: option.mod_version_id,
                  version: option.version,
                  label: cleanDisplayVersion(option.version),
                  sourceLabel: versionOptionSourceKeys(sourceLabelOption)
                    .map((key) => t(`mods.versionSource.${key}`))
                    .join(t('mods.versionSource.joiner')),
                  installed: option.installed,
                  installedEnabled: isSelectedVersion,
                  cached: option.cached,
                  pinned: option.pinned,
                  source: option.source ?? null,
                  githubUrl: option.github_url ?? null,
                  nexusUrl: option.nexus_url ?? null,
                  installSource: option.install_source,
                  workshopItemId: option.workshop_item_id ?? null,
                  workshopUrl: option.workshop_url ?? null,
                  usedByProfiles: option.used_by_profiles ?? [],
                };
              })}
              onSelectVersion={(selectedKey) => {
                setGuidedDelete(null);
                return handleSelectRowVersion(row, selectedKey);
              }}
              onRemoveVersion={(option) => {
                const selected = versionRows.find(
                  (candidate) => candidate.mod_version_id === option.key,
                );
                if (selected) void handleRemoveRowVersion(row, selected);
              }}
              onKeepOnlyVersion={(option) => handleKeepOnlyRowVersion(row, option.key)}
              removingVersionKey={removingVersionKey}
              keepingOnlyVersionKey={keepingOnlyVersionKey}
              sourceConflict={duplicateSourceConflictKeys.has(rowKey)}
              activeBundleName={activeBundleName}
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
      {versionRemovalWizard && (
        <div
          className="gf-modal-back"
          onClick={() => setVersionRemovalWizard(null)}
        >
          <div
            className="gf-modal gf-version-removal-wizard"
            role="dialog"
            aria-modal="true"
            aria-labelledby="version-removal-wizard-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="gf-modal-head">
              <div>
                <div
                  id="version-removal-wizard-title"
                  className="gf-modal-title"
                >
                  {t('mods.versionRemovalWizardTitle', {
                    mod:
                      versionRemovalWizard.option.display_name?.trim() ||
                      membershipDisplayName(versionRemovalWizard.row),
                    version: cleanDisplayVersion(
                      versionRemovalWizard.option.version,
                    ),
                  })}
                </div>
                <div className="gf-modal-sub">
                  {t('mods.versionRemovalWizardSub')}
                </div>
              </div>
            </div>
            <div className="gf-modal-body">
              <div className="gf-version-removal-impact">
                <span>
                  {versionRemovalWizard.preview.active
                    ? t('mods.versionRemovalImpactActive')
                    : versionRemovalWizard.preview.installed
                      ? t('mods.versionRemovalImpactStored')
                      : t('mods.versionRemovalImpactSaved')}
                </span>
                <span>
                  {t('mods.versionRemovalImpactPacks', {
                    count:
                      versionRemovalWizard.preview.affected_profiles.length,
                  })}
                </span>
              </div>
              {versionRemovalWizard.preview.pinned && (
                <div className="gf-version-removal-warning">
                  {t('mods.versionRemovalPinnedWarning')}
                </div>
              )}
              {versionRemovalWizard.preview.affected_profiles.length > 0 && (
                <div className="gf-version-removal-section">
                  <div className="gf-version-removal-section-title">
                    {t('mods.versionRemovalAffectedTitle')}
                  </div>
                  <ul className="gf-version-removal-pack-list">
                    {versionRemovalWizard.preview.affected_profiles.map(
                      (profile) => (
                        <li key={profile.profile_id}>{profile.profile_name}</li>
                      ),
                    )}
                  </ul>
                </div>
              )}
              {versionRemovalWizard.preview.replacement_candidates.length >
              0 ? (
                <div className="gf-version-removal-mode-grid">
                  <button
                    type="button"
                    className={`gf-version-removal-mode${versionRemovalWizard.mode === 'remap' ? ' is-selected' : ''}`}
                    onClick={() =>
                      setVersionRemovalWizard((current) =>
                        current ? { ...current, mode: 'remap' } : current,
                      )
                    }
                  >
                    <strong>{t('mods.versionRemovalModeRemapTitle')}</strong>
                    <span>{t('mods.versionRemovalModeRemapBody')}</span>
                  </button>
                  <button
                    type="button"
                    className={`gf-version-removal-mode${versionRemovalWizard.mode === 'remove_from_packs' ? ' is-selected' : ''}`}
                    onClick={() =>
                      setVersionRemovalWizard((current) =>
                        current
                          ? { ...current, mode: 'remove_from_packs' }
                          : current,
                      )
                    }
                  >
                    <strong>{t('mods.versionRemovalModeRemoveTitle')}</strong>
                    <span>{t('mods.versionRemovalModeRemoveBody')}</span>
                  </button>
                </div>
              ) : (
                <div className="gf-version-removal-warning">
                  {t('mods.versionRemovalNoReplacement')}
                </div>
              )}
              {versionRemovalWizard.mode === 'remap' &&
                versionRemovalWizard.preview.replacement_candidates.length >
                  0 && (
                  <div className="gf-version-removal-section">
                    {versionRemovalWizard.preview.active && (
                      <label className="gf-version-removal-field">
                        <span>{t('mods.versionRemovalActiveReplacement')}</span>
                        <Select
                          value={versionRemovalWizard.activeReplacementId}
                          onChange={(value) =>
                            setVersionRemovalWizard((current) =>
                              current
                                ? { ...current, activeReplacementId: value }
                                : current,
                            )
                          }
                          aria-label={t('mods.versionRemovalActiveReplacement')}
                          options={versionRemovalReplacementOptions}
                        />
                      </label>
                    )}
                    {versionRemovalWizard.preview.affected_profiles.map(
                      (profile) => (
                        <label
                          key={profile.profile_id}
                          className="gf-version-removal-field"
                        >
                          <span>
                            {t('mods.versionRemovalPackReplacement', {
                              profile: profile.profile_name,
                            })}
                          </span>
                          <Select
                            value={
                              versionRemovalWizard.profileReplacementIds[
                                profile.profile_id
                              ] ?? ''
                            }
                            onChange={(value) =>
                              setVersionRemovalWizard((current) =>
                                current
                                  ? {
                                      ...current,
                                      profileReplacementIds: {
                                        ...current.profileReplacementIds,
                                        [profile.profile_id]: value,
                                      },
                                    }
                                  : current,
                              )
                            }
                            aria-label={t(
                              'mods.versionRemovalPackReplacement',
                              {
                                profile: profile.profile_name,
                              },
                            )}
                            options={versionRemovalReplacementOptions}
                          />
                        </label>
                      ),
                    )}
                  </div>
                )}
              {versionRemovalWizard.mode === 'remove_from_packs' && (
                <div className="gf-version-removal-warning">
                  {versionRemovalWizard.preview.affected_profiles.length > 0
                    ? t('mods.versionRemovalRemoveFromPacksWarning', {
                        count:
                          versionRemovalWizard.preview.affected_profiles.length,
                      })
                    : t('mods.versionRemovalDeleteOnlyWarning')}
                </div>
              )}
            </div>
            <div className="gf-modal-foot">
              <button
                type="button"
                className="gf-btn-3"
                onClick={() => setVersionRemovalWizard(null)}
                disabled={versionRemovalWizard.committing}
              >
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="gf-btn-3 gf-btn-danger"
                onClick={commitVersionRemovalWizard}
                disabled={!versionRemovalCanCommit}
              >
                {versionRemovalWizard.committing
                  ? t('mods.versionRemoving')
                  : versionRemovalWizard.mode === 'remap'
                    ? t('mods.versionRemovalConfirmRemap')
                    : t('mods.versionRemovalConfirmRemove')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
