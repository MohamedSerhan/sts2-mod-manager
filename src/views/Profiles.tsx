import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus,
  Camera,
  Copy,
  Download,
  Link as LinkIcon,
  MessageSquare,
  Upload,
  Layers,
  RefreshCw,
  AlertTriangle,
  Save,
  ArrowUp,
  ArrowDown,
  GripVertical,
} from 'lucide-react';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useClipboard } from '../hooks/useClipboard';
import { useConfirm } from '../components/ConfirmDialog';
import { ModpackDetail } from '../components/ModpackDetail';
import { PublishModal } from '../components/PublishModal';
import { CreateModpackWizard } from '../components/CreateModpackWizard';
import { HelpHint } from '../components/HelpHint';
import { BrowseModpacksView } from './BrowseModpacks';
import {
  listProfiles,
  switchProfile,
  repairProfile,
  snapshotProfile,
  deleteProfile,
  duplicateProfile,
  exportProfile,
  importProfile,
  setProfileLoadOrder,
  getShareInfo,
  getProfileDrift,
  createBackup,
  applySubscriptionUpdate,
  getSubscriptions,
} from '../hooks/useTauri';
import { importShareCodeSmart, buildShareLink, buildShareMessage } from '../lib/shareImport';
import type { ProfileDrift } from '../hooks/useTauri';
import type { LoadOrderSettingsStatus, Profile, ShareResult } from '../types';

interface ProfilesViewProps {
  /** Navigates to Settings → Accounts. Passed down to PublishModal's
   *  pre-flight "GitHub token missing" prompt so the curator gets a
   *  one-click route to the token field instead of having to discover
   *  it themselves. */
  onGoToSettings?: () => void;
  /** 1.7.0 T16 — bumped by the App shell when a sibling surface
   *  (the Mods "Manage active modpack →" link) wants Modpacks to open
   *  the active modpack's detail view on entry. Replaces the legacy
   *  openModLibrarySignal pump which opened a now-removed standalone
   *  workspace. The signal value itself is meaningless; only the
   *  change is observed. */
  openActiveModpackSignal?: number;
  /** 1.7.0 — initial outer-tab selection. 'browse' lands users on the
   *  Browse-modpacks tab (the absorbed top-level view); 'yours' is
   *  the default and shows the user's followed/published modpacks.
   *  Provided so the App shell can honor the legacy
   *  'browse-modpacks' view-id as a redirect. */
  initialTab?: 'yours' | 'browse';
  /** 1.7.0 v7 — incremented by the App shell when a sibling surface
   *  (ProfileSwitcher's "Add pack", onboarding's "Follow a friend")
   *  wants the toolbar Quick-Add input to grab focus + pulse. Each
   *  bump triggers a one-shot effect; the value itself is
   *  meaningless, only the change matters. */
  focusQuickAddSignal?: number;
  /** 1.7.0 T8 — incremented by the App shell when the new branched
   *  onboarding's creator-path CTA fires. Each bump opens the guided
   *  CreateModpackWizard. Same one-shot signal pattern as the focus
   *  variant; the value itself is meaningless, only the change
   *  matters. */
  openCreateWizardSignal?: number;
}

