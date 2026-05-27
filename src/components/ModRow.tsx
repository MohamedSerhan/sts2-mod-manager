import { useTranslation } from 'react-i18next';
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
  Link as LinkIcon,
  RefreshCw,
  RotateCcw,
  Snowflake,
  Sun,
  Tags,
  ToggleLeft,
  ToggleRight,
  Trash2,
  Wrench,
} from 'lucide-react';

import { Badge, getSourceVariant } from './Badge';
import { Button } from './Button';
import { HelpHint } from './HelpHint';
import {
  KebabDivider,
  KebabItem,
  KebabMenu,
  KebabSection,
} from './KebabMenu';
import { isUpToDate } from '../lib/auditState';
import type { ModAuditEntry, ModInfo } from '../types';

/**
 * 1.7.0 T17 — per-row component for the Library view.
 *
 * Solo's feedback: in 1.6.x the row's most prominent affordance was the
 * Active/Stored toggle switch, which led users to manage mods through this
 * surface rather than through modpacks. T17 reframes the row so the
 * primary read is just: mod name + version + storage chip + membership chip
 * + one kebab. Click the row body to expand an inline drawer that
 * surfaces source pills, audit details, and all per-mod actions. The
 * storage toggle now lives inside the kebab menu so it stays reachable
 * without competing with the row's primary read.
 *
 * The component is intentionally state-thin: it owns nothing but the
 * "Show details" toggle is controlled by the parent (Mods.tsx tracks the
 * expanded set across the whole list). Every mutation runs through a
 * callback prop, so ModRow can be tested in isolation without a Tauri
 * mock.
 */

export interface ModRowProps {
  mod: ModInfo;
  /** Disambiguator label shown beside name when two mods share a display
   *  name. Null when this row has a unique display name. */
  disambiguator: string | null;
  /** Audit entry from getAuditByKey lookup. Undefined when audit hasn't
   *  run for this row. */
  audit: ModAuditEntry | undefined;
  /** Membership in the active modpack. Null when no active modpack OR
   *  this row isn't present in the membership grid yet. */
  membership: 'in' | 'includedOff' | 'notIn' | null;
  /** Active modpack name (used by the inline "Add to / Remove from
   *  <pack>" affordance). Null when no modpack is active — in that
   *  case no membership controls render. */
  activeProfile: string | null;
  /** Toggle this mod's membership in the active modpack. Called when
   *  the user clicks the membership chip or the kebab item. */
  onToggleMembership: () => void;
  /** True when the membership mutation is in flight (per-row spinner). */
  isMembershipSaving: boolean;
  /** Current game running state — used to disable destructive actions. */
  gameRunning: boolean;
  /** Current STS2 game version, drives the min_game_version warning. */
  gameVersion: string | null | undefined;
  /** Whether THIS row's update is in flight (per-row spinner). */
  isUpdating: boolean;
  /** Whether THIS row's repair is in flight. */
  isRepairing: boolean;
  /** Whether THIS row's rollback is in flight. */
  isRollingBack: boolean;
  /** True when ANY row is currently updating (disables this row's
   *  update button to prevent two simultaneous installs). */
  anyUpdating: boolean;
  /** True when ANY row is repairing or rolling back. */
  anyRecoveryInFlight: boolean;
  /** Whether this row's drawer is expanded. Controlled by the parent. */
  expanded: boolean;
  /** Toggle this row's expanded state. */
  onToggleExpand: () => void;
  // Kebab + drawer action callbacks. All mutations run through these so
  // ModRow stays free of Tauri or context wiring.
  onToggleStorage: () => void;
  onTogglePin: () => void;
  onCopyVersion: () => void;
  onOpenModsFolder: () => void;
  onEditSources: () => void;
  onFindGithubFromNexus: () => void;
  onSnooze: () => void;
  onUnsnooze: () => void;
  onRepair: () => void;
  onRollback: () => void;
  onDelete: () => void;
  onUpdate: () => void;
  onOpenExternalUrl: (url: string) => void;
  /** Optional slot for the SourceEditor when "Edit sources" is toggled
   *  open. Rendered inside the drawer below the action buttons. */
  sourceEditorSlot?: ReactNode;
}

