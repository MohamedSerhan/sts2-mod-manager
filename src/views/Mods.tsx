import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { countGithubUpdates, isUpToDate } from '../lib/auditState';
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
  GitBranch,
  ExternalLink,
  Pin,
  PinOff,
  Wrench,
  ClipboardCheck,
  Download,
  AlertTriangle,
  Check,
  Clock,
  RotateCcw,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { Badge, getSourceVariant } from '../components/Badge';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmDialog';
import { KebabMenu, KebabSection, KebabDivider, KebabItem } from '../components/KebabMenu';
import { SourceEditor } from '../components/SourceEditor';
import { Copy } from 'lucide-react';
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
  setModSnooze,
  findGithubFromNexus,
  pinMod,
  unpinMod,
  repairMod,
  rollbackMod,
  updateMod,
} from '../hooks/useTauri';

// v5 — Advanced mode is per-screen, persisted in localStorage. Off by default.
const ADVANCED_KEY = 'sts2mm-mods-advanced';

/**
 * Numeric semver compare for the small subset we actually see in
 * mod manifests + STS2's release_info.json: "MAJOR.MINOR.PATCH" with
 * an optional leading "v". Returns true when `current >= required`.
 *
 * Fails OPEN on parse hiccups — UI would rather skip the warning than
 * cry "won't load!" at the user because of a quirky version string.
 */
