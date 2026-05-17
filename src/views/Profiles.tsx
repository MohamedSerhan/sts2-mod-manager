import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Camera,
  Play,
  Download,
  Trash2,
  Upload,
  Layers,
  Share2,
  RefreshCw,
  Copy,
  Check,
  Key,
  Files,
  AlertTriangle,
  MessageSquare,
  Link as LinkIcon,
  Save,
} from 'lucide-react';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmDialog';
import { KebabMenu, KebabSection, KebabDivider, KebabItem } from '../components/KebabMenu';
import { PublishModal } from '../components/PublishModal';
import {
  listProfiles,
  createProfile,
  switchProfile,
  repairProfile,
  snapshotProfile,
  deleteProfile,
  duplicateProfile,
  exportProfile,
  importProfile,
  getShareInfo,
  getProfileDrift,
  createBackup,
  applySubscriptionUpdate,
  getSubscriptions,
} from '../hooks/useTauri';
import { importShareCodeSmart, buildShareMessage, buildShareLink } from '../lib/shareImport';
import type { ProfileDrift } from '../hooks/useTauri';
import type { Profile, ShareResult } from '../types';

interface ProfilesViewProps {
  /** Navigates to Settings → Accounts. Passed down to PublishModal's
   *  pre-flight "GitHub token missing" prompt so the curator gets a
   *  one-click route to the token field instead of having to discover
   *  it themselves. */
  onGoToSettings?: () => void;
}

