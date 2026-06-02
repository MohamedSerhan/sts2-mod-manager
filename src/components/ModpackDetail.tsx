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
  Ban,
  Camera,
  Check,
  ChevronDown,
  ClipboardCheck,
  Copy,
  Download,
  Files,
  ListOrdered,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Share2,
  Trash2,
} from 'lucide-react';
import { Badge } from './Badge';
import { Button } from './Button';
import { Card } from './Card';
import { HelpHint } from './HelpHint';
import { KebabDivider, KebabItem, KebabMenu, KebabSection } from './KebabMenu';
import { EditModpackModal } from './EditModpackModal';
import { AddModsMenu } from './AddModsMenu';
import { LibraryTable } from './LibraryTable';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from './ConfirmDialog';
import { useModLibrary } from '../hooks/useModLibrary';
import { usePinScroll } from '../hooks/usePinScroll';
import { deleteMod, setProfileModMembership, toggleMod } from '../hooks/useTauri';
import type { ModInfo, Profile, ShareResult } from '../types';
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
  const { activeProfile, auditResults, mods, refreshAll, gameRunning } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  // Shared mod-library surface (toolbar + install actions), scoped so a
  // mod installed from here auto-joins THIS pack, and the Audit action
  // checks only this pack's mods. The same hook powers the All Mods view.
  const lib = useModLibrary({
    targetPack: profile.name,
    auditScope: () => profile.mods.map((m) => m.name),
  });
  // Scroll-pin safety net (shared with LibraryTable via usePinScroll). The
  // Add-from-library and enable/disable-all actions shrink/refresh the list;
  // pinning keeps the user where they were instead of collapsing to the top.
  const { ref: rootRef, pinScroll } = usePinScroll<HTMLDivElement>();
  // "Add from your Library" is collapsed by default to keep the focus on
  // the pack's own mods; the user expands it to browse the rest.
  const [libraryOpen, setLibraryOpen] = useState(false);
  // Bulk-edit membership via the wizard's checkbox picker.
  const [editing, setEditing] = useState(false);

  const isActive = activeProfile === profile.name;
  const isShared = !!shareInfo;
  const hasDrift = !!drift?.has_drift;
  // Bug 5: the header count is manifest membership (profile.mods.length) while
  // the list shows mods actually on disk. Drift's `removed` set is exactly the
  // manifest entries with no installed mod, so surfacing its size as
  // "(N missing)" makes the header agree with the scan instead of silently
  // over-counting. (Empty folders are deliberately not scanned as mods, so we
  // never go the other way.)
  const missingCount = drift?.removed?.length ?? 0;
  const switchingThis = switchingProfile === profile.name;
  const switchingOther = !!switchingProfile && switchingProfile !== profile.name;

  // Per-row in-flight keys so a double-click can't double-fire the
  // membership add. Keyed by modKey().
  const [busyKeys, setBusyKeys] = useState<Set<string>>(new Set());
  // Search for the "Add from your Library" section only — the in-pack
  // LibraryTable owns its own search (same as the All Mods view).
  const [availableQuery, setAvailableQuery] = useState('');

  // Build a set of mod-names that belong to this pack so the updates
  // affordance is scoped to the pack's own mods.
  const modNames = useMemo(
    () => new Set(profile.mods.map((m) => m.name)),
    [profile.mods],
  );
  // How many of THIS pack's mods are currently active (enabled) in the game.
  // The status line is scoped to the pack — it must not report the whole
  // library. Matched against the live on-disk state so it agrees with the
  // active/stored toggles shown in the row list.
  const activeInPack = useMemo(() => {
    const key = (m: { folder_name?: string | null; mod_id?: string | null; name: string }) =>
      m.folder_name ?? m.mod_id ?? m.name;
    const enabled = new Set(mods.filter((m) => m.enabled).map(key));
    return profile.mods.filter((pm) => enabled.has(key(pm))).length;
  }, [mods, profile.mods]);
  // GitHub-updatable mods in THIS pack (drives the "N updates available"
  // pill + the update-all action).
  const packUpdateNames = useMemo(
    () =>
      (auditResults ?? [])
        .filter(
          (r) =>
            r.needs_update
            && !r.snoozed
            && r.github_repo
            && r.latest_release_with_assets_tag
            && modNames.has(r.mod_name),
        )
        .map((r) => r.mod_name),
    [auditResults, modNames],
  );
  const updatesCount = packUpdateNames.length;

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
    // Bug 2: the available list shrinks when this mod joins the pack and the
    // refresh re-renders both sections — pin the scroll so the page doesn't
    // collapse upward and lose the user's place.
    pinScroll();
    setBusy(key, true);
    try {
      // Flip the mod ON in the game folder FIRST when this is the active
      // pack: toggle_mod guards on the game running (and can fail the move)
      // while the membership write doesn't. Doing the guarded step first keeps
      // disk and manifest in sync instead of recording a membership the live
      // mods/ folder never received.
      if (isActive) {
        await toggleMod(mod.name, mod.folder_name ?? null, true);
      }
      await setProfileModMembership(
        profile.name,
        mod.name,
        mod.folder_name ?? null,
        mod.mod_id ?? null,
        true,
      );
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

  // Delete-all scoped to THIS pack: deletes only the pack's mods from disk
  // (not the whole install, unlike the All Mods "Delete all"). Typed-phrase
  // confirm, mirroring the All Mods destructive guard.
  const [deletingAll, setDeletingAll] = useState(false);
  const handleDeleteAllInPack = async () => {
    if (profile.mods.length === 0 || deletingAll) return;
    const ok = await confirm({
      title: t('modpack.detail.deleteAllTitle', { count: profile.mods.length, name: profile.name }),
      body: t('modpack.detail.deleteAllBody'),
      warning: t('modpack.detail.deleteAllWarning'),
      confirmLabel: t('modpack.detail.deleteAllConfirm'),
      destructive: true,
      typedPhrase: 'delete all',
    });
    if (!ok) return;
    setDeletingAll(true);
    try {
      // Snapshot the list first — refreshing mid-loop would mutate it.
      const targets = profile.mods.map((m) => ({ name: m.name, folder_name: m.folder_name ?? null }));
      for (const m of targets) {
        await deleteMod(m.name, m.folder_name);
      }
      await refreshAfterMutation();
      toast.success(
        t('modpack.detail.deleteAllDone', { count: targets.length, name: profile.name }),
      );
    } catch (e) {
      toast.error(
        t('modpack.detail.deleteAllFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setDeletingAll(false);
    }
  };

  // Bug 7: enable/disable EVERY mod in THIS pack (vs. the whole library).
  // Iterates the pack's mods and toggles each on disk, reusing pinScroll so
  // the list doesn't collapse upward (Bug 2) as rows re-render.
  const [bulkToggling, setBulkToggling] = useState(false);
  const handleToggleAllInPack = async (enabled: boolean) => {
    if (bulkToggling || gameRunning || profile.mods.length === 0) return;
    pinScroll();
    setBulkToggling(true);
    try {
      for (const pm of profile.mods) {
        await toggleMod(pm.name, pm.folder_name ?? null, enabled);
      }
      await refreshAfterMutation();
      toast.success(
        enabled
          ? t('modpack.detail.enabledAllInPack', { pack: profile.name })
          : t('modpack.detail.disabledAllInPack', { pack: profile.name }),
      );
    } catch (e) {
      toast.error(
        t('modpack.detail.toggleAllFailed', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    } finally {
      setBulkToggling(false);
    }
  };

  // "+ Add mods ▾" dropdown + Edit + Load order — these share the search
  // row inside the LibraryTable (via its toolbarActions slot). All install
  // methods are consolidated into the one dropdown to keep the row calm.
  const packToolbarActions = (
    <>
      <AddModsMenu lib={lib} />
      <Button
        variant="secondary"
        size="sm"
        onClick={() => setEditing(true)}
        title={t('modpack.detail.editModsTitle')}
      >
        <Pencil size={14} />
        {t('modpack.detail.editMods')}
      </Button>
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
    </>
  );

  // Updates affordance shown beside the section title. Mirrors the audit
  // button's states but scoped to this pack: not-yet-checked → "Check for
  // updates"; checked-with-updates → "N updates available" (updates all);
  // checked-current → quiet "Up to date".
  const updatesControl = lib.auditing ? (
    <span className="gf-pill gf-pill-ok gf-pill-toolbar">
      <RefreshCw size={12} className="animate-spin" /> {t('mods.audit.running')}
    </span>
  ) : lib.updatingAll ? (
    <span className="gf-pill gf-pill-update gf-pill-toolbar">
      <RefreshCw size={12} className="animate-spin" /> {t('mods.updatingCount', { count: updatesCount })}
    </span>
  ) : auditResults === null ? (
    <button
      type="button"
      className="gf-pill gf-pill-update gf-pill-toolbar"
      onClick={lib.handleCheckUpdates}
      title={t('mods.checkForUpdates')}
    >
      <ClipboardCheck size={12} /> {t('modpack.detail.checkUpdates')}
    </button>
  ) : updatesCount > 0 ? (
    <button
      type="button"
      className="gf-pill gf-pill-update gf-pill-toolbar"
      onClick={() => lib.updateAllGithub(packUpdateNames)}
      title={t('mods.updateAllTitle')}
    >
      <Download size={12} /> {t('modpack.detail.updatesAvailable', { count: updatesCount })}
    </button>
  ) : (
    <button
      type="button"
      className="gf-pill gf-pill-ok gf-pill-toolbar"
      onClick={lib.handleCheckUpdates}
      title={t('mods.reaudit')}
    >
      <Check size={12} /> {t('mods.audit.upToDate')}
    </button>
  );

  return (
    <div className="gf-modpack-detail" data-testid="modpack-detail" ref={rootRef}>
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
          {/* Advanced / power-user actions live in a header kebab so the
              toolbar below stays focused on the common add/edit actions.
              Destructive items sit below a divider with danger styling. */}
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
              {/* Repair is always offered for the ACTIVE modpack (not only when
                  drift is auto-detected) so a user who messed up their install
                  has an on-demand "reset to the saved version" action. It also
                  shows for any pack with detected drift. */}
              {onRepairDrift && (isActive || hasDrift) && (
                <KebabItem
                  icon={<Download size={12} />}
                  onClick={() => onRepairDrift(profile.name)}
                  description={t('modpack.detail.repairHint')}
                >
                  {t('modpack.detail.repair')}
                </KebabItem>
              )}
              <KebabItem icon={<Search size={12} />} onClick={() => lib.setShowAutoDetect(true)}>
                {t('mods.autoDetectSources')}
              </KebabItem>
              <KebabItem
                icon={<RefreshCw size={12} className={lib.refreshing ? 'animate-spin' : undefined} />}
                onClick={lib.handleRefresh}
                disabled={lib.refreshing}
              >
                {t('common.refresh')}
              </KebabItem>
              {profile.mods.length > 0 && (
                <>
                  <KebabItem
                    icon={<Check size={12} />}
                    onClick={() => handleToggleAllInPack(true)}
                    disabled={gameRunning || bulkToggling}
                    description={gameRunning ? t('mods.closeSts2First') : undefined}
                  >
                    {t('mods.enableAll')}
                  </KebabItem>
                  <KebabItem
                    icon={<Ban size={12} />}
                    onClick={() => handleToggleAllInPack(false)}
                    disabled={gameRunning || bulkToggling}
                    description={gameRunning ? t('mods.closeSts2First') : undefined}
                  >
                    {t('mods.disableAll')}
                  </KebabItem>
                </>
              )}
            </KebabSection>
            {(profile.mods.length > 0 || onDelete) && (
              <>
                <KebabDivider />
                {profile.mods.length > 0 && (
                  <KebabItem
                    danger
                    icon={<Trash2 size={12} />}
                    onClick={handleDeleteAllInPack}
                    disabled={gameRunning || deletingAll}
                    description={t('modpack.detail.deleteAllTitleShort')}
                  >
                    {t('modpack.detail.deleteAll')}
                  </KebabItem>
                )}
                {onDelete && (
                  <KebabItem
                    danger
                    icon={<Trash2 size={12} />}
                    onClick={() => onDelete(profile.name)}
                  >
                    {t('profiles.kebab.deleteProfile')}
                  </KebabItem>
                )}
              </>
            )}
          </KebabMenu>
        </div>
      </div>

      {/* Status line — a quick read of what's loaded + game state. */}
      <div className="gf-modpack-detail-status">
        {t('modpack.detail.statusCounts', { active: activeInPack, total: profile.mods.length })}
        {isActive && gameRunning && (
          <>
            {' · '}
            <span className="gf-modpack-detail-running">{t('modpack.detail.runningNow')}</span>
          </>
        )}
      </div>

      {/* Quick-add form (shown when "+ Add mods → Quick add URL" is picked). */}
      {lib.renderQuickAddForm()}

      {/* ── Section 1: mods in this pack ─────────────────────────── */}
      <section
        className="gf-modpack-detail-section"
        data-testid="modpack-detail-in-pack"
      >
        <div className="gf-modpack-detail-section-head">
          <div className="gf-modpack-detail-section-title-group">
            <h3 className="gf-modpack-detail-section-title">
              {t('modpack.detail.inPackHeading')}
            </h3>
            <span className="gf-modpack-detail-count" aria-hidden>
              {profile.mods.length}
            </span>
            {missingCount > 0 && (
              <span
                className="gf-modpack-detail-count-missing"
                title={t('modpack.detail.missingTitle')}
              >
                {t('modpack.detail.missingCount', { count: missingCount })}
              </span>
            )}
            <HelpHint helpKey="modpackWhat" />
          </div>
          {/* Updates affordance — scoped to this pack's mods. */}
          {updatesControl}
        </div>

        {profile.mods.length > 0 && (
          <p className="gf-modpack-detail-section-note">
            {t('modpack.detail.inPackOrderNote')}
          </p>
        )}

        {/* The pack's mods render with the SAME rich rows as the All Mods
            view (toggle / source badges / kebab / inline source editor),
            filtered to just this pack's members. The toolbar's "+ Add mods"
            / Edit / Load order share the search row (toolbarActions).
            packScoped drops the redundant In-Modpack badge + sort and turns
            each row's visible action into "Remove from pack". reloadToken
            re-syncs when membership changes from outside the table. */}
        <LibraryTable
          modpackName={profile.name}
          packScoped
          coupleActiveStorage
          reloadToken={`${membershipSignature}|active:${activeProfile ?? ''}`}
          toolbarActions={packToolbarActions}
          filterRow={(row) =>
            !!row.profiles.find((p) => p.profile_name === profile.name)?.included
          }
          onMembershipChanged={refreshAfterMutation}
          onLoadOrderChanged={refreshAfterMutation}
          {...lib.tableActionProps}
        />
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

      {/* Bulk membership editor (checkbox picker). */}
      {editing && (
        <EditModpackModal
          profile={profile}
          onClose={() => setEditing(false)}
          onSaved={refreshAfterMutation}
        />
      )}
    </div>
  );
}
