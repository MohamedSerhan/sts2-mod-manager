import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { countGithubUpdates } from '../lib/auditState';
import { nexusFilesUrl } from '../lib/nexusUrl';
import {
  Search,
  Upload,
  Link,
  Trash2,
  Package,
  RefreshCw,
  FolderOpen,
  ToggleLeft,
  ToggleRight,
  X,
  ClipboardCheck,
  Download,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { ModRow } from '../components/ModRow';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmDialog';
import { SourceEditor } from '../components/SourceEditor';
import { HelpHint } from '../components/HelpHint';
import { BrowseView } from './Browse';
import type { ModInfo, ProfileMembershipGrid } from '../types';
import {
  toggleMod,
  deleteMod,
  deleteAllMods,
  installModFromFile,
  quickAddMod,
  enableAllMods,
  disableAllMods,
  openModsFolder,
  openExternalUrl,
  setModSource,
  setModSourcesFull,
  setModExtras,
  setModDisplayOverrides,
  setModSnooze,
  setModTags,
  findGithubFromNexus,
  getProfileMemberships,
  pinMod,
  unpinMod,
  repairMod,
  rollbackMod,
  updateMod,
} from '../hooks/useTauri';

function displayNameFor(mod: ModInfo): string {
  return mod.display_name?.trim() || mod.name;
}

function ghRepoFromUrl(url: string | null): string {
  if (!url) return '';
  const match = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/?#]+)/);
  if (match) return match[1].replace(/\.git$/, '');
  return url;
}

function cleanOptional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseManagerTags(input: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(',')) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((tag, index) => tag === b[index]);
}

type ModSortMode = 'nameAsc' | 'nameDesc' | 'enabledFirst' | 'disabledFirst' | 'largestFirst';

function compareModDisplayName(a: ModInfo, b: ModInfo): number {
  const byName = displayNameFor(a).localeCompare(displayNameFor(b), undefined, {
    sensitivity: 'base',
    numeric: true,
  });
  if (byName !== 0) return byName;
  return (a.folder_name ?? a.mod_id ?? a.name).localeCompare(b.folder_name ?? b.mod_id ?? b.name, undefined, {
    sensitivity: 'base',
    numeric: true,
  });
}

function sortMods(mods: ModInfo[], sortMode: ModSortMode): ModInfo[] {
  const sorted = [...mods];
  sorted.sort((a, b) => {
    if (sortMode === 'nameDesc') return compareModDisplayName(b, a);
    if (sortMode === 'enabledFirst') {
      const byEnabled = Number(b.enabled) - Number(a.enabled);
      return byEnabled || compareModDisplayName(a, b);
    }
    if (sortMode === 'disabledFirst') {
      const byDisabled = Number(a.enabled) - Number(b.enabled);
      return byDisabled || compareModDisplayName(a, b);
    }
    if (sortMode === 'largestFirst') {
      const bySize = b.size_bytes - a.size_bytes;
      return bySize || compareModDisplayName(a, b);
    }
    return compareModDisplayName(a, b);
  });
  return sorted;
}

interface ModsViewProps {
  /** 1.7.0 T17 — legacy advanced-mode toggle was removed when the
   *  per-row drawer absorbed source pills + Freeze/Delete disclosure.
   *  The prop is kept (unused) so older callers don't break, but it
   *  has no effect — Library is now uniformly "advanced". */
  advancedMode?: boolean;
  /** 1.7.0 T16 — handler for the "Manage active modpack →" bridge
   *  links. Routes the user to the Modpacks view with the active
   *  modpack's detail view auto-opened. Replaces the legacy
   *  onOpenModLibrary which routed to a now-removed standalone
   *  workspace. */
  onManageActiveModpack?: () => void;
  /** Forwarded to BrowseView's "Nexus key missing → open Settings"
   *  banner. Only consumed when the Browse tab is active. */
  onGoToSettings?: () => void;
  /** 1.7.0 — initial outer-tab selection. 'browse' lands users on the
   *  Browse-mods tab (the absorbed top-level view); 'installed' is
   *  the default and shows installed mods. Provided so the App shell
   *  can honor the legacy 'browse-mods' view-id as a redirect. */
  initialTab?: 'installed' | 'browse';
}