export function ProfilesView({ onGoToSettings }: ProfilesViewProps = {}) {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [showImportCode, setShowImportCode] = useState(false);
  const [importCode, setImportCode] = useState('');
  const [importingCode, setImportingCode] = useState(false);
  const [copiedProfileCode, setCopiedProfileCode] = useState<string | null>(null);
  const [shareInfoMap, setShareInfoMap] = useState<Record<string, ShareResult>>({});
  const [publishTarget, setPublishTarget] = useState<{ profile: Profile; isReshare: boolean } | null>(null);
  const [driftMap, setDriftMap] = useState<Record<string, ProfileDrift>>({});
  const [switchingProfile, setSwitchingProfile] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState<string | null>(null);
  // v5 batch 3 — Following / Published tabs.
  // "Following" = every profile you have. "Published" = ones you've shared (have a share code).
  const [tab, setTab] = useState<'following' | 'published'>('following');
  const { t } = useTranslation();
  const { refreshAll, setActiveProfile, activeProfile, subUpdates, refreshSubUpdates } = useApp();
  const toastCtx = useToast();
  const confirm = useConfirm();
  const [applyingSubId, setApplyingSubId] = useState<string | null>(null);

  async function handleApplySub(shareId: string) {
    if (applyingSubId) return;
    setApplyingSubId(shareId);
    try {
      const profile = await applySubscriptionUpdate(shareId);
      await refreshAll();
      refreshSubUpdates();
      toastCtx.success(t('profiles.toast.synced', { name: profile.name }));
    } catch (e) {
      toastCtx.error(t('profiles.toast.syncFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setApplyingSubId(null);
    }
  }

  useEffect(() => {
    loadProfiles();
  }, []);

  /**
   * Re-pull share info + drift state for currently-loaded profiles.
   *
   * Drift only matters for the active profile — every other profile is
   * just a saved snapshot, so "differs from disk" there is the expected
   * state, not a problem.
   *
   * Exposed (vs being inline in the useEffect) so that mutating actions —
   * Share, Re-share, Update from drift — can fire it after they finish
   * and the UI updates immediately instead of leaving the user staring at
   * a stale "out of sync" banner until they navigate away and back.
   */
  const refreshShareAndDrift = useCallback(async () => {
    const shareMap: Record<string, ShareResult> = {};
    for (const p of profiles) {
      try {
        const info = await getShareInfo(p.name);
        if (info) shareMap[p.name] = info;
      } catch { /* no share info */ }
    }
    setShareInfoMap(shareMap);

    const driftEntries: Record<string, ProfileDrift> = {};
    if (activeProfile) {
      try {
        const drift = await getProfileDrift(activeProfile);
        if (drift.has_drift) driftEntries[activeProfile] = drift;
      } catch { /* ignore */ }
    }
    setDriftMap(driftEntries);
  }, [profiles, activeProfile]);

  useEffect(() => {
    if (profiles.length === 0) return;
    refreshShareAndDrift();
  }, [profiles, activeProfile, refreshShareAndDrift]);

  async function loadProfiles() {
    try {
      setLoading(true);
      setError(null);
      const list = await listProfiles();
      setProfiles(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      const profile = await createProfile(newName.trim());
      setProfiles((prev) => [...prev, profile]);
      setNewName('');
      setShowCreate(false);
      toastCtx.success(t('profiles.toast.created', { name: profile.name }));
    } catch (e) {
      toastCtx.error(t('profiles.toast.createFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleSnapshot() {
    const name = prompt('Enter snapshot name:');
    if (!name?.trim()) return;
    try {
      const profile = await snapshotProfile(name.trim());
      setProfiles((prev) => [...prev, profile]);
      toastCtx.success(t('profiles.toast.snapshotCreated', { name: profile.name, count: profile.mods.length }));
    } catch (e) {
      toastCtx.error(t('profiles.toast.snapshotFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleSwitch(name: string) {
    if (activeProfile && activeProfile !== name && driftMap[activeProfile]?.has_drift) {
      const ok = await confirm({
        title: t('profiles.confirm.switch.title', { name: activeProfile }),
        body: t('profiles.confirm.switch.body'),
        warning: t('profiles.confirm.switch.warning'),
        confirmLabel: t('profiles.confirm.switch.confirmLabel'),
        cancelLabel: t('profiles.confirm.switch.cancelLabel'),
      });
      if (!ok) return;
    }

    try {
      setSwitchingProfile(name);
      const result = await switchProfile(name);
      setActiveProfile(name);
      await refreshAll();
      await loadProfiles();

      const parts: string[] = [];
      if (result.downloaded > 0) parts.push(`${result.downloaded} mod(s) downloaded`);
      if (result.failed_downloads && result.failed_downloads.length > 0) {
        parts.push(`${result.failed_downloads.length} failed: ${result.failed_downloads.join(', ')}`);
      }
      if (result.missing_mods.length > 0) {
        parts.push(`${result.missing_mods.length} still missing: ${result.missing_mods.join(', ')}`);
      }

      if (parts.length > 0) {
        toastCtx.info(t('profiles.toast.switchedWithDetails', { name, details: parts.join('. ') }));
      } else {
        toastCtx.success(t('profiles.toast.switched', { name }));
      }
    } catch (e) {
      toastCtx.error(t('profiles.toast.switchFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSwitchingProfile(null);
    }
  }

  /**
   * Drift Repair — same as Switch, but with "restore from manifest" intent:
   * missing/version-drifted profile mods are restored, and active extras are
   * moved to mods_disabled. It never deletes a user's mod library.
   */
  async function handleRepairDrift(name: string) {
    const drift = driftMap[name];
    const orphanCount = drift?.added.length ?? 0;
    const orphans = drift?.added ?? [];
    const orphanList = orphans.length > 8
      ? `${orphans.slice(0, 8).join(', ')}, …${orphans.length - 8} more`
      : orphans.join(', ');

    const ok = await confirm({
      title: t('profiles.confirm.repair.title', { name }),
      body: orphanCount > 0
        ? t('profiles.confirm.repair.bodyWithOrphans', { count: orphanCount, list: orphanList })
        : t('profiles.confirm.repair.bodyNoOrphans'),
      confirmLabel: t('profiles.confirm.repair.confirmLabel'),
      destructive: false,
      checkbox: orphanCount > 0
        ? { label: t('profiles.confirm.repair.backupCheckbox'), defaultChecked: false }
        : undefined,
    });
    if (!ok) return;

    try {
      setSwitchingProfile(name);
      if (ok.checked) {
        try { await createBackup(); }
        catch (e) { toastCtx.error(t('profiles.toast.backupFailed', { error: e instanceof Error ? e.message : String(e) })); }
      }
      const result = await repairProfile(name);
      setActiveProfile(name);
      await refreshAll();
      await loadProfiles();

      const summary: string[] = [];
      const disabledOrphans = result.disabled_orphans ?? [];
      if (disabledOrphans.length > 0) {
        summary.push(`disabled ${disabledOrphans.length} extra mod${disabledOrphans.length === 1 ? '' : 's'}`);
      }
      if (result.downloaded > 0) summary.push(`downloaded ${result.downloaded}`);
      if (result.failed_downloads.length > 0) {
        summary.push(`${result.failed_downloads.length} download(s) failed`);
      }
      if (result.missing_mods.length > 0) {
        summary.push(`${result.missing_mods.length} still missing`);
      }
      toastCtx.success(
        summary.length > 0
          ? t('profiles.toast.repairedWithDetails', { name, details: summary.join(', ') })
          : t('profiles.toast.repaired', { name })
      );
    } catch (e) {
      toastCtx.error(t('profiles.toast.repairFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSwitchingProfile(null);
    }
  }

  async function handleSaveDrift(name: string) {
    if (savingProfile) return;
    try {
      setSavingProfile(name);
      const profile = await snapshotProfile(name);
      setProfiles((prev) => {
        const exists = prev.some((p) => p.name === profile.name);
        return exists
          ? prev.map((p) => (p.name === profile.name ? profile : p))
          : [...prev, profile];
      });
      setDriftMap((prev) => {
        const next = { ...prev };
        delete next[name];
        return next;
      });
      await refreshAll();
      await loadProfiles();
      toastCtx.success(
        shareInfoMap[name]
          ? t('profiles.toast.savedChangesWithReShare', { name })
          : t('profiles.toast.savedChanges', { name })
      );
    } catch (e) {
      toastCtx.error(t('profiles.toast.saveFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSavingProfile(null);
    }
  }

  async function handleExport(name: string) {
    try {
      const json = await exportProfile(name);
      await navigator.clipboard.writeText(json);
      toastCtx.success(t('profiles.toast.exported'));
    } catch (e) {
      toastCtx.error(t('profiles.toast.exportFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleDelete(name: string) {
    const ok = await confirm({
      title: t('profiles.confirm.delete.title', { name }),
      body: t('profiles.confirm.delete.body'),
      confirmLabel: t('profiles.confirm.delete.confirmLabel'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteProfile(name);
      setProfiles((prev) => prev.filter((p) => p.name !== name));
      toastCtx.success(t('profiles.toast.deleted', { name }));
    } catch (e) {
      toastCtx.error(t('profiles.toast.deleteFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleDuplicate(name: string) {
    const newName = prompt(`Duplicate "${name}" as:`, `${name} (copy)`);
    if (!newName?.trim()) return;
    try {
      const profile = await duplicateProfile(name, newName.trim());
      setProfiles((prev) => [...prev, profile]);
      toastCtx.success(t('profiles.toast.duplicated', { name: profile.name }));
    } catch (e) {
      toastCtx.error(t('profiles.toast.duplicateFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleImport() {
    if (!importJson.trim()) return;
    try {
      const profile = await importProfile(importJson.trim());
      setProfiles((prev) => [...prev, profile]);
      setImportJson('');
      setShowImport(false);
      toastCtx.success(t('profiles.toast.imported', { name: profile.name }));
    } catch (e) {
      toastCtx.error(t('profiles.toast.importFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  // Share + re-share are now driven by <PublishModal> which calls
  // shareProfile / reshareProfile internally. The legacy direct handlers
  // have been removed.

  async function handleImportFromCode() {
    const code = importCode.trim();
    if (!code) return;

    try {
      setImportingCode(true);
      // Same smart router Home uses + the deep-link path. Fetches
      // subscriptions inline so we don't need to lift them into context
      // for this one call site.
      const subs = await getSubscriptions().catch(() => []);
      const outcome = await importShareCodeSmart(code, {
        confirm,
        subscriptions: subs,
        activeProfile,
        subUpdates,
        t,
      });
      if (outcome.kind === 'cancelled') return;

      setImportCode('');
      setShowImportCode(false);
      await refreshAll();
      refreshSubUpdates();

      if (outcome.kind === 'installed') {
        setProfiles((prev) => [...prev, outcome.profile]);
        toastCtx.success(
          t('profiles.toast.importedModpack', { name: outcome.profile.name, count: outcome.profile.mods.length }),
        );
      } else if (outcome.kind === 'activated') {
        toastCtx.success(t('profiles.toast.switched', { name: outcome.profileName }));
      } else if (outcome.kind === 'reapplied') {
        const parts: string[] = [];
        if (outcome.result.downloaded > 0) parts.push(`${outcome.result.downloaded} downloaded`);
        if (outcome.result.failed_downloads.length > 0) parts.push(`${outcome.result.failed_downloads.length} failed`);
        if (outcome.result.missing_mods.length > 0) parts.push(`${outcome.result.missing_mods.length} still missing`);
        toastCtx.info(parts.length ? t('profiles.toast.reappliedWithDetails', { name: outcome.profileName, details: parts.join(', ') }) : t('profiles.toast.reapplied', { name: outcome.profileName }));
      } else if (outcome.kind === 'synced') {
        toastCtx.success(t('profiles.toast.syncedUpToDate', { name: outcome.profileName }));
      } else if (outcome.kind === 'already-active') {
        toastCtx.info(t('profiles.toast.alreadyActive', { name: outcome.profileName }));
      }
    } catch (e) {
      toastCtx.error(t('profiles.toast.importFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setImportingCode(false);
    }
  }

  return (
    <div className="gf-body">
      {/* Switching Profile Overlay (v5 loading) */}
      {switchingProfile && (
        <div className="gf-modal-back">
          <div className="gf-loading-card">
            <div className="gf-spinner" />
            <div className="gf-loading-msg">{t('profiles.switching.activating', { name: switchingProfile })}</div>
            <div className="gf-loading-sub">
              {t('profiles.switching.fetching')}
            </div>
            <div className="gf-loading-step">
              {t('profiles.switching.eta')}
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="gf-page-head">
        <div>
          <h1 className="gf-page-title">{t('profiles.page.title')}</h1>
          <p className="gf-page-sub">
            {t('profiles.page.subtitle')}
          </p>
        </div>
        <div className="gf-page-actions">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowImportCode(!showImportCode);
              setShowImport(false);
              setShowCreate(false);
            }}
          >
            <Key size={14} />
            {t('profiles.actions.addByCode')}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowImport(!showImport);
              setShowImportCode(false);
              setShowCreate(false);
            }}
          >
            <Upload size={14} />
            {t('profiles.actions.importJson')}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleSnapshot}>
            <Camera size={14} />
            {t('profiles.actions.snapshotCurrent')}
          </Button>
          <Button size="sm" onClick={() => {
            setShowCreate(!showCreate);
            setShowImport(false);
            setShowImportCode(false);
          }}>
            <Plus size={14} />
            {t('profiles.actions.newProfile')}
          </Button>
        </div>
      </div>

      {/* Following / Published tabs (v5 batch 3) */}
      <div className="gf-tabs gf-tabs-settings" style={{ marginBottom: 14 }}>
        <button
          className={`gf-tab ${tab === 'following' ? 'active' : ''}`}
          onClick={() => setTab('following')}
        >
          {t('profiles.tabs.following')}
          <span className="gf-tab-count">{profiles.length}</span>
        </button>
        <button
          className={`gf-tab ${tab === 'published' ? 'active' : ''}`}
          onClick={() => setTab('published')}
        >
          {t('profiles.tabs.publishedByYou')}
          <span className="gf-tab-count">{Object.keys(shareInfoMap).length}</span>
        </button>
      </div>

      {/* Activity — pending updates from followed packs. One row per
          pack the curator has re-shared since the user last synced.
          Same data the Home view's "update available" cards consume,
          plus a sidebar badge — surfaced here as a focused worklist. */}
      {subUpdates.length > 0 && (
        <div className="gf-activity-feed" style={{ marginBottom: 14 }}>
          <div className="gf-activity-head">
            <RefreshCw size={14} />
            <span>
              {subUpdates.length === 1
                ? t('profiles.activity.hasUpdates', { count: subUpdates.length })
                : t('profiles.activity.haveUpdates', { count: subUpdates.length })}
            </span>
          </div>
          {subUpdates.map((u) => {
            const summary = [
              u.added_mods.length > 0 && t('profiles.activity.summary.added', { count: u.added_mods.length }),
              u.updated_mods.length > 0 && t('profiles.activity.summary.updated', { count: u.updated_mods.length }),
              u.removed_mods.length > 0 && t('profiles.activity.summary.removed', { count: u.removed_mods.length }),
            ].filter(Boolean).join(' · ') || t('profiles.activity.summary.noChange');
            return (
              <div key={u.share_id} className="gf-activity-row">
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="gf-activity-name">{u.profile_name}</div>
                  <div className="gf-activity-summary">{summary}</div>
                </div>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={applyingSubId !== null}
                  onClick={() => handleApplySub(u.share_id)}
                >
                  {applyingSubId === u.share_id ? (
                    <RefreshCw size={12} className="animate-spin" />
                  ) : (
                    <Download size={12} />
                  )}
                  {applyingSubId === u.share_id ? t('profiles.activity.applying') : t('profiles.activity.applyUpdate')}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      {/* Drift banner on the active profile (v5 batch 3) */}
      {activeProfile && driftMap[activeProfile] && (
        <div className="gf-banner gf-banner-warn" style={{ marginBottom: 14 }}>
          <AlertTriangle size={16} className="gf-banner-icon" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{t('profiles.drift.title', { name: activeProfile })}</div>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              {[
                driftMap[activeProfile].added.length && t('profiles.drift.newItems', { count: driftMap[activeProfile].added.length }),
                driftMap[activeProfile].removed.length && t('profiles.drift.removedItems', { count: driftMap[activeProfile].removed.length }),
                driftMap[activeProfile].toggled.length && t('profiles.drift.toggledItems', { count: driftMap[activeProfile].toggled.length }),
                (driftMap[activeProfile].version_changed?.length ?? 0) && t('profiles.drift.versionChanged', { count: driftMap[activeProfile].version_changed.length }),
              ].filter(Boolean).join(' · ') || t('profiles.drift.outOfSyncFallback')}
              {' '}{t('profiles.drift.hint')}
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => handleSaveDrift(activeProfile)}
            title={t('profiles.drift.saveChanges')}
            disabled={savingProfile !== null}
          >
            {savingProfile === activeProfile ? (
              <RefreshCw size={12} className="animate-spin" />
            ) : (
              <Save size={12} />
            )}
            {t('profiles.drift.saveChanges')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleRepairDrift(activeProfile)}
            title={t('profiles.drift.repair')}
            disabled={savingProfile !== null}
          >
            {t('profiles.drift.repair')}
          </Button>
        </div>
      )}

      {/* Import Code Form */}
      {showImportCode && (
        <Card className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-text-muted block mb-1">
              {t('profiles.form.codeLabel')}
            </label>
            <input
              type="text"
              value={importCode}
              onChange={(e) => setImportCode(e.target.value)}
              placeholder={t('profiles.form.codePlaceholder')}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-text font-mono tracking-wider placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50"
              onKeyDown={(e) => e.key === 'Enter' && handleImportFromCode()}
              disabled={importingCode}
            />
          </div>
          <Button
            size="sm"
            onClick={handleImportFromCode}
            disabled={importingCode}
          >
            {importingCode ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            {importingCode ? t('common.importing') : t('common.import')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowImportCode(false)}
          >
            {t('common.cancel')}
          </Button>
        </Card>
      )}

      {/* Create Profile Form */}
      {showCreate && (
        <Card className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-text-muted block mb-1">
              {t('profiles.form.nameLabel')}
            </label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('profiles.form.namePlaceholder')}
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>
          <Button size="sm" onClick={handleCreate}>
            {t('common.create')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCreate(false)}
          >
            {t('common.cancel')}
          </Button>
        </Card>
      )}

      {/* Import Profile JSON Form */}
      {showImport && (
        <Card className="space-y-2">
          <label className="text-xs text-text-muted block">
            {t('profiles.form.jsonLabel')}
          </label>
          <textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            placeholder={t('profiles.form.jsonPlaceholder')}
            rows={4}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none font-mono"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleImport}>
              {t('common.import')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowImport(false)}
            >
              {t('common.cancel')}
            </Button>
          </div>
        </Card>
      )}

      {/* Profiles List */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-text-dim">
          <p className="text-sm">{t('profiles.loading')}</p>
        </div>
      ) : error ? (
        <Card className="text-center py-8">
          <p className="text-danger text-sm">{error}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={loadProfiles}
          >
            {t('common.retry')}
          </Button>
        </Card>
      ) : profiles.length === 0 ? (
        <div className="gf-empty">
          <div className="gf-empty-art"><Layers size={28} /></div>
          <div className="gf-empty-title">{t('profiles.empty.following.title')}</div>
          <div className="gf-empty-sub">
            {t('profiles.empty.following.hint')}
          </div>
        </div>
      ) : (() => {
        const visible = tab === 'published'
          ? profiles.filter((p) => shareInfoMap[p.name])
          : profiles;
        if (visible.length === 0) {
          return (
            <div className="gf-empty">
              <div className="gf-empty-art"><Layers size={28} /></div>
              <div className="gf-empty-title">{t('profiles.empty.published.title')}</div>
              <div className="gf-empty-sub">{t('profiles.empty.published.hint')}</div>
            </div>
          );
        }
        return (
        <div className="space-y-2">
          {visible.map((profile) => (
            <Card
              key={profile.name}
              className={`flex items-center justify-between hover:bg-surface-hover transition-colors ${activeProfile === profile.name ? 'border-green-500/50 bg-green-500/5' : ''}`}
            >
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-text flex items-center gap-2">
                  {profile.name}
                  {activeProfile === profile.name && (
                    <span className="text-[10px] font-normal bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded">{t('profiles.card.active')}</span>
                  )}
                </h3>
                <div className="flex items-center gap-3 mt-1 text-xs text-text-dim">
                  <span>
                    {t('profiles.card.enabled', { count: profile.mods.filter(m => m.enabled).length })}
                    {profile.mods.filter(m => !m.enabled).length > 0 && (
                      <>, {t('profiles.card.disabled', { count: profile.mods.filter(m => !m.enabled).length })}</>
                    )}
                  </span>
                  {profile.game_version && <span>{profile.game_version}</span>}
                  <span>
                    {new Date(profile.created_at).toLocaleDateString()}
                  </span>
                  {profile.created_by && (
                    <span className="text-primary">{t('profiles.card.by', { name: profile.created_by })}</span>
                  )}
                </div>
                {shareInfoMap[profile.name] && (
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <code className="text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded select-all">
                      {shareInfoMap[profile.name].owner}/{shareInfoMap[profile.name].code}
                    </code>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const code = `${shareInfoMap[profile.name].owner}/${shareInfoMap[profile.name].code}`;
                        navigator.clipboard.writeText(code).then(() => {
                          setCopiedProfileCode(profile.name);
                          setTimeout(() => setCopiedProfileCode(null), 2000);
                        }).catch(() => {});
                      }}
                      className="text-text-dim hover:text-text transition-colors"
                      title={t('profiles.kebab.copyShareCode')}
                    >
                      {copiedProfileCode === profile.name ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                    {/* Copy install link — Discord-clickable HTTPS URL. */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const code = `${shareInfoMap[profile.name].owner}/${shareInfoMap[profile.name].code}`;
                        navigator.clipboard.writeText(buildShareLink(code))
                          .then(() => toastCtx.success(t('profiles.toast.installLinkCopied')))
                          .catch(() => toastCtx.error(t('profiles.toast.cantCopyToClipboard')));
                      }}
                      className="text-text-dim hover:text-text transition-colors"
                      title={t('profiles.kebab.copyShareLink')}
                    >
                      <LinkIcon size={12} />
                    </button>
                    {/* Copy full share message — intro + link + raw code. */}
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const code = `${shareInfoMap[profile.name].owner}/${shareInfoMap[profile.name].code}`;
                        const message = buildShareMessage(profile.name, code, t);
                        navigator.clipboard.writeText(message)
                          .then(() => toastCtx.success(t('profiles.toast.shareMessageCopied')))
                          .catch(() => toastCtx.error(t('profiles.toast.cantCopyToClipboard')));
                      }}
                      className="text-text-dim hover:text-text transition-colors"
                      title={t('profiles.kebab.copyShareMessage')}
                    >
                      <MessageSquare size={12} />
                    </button>
                  </div>
                )}
                {driftMap[profile.name] && (
                  <div
                    className="flex items-start gap-2 mt-1.5 text-xs text-amber-400 bg-amber-500/10 rounded px-2 py-1"
                    title={
                      (driftMap[profile.name].version_changed ?? [])
                        .map((v) => `${v.name}: ${v.profile_version} → ${v.disk_version}`)
                        .join('\n') || undefined
                    }
                  >
                    <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                    <span>
                      {t('profiles.card.outOfSync')}
                      {driftMap[profile.name].added.length > 0 && (
                        <> &middot; {driftMap[profile.name].added.length > 1 ? t('profiles.card.newMods', { count: driftMap[profile.name].added.length }) : t('profiles.card.newMod', { count: driftMap[profile.name].added.length })}</>
                      )}
                      {driftMap[profile.name].removed.length > 0 && (
                        <> &middot; {t('profiles.card.removed', { count: driftMap[profile.name].removed.length })}</>
                      )}
                      {driftMap[profile.name].toggled.length > 0 && (
                        <> &middot; {t('profiles.card.toggled', { count: driftMap[profile.name].toggled.length })}</>
                      )}
                      {(driftMap[profile.name].version_changed?.length ?? 0) > 0 && (
                        <> &middot; {driftMap[profile.name].version_changed.length > 1 ? t('profiles.card.versionChanged_other', { count: driftMap[profile.name].version_changed.length }) : t('profiles.card.versionChanged_one', { count: driftMap[profile.name].version_changed.length })}</>
                      )}
                      {shareInfoMap[profile.name] && (
                        <> &mdash; {t('profiles.card.reShareHint')}</>
                      )}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1">
                {activeProfile === profile.name ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleSwitch(profile.name)}
                    title={t('profiles.card.restore')}
                    disabled={switchingProfile !== null}
                  >
                    {switchingProfile === profile.name ? (
                      <RefreshCw size={14} className="animate-spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleSwitch(profile.name)}
                    title={t('profiles.card.activateProfile')}
                    disabled={switchingProfile !== null}
                  >
                    {switchingProfile === profile.name ? (
                      <RefreshCw size={14} className="animate-spin" />
                    ) : (
                      <><Play size={14} fill="currentColor" /> {t('profiles.card.switchTo')}</>
                    )}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPublishTarget({ profile, isReshare: !!shareInfoMap[profile.name] })}
                  title={shareInfoMap[profile.name] ? t('profiles.card.reShareTitle') : t('profiles.card.shareTitle')}
                >
                  <Share2 size={14} />
                  {shareInfoMap[profile.name] ? t('profiles.card.reShare') : t('profiles.card.share')}
                </Button>
                <KebabMenu title={t('profiles.card.moreActions')}>
                  <KebabSection>
                    <KebabItem icon={<Camera size={12} />} onClick={() => handleSnapshot()}>
                      {t('profiles.kebab.snapshotFromCurrent')}
                    </KebabItem>
                    <KebabItem icon={<Files size={12} />} onClick={() => handleDuplicate(profile.name)}>
                      {t('profiles.kebab.duplicate')}
                    </KebabItem>
                  </KebabSection>
                  <KebabDivider />
                  <KebabSection>
                    <KebabItem icon={<Download size={12} />} onClick={() => handleExport(profile.name)}>
                      {t('profiles.kebab.exportJson')}
                    </KebabItem>
                    {shareInfoMap[profile.name] && (
                      <>
                        <KebabItem
                          icon={<Copy size={12} />}
                          onClick={() => {
                            const code = `${shareInfoMap[profile.name].owner}/${shareInfoMap[profile.name].code}`;
                            navigator.clipboard.writeText(code).then(() => toastCtx.success(t('profiles.toast.shareCodeCopied')));
                          }}
                        >
                          {t('profiles.kebab.copyShareCode')}
                        </KebabItem>
                        <KebabItem
                          icon={<LinkIcon size={12} />}
                          onClick={() => {
                            const code = `${shareInfoMap[profile.name].owner}/${shareInfoMap[profile.name].code}`;
                            navigator.clipboard.writeText(buildShareLink(code))
                              .then(() => toastCtx.success(t('profiles.toast.installLinkCopied')))
                              .catch(() => toastCtx.error(t('profiles.toast.cantCopyToClipboard')));
                          }}
                        >
                          {t('profiles.kebab.copyShareLink')}
                        </KebabItem>
                        <KebabItem
                          icon={<MessageSquare size={12} />}
                          onClick={() => {
                            const code = `${shareInfoMap[profile.name].owner}/${shareInfoMap[profile.name].code}`;
                            const message = buildShareMessage(profile.name, code, t);
                            navigator.clipboard.writeText(message)
                              .then(() => toastCtx.success(t('profiles.toast.shareMessageCopied')))
                              .catch(() => toastCtx.error(t('profiles.toast.cantCopyToClipboard')));
                          }}
                        >
                          {t('profiles.kebab.copyShareMessage')}
                        </KebabItem>
                      </>
                    )}
                  </KebabSection>
                  <KebabDivider />
                  <KebabItem
                    danger
                    icon={<Trash2 size={12} />}
                    onClick={() => handleDelete(profile.name)}
                  >
                    {t('profiles.kebab.deleteProfile')}
                  </KebabItem>
                </KebabMenu>
              </div>
            </Card>
          ))}
        </div>
        );
      })()}

      <PublishModal
        open={!!publishTarget}
        profile={publishTarget?.profile ?? null}
        isReshare={publishTarget?.isReshare ?? false}
        onGoToSettings={onGoToSettings}
        onClose={() => setPublishTarget(null)}
        onShared={(result) => {
          // Optimistically patch share info so the row flips Share→Re-share
          // immediately even before the reload below settles.
          setShareInfoMap((prev) => ({ ...prev, [publishTarget!.profile.name]: result }));
          // Share/Re-share takes a fresh snapshot of disk into the profile,
          // so after it finishes the profile and disk should match again.
          // Reload the profile list — that bumps the `profiles` state
          // reference, which trips the effect that re-derives drift, so
          // the "out of sync" banner clears immediately instead of
          // hanging around until the user navigates away and back.
          loadProfiles();
        }}
      />
    </div>
  );
}
