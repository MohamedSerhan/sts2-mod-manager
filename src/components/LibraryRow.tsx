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
  Link as LinkIcon,
  RefreshCw,
  RotateCcw,
  Snowflake,
  Sun,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Wrench,
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
  onEditSources?: () => void;
  onFindGithubFromNexus?: () => void;
  onOpenExternalUrl?: (url: string) => void;
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
  onEditSources = noop,
  onFindGithubFromNexus = noop,
  onOpenExternalUrl = noop,
  sourceEditorSlot,
}: LibraryRowProps) {
  const { t } = useTranslation();
  const membershipKey = modpackName
    ? `${membershipRowKey(row)}::${modpackName}`
    : null;
  const saving = membershipKey != null && membershipSaving === membershipKey;
  const displayName = membershipDisplayName(row);
  // Drag-reorder is only meaningful in a load-order context
  // (ModpackDetail). The Library view passes enableReorder=false, so
  // the drag handle, the `draggable` attribute, and the rank chip stay
  // hidden there even though rows can be "in pack".
  const reorderable = enableReorder && inPack && inPackIndex >= 0;
  // Audit pill flags. We surface exactly one of: update / blocked /
  // frozen / snoozed at a time, mirroring ModRow's drawer logic, but in
  // an inline chip-row so the user doesn't have to expand anything.
  const compatibleTag =
    audit?.latest_compatible_tag ?? audit?.latest_release_with_assets_tag ?? null;
  const showUpdatePill =
    !!audit
    && audit.needs_update
    && !audit.pinned
    && !audit.snoozed
    && !audit.game_version_too_old
    && !audit.latest_release_blocked_by_game_version
    && !!compatibleTag
    && !!mod?.github_url;
  const showBlockedPill =
    !!audit?.latest_release_blocked_by_game_version && !audit.pinned;
  const showFrozenPill = !!mod?.pinned;
  const showSnoozedPill = !!audit?.snoozed;
  const auditError = audit?.error ?? null;
  const minGameViolated =
    !!mod?.min_game_version && !gameVersionSatisfies(gameVersion, mod.min_game_version);

  return (
    <Card
      className={`gf-profile-library-row ${inPack ? 'in-pack' : ''} ${isDragOver ? 'drag-over' : ''}${mod?.pinned ? ' gf-mod-pinned' : ''}`}
      draggable={reorderable && !loadOrderSaving}
      onDragStart={(event) => onDragStart(event, inPackIndex)}
      onDragOver={(event) => onDragOver(event, inPackIndex)}
      onDragLeave={() => onDragLeave(inPackIndex)}
      onDrop={(event) => onDrop(event, inPackIndex)}
      onDragEnd={onDragEnd}
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
            {/* Show folder_name as a disambiguator only when it adds
                signal — skip when it duplicates the title text (i.e.
                folder_name === name AND no display_name override) so
                rows don't render the same string twice. */}
            {row.folder_name
              && (row.folder_name !== row.name || !!row.display_name?.trim())
              && <span>{row.folder_name}</span>}
            {reorderable && (
              <span className="gf-load-order-rank-inline">
                #{inPackIndex + 1}
              </span>
            )}
            {/* Audit pills — one at a time. The update pill fires
                onUpdate (per-row install); blocked / frozen / snoozed
                are informational. */}
            {audit && isUpToDate(audit) && !showUpdatePill && !showBlockedPill && !showFrozenPill && !showSnoozedPill && (
              <span className="gf-pill gf-pill-ok" title={t('mods.latestTitle')}>
                <Check size={9} /> {t('mods.latest')}
              </span>
            )}
            {showUpdatePill && (
              <button
                type="button"
                className="gf-pill gf-pill-update"
                onClick={onUpdate}
                disabled={gameRunning || isUpdating || anyUpdating}
                title={
                  gameRunning
                    ? t('mods.closeSts2FirstDot')
                    : t('mods.updateClickTitle', {
                        current: mod!.version,
                        target: compatibleTag?.replace(/^v/, ''),
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
                      version: compatibleTag?.replace(/^v/, ''),
                    })}
                  </>
                )}
              </button>
            )}
            {showBlockedPill && (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300"
                title={t('mods.gameVersionBlockedTitle', {
                  target:
                    audit!.latest_release_with_assets_tag?.replace(/^v/, '') ?? '?',
                })}
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
                title={t('mods.snoozedTitle', {
                  version:
                    audit!.latest_release_with_assets_tag?.replace(/^v/, '') ?? '?',
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
                  background: 'oklch(0.78 0.16 60 / 0.18)',
                  color: 'oklch(0.85 0.16 60)',
                }}
                title={t('mods.minGameVersionTitle', {
                  minVer: mod!.min_game_version,
                  yourVer: gameVersion ?? 'unknown',
                })}
              >
                <AlertTriangle size={9} /> {t('mods.needsGameVersion', { version: mod!.min_game_version })}
              </span>
            )}
          </div>
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
        <div className="gf-profile-library-storage-actions">
          {/* Source pills + tags. Only rendered when we have a ModInfo
              to read from. When the mod has no link at all, we surface
              an "Unlinked" / "Local" badge so the user can tell the row
              apart from linked mods (this matches the old ModRow drawer
              behavior). Active/stored is no longer a per-row button —
              it's derived from the active modpack and lives in the
              kebab ("Activate in game" / "Disable in game") for power
              users. */}
          {mod && (
            <div className="gf-modrow-drawer-sources">
              {mod.github_url && (
                <a
                  href={mod.github_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex"
                  title={t('mods.viewOnGitHub', { url: mod.github_url })}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Badge variant="github">
                    <GitBranch size={10} className="mr-1" />
                    {t('mods.gitHub')}
                  </Badge>
                </a>
              )}
              {mod.nexus_url && (
                <a
                  href={mod.nexus_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex"
                  title={t('mods.viewOnNexus', { url: mod.nexus_url })}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Badge variant="nexus">{t('mods.nexus')}</Badge>
                </a>
              )}
              {mod.custom_url && (
                <a
                  href={mod.custom_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex"
                  title={t('mods.openLink', { url: mod.custom_url })}
                  onClick={(e) => e.stopPropagation()}
                >
                  <Badge variant="default">
                    <ExternalLink size={10} className="mr-1" />
                    {t('mods.link')}
                  </Badge>
                </a>
              )}
              {!mod.github_url && !mod.nexus_url && !mod.custom_url && (
                <Badge variant={mod.source ? 'local' : 'default'}>
                  {mod.source ? t('mods.local') : t('mods.unlinked')}
                </Badge>
              )}
            </div>
          )}
          {mod && <LibraryRowKebab
            mod={mod}
            audit={audit}
            modpackName={modpackName}
            state={state}
            isUpdating={isUpdating}
            isRepairing={isRepairing}
            isRollingBack={isRollingBack}
            anyRecoveryInFlight={anyRecoveryInFlight}
            membershipSaving={!!membershipSaving}
            gameRunning={gameRunning}
            onToggleMembership={() => onToggleMembership(row)}
            onToggleStorage={() => onToggleStorage(row)}
            onTogglePin={onTogglePin}
            onSnooze={onSnooze}
            onUnsnooze={onUnsnooze}
            onCopyVersion={onCopyVersion}
            onOpenModsFolder={onOpenModsFolder}
            onEditSources={onEditSources}
            onFindGithubFromNexus={onFindGithubFromNexus}
            onRepair={onRepair}
            onRollback={onRollback}
            onDelete={onDelete}
            onOpenExternalUrl={onOpenExternalUrl}
          />}
        </div>
      </div>
      {modpackName != null && (
        <div className="gf-profile-memberships">
          {state ? (
            <label
              className={`gf-profile-membership ${state.included ? 'active' : ''}`}
              title={
                !state.editable
                  ? t('profiles.library.readOnlyTitle')
                  : t('libraryTable.membershipCheckbox', {
                      mod: displayName,
                      modpack: modpackName,
                    })
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
                onChange={() => onToggleMembership(row)}
                aria-label={t('libraryTable.membershipCheckbox', {
                  mod: displayName,
                  modpack: modpackName,
                })}
              />
              {/* Short visible label — the full pack name lives in the
                  aria-label + title so every row doesn't repeat the
                  (often long) modpack name inline. */}
              <span className="gf-profile-membership-name">
                {state.included
                  ? t('libraryTable.inPack')
                  : t('libraryTable.notInPack')}
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
      )}
      {sourceEditorSlot && (
        <div className="gf-profile-library-source-editor" data-testid="library-row-source-editor" style={{ gridColumn: '1 / -1' }}>
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
  isUpdating: boolean;
  isRepairing: boolean;
  isRollingBack: boolean;
  anyRecoveryInFlight: boolean;
  membershipSaving: boolean;
  gameRunning: boolean;
  onToggleMembership: () => void;
  onToggleStorage: () => void;
  onTogglePin: () => void;
  onSnooze: () => void;
  onUnsnooze: () => void;
  onCopyVersion: () => void;
  onOpenModsFolder: () => void;
  onEditSources: () => void;
  onFindGithubFromNexus: () => void;
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
    isUpdating,
    isRepairing,
    isRollingBack,
    anyRecoveryInFlight,
    membershipSaving,
    gameRunning,
    onToggleMembership,
    onToggleStorage,
    onTogglePin,
    onSnooze,
    onUnsnooze,
    onCopyVersion,
    onOpenModsFolder,
    onEditSources,
    onFindGithubFromNexus,
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
          {modpackName && membershipChip && (
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
          <KebabItem
            icon={mod.enabled ? <ToggleLeft size={12} /> : <ToggleRight size={12} />}
            onClick={onToggleStorage}
            disabled={gameRunning}
            description={
              mod.enabled ? t('mods.kebab.disableDesc') : t('mods.kebab.activateDesc')
            }
          >
            {mod.enabled ? t('mods.kebab.disable') : t('mods.kebab.activate')}
          </KebabItem>
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
            {isRollingBack ? (
              t('mods.rollingBack')
            ) : (
              <span className="inline-flex items-center gap-1">
                {t('mods.rollBackOneVersion')}
                <Badge variant="beta" ariaHidden>
                  {t('common.beta')}
                </Badge>
              </span>
            )}
          </KebabItem>
        </KebabSection>
        <KebabDivider />
        <KebabItem
          danger
          icon={<Trash2 size={12} />}
          onClick={onDelete}
          disabled={gameRunning}
        >
          {t('mods.removeMod')}
        </KebabItem>
      </KebabMenu>
    </div>
  );
}
