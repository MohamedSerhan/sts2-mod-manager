import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { countGithubUpdates } from '../lib/auditState';
import { nexusFilesUrl } from '../lib/nexusUrl';
import {
  Upload,
  Link,
  Trash2,
  RefreshCw,
  FolderOpen,
  ToggleLeft,
  ToggleRight,
  X,
  ClipboardCheck,
  Download,
  Search,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { LibraryTable } from '../components/LibraryTable';
import { AutoDetectModal } from '../components/AutoDetectModal';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmDialog';
import { SourceEditor } from '../components/SourceEditor';
import { HelpHint } from '../components/HelpHint';
import { BrowseView } from './Browse';
import type { ModInfo, ProfileMembershipMod } from '../types';
import {
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

interface ModsViewProps {
  /** 1.7.0 T17 — legacy advanced-mode toggle was removed when the
   *  per-row drawer absorbed source pills + Freeze/Delete disclosure.
   *  The prop is kept (unused) so older callers don't break, but it
   *  has no effect — Library is now uniformly "advanced". */
  advancedMode?: boolean;
  /** 1.7.0 T16 — handler for the "Manage active modpack →" bridge
   *  links. Routes the user to the Modpacks view with the active
   *  modpack's detail view auto-opened. */
  onManageActiveModpack?: () => void;
  /** Forwarded to BrowseView's "Nexus key missing → open Settings"
   *  banner. Only consumed when the Browse tab is active. */
  onGoToSettings?: () => void;
  /** 1.7.0 — initial outer-tab selection. 'browse' lands users on the
   *  Browse-mods tab (the absorbed top-level view); 'installed' is
   *  the default and shows installed mods. */
  initialTab?: 'installed' | 'browse';
}

export function ModsView({ onManageActiveModpack, onGoToSettings, initialTab = 'installed' }: ModsViewProps = {}) {
  // 1.7.0 outer Installed/Browse tabs.
  const [outerTab, setOuterTab] = useState<'installed' | 'browse'>(initialTab);
  useEffect(() => {
    setOuterTab(initialTab);
  }, [initialTab]);
  const { t } = useTranslation();
  const {
    mods,
    refreshMods,
    refreshAll,
    gameRunning,
    gameInfo,
    notifyNexusOpen,
    auditResults,
    auditing,
    runAudit,
    refreshAuditEntries,
    updatingAll,
    updateAllGithub,
    activeProfile,
  } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [tagFilter, setTagFilter] = useState('');
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [showAutoDetect, setShowAutoDetect] = useState(false);
  const [quickAddUrl, setQuickAddUrl] = useState('');
  const [quickAdding, setQuickAdding] = useState(false);
  // Per-row source editor opens inside the row's slot. The Library view
  // owns which row's editor is open so the LibraryTable callbacks can
  // drive it without coupling the table to a SourceEditor.
  const [sourceEditorRowKey, setSourceEditorRowKey] = useState<string | null>(null);
  const [savingSource, setSavingSource] = useState(false);
  const [findingGithub, setFindingGithub] = useState<string | null>(null);

  const [refreshing, setRefreshing] = useState(false);
  // Per-row spinner state for inline Update button. Keyed by folder_name
  // (falling back to display name) so two same-named mods don't share
  // the spinner.
  const [updatingKey, setUpdatingKey] = useState<string | null>(null);
  const [repairingKey, setRepairingKey] = useState<string | null>(null);
  const [rollingBackKey, setRollingBackKey] = useState<string | null>(null);

  // Map ROW KEY → audit row, for O(1) per-row lookup in render. The
  // row key is `folder_name ?? mod_name` so two same-named mods don't
  // share the same audit entry (the CardArtEditor case).
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

  // ModInfo lookup by row key — LibraryTable threads this through to
  // LibraryRow's kebab so the menu can read github_url, tags, pinned,
  // etc. without re-fetching.
  const modInfoByKey = useMemo(() => {
    const m = new Map<string, ModInfo>();
    for (const mod of mods) {
      const key = mod.folder_name ?? mod.name;
      m.set(key, mod);
    }
    return m;
  }, [mods]);

  async function handleCheckUpdates() {
    await runAudit();
  }

  async function handleInlineUpdate(mod: ModInfo) {
    const key = mod.folder_name ?? mod.name;
    if (updatingKey) return;
    setUpdatingKey(key);
    try {
      const info = await updateMod(mod.name, mod.folder_name);
      toast.success(t('mods.toast.updated', { name: mod.name, version: info.version }));
      await refreshAll();
      // Targeted re-audit: cover both the requested name and any rename
      // the install produced (same approach Settings uses).
      const names = info.name !== mod.name ? [mod.name, info.name] : [mod.name];
      await refreshAuditEntries(names);
    } catch (e) {
      const updateErrMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('mods.toast.updateFailed', { name: mod.name, error: updateErrMsg }));
    } finally {
      setUpdatingKey(null);
    }
  }

  async function handleTogglePin(mod: ModInfo) {
    try {
      if (mod.pinned) {
        await unpinMod(mod.name, mod.folder_name);
        toast.success(t('mods.toast.unpinned', { name: mod.name }));
      } else {
        await pinMod(mod.name, mod.folder_name);
        toast.success(t('mods.toast.pinned', { name: mod.name }));
      }
      await refreshMods();
    } catch (e) {
      const action = mod.pinned ? t('mods.toast.unpinAction') : t('mods.toast.pinAction');
      toast.error(t('mods.toast.pinFailed', { action, name: mod.name, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleRepair(mod: ModInfo) {
    // The kebab item is independently disabled when github_url is null
    // (see LibraryRow), so this guard is a defensive no-op for direct
    // callers and is unreachable via the UI.
    /* v8 ignore start */
    if (!mod.github_url) {
      toast.error(t('mods.toast.repairNoGithub', { name: mod.name }));
      return;
    }
    /* v8 ignore stop */
    const ok = await confirm({
      title: t('mods.repairConfirmTitle', { name: mod.name }),
      body: t('mods.repairConfirmBody'),
      confirmLabel: t('mods.repairNow'),
    });
    if (!ok) return;
    const key = mod.folder_name ?? mod.name;
    setRepairingKey(key);
    try {
      const info = await repairMod(mod.name, mod.folder_name);
      toast.success(t('mods.toast.repaired', { name: info.name, version: info.version }));
      await refreshAll();
    } catch (e) {
      const repairErrMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('mods.toast.repairFailed', { name: mod.name, error: repairErrMsg }));
    } finally {
      setRepairingKey(null);
    }
  }

  async function handleRollback(mod: ModInfo) {
    /* v8 ignore start */
    if (!mod.github_url) {
      toast.error(t('mods.rollbackNoSource', { name: mod.name }));
      return;
    }
    /* v8 ignore stop */
    const ok = await confirm({
      title: t('mods.rollbackConfirmTitle', { name: mod.name }),
      body: t('mods.rollbackConfirmBody'),
      warning: t('mods.rollbackConfirmWarning'),
      confirmLabel: t('mods.rollbackNow'),
    });
    if (!ok) return;
    const key = mod.folder_name ?? mod.name;
    setRollingBackKey(key);
    try {
      const info = await rollbackMod(mod.name, mod.folder_name);
      toast.success(t('mods.toast.rolledBack', { name: info.name, version: info.version }));
      await refreshAll();
      const names = info.name !== mod.name ? [mod.name, info.name] : [mod.name];
      await refreshAuditEntries(names);
    } catch (e) {
      toast.error(t('mods.toast.rollbackFailed', { name: mod.name, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRollingBackKey(null);
    }
  }

  async function handleDelete(mod: ModInfo) {
    const ok = await confirm({
      title: t('mods.deleteConfirmTitle', { name: mod.name }),
      body: t('mods.deleteConfirmBody'),
      confirmLabel: t('mods.delete'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteMod(mod.name, mod.folder_name);
      await refreshMods();
      toast.success(t('mods.toast.deleted', { name: mod.name }));
    } catch (e) {
      const delErrMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('mods.toast.deleteFailed', { name: mod.name, error: delErrMsg }));
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

  async function handleCopyVersion(mod: ModInfo) {
    try {
      await navigator.clipboard.writeText(mod.version);
      toast.success(t('mods.toast.versionCopied', { version: mod.version }));
    } catch {
      toast.error(t('mods.toast.couldNotCopy'));
    }
  }

  async function handleFindGithubFromNexus(mod: ModInfo) {
    const key = mod.folder_name ?? mod.name;
    try {
      setFindingGithub(key);
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
  }

  async function handleSnooze(mod: ModInfo, auditTag: string | null) {
    try {
      await setModSnooze(mod.name, auditTag, mod.folder_name);
      await refreshAuditEntries([mod.name]);
      toast.success(t('mods.toast.snoozed', { name: mod.name }));
    } catch (e) {
      toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleUnsnooze(mod: ModInfo) {
    try {
      await setModSnooze(mod.name, null, mod.folder_name);
      await refreshAuditEntries([mod.name]);
      toast.success(t('mods.toast.unsnoozed', { name: mod.name }));
    } catch (e) {
      toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  function handleOpenExternalUrl(url: string, mod: ModInfo) {
    // Nexus URL clicks ALSO arm the downloads watcher toast so the user
    // knows we'll auto-install the zip when it lands in their Downloads
    // folder. Same logic as the legacy inline Nexus update pill.
    if (mod.nexus_url && url === mod.nexus_url) {
      notifyNexusOpen(mod.name);
    }
    openExternalUrl(url).catch(() => {});
  }

  // Tag filter for the page-level toolbar. We feed this into
  // LibraryTable's `filterRow` so the existing search + sort + paginate
  // run after the tag prefilter.
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

  const totalCount = mods.length;
  const enabledCount = mods.filter((m) => m.enabled).length;
  const disabledCount = mods.filter((m) => !m.enabled).length;

  // Row filter: by tag. Each row arrives from the membership grid; we
  // look up its ModInfo to check its tags.
  function filterRowByTag(row: ProfileMembershipMod): boolean {
    const tagKey = tagFilter.toLocaleLowerCase();
    if (!tagKey) return true;
    const key = row.folder_name ?? row.name;
    const mod = modInfoByKey.get(key);
    if (!mod) return false;
    return (mod.tags ?? []).some((tag) => tag.toLocaleLowerCase() === tagKey);
  }

  function renderSourceEditor(mod: ModInfo) {
    const rowKey = mod.folder_name ?? mod.name;
    if (sourceEditorRowKey !== rowKey) return undefined;
    return (
      <SourceEditor
        mod={mod}
        findingGithub={findingGithub === rowKey}
        onClose={() => setSourceEditorRowKey(null)}
        onClear={() => handleClearSource(mod.name, mod.folder_name)}
        onFindGithub={() => handleFindGithubFromNexus(mod)}
        onSave={async (gh, nx, note, customUrl, displayName, displayDescription, tagsInput) => {
          try {
            setSavingSource(true);
            // Two separate commands by design: setModSourcesFull owns
            // the GitHub/Nexus link fields (clearing nulls clears those
            // links), setModExtras owns the free-form note + custom URL.
            // They write to the same source entry but don't clobber each
            // other.
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
    );
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
              mods" so users don't read it as "the active modpack's mods". */}
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
          <Button variant="secondary" size="sm" onClick={() => setShowAutoDetect(true)}>
            <Search size={14} />
            {t('mods.autoDetectSources')}
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
        </div>
      </div>
      )}

      {/* 1.7.0 — outer Installed/Browse tab strip. */}
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
          Quick-Add button. */}
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

      {/* Tag filter + bulk actions strip. LibraryTable owns the
          per-table search + sort below, so this row only carries
          page-level affordances (tag filter, enable/disable/delete-all). */}
      {(tagOptions.length > 0 || mods.length > 0) && (
        <div className="gf-toolbar">
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
      )}

      {/* Library table — same row component the ModpackDetail view
          uses. Pass `modpackName={activeProfile}` so when there's an
          active modpack, the per-row checkbox column appears for
          quick add-to / remove-from membership editing; when no
          modpack is active, the table runs in no-focus mode (no
          checkboxes, no drag). */}
      <LibraryTable
        modpackName={activeProfile}
        filterRow={filterRowByTag}
        modInfoByKey={modInfoByKey}
        auditByKey={auditByKey}
        gameRunning={gameRunning}
        gameVersion={gameInfo?.game_version ?? null}
        updatingKey={updatingKey}
        repairingKey={repairingKey}
        rollingBackKey={rollingBackKey}
        anyUpdating={updatingKey !== null}
        anyRecoveryInFlight={repairingKey !== null || rollingBackKey !== null}
        onUpdate={handleInlineUpdate}
        onTogglePin={handleTogglePin}
        onSnooze={(mod, audit) => handleSnooze(mod, audit?.latest_release_with_assets_tag ?? null)}
        onUnsnooze={handleUnsnooze}
        onRepair={handleRepair}
        onRollback={handleRollback}
        onDelete={handleDelete}
        onCopyVersion={handleCopyVersion}
        onOpenModsFolder={handleOpenFolder}
        onEditSources={(mod) => setSourceEditorRowKey(mod.folder_name ?? mod.name)}
        onFindGithubFromNexus={handleFindGithubFromNexus}
        onOpenExternalUrl={handleOpenExternalUrl}
        renderSourceEditor={renderSourceEditor}
      />
        </>
      )}

      {/* Auto-detect sources — scans unlinked mods against GitHub by
          name and links high-confidence matches. Relocated from the
          old Settings → Audit tab; the Library is the canonical
          mod-management surface. */}
      <AutoDetectModal
        open={showAutoDetect}
        onClose={() => setShowAutoDetect(false)}
        onApplied={() => {
          refreshMods();
          // If an audit already ran, re-run it so the newly-linked rows
          // pick up their update status without a manual re-audit.
          if (auditResults) runAudit();
        }}
      />
    </div>
  );
}