export function ModsView({ onManageActiveModpack, onGoToSettings, initialTab = 'installed' }: ModsViewProps = {}) {
  // 1.7.0 outer Installed/Browse tabs. 'installed' is the existing
  // Mods view content; 'browse' renders the public mod browser
  // (formerly its own sidebar entry).
  const [outerTab, setOuterTab] = useState<'installed' | 'browse'>(initialTab);
  // Reflect prop changes if App re-renders us with a new initialTab
  // (e.g. legacy 'browse-mods' view-id arrives via a deep-link).
  useEffect(() => {
    setOuterTab(initialTab);
  }, [initialTab]);
  const { t } = useTranslation();
  const { mods, refreshMods, refreshAll, gameRunning, gameInfo, notifyNexusOpen, auditResults, auditing, runAudit, refreshAuditEntries, updatingAll, updateAllGithub, activeProfile } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [filter, setFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [sortMode, setSortMode] = useState<ModSortMode>('nameAsc');
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAddUrl, setQuickAddUrl] = useState('');
  const [quickAdding, setQuickAdding] = useState(false);
  // 1.7.0 T17 — Library rows are now click-to-expand accordions. The
  // expanded set holds every row whose drawer is open (multi-expand;
  // power users routinely want to compare two rows side by side).
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
  // Per-row source editor opens inside the drawer. We track which row's
  // editor is currently open separately so a user can close the editor
  // without collapsing the row's drawer.
  const [sourceEditorRowKey, setSourceEditorRowKey] = useState<string | null>(null);
  const [savingSource, setSavingSource] = useState(false);
  const [findingGithub, setFindingGithub] = useState<string | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  // Per-row spinner state for inline Update button. Keyed by folder_name
  // (falling back to display name) so two same-named mods don't share
  // the spinner.
  const [updatingKey, setUpdatingKey] = useState<string | null>(null);

  // Map ROW KEY → audit row, for O(1) per-row lookup in render. The
  // row key is `folder_name ?? mod_name` — the same identity Mods view
  // uses for React keys / toggle dispatch — so two same-named mods don't
  // share the same audit entry (the CardArtEditor case). The audit
  // backend now carries folder_name on every entry, so this collapses
  // back to mod_name only when an audit row legitimately has no folder
  // (DLL-only mods scanned before 1.3.1, etc.).
  const auditByKey = useMemo(() => {
    const m = new Map<string, NonNullable<typeof auditResults>[number]>();
    if (auditResults) {
      for (const a of auditResults) {
        const key = a.folder_name ?? a.mod_name;
        m.set(key, a);
      }
    }
    return m;
  }, [auditResults]);

  // 1.7.0 — per-row "in this modpack" chip. We pull the full membership
  // grid (one round-trip) and look up each row by folder name / mod
  // name. The grid only matters when there's an active modpack — when
  // there isn't, we just skip the chip entirely. We re-fetch on the
  // installed-mods list changing because adding/removing a mod can
  // change which rows the grid covers.
  const [memberships, setMemberships] = useState<ProfileMembershipGrid | null>(null);
  useEffect(() => {
    if (!activeProfile) {
      setMemberships(null);
      return;
    }
    let cancelled = false;
    getProfileMemberships()
      .then((grid) => { if (!cancelled) setMemberships(grid); })
      .catch(() => { if (!cancelled) setMemberships(null); });
    return () => { cancelled = true; };
  }, [activeProfile, mods]);

  // Lookup: row → 'in' (included & enabled in active pack), 'includedOff'
  // (included but disabled in the pack overlay), 'notIn' (not in the
  // pack), or null (no active pack / no data — caller should skip the
  // chip). Index by folder_name first since two mods can share a display
  // name; fall back to mod name for legacy entries.
  const membershipByKey = useMemo(() => {
    const m = new Map<string, 'in' | 'includedOff' | 'notIn'>();
    if (!activeProfile || !memberships) return m;
    for (const row of memberships.mods) {
      const key = row.folder_name ?? row.name;
      const inActive = row.profiles.find((p) => p.profile_name === activeProfile);
      if (!inActive || !inActive.included) {
        m.set(key, 'notIn');
      } else if (inActive.enabled) {
        m.set(key, 'in');
      } else {
        m.set(key, 'includedOff');
      }
    }
    return m;
  }, [activeProfile, memberships]);

  async function handleCheckUpdates() {
    await runAudit();
  }

  async function handleInlineUpdate(name: string, folderName: string | null) {
    const key = folderName ?? name;
    if (updatingKey) return;
    setUpdatingKey(key);
    try {
      const info = await updateMod(name, folderName);
      toast.success(t('mods.toast.updated', { name, version: info.version }));
      await refreshAll();
      // Targeted re-audit: cover both the requested name and any rename
      // the install produced (same approach Settings uses).
      const names = info.name !== name ? [name, info.name] : [name];
      await refreshAuditEntries(names);
    } catch (e) {
      const updateErrMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('mods.toast.updateFailed', { name, error: updateErrMsg }));
    } finally {
      setUpdatingKey(null);
    }
  }

  function toggleExpand(rowKey: string): void {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) {
        next.delete(rowKey);
        // Closing a row closes its source editor too. Otherwise the
        // editor would silently stay "open" for a row whose drawer is
        // no longer visible, which surprises the user when they re-
        // expand the row and the editor's already loaded.
        if (sourceEditorRowKey === rowKey) setSourceEditorRowKey(null);
      } else {
        next.add(rowKey);
      }
      return next;
    });
  }

  function openSourceEditor(rowKey: string): void {
    setExpandedRows((prev) => {
      // Make sure the drawer is open when the user requests Edit Sources
      // from the kebab — the source editor sits inside the drawer, so
      // opening it without opening the drawer would silently fail.
      if (prev.has(rowKey)) return prev;
      const next = new Set(prev);
      next.add(rowKey);
      return next;
    });
    setSourceEditorRowKey(rowKey);
  }

  const totalCount = mods.length;
  const enabledCount = mods.filter((m) => m.enabled).length;
  const disabledCount = mods.filter((m) => !m.enabled).length;

  async function handleToggle(name: string, folderName: string | null, enable: boolean) {
    try {
      await toggleMod(name, folderName, enable);
      await refreshMods();
      toast.success(enable ? t('mods.toast.enabled', { name }) : t('mods.toast.disabled', { name }));
    } catch (e) {
      toast.error(t('mods.toast.toggleFailed', { name, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleTogglePin(name: string, folderName: string | null, pinned: boolean) {
    try {
      if (pinned) {
        await unpinMod(name, folderName);
        toast.success(t('mods.toast.unpinned', { name }));
      } else {
        await pinMod(name, folderName);
        toast.success(t('mods.toast.pinned', { name }));
      }
      await refreshMods();
    } catch (e) {
      const action = pinned ? t('mods.toast.unpinAction') : t('mods.toast.pinAction');
      toast.error(t('mods.toast.pinFailed', { action, name, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  // Force-reinstall a single mod from its linked GitHub source. Used to
  // recover from broken installs (manifest fails to parse, version reads
  // 'unknown', game won't load it). Confirms first because it nukes the
  // current on-disk install before re-extracting.
  const [repairingMod, setRepairingMod] = useState<string | null>(null);
  const [rollingBackMod, setRollingBackMod] = useState<string | null>(null);
  async function handleRepair(name: string, folderName: string | null, hasGithub: boolean) {
    // uncovered: this guard is defensive — the kebab item is independently
    // disabled when github_url is null (see ModRow render), so no UI path
    // reaches it. Covered indirectly by the "kebab disabled" test instead.
    if (!hasGithub) {
      toast.error(t('mods.toast.repairNoGithub', { name }));
      return;
    }
    const ok = await confirm({
      title: t('mods.repairConfirmTitle', { name }),
      body: t('mods.repairConfirmBody'),
      confirmLabel: t('mods.repairNow'),
    });
    if (!ok) return;
    // Track the in-progress repair by folder key so the spinner shows on
    // the exact row when two mods share a display name.
    const repairKey = folderName ?? name;
    setRepairingMod(repairKey);
    try {
      const info = await repairMod(name, folderName);
      toast.success(t('mods.toast.repaired', { name: info.name, version: info.version }));
      await refreshAll();
    } catch (e) {
      const repairErrMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('mods.toast.repairFailed', { name, error: repairErrMsg }));
    } finally {
      setRepairingMod(null);
    }
  }

  async function handleRollback(name: string, folderName: string | null, hasGithub: boolean) {
    // The kebab item is `disabled={!github_url}` so React refuses to
    // dispatch onClick when there's no source. This guard is a defensive
    // safety net for direct callers and is unreachable via the UI, hence
    // the v8 ignore directive (same pattern as DiagnosticBundle's
    // re-entrancy guard).
    /* v8 ignore start */
    if (!hasGithub) {
      toast.error(t('mods.rollbackNoSource', { name }));
      return;
    }
    /* v8 ignore stop */
    const ok = await confirm({
      title: t('mods.rollbackConfirmTitle', { name }),
      body: t('mods.rollbackConfirmBody'),
      warning: t('mods.rollbackConfirmWarning'),
      confirmLabel: t('mods.rollbackNow'),
    });
    if (!ok) return;
    const rollbackKey = folderName ?? name;
    setRollingBackMod(rollbackKey);
    try {
      const info = await rollbackMod(name, folderName);
      toast.success(t('mods.toast.rolledBack', { name: info.name, version: info.version }));
      await refreshAll();
      const names = info.name !== name ? [name, info.name] : [name];
      await refreshAuditEntries(names);
    } catch (e) {
      toast.error(t('mods.toast.rollbackFailed', { name, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRollingBackMod(null);
    }
  }

  async function handleDelete(name: string, folderName: string | null) {
    const ok = await confirm({
      title: t('mods.deleteConfirmTitle', { name }),
      body: t('mods.deleteConfirmBody'),
      confirmLabel: t('mods.delete'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteMod(name, folderName);
      await refreshMods();
      toast.success(t('mods.toast.deleted', { name }));
    } catch (e) {
      const delErrMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('mods.toast.deleteFailed', { name, error: delErrMsg }));
    }
  }

  async function handleImportFile() {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: t('mods.importArchiveFilter'), extensions: ['zip', '7z', 'rar'] }],
      });
      if (!selected) return;
      const path = typeof selected === 'string' ? selected : selected;
      const mod = await installModFromFile(path);
      await refreshAll();
      toast.success(t('mods.toast.installed', { name: mod.name }));
    } catch (e) {
      const impErrMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('mods.toast.importFailed', { error: impErrMsg }));
    }
  }

  async function handleQuickAdd() {
    if (!quickAddUrl.trim()) return;
    const input = quickAddUrl.trim();
    try {
      setQuickAdding(true);
      const result = await quickAddMod(input);
      if (result.type === 'github_installed') {
        await refreshAll();
        toast.success(t('mods.toast.installed', { name: result.mod_info.name }));
      } else {
        const filesUrl = nexusFilesUrl(input);
        if (filesUrl) {
          await openExternalUrl(filesUrl);
          // Sticky toast — dismissed when the downloads watcher reports
          // an install or after a 10-min fail-safe.
          notifyNexusOpen(result.nexus_info.name || t('quickAdd.nexusMod'));
        } else {
          toast.info(t('mods.toast.foundNexusMod', { name: result.nexus_info.name || t('quickAdd.unknown') }));
        }
      }
      setQuickAddUrl('');
      setShowQuickAdd(false);
    } catch (e) {
      const qaErrMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('mods.toast.quickAddFailed', { error: qaErrMsg }));
    } finally {
      setQuickAdding(false);
    }
  }

  async function handleEnableAll() {
    try {
      await enableAllMods();
      await refreshMods();
      toast.success(t('mods.toast.allEnabled'));
    } catch (e) {
      toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleDisableAll() {
    try {
      await disableAllMods();
      await refreshMods();
      toast.success(t('mods.toast.allDisabled'));
    } catch (e) {
      toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleDeleteAll() {
    const ok = await confirm({
      title: t('mods.deleteAllConfirmTitle', { count: mods.length }),
      body: t('mods.deleteAllConfirmBody'),
      warning: t('mods.deleteAllConfirmWarning'),
      confirmLabel: t('mods.deleteEverything'),
      destructive: true,
      typedPhrase: 'delete all',
    });
    if (!ok) return;
    try {
      const deleted = await deleteAllMods();
      await refreshAll();
      toast.success(t('mods.toast.deletedMultiple', { count: deleted }));
    } catch (e) {
      toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleOpenFolder() {
    try {
      await openModsFolder();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleClearSource(modName: string, folderName: string | null) {
    try {
      await setModSource(modName, '', folderName);
      await refreshMods();
      toast.info(t('mods.toast.sourceCleared', { name: modName }));
    } catch (e) {
      toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  const filtered = useMemo(() => {
    const term = filter.trim().toLowerCase();
    const tagKey = tagFilter.toLocaleLowerCase();
    const visible = mods.filter((m) => {
      const tags = m.tags ?? [];
      const tagMatched = !tagKey || tags.some((tag) => tag.toLocaleLowerCase() === tagKey);
      if (!tagMatched) return false;
      if (!term) return true;
      return displayNameFor(m).toLowerCase().includes(term)
        || m.name.toLowerCase().includes(term)
        || (m.folder_name?.toLowerCase().includes(term) ?? false)
        || tags.some((tag) => tag.toLowerCase().includes(term));
    });
    return sortMods(visible, sortMode);
  }, [mods, filter, tagFilter, sortMode]);

  const tagOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const mod of mods) {
      for (const tag of mod.tags ?? []) {
        const trimmed = tag.trim();
        if (!trimmed) continue;
        const key = trimmed.toLocaleLowerCase();
        if (!seen.has(key)) seen.set(key, trimmed);
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, {
      sensitivity: 'base',
      numeric: true,
    }));
  }, [mods]);

  // Display names that appear on more than one installed mod. These rows
  // get a folder/author subtitle so the user can tell two same-named
  // mods apart (e.g. two CardArtEditor installs in different folders).
  const duplicateNames = new Set<string>();
  {
    const seen = new Set<string>();
    for (const m of mods) {
      const displayName = displayNameFor(m);
      if (seen.has(displayName)) duplicateNames.add(displayName);
      seen.add(displayName);
    }
  }

  return (
    <div className="gf-body">
      {/* Header — only on the Installed tab. The Browse tab's
          BrowseView component renders its own page-head, so we'd
          stack two headers if this stayed unconditional. */}
      {outerTab === 'installed' && (
      <div className="gf-page-head">
        <div>
          {/* 1.7.0 — heading reframed from "Your mods" to "All installed
              mods" so users don't read it as "the active modpack's mods".
              A real user (Solo) hit that confusion repeatedly. The
              subtitle below the count clarifies the relationship between
              this screen and the active modpack, and the link routes
              over to the modpack mod-library workspace where the per-
              pack membership lives. */}
          <h1 className="gf-page-title">{t('mods.allInstalledTitle')}</h1>
          <p className="gf-page-sub">
            {t('mods.subtitle', { total: totalCount, enabled: enabledCount, disabled: disabledCount > 0 ? t('mods.subtitleDisabledSuffix', { count: disabledCount }) : '' })}
          </p>
          <p className="gf-page-sub">
            {t('mods.allInstalledSubtitle')}
            <HelpHint helpKey="storedMeaning" />
          </p>
          {onManageActiveModpack && (
            <button
              type="button"
              className="gf-link-button"
              onClick={onManageActiveModpack}
            >
              {t('mods.manageActiveModpackLink')}
            </button>
          )}
        </div>
        <div className="gf-page-actions">
          <Button variant="secondary" size="sm" onClick={handleOpenFolder}>
            <FolderOpen size={14} />
            {t('mods.openFolder')}
          </Button>
          <Button variant="secondary" size="sm" onClick={handleImportFile} disabled={gameRunning}>
            <Upload size={14} />
            {t('mods.importMod')}
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setShowQuickAdd(!showQuickAdd)} disabled={gameRunning}>
            <Link size={14} />
            {t('mods.quickAddUrl')}
          </Button>
          {(() => {
            const ghUpdateCount = auditResults ? countGithubUpdates(auditResults) : 0;
            const ghUpdateNames = auditResults
              ? auditResults
                  .filter(r => r.needs_update && !r.snoozed && r.github_repo && r.latest_release_with_assets_tag)
                  .map(r => r.mod_name)
              : [];

            if (auditing) {
              return (
                <Button variant="secondary" size="sm" disabled title={t('mods.checking')}>
                  <ClipboardCheck size={14} className="animate-pulse" />
                  {t('mods.audit.running')}
                </Button>
              );
            }

            if (updatingAll) {
              return (
                <Button variant="primary" size="sm" disabled>
                  <RefreshCw size={14} className="animate-spin" />
                  {t('mods.updatingCount', { count: ghUpdateCount })}
                </Button>
              );
            }

            if (auditResults === null) {
              return (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCheckUpdates}
                  title={t('mods.checkForUpdates')}
                >
                  <ClipboardCheck size={14} />
                  {t('mods.audit.run')}
                  <Badge variant="beta" ariaHidden>{t('common.beta')}</Badge>
                </Button>
              );
            }

            if (ghUpdateCount === 0) {
              return (
                <>
                  <span
                    className="gf-pill gf-pill-ok gf-pill-toolbar"
                    title={t('mods.allUpToDate')}
                  >
                    {t('mods.audit.upToDate')}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCheckUpdates}
                    title={t('mods.reaudit')}
                    aria-label={t('mods.reaudit')}
                  >
                    <RefreshCw size={14} />
                  </Button>
                </>
              );
            }

            return (
              <>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => updateAllGithub(ghUpdateNames)}
                  title={t('mods.updateAllTitle')}
                >
                  <Download size={14} />
                  {t('mods.updateAllLabel', { count: ghUpdateCount })}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCheckUpdates}
                  title={t('mods.reaudit')}
                  aria-label={t('mods.reaudit')}
                >
                  <RefreshCw size={14} />
                </Button>
              </>
            );
          })()}
          <Button size="sm" onClick={async () => {
            setRefreshing(true);
            try { await refreshMods(); }
            finally { setRefreshing(false); }
          }} disabled={refreshing}>
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? t('common.refreshing') : t('common.refresh')}
          </Button>
          {/* T16 review fix — toolbar "Mod Library" button removed.
              It was a redundant + misleading entry point: the label
              described the dead cross-profile workspace, and the page
              header already exposes the same `onManageActiveModpack`
              handler via a clearer "Manage active modpack →" link.
              Keeping only the page-header link removes the duplicate
              affordance and the stale copy. */}
        </div>
      </div>
      )}

      {/* 1.7.0 — outer Installed/Browse tab strip. 'browse' renders
          the public mod browser absorbed from the old top-level
          sidebar entry. */}
      <div className="gf-tabs" style={{ marginBottom: 14 }}>
        <button
          className={`gf-tab ${outerTab === 'installed' ? 'active' : ''}`}
          onClick={() => setOuterTab('installed')}
        >
          {t('library.tabs.installed')}
        </button>
        <button
          className={`gf-tab ${outerTab === 'browse' ? 'active' : ''}`}
          onClick={() => setOuterTab('browse')}
        >
          {t('library.tabs.browse')}
        </button>
      </div>

      {outerTab === 'browse' && <BrowseView onGoToSettings={onGoToSettings} />}

      {outerTab === 'installed' && (
        <>
      {/* Quick Add URL Form — shown when the user clicks the toolbar
          Quick-Add button. The advanced-mode gate was removed in T17. */}
      {showQuickAdd && (
        <Card className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="text-sm text-text-muted block mb-1.5">
              {t('mods.quickAddLabel')}
            </label>
            <input
              type="text"
              value={quickAddUrl}
              onChange={(e) => setQuickAddUrl(e.target.value)}
              placeholder={t('mods.quickAddPlaceholder')}
              className="w-full bg-background border border-border rounded-lg px-4 py-2.5 text-sm text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50"
              onKeyDown={(e) => e.key === 'Enter' && handleQuickAdd()}
              disabled={quickAdding}
            />
          </div>
          <Button size="sm" onClick={handleQuickAdd} disabled={quickAdding}>
            {quickAdding ? t('mods.adding') : t('mods.add')}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowQuickAdd(false)}>
            <X size={14} />
          </Button>
        </Card>
      )}

      {/* Search / Filter + Bulk Actions */}
      <div className="gf-toolbar">
        <div className="gf-search" style={{ maxWidth: 380 }}>
          <Search size={14} style={{ color: 'var(--ink-dim)' }} />
          <input
            type="text"
            placeholder={t('mods.searchPlaceholder', { count: totalCount })}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        <label className="gf-sort-control">
          <span>{t('mods.sort.label')}</span>
          <select
            aria-label={t('mods.sort.label')}
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as ModSortMode)}
          >
            <option value="nameAsc">{t('mods.sort.nameAsc')}</option>
            <option value="nameDesc">{t('mods.sort.nameDesc')}</option>
            <option value="enabledFirst">{t('mods.sort.enabledFirst')}</option>
            <option value="disabledFirst">{t('mods.sort.disabledFirst')}</option>
            <option value="largestFirst">{t('mods.sort.largestFirst')}</option>
          </select>
        </label>
        {tagOptions.length > 0 && (
          <label className="gf-sort-control">
            <span>{t('mods.tags.label')}</span>
            <select
              aria-label={t('mods.tags.label')}
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
            >
              <option value="">{t('mods.tags.all')}</option>
              {tagOptions.map((tag) => (
                <option key={tag} value={tag}>{tag}</option>
              ))}
            </select>
          </label>
        )}
        <div className="gf-sort-note">{t('mods.sort.visualOnly')}</div>
        {mods.length > 0 && (
          <div className="flex gap-1.5">
            <Button variant="ghost" size="sm" onClick={handleEnableAll} disabled={gameRunning} title={gameRunning ? t('mods.closeSts2First') : t('mods.enableAll')}>
              <ToggleRight size={14} />
              {t('mods.enableAll')}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleDisableAll} disabled={gameRunning} title={gameRunning ? t('mods.closeSts2First') : t('mods.disableAll')}>
              <ToggleLeft size={14} />
              {t('mods.disableAll')}
            </Button>
            <Button variant="danger" size="sm" onClick={handleDeleteAll} disabled={gameRunning} title={gameRunning ? t('mods.closeSts2First') : t('mods.deleteAll')}>
              <Trash2 size={14} />
              {t('mods.deleteAll')}
            </Button>
          </div>
        )}
      </div>

      {/* Mod List */}
      {filtered.length === 0 ? (
        <div className="gf-empty">
          <div className="gf-empty-art"><Package size={28} /></div>
          <div className="gf-empty-title">
            {mods.length === 0 ? t('mods.empty') : t('mods.noMatch')}
          </div>
          <div className="gf-empty-sub">
            {mods.length === 0
              ? t('mods.emptyDescription')
              : t('mods.noMatchSub')}
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map((mod) => {
            // Row key uses folder_name when present — two mods sharing a
            // display name MUST have distinct keys or React will fuse them.
            const rowKey = mod.folder_name ?? mod.name;
            const displayName = displayNameFor(mod);
            const isDuplicate = duplicateNames.has(displayName);
            // When two mods share a display name, show a subtitle so the
            // user can tell them apart. Prefer author, fall back to the
            // on-disk folder name.
            const disambiguator = isDuplicate
              ? (mod.author?.trim() || mod.folder_name || null)
              : null;
            // Audit row for this mod (if an audit has been run). Lookup
            // is folder-first so two same-named mods get distinct audit
            // rows (the CardArtEditor case).
            const auditRow = auditByKey.get(rowKey) ?? auditByKey.get(mod.name);
            // 1.7.0 — membership chip is sourced from the active modpack's
            // membership grid. Null = no active modpack OR no row for this
            // mod (newly installed since the grid was fetched), and we skip
            // the chip in both cases.
            const membership = membershipByKey.get(rowKey) ?? membershipByKey.get(mod.name) ?? null;
            const expanded = expandedRows.has(rowKey);
            const editingSources = sourceEditorRowKey === rowKey;
            return (
              <ModRow
                key={rowKey}
                mod={mod}
                disambiguator={disambiguator}
                audit={auditRow}
                membership={membership}
                gameRunning={gameRunning}
                gameVersion={gameInfo?.game_version}
                isUpdating={updatingKey === rowKey}
                isRepairing={repairingMod === rowKey}
                isRollingBack={rollingBackMod === rowKey}
                anyUpdating={updatingKey !== null}
                anyRecoveryInFlight={repairingMod !== null || rollingBackMod !== null}
                expanded={expanded}
                onToggleExpand={() => toggleExpand(rowKey)}
                onToggleStorage={() => handleToggle(mod.name, mod.folder_name, !mod.enabled)}
                onTogglePin={() => handleTogglePin(mod.name, mod.folder_name, mod.pinned)}
                onCopyVersion={() => {
                  navigator.clipboard.writeText(mod.version).then(
                    () => toast.success(t('mods.toast.versionCopied', { version: mod.version })),
                    () => toast.error(t('mods.toast.couldNotCopy')),
                  );
                }}
                onOpenModsFolder={handleOpenFolder}
                onEditSources={() => openSourceEditor(rowKey)}
                onFindGithubFromNexus={async () => {
                  try {
                    setFindingGithub(rowKey);
                    const repo = await findGithubFromNexus(mod.name, mod.folder_name);
                    if (repo) {
                      await refreshMods();
                      toast.success(t('mods.toast.foundGitHub', { repo }));
                    } else {
                      toast.info(t('mods.toast.noGitHubInNexus', { name: mod.name }));
                    }
                  } catch (e) {
                    toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
                  } finally {
                    setFindingGithub(null);
                  }
                }}
                onSnooze={async () => {
                  try {
                    await setModSnooze(
                      mod.name,
                      auditRow?.latest_release_with_assets_tag ?? null,
                      mod.folder_name,
                    );
                    await refreshAuditEntries([mod.name]);
                    toast.success(t('mods.toast.snoozed', { name: mod.name }));
                  } catch (e) {
                    toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
                  }
                }}
                onUnsnooze={async () => {
                  try {
                    await setModSnooze(mod.name, null, mod.folder_name);
                    await refreshAuditEntries([mod.name]);
                    toast.success(t('mods.toast.unsnoozed', { name: mod.name }));
                  } catch (e) {
                    toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
                  }
                }}
                onRepair={() => handleRepair(mod.name, mod.folder_name, !!mod.github_url)}
                onRollback={() => handleRollback(mod.name, mod.folder_name, !!mod.github_url)}
                onDelete={() => handleDelete(mod.name, mod.folder_name)}
                onUpdate={() => handleInlineUpdate(mod.name, mod.folder_name)}
                onOpenExternalUrl={(url) => {
                  // Nexus URL clicks ALSO arm the downloads watcher
                  // toast so the user knows we'll auto-install the zip
                  // when it lands in their Downloads folder. Same logic
                  // as the legacy inline Nexus update pill.
                  if (mod.nexus_url && url === mod.nexus_url) {
                    notifyNexusOpen(mod.name);
                  }
                  openExternalUrl(url).catch(() => {});
                }}
                sourceEditorSlot={editingSources ? (
                  <SourceEditor
                    mod={mod}
                    findingGithub={findingGithub === rowKey}
                    onClose={() => setSourceEditorRowKey(null)}
                    onClear={() => handleClearSource(mod.name, mod.folder_name)}
                    onFindGithub={async () => {
                      try {
                        setFindingGithub(rowKey);
                        const repo = await findGithubFromNexus(mod.name, mod.folder_name);
                        if (repo) {
                          await refreshMods();
                          toast.success(t('mods.toast.foundGitHub', { repo }));
                        } else {
                          toast.info(t('mods.toast.noGitHubInNexus', { name: mod.name }));
                        }
                      } catch (e) {
                        toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
                      } finally {
                        setFindingGithub(null);
                      }
                    }}
                    onSave={async (gh, nx, note, customUrl, displayName, displayDescription, tagsInput) => {
                      try {
                        setSavingSource(true);
                        // Two separate commands by design: setModSourcesFull
                        // owns the GitHub/Nexus link fields (clearing nulls
                        // clears those links), setModExtras owns the
                        // free-form note + custom URL. They write to the
                        // same source entry but don't clobber each other.
                        const nextGithub = cleanOptional(gh);
                        const nextNexus = cleanOptional(nx);
                        if (
                          nextGithub !== (cleanOptional(ghRepoFromUrl(mod.github_url)))
                          || nextNexus !== (mod.nexus_url ?? null)
                        ) {
                          await setModSourcesFull(mod.name, nextGithub, nextNexus, mod.folder_name);
                        }

                        const nextNote = cleanOptional(note);
                        const nextCustomUrl = cleanOptional(customUrl);
                        if (
                          nextNote !== (mod.note ?? null)
                          || nextCustomUrl !== (mod.custom_url ?? null)
                        ) {
                          await setModExtras(mod.name, nextNote, nextCustomUrl, mod.folder_name);
                        }

                        const nextDisplayName = cleanOptional(displayName);
                        const nextDisplayDescription = cleanOptional(displayDescription);
                        if (
                          nextDisplayName !== (mod.display_name ?? null)
                          || nextDisplayDescription !== (mod.display_description ?? null)
                        ) {
                          await setModDisplayOverrides(
                            mod.name,
                            nextDisplayName,
                            nextDisplayDescription,
                            mod.folder_name,
                          );
                        }

                        const nextTags = parseManagerTags(tagsInput);
                        if (!sameTags(nextTags, mod.tags ?? [])) {
                          await setModTags(mod.name, nextTags, mod.folder_name);
                        }
                        await refreshMods();
                        toast.success(t('mods.toast.sourcesSaved', { name: displayNameFor(mod) }));
                        setSourceEditorRowKey(null);
                      } catch (e) {
                        toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
                      } finally {
                        setSavingSource(false);
                      }
                    }}
                    saving={savingSource}
                  />
                ) : undefined}
              />
            );
          })}
        </div>
      )}
        </>
      )}
    </div>
  );
}