export function ProfilesView({ onGoToSettings, openActiveModpackSignal = 0, initialTab = 'yours', focusQuickAddSignal, openCreateWizardSignal }: ProfilesViewProps = {}) {
  // 1.7.0 outer Yours/Browse tabs. 'yours' renders the user's
  // followed/published modpack list (the legacy Profiles content);
  // 'browse' renders the public modpack browser (formerly its own
  // sidebar entry). The inner 'following'/'published' filter still
  // lives below as the `tab` state — they're distinct concerns.
  const [outerTab, setOuterTab] = useState<'yours' | 'browse'>(initialTab);
  // If App re-renders us with a new initialTab (e.g. user navigates
  // to 'browse-modpacks' from a deep-link after we're already
  // mounted), reflect it. We use a ref-style effect rather than
  // making outerTab fully controlled because the user can still
  // click between tabs locally.
  useEffect(() => {
    setOuterTab(initialTab);
  }, [initialTab]);

  // 1.7.0 v7 — react to the App-owned focus signal by scrolling the
  // Quick-Add row into view, focusing the input, and pulsing the row
  // briefly so the user sees the paste-zone. Skip the very first
  // render (signal=0 or undefined).
  useEffect(() => {
    if (!focusQuickAddSignal) return;
    // Ensure we're on the Yours tab — the Quick-Add row lives in the
    // Yours toolbar above the tabs, and we don't want to silently hide
    // the focus pump if the user happens to be on Browse.
    setOuterTab('yours');
    const row = quickAddRowRef.current;
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const input = quickAddInputRef.current;
    if (input) {
      // Wait one frame so the scroll starts before focus steals it back.
      requestAnimationFrame(() => input.focus({ preventScroll: true }));
    }
    setQuickAddPulse(true);
    const timer = window.setTimeout(() => setQuickAddPulse(false), 1400);
    return () => window.clearTimeout(timer);
  }, [focusQuickAddSignal]);

  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreateWizard, setShowCreateWizard] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [importCode, setImportCode] = useState('');
  const [importingCode, setImportingCode] = useState(false);
  // 1.7.0 v7 — always-visible Quick-Add row above the tabs. Same import
  // pipeline as the toggle-able panel above; we keep both because the
  // toolbar button is the discoverable "Add modpack code" affordance
  // for users who want a labelled panel, while the inline row is the
  // one-paste fast-path. Both call handleImportFromCode (which already
  // routes via importShareCodeSmart + confirm pipeline).
  const quickAddInputRef = useRef<HTMLInputElement | null>(null);
  const quickAddRowRef = useRef<HTMLDivElement | null>(null);
  const [quickAddPulse, setQuickAddPulse] = useState(false);
  const [shareInfoMap, setShareInfoMap] = useState<Record<string, ShareResult>>({});
  const [publishTarget, setPublishTarget] = useState<{ profile: Profile; isReshare: boolean } | null>(null);
  const [driftMap, setDriftMap] = useState<Record<string, ProfileDrift>>({});
  const [switchingProfile, setSwitchingProfile] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState<string | null>(null);
  // 1.7.0 T16 — detail-view selection. When set, the modpack list
  // area becomes a focused detail view for this pack (header + audit
  // chips + LibraryTable + Advanced). Cleared by the back button.
  const [selectedModpack, setSelectedModpack] = useState<string | null>(null);
  // v5 batch 3 - profile list filters.
  const [tab, setTab] = useState<'following' | 'published'>('following');
  const [loadOrderProfile, setLoadOrderProfile] = useState<Profile | null>(null);
  const [loadOrderDraft, setLoadOrderDraft] = useState<Profile['mods']>([]);
  const [loadOrderSaving, setLoadOrderSaving] = useState(false);
  const [draggedLoadOrderIndex, setDraggedLoadOrderIndex] = useState<number | null>(null);
  const [dragOverLoadOrderIndex, setDragOverLoadOrderIndex] = useState<number | null>(null);
  // Ref to the scrollable load-order list so pointer-drag can hit-test
  // rows by clientY. HTML5 drag-and-drop is unusable here because Tauri's
  // OS-level file drop (enabled for drag-to-install) swallows the
  // webview's drag events — so reordering uses pointer events instead.
  const loadOrderListRef = useRef<HTMLDivElement>(null);
  const { t, i18n } = useTranslation();
  const { refreshAll, setActiveProfile, activeProfile, subUpdates, refreshSubUpdates } = useApp();
  const toastCtx = useToast();
  // Shared clipboard hook — same one Home + PublishModal use, so a
  // wording change for "Couldn't copy" propagates everywhere without
  // hunting through three separate try/catch blocks.
  const clipboard = useClipboard();
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

  /**
   * Copy a share artifact (raw code, install link, or paste-ready
   * message) to the clipboard from a shared modpack card chip.
   *
   * Review fix (T16): the old per-row Copy buttons were lost in the
   * card restructure — users who just wanted to forward a friend the
   * code had to click into detail → Share/Re-share → wait for the
   * publish modal → copy. Restoring inline chips on the card keeps the
   * fast-path one click away. Same `clipboard.writeText` shape +
   * toast as PublishModal.handleCopy.
   */
  async function handleCardCopy(
    profileName: string,
    kind: 'code' | 'link' | 'msg',
  ): Promise<void> {
    const info = shareInfoMap[profileName];
    if (!info) return;
    const codeStr = `${info.owner}/${info.code}`;
    const text
      = kind === 'code' ? codeStr
      : kind === 'link' ? buildShareLink(codeStr)
      : buildShareMessage(profileName, codeStr, t);
    const label =
      kind === 'code' ? t('profiles.toast.shareCodeCopied')
      : kind === 'link' ? t('profiles.toast.installLinkCopied')
      : t('profiles.toast.shareMessageCopied');
    await clipboard.copy(text, kind, {
      successMessage: label,
      failureMessage: 'profiles.toast.cantCopyToClipboard',
    });
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

  // 1.7.0 T16 — open the active modpack's detail view when a sibling
  // surface pumps the signal (Mods view's "Manage active modpack →"
  // link). If there's no active modpack, fall through to the list.
  useEffect(() => {
    if (openActiveModpackSignal > 0 && activeProfile) {
      setSelectedModpack(activeProfile);
      setShowImport(false);
    }
  }, [openActiveModpackSignal, activeProfile]);

  // 1.7.0 T8 — open the guided Create-modpack wizard when the App
  // shell pumps the signal (branched onboarding's creator-path CTA).
  // Skip the first render (signal=0 or undefined). Also drops the
  // user onto the Yours tab + closes any competing inline panels so
  // the wizard isn't fighting for screen space.
  useEffect(() => {
    if (!openCreateWizardSignal) return;
    setOuterTab('yours');
    setShowImport(false);
    setShowCreateWizard(true);
  }, [openCreateWizardSignal]);

  // T16 review fix — orphan-modpack guard. If the open detail view's
  // modpack disappears (deleted while detail is open, or signal bumped
  // before profiles finished loading), bounce back to the list. This
  // MUST live in an effect, not inline in render, or React StrictMode
  // (and 19+ in general) will warn about setState during render.
  useEffect(() => {
    if (
      selectedModpack !== null
      && profiles.length > 0
      && !profiles.find((p) => p.name === selectedModpack)
    ) {
      setSelectedModpack(null);
    }
  }, [profiles, selectedModpack]);

  async function loadProfiles(opts?: { silent?: boolean }) {
    try {
      // A silent reload skips the full-screen loading flag so an open
      // ModpackDetail isn't unmounted/remounted (which resets its scroll
      // position) on a background refresh after an add/remove. The
      // initial mount + explicit retries still show the skeleton.
      if (!opts?.silent) setLoading(true);
      setError(null);
      const list = await listProfiles();
      setProfiles(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }

  function openLoadOrderEditor(profile: Profile) {
    setLoadOrderProfile(profile);
    setLoadOrderDraft([...profile.mods]);
  }

  function closeLoadOrderEditor() {
    if (loadOrderSaving) return;
    setLoadOrderProfile(null);
    setLoadOrderDraft([]);
  }

  function moveLoadOrderItem(index: number, delta: -1 | 1) {
    setLoadOrderDraft((prev) => {
      const nextIndex = index + delta;
      if (nextIndex < 0 || nextIndex >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }

  function moveLoadOrderItemTo(fromIndex: number, toIndex: number) {
    setLoadOrderDraft((prev) => {
      if (
        fromIndex < 0
        || toIndex < 0
        || fromIndex >= prev.length
        || toIndex >= prev.length
        || fromIndex === toIndex
      ) {
        return prev;
      }
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  }

  /** Which row index the pointer is currently over, by hit-testing the
   *  rendered rows against clientY. Used by the pointer-drag reorder. */
  function loadOrderDropIndex(clientY: number): number | null {
    const list = loadOrderListRef.current;
    if (!list) return null;
    const rows = Array.from(
      list.querySelectorAll<HTMLElement>('.gf-load-order-row'),
    );
    for (let i = 0; i < rows.length; i++) {
      const rect = rows[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) return i;
    }
    return rows.length > 0 ? rows.length - 1 : null;
  }

  function loadOrderToastKey(status: LoadOrderSettingsStatus): string {
    switch (status) {
      case 'applied':
        return 'profiles.loadOrder.toastSavedApplied';
      case 'skipped_missing':
        return 'profiles.loadOrder.toastSavedSettingsMissing';
      case 'skipped_multiple':
        return 'profiles.loadOrder.toastSavedSettingsMultiple';
      case 'skipped_game_running':
        return 'profiles.loadOrder.toastSavedGameRunning';
      case 'failed':
        return 'profiles.loadOrder.toastSavedSettingsFailed';
      case 'skipped_inactive':
      default:
        return 'profiles.loadOrder.toastSavedInactive';
    }
  }

  async function handleSaveLoadOrder() {
    if (!loadOrderProfile || loadOrderSaving) return;
    try {
      setLoadOrderSaving(true);
      const result = await setProfileLoadOrder(
        loadOrderProfile.name,
        loadOrderDraft.map((mod) => ({
          name: mod.name,
          folder_name: mod.folder_name,
          mod_id: mod.mod_id,
        })),
      );
      setProfiles((prev) => prev.map((profile) => (
        profile.name === result.profile.name ? result.profile : profile
      )));
      setLoadOrderProfile(null);
      setLoadOrderDraft([]);
      const key = loadOrderToastKey(result.settings_status);
      const message = t(key, { name: result.profile.name });
      if (result.settings_status === 'failed') {
        toastCtx.error(message);
      } else if (
        result.settings_status === 'skipped_missing'
        || result.settings_status === 'skipped_multiple'
        || result.settings_status === 'skipped_game_running'
      ) {
        toastCtx.info(message);
      } else {
        toastCtx.success(message);
      }
    } catch (e) {
      toastCtx.error(t('profiles.loadOrder.toastFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLoadOrderSaving(false);
    }
  }

  /** 1.7.0 T16 — refresh hook fired by LibraryTable after a
   *  membership / storage mutation. We re-pull the profile list so
   *  the parent's drift map + share map see the updated manifests. */
  async function handleLibraryChanged() {
    // Silent so the open ModpackDetail keeps its scroll position while
    // the manifest re-pulls after an add/remove.
    await loadProfiles({ silent: true });
    refreshShareAndDrift();
  }

  async function handleSnapshot() {
    const name = prompt(t('profiles.prompt.snapshotName'));
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
      if (result.downloaded > 0) parts.push(t('common.parts.modsDownloaded', { count: result.downloaded }));
      if (result.failed_downloads && result.failed_downloads.length > 0) {
        parts.push(t('common.parts.failedWithList', { count: result.failed_downloads.length, list: result.failed_downloads.join(', ') }));
      }
      if (result.missing_mods.length > 0) {
        parts.push(t('common.parts.stillMissingWithList', { count: result.missing_mods.length, list: result.missing_mods.join(', ') }));
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
        summary.push(t('common.parts.disabledOrphans', { count: disabledOrphans.length }));
      }
      if (result.downloaded > 0) summary.push(t('common.parts.downloadedNum', { count: result.downloaded }));
      if (result.failed_downloads.length > 0) {
        summary.push(t('common.parts.downloadsFailed', { count: result.failed_downloads.length }));
      }
      if (result.missing_mods.length > 0) {
        summary.push(t('common.parts.stillMissing', { count: result.missing_mods.length }));
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
      // Use the shared hook for the clipboard write so the failure
      // wording stays consistent with the rest of the app. The
      // distinct export-failure message (when `exportProfile` itself
      // rejects) stays as a separate toast — the export step failing
      // is a different problem from the clipboard write failing.
      await clipboard.copy(json, 'export', {
        successMessage: t('profiles.toast.exported'),
        failureMessage: 'profiles.toast.cantCopyToClipboard',
      });
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
    const newName = prompt(t('profiles.prompt.duplicateAs', { name }), t('profiles.prompt.duplicateDefault', { name }));
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
      await refreshAll();
      refreshSubUpdates();

      if (outcome.kind === 'installed') {
        setProfiles((prev) => [...prev, outcome.profile]);
        toastCtx.success(
          t('profiles.toast.importedModpack', { name: outcome.profile.name, count: outcome.profile.mods.length }),
        );
      } else if (outcome.kind === 'activated') {
        toastCtx.success(t('profiles.toast.activated', { name: outcome.profileName }));
      } else if (outcome.kind === 'reapplied') {
        const parts: string[] = [];
        if (outcome.result.downloaded > 0) parts.push(t('common.parts.downloaded', { count: outcome.result.downloaded }));
        if (outcome.result.failed_downloads.length > 0) parts.push(t('common.parts.failed', { count: outcome.result.failed_downloads.length }));
        if (outcome.result.missing_mods.length > 0) parts.push(t('common.parts.stillMissing', { count: outcome.result.missing_mods.length }));
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

  function renderLoadOrderModal() {
    if (!loadOrderProfile) return null;
    return (
      <div className="gf-modal-back">
        <div
          className="gf-modal gf-load-order-modal"
          role="dialog"
          aria-modal="true"
          aria-label={t('profiles.loadOrder.dialogLabel', { name: loadOrderProfile.name })}
        >
          <div className="gf-modal-head">
            <div>
              <div className="gf-modal-title">{t('profiles.loadOrder.title', { name: loadOrderProfile.name })}</div>
              <div className="gf-modal-sub">{t('profiles.loadOrder.subtitle')}</div>
            </div>
          </div>
          <div className="gf-modal-body">
            <div className="gf-load-order-note">{t('profiles.loadOrder.note')}</div>
            {loadOrderDraft.length === 0 ? (
              <div className="gf-empty-sub">{t('profiles.loadOrder.empty')}</div>
            ) : (
              <div className="gf-load-order-list" role="list" ref={loadOrderListRef}>
                {loadOrderDraft.map((mod, index) => (
                  <div
                    className={`gf-load-order-row${dragOverLoadOrderIndex === index ? ' drag-over' : ''}${draggedLoadOrderIndex === index ? ' dragging' : ''}`}
                    key={`${mod.folder_name ?? mod.mod_id ?? mod.name}-${index}`}
                    role="listitem"
                    aria-label={t('profiles.loadOrder.rowLabel', { name: mod.name, position: index + 1 })}
                  >
                    {/* Pointer-drag handle. Uses pointer events + capture
                        (not HTML5 DnD, which Tauri's native file-drop
                        breaks) and hit-tests rows by clientY to reorder. */}
                    <div
                      className="gf-load-order-drag"
                      title={t('profiles.loadOrder.dragHandle')}
                      aria-label={t('profiles.loadOrder.dragHandle')}
                      onPointerDown={(event) => {
                        if (loadOrderSaving) return;
                        event.preventDefault();
                        setDraggedLoadOrderIndex(index);
                        setDragOverLoadOrderIndex(index);
                        event.currentTarget.setPointerCapture(event.pointerId);
                      }}
                      onPointerMove={(event) => {
                        if (draggedLoadOrderIndex === null) return;
                        const to = loadOrderDropIndex(event.clientY);
                        if (to !== null) setDragOverLoadOrderIndex(to);
                      }}
                      onPointerUp={(event) => {
                        if (draggedLoadOrderIndex !== null) {
                          const to = dragOverLoadOrderIndex ?? draggedLoadOrderIndex;
                          moveLoadOrderItemTo(draggedLoadOrderIndex, to);
                        }
                        setDraggedLoadOrderIndex(null);
                        setDragOverLoadOrderIndex(null);
                        try {
                          event.currentTarget.releasePointerCapture(event.pointerId);
                        } catch {
                          /* capture may already be gone — harmless */
                        }
                      }}
                    >
                      <GripVertical size={14} />
                    </div>
                    <div className="gf-load-order-rank">{index + 1}</div>
                    <div className="gf-load-order-main">
                      <div className="gf-load-order-name">{mod.name}</div>
                      <div className="gf-load-order-meta">
                        <span>{mod.version}</span>
                        {mod.folder_name && <span>{mod.folder_name}</span>}
                        {!mod.enabled && <span>{t('profiles.loadOrder.disabled')}</span>}
                      </div>
                    </div>
                    <div className="gf-load-order-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => moveLoadOrderItem(index, -1)}
                        disabled={index === 0 || loadOrderSaving}
                        title={t('profiles.loadOrder.moveUp', { name: mod.name })}
                        aria-label={t('profiles.loadOrder.moveUp', { name: mod.name })}
                      >
                        <ArrowUp size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => moveLoadOrderItem(index, 1)}
                        disabled={index === loadOrderDraft.length - 1 || loadOrderSaving}
                        title={t('profiles.loadOrder.moveDown', { name: mod.name })}
                        aria-label={t('profiles.loadOrder.moveDown', { name: mod.name })}
                      >
                        <ArrowDown size={14} />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="gf-modal-foot">
            <Button variant="ghost" size="sm" onClick={closeLoadOrderEditor} disabled={loadOrderSaving}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleSaveLoadOrder} disabled={loadOrderSaving || loadOrderDraft.length === 0}>
              {loadOrderSaving ? <RefreshCw size={14} className="animate-spin" /> : <Save size={14} />}
              {t('profiles.loadOrder.save')}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="gf-body">
      {renderLoadOrderModal()}

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

      {/* Header — hidden on the Browse tab because BrowseModpacksView
          renders its own view-head and stacking two would crowd the
          page. Also hidden on the detail view so the per-modpack back
          button + title can take focus without a competing page head. */}
      {outerTab === 'yours' && selectedModpack === null && (
      <div className="gf-page-head">
        <div>
          <h1 className="gf-page-title">
            {t('profiles.page.title')}
            <HelpHint helpKey="modpackWhat" />
          </h1>
          <p className="gf-page-sub">
            {t('profiles.page.subtitle')}
          </p>
        </div>
        <div className="gf-page-actions">
          {/* The page-action buttons are modpack-management actions
              (create / import / snapshot). They only make sense on
              the Yours tab — the Browse tab is read-only. */}
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowImport(!showImport);
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
            // Open the guided wizard. Close any inline panels that
            // would otherwise compete for vertical space behind the
            // modal.
            setShowCreateWizard(true);
            setShowImport(false);
          }}>
            <Plus size={14} />
            {t('profiles.actions.newProfile')}
          </Button>
        </div>
      </div>
      )}

      {/* 1.7.0 v7 — always-visible Quick-Add code paste row.
          Relocated from Home (which is now the single-block launcher).
          The Modpacks toolbar already owns Create / Import-JSON /
          Snapshot, so Quick-Add lives here next to those affordances.
          Shown on the Yours tab — the Browse tab is for public packs
          which install via the row CTAs, not via a typed code.
          The toggle-able "Add modpack code" panel above remains for
          users who arrive via the button; both call the same
          handleImportFromCode pipeline.
          T16 — stays visible on the list view; hidden inside detail
          view so the detail header isn't competing for focus. */}
      {outerTab === 'yours' && selectedModpack === null && (
        <div
          ref={quickAddRowRef}
          className={`gf-quickadd${quickAddPulse ? ' gf-quickadd-pulse' : ''}`}
          style={{ marginTop: 0, marginBottom: 14 }}
        >
          <div className="gf-quickadd-eyebrow">{t('modpacks.quickAdd.label')}</div>
          <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
            <input
              ref={quickAddInputRef}
              className="gf-input-hero"
              aria-label={t('modpacks.quickAdd.label')}
              placeholder={t('modpacks.quickAdd.placeholder')}
              value={importCode}
              onChange={(e) => setImportCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleImportFromCode()}
              disabled={importingCode}
            />
            <Button
              size="sm"
              onClick={handleImportFromCode}
              disabled={importingCode || !importCode.trim()}
            >
              {importingCode ? (
                <RefreshCw size={14} className="animate-spin" />
              ) : (
                <Plus size={14} />
              )}
              {t('modpacks.quickAdd.addBtn')}
            </Button>
          </div>
        </div>
      )}

      {/* 1.7.0 — outer Yours/Browse tab strip. Hidden inside detail
          view (the detail's own back button drives navigation). */}
      {selectedModpack === null && (
        <div className="gf-tabs" style={{ marginBottom: 14 }}>
          <button
            className={`gf-tab ${outerTab === 'yours' ? 'active' : ''}`}
            onClick={() => setOuterTab('yours')}
          >
            {t('modpacks.tabs.yours')}
          </button>
          <button
            className={`gf-tab ${outerTab === 'browse' ? 'active' : ''}`}
            onClick={() => setOuterTab('browse')}
          >
            {t('modpacks.tabs.browse')}
          </button>
        </div>
      )}

      {/* Browse tab — public modpack browser absorbed from the old
          top-level sidebar entry. Wires the curator's "switch to your
          modpacks" CTA back to our Yours tab so the user stays inside
          the Modpacks surface. */}
      {selectedModpack === null && outerTab === 'browse' && (
        <BrowseModpacksView onGoToProfiles={() => setOuterTab('yours')} />
      )}

      {/* T16 — detail-view branch. When a modpack is selected the
          list area is replaced by ModpackDetail (Paradox-style
          drilldown). Reachable only from the Yours tab; clicking
          Back returns to the list. The orphan-modpack bounce-back
          (profile deleted while detail open) is handled by a
          useEffect above — render here is pure. */}
      {outerTab === 'yours' && selectedModpack !== null && !loading && (() => {
        const profile = profiles.find((p) => p.name === selectedModpack);
        // The effect above clears selectedModpack on the next tick when
        // the profile disappears; until that runs we render nothing so
        // we don't flash a stale view.
        if (!profile) return null;
        return (
          <ModpackDetail
            profile={profile}
            shareInfo={shareInfoMap[profile.name] ?? null}
            drift={driftMap[profile.name] ?? null}
            switchingProfile={switchingProfile}
            onBack={() => setSelectedModpack(null)}
            onSwitch={handleSwitch}
            onShare={(p) =>
              setPublishTarget({ profile: p, isReshare: !!shareInfoMap[p.name] })
            }
            onDelete={async (name) => {
              await handleDelete(name);
              // Bounce back to the list if we just deleted the open pack.
              if (name === selectedModpack) setSelectedModpack(null);
            }}
            onDuplicate={handleDuplicate}
            onExportJson={handleExport}
            onSnapshot={() => handleSnapshot()}
            onOpenLoadOrder={openLoadOrderEditor}
            onRepairDrift={handleRepairDrift}
            onLibraryChanged={handleLibraryChanged}
          />
        );
      })()}

      {outerTab === 'yours' && selectedModpack === null && (
        <>
      {/* Profile list filters (v5 batch 3) */}
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
            title={t('profiles.drift.repairTitle')}
            disabled={savingProfile !== null}
          >
            {t('profiles.drift.repair')}
          </Button>
        </div>
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
            onClick={() => loadProfiles()}
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
        // T16 — list view: clickable cards in a responsive grid.
        // Click a card to open its detail (Paradox-style drilldown).
        // Per-card action buttons (Share, Activate, kebab, etc.) are
        // gone from the list; they live inside the detail view now.
        // Active state, share state, drift, and pending-update hints
        // remain as compact card meta so the user can scan at a glance.
        <div className="gf-modpack-cards">
          {visible.map((profile) => {
            const isActive = activeProfile === profile.name;
            const isShared = !!shareInfoMap[profile.name];
            const hasDrift = !!driftMap[profile.name];
            const hasUpdate = subUpdates.some(
              (u) => u.profile_name === profile.name,
            );
            // T16 review fix — shared cards now host inline Copy chips
            // (share code / install link / share message). Because nested
            // <button> isn't valid HTML, the card itself is a div with
            // role="button" + keyboard handlers; the chips are real
            // buttons that stopPropagation so they don't navigate.
            return (
              <div
                key={profile.name}
                role="button"
                tabIndex={0}
                className={`gf-modpack-card ${isActive ? 'is-active' : ''}`}
                onClick={() => setSelectedModpack(profile.name)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedModpack(profile.name);
                  }
                }}
                aria-label={t('modpack.openDetailAria', { name: profile.name })}
              >
                <div className="gf-modpack-card-header">
                  <div className="gf-modpack-card-name">{profile.name}</div>
                  {isActive && (
                    <Badge variant="ok" ariaHidden>
                      {t('profiles.card.active')}
                    </Badge>
                  )}
                </div>
                <div className="gf-modpack-card-meta">
                  <span>{t('modpack.modCount', { count: profile.mods.length })}</span>
                  {profile.game_version && <span>{profile.game_version}</span>}
                  <span>
                    {new Date(profile.created_at).toLocaleDateString(i18n.language)}
                  </span>
                  {profile.created_by && (
                    <span className="text-primary">
                      {t('profiles.card.by', { name: profile.created_by })}
                    </span>
                  )}
                </div>
                <div className="gf-modpack-card-badges">
                  {hasUpdate && (
                    <Badge variant="update" ariaHidden>
                      {t('home.syncPillReady')}
                    </Badge>
                  )}
                  {isShared && (
                    <Badge variant="github" ariaHidden>
                      {t('modpack.shared')}
                    </Badge>
                  )}
                  {hasDrift && (
                    <span
                      className="gf-modpack-card-drift"
                      title={t('profiles.card.outOfSync')}
                    >
                      <AlertTriangle size={11} />
                      {t('profiles.card.outOfSync')}
                    </span>
                  )}
                  {isShared && (
                    <div
                      className="gf-modpack-card-copy-chips"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        className="gf-modpack-card-copy-chip"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCardCopy(profile.name, 'code');
                        }}
                        title={t('profiles.kebab.copyShareCode')}
                        aria-label={t('profiles.kebab.copyShareCode')}
                      >
                        <Copy size={12} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="gf-modpack-card-copy-chip"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCardCopy(profile.name, 'link');
                        }}
                        title={t('profiles.kebab.copyShareLink')}
                        aria-label={t('profiles.kebab.copyShareLink')}
                      >
                        <LinkIcon size={12} aria-hidden />
                      </button>
                      <button
                        type="button"
                        className="gf-modpack-card-copy-chip"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCardCopy(profile.name, 'msg');
                        }}
                        title={t('profiles.kebab.copyShareMessageLabel')}
                        aria-label={t('profiles.kebab.copyShareMessageLabel')}
                      >
                        <MessageSquare size={12} aria-hidden />
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        );
      })()}
        </>
      )}

      {showCreateWizard && (
        <CreateModpackWizard
          onClose={() => setShowCreateWizard(false)}
          onCreated={async ({ name, sharedNow }) => {
            // Close the wizard immediately so it doesn't sit on top of
            // the new pack's row, then refresh so the new manifest shows
            // up. If the user picked "Create and share now", hand off to
            // PublishModal once the list has the new row available.
            setShowCreateWizard(false);
            toastCtx.success(t('profiles.toast.created', { name }));
            await loadProfiles();
            if (sharedNow) {
              const fresh = await listProfiles().catch(() => [] as Profile[]);
              const profile = fresh.find((p) => p.name === name);
              if (profile) {
                setPublishTarget({ profile, isReshare: false });
              }
            }
          }}
        />
      )}

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
          // Share/Re-share enriches the saved profile manifest with bundle
          // URLs and listing state. Reload the profile list so the row shows
          // the persisted manifest immediately instead of waiting for a
          // navigation round-trip.
          loadProfiles();
        }}
      />
    </div>
  );
}