function displayNameFor(mod: ModInfo): string {
  return mod.display_name?.trim() || mod.name;
}

function displayDescriptionFor(mod: ModInfo): string {
  return mod.display_description?.trim() || mod.description;
}

/**
 * Numeric semver compare for the small subset we actually see in
 * mod manifests + STS2's release_info.json: "MAJOR.MINOR.PATCH" with
 * an optional leading "v". Returns true when `current >= required`.
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

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export function ModRow(props: ModRowProps) {
  const { t } = useTranslation();
  const {
    mod,
    disambiguator,
    audit,
    membership,
    activeProfile,
    onToggleMembership,
    isMembershipSaving,
    gameRunning,
    gameVersion,
    isUpdating,
    isRepairing,
    isRollingBack,
    anyUpdating,
    anyRecoveryInFlight,
    expanded,
    onToggleExpand,
    onToggleStorage,
    onTogglePin,
    onCopyVersion,
    onOpenModsFolder,
    onEditSources,
    onFindGithubFromNexus,
    onSnooze,
    onUnsnooze,
    onRepair,
    onRollback,
    onDelete,
    onUpdate,
    onOpenExternalUrl,
    sourceEditorSlot,
  } = props;

  const displayName = displayNameFor(mod);
  const displayDescription = displayDescriptionFor(mod);
  const hasLinks = mod.github_url || mod.nexus_url;
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
    && !!mod.github_url;
  const auditError = audit?.error ?? null;
  // Nexus update pill — only meaningful when the audit row carries a
  // resolvable Nexus URL. We don't render the pill here in the row
  // (the spec wants exactly: name + version + chips + kebab) but we
  // expose it inside the drawer's "Update from Nexus" button.
  const showNexusUpdatePill =
    !!audit
    && audit.nexus_update_available
    && !audit.pinned
    && !audit.snoozed
    && !!mod.nexus_url;
  const minGameViolated =
    !!mod.min_game_version && !gameVersionSatisfies(gameVersion, mod.min_game_version);
  const rowClassName = `gf-modrow ${mod.pinned ? 'gf-mod-pinned' : ''}${expanded ? ' gf-modrow-expanded' : ''}`;

  return (
    <div className={rowClassName} data-testid="mod-row">
      {/* Primary read: name + version + chips + ONE kebab. Clicking
          anywhere on the main button toggles the drawer. The kebab is
          rendered outside the main button so its clicks don't bubble
          up and double-toggle. */}
      <div className="gf-modrow-row">
        <button
          type="button"
          className="gf-modrow-main"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? t('mods.row.collapse', { name: displayName })
              : t('mods.row.expand', { name: displayName })
          }
        >
          <div className="gf-modrow-info">
            <div className="gf-modrow-title-row">
              <span className="gf-modrow-name">{displayName}</span>
              {mod.display_name && (
                <span className="gf-modrow-rawname">{mod.name}</span>
              )}
              {disambiguator && (
                <span
                  className="gf-modrow-disambig"
                  title={t('mods.disambiguatorTitle', {
                    name: displayName,
                    identifier: mod.author
                      ? t('mods.disambiguatorAuthor', { author: mod.author })
                      : t('mods.disambiguatorFolder', { folder: mod.folder_name }),
                  })}
                >
                  · {disambiguator}
                </span>
              )}
              <span className="gf-modrow-version">v{mod.version}</span>
            </div>
            <div className="gf-mod-row-chips">
              <Badge
                variant={mod.enabled ? 'ok' : 'github'}
                title={mod.enabled ? undefined : t('modpack.storage.storedHint')}
              >
                {mod.enabled ? t('modpack.storage.active') : t('modpack.storage.stored')}
              </Badge>
              {membership && activeProfile && (
                <button
                  type="button"
                  className="gf-membership-chip"
                  onClick={(e) => {
                    // Don't expand the row when toggling membership.
                    e.stopPropagation();
                    onToggleMembership();
                  }}
                  disabled={isMembershipSaving}
                  title={
                    membership === 'notIn'
                      ? t('mods.membership.addTo', { pack: activeProfile })
                      : t('mods.membership.removeFrom', { pack: activeProfile })
                  }
                >
                  <Badge
                    variant={
                      membership === 'in'
                        ? 'ok'
                        : membership === 'includedOff'
                          ? 'update'
                          : 'github'
                    }
                  >
                    {isMembershipSaving ? (
                      <RefreshCw size={10} className="animate-spin" />
                    ) : null}
                    {t(
                      membership === 'in'
                        ? 'modpack.membership.in'
                        : membership === 'includedOff'
                          ? 'modpack.membership.includedOff'
                          : 'modpack.membership.notIn',
                    )}
                  </Badge>
                </button>
              )}
            </div>
          </div>
        </button>
        <div className="gf-modrow-kebab" onClick={(e) => e.stopPropagation()}>
          <KebabMenu title={t('mods.modActions')}>
            <KebabSection>
              {activeProfile && membership && (
                <KebabItem
                  icon={
                    membership === 'notIn' ? (
                      <ToggleRight size={12} />
                    ) : (
                      <ToggleLeft size={12} />
                    )
                  }
                  onClick={onToggleMembership}
                  disabled={isMembershipSaving}
                  description={
                    membership === 'notIn'
                      ? t('mods.kebab.addToModpackDesc', { pack: activeProfile })
                      : t('mods.kebab.removeFromModpackDesc', { pack: activeProfile })
                  }
                >
                  {membership === 'notIn'
                    ? t('mods.kebab.addToModpack', { pack: activeProfile })
                    : t('mods.kebab.removeFromModpack', { pack: activeProfile })}
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
                disabled={gameRunning || anyRecoveryInFlight || !mod.github_url}
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
                disabled={gameRunning || anyRecoveryInFlight || !mod.github_url}
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
      </div>

      {/* Optional description / note line — render only when present.
          Stays outside the drawer because the description is part of
          the mod's identity (helps users distinguish similar mods at
          a glance). */}
      {(displayDescription || mod.note) && (
        <div className="gf-modrow-meta">
          {displayDescription && (
            <p className="gf-modrow-desc" title={displayDescription}>
              {displayDescription}
            </p>
          )}
          {mod.note && (
            <p
              className="gf-modrow-note"
              title={mod.note}
            >
              {t('mods.notePrefix')} {mod.note}
            </p>
          )}
        </div>
      )}

      {expanded && (
        <div className="gf-modrow-drawer" data-testid="mod-row-drawer">
          {/* Source pills row */}
          <div className="gf-modrow-drawer-sources">
            {mod.github_url ? (
              <a
                href={mod.github_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex"
                title={t('mods.viewOnGitHub', { url: mod.github_url })}
              >
                <Badge variant="github">
                  <GitBranch size={10} className="mr-1" />
                  {t('mods.gitHub')}
                </Badge>
              </a>
            ) : null}
            {mod.nexus_url ? (
              <a
                href={mod.nexus_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex"
                title={t('mods.viewOnNexus', { url: mod.nexus_url })}
              >
                <Badge variant="nexus">{t('mods.nexus')}</Badge>
              </a>
            ) : null}
            {mod.custom_url ? (
              <a
                href={mod.custom_url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex"
                title={t('mods.openLink', { url: mod.custom_url })}
              >
                <Badge variant="default">
                  <ExternalLink size={10} className="mr-1" />
                  {t('mods.link')}
                </Badge>
              </a>
            ) : null}
            {!hasLinks && !mod.custom_url && (
              <Badge variant={getSourceVariant(mod.source)}>
                {mod.source ? t('mods.local') : t('mods.unlinked')}
              </Badge>
            )}
            {mod.tags?.map((tag) => (
              <span key={tag} className="gf-pill gf-mod-tag" title={t('mods.tags.title', { tag })}>
                <Tags size={9} /> {tag}
              </span>
            ))}
            {mod.size_bytes > 0 && (
              <span className="gf-modrow-size">{formatBytes(mod.size_bytes)}</span>
            )}
          </div>

          {/* Audit details strip. Each badge here is informational; the
              actionable update/skip buttons live in the actions row
              below so the user can click them without first reading
              the badge text. */}
          {(audit || mod.pinned || minGameViolated) && (
            <div className="gf-modrow-drawer-audit">
              {audit && isUpToDate(audit) && (
                <span className="gf-pill gf-pill-ok" title={t('mods.latestTitle')}>
                  <Check size={9} /> {t('mods.latest')}
                </span>
              )}
              {mod.pinned && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300"
                  title={t('mods.pinnedTitle')}
                >
                  <Snowflake size={9} /> {t('mods.pinned')}
                </span>
              )}
              {audit?.snoozed && (
                <span
                  className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-300"
                  title={t('mods.snoozedTitle', {
                    version:
                      audit.latest_release_with_assets_tag?.replace(/^v/, '') ?? '?',
                  })}
                >
                  💤 {t('mods.snoozed')}
                </span>
              )}
              {audit?.latest_release_blocked_by_game_version && !audit.pinned && (
                <>
                  <span
                    className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300"
                    title={t('mods.gameVersionBlockedTitle', {
                      target:
                        audit.latest_release_with_assets_tag?.replace(/^v/, '') ?? '?',
                    })}
                  >
                    <AlertTriangle size={9} /> {t('mods.updateBlockedByGameVersion')}
                  </span>
                  <HelpHint helpKey="blockedUpdate" />
                </>
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
                    minVer: mod.min_game_version,
                    yourVer: gameVersion ?? 'unknown',
                  })}
                >
                  ⚠ {t('mods.needsGameVersion', { version: mod.min_game_version })}
                </span>
              )}
            </div>
          )}

          {/* Action buttons. The most important ones first. */}
          <div className="gf-modrow-drawer-actions">
            {showUpdatePill && (
              <Button
                variant="primary"
                size="sm"
                onClick={onUpdate}
                disabled={gameRunning || isUpdating || anyUpdating}
                title={
                  gameRunning
                    ? t('mods.closeSts2FirstDot')
                    : t('mods.updateClickTitle', {
                        current: mod.version,
                        target: compatibleTag?.replace(/^v/, ''),
                      })
                }
              >
                {isUpdating ? (
                  <>
                    <RefreshCw size={11} className="animate-spin" />
                    {t('mods.updating')}
                  </>
                ) : (
                  <>
                    <Download size={11} />
                    {t('mods.updateAvailable', {
                      version: compatibleTag?.replace(/^v/, ''),
                    })}
                  </>
                )}
              </Button>
            )}
            {showNexusUpdatePill && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => onOpenExternalUrl(mod.nexus_url!)}
                title={t('mods.nexusUpdateTitle', {
                  nexusVer: audit!.nexus_version ?? '?',
                  localVer: mod.version,
                })}
              >
                <Download size={11} /> {t('mods.downloadFromNexus')}
              </Button>
            )}
            <Button variant="secondary" size="sm" onClick={onOpenModsFolder}>
              <FolderOpen size={11} /> {t('mods.row.openFolder')}
            </Button>
            <Button variant="secondary" size="sm" onClick={onEditSources}>
              <LinkIcon size={11} /> {t('mods.row.editSources')}
            </Button>
            {mod.nexus_url && !mod.github_url && (
              <Button
                variant="secondary"
                size="sm"
                onClick={onFindGithubFromNexus}
              >
                <GitBranch size={11} /> {t('mods.row.findGithub')}
              </Button>
            )}
            {audit?.needs_update && !!audit.latest_release_with_assets_tag && !audit.snoozed && (
              <Button variant="ghost" size="sm" onClick={onSnooze}>
                <Clock size={11} /> {t('mods.kebab.skipUpdate')}
              </Button>
            )}
            {audit?.snoozed && (
              <Button variant="ghost" size="sm" onClick={onUnsnooze}>
                <Check size={11} /> {t('mods.kebab.unsnooze')}
              </Button>
            )}
          </div>

          {/* SourceEditor slot — Mods.tsx renders the editor here when
              the user opens it from the kebab or the drawer button.
              Keeping the editor in the drawer means the user stays
              anchored to this row while making changes. */}
          {sourceEditorSlot}
        </div>
      )}
    </div>
  );
}
