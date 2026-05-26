/**
 * ModpackDetail — inline detail view for a single modpack.
 *
 * Replaces the page's list area when the user clicks a modpack card
 * (T16 / 1.7.0). The detail view emulates the Paradox launcher pattern:
 * one focused page per modpack, with the mod editor (LibraryTable) as
 * the body and power-user actions tucked under an Advanced disclosure.
 *
 * Layout (top to bottom):
 *   - Header: Back button + modpack name + Active/Switch + Share.
 *   - Audit summary: compact chip row showing updates / missing-source
 *     / blocked counts. Auto-hidden when all zero.
 *   - Body: <LibraryTable> for this modpack.
 *   - Advanced (collapsible): Delete, Duplicate, Export JSON, Snapshot,
 *     Load Order, Repair drift. Sits at the bottom so casual users
 *     never accidentally trip the destructive actions.
 *
 * State is owned by the parent (ProfilesView). The detail view is a
 * controlled component — every action calls a handler prop, so the
 * parent stays the source of truth for the profile list, drift map,
 * share map, etc. The only local state is owned by AdvancedSection,
 * which persists its open/closed flag to localStorage so users who
 * open the disclosure once don't have to re-open it every session.
 */
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Camera,
  Copy,
  Download,
  Files,
  ListOrdered,
  Play,
  RefreshCw,
  Share2,
  Trash2,
} from 'lucide-react';
import { AdvancedSection } from './AdvancedSection';
import { Badge } from './Badge';
import { Button } from './Button';
import { HelpHint } from './HelpHint';
import { LibraryTable } from './LibraryTable';
import { useApp } from '../contexts/AppContext';
import type { ModAuditEntry, Profile, ShareResult } from '../types';
import type { ProfileDrift } from '../hooks/useTauri';

export interface ModpackDetailProps {
  /** The modpack to render. Comes from the profile list in
   *  ProfilesView so it stays in sync with the latest manifest. */
  profile: Profile;
  /** Returns to the list view. */
  onBack: () => void;
  /** Activate this modpack — applies its mods to the game folder. */
  onSwitch?: (name: string) => void;
  /** Open PublishModal (share / re-share flow). */
  onShare?: (profile: Profile) => void;
  onDelete?: (name: string) => void;
  onDuplicate?: (name: string) => void;
  onExportJson?: (name: string) => void;
  onSnapshot?: (name: string) => void;
  onOpenLoadOrder?: (profile: Profile) => void;
  onRepairDrift?: (name: string) => void;
  /** Optional snapshot of the active "switching..." state so the
   *  Switch button can show a spinner without us reaching into the
   *  parent's state shape. */
  switchingProfile?: string | null;
  shareInfo?: ShareResult | null;
  drift?: ProfileDrift | null;
  /** Refreshes the underlying profile list after a LibraryTable
   *  mutation so the parent's drift / share metadata stays current. */
  onLibraryChanged?: () => void;
}

function countAuditUpdates(
  audit: ModAuditEntry[] | null,
  modNames: Set<string>,
): number {
  if (!audit) return 0;
  return audit.filter(
    (entry) =>
      entry.needs_update
      && !entry.snoozed
      && modNames.has(entry.mod_name),
  ).length;
}

function countMissingSource(profile: Profile): number {
  return profile.mods.filter(
    (mod) => mod.source === null && mod.bundle_url === null,
  ).length;
}

function countBlockedByGameVersion(
  audit: ModAuditEntry[] | null,
  modNames: Set<string>,
): number {
  if (!audit) return 0;
  return audit.filter(
    (entry) =>
      modNames.has(entry.mod_name)
      && (entry.game_version_too_old
        || entry.latest_release_blocked_by_game_version),
  ).length;
}

