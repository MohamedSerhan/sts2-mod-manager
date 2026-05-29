/**
 * ModpackDetail — inline detail view for a single modpack.
 *
 * Replaces the page's list area when the user clicks a modpack card
 * (T16 / 1.7.0). The detail view emulates the Paradox launcher pattern:
 * one focused page per modpack.
 *
 * Layout (top to bottom):
 *   - Header: Back button + modpack name + Active/Switch + Share.
 *   - Audit summary: compact chip row showing updates / missing-source
 *     / blocked counts. Auto-hidden when all zero.
 *   - Search box: filters BOTH sections by name/folder/version.
 *   - Section 1 "In this modpack": the pack's mods (profile.mods), in
 *     load order, each with a low-key Remove. Reordering happens in the
 *     Load Order modal (button in the section header) — there is NO
 *     inline drag affordance, because the user can't drag here.
 *   - Section 2 "Add from your library": installed mods not yet in the
 *     pack, each with a low-key "+ Add".
 *   - Advanced: a clearly-divided section (heading + divider) holding the
 *     power-user / destructive actions (Snapshot, Duplicate, Export,
 *     Repair, Delete). No longer buried in a collapsible.
 *
 * State is owned by the parent (ProfilesView). The detail view is a
 * controlled component for the profile-level actions — every action
 * calls a handler prop. The Add/Remove membership mutations are run
 * locally (they touch the membership API + optionally toggle_mod when
 * this is the active pack) and then bubble up via onLibraryChanged +
 * refreshAll so the parent's profile list / drift / share metadata and
 * the local `mods` array stay current.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Camera,
  ChevronDown,
  Copy,
  Download,
  Files,
  ListOrdered,
  Play,
  Plus,
  RefreshCw,
  Share2,
  Trash2,
} from 'lucide-react';
import { Badge } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { HelpHint } from './HelpHint';
import { KebabDivider, KebabItem, KebabMenu, KebabSection } from './KebabMenu';
import { LibraryTable } from './LibraryTable';
import { ModLibraryToolbar } from './ModLibraryToolbar';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useModLibrary } from '../hooks/useModLibrary';
import { setProfileModMembership, toggleMod } from '../hooks/useTauri';
import type { ModAuditEntry, ModInfo, Profile, ShareResult } from '../types';
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
  /** Refreshes the underlying profile list after a membership
   *  mutation so the parent's drift / share metadata stays current. */
  onLibraryChanged?: () => void;
}

/** Identity key for a profile mod / installed mod: prefer the on-disk
 *  folder name, fall back to the manifest name. Matches the convention
 *  used across the membership grid. */