function gameVersionSatisfies(current: string | null | undefined, required: string | null | undefined): boolean {
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

export function ModsView({ advancedMode: advancedModeProp }: { advancedMode?: boolean } = {}) {
  const { t } = useTranslation();
  const { mods, refreshMods, refreshAll, gameRunning, gameInfo, notifyNexusOpen, auditResults, auditing, runAudit, refreshAuditEntries, updatingAll, updateAllGithub } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [filter, setFilter] = useState('');
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAddUrl, setQuickAddUrl] = useState('');
  const [quickAdding, setQuickAdding] = useState(false);
  const [expandedMod, setExpandedMod] = useState<string | null>(null);
  const [savingSource, setSavingSource] = useState(false);
  const [findingGithub, setFindingGithub] = useState<string | null>(null);
  const [advancedMode, setAdvancedMode] = useState<boolean>(() => {
    if (advancedModeProp !== undefined) return advancedModeProp;
    try { return localStorage.getItem(ADVANCED_KEY) === 'true'; }
    catch { return false; }
  });
  function toggleAdvanced() {
    const next = !advancedMode;
    setAdvancedMode(next);
    try { localStorage.setItem(ADVANCED_KEY, String(next)); } catch {}
  }

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

  const totalCount = mods.length;
  const enabledCount = mods.filter((m) => m.enabled).length;
  const disabledCount = mods.filter((m) => !m.enabled).length;
  const linkedCount = mods.filter((m) => m.github_url || m.nexus_url).length;

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

  function startEditSource(rowKey: string) {
    setExpandedMod(rowKey);
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  const filtered = mods.filter((m) =>
    m.name.toLowerCase().includes(filter.toLowerCase()),
  );

  // Display names that appear on more than one installed mod. These rows
  // get a folder/author subtitle so the user can tell two same-named
  // mods apart (e.g. two CardArtEditor installs in different folders).
  const duplicateNames = new Set<string>();
  {
    const seen = new Set<string>();
    for (const m of mods) {
      if (seen.has(m.name)) duplicateNames.add(m.name);
      seen.add(m.name);
    }
  }

  return (
    <div className="gf-body">
      {/* Header */}
      <div className="gf-page-head">
        <div>
          <h1 className="gf-page-title">{t('mods.title')}</h1>
          <p className="gf-page-sub">
            {t('mods.subtitle', { total: totalCount, enabled: enabledCount, disabled: disabledCount > 0 ? t('mods.subtitleDisabledSuffix', { count: disabledCount }) : '' })}
            {advancedMode && linkedCount > 0 && (
              <span style={{ color: 'var(--ok)', marginLeft: 8 }}>
                · {t('mods.linkedCount', { count: linkedCount })}
              </span>
            )}
          </p>
        </div>
        <div className="gf-page-actions">
          <Button variant="secondary" size="sm" onClick={handleOpenFolder}>
            <FolderOpen size={14} />
            {t('mods.openFolder')}
          </Button>
          {advancedMode && (
            <>
              <Button variant="secondary" size="sm" onClick={handleImportFile} disabled={gameRunning}>
                <Upload size={14} />
                {t('mods.importMod')}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setShowQuickAdd(!showQuickAdd)} disabled={gameRunning}>
                <Link size={14} />
                {t('mods.quickAddUrl')}
              </Button>
            </>
          )}
          {(() => {
            const ghUpdateCount = auditResults ? countGithubUpdates(auditResults) : 0;
            const ghUpdateNames = auditResults
              ? auditResults
                  .filter(r => r.needs_update && r.github_repo && r.latest_release_with_assets_tag)
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

      {/* Quick Add URL Form (advanced only) */}
      {advancedMode && showQuickAdd && (
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
        {/* Per-screen Advanced toggle (v5 batch 2) */}
        <button
          type="button"
          className={`gf-adv-toggle ${advancedMode ? 'on' : ''}`}
          onClick={toggleAdvanced}
          title={t('mods.advancedTitle')}
        >
          <span className="gf-adv-toggle-track">
            <span className="gf-adv-toggle-dot" />
          </span>
          <span className="gf-adv-toggle-label">{t('mods.advanced')}</span>
        </button>
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
            const isExpanded = expandedMod === rowKey;
            const hasLinks = mod.github_url || mod.nexus_url;
            const isDuplicate = duplicateNames.has(mod.name);
            // When two mods share a display name, show a subtitle so the
            // user can tell them apart. Prefer author, fall back to the
            // on-disk folder name.
            const disambiguator = isDuplicate
              ? (mod.author?.trim() || mod.folder_name || null)
              : null;

            // Audit row for this mod (if an audit has been run). Drives the
            // inline "update available" pill + game-compat warning. We
            // intentionally don't surface the pill for pinned mods or
            // game-version-blocked rows — the audit table in Settings still
            // shows those details for users who want the full picture.
            //
            // Lookup is folder-first so two same-named mods get distinct
            // audit rows (the CardArtEditor case). Backend audit now
            // includes folder_name on every entry; the fallback to
            // display name only fires for legacy data shapes.
            const auditRow = auditByKey.get(rowKey) ?? auditByKey.get(mod.name);
            const compatibleTag = auditRow?.latest_compatible_tag ?? auditRow?.latest_release_with_assets_tag ?? null;
            const showUpdatePill =
              !!auditRow &&
              auditRow.needs_update &&
              !auditRow.pinned &&
              !auditRow.snoozed &&
              !auditRow.game_version_too_old &&
              !auditRow.latest_release_blocked_by_game_version &&
              !!compatibleTag &&
              !!mod.github_url;
            // Nexus-update pill — mirrors the Settings → Audit row.
            // `nexus_update_available` is already gated by the backend on
            // game-version compatibility (see updater.rs: when the latest
            // GitHub release is blocked by min_game_version AND Nexus has
            // the same version, the flag is suppressed so we don't send
            // the user to download an incompatible build). Pinned and
            // snoozed states piggy-back on the GitHub pill's gates for
            // consistency with what Settings shows.
            const nexusFilesHref = mod.nexus_url ? nexusFilesUrl(mod.nexus_url) ?? `${mod.nexus_url}?tab=files` : null;
            const showNexusUpdatePill =
              !!auditRow &&
              auditRow.nexus_update_available &&
              !auditRow.pinned &&
              !auditRow.snoozed &&
              !!nexusFilesHref;
            const isUpdatingThisRow = updatingKey === rowKey;
            const auditError = auditRow?.error ?? null;

            return (
              <Card
                key={rowKey}
                className={`hover:bg-surface-hover transition-colors ${mod.pinned ? 'gf-mod-pinned' : ''}`}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4 min-w-0">
                    <Toggle
                      checked={mod.enabled}
                      onChange={(checked) => handleToggle(mod.name, mod.folder_name, checked)}
                      disabled={gameRunning}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2.5 flex-wrap">
                        <span className="text-sm font-medium text-text truncate">
                          {mod.name}
                        </span>
                        {disambiguator && (
                          <span
                            className="text-xs text-text-dim"
                            title={t('mods.disambiguatorTitle', { name: mod.name, identifier: mod.author ? t('mods.disambiguatorAuthor', { author: mod.author }) : t('mods.disambiguatorFolder', { folder: mod.folder_name }) })}
                          >
                            · {disambiguator}
                          </span>
                        )}
                        <span className="text-sm text-text-dim">v{mod.version}</span>
                        {mod.pinned && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300"
                            title={t('mods.pinnedTitle')}
                          >
                            <Pin size={9} /> {t('mods.pinned')}
                          </span>
                        )}
                        {auditRow && isUpToDate(auditRow) && (
                          <span
                            className="gf-pill gf-pill-ok"
                            title={t('mods.latestTitle')}
                          >
                            <Check size={9} /> {t('mods.latest')}
                          </span>
                        )}
                        {showUpdatePill && (
                          <button
                            onClick={() => handleInlineUpdate(mod.name, mod.folder_name)}
                            disabled={gameRunning || isUpdatingThisRow || updatingKey !== null}
                            className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                            title={
                              gameRunning
                                ? t('mods.closeSts2FirstDot')
                                : t('mods.updateClickTitle', { current: mod.version, target: compatibleTag?.replace(/^v/, '') })
                            }
                          >
                            {isUpdatingThisRow ? (
                              <><RefreshCw size={9} className="animate-spin" /> {t('mods.updating')}</>
                            ) : (
                              <><Download size={9} /> {t('mods.updateAvailable', { version: compatibleTag?.replace(/^v/, '') })}</>
                            )}
                          </button>
                        )}
                        {showNexusUpdatePill && (
                          <a
                            href={nexusFilesHref!}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={() => notifyNexusOpen(mod.name)}
                            className="gf-pill gf-pill-update inline-flex items-center gap-1 hover:underline"
                            title={t('mods.nexusUpdateTitle', { nexusVer: auditRow!.nexus_version ?? '?', localVer: mod.version })}
                          >
                            <Download size={9} /> {t('mods.downloadFromNexus')}
                          </a>
                        )}
                        {auditRow?.snoozed && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-slate-500/20 text-slate-300"
                            title={t('mods.snoozedTitle', { version: auditRow.latest_release_with_assets_tag?.replace(/^v/, '') ?? '?' })}
                          >
                            💤 {t('mods.snoozed')}
                          </span>
                        )}
                        {auditRow?.latest_release_blocked_by_game_version && !auditRow.pinned && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300"
                            title={t('mods.gameVersionBlockedTitle', { target: auditRow.latest_release_with_assets_tag?.replace(/^v/, '') ?? '?' })}
                          >
                            <AlertTriangle size={9} /> {t('mods.updateBlockedByGameVersion')}
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
                        {mod.min_game_version &&
                          !gameVersionSatisfies(gameInfo?.game_version, mod.min_game_version) && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded"
                            style={{
                              background: 'oklch(0.78 0.16 60 / 0.18)',
                              color: 'oklch(0.85 0.16 60)',
                            }}
                            title={t('mods.minGameVersionTitle', { minVer: mod.min_game_version, yourVer: gameInfo?.game_version ?? 'unknown' })}
                          >
                            ⚠ {t('mods.needsGameVersion', { version: mod.min_game_version })}
                          </span>
                        )}
                        {/* Source badges (advanced only) */}
                        {advancedMode && mod.github_url ? (
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
                        {advancedMode && mod.nexus_url ? (
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
                        {advancedMode && mod.custom_url ? (
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
                        {advancedMode && !hasLinks && !mod.custom_url && (
                          <Badge variant={getSourceVariant(mod.source)}>
                            {mod.source ? t('mods.local') : t('mods.unlinked')}
                          </Badge>
                        )}
                        {mod.size_bytes > 0 && (
                          <span className="text-xs text-text-dim">{formatBytes(mod.size_bytes)}</span>
                        )}
                      </div>
                      {mod.description && (
                        <p className="text-sm text-text-muted mt-1 truncate">
                          {mod.description}
                        </p>
                      )}
                      {mod.note && (
                        <p
                          className="text-xs text-text-dim mt-1 truncate"
                          title={mod.note}
                          style={{ fontStyle: 'italic' }}
                        >
                          📝 {mod.note}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 ml-4 shrink-0">
                    {/* Advanced mode: promote Remove to a one-click button
                        on the row (left of the kebab). Non-advanced mode
                        keeps the Remove entry inside the kebab so the row
                        stays tidy for casual users. */}
                    {advancedMode && (
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={() => handleDelete(mod.name, mod.folder_name)}
                        disabled={gameRunning}
                        aria-label={t('mods.removeMod')}
                        title={gameRunning ? t('mods.closeSts2First') : t('mods.removeMod')}
                      >
                        <Trash2 size={12} />
                      </Button>
                    )}
                    <KebabMenu title={t('mods.modActions')}>
                      <KebabSection>
                        <KebabItem
                          icon={mod.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                          onClick={() => handleTogglePin(mod.name, mod.folder_name, mod.pinned)}
                          description={
                            mod.pinned
                              ? t('mods.unpinDesc')
                              : t('mods.pinDesc')
                          }
                        >
                          {mod.pinned ? t('mods.unpinThisMod') : t('mods.pinThisMod')}
                        </KebabItem>
                        <KebabItem
                          icon={<Copy size={12} />}
                          onClick={() => {
                            navigator.clipboard.writeText(mod.version).then(
                              () => toast.success(t('mods.toast.versionCopied', { version: mod.version })),
                              () => toast.error(t('mods.toast.couldNotCopy')),
                            );
                          }}
                        >
                          {t('mods.copyVersion', { version: mod.version })}
                        </KebabItem>
                        <KebabItem icon={<FolderOpen size={12} />} onClick={handleOpenFolder}>
                          {t('mods.openModsFolder')}
                        </KebabItem>
                        {auditRow?.snoozed ? (
                          <KebabItem
                            icon={<Check size={12} />}
                            onClick={async () => {
                              try {
                                await setModSnooze(mod.name, null, mod.folder_name);
                                await refreshAuditEntries([mod.name]);
                                toast.success(t('mods.toast.unsnoozed', { name: mod.name }));
                              } catch (e) {
                                toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
                              }
                            }}
                            description={t('mods.unsnoozeDesc')}
                          >
                            {t('mods.unsnoozeUpdate')}
                          </KebabItem>
                        ) : (
                          auditRow?.needs_update && !!auditRow.latest_release_with_assets_tag && (
                            <KebabItem
                              icon={<Clock size={12} />}
                              onClick={async () => {
                                try {
                                  await setModSnooze(
                                    mod.name,
                                    auditRow.latest_release_with_assets_tag ?? null,
                                    mod.folder_name,
                                  );
                                  await refreshAuditEntries([mod.name]);
                                  toast.success(t('mods.toast.snoozed', { name: mod.name }));
                                } catch (e) {
                                  toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
                                }
                              }}
                              description={t('mods.snoozeDesc', { version: auditRow.latest_release_with_assets_tag?.replace(/^v/, '') ?? '?' })}
                            >
                              {t('mods.snoozeUpdate')}
                            </KebabItem>
                          )
                        )}
                      </KebabSection>
                      {advancedMode && (
                        <>
                          <KebabDivider />
                          <KebabSection head={t('mods.sources')}>
                            <KebabItem
                              icon={<Link size={12} />}
                              onClick={() =>
                                isExpanded ? setExpandedMod(null) : startEditSource(rowKey)
                              }
                            >
                              {isExpanded ? t('mods.closeSourceEditor') : t('mods.editSources')}
                            </KebabItem>
                            {mod.github_url && (
                              <KebabItem
                                icon={<GitBranch size={12} />}
                                onClick={() => openExternalUrl(mod.github_url!).catch(() => {})}
                              >
                                {t('mods.viewOnGitHubKebab')}
                              </KebabItem>
                            )}
                            {mod.nexus_url && (
                              <KebabItem
                                icon={<ExternalLink size={12} />}
                                onClick={() => openExternalUrl(mod.nexus_url!).catch(() => {})}
                              >
                                {t('mods.viewOnNexusKebab')}
                              </KebabItem>
                            )}
                            {mod.nexus_url && !mod.github_url && (
                              <KebabItem
                                icon={<GitBranch size={12} />}
                                onClick={async () => {
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
                              >
                                {t('mods.findGitHubFromNexus')}
                              </KebabItem>
                            )}
                          </KebabSection>
                          <KebabDivider />
                          <KebabSection head={t('mods.recovery')}>
                            <KebabItem
                              icon={
                                repairingMod === rowKey ? (
                                  <RefreshCw size={12} className="animate-spin" />
                                ) : (
                                  <Wrench size={12} />
                                )
                              }
                              onClick={() => handleRepair(mod.name, mod.folder_name, !!mod.github_url)}
                              disabled={
                                gameRunning ||
                                repairingMod !== null ||
                                !mod.github_url
                              }
                              description={
                                mod.github_url
                                  ? t('mods.repairDesc')
                                  : t('mods.repairNeedSource')
                              }
                            >
                              {repairingMod === rowKey ? t('mods.repairing') : t('mods.repairThisMod')}
                            </KebabItem>
                            <KebabItem
                              icon={
                                rollingBackMod === rowKey ? (
                                  <RefreshCw size={12} className="animate-spin" />
                                ) : (
                                  <RotateCcw size={12} />
                                )
                              }
                              onClick={() => handleRollback(mod.name, mod.folder_name, !!mod.github_url)}
                              disabled={
                                gameRunning ||
                                repairingMod !== null ||
                                rollingBackMod !== null ||
                                !mod.github_url
                              }
                              description={
                                mod.github_url
                                  ? t('mods.rollbackDesc')
                                  : t('mods.rollbackNeedSource')
                              }
                            >
                              {rollingBackMod === rowKey ? (
                                t('mods.rollingBack')
                              ) : (
                                <span className="inline-flex items-center gap-1">
                                  {t('mods.rollBackOneVersion')}
                                  <Badge variant="beta" ariaHidden>{t('common.beta')}</Badge>
                                </span>
                              )}
                            </KebabItem>
                          </KebabSection>
                        </>
                      )}
                      {!advancedMode && (
                        <>
                          <KebabDivider />
                          <KebabItem
                            danger
                            icon={<Trash2 size={12} />}
                            onClick={() => handleDelete(mod.name, mod.folder_name)}
                            disabled={gameRunning}
                          >
                            {t('mods.removeMod')}
                          </KebabItem>
                        </>
                      )}
                    </KebabMenu>
                  </div>
                </div>

                {/* v5 Source editor drawer (advanced only) */}
                {advancedMode && isExpanded && (
                  <SourceEditor
                    mod={mod}
                    findingGithub={findingGithub === rowKey}
                    onClose={() => setExpandedMod(null)}
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
                    onSave={async (gh, nx, note, customUrl) => {
                      try {
                        setSavingSource(true);
                        // Two separate commands by design: setModSourcesFull
                        // owns the GitHub/Nexus link fields (clearing nulls
                        // clears those links), setModExtras owns the
                        // free-form note + custom URL. They write to the
                        // same source entry but don't clobber each other.
                        await setModSourcesFull(mod.name, gh.trim() || null, nx.trim() || null, mod.folder_name);
                        await setModExtras(mod.name, note.trim() || null, customUrl.trim() || null, mod.folder_name);
                        await refreshMods();
                        toast.success(t('mods.toast.sourcesSaved', { name: mod.name }));
                        setExpandedMod(null);
                      } catch (e) {
                        toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
                      } finally {
                        setSavingSource(false);
                      }
                    }}
                    saving={savingSource}
                  />
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