export function ModpackDetail({
  profile,
  onBack,
  onSwitch,
  onShare,
  onDelete,
  onDuplicate,
  onExportJson,
  onSnapshot,
  onOpenLoadOrder,
  onRepairDrift,
  switchingProfile,
  shareInfo,
  drift,
  onLibraryChanged,
}: ModpackDetailProps) {
  const { t } = useTranslation();
  const { activeProfile, auditResults } = useApp();

  const isActive = activeProfile === profile.name;
  const isShared = !!shareInfo;
  const hasDrift = !!drift?.has_drift;
  const switchingThis = switchingProfile === profile.name;
  const switchingOther = !!switchingProfile && switchingProfile !== profile.name;

  // Build a set of mod-display-names that belong to this pack — the
  // audit summary is filtered to just these mods so users see counts
  // scoped to the detail view.
  const modNames = new Set(profile.mods.map((m) => m.name));
  const updatesCount = countAuditUpdates(auditResults, modNames);
  const missingSourceCount = countMissingSource(profile);
  const blockedCount = countBlockedByGameVersion(auditResults, modNames);
  const hasAuditChips
    = updatesCount > 0 || missingSourceCount > 0 || blockedCount > 0;

  return (
    <div className="gf-modpack-detail" data-testid="modpack-detail">
      <div className="gf-modpack-detail-head">
        <Button
          variant="ghost"
          size="sm"
          onClick={onBack}
          aria-label={t('modpack.backToList')}
          className="gf-modpack-detail-back"
        >
          <ArrowLeft size={16} />
          {t('modpack.backToList')}
        </Button>
        <div className="gf-modpack-detail-title-row">
          <h2 className="gf-modpack-detail-title">{profile.name}</h2>
          {isActive && (
            <Badge variant="ok" ariaHidden>
              {t('profiles.card.active')}
            </Badge>
          )}
          {isShared && (
            <Badge variant="github" ariaHidden>
              {t('modpack.shared')}
            </Badge>
          )}
        </div>
        <div className="gf-modpack-detail-head-actions">
          {!isActive && onSwitch && (
            <Button
              variant="primary"
              size="sm"
              onClick={() => onSwitch(profile.name)}
              disabled={switchingOther}
              title={t('profiles.card.activateProfile')}
            >
              {switchingThis ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : (
                <>
                  <Play size={14} fill="currentColor" />
                  {t('profiles.card.switchTo')}
                </>
              )}
            </Button>
          )}
          {onShare && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onShare(profile)}
              title={
                isShared
                  ? t('profiles.card.reShareTitle')
                  : t('profiles.card.shareTitle')
              }
            >
              <Share2 size={14} />
              {isShared
                ? t('profiles.card.reShare')
                : t('profiles.card.share')}
            </Button>
          )}
        </div>
      </div>

      {hasAuditChips && (
        <div
          className="gf-modpack-detail-audit"
          data-testid="modpack-detail-audit"
        >
          {updatesCount > 0 && (
            <span
              className="gf-chip gf-chip-update"
              data-testid="audit-chip-updates"
            >
              {t('modpack.auditSummary.updates', { count: updatesCount })}
            </span>
          )}
          {missingSourceCount > 0 && (
            <span
              className="gf-chip gf-chip-warn"
              data-testid="audit-chip-missing"
            >
              {t('modpack.auditSummary.missing', { count: missingSourceCount })}
            </span>
          )}
          {blockedCount > 0 && (
            <span
              className="gf-chip gf-chip-danger"
              data-testid="audit-chip-blocked"
            >
              {t('modpack.auditSummary.blocked', { count: blockedCount })}
            </span>
          )}
        </div>
      )}

      <div className="gf-modpack-detail-body">
        <h3 className="gf-modpack-detail-library-heading">
          {t('modpack.libraryHeading')}
          <HelpHint helpKey="modpackWhat" />
        </h3>
        <LibraryTable
          modpackName={profile.name}
          onMembershipChanged={onLibraryChanged}
          onLoadOrderChanged={onLibraryChanged}
        />
      </div>

      <AdvancedSection
        localStorageKey="modpack-detail-advanced"
        title={t('modpack.advanced')}
      >
        <div
          id="modpack-detail-advanced-panel"
          className="gf-modpack-detail-advanced-panel"
          data-testid="modpack-detail-advanced-panel"
        >
          {onOpenLoadOrder && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onOpenLoadOrder(profile)}
              disabled={profile.mods.length === 0}
              title={t('profiles.loadOrder.buttonTitle', {
                name: profile.name,
              })}
            >
              <ListOrdered size={14} />
              {t('profiles.loadOrder.button')}
            </Button>
          )}
          {onSnapshot && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onSnapshot(profile.name)}
            >
              <Camera size={14} />
              {t('profiles.kebab.snapshotFromCurrent')}
            </Button>
          )}
          {onDuplicate && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onDuplicate(profile.name)}
            >
              <Files size={14} />
              {t('profiles.kebab.duplicate')}
            </Button>
          )}
          {onExportJson && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onExportJson(profile.name)}
            >
              <Copy size={14} />
              {t('profiles.kebab.exportJson')}
            </Button>
          )}
          {onRepairDrift && hasDrift && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onRepairDrift(profile.name)}
            >
              <Download size={14} />
              {t('profiles.drift.repair')}
            </Button>
          )}
          {onDelete && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => onDelete(profile.name)}
            >
              <Trash2 size={14} />
              {t('profiles.kebab.deleteProfile')}
            </Button>
          )}
        </div>
      </AdvancedSection>
    </div>
  );
}