function modKey(mod: { folder_name: string | null; name: string }): string {
  return mod.folder_name ?? mod.name;
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

/** Source badges for a row, derived from the matching installed
 *  ModInfo (GitHub / Nexus / local). Pure presentation — no links, just
 *  the at-a-glance source pills used elsewhere in the app. */
function SourceBadges({ mod }: { mod: ModInfo | undefined }) {
  const { t } = useTranslation();
  if (!mod) return null;
  const hasGithub = !!mod.github_url;
  const hasNexus = !!mod.nexus_url;
  if (!hasGithub && !hasNexus) {
    if (!mod.source) return null;
    return <Badge variant="local">{t('mods.local')}</Badge>;
  }
  return (
    <>
      {hasGithub && <Badge variant="github">{t('mods.gitHub')}</Badge>}
      {hasNexus && <Badge variant="nexus">{t('mods.nexus')}</Badge>}
    </>
  );
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
  const { activeProfile, auditResults, mods, refreshAll } = useApp();
  const toast = useToast();
  // Shared mod-library surface (toolbar + install actions), scoped so a
  // mod installed from here auto-joins THIS pack. The same hook powers the
  // All Mods view, so the add affordances are identical.
  const lib = useModLibrary({ targetPack: profile.name });
  // "Add from your Library" is collapsed by default to keep the focus on
  // the pack's own mods; the user expands it to browse the rest.
  const [libraryOpen, setLibraryOpen] = useState(false);

  const isActive = activeProfile === profile.name;
  const isShared = !!shareInfo;
  const hasDrift = !!drift?.has_drift;
  const switchingThis = switchingProfile === profile.name;
  const switchingOther = !!switchingProfile && switchingProfile !== profile.name;

  // Per-row in-flight keys so a double-click can't double-fire the
  // membership add. Keyed by modKey().
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  // Search for the "Add from your Library" section only — the in-pack
  // LibraryTable owns its own search (same as the All Mods view).
  const [availableQuery, setAvailableQuery] = useState('');

  // Build a set of mod-display-names that belong to this pack — the
  // audit summary is filtered to just these mods so users see counts
  // scoped to the detail view.
  const modNames = useMemo(
    () => new Set(profile.mods.map((m) => m.name)),
    [profile.mods],
  );
  const updatesCount = countAuditUpdates(auditResults, modNames);
  const missingSourceCount = countMissingSource(profile);
  const blockedCount = countBlockedByGameVersion(auditResults, modNames);
  const hasAuditChips
    = updatesCount > 0 || missingSourceCount > 0 || blockedCount > 0;

  // The pack's mods, in load order. (profile.mods is the manifest order.)
  const inPackKeys = useMemo(
    () => new Set(profile.mods.map((m) => modKey(m))),
    [profile.mods],
  );

  // Available = installed mods NOT already in the pack.
  const availableMods = useMemo(
    () => mods.filter((m) => !inPackKeys.has(modKey(m))),
    [mods, inPackKeys],
  );

  // Order-sensitive membership signature. Feeds LibraryTable's reloadToken
  // so the in-pack rows re-fetch when this pack's membership OR load order
  // changes from outside the table (Add-from-library, the Load order modal,
  // a drift save) — keeping the rich rows in sync with the manifest.
  const membershipSignature = useMemo(
    () => profile.mods.map((m) => modKey(m)).join('>'),
    [profile.mods],
  );

  // Available section filter (its own search box).
  const filteredAvailable = useMemo(() => {
    const q = availableQuery.trim().toLowerCase();
    if (!q) return availableMods;
    return availableMods.filter((m) => {
      const name = (m.display_name?.trim() || m.name).toLowerCase();
      return (
        name.includes(q)
        || (m.folder_name?.toLowerCase().includes(q) ?? false)
        || m.version.toLowerCase().includes(q)
      );
    });
  }, [availableMods, availableQuery]);

  const refreshAfterMutation = async () => {
    await refreshAll();
    onLibraryChanged?.();
  };

  const setBusy = (key: string, busy: boolean) => {
    setBusyKeys((prev) => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });
  };

  const handleAdd = async (mod: ModInfo) => {
    const key = modKey(mod);
    if (busyKeys.has(key)) return;
    setBusy(key, true);
    try {
      await setProfileModMembership(
        profile.name,
        mod.name,
        mod.folder_name ?? null,
        mod.mod_id ?? null,
        true,
      );
      // Membership alone doesn't move files — when this is the active
      // pack, also flip the mod ON in the game folder so the change
      // takes effect immediately.
      if (isActive) {
        await toggleMod(mod.name, mod.folder_name ?? null, true);
      }
      await refreshAfterMutation();
      toast.success(
        t('modpack.detail.added', {
          mod: mod.display_name?.trim() || mod.name,
          pack: profile.name,
        }),
      );
    } catch (e) {
      toast.error(
        t('modpack.detail.addFailed', {
          mod: mod.display_name?.trim() || mod.name,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBusy(key, false);
    }
  };

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
          {/* Advanced / power-user actions live in a header kebab so
              they're always reachable at the top instead of buried under
              a long mod list. Destructive Delete is grouped below a
              divider with danger styling. */}
          {(onSnapshot || onDuplicate || onExportJson || (onRepairDrift && hasDrift) || onDelete) && (
            <KebabMenu title={t('modpack.advancedActions')} size="sm">
              <KebabSection head={t('modpack.advanced')}>
                {onSnapshot && (
                  <KebabItem icon={<Camera size={12} />} onClick={() => onSnapshot(profile.name)}>
                    {t('profiles.kebab.snapshotFromCurrent')}
                  </KebabItem>
                )}
                {onDuplicate && (
                  <KebabItem icon={<Files size={12} />} onClick={() => onDuplicate(profile.name)}>
                    {t('profiles.kebab.duplicate')}
                  </KebabItem>
                )}
                {onExportJson && (
                  <KebabItem icon={<Copy size={12} />} onClick={() => onExportJson(profile.name)}>
                    {t('profiles.kebab.exportJson')}
                  </KebabItem>
                )}
                {onRepairDrift && hasDrift && (
                  <KebabItem icon={<Download size={12} />} onClick={() => onRepairDrift(profile.name)}>
                    {t('profiles.drift.repair')}
                  </KebabItem>
                )}
              </KebabSection>
              {onDelete && (
                <>
                  <KebabDivider />
                  <KebabItem
                    danger
                    icon={<Trash2 size={12} />}
                    onClick={() => onDelete(profile.name)}
                  >
                    {t('profiles.kebab.deleteProfile')}
                  </KebabItem>
                </>
              )}
            </KebabMenu>
          )}
        </div>
      </div>

      {/* Shared mod-library toolbar — same affordances as the All Mods
          view (Open folder / Import / Quick add URL / Auto-detect / Audit /
          Refresh). Installs from here auto-join this pack (targetPack). */}
      <div className="gf-modpack-detail-toolbar">
        <ModLibraryToolbar lib={lib} />
      </div>
      {lib.renderQuickAddForm()}

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

      {/* ── Section 1: mods in this pack ─────────────────────────── */}
      <section
        className="gf-modpack-detail-section"
        data-testid="modpack-detail-in-pack"
      >
        <div className="gf-modpack-detail-section-head">
          <h3 className="gf-modpack-detail-section-title">
            {t('modpack.detail.inPackCount', { count: profile.mods.length })}
            <HelpHint helpKey="modpackWhat" />
          </h3>
          {onOpenLoadOrder && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onOpenLoadOrder(profile)}
              disabled={profile.mods.length === 0}
              title={t('profiles.loadOrder.buttonTitle', { name: profile.name })}
            >
              <ListOrdered size={14} />
              {t('profiles.loadOrder.button')}
            </Button>
          )}
        </div>

        {profile.mods.length > 1 && (
          <p className="gf-modpack-detail-section-note">
            {t('modpack.detail.inPackOrderNote')}
          </p>
        )}

        {profile.mods.length === 0 ? (
          <p className="gf-modpack-detail-empty">
            {t('modpack.detail.emptyInPack')}
          </p>
        ) : (
          // The pack's mods render with the SAME rich rows as the All Mods
          // view (toggle / source badges / kebab / delete / inline source
          // editor), filtered to just this pack's members and drag-
          // reorderable. coupleActiveStorage makes removing a mod from the
          // active pack also unload it from the game. reloadToken re-syncs
          // the rows when membership changes from outside the table.
          <LibraryTable
            modpackName={profile.name}
            enableReorder
            coupleActiveStorage
            reloadToken={membershipSignature}
            filterRow={(row) =>
              !!row.profiles.find((p) => p.profile_name === profile.name)?.included
            }
            onMembershipChanged={refreshAfterMutation}
            onLoadOrderChanged={refreshAfterMutation}
            {...lib.tableActionProps}
          />
        )}
      </section>

      {/* ── Section 2: add from your library (collapsed by default) ── */}
      {availableMods.length > 0 && (
        <section
          className="gf-modpack-detail-section"
          data-testid="modpack-detail-available"
        >
          {/* Prominent expander so it's obvious there's more to add
              without cluttering the view with every installed mod. */}
          <button
            type="button"
            className="gf-modpack-detail-library-toggle"
            onClick={() => setLibraryOpen((o) => !o)}
            aria-expanded={libraryOpen}
            aria-controls="gf-modpack-detail-library-rows"
          >
            <ChevronDown
              size={16}
              className={`gf-modpack-detail-library-chevron ${libraryOpen ? 'is-open' : ''}`}
              aria-hidden
            />
            <span className="gf-modpack-detail-section-title">
              {t('modpack.detail.availableCount', { count: availableMods.length })}
            </span>
            <span className="gf-modpack-detail-library-hint">
              {libraryOpen ? t('modpack.detail.libraryHide') : t('modpack.detail.libraryShow')}
            </span>
          </button>
          {libraryOpen && (
            <div
              className="gf-modpack-detail-rows"
              id="gf-modpack-detail-library-rows"
            >
              <div className="gf-modpack-detail-search">
                <input
                  type="search"
                  className="gf-input"
                  value={availableQuery}
                  onChange={(e) => setAvailableQuery(e.target.value)}
                  placeholder={t('modpack.detail.search')}
                  aria-label={t('modpack.detail.search')}
                />
              </div>
              {filteredAvailable.length === 0 && (
                <p className="gf-modpack-detail-empty">
                  {t('modpack.detail.availableNoMatch')}
                </p>
              )}
              {filteredAvailable.map((mod) => {
                const key = modKey(mod);
                const busy = busyKeys.has(key);
                return (
                  <Card
                    key={key}
                    className="gf-modpack-mod-row"
                    data-testid="modpack-mod-row-available"
                  >
                    <div className="gf-modpack-mod-row-info">
                      <span className="gf-modpack-mod-row-name">
                        {mod.display_name?.trim() || mod.name}
                      </span>
                      <span className="gf-modpack-mod-row-meta">
                        <span>{mod.version}</span>
                        <SourceBadges mod={mod} />
                      </span>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      className="gf-modpack-mod-row-add"
                      onClick={() => handleAdd(mod)}
                      disabled={busy}
                      aria-label={t('modpack.detail.add')}
                    >
                      {busy ? (
                        <RefreshCw size={13} className="animate-spin" />
                      ) : (
                        <Plus size={13} />
                      )}
                      {t('modpack.detail.add')}
                    </Button>
                  </Card>
                );
              })}
            </div>
          )}
        </section>
      )}

      {availableMods.length === 0 && profile.mods.length > 0 && (
        <p className="gf-modpack-detail-empty" data-testid="modpack-detail-all-in-pack">
          {t('modpack.detail.allInPack')}
        </p>
      )}

      {/* Auto-detect sources modal (shared). */}
      {lib.renderAutoDetectModal()}
    </div>
  );
}
