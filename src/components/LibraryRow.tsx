/**
 * LibraryRow — single per-mod row inside <LibraryTable>.
 *
 * History:
 *  - 1.7.0 T16: extracted from LibraryTable.tsx so the table file stays
 *    focused on data plumbing (fetch, filter, sort, paginate, mutate)
 *    and the row stays focused on rendering one mod against one modpack
 *    column.
 *  - 1.7.0 T17/T18 unification: absorbed the full ModRow action surface
 *    so the Library view + ModpackDetail can use this single row
 *    component. The kebab menu mirrors the old ModRow drawer (Activate,
 *    Freeze, Skip update, Edit sources, View on GitHub/Nexus, Repair,
 *    Rollback, Delete) and an inline audit pill surfaces update /
 *    blocked / frozen / snoozed states next to the storage chip.
 *
 * Still presentation-only: the parent owns drag indices, mutation
 * in-flight flags, and all Tauri calls. The new mutation callbacks
 * (onUpdate, onTogglePin, onRepair, …) are optional with no-op defaults
 * so the modpack-focused call sites that only care about
 * membership / storage / drag don't have to wire them.
 */
import { useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  CircleCheck,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  GitBranch,
  GripVertical,
  Layers,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Snowflake,
  Sun,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Wrench,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from './Badge';
import { Card } from './Card';
import { KebabDivider, KebabItem, KebabMenu, KebabSection } from './KebabMenu';
import { Toggle } from './Toggle';
import { Select } from './Select';
import { useRowMenu } from '../contexts/RowMenuContext';
import { isUpToDate } from '../lib/auditState';
import {
  isWorkshopOwned as isWorkshopOwnedEntry,
  isWorkshopSource,
  workshopSourceUrl,
} from '../lib/modIdentity';
import {
  resolveRowMenuOrder,
  ROW_MENU_OPEN_EVENT,
  type RowMenuItemId,
} from '../lib/rowMenuConfig';
import { profileDisplayName } from '../lib/profileDisplay';
import type {
  ModAuditEntry,
  ModInfo,
  ModInstallSource,
  ProfileMembershipMod,
  ProfileMembershipState,
  UpdatePlanItem,
} from '../types';

export interface StoredVersionGuidance {
  key: string;
  version: string;
  sourceLabel: string;
}

export function membershipRowKey(row: ProfileMembershipMod): string {
  return row.mod_version_id ?? row.folder_name ?? row.mod_id ?? row.name;
}

export function membershipDisplayName(row: ProfileMembershipMod): string {
  return row.display_name?.trim() || row.name;
}

export function libraryStorageKey(row: ProfileMembershipMod): string {
  return `storage::${membershipRowKey(row)}`;
}

function hasWorkshopSource(row: ProfileMembershipMod, mod?: ModInfo | null): boolean {
  // Reuse the canonical helper so the "is this a Steam Workshop mod?"
  // heuristic (install_source / workshop_item_id / workshop_url / source
  // URL shape) stays in one place across the row, the useModLibrary hook,
  // and the backend guards. Either the ModInfo or the membership row can
  // carry the workshop-ness bits, so OR the two.
  return isWorkshopSource(mod) || isWorkshopSource(row);
}

function isWorkshopOwned(row: ProfileMembershipMod, mod?: ModInfo | null): boolean {
  // Stricter than hasWorkshopSource: only true when Steam actually owns
  // the install (install_source === 'steam_workshop'). Drives delete
  // guidance — we should not warn "Workshop-managed, use Steam" for a
  // mod that merely carries a workshop URL in its notes.
  return isWorkshopOwnedEntry(mod) || isWorkshopOwnedEntry(row);
}

function workshopUrlFor(row: ProfileMembershipMod, mod?: ModInfo | null): string | null {
  return workshopSourceUrl(mod) ?? workshopSourceUrl(row);
}

/**
 * Numeric semver compare for the small subset we actually see in mod
 * manifests + STS2's release_info.json: "MAJOR.MINOR.PATCH" with an
 * optional leading "v". Returns true when `current >= required`.
 *
 * Fails OPEN on parse hiccups — UI would rather skip the warning than
 * cry "won't load!" at the user because of a quirky version string.
 */
function gameVersionSatisfies(
  current: string | null | undefined,
  required: string | null | undefined,
): boolean {
  if (!current || !required) return true;
  const parse = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split('.')
      .slice(0, 3)
      .map((n) => Number.parseInt(n, 10));
  const [cMaj, cMin, cPatch] = parse(current);
  const [rMaj, rMin, rPatch] = parse(required);
  if ([cMaj, cMin, cPatch, rMaj, rMin, rPatch].some((n) => Number.isNaN(n)))
    return true;
  if (cMaj !== rMaj) return cMaj > rMaj;
  if (cMin !== rMin) return cMin > rMin;
  return cPatch >= rPatch;
}

export interface LibraryRowVersionOption {
  key: string;
  version: string;
  label: string;
  sourceLabel?: string;
  installed?: boolean;
  installedEnabled?: boolean;
  cached?: boolean;
  pinned?: boolean;
  source?: string | null;
  githubUrl?: string | null;
  nexusUrl?: string | null;
  installSource?: ModInstallSource;
  workshopItemId?: string | null;
  workshopUrl?: string | null;
  usedByProfiles?: string[];
}

export interface LibraryRowProps {
  /** The membership grid row for this mod. */
  row: ProfileMembershipMod;
  /** Name of the focused modpack — used for ARIA labels + checkbox copy.
   *  When null, the row hides the per-modpack checkbox and drag handle
   *  (Library view uses this mode). */
  modpackName: string | null;
  /** Display name for the focused modpack. Backend ids stay in modpackName. */
  modpackLabel?: string | null;
  /** Focused-profile state row pulled out of `row.profiles` by the
   *  parent (kept hoisted so the table can compute counts in one pass).
   *  Undefined when modpackName is null. */
  state: ProfileMembershipState | undefined;
  /** Whether the row belongs to the focused modpack. Derived from
   *  `state?.included`, passed for symmetry with `inPackIndex`. */
  inPack: boolean;
  /** Index inside the load-order draft (-1 when not in the pack).
   *  Drives the drag handles + rank chip. */
  inPackIndex: number;
  /** Whether this row lives in a load-order context (ModpackDetail).
   *  Gates the drag handle, the `draggable` attribute, and the rank
   *  chip. The Library view passes false (no order to set — there's
   *  nothing to reorder across all-installed-mods), so the handle/chip
   *  never render there even though rows can be "in pack". */
  enableReorder?: boolean;
  /** Dedicated modpack view (the page that shows ONLY this pack's mods).
   *  When true: the redundant In-Modpack indicator is hidden (every row
   *  is in the pack), the visible row action is "Remove from pack" instead
   *  of the disk-delete trash, and the kebab gains a "Delete from disk"
   *  item. The All Mods view leaves this false. */
  packScoped?: boolean;
  /** Whether the focused pack is the ACTIVE one. Only meaningful with
   *  packScoped: the active/stored toggle (and the green "active in game"
   *  border) appear only for the active pack's rows, since in-game state is
   *  irrelevant for a pack that isn't loaded. Ignored outside packScoped —
   *  the All Mods view always shows the toggle. */
  packActive?: boolean;
  /** Drag highlight target. */
  isDragOver: boolean;
  /** The row currently being dragged. */
  isDragging?: boolean;
  /** True while a setProfileLoadOrder commit is in flight. Disables
   *  draggable + early-returns drag handlers. */
  loadOrderSaving: boolean;
  /** Per-row membership-mutation in-flight flag. */
  membershipSaving: string | null;
  /** Per-row storage-mutation in-flight flag (or BULK_STORAGE_KEY). */
  storageSaving: string | null;
  // Drag callbacks — the parent owns drag indices.
  onDragStart: (event: React.DragEvent, inPackIndex: number) => void;
  onDragOver: (event: React.DragEvent, inPackIndex: number) => void;
  onDragLeave: (inPackIndex: number) => void;
  onDrop: (event: React.DragEvent, inPackIndex: number) => void;
  onDragEnd: () => void;
  // Mutation callbacks — the parent owns Tauri calls + toasts + state.
  onToggleMembership: (row: ProfileMembershipMod) => void | Promise<void>;
  onToggleStorage: (row: ProfileMembershipMod) => void | Promise<void>;
  /** Restore a cached-only profile version to disk and enable it. Only
   *  surfaced for archived rows in the active modpack. */
  onRestoreCached?: (row: ProfileMembershipMod) => void | Promise<void>;

  // ─── Optional ModRow-style action surface ────────────────────────
  // All optional: LibraryTable in modpack-detail mode doesn't strictly
  // need these (the membership checkbox + kebab cover the core flow).
  // The Library view wires them all in so the kebab matches the old
  // ModRow drawer.

  /** Full ModInfo for this row (provides github_url, tags, pinned,
   *  size_bytes, etc.). When omitted, the kebab still renders core
   *  actions (storage toggle, edit sources, recovery, delete) but the
   *  Freeze/Repair/Rollback are disabled and source-pill drawer items
   *  are skipped. */
  mod?: ModInfo;
  /** Audit entry from getAuditByKey lookup. Undefined when audit hasn't
   *  run for this row. */
  audit?: ModAuditEntry | undefined;
  updatePlans?: UpdatePlanItem[];
  removableLocalVersion?: StoredVersionGuidance;
  onClearDeleteGuidance?: () => void;
  /** Current game running state — disables destructive actions. */
  gameRunning?: boolean;
  /** Current STS2 game version, drives the min_game_version warning. */
  gameVersion?: string | null;
  versionOptions?: LibraryRowVersionOption[];
  selectedVersionKey?: string;
  onSelectVersion?: (key: string) => void;
  onRemoveVersion?: (option: LibraryRowVersionOption) => void | Promise<void>;
  onKeepOnlyVersion?: (option: LibraryRowVersionOption) => boolean | Promise<boolean>;
  removingVersionKey?: string | null;
  keepingOnlyVersionKey?: string | null;
  /** Whether THIS row's update is in flight (per-row spinner). */
  isUpdating?: boolean;
  /** Whether THIS row's repair is in flight. */
  isRepairing?: boolean;
  /** Whether THIS row's rollback is in flight. */
  isRollingBack?: boolean;
  /** True when ANY row is currently updating. */
  anyUpdating?: boolean;
  /** True when ANY row is repairing or rolling back. */
  anyRecoveryInFlight?: boolean;

  onUpdate?: () => void;
  /** Open the review sheet for a group of provider update plans. Wired
   *  through from ModLibrary/ModpackDetail so the provider-evidence pills
   *  on a row with pending plans stay clickable (never silently apply). */
  onReviewUpdates?: (plans: UpdatePlanItem[]) => void;
  onTogglePin?: () => void;
  onSnooze?: () => void;
  onUnsnooze?: () => void;
  onRepair?: () => void;
  onRollback?: () => void;
  onDelete?: () => void;
  onCopyVersion?: () => void;
  /** Open THIS mod's folder (vs. the global mods dir). Bug 6. */
  onOpenThisModFolder?: () => void;
  onEditSources?: () => void;
  onFindGithubFromNexus?: () => void;
  onOpenExternalUrl?: (url: string) => void;
  onAutoDetectSource?: () => void;
  sourceConflict?: boolean;
  /** Name of an enabled bundle that already provides this inactive row's
   *  runtime ID. The disk copy stays inactive to avoid loading two mods with
   *  the same ID, but the row should make clear that its functionality is
   *  already active through the bundle. */
  activeBundleName?: string;
  /** Optional slot rendered inside the row (currently used by the
   *  Library view to attach the inline SourceEditor below the row). */
  sourceEditorSlot?: ReactNode;
}

const noop = () => {};

export function LibraryRow({
  row,
  modpackName,
  modpackLabel,
  state,
  inPack,
  inPackIndex,
  enableReorder = false,
  packScoped = false,
  packActive = false,
  isDragOver,
  isDragging = false,
  loadOrderSaving,
  membershipSaving,
  storageSaving,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd,
  onToggleMembership,
  onToggleStorage,
  onRestoreCached,
  mod,
  audit,
  updatePlans = [],
  removableLocalVersion,
  onClearDeleteGuidance = noop,
  gameRunning = false,
  gameVersion,
  versionOptions = [],
  selectedVersionKey,
  onSelectVersion = noop,
  onRemoveVersion = noop,
  onKeepOnlyVersion = () => false,
  removingVersionKey = null,
  keepingOnlyVersionKey = null,
  isUpdating = false,
  isRepairing = false,
  isRollingBack = false,
  anyUpdating = false,
  anyRecoveryInFlight = false,
  onUpdate = noop,
  onReviewUpdates,
  onTogglePin = noop,
  onSnooze = noop,
  onUnsnooze = noop,
  onRepair = noop,
  onRollback = noop,
  onDelete = noop,
  onCopyVersion = noop,
  onOpenThisModFolder = noop,
  onEditSources = noop,
  onFindGithubFromNexus = noop,
  onOpenExternalUrl = noop,
  onAutoDetectSource = noop,
  sourceConflict = false,
  activeBundleName,
  sourceEditorSlot,
}: LibraryRowProps) {
  const { t } = useTranslation();
  const [versionManagerOpen, setVersionManagerOpen] = useState(false);
  const modpackDisplayName = profileDisplayName(
    modpackLabel ?? modpackName,
    t('quickAdd.unknown'),
  );
  const membershipKey = modpackName
    ? `${membershipRowKey(row)}::${modpackName}`
    : null;
  const saving = membershipKey != null && membershipSaving === membershipKey;
  const displayName = mod?.display_name?.trim() || membershipDisplayName(row);
  const workshopRow = hasWorkshopSource(row, mod);
  const workshopOwned = isWorkshopOwned(row, mod);
  const workshopUrl = workshopUrlFor(row, mod);
  const rowCanEditSources = !!mod;
  // Per-row storage (active/stored) mutation in flight. Drives the small
  // spinner beside the active/stored toggle. `storageSaving` carries the
  // libraryStorageKey of the row being flipped (or BULK_STORAGE_KEY).
  const storageBusy = storageSaving === libraryStorageKey(row);
  // Drag-reorder is only meaningful in a load-order context
  // (ModpackDetail). The Library view passes enableReorder=false, so
  // the drag handle, the `draggable` attribute, and the rank chip stay
  // hidden there even though rows can be "in pack".
  const reorderable = enableReorder && inPack && inPackIndex >= 0;
  const rowInstalled = row.installed ?? true;
  const canRestoreCached =
    !rowInstalled &&
    !!row.cached &&
    packScoped &&
    packActive &&
    !!onRestoreCached;
  const cleanVersion = (value: string | null | undefined) =>
    (value ?? '').trim().replace(/^v/i, '');
  // "In N modpacks" — how many of the user's modpacks include this mod. Only
  // meaningful in the All Mods view (the focused membership grid carries every
  // profile's state); the synthesized no-focus grid leaves profiles empty, so
  // the indicator hides there and in the pack-scoped modpack view.
  const includedProfiles = row.profiles.filter((p) => p.included);
  const profileVersionUses = new Map<
    string,
    { profile: string; version: string }
  >();
  for (const option of versionOptions) {
    for (const profile of option.usedByProfiles ?? []) {
      if (!profileVersionUses.has(profile)) {
        profileVersionUses.set(profile, { profile, version: option.version });
      }
    }
  }
  if (profileVersionUses.size === 0) {
    for (const profile of includedProfiles) {
      profileVersionUses.set(profile.profile_name, {
        profile: profile.profile_name,
        version: row.version,
      });
    }
  }
  const profileVersionSummary = [...profileVersionUses.values()];
  const modpackUsageTitle =
    profileVersionSummary.length > 0
      ? profileVersionSummary
          .map((use) => `${use.profile}: v${cleanVersion(use.version) || '?'}`)
          .join(', ')
      : t('libraryTable.inNoModpacks');
  // Audit pill flags. We surface exactly one of: update / blocked /
  // frozen / snoozed at a time, mirroring ModRow's drawer logic, but in
  // an inline chip-row so the user doesn't have to expand anything.
  const compatibleTag =
    audit?.latest_compatible_tag ??
    audit?.latest_release_with_assets_tag ??
    null;
  // Version to display in the update pill. GitHub updates use the release
  // tag (compatibleTag); Nexus-only updates fall back to nexus_version so
  // the pill shows a real version string rather than undefined.
  const updateDisplayVersion = compatibleTag ?? audit?.nexus_version ?? null;
  const hasProviderPlanPayload = audit
    ? audit.update_plans !== undefined || audit.update_plan !== undefined
    : false;
  // Show the update pill for a GitHub update (when compatibleTag is known)
  // OR for a Nexus-only update (nexus_update_available is true). Bundles
  // and Nexus-only mods have no github_url, so gating on github_url alone
  // was silently hiding their "update available" state.
  const showUpdatePill =
    !!audit &&
    !hasProviderPlanPayload &&
    audit.needs_update &&
    !workshopOwned &&
    !audit.pinned &&
    !audit.snoozed &&
    !audit.game_version_too_old &&
    !audit.latest_release_blocked_by_game_version &&
    (!!compatibleTag || !!audit.nexus_update_available);
  const showBlockedPill =
    !!audit?.latest_release_blocked_by_game_version && !audit.pinned;
  const showFrozenPill = !!mod?.pinned;
  const showSnoozedPill = !!audit?.snoozed;
  const workshopUpdatePending =
    workshopRow &&
    !updatePlans.some((plan) => plan.provider === 'steam') &&
    !!(mod?.workshop_update_pending || row.workshop_update_pending);
  const auditError = audit?.error ?? null;
  const minGameViolated =
    !!mod?.min_game_version &&
    !gameVersionSatisfies(gameVersion, mod.min_game_version);
  const manifestVersion = cleanVersion(
    audit?.manifest_version ?? mod?.version ?? row.version,
  );
  const installedSourceVersion = cleanVersion(audit?.installed_source_version);
  const hasConfirmedGithub = !!mod?.github_url && !mod.github_auto_detected;
  const sourceVersionLabel = workshopOwned
    ? t('mods.steamWorkshop')
    : hasConfirmedGithub ||
        (!!audit?.github_repo && !audit.github_auto_detected)
      ? t('mods.gitHub')
      : audit?.nexus_url || mod?.nexus_url
        ? t('mods.nexus')
        : 'installed';
  // Steam does not expose a human-readable release version separately from
  // the mod author's manifest. Its ACF `manifest` value is an opaque content
  // revision, so label the semantic manifest value as the installed Workshop
  // version instead of showing either "manifest" or the Workshop item ID.
  const displayedSourceVersion = workshopOwned
    ? manifestVersion
    : installedSourceVersion;
  const showInstalledSourceVersion = workshopOwned
    ? !!displayedSourceVersion
    : !!installedSourceVersion && installedSourceVersion !== manifestVersion;

  const versionStateLabel = (option: LibraryRowVersionOption) => {
    if (option.installedEnabled) return t('mods.versionActiveStatus');
    if (option.installed) return t('mods.versionStoredOnDiskStatus');
    if (option.cached) return t('mods.versionSavedStatus');
    return t('mods.versionStoredStatus');
  };
  const versionSelectorStateLabel = (option: LibraryRowVersionOption) =>
    option.installedEnabled
      ? t('mods.versionActiveTitle')
      : versionStateLabel(option);
  const providerLabel = (provider: string) =>
    provider
      .split('+')
      .map((part) =>
        part === 'github'
          ? t('mods.gitHub')
          : part === 'nexus'
            ? t('mods.nexus')
            : part === 'steam'
              ? t('mods.steamWorkshop')
              : part,
      )
      .join(t('mods.versionSource.joiner'));
  const versionWorkshopUrl = (option: LibraryRowVersionOption) =>
    option.workshopUrl ??
    (option.workshopItemId
      ? `https://steamcommunity.com/sharedfiles/filedetails/?id=${option.workshopItemId}`
      : null);
  const versionRemoveBlockReason = (option: LibraryRowVersionOption) => {
    const usedByProfiles = option.usedByProfiles ?? [];
    if (option.installSource === 'steam_workshop' && option.installed) {
      return t('mods.versionRemoveWorkshopReason');
    }
    if (option.installedEnabled) return t('mods.versionRemoveActiveReason');
    if (option.pinned) return t('mods.versionRemovePinnedReason');
    if (usedByProfiles.length > 0) {
      return t('mods.versionRemoveProfileReason', {
        profiles: usedByProfiles.join(', '),
      });
    }
    return null;
  };

  return (
    <>
      <Card
        className={`gf-profile-library-row${(!packScoped || packActive) && row.installed_enabled ? ' is-active' : ''}${isDragOver ? ' drag-over' : ''}${isDragging ? ' dragging' : ''}${mod?.pinned ? ' gf-mod-pinned' : ''}${rowCanEditSources ? ' is-clickable' : ''}`}
        draggable={reorderable && !loadOrderSaving}
        onDragStart={(event) => onDragStart(event, inPackIndex)}
        onDragOver={(event) => onDragOver(event, inPackIndex)}
        onDragLeave={() => onDragLeave(inPackIndex)}
        onDrop={(event) => onDrop(event, inPackIndex)}
        onDragEnd={onDragEnd}
        // 4.4 — clicking the row opens its inline Edit-sources editor.
        // Interactive children (toggle, kebab, source links) stop
        // propagation so they don't also trigger this.
        onClick={rowCanEditSources ? () => onEditSources() : undefined}
        onKeyDown={
          rowCanEditSources
            ? (event) => {
                // Only the row itself should activate on Enter/Space. A keydown
                // from a focused child control (toggle, kebab, source link)
                // bubbles up here too; without this guard it would fire the
                // row's Edit-sources action alongside the child's own.
                if (
                  event.target === event.currentTarget &&
                  (event.key === 'Enter' || event.key === ' ')
                ) {
                  event.preventDefault();
                  onEditSources();
                }
              }
            : undefined
        }
        role={rowCanEditSources ? 'button' : undefined}
        tabIndex={rowCanEditSources ? 0 : undefined}
        // Explicit accessible name so the row-button doesn't absorb its
        // children's text (which would make every inner pill/badge match a
        // getByRole('button', { name }) lookup for the row too).
        aria-label={
          rowCanEditSources
            ? t('mods.rowEditSourcesAria', { mod: displayName })
            : undefined
        }
        title={
          rowCanEditSources
            ? t('mods.rowClickEditSources')
            : undefined
        }
        data-testid="library-row"
      >
        <div className="gf-profile-library-main">
          {reorderable && (
            <div
              className="gf-load-order-drag"
              title={t('profiles.loadOrder.dragHandle')}
              aria-label={t('profiles.loadOrder.dragHandle')}
            >
              <GripVertical size={14} />
            </div>
          )}
          {/* 4.1 — active/stored switch, leftmost. The card's green left
            border mirrors this (on = active in game, off = stored).
            stopPropagation so flipping it doesn't open Edit-sources. */}
          {/* Active/stored toggle — only where in-game state is meaningful:
            the All Mods view, or the ACTIVE pack's rows. A non-active pack's
            members aren't loaded, so showing a toggle there is misleading. */}
          {(rowInstalled || canRestoreCached) &&
            (!packScoped || packActive) && (
              <div
                className="gf-row-status"
                role="presentation"
                onClick={(event) => event.stopPropagation()}
              >
                <Toggle
                  checked={row.installed_enabled}
                  onChange={() =>
                    canRestoreCached
                      ? onRestoreCached?.(row)
                      : onToggleStorage(row)
                  }
                  // Only gate on the game running. We deliberately do NOT disable
                  // while a save is in flight: disabling the just-clicked control
                  // rips keyboard focus off it (it falls to <body>), and some
                  // WebViews react to that focus loss by scrolling the list — so
                  // the user gets yanked to the top on every toggle. Re-entrancy /
                  // double-clicks are already guarded inside handleToggleStorage
                  // (`if (storageSaving || membershipSaving) return`), so the
                  // disabled attribute was only ever redundant insurance.
                  disabled={gameRunning || workshopOwned}
                  ariaLabel={t('modpack.storage.toggleAria', {
                    mod: displayName,
                  })}
                  title={
                    canRestoreCached
                      ? t('mods.restoreArchivedAndEnable')
                      : workshopOwned
                        ? t('mods.workshopManagedTitle')
                        : activeBundleName
                          ? t('mods.activeViaBundleTitle', {
                              bundle: activeBundleName,
                            })
                          : row.installed_enabled
                            ? t('modpack.storage.active')
                            : t('modpack.storage.storedHint')
                  }
                />
                <span className="gf-row-status-label">
                  {canRestoreCached
                    ? t('mods.versionSavedStatus')
                    : row.installed_enabled
                      ? t('modpack.storage.active')
                      : t('modpack.storage.stored')}
                </span>
                {storageBusy && (
                  <RefreshCw size={11} className="animate-spin" aria-hidden />
                )}
              </div>
            )}
          <div className="gf-profile-library-identity min-w-0">
            <div className="gf-profile-library-titlerow">
              <h3 className="gf-profile-library-title">{displayName}</h3>
              {displayName !== row.name && (
                <span className="gf-profile-library-rawname">{row.name}</span>
              )}
              {/* Tags, source badges and audit pills all cluster to the
                right of the name — there's more room here than mid-row, so
                they read as one group instead of scattered bits. */}
              <span className="gf-row-tagcluster">
                {activeBundleName && (
                  <span
                    className="gf-pill gf-pill-ok"
                    title={t('mods.activeViaBundleTitle', {
                      bundle: activeBundleName,
                    })}
                  >
                    <Check size={9} />
                    {t('mods.activeViaBundle', { bundle: activeBundleName })}
                  </span>
                )}
                {mod?.tags?.slice(0, 5).map((tag) => (
                  <span key={tag} className="gf-row-tag">
                    {tag}
                  </span>
                ))}
                {workshopRow && workshopUrl && (
                  <a
                    href={workshopUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="gf-source-link"
                    title={t('mods.viewOnSteamWorkshop', { url: workshopUrl })}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Badge variant="default">
                      <ExternalLink size={10} className="mr-1" />
                      {t('mods.steamWorkshop')}
                    </Badge>
                  </a>
                )}
                {workshopRow && !workshopUrl && (
                  <Badge variant="default">{t('mods.steamWorkshop')}</Badge>
                )}
                {mod?.github_url && (
                  <a
                    href={mod.github_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="gf-source-link"
                    title={t('mods.viewOnGitHub', { url: mod.github_url })}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Badge variant="github">
                      <GitBranch size={10} className="mr-1" />
                      {t('mods.gitHub')}
                    </Badge>
                  </a>
                )}
                {mod?.nexus_url && (
                  <a
                    href={mod.nexus_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="gf-source-link"
                    title={t('mods.viewOnNexus', { url: mod.nexus_url })}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Badge variant="nexus">{t('mods.nexus')}</Badge>
                  </a>
                )}
                {mod?.custom_url && (
                  <a
                    href={mod.custom_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="gf-source-link"
                    title={t('mods.openLink', { url: mod.custom_url })}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Badge variant="default">
                      <ExternalLink size={10} className="mr-1" />
                      {t('mods.link')}
                    </Badge>
                  </a>
                )}
                {mod &&
                  !workshopRow &&
                  !mod.github_url &&
                  !mod.nexus_url &&
                  !mod.custom_url && (
                    <Badge variant={mod.source ? 'local' : 'default'}>
                      {mod.source ? t('mods.local') : t('mods.unlinked')}
                    </Badge>
                  )}
                {/* Bundle member-count badge — shown when this mod is a
                  bundle container (bundle_members is non-empty). */}
                {(mod?.bundle_members?.length ?? 0) > 0 && (
                  <span className="gf-pill gf-pill-github">
                    {t('bundle.memberCount', {
                      count: mod!.bundle_members!.length,
                    })}
                  </span>
                )}
                {/* Audit pills — one at a time. Update fires onUpdate; the
                  rest are informational. */}
                {workshopUpdatePending && (
                  <span
                    className="gf-pill gf-pill-update"
                    title={t('mods.workshopManagedDesc')}
                  >
                    <AlertTriangle size={9} /> {t('mods.steamWorkshop')}
                  </span>
                )}
                {audit &&
                  isUpToDate(audit) &&
                  !showUpdatePill &&
                  !showBlockedPill &&
                  !showFrozenPill &&
                  !showSnoozedPill && (
                    <span
                      className="gf-pill gf-pill-ok"
                      title={t('mods.latestTitle')}
                    >
                      <Check size={9} /> {t('mods.latest')}
                    </span>
                  )}
                {showUpdatePill && updatePlans.length === 0 && (
                  <button
                    type="button"
                    className="gf-pill gf-pill-update"
                    onClick={(e) => {
                      e.stopPropagation();
                      onUpdate();
                    }}
                    disabled={gameRunning || isUpdating || anyUpdating}
                    title={
                      gameRunning
                        ? t('mods.closeSts2FirstDot')
                        : t('mods.updateClickTitle', {
                            current: mod!.version,
                            target: updateDisplayVersion?.replace(/^v/, ''),
                          })
                    }
                  >
                    {isUpdating ? (
                      <>
                        <RefreshCw size={9} className="animate-spin" />
                        {t('mods.updating')}
                      </>
                    ) : (
                      <>
                        <Download size={9} />
                        {t('mods.updateAvailable', {
                          version: updateDisplayVersion?.replace(/^v/, ''),
                        })}
                      </>
                    )}
                  </button>
                )}
                {updatePlans.map((plan) => {
                  const pillKey = `${plan.target.mod_version_id ?? plan.target.folder_name ?? plan.target.mod_id ?? plan.target.name}:${plan.provider}`;
                  const pillClassName = `gf-pill gf-pill-update${plan.provider === 'steam' ? ' gf-pill-update-steam' : ''}`;
                  const pillTitle = plan.provider === 'steam'
                    ? t('mods.steamUpdateTitle')
                    : t(`mods.updatePlan.capability.${plan.capability}`);
                  const pillContent = (
                    <>
                      <AlertTriangle size={9} />
                      {plan.provider === 'steam'
                        ? t('mods.steamUpdateAvailable')
                        : t('mods.providerUpdateEvidence', {
                            provider: providerLabel(plan.provider),
                            current: cleanVersion(plan.current_version),
                            target: cleanVersion(plan.target_version) || t('unknown'),
                          })}
                    </>
                  );
                  // When a review-updates callback is wired, expose the pill as
                  // an interactive button so the row has an affordance to open
                  // the review sheet. Without a callback we fall back to the
                  // original inert <span> (backward compatible for callers that
                  // only want the evidence, not the click).
                  if (onReviewUpdates) {
                    return (
                      <button
                        type="button"
                        key={pillKey}
                        className={pillClassName}
                        title={pillTitle}
                        onClick={(e) => {
                          e.stopPropagation();
                          onReviewUpdates(updatePlans);
                        }}
                      >
                        {pillContent}
                      </button>
                    );
                  }
                  return (
                    <span key={pillKey} className={pillClassName} title={pillTitle}>
                      {pillContent}
                    </span>
                  );
                })}
                {showBlockedPill && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300"
                    title={t('mods.gameVersionBlockedTitle', {
                      target:
                        audit!.latest_release_with_assets_tag?.replace(
                          /^v/,
                          '',
                        ) ?? '?',
                    })}
                  >
                    <AlertTriangle size={9} />{' '}
                    {t('mods.updateBlockedByGameVersion')}
                  </span>
                )}
                {showFrozenPill && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300"
                    title={t('mods.pinnedTitle')}
                  >
                    <Snowflake size={9} /> {t('mods.pinned')}
                  </span>
                )}
                {showSnoozedPill && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-300"
                    title={t('mods.snoozedTitle', {
                      version:
                        audit!.latest_release_with_assets_tag?.replace(
                          /^v/,
                          '',
                        ) ?? '?',
                    })}
                  >
                    {t('mods.snoozed')}
                  </span>
                )}
                {auditError && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-500/20 text-red-300"
                    title={auditError}
                  >
                    <AlertTriangle size={9} /> {t('mods.auditError')}
                  </span>
                )}
                {minGameViolated && (
                  <span
                    className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded"
                    style={{
                      background:
                        'color-mix(in oklch, var(--amber-glow) 18%, transparent)',
                      color: 'var(--ember-bright)',
                    }}
                    title={t('mods.minGameVersionTitle', {
                      minVer: mod!.min_game_version,
                      yourVer: gameVersion ?? 'unknown',
                    })}
                  >
                    <AlertTriangle size={9} />{' '}
                    {t('mods.needsGameVersion', {
                      version: mod!.min_game_version,
                    })}
                  </span>
                )}
              </span>
            </div>
            <div className="gf-profile-library-meta">
              {/* 4.5 — version is v-prefixed and the on-disk folder carries
                a folder glyph + tooltip, so version / folder / description
                read as distinct things instead of three grey lookalikes. */}
              <span className="gf-meta-version" title={t('mods.versionLabel')}>
                {showInstalledSourceVersion
                  ? `${sourceVersionLabel} v${displayedSourceVersion}`
                  : t('mods.manifestVersion', { version: manifestVersion })}
              </span>
              {showInstalledSourceVersion && !workshopOwned && (
                <span
                  className="gf-meta-version"
                  title={t('mods.versionLabel')}
                >
                  {t('mods.manifestVersion', { version: manifestVersion })}
                </span>
              )}
              {!rowInstalled && row.cached && (
                <span
                  className="gf-meta-version"
                  title={t('mods.versionSavedStatus')}
                >
                  {t('mods.versionSavedStatus')}
                </span>
              )}
              {!rowInstalled && row.missing && (
                <span
                  className="gf-meta-version"
                  title={t('mods.versionMissingStatus')}
                >
                  {t('mods.versionMissingStatus')}
                </span>
              )}
              {versionOptions.length > 1 && (
                <div
                  className="gf-version-tools"
                  onClick={(event) => event.stopPropagation()}
                >
                  <label
                    className="gf-version-select"
                    title={t('mods.versionSelectorTitle')}
                  >
                    <span>{t('mods.versionSelectorLabel')}</span>
                    <Select
                      value={selectedVersionKey ?? membershipRowKey(row)}
                      onChange={onSelectVersion}
                      aria-label={t('mods.versionSelectorTitle')}
                      onClick={(event) => event.stopPropagation()}
                      options={versionOptions.map((option) => ({
                        value: option.key,
                        label: (
                          <span className="gf-version-option-label">
                            <span
                              className={`gf-version-option-status${option.installedEnabled ? ' is-active' : ' is-stored'}`}
                              role="img"
                              aria-label={versionSelectorStateLabel(option)}
                              title={versionSelectorStateLabel(option)}
                            >
                              {option.installedEnabled
                                ? <CircleCheck size={13} aria-hidden="true" />
                                : <Archive size={13} aria-hidden="true" />}
                            </span>
                            <span className="gf-version-option-main">
                              v{cleanVersion(option.version) || '?'}
                            </span>
                            {option.sourceLabel && (
                              <span className="gf-version-option-source">
                                {option.sourceLabel}
                              </span>
                            )}
                          </span>
                        ),
                      }))}
                    />
                  </label>
                  <button
                    type="button"
                    className={`gf-btn-3 gf-btn-icon gf-version-manage${removableLocalVersion ? ' is-guided' : ''}`}
                    title={removableLocalVersion ? t('mods.versionManageGuided', { source: removableLocalVersion.sourceLabel, version: cleanVersion(removableLocalVersion.version) }) : t('mods.versionManageTitle')}
                    aria-label={removableLocalVersion ? t('mods.versionManageGuided', { source: removableLocalVersion.sourceLabel, version: cleanVersion(removableLocalVersion.version) }) : t('mods.versionManageTitle')}
                    onClick={() => {
                      onClearDeleteGuidance();
                      setVersionManagerOpen(true);
                    }}
                  >
                    <SlidersHorizontal size={13} />
                  </button>
                </div>
              )}
              {row.folder_name &&
                (row.folder_name !== row.name ||
                  !!row.display_name?.trim()) && (
                  <span
                    className="gf-meta-folder"
                    title={t('mods.onDiskFolderTitle', {
                      folder: row.folder_name,
                    })}
                  >
                    <FolderOpen size={10} /> {row.folder_name}
                  </span>
                )}
              {!packScoped && profileVersionSummary.length > 0 && (
                <span className="gf-meta-modpacks" title={modpackUsageTitle}>
                  <Layers size={10} />{' '}
                  {profileVersionSummary.length > 0
                    ? t('libraryTable.inModpacks', {
                        count: profileVersionSummary.length,
                      })
                    : t('libraryTable.inNoModpacks')}
                </span>
              )}
              {reorderable && (
                <span className="gf-load-order-rank-inline">
                  #{inPackIndex + 1}
                </span>
              )}
            </div>
            {/* Bundle member list — shown in comfortable density when this
              mod is a bundle container (bundle_members is non-empty). */}
            {mod && (mod.bundle_members?.length ?? 0) > 0 && (
              <ul
                className="gf-bundle-members"
                aria-label={t('bundle.membersAria', { name: displayName })}
              >
                {mod.bundle_members!.map((memberName) => (
                  <li key={memberName} className="gf-bundle-member-name">
                    {memberName}
                  </li>
                ))}
              </ul>
            )}
            {/* Description (manager override or manifest) + free-form
              note. Both render outside the drawer because they're part
              of the row's identity. */}
            {mod &&
              (mod.display_description ||
                mod.description ||
                mod.note ||
                sourceConflict) && (
                <div className="gf-modrow-meta">
                  {(mod.display_description || mod.description) && (
                    <p
                      className="gf-modrow-desc"
                      title={mod.display_description?.trim() || mod.description}
                    >
                      {mod.display_description?.trim() || mod.description}
                    </p>
                  )}
                  {mod.note && (
                    <p className="gf-modrow-note" title={mod.note}>
                      {t('mods.notePrefix')} {mod.note}
                    </p>
                  )}
                  {sourceConflict && (
                    <p
                      className="gf-modrow-note gf-source-conflict-warning"
                      title={t('mods.duplicateSourceWarning')}
                    >
                      <AlertTriangle size={11} /> {t('mods.duplicateSourceWarning')}
                    </p>
                  )}
                </div>
              )}
          </div>
          <div className="gf-profile-library-row-actions">
            {/* In-pack / not-in-pack indicator — only in the All Mods view,
              where membership against the active pack is informative. In the
              dedicated modpack view every row is already in the pack, so it
              would be redundant and is hidden. */}
            {modpackName != null &&
              !packScoped &&
              (state ? (
                <span
                  className={`gf-row-inpack${state.included ? ' is-in' : ''}`}
                  title={
                    state.included
                      ? t('libraryTable.inPackTitle', {
                          modpack: modpackDisplayName,
                        })
                      : t('libraryTable.notInPackTitle', {
                          modpack: modpackDisplayName,
                        })
                  }
                >
                  {state.included ? <Check size={12} /> : <X size={12} />}
                  <span className="gf-row-inpack-label">
                    {state.included
                      ? t('libraryTable.inPack')
                      : t('libraryTable.notInPack')}
                  </span>
                  {saving && (
                    <RefreshCw size={11} className="animate-spin" aria-hidden />
                  )}
                </span>
              ) : (
                <span className="gf-profile-library-muted">
                  {t('libraryTable.modpackMissing')}
                </span>
              ))}
            {/* Primary visible row action. Modpack view → "Remove from pack"
              (membership remove only; storage stays under the row switch).
              All Mods view → the disk-delete trash. Delete-from-disk for the
              modpack view lives in the kebab. */}
            {packScoped ? (
              <button
                type="button"
                className="gf-row-remove"
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleMembership(row);
                }}
                disabled={saving || (!!state && !state.editable)}
                title={t('modpack.detail.removeFromPackTitle')}
                aria-label={t('modpack.detail.removeFromPackAria', {
                  mod: displayName,
                })}
              >
                {saving ? (
                  <RefreshCw size={13} className="animate-spin" />
                ) : (
                  <X size={13} />
                )}
                {t('modpack.detail.remove')}
              </button>
            ) : (
              mod &&
              onDelete !== noop && (
                <button
                  type="button"
                  className="gf-row-delete"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete();
                  }}
                  disabled={gameRunning}
                  title={
                    gameRunning
                      ? t('mods.closeSts2FirstDot')
                      : t('mods.removeMod')
                  }
                  aria-label={t('mods.removeModNamed', { mod: displayName })}
                >
                  <Trash2 size={14} />
                </button>
              )
            )}
            {mod && (
              <LibraryRowKebab
                mod={mod}
                audit={audit}
                modpackName={modpackName}
                modpackLabel={modpackDisplayName}
                state={state}
                packScoped={packScoped}
                isUpdating={isUpdating}
                isRepairing={isRepairing}
                isRollingBack={isRollingBack}
                anyRecoveryInFlight={anyRecoveryInFlight}
                membershipSaving={!!membershipSaving}
                gameRunning={gameRunning}
                onToggleMembership={() => onToggleMembership(row)}
                onTogglePin={onTogglePin}
                onSnooze={onSnooze}
                onUnsnooze={onUnsnooze}
                onCopyVersion={onCopyVersion}
                onOpenThisModFolder={onOpenThisModFolder}
                onFindGithubFromNexus={onFindGithubFromNexus}
                onAutoDetectSource={onAutoDetectSource}
                onRepair={onRepair}
                onRollback={onRollback}
                onDelete={onDelete}
                onOpenExternalUrl={onOpenExternalUrl}
              />
            )}
          </div>
        </div>
        {sourceEditorSlot && (
          // The editor lives inside the clickable row — stop clicks/keys
          // from bubbling to the row's onClick (which would re-open the
          // editor the moment the user clicks Cancel/X inside it).
          <div
            className="gf-profile-library-source-editor"
            data-testid="library-row-source-editor"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            {sourceEditorSlot}
          </div>
        )}
      </Card>
      {versionManagerOpen && (
        <div
          className="gf-modal-back"
          onClick={() => setVersionManagerOpen(false)}
        >
          <div
            className="gf-modal gf-version-manager"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`version-manager-${membershipRowKey(row)}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="gf-modal-head">
              <div>
                <div
                  id={`version-manager-${membershipRowKey(row)}`}
                  className="gf-modal-title"
                >
                  {t('mods.versionManageHeading', { mod: displayName })}
                </div>
                <div className="gf-modal-sub">{t('mods.versionManageSub')}</div>
              </div>
              <button
                type="button"
                onClick={() => setVersionManagerOpen(false)}
                className="gf-btn-3 gf-btn-icon"
                title={t('common.close')}
                aria-label={t('common.close')}
              >
                <X size={14} />
              </button>
            </div>
            <div className="gf-modal-body">
              <ul className="gf-version-manager-list">
                {versionOptions.map((option) => {
                  const reason = versionRemoveBlockReason(option);
                  const removing = removingVersionKey === option.key;
                  const keepingOnly = keepingOnlyVersionKey === option.key;
                  const managedBySteam =
                    option.installSource === 'steam_workshop' && option.installed;
                  const canKeepOnly = versionOptions.length > 1
                    && (option.installed || option.cached)
                    && !versionOptions.some((candidate) => candidate.pinned)
                    && !versionOptions.some((candidate) =>
                      candidate.key !== option.key
                      && candidate.installSource === 'steam_workshop');
                  const workshopVersionUrl = versionWorkshopUrl(option);
                  return (
                    <li key={option.key} className="gf-version-manager-item">
                      <div className="gf-version-manager-copy">
                        <span className="gf-version-manager-version">
                          {t('mods.versionOptionVersion', {
                            version:
                              option.version.trim().replace(/^v/i, '') || '?',
                          })}
                        </span>
                        <span className="gf-version-manager-state">
                          {versionStateLabel(option)}
                        </span>
                        {option.sourceLabel && (
                          <span className="gf-version-manager-source">
                            {option.sourceLabel}
                          </span>
                        )}
                        {reason && (
                          <span className="gf-version-manager-reason">
                            {reason}
                          </span>
                        )}
                      </div>
                      <div className="gf-version-manager-actions">
                        <button
                          type="button"
                          className="gf-btn-3 gf-version-manager-keep"
                          disabled={!canKeepOnly || keepingOnlyVersionKey !== null || removingVersionKey !== null}
                          title={!canKeepOnly ? t('mods.versionKeepOnlyUnavailable') : undefined}
                          onClick={async () => {
                            const kept = await onKeepOnlyVersion(option);
                            if (kept) setVersionManagerOpen(false);
                          }}
                        >
                          {keepingOnly ? t('mods.versionKeepingOnly') : t('mods.versionKeepOnly')}
                        </button>
                        {managedBySteam ? (
                          <button
                            type="button"
                            className="gf-btn-3 gf-version-manager-remove"
                            disabled={!workshopVersionUrl || keepingOnlyVersionKey !== null}
                            onClick={() => {
                              if (workshopVersionUrl) onOpenExternalUrl(workshopVersionUrl);
                            }}
                          >
                            {workshopVersionUrl
                              ? t('mods.versionOpenWorkshop')
                              : t('mods.versionSteamManaged')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="gf-btn-3 gf-btn-danger gf-version-manager-remove"
                            disabled={removing || keepingOnlyVersionKey !== null}
                            onClick={() => onRemoveVersion(option)}
                          >
                            {removing
                              ? t('mods.versionRemoving')
                              : t('mods.versionRemove')}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="gf-modal-foot">
              <button
                type="button"
                className="gf-btn-3"
                onClick={() => setVersionManagerOpen(false)}
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * Per-row kebab menu. Renders the full action surface ModRow used to
 * expose in its drawer (Activate, Freeze, Skip update, Edit sources,
 * View on GitHub/Nexus, Repair, Rollback, Delete). Lifted into a small
 * helper so the row file's main body stays readable.
 */
interface LibraryRowKebabProps {
  mod: ModInfo;
  audit: ModAuditEntry | undefined;
  modpackName: string | null;
  modpackLabel?: string | null;
  state: ProfileMembershipState | undefined;
  /** Dedicated modpack view: the membership toggle moves to the visible
   *  "Remove from pack" button, and the kebab instead offers
   *  "Delete from disk". */
  packScoped: boolean;
  isUpdating: boolean;
  isRepairing: boolean;
  isRollingBack: boolean;
  anyRecoveryInFlight: boolean;
  membershipSaving: boolean;
  gameRunning: boolean;
  onToggleMembership: () => void;
  onTogglePin: () => void;
  onSnooze: () => void;
  onUnsnooze: () => void;
  onCopyVersion: () => void;
  onOpenThisModFolder: () => void;
  onFindGithubFromNexus: () => void;
  onAutoDetectSource: () => void;
  onRepair: () => void;
  onRollback: () => void;
  onDelete: () => void;
  onOpenExternalUrl: (url: string) => void;
}

function LibraryRowKebab(props: LibraryRowKebabProps) {
  const { t } = useTranslation();
  const { config } = useRowMenu();
  const {
    mod,
    audit,
    modpackName,
    modpackLabel,
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
  const modpackDisplayName = profileDisplayName(
    modpackLabel ?? modpackName,
    t('quickAdd.unknown'),
  );

  // Membership classification (in / includedOff / notIn) — null hides the item.
  let membershipChip: 'in' | 'includedOff' | 'notIn' | null = null;
  if (modpackName && state) {
    if (!state.included) membershipChip = 'notIn';
    else if (state.enabled) membershipChip = 'in';
    else membershipChip = 'includedOff';
  }

  const snoozeTargetVersion =
    audit?.latest_release_with_assets_tag ?? audit?.nexus_version ?? null;
  const canSnooze =
    !!audit?.snoozed || (!!audit?.needs_update && !!snoozeTargetVersion);
  const hasUserConfirmedGithub = !!mod.github_url && !mod.github_auto_detected;
  const workshopOwned = isWorkshopOwnedEntry(mod);

  // Rebuilt per render — cheap, and the menu only mounts/opens on demand. Don't memoize (it would force listing every closure capture as a dep).
  // One descriptor per customizable id: contextual availability + how to render.
  const descriptors: Record<
    RowMenuItemId,
    { available: boolean; render: () => ReactNode }
  > = {
    membership: {
      available: !packScoped && !!modpackName && !!membershipChip,
      render: () => (
        <KebabItem
          key="membership"
          icon={
            membershipChip === 'notIn' ? (
              <ToggleRight size={12} />
            ) : (
              <ToggleLeft size={12} />
            )
          }
          onClick={onToggleMembership}
          disabled={membershipSaving || !state?.editable}
          description={
            membershipChip === 'notIn'
              ? t('mods.kebab.addToModpackDesc', { pack: modpackDisplayName })
              : t('mods.kebab.removeFromModpackDesc', {
                  pack: modpackDisplayName,
                })
          }
        >
          {membershipChip === 'notIn'
            ? t('mods.kebab.addToModpack', { pack: modpackDisplayName })
            : t('mods.kebab.removeFromModpack', { pack: modpackDisplayName })}
        </KebabItem>
      ),
    },
    copyVersion: {
      available: true,
      render: () => (
        <KebabItem
          key="copyVersion"
          icon={<Copy size={12} />}
          onClick={onCopyVersion}
        >
          {t('mods.copyVersion', { version: mod.version.replace(/^v/i, '') })}
        </KebabItem>
      ),
    },
    openFolder: {
      available: true,
      render: () => (
        <KebabItem
          key="openFolder"
          icon={<FolderOpen size={12} />}
          onClick={onOpenThisModFolder}
        >
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
              version: snoozeTargetVersion?.replace(/^v/, '') ?? '?',
            })}
          >
            {t('mods.snoozeUpdate')}
          </KebabItem>
        ),
    },
    autoDetect: {
      available: !workshopOwned,
      render: () => (
        <KebabItem
          key="autoDetect"
          icon={<Search size={12} />}
          onClick={onAutoDetectSource}
        >
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
      available: !!mod.nexus_url && !mod.github_url && !workshopOwned,
      render: () => (
        <KebabItem
          key="findGithub"
          icon={<GitBranch size={12} />}
          onClick={onFindGithubFromNexus}
        >
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
          icon={
            isRepairing ? (
              <RefreshCw size={12} className="animate-spin" />
            ) : (
              <Wrench size={12} />
            )
          }
          onClick={onRepair}
          disabled={
            gameRunning ||
            anyRecoveryInFlight ||
            !hasUserConfirmedGithub ||
            workshopOwned ||
            isUpdating
          }
          description={
            workshopOwned
              ? t('mods.workshopManagedDesc')
              : hasUserConfirmedGithub
              ? t('mods.repairDesc')
              : t('mods.repairNeedSource')
          }
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
          icon={
            isRollingBack ? (
              <RefreshCw size={12} className="animate-spin" />
            ) : (
              <RotateCcw size={12} />
            )
          }
          onClick={onRollback}
          disabled={
            gameRunning ||
            anyRecoveryInFlight ||
            !hasUserConfirmedGithub ||
            workshopOwned ||
            isUpdating
          }
          description={
            workshopOwned
              ? t('mods.workshopManagedDesc')
              : hasUserConfirmedGithub
              ? t('mods.rollbackDesc')
              : t('mods.rollbackNeedSource')
          }
        >
          {isRollingBack ? t('mods.rollingBack') : t('mods.rollBackOneVersion')}
        </KebabItem>
      ),
    },
  };

  const availableIds = new Set<RowMenuItemId>(
    (Object.keys(descriptors) as RowMenuItemId[]).filter(
      (id) => descriptors[id].available,
    ),
  );
  const orderedIds = resolveRowMenuOrder(config, availableIds);

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <KebabMenu title={t('mods.modActions')}>
        <KebabSection>
          {orderedIds.map((id) => descriptors[id].render())}
        </KebabSection>
        {/* Locked danger item — disk delete, modpack view only, pinned bottom. */}
        {packScoped && (
          <>
            <KebabDivider />
            <KebabSection>
              <KebabItem
                danger
                icon={<Trash2 size={12} />}
                onClick={onDelete}
                disabled={gameRunning || workshopOwned}
                description={
                  workshopOwned
                    ? t('mods.workshopManagedDesc')
                    : t('mods.kebab.deleteFromDiskDesc')
                }
              >
                {t('mods.kebab.deleteFromDisk')}
              </KebabItem>
            </KebabSection>
          </>
        )}
        {/* Locked footer — always last; opens the Settings customizer. */}
        {config.showCustomizeEntry && (
          <>
            <KebabDivider />
            <KebabSection>
              <KebabItem
                icon={<SlidersHorizontal size={12} />}
                onClick={() =>
                  window.dispatchEvent(new CustomEvent(ROW_MENU_OPEN_EVENT))
                }
                description={t('mods.customizeMenuDesc')}
              >
                {t('mods.customizeMenu')}
              </KebabItem>
            </KebabSection>
          </>
        )}
      </KebabMenu>
    </div>
  );
}
