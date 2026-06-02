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
import type { ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  Clock,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  GitBranch,
  GripVertical,
  Layers,
  Link as LinkIcon,
  RefreshCw,
  RotateCcw,
  Search,
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
import {
  KebabDivider,
  KebabItem,
  KebabMenu,
  KebabSection,
} from './KebabMenu';
import { Toggle } from './Toggle';
import { isUpToDate } from '../lib/auditState';
import type {
  ModAuditEntry,
  ModInfo,
  ProfileMembershipMod,
  ProfileMembershipState,
} from '../types';

export function membershipRowKey(row: ProfileMembershipMod): string {
  return row.folder_name ?? row.mod_id ?? row.name;
}

export function membershipDisplayName(row: ProfileMembershipMod): string {
  return row.display_name?.trim() || row.name;
}

export function libraryStorageKey(row: ProfileMembershipMod): string {
  return `storage::${membershipRowKey(row)}`;
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
    v.trim().replace(/^v/i, '').split('.').slice(0, 3).map((n) => Number.parseInt(n, 10));
  const [cMaj, cMin, cPatch] = parse(current);
  const [rMaj, rMin, rPatch] = parse(required);
  if ([cMaj, cMin, cPatch, rMaj, rMin, rPatch].some((n) => Number.isNaN(n))) return true;
  if (cMaj !== rMaj) return cMaj > rMaj;
  if (cMin !== rMin) return cMin > rMin;
  return cPatch >= rPatch;
}

export interface LibraryRowProps {
  /** The membership grid row for this mod. */
  row: ProfileMembershipMod;
  /** Name of the focused modpack — used for ARIA labels + checkbox copy.
   *  When null, the row hides the per-modpack checkbox and drag handle
   *  (Library view uses this mode). */
  modpackName: string | null;
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
  /** Current game running state — disables destructive actions. */
  gameRunning?: boolean;
  /** Current STS2 game version, drives the min_game_version warning. */
  gameVersion?: string | null;
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
  onTogglePin?: () => void;
  onSnooze?: () => void;
  onUnsnooze?: () => void;
  onRepair?: () => void;
  onRollback?: () => void;
  onDelete?: () => void;
  onCopyVersion?: () => void;
  onOpenModsFolder?: () => void;
  /** Open THIS mod's folder (vs. the global mods dir). Bug 6. */
  onOpenThisModFolder?: () => void;
  onEditSources?: () => void;
  onFindGithubFromNexus?: () => void;
  onOpenExternalUrl?: (url: string) => void;
  onAutoDetectSource?: () => void;
  /** Optional slot rendered inside the row (currently used by the
   *  Library view to attach the inline SourceEditor below the row). */
  sourceEditorSlot?: ReactNode;
}

const noop = () => {};

export function LibraryRow({
  row,
  modpackName,
  state,
  inPack,
  inPackIndex,
  enableReorder = false,
  packScoped = false,
  packActive = false,
  isDragOver,
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
  mod,
  audit,
  gameRunning = false,
  gameVersion,
  isUpdating = false,
  isRepairing = false,
  isRollingBack = false,
  anyUpdating = false,
  anyRecoveryInFlight = false,
  onUpdate = noop,
  onTogglePin = noop,
  onSnooze = noop,
  onUnsnooze = noop,
  onRepair = noop,
  onRollback = noop,
  onDelete = noop,
  onCopyVersion = noop,
  onOpenModsFolder = noop,
  onOpenThisModFolder = noop,
  onEditSources = noop,
  onFindGithubFromNexus = noop,
  onOpenExternalUrl = noop,
  onAutoDetectSource = noop,
  sourceEditorSlot,
}: LibraryRowProps) {
  const { t } = useTranslation();
  const membershipKey = modpackName
    ? `${membershipRowKey(row)}::${modpackName}`
    : null;
  const saving = membershipKey != null && membershipSaving === membershipKey;
  const displayName = membershipDisplayName(row);
  // Per-row storage (active/stored) mutation in flight. Drives the small
  // spinner beside the active/stored toggle. `storageSaving` carries the
  // libraryStorageKey of the row being flipped (or BULK_STORAGE_KEY).
  const storageBusy = storageSaving === libraryStorageKey(row);
  // Drag-reorder is only meaningful in a load-order context
  // (ModpackDetail). The Library view passes enableReorder=false, so
  // the drag handle, the `draggable` attribute, and the rank chip stay
  // hidden there even though rows can be "in pack".
  const reorderable = enableReorder && inPack && inPackIndex >= 0;
  // "In N modpacks" — how many of the user's modpacks include this mod. Only
  // meaningful in the All Mods view (the focused membership grid carries every
  // profile's state); the synthesized no-focus grid leaves profiles empty, so
  // the indicator hides there and in the pack-scoped modpack view.
  const includedProfiles = row.profiles.filter((p) => p.included);
  // Audit pill flags. We surface exactly one of: update / blocked /
  // frozen / snoozed at a time, mirroring ModRow's drawer logic, but in
  // an inline chip-row so the user doesn't have to expand anything.
  const compatibleTag =
    audit?.latest_compatible_tag ?? audit?.latest_release_with_assets_tag ?? null;
  // Version to display in the update pill. GitHub updates use the release
  // tag (compatibleTag); Nexus-only updates fall back to nexus_version so
  // the pill shows a real version string rather than undefined.
  const updateDisplayVersion = compatibleTag ?? audit?.nexus_version ?? null;
  // Show the update pill for a GitHub update (when compatibleTag is known)
  // OR for a Nexus-only update (nexus_update_available is true). Bundles
  // and Nexus-only mods have no github_url, so gating on github_url alone
  // was silently hiding their "update available" state.
  const showUpdatePill =
    !!audit
    && audit.needs_update
    && !audit.pinned
    && !audit.snoozed
    && !audit.game_version_too_old
    && !audit.latest_release_blocked_by_game_version
    && (!!compatibleTag || !!audit.nexus_update_available);
  const showBlockedPill =
    !!audit?.latest_release_blocked_by_game_version && !audit.pinned;
  const showFrozenPill = !!mod?.pinned;
  const showSnoozedPill = !!audit?.snoozed;
  const auditError = audit?.error ?? null;
  const minGameViolated =
    !!mod?.min_game_version && !gameVersionSatisfies(gameVersion, mod.min_game_version);

  return (
    <Card
      className={`gf-profile-library-row${(!packScoped || packActive) && row.installed_enabled ? ' is-active' : ''}${isDragOver ? ' drag-over' : ''}${mod?.pinned ? ' gf-mod-pinned' : ''}${mod ? ' is-clickable' : ''}`}
      draggable={reorderable && !loadOrderSaving}
      onDragStart={(event) => onDragStart(event, inPackIndex)}
      onDragOver={(event) => onDragOver(event, inPackIndex)}
      onDragLeave={() => onDragLeave(inPackIndex)}
      onDrop={(event) => onDrop(event, inPackIndex)}
      onDragEnd={onDragEnd}
      // 4.4 — clicking the row opens its inline Edit-sources editor.
      // Interactive children (toggle, kebab, source links) stop
      // propagation so they don't also trigger this.
      onClick={mod ? () => onEditSources() : undefined}
      onKeyDown={
        mod
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
      role={mod ? 'button' : undefined}
      tabIndex={mod ? 0 : undefined}
      // Explicit accessible name so the row-button doesn't absorb its
      // children's text (which would make every inner pill/badge match a
      // getByRole('button', { name }) lookup for the row too).
      aria-label={mod ? t('mods.rowEditSourcesAria', { mod: displayName }) : undefined}
      title={mod ? t('mods.rowClickEditSources') : undefined}
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
        {mod && (!packScoped || packActive) && (
          <div
            className="gf-row-status"
            role="presentation"
            onClick={(event) => event.stopPropagation()}
          >
            <Toggle
              checked={row.installed_enabled}
              onChange={() => onToggleStorage(row)}
              // Only gate on the game running. We deliberately do NOT disable
              // while a save is in flight: disabling the just-clicked control
              // rips keyboard focus off it (it falls to <body>), and some
              // WebViews react to that focus loss by scrolling the list — so
              // the user gets yanked to the top on every toggle. Re-entrancy /
              // double-clicks are already guarded inside handleToggleStorage
              // (`if (storageSaving || membershipSaving) return`), so the
              // disabled attribute was only ever redundant insurance.
              disabled={gameRunning}
              ariaLabel={t('modpack.storage.toggleAria', { mod: displayName })}
              title={
                row.installed_enabled
                  ? t('modpack.storage.active')
                  : t('modpack.storage.storedHint')
              }
            />
            <span className="gf-row-status-label">
              {row.installed_enabled
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
            <h3 className="gf-profile-library-title">
              {row.display_name?.trim() || row.name}
            </h3>
            {row.display_name && (
              <span className="gf-profile-library-rawname">{row.name}</span>
            )}
            {/* Tags, source badges and audit pills all cluster to the
                right of the name — there's more room here than mid-row, so
                they read as one group instead of scattered bits. */}
            <span className="gf-row-tagcluster">
              {mod?.tags?.slice(0, 5).map((tag) => (
                <span key={tag} className="gf-row-tag">{tag}</span>
              ))}
              {mod?.github_url && (
                <a
                  href={mod.github_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gf-source-link"
                  title={t('mods.viewOnGitHub', { url: mod.github_url })}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Badge variant="github"><GitBranch size={10} className="mr-1" />{t('mods.gitHub')}</Badge>
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
                  <Badge variant="default"><ExternalLink size={10} className="mr-1" />{t('mods.link')}</Badge>
                </a>
              )}
              {mod && !mod.github_url && !mod.nexus_url && !mod.custom_url && (
                <Badge variant={mod.source ? 'local' : 'default'}>
                  {mod.source ? t('mods.local') : t('mods.unlinked')}
                </Badge>
              )}
              {/* Bundle member-count badge — shown when this mod is a
                  bundle container (bundle_members is non-empty). */}
              {(mod?.bundle_members?.length ?? 0) > 0 && (
                <span className="gf-pill gf-pill-github">
                  {t('bundle.memberCount', { count: mod!.bundle_members!.length })}
                </span>
              )}
              {/* Audit pills — one at a time. Update fires onUpdate; the
                  rest are informational. */}
              {audit && isUpToDate(audit) && !showUpdatePill && !showBlockedPill && !showFrozenPill && !showSnoozedPill && (
                <span className="gf-pill gf-pill-ok" title={t('mods.latestTitle')}>
                  <Check size={9} /> {t('mods.latest')}
                </span>
              )}
              {showUpdatePill && (
                <button
                  type="button"
                  className="gf-pill gf-pill-update"
                  onClick={(e) => { e.stopPropagation(); onUpdate(); }}
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
                    <><RefreshCw size={9} className="animate-spin" />{t('mods.updating')}</>
                  ) : (
                    <><Download size={9} />{t('mods.updateAvailable', { version: updateDisplayVersion?.replace(/^v/, '') })}</>
                  )}
                </button>
              )}
              {showBlockedPill && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300"
                  title={t('mods.gameVersionBlockedTitle', { target: audit!.latest_release_with_assets_tag?.replace(/^v/, '') ?? '?' })}
                >
                  <AlertTriangle size={9} /> {t('mods.updateBlockedByGameVersion')}
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
                  title={t('mods.snoozedTitle', { version: audit!.latest_release_with_assets_tag?.replace(/^v/, '') ?? '?' })}
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
                  style={{ background: 'oklch(0.78 0.16 60 / 0.18)', color: 'oklch(0.85 0.16 60)' }}
                  title={t('mods.minGameVersionTitle', { minVer: mod!.min_game_version, yourVer: gameVersion ?? 'unknown' })}
                >
                  <AlertTriangle size={9} /> {t('mods.needsGameVersion', { version: mod!.min_game_version })}
                </span>
              )}
            </span>
          </div>
          <div className="gf-profile-library-meta">
            {/* 4.5 — version is v-prefixed and the on-disk folder carries
                a folder glyph + tooltip, so version / folder / description
                read as distinct things instead of three grey lookalikes. */}
            <span className="gf-meta-version" title={t('mods.versionLabel')}>
              v{(row.version || '').replace(/^v/i, '')}
            </span>
            {row.folder_name
              && (row.folder_name !== row.name || !!row.display_name?.trim())
              && (
                <span
                  className="gf-meta-folder"
                  title={t('mods.onDiskFolderTitle', { folder: row.folder_name })}
                >
                  <FolderOpen size={10} /> {row.folder_name}
                </span>
              )}
            {!packScoped && row.profiles.length > 0 && (
              <span
                className="gf-meta-modpacks"
                title={
                  includedProfiles.length > 0
                    ? includedProfiles.map((p) => p.profile_name).join(', ')
                    : t('libraryTable.inNoModpacks')
                }
              >
                <Layers size={10} />{' '}
                {includedProfiles.length > 0
                  ? t('libraryTable.inModpacks', { count: includedProfiles.length })
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
          {mod && (mod.display_description || mod.description || mod.note) && (
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
            </div>
          )}
        </div>
        <div className="gf-profile-library-row-actions">
          {/* In-pack / not-in-pack indicator — only in the All Mods view,
              where membership against the active pack is informative. In the
              dedicated modpack view every row is already in the pack, so it
              would be redundant and is hidden. */}
          {modpackName != null && !packScoped && (
            state ? (
              <span
                className={`gf-row-inpack${state.included ? ' is-in' : ''}`}
                title={
                  state.included
                    ? t('libraryTable.inPackTitle', { modpack: modpackName })
                    : t('libraryTable.notInPackTitle', { modpack: modpackName })
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
            )
          )}
          {/* Primary visible row action. Modpack view → "Remove from pack"
              (membership remove; on the active pack it also unloads the mod).
              All Mods view → the disk-delete trash. Delete-from-disk for the
              modpack view lives in the kebab. */}
          {mod && packScoped ? (
            <button
              type="button"
              className="gf-row-remove"
              onClick={(event) => {
                event.stopPropagation();
                onToggleMembership(row);
              }}
              disabled={saving || (!!state && !state.editable)}
              title={t('modpack.detail.removeFromPackTitle')}
              aria-label={t('modpack.detail.removeFromPackAria', { mod: displayName })}
            >
              {saving ? (
                <RefreshCw size={13} className="animate-spin" />
              ) : (
                <X size={13} />
              )}
              {t('modpack.detail.remove')}
            </button>
          ) : (
            mod && onDelete !== noop && (
              <button
                type="button"
                className="gf-row-delete"
                onClick={(event) => {
                  event.stopPropagation();
                  onDelete();
                }}
                disabled={gameRunning}
                title={gameRunning ? t('mods.closeSts2FirstDot') : t('mods.removeMod')}
                aria-label={t('mods.removeModNamed', { mod: displayName })}
              >
                <Trash2 size={14} />
              </button>
            )
          )}
          {mod && <LibraryRowKebab
            mod={mod}
            audit={audit}
            modpackName={modpackName}
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
            onOpenModsFolder={onOpenModsFolder}
            onOpenThisModFolder={onOpenThisModFolder}
            onEditSources={onEditSources}
            onFindGithubFromNexus={onFindGithubFromNexus}
            onAutoDetectSource={onAutoDetectSource}
            onRepair={onRepair}
            onRollback={onRollback}
            onDelete={onDelete}
            onOpenExternalUrl={onOpenExternalUrl}
          />}
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
  onOpenModsFolder: () => void;
  onOpenThisModFolder: () => void;
  onEditSources: () => void;
  onFindGithubFromNexus: () => void;
  onAutoDetectSource: () => void;
  onRepair: () => void;
  onRollback: () => void;
  onDelete: () => void;
  onOpenExternalUrl: (url: string) => void;
}

function LibraryRowKebab(props: LibraryRowKebabProps) {
  const { t } = useTranslation();
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
    onOpenModsFolder,
    onOpenThisModFolder,
    onEditSources,
    onFindGithubFromNexus,
    onAutoDetectSource,
    onRepair,
    onRollback,
    onDelete,
    onOpenExternalUrl,
  } = props;

  // Derive membership classification (in / includedOff / notIn). When
  // modpackName is null OR there's no state row, we just hide the
  // membership kebab item entirely.
  let membershipChip: 'in' | 'includedOff' | 'notIn' | null = null;
  if (modpackName && state) {
    if (!state.included) membershipChip = 'notIn';
    else if (state.enabled) membershipChip = 'in';
    else membershipChip = 'includedOff';
  }

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <KebabMenu title={t('mods.modActions')}>
        <KebabSection>
          {/* Membership toggle — only in the All Mods view. In the modpack
              view the visible "Remove from pack" button covers it. */}
          {!packScoped && modpackName && membershipChip && (
            <KebabItem
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
                  ? t('mods.kebab.addToModpackDesc', { pack: modpackName })
                  : t('mods.kebab.removeFromModpackDesc', { pack: modpackName })
              }
            >
              {membershipChip === 'notIn'
                ? t('mods.kebab.addToModpack', { pack: modpackName })
                : t('mods.kebab.removeFromModpack', { pack: modpackName })}
            </KebabItem>
          )}
          {/* Active/stored is no longer a kebab item — it lives on the
              row itself as a dedicated switch (see <Toggle> in the
              storage-actions cluster). Keeping it out of the kebab
              avoids two controls for the same action. */}
          <KebabItem
            icon={mod.pinned ? <Sun size={12} /> : <Snowflake size={12} />}
            onClick={onTogglePin}
            description={mod.pinned ? t('mods.unpinDesc') : t('mods.pinDesc')}
          >
            {mod.pinned ? t('mods.unpinThisMod') : t('mods.pinThisMod')}
          </KebabItem>
          <KebabItem icon={<Copy size={12} />} onClick={onCopyVersion}>
            {t('mods.copyVersion', { version: mod.version })}
          </KebabItem>
          <KebabItem icon={<FolderOpen size={12} />} onClick={onOpenModsFolder}>
            {t('mods.openModsFolder')}
          </KebabItem>
          <KebabItem icon={<FolderOpen size={12} />} onClick={onOpenThisModFolder}>
            {t('mods.openThisModFolder')}
          </KebabItem>
          {audit?.snoozed ? (
            <KebabItem
              icon={<Check size={12} />}
              onClick={onUnsnooze}
              description={t('mods.unsnoozeDesc')}
            >
              {t('mods.unsnoozeUpdate')}
            </KebabItem>
          ) : (
            audit?.needs_update && !!audit.latest_release_with_assets_tag && (
              <KebabItem
                icon={<Clock size={12} />}
                onClick={onSnooze}
                description={t('mods.snoozeDesc', {
                  version:
                    audit.latest_release_with_assets_tag?.replace(/^v/, '') ?? '?',
                })}
              >
                {t('mods.snoozeUpdate')}
              </KebabItem>
            )
          )}
        </KebabSection>
        <KebabDivider />
        <KebabSection head={t('mods.sources')}>
          <KebabItem icon={<LinkIcon size={12} />} onClick={onEditSources}>
            {t('mods.editSources')}
          </KebabItem>
          <KebabItem icon={<Search size={12} />} onClick={onAutoDetectSource}>
            {t('mods.autoDetectSourceOne')}
          </KebabItem>
          {mod.github_url && (
            <KebabItem
              icon={<GitBranch size={12} />}
              onClick={() => onOpenExternalUrl(mod.github_url!)}
            >
              {t('mods.viewOnGitHubKebab')}
            </KebabItem>
          )}
          {mod.nexus_url && (
            <KebabItem
              icon={<ExternalLink size={12} />}
              onClick={() => onOpenExternalUrl(mod.nexus_url!)}
            >
              {t('mods.viewOnNexusKebab')}
            </KebabItem>
          )}
          {mod.nexus_url && !mod.github_url && (
            <KebabItem
              icon={<GitBranch size={12} />}
              onClick={onFindGithubFromNexus}
            >
              {t('mods.findGitHubFromNexus')}
            </KebabItem>
          )}
        </KebabSection>
        <KebabDivider />
        <KebabSection head={t('mods.recovery')}>
          <KebabItem
            icon={
              isRepairing ? (
                <RefreshCw size={12} className="animate-spin" />
              ) : (
                <Wrench size={12} />
              )
            }
            onClick={onRepair}
            disabled={gameRunning || anyRecoveryInFlight || !mod.github_url || isUpdating}
            description={
              mod.github_url ? t('mods.repairDesc') : t('mods.repairNeedSource')
            }
          >
            {isRepairing ? t('mods.repairing') : t('mods.repairThisMod')}
          </KebabItem>
          <KebabItem
            icon={
              isRollingBack ? (
                <RefreshCw size={12} className="animate-spin" />
              ) : (
                <RotateCcw size={12} />
              )
            }
            onClick={onRollback}
            disabled={gameRunning || anyRecoveryInFlight || !mod.github_url || isUpdating}
            description={
              mod.github_url ? t('mods.rollbackDesc') : t('mods.rollbackNeedSource')
            }
          >
            {isRollingBack ? t('mods.rollingBack') : t('mods.rollBackOneVersion')}
          </KebabItem>
        </KebabSection>
        {/* In the modpack view, deleting the mod from disk lives here (the
            visible row button is "Remove from pack"). In All Mods the
            visible trash handles disk-delete, so this stays out of the
            kebab there. */}
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
      </KebabMenu>
    </div>
  );
}
