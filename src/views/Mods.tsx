import { useMemo, useState } from 'react';
import { countGithubUpdates } from '../lib/auditState';
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
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
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
  setModSource,
  setModSourcesFull,
  findGithubFromNexus,
  pinMod,
  unpinMod,
  repairMod,
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
      toast.success(`Updated '${name}' to v${info.version}`);
      await refreshAll();
      // Targeted re-audit: cover both the requested name and any rename
      // the install produced (same approach Settings uses).
      const names = info.name !== name ? [name, info.name] : [name];
      await refreshAuditEntries(names);
    } catch (e) {
      toast.error(`Update failed for '${name}': ${e instanceof Error ? e.message : String(e)}`);
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
      toast.success(`${name} ${enable ? 'enabled' : 'disabled'}`);
    } catch (e) {
      toast.error(`Failed to toggle ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleTogglePin(name: string, folderName: string | null, pinned: boolean) {
    try {
      if (pinned) {
        await unpinMod(name, folderName);
        toast.success(`Unpinned ${name}`);
      } else {
        await pinMod(name, folderName);
        toast.success(`Pinned ${name} — its enabled state will survive modpack updates`);
      }
      await refreshMods();
    } catch (e) {
      toast.error(`Failed to ${pinned ? 'unpin' : 'pin'} ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Force-reinstall a single mod from its linked GitHub source. Used to
  // recover from broken installs (manifest fails to parse, version reads
  // 'unknown', game won't load it). Confirms first because it nukes the
  // current on-disk install before re-extracting.
  const [repairingMod, setRepairingMod] = useState<string | null>(null);
  async function handleRepair(name: string, folderName: string | null, hasGithub: boolean) {
    if (!hasGithub) {
      toast.error(
        `'${name}' has no GitHub source linked — repair fetches from GitHub. ` +
        `Add a source via Edit sources… first.`,
      );
      return;
    }
    const ok = await confirm({
      title: `Repair '${name}'?`,
      body:
        `This will delete the current on-disk install and re-download the latest ` +
        `release from the linked GitHub source. Use it when a mod is broken ` +
        `(version reads "unknown", game won't load it, etc.). Make sure STS2 is closed.`,
      confirmLabel: 'Repair now',
    });
    if (!ok) return;
    // Track the in-progress repair by folder key so the spinner shows on
    // the exact row when two mods share a display name.
    const repairKey = folderName ?? name;
    setRepairingMod(repairKey);
    try {
      const info = await repairMod(name, folderName);
      toast.success(`Repaired '${info.name}' (v${info.version})`);
      await refreshAll();
    } catch (e) {
      toast.error(`Repair failed for '${name}': ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRepairingMod(null);
    }
  }

  async function handleDelete(name: string, folderName: string | null) {
    const ok = await confirm({
      title: `Delete "${name}"?`,
      body: 'This permanently removes the mod files from disk. This cannot be undone.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteMod(name, folderName);
      await refreshMods();
      toast.success(`Deleted: ${name}`);
    } catch (e) {
      toast.error(`Failed to delete ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleImportFile() {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Mod Archives', extensions: ['zip'] }],
      });
      if (!selected) return;
      const path = typeof selected === 'string' ? selected : selected;
      const mod = await installModFromFile(path);
      await refreshAll();
      toast.success(`Installed: ${mod.name}`);
    } catch (e) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
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
        toast.success(`Installed: ${result.mod_info.name}`);
      } else {
        const filesUrl = nexusFilesUrl(input);
        if (filesUrl) {
          await openUrl(filesUrl);
          // Sticky toast — dismissed when the downloads watcher reports
          // an install or after a 10-min fail-safe.
          notifyNexusOpen(result.nexus_info.name || 'Nexus mod');
        } else {
          toast.info(`Found Nexus mod: ${result.nexus_info.name || 'Unknown'}. Open it on Nexus and click "Slow Download" / "Manual" — the app will catch the zip from your Downloads folder.`);
        }
      }
      setQuickAddUrl('');
      setShowQuickAdd(false);
    } catch (e) {
      toast.error(`Quick add failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setQuickAdding(false);
    }
  }

  function nexusFilesUrl(input: string): string | null {
    try {
      const u = new URL(input);
      if (u.host.includes('nexusmods.com')) {
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length >= 3 && parts[1] === 'mods') {
          return `https://www.nexusmods.com/${parts[0]}/mods/${parts[2]}?tab=files`;
        }
      }
    } catch {
      // not a full URL — fall through to shorthand
    }
    const m = input.match(/^nexus:([^/]+)\/mods\/(\d+)/);
    if (m) return `https://www.nexusmods.com/${m[1]}/mods/${m[2]}?tab=files`;
    return null;
  }

  async function handleEnableAll() {
    try {
      await enableAllMods();
      await refreshMods();
      toast.success('All mods enabled');
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDisableAll() {
    try {
      await disableAllMods();
      await refreshMods();
      toast.success('All mods disabled');
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDeleteAll() {
    const ok = await confirm({
      title: `Delete all ${mods.length} mods?`,
      body: 'Every mod folder will be permanently removed from disk. This cannot be undone.',
      warning: 'Profiles that include these mods will be unable to launch until mods are reinstalled.',
      confirmLabel: 'Delete everything',
      destructive: true,
      typedPhrase: 'delete all',
    });
    if (!ok) return;
    try {
      const deleted = await deleteAllMods();
      await refreshAll();
      toast.success(`Deleted ${deleted} mods`);
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
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
      toast.info(`Source link cleared for ${modName}`);
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
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
          <h1 className="gf-page-title">Your mods</h1>
          <p className="gf-page-sub">
            {totalCount} installed · {enabledCount} active{disabledCount > 0 ? `, ${disabledCount} disabled` : ''}
            {advancedMode && linkedCount > 0 && (
              <span style={{ color: 'var(--ok)', marginLeft: 8 }}>
                · {linkedCount} linked for auto-updates
              </span>
            )}
          </p>
        </div>
        <div className="gf-page-actions">
          <Button variant="secondary" size="sm" onClick={handleOpenFolder}>
            <FolderOpen size={14} />
            Open folder
          </Button>
          {advancedMode && (
            <>
              <Button variant="secondary" size="sm" onClick={handleImportFile} disabled={gameRunning}>
                <Upload size={14} />
                Import mod
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setShowQuickAdd(!showQuickAdd)} disabled={gameRunning}>
                <Link size={14} />
                Quick add URL
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
                <Button variant="secondary" size="sm" disabled title="Checking each mod against its source…">
                  <ClipboardCheck size={14} className="animate-pulse" />
                  Auditing…
                </Button>
              );
            }

            if (updatingAll) {
              return (
                <Button variant="primary" size="sm" disabled>
                  <RefreshCw size={14} className="animate-spin" />
                  Updating {ghUpdateCount}…
                </Button>
              );
            }

            if (auditResults === null) {
              return (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCheckUpdates}
                  title="Check each mod against its source for updates."
                >
                  <ClipboardCheck size={14} />
                  Audit mods
                </Button>
              );
            }

            if (ghUpdateCount === 0) {
              return (
                <>
                  <span
                    className="gf-pill gf-pill-ok gf-pill-toolbar"
                    title="Every linked mod is on its source's latest installable release."
                  >
                    Up to date
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleCheckUpdates}
                    title="Re-audit"
                    aria-label="Re-audit"
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
                  title="Update every GitHub-linked mod with a pending update. Pinned mods are skipped."
                >
                  <Download size={14} />
                  Update {ghUpdateCount} mod{ghUpdateCount === 1 ? '' : 's'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleCheckUpdates}
                  title="Re-audit"
                  aria-label="Re-audit"
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
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </Button>
        </div>
      </div>

      {/* Quick Add URL Form (advanced only) */}
      {advancedMode && showQuickAdd && (
        <Card className="flex gap-3 items-end">
          <div className="flex-1">
            <label className="text-sm text-text-muted block mb-1.5">
              GitHub URL, Nexus URL, or github:owner/repo
            </label>
            <input
              type="text"
              value={quickAddUrl}
              onChange={(e) => setQuickAddUrl(e.target.value)}
              placeholder="https://github.com/user/mod or nexus:slaythespire2/mods/123"
              className="w-full bg-background border border-border rounded-lg px-4 py-2.5 text-sm text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50"
              onKeyDown={(e) => e.key === 'Enter' && handleQuickAdd()}
              disabled={quickAdding}
            />
          </div>
          <Button size="sm" onClick={handleQuickAdd} disabled={quickAdding}>
            {quickAdding ? 'Adding...' : 'Add'}
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
            placeholder={`Search ${totalCount} mod${totalCount === 1 ? '' : 's'}…`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
        {/* Per-screen Advanced toggle (v5 batch 2) */}
        <button
          type="button"
          className={`gf-adv-toggle ${advancedMode ? 'on' : ''}`}
          onClick={toggleAdvanced}
          title="Show source pills, Pin/Delete, source editor"
        >
          <span className="gf-adv-toggle-track">
            <span className="gf-adv-toggle-dot" />
          </span>
          <span className="gf-adv-toggle-label">Advanced</span>
        </button>
        {mods.length > 0 && (
          <div className="flex gap-1.5">
            <Button variant="ghost" size="sm" onClick={handleEnableAll} disabled={gameRunning} title={gameRunning ? 'Close STS2 first' : 'Enable all mods'}>
              <ToggleRight size={14} />
              Enable all
            </Button>
            <Button variant="ghost" size="sm" onClick={handleDisableAll} disabled={gameRunning} title={gameRunning ? 'Close STS2 first' : 'Disable all mods'}>
              <ToggleLeft size={14} />
              Disable all
            </Button>
            <Button variant="danger" size="sm" onClick={handleDeleteAll} disabled={gameRunning} title={gameRunning ? 'Close STS2 first' : 'Delete every mod'}>
              <Trash2 size={14} />
              Delete all
            </Button>
          </div>
        )}
      </div>

      {/* Mod List */}
      {filtered.length === 0 ? (
        <div className="gf-empty">
          <div className="gf-empty-art"><Package size={28} /></div>
          <div className="gf-empty-title">
            {mods.length === 0 ? 'No mods installed' : 'No mods match your filter'}
          </div>
          <div className="gf-empty-sub">
            {mods.length === 0
              ? "Browse to install a mod, paste a friend's profile code, or drop a .zip anywhere on this window."
              : 'Try a different search term.'}
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
              !auditRow.game_version_too_old &&
              !auditRow.latest_release_blocked_by_game_version &&
              !!compatibleTag &&
              !!mod.github_url;
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
                            title={`Two installed mods are named "${mod.name}". This one is identified by ${mod.author ? `author: ${mod.author}` : `folder: ${mod.folder_name}`}.`}
                          >
                            · {disambiguator}
                          </span>
                        )}
                        <span className="text-sm text-text-dim">v{mod.version}</span>
                        {mod.pinned && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300"
                            title="Pinned — modpack updates will preserve this mod's enabled/disabled state and version"
                          >
                            <Pin size={9} /> Pinned
                          </span>
                        )}
                        {showUpdatePill && (
                          <button
                            onClick={() => handleInlineUpdate(mod.name, mod.folder_name)}
                            disabled={gameRunning || isUpdatingThisRow || updatingKey !== null}
                            className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
                            title={
                              gameRunning
                                ? 'Close STS2 first.'
                                : `Click to update from v${mod.version} → v${compatibleTag?.replace(/^v/, '')}. Same pipeline as Settings → Audit.`
                            }
                          >
                            {isUpdatingThisRow ? (
                              <><RefreshCw size={9} className="animate-spin" /> Updating…</>
                            ) : (
                              <><Download size={9} /> Update available → v{compatibleTag?.replace(/^v/, '')}</>
                            )}
                          </button>
                        )}
                        {auditRow?.latest_release_blocked_by_game_version && !auditRow.pinned && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300"
                            title={
                              `Newer release exists (v${auditRow.latest_release_with_assets_tag?.replace(/^v/, '') ?? '?'}) but it requires a newer Slay the Spire 2 build. ` +
                              `Update STS2 (or switch beta branches) to pick it up; the manager can install an older compatible release in the meantime.`
                            }
                          >
                            <AlertTriangle size={9} /> Update blocked by game version
                          </span>
                        )}
                        {auditError && (
                          <span
                            className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded bg-red-500/20 text-red-300"
                            title={auditError}
                          >
                            <AlertTriangle size={9} /> Audit error
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
                            title={
                              `This mod's manifest declares min_game_version=${mod.min_game_version}. ` +
                              `Your STS2 is v${gameInfo?.game_version ?? 'unknown'}. ` +
                              `The game's loader will silently skip this mod until you update STS2 or switch beta branches. ` +
                              `Use Repair (advanced kebab) to roll back to a compatible release.`
                            }
                          >
                            ⚠ needs game ≥ v{mod.min_game_version}
                          </span>
                        )}
                        {/* Source badges (advanced only) */}
                        {advancedMode && mod.github_url ? (
                          <a
                            href={mod.github_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex"
                            title={`View on GitHub: ${mod.github_url}`}
                          >
                            <Badge variant="github">
                              <GitBranch size={10} className="mr-1" />
                              GitHub
                            </Badge>
                          </a>
                        ) : null}
                        {advancedMode && mod.nexus_url ? (
                          <a
                            href={mod.nexus_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex"
                            title={`View on Nexus: ${mod.nexus_url}`}
                          >
                            <Badge variant="nexus">Nexus</Badge>
                          </a>
                        ) : null}
                        {advancedMode && !hasLinks && (
                          <Badge variant={getSourceVariant(mod.source)}>
                            {mod.source ? 'Local' : 'Unlinked'}
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
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 ml-4 shrink-0">
                    <KebabMenu title="Mod actions">
                      <KebabSection>
                        <KebabItem
                          icon={mod.pinned ? <PinOff size={12} /> : <Pin size={12} />}
                          onClick={() => handleTogglePin(mod.name, mod.folder_name, mod.pinned)}
                          description={
                            mod.pinned
                              ? "Modpacks can update or replace this mod again."
                              : "Lock this mod's version and enabled/disabled state. Switching profiles or applying a modpack won't touch it."
                          }
                        >
                          {mod.pinned ? 'Unpin this mod' : 'Pin this mod'}
                        </KebabItem>
                        <KebabItem
                          icon={<Copy size={12} />}
                          onClick={() => {
                            navigator.clipboard.writeText(mod.version).then(
                              () => toast.success(`Copied v${mod.version}`),
                              () => toast.error('Could not copy'),
                            );
                          }}
                        >
                          Copy version (v{mod.version})
                        </KebabItem>
                        <KebabItem icon={<FolderOpen size={12} />} onClick={handleOpenFolder}>
                          Open mods folder
                        </KebabItem>
                      </KebabSection>
                      {advancedMode && (
                        <>
                          <KebabDivider />
                          <KebabSection head="Sources">
                            <KebabItem
                              icon={<Link size={12} />}
                              onClick={() =>
                                isExpanded ? setExpandedMod(null) : startEditSource(rowKey)
                              }
                            >
                              {isExpanded ? 'Close source editor' : 'Edit sources…'}
                            </KebabItem>
                            {mod.github_url && (
                              <KebabItem
                                icon={<GitBranch size={12} />}
                                onClick={() => openUrl(mod.github_url!).catch(() => {})}
                              >
                                View on GitHub
                              </KebabItem>
                            )}
                            {mod.nexus_url && (
                              <KebabItem
                                icon={<ExternalLink size={12} />}
                                onClick={() => openUrl(mod.nexus_url!).catch(() => {})}
                              >
                                View on Nexus
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
                                      toast.success(`Found GitHub repo: ${repo}`);
                                    } else {
                                      toast.info(`No GitHub link found in Nexus description for ${mod.name}`);
                                    }
                                  } catch (e) {
                                    toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
                                  } finally {
                                    setFindingGithub(null);
                                  }
                                }}
                              >
                                Find GitHub from Nexus
                              </KebabItem>
                            )}
                          </KebabSection>
                          <KebabDivider />
                          <KebabSection head="Recovery">
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
                                  ? 'Force-reinstall from GitHub. Use when version reads "unknown", the game refuses to load this mod, or the install otherwise looks broken.'
                                  : 'Link a GitHub source first via "Edit sources…" — repair fetches from GitHub.'
                              }
                            >
                              {repairingMod === rowKey ? 'Repairing…' : 'Repair this mod'}
                            </KebabItem>
                          </KebabSection>
                        </>
                      )}
                      <KebabDivider />
                      <KebabItem
                        danger
                        icon={<Trash2 size={12} />}
                        onClick={() => handleDelete(mod.name, mod.folder_name)}
                        disabled={gameRunning}
                      >
                        Remove mod…
                      </KebabItem>
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
                          toast.success(`Found GitHub repo: ${repo}`);
                        } else {
                          toast.info(`No GitHub link found in Nexus description for ${mod.name}`);
                        }
                      } catch (e) {
                        toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
                      } finally {
                        setFindingGithub(null);
                      }
                    }}
                    onSave={async (gh, nx) => {
                      try {
                        setSavingSource(true);
                        await setModSourcesFull(mod.name, gh.trim() || null, nx.trim() || null, mod.folder_name);
                        await refreshMods();
                        toast.success(`Sources saved for ${mod.name}`);
                        setExpandedMod(null);
                      } catch (e) {
                        toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
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
