import { useState, useEffect } from 'react';
import {
  FolderSearch,
  Key,
  FolderOpen,
  RefreshCw,
  ClipboardCheck,
  ExternalLink,
  Download,
  Pin,
  PinOff,
  Archive,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmDialog';
import { LogsViewer } from '../components/LogsViewer';
import { DiagnosticBundle } from '../components/DiagnosticBundle';
import { AutoDetectModal } from '../components/AutoDetectModal';
import {
  detectGamePath,
  setGamePath,
  setNexusApiKey,
  setGithubToken,
  openGameFolder,
  openModsFolder,
  getApiKeyStatus,
  auditModVersions,
  pinMod,
  unpinMod,
  updateMod,
  updateAllMods,
  createBackup,
  listBackups,
  restoreBackup,
  deleteBackup,
} from '../hooks/useTauri';
import type { ModAuditEntry, BackupInfo } from '../types';

type Tab = 'general' | 'accounts' | 'backups' | 'audit' | 'advanced';

// v5 — tabbed Settings shell. Tabs are stateful; tab content is rendered
// inline beneath the tab strip. All existing handlers preserved.
export function SettingsView() {
  const { gameInfo, refreshAll } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>('general');

  // ── General ─────────────────────────────────────────
  const [gamePath, setGamePathValue] = useState('');

  // ── Accounts ────────────────────────────────────────
  const [nexusKey, setNexusKey] = useState('');
  const [githubToken, setGithubTokenValue] = useState('');
  const [nexusKeySaved, setNexusKeySaved] = useState(false);
  const [githubTokenSaved, setGithubTokenSaved] = useState(false);

  // ── Audit ───────────────────────────────────────────
  const [auditing, setAuditing] = useState(false);
  const [auditResults, setAuditResults] = useState<ModAuditEntry[] | null>(null);
  const [updatingMod, setUpdatingMod] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);

  // ── Backups ─────────────────────────────────────────
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);

  // ── Updates (Advanced) ──────────────────────────────
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  // ── Diagnostic bundle modal ─────────────────────────
  const [showDiag, setShowDiag] = useState(false);
  const [showAutoDetect, setShowAutoDetect] = useState(false);

  async function refreshBackups() {
    try {
      setBackups(await listBackups());
    } catch (e) {
      toast.error(`Failed to load backups: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  useEffect(() => { refreshBackups(); }, []);
  useEffect(() => {
    if (gameInfo?.game_path) {
      setGamePathValue(gameInfo.game_path);
    }
  }, [gameInfo?.game_path]);
  useEffect(() => {
    getApiKeyStatus().then((status) => {
      setNexusKeySaved(status.nexus_api_key_set);
      setGithubTokenSaved(status.github_token_set);
    }).catch(() => {});
  }, []);

  async function handleCreateBackup() {
    setBackupBusy('create');
    try {
      const name = await createBackup();
      toast.success(`Backup created: ${name}`);
      await refreshBackups();
    } catch (e) {
      toast.error(`Failed to create backup: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBackupBusy(null);
    }
  }

  async function handleRestoreBackup(name: string) {
    const ok = await confirm({
      title: 'Restore overwrites your current setup',
      body: 'This will replace your current mods with the snapshot. Your current state is not saved unless you back it up first.',
      confirmLabel: 'Restore now',
      destructive: true,
      checkbox: { label: 'Save current as a new backup before restoring', defaultChecked: true },
    });
    if (!ok) return;
    setBackupBusy(name);
    try {
      if (ok.checked) {
        try { await createBackup(); } catch { /* non-fatal */ }
      }
      await restoreBackup(name);
      await refreshAll();
      toast.success('Backup restored.');
    } catch (e) {
      toast.error(`Failed to restore backup: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBackupBusy(null);
    }
  }

  async function handleDeleteBackup(name: string) {
    const ok = await confirm({
      title: 'Delete this backup?',
      body: 'You won\'t be able to restore it after this.',
      confirmLabel: 'Delete',
      destructive: true,
    });
    if (!ok) return;
    setBackupBusy(name);
    try {
      await deleteBackup(name);
      toast.success('Backup deleted.');
      await refreshBackups();
    } catch (e) {
      toast.error(`Failed to delete backup: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBackupBusy(null);
    }
  }

  function formatBackupTimestamp(name: string): string {
    const m = name.match(/^backup_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
    if (!m) return name;
    const [, y, mo, d, h, mi, s] = m;
    const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    return date.toLocaleString();
  }

  function formatSizeMb(bytes: number): string {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function handleDetectGame() {
    try {
      const info = await detectGamePath();
      if (info.valid && info.game_path) {
        setGamePathValue(info.game_path);
        await refreshAll();
        toast.success('Game detected successfully!');
      } else {
        toast.error('Could not auto-detect game path. Please set it manually.');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSetGamePath() {
    if (!gamePath.trim()) return;
    try {
      const info = await setGamePath(gamePath.trim());
      if (info.valid) {
        await refreshAll();
        toast.success('Game path updated.');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleBrowseGamePath() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Select Slay the Spire 2 folder',
      });
      if (!selected) return;
      const picked = typeof selected === 'string' ? selected : String(selected);
      setGamePathValue(picked);
      const info = await setGamePath(picked);
      if (info.valid && info.game_path) {
        setGamePathValue(info.game_path);
        await refreshAll();
        toast.success('Game path updated.');
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSaveNexusKey() {
    if (!nexusKey.trim()) return;
    try {
      await setNexusApiKey(nexusKey.trim());
      toast.success('Nexus API key saved.');
      setNexusKey('');
      setNexusKeySaved(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleSaveGithubToken() {
    if (!githubToken.trim()) return;
    try {
      await setGithubToken(githubToken.trim());
      toast.success('GitHub token saved.');
      setGithubTokenValue('');
      setGithubTokenSaved(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleOpenGameFolder() {
    try {
      await openGameFolder();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleOpenModsFolder() {
    try {
      await openModsFolder();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleRunAudit() {
    try {
      setAuditing(true);
      const results = await auditModVersions();
      setAuditResults(results);
    } catch (e) {
      toast.error(`Audit failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setAuditing(false);
    }
  }

  // Re-audit just the named mods and splice their fresh entries back into
  // the existing audit list, leaving every other row untouched. Used after
  // single-mod / bulk updates so the user doesn't have to wait for a full
  // audit (every mod fetches its source) just to see the row flip from
  // "X → Y" to "(latest)".
  async function refreshAuditEntries(names: string[]) {
    if (names.length === 0) return;
    try {
      const fresh = await auditModVersions(names);
      const byName = new Map(fresh.map((e) => [e.mod_name, e]));
      setAuditResults((prev) =>
        prev ? prev.map((e) => byName.get(e.mod_name) ?? e) : prev,
      );
    } catch {
      /* non-fatal — leaves existing rows in place */
    }
  }

  // Update every GitHub-sourced mod with a pending update in one shot.
  // Pinned mods are skipped on the backend, so this only touches things
  // the audit was already flagging. We confirm first because it kicks off
  // multiple downloads and modifies the install on disk.
  async function handleUpdateAll(githubUpdateNames: string[]) {
    if (updatingAll || githubUpdateNames.length === 0) return;
    const ok = await confirm({
      title: `Update ${githubUpdateNames.length} mod${githubUpdateNames.length === 1 ? '' : 's'}?`,
      body:
        `This will download and re-install the latest GitHub release for each. ` +
        `Pinned mods are skipped. Make sure STS2 is closed first.`,
      confirmLabel: 'Update all',
    });
    if (!ok) return;
    setUpdatingAll(true);
    try {
      const updated = await updateAllMods();
      toast.success(
        updated.length === 0
          ? 'Nothing to update.'
          : `Updated ${updated.length} mod${updated.length === 1 ? '' : 's'}.`,
      );
      await refreshAll();
      // Targeted re-audit of just the rows we touched. Mod names can shift
      // after install (manifest renames), so audit by both the requested
      // set and what came back — the union covers both pre- and post-rename.
      const names = Array.from(
        new Set([...githubUpdateNames, ...updated.map((m) => m.name)]),
      );
      await refreshAuditEntries(names);
    } catch (e) {
      toast.error(`Update all failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUpdatingAll(false);
    }
  }

  // Update a single mod inline from the audit row. Only available for mods
  // whose source is GitHub — Nexus mods still require the user to download
  // through the browser via the existing "Download from Nexus" pill.
  async function handleUpdateOne(modName: string) {
    if (updatingMod) return;
    setUpdatingMod(modName);
    try {
      const info = await updateMod(modName);
      toast.success(`Updated '${modName}' to v${info.version}`);
      await refreshAll();
      // Re-audit only this mod (and the manifest name if install_mod_from_zip
      // ended up rewriting it) so the row flips fast — no full audit needed.
      const names = info.name !== modName ? [modName, info.name] : [modName];
      await refreshAuditEntries(names);
    } catch (e) {
      toast.error(`Update failed for '${modName}': ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUpdatingMod(null);
    }
  }

  async function handleCheckUpdateNow() {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const update = await check();
      if (!update) {
        toast.success('You are on the latest version.');
        return;
      }
      toast.success(`v${update.version} available — installing...`);
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      toast.error(`Update check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCheckingUpdate(false);
    }
  }

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'general',  label: 'General' },
    { id: 'accounts', label: 'Accounts' },
    { id: 'backups',  label: 'Backups',  count: backups.length || undefined },
    { id: 'audit',    label: 'Audit',    count: auditResults?.filter(r => r.needs_update).length || undefined },
    { id: 'advanced', label: 'Advanced' },
    // About moved to the Home screen footer (v1.0.4) — kept the section in
    // history because the diag-bundle action and update-check now live there.
  ];

  return (
    <div className="gf-body" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="gf-page-head">
        <div>
          <h1 className="gf-page-title">Settings</h1>
          <p className="gf-page-sub">Game paths, accounts, backups, mod audit, advanced</p>
        </div>
      </div>

      {/* Tab strip */}
      <div className="gf-tabs gf-tabs-settings">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`gf-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.count != null && <span className="gf-tab-count">{t.count}</span>}
          </button>
        ))}
      </div>

      <div style={{ marginTop: 14, flex: 1, minHeight: 0 }}>
        {tab === 'general' && (
          <>
            <Card className="space-y-4">
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <FolderSearch size={18} />
                Game Path
              </h3>
              <div className="gf-field" style={{ margin: 0 }}>
                <div className="gf-input-row">
                  <input
                    className={`gf-set-input ${gameInfo?.valid ? 'is-ok' : gamePath && !gameInfo?.valid ? 'is-err' : ''}`}
                    placeholder={
                      typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
                        ? '~/Library/Application Support/Steam/steamapps/common/SlayTheSpire2'
                        : typeof navigator !== 'undefined' && /Linux/.test(navigator.platform)
                        ? '~/.steam/steam/steamapps/common/SlayTheSpire2'
                        : 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\SlayTheSpire2'
                    }
                    value={gamePath}
                    onChange={(e) => setGamePathValue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSetGamePath()}
                    style={{ flex: 1 }}
                  />
                  <Button variant="secondary" size="sm" onClick={handleBrowseGamePath}>
                    Browse...
                  </Button>
                  <Button variant="secondary" size="sm" onClick={handleDetectGame}>
                    Auto-detect
                  </Button>
                  <Button size="sm" onClick={handleSetGamePath}>
                    Save
                  </Button>
                </div>
                {gameInfo?.valid ? (
                  <div className="gf-help ok">
                    <span>✓</span>
                    <span>
                      Verified · {gameInfo.mods_count} mods detected ·{' '}
                      <button onClick={handleOpenGameFolder} className="hover:underline" style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', padding: 0 }}>
                        Open game folder
                      </button>
                      {' · '}
                      <button onClick={handleOpenModsFolder} className="hover:underline" style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', padding: 0 }}>
                        Open mods folder
                      </button>
                    </span>
                  </div>
                ) : gamePath ? (
                  <div className="gf-help err">
                    <span>!</span><span>Couldn't verify SlayTheSpire2.exe in this folder. Pick the install root, not a subfolder.</span>
                  </div>
                ) : (
                  <div className="gf-help muted">
                    <span>Click <b>Auto-detect</b> to find your Steam install, or <b>Browse</b> to pick the folder manually.</span>
                  </div>
                )}
              </div>
            </Card>
          </>
        )}

        {tab === 'accounts' && (
          <>
            <Card className="space-y-4">
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <Key size={18} />
                Nexus Mods API Key
                {nexusKeySaved && (
                  <span className="gf-pill gf-pill-update" style={{ marginLeft: 6 }}>Saved ✓</span>
                )}
              </h3>
              <div className="gf-field" style={{ margin: 0 }}>
                <div className="gf-input-row">
                  <input
                    className={`gf-set-input ${nexusKeySaved && !nexusKey ? 'is-ok' : ''}`}
                    type="password"
                    placeholder={nexusKeySaved ? '••••••••••••••••  (saved · enter new value to replace)' : 'Enter your Nexus API key'}
                    value={nexusKey}
                    onChange={(e) => setNexusKey(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveNexusKey()}
                    style={{ flex: 1 }}
                  />
                  <Button size="sm" onClick={handleSaveNexusKey}>
                    Save
                  </Button>
                </div>
                {nexusKeySaved && !nexusKey ? (
                  <div className="gf-help ok">
                    <span>✓</span><span>Saved · Nexus mods will appear in Browse.</span>
                  </div>
                ) : (
                  <div className="gf-help muted">
                    <span>
                      <a
                        href="https://www.nexusmods.com/users/myaccount?tab=api"
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: 'var(--gf)', display: 'inline-flex', alignItems: 'center', gap: 4 }}
                        className="hover:underline"
                      >
                        Get your API key from Nexus Mods <ExternalLink size={11} />
                      </a>
                    </span>
                  </div>
                )}
              </div>
            </Card>

            <Card className="space-y-4" style={{ marginTop: 8 }}>
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <Key size={18} />
                GitHub Token
                <span className="text-xs text-text-dim font-normal">(optional)</span>
                {githubTokenSaved && (
                  <span className="gf-pill gf-pill-update" style={{ marginLeft: 6 }}>Saved ✓</span>
                )}
              </h3>
              <div className="gf-field" style={{ margin: 0 }}>
                <div className="gf-input-row">
                  <input
                    className={`gf-set-input ${githubTokenSaved && !githubToken ? 'is-ok' : ''}`}
                    type="password"
                    placeholder={githubTokenSaved ? '••••••••••••••••  (saved · enter new value to replace)' : 'ghp_xxxxxxxxxxxxxxxxxxxx'}
                    value={githubToken}
                    onChange={(e) => setGithubTokenValue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveGithubToken()}
                    style={{ flex: 1 }}
                  />
                  <Button variant="secondary" size="sm" onClick={handleSaveGithubToken}>
                    Save
                  </Button>
                </div>
                {githubTokenSaved && !githubToken ? (
                  <div className="gf-help ok">
                    <span>✓</span><span>Saved · raises API rate limit to 5,000 req/hr.</span>
                  </div>
                ) : (
                  <div className="gf-help muted">
                    <span>
                      Any token type works (classic or fine-grained). For sharing profiles, needs <b>repo</b> permission.
                      Without auth: 60 requests/hr (shared with anyone on this network).
                    </span>
                  </div>
                )}
              </div>
            </Card>
          </>
        )}

        {tab === 'backups' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <div>
                <div className="gf-set-label" style={{ fontSize: 14 }}>Backups</div>
                <div className="gf-set-desc">Auto-saved before every launch and Vanilla Mode · keeps the last 5</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <Button variant="secondary" size="sm" onClick={handleOpenModsFolder}>
                  <FolderOpen size={14} /> Open folder
                </Button>
                <Button size="sm" onClick={handleCreateBackup} disabled={backupBusy !== null}>
                  <Archive size={14} />
                  {backupBusy === 'create' ? 'Creating...' : 'Create backup'}
                </Button>
              </div>
            </div>
            {backups.length === 0 ? (
              <div className="gf-empty">
                <div className="gf-empty-art"><Archive size={28} /></div>
                <div className="gf-empty-title">No backups yet</div>
                <div className="gf-empty-sub">A backup is auto-created before every launch. You can also create one manually.</div>
              </div>
            ) : (
              backups.map((b, i) => {
                const busy = backupBusy === b.name;
                const anyBusy = backupBusy !== null;
                return (
                  <div key={b.name} className="gf-backup">
                    <div className="gf-backup-icon"><Archive size={16} /></div>
                    <div style={{ flex: 1 }}>
                      <div className="gf-backup-time">
                        {formatBackupTimestamp(b.name)}
                        {i === 0 && (
                          <span className="gf-pill gf-pill-update" style={{ marginLeft: 8 }}>NEWEST</span>
                        )}
                      </div>
                      <div className="gf-backup-meta">
                        {b.mod_count} {b.mod_count === 1 ? 'file' : 'files'} · {formatSizeMb(b.size_bytes)}
                      </div>
                    </div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => handleRestoreBackup(b.name)}
                      disabled={anyBusy}
                    >
                      {busy ? (
                        <RefreshCw size={12} className="animate-spin" />
                      ) : (
                        <RotateCcw size={12} />
                      )}
                      {busy ? 'Restoring…' : 'Restore'}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => handleDeleteBackup(b.name)}
                      disabled={anyBusy}
                      title="Delete backup"
                    >
                      <Trash2 size={12} />
                    </Button>
                  </div>
                );
              })
            )}
          </>
        )}

        {tab === 'audit' && (
          <>
            {(() => {
              // Only the audit toolbar needs this — derive the GitHub-update
              // list once per render and reuse it for the "Update all"
              // gating below.
              const ghUpdates = auditResults
                ? auditResults.filter((r) => r.needs_update && r.github_repo).map((r) => r.mod_name)
                : [];
              return (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                  <div>
                    <div className="gf-set-label" style={{ fontSize: 14 }}>Mod audit</div>
                    <div className="gf-set-desc">Compare each installed mod against its source · pin to lock the current version</div>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    {/* Show Update all only when there are 2+ GitHub-sourced
                        updates queued — for a single one the inline Update
                        button on the row is enough. */}
                    {ghUpdates.length >= 2 && (
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={() => handleUpdateAll(ghUpdates)}
                        disabled={updatingAll || updatingMod !== null}
                        title={`Update ${ghUpdates.length} GitHub-sourced mods (skips pinned)`}
                      >
                        {updatingAll ? (
                          <RefreshCw size={14} className="animate-spin" />
                        ) : (
                          <Download size={14} />
                        )}
                        {updatingAll ? 'Updating…' : `Update all (${ghUpdates.length})`}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setShowAutoDetect(true)} disabled={updatingAll}>
                      Auto-detect sources
                    </Button>
                    <Button variant="secondary" size="sm" onClick={handleRunAudit} disabled={auditing || updatingAll}>
                      <ClipboardCheck size={14} className={auditing ? 'animate-pulse' : ''} />
                      {auditing ? 'Auditing...' : auditResults ? 'Re-audit' : 'Run audit'}
                    </Button>
                  </div>
                </div>
              );
            })()}

            {auditResults === null ? (
              <div className="gf-empty">
                <div className="gf-empty-art"><ClipboardCheck size={28} /></div>
                <div className="gf-empty-title">No audit yet</div>
                <div className="gf-empty-sub">Run an audit to see which mods have updates available, which are pinned, and which can't be matched against a source.</div>
                <div style={{ marginTop: 14 }}>
                  <Button onClick={handleRunAudit} disabled={auditing}>
                    <ClipboardCheck size={14} /> {auditing ? 'Auditing...' : 'Run audit'}
                  </Button>
                </div>
              </div>
            ) : auditResults.length === 0 ? (
              <div className="gf-empty">
                <div className="gf-empty-art"><ClipboardCheck size={28} /></div>
                <div className="gf-empty-title">No mods to audit</div>
                <div className="gf-empty-sub">Install some mods first.</div>
              </div>
            ) : (
              <>
                <div className="space-y-1" style={{ maxHeight: 480, overflowY: 'auto' }}>
                  {auditResults.map((entry) => {
                    const hasAnySource = entry.github_repo || entry.nexus_url;
                    const hasRealError = entry.error && !entry.github_auto_detected;
                    // "gone" = GitHub has a latest release tagged but no
                    // installable asset (zip/dll). Soft problem — counted
                    // separately in the footer so it doesn't inflate the
                    // error count.
                    const isGone = !hasRealError && !!entry.latest_release_tag && !entry.latest_release_with_assets_tag;
                    const state: 'ok' | 'update' | 'gone' | 'unlinked' | 'error' =
                      hasRealError ? 'error'
                        : entry.needs_update ? 'update'
                        : !hasAnySource ? 'unlinked'
                        : isGone ? 'gone'
                        : 'ok';
                    const ledClass = {
                      ok: 'gf-audit-led-ok',
                      update: 'gf-audit-led-update',
                      gone: 'gf-audit-led-warn',
                      unlinked: '',
                      error: 'gf-audit-led-gone',
                    }[state];
                    return (
                      <div
                        key={entry.mod_name}
                        className="text-xs p-2 rounded-lg"
                        style={{
                          background: 'var(--indigo-panel)',
                          border: '1px solid var(--indigo-line)',
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-medium flex items-center gap-2" style={{ color: 'var(--ink)' }}>
                            <span className={`gf-audit-led ${ledClass}`} />
                            {entry.mod_name}
                            {entry.pinned && (
                              <span className="gf-pill" style={{ background: 'var(--indigo-elev)', color: 'var(--ink-mute)' }}>
                                <Pin size={9} /> PINNED
                              </span>
                            )}
                          </span>
                          <span className="flex items-center gap-2">
                            {entry.needs_update && entry.github_repo && (
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleUpdateOne(entry.mod_name);
                                }}
                                disabled={updatingMod === entry.mod_name || updatingAll}
                                className="gf-btn gf-btn-sm"
                                title={`Download and install v${entry.latest_release_with_assets_tag ?? entry.nexus_version ?? 'latest'}`}
                              >
                                {updatingMod === entry.mod_name || updatingAll ? (
                                  <><RefreshCw size={10} className="animate-spin" /> Updating…</>
                                ) : (
                                  <><Download size={10} /> Update</>
                                )}
                              </button>
                            )}
                            <button
                              onClick={async (e) => {
                                e.stopPropagation();
                                try {
                                  if (entry.pinned) {
                                    await unpinMod(entry.mod_name);
                                    toast.success(`Unpinned '${entry.mod_name}' — updates will be checked again.`);
                                  } else {
                                    await pinMod(entry.mod_name);
                                    toast.success(`Pinned '${entry.mod_name}' — version and on/off state locked.`);
                                  }
                                  // Pin/unpin only flips the `pinned` flag
                                  // and recomputes needs_update for THIS
                                  // row. No need to re-fetch every other
                                  // mod's source.
                                  await refreshAuditEntries([entry.mod_name]);
                                } catch (err) {
                                  toast.error(err instanceof Error ? err.message : String(err));
                                }
                              }}
                              className="gf-btn-3 gf-btn-2-sm"
                              title={entry.pinned ? 'Unpin — allow updates and profile changes' : 'Pin — lock version and on/off state'}
                            >
                              {entry.pinned ? <><PinOff size={9} /> Unpin</> : <><Pin size={9} /> Pin</>}
                            </button>
                            <span
                              className="gf-audit-mono"
                              title={
                                isGone
                                  ? `GitHub release ${entry.latest_release_tag ?? ''} ships no installable asset. Auto-update can't fetch from this source.`
                                  : undefined
                              }
                            >
                              {hasRealError
                                ? 'ERROR'
                                : entry.needs_update
                                ? `${entry.installed_version} → ${
                                    entry.update_source === 'nexus' || (!entry.latest_release_with_assets_tag && entry.nexus_version)
                                      ? entry.nexus_version
                                      : entry.latest_release_with_assets_tag
                                  }`
                                : !hasAnySource
                                ? 'No source'
                                : isGone
                                ? `${entry.installed_version} · release missing assets`
                                : `${entry.installed_version} (latest)`}
                            </span>
                          </span>
                        </div>
                        <div className="flex items-center gap-3 mt-1.5 ml-4" style={{ fontSize: 11 }}>
                          {entry.github_repo && (
                            <a
                              href={`https://github.com/${entry.github_repo}/releases`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 hover:underline"
                              style={{ color: entry.github_auto_detected ? 'var(--ink-dim)' : 'var(--gf)' }}
                            >
                              <ExternalLink size={10} />
                              {entry.github_repo}
                              {entry.github_auto_detected && (
                                <span className="text-text-dim opacity-60">(auto-detected)</span>
                              )}
                            </a>
                          )}
                          {entry.nexus_url && (
                            <a
                              href={entry.nexus_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 hover:underline"
                              style={{ color: 'var(--gf)' }}
                            >
                              <ExternalLink size={10} />
                              Nexus{entry.nexus_version ? ` (v${entry.nexus_version})` : ''}
                            </a>
                          )}
                          {entry.nexus_update_available && entry.nexus_url && (
                            <a
                              href={`${entry.nexus_url}?tab=files`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="gf-pill gf-pill-update inline-flex items-center gap-1 hover:underline"
                            >
                              <Download size={10} /> Download from Nexus
                            </a>
                          )}
                        </div>
                        {hasRealError && (
                          <div className="mt-1" style={{ color: 'oklch(0.75 0.13 25)', fontSize: 11 }}>
                            {entry.error}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                {(() => {
                  const okCount = auditResults.filter(r =>
                    (r.github_repo || r.nexus_url) &&
                    !r.needs_update &&
                    !(r.error && !r.github_auto_detected) &&
                    !(r.latest_release_tag && !r.latest_release_with_assets_tag)
                  ).length;
                  const updateCount = auditResults.filter(r => r.needs_update).length;
                  const goneCount = auditResults.filter(r =>
                    !(r.error && !r.github_auto_detected) &&
                    r.latest_release_tag &&
                    !r.latest_release_with_assets_tag &&
                    !r.needs_update
                  ).length;
                  const errCount = auditResults.filter(r => r.error && !r.github_auto_detected).length;
                  const pinnedCount = auditResults.filter(r => r.pinned).length;
                  const unlinkedCount = auditResults.filter(r => !r.github_repo && !r.nexus_url).length;
                  return (
                    <div className="gf-audit-foot" style={{ marginTop: 12 }}>
                      <div className="gf-audit-foot-stat">
                        <span className="gf-audit-led gf-audit-led-ok" />
                        {okCount} up to date
                      </div>
                      <div className="gf-audit-foot-stat">
                        <span className="gf-audit-led gf-audit-led-update" />
                        {updateCount} updates available
                      </div>
                      {goneCount > 0 && (
                        <div
                          className="gf-audit-foot-stat"
                          title="GitHub release exists but ships no installable asset — auto-update can't fetch from this source."
                        >
                          <span className="gf-audit-led gf-audit-led-warn" />
                          {goneCount} release{goneCount === 1 ? '' : 's'} missing assets
                        </div>
                      )}
                      <div className="gf-audit-foot-stat">
                        <span className="gf-audit-led gf-audit-led-gone" />
                        {errCount} error{errCount === 1 ? '' : 's'}
                      </div>
                      <div className="gf-audit-foot-stat" style={{ marginLeft: 'auto', color: 'var(--ink-dim)' }}>
                        {pinnedCount} pinned · {unlinkedCount} unlinked
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
          </>
        )}

        {tab === 'advanced' && (
          <>
            <div className="gf-section-title" style={{ marginTop: 0 }}>Quick actions</div>
            <Card className="space-y-3">
              <div className="flex gap-2 flex-wrap">
                <Button variant="secondary" size="sm" onClick={handleOpenGameFolder}>
                  <FolderOpen size={14} /> Open game folder
                </Button>
                <Button variant="secondary" size="sm" onClick={handleOpenModsFolder}>
                  <FolderOpen size={14} /> Open mods folder
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCheckUpdateNow}
                  disabled={checkingUpdate}
                >
                  <RefreshCw size={14} className={checkingUpdate ? 'animate-spin' : ''} />
                  {checkingUpdate ? 'Checking...' : 'Check for updates'}
                </Button>
              </div>
            </Card>

            <div className="gf-section-title">In-app logs</div>
            <LogsViewer />

            <div className="gf-section-title">Protocol handlers</div>
            <div className="gf-set-row">
              <div>
                <div className="gf-set-label">sts2mm:// handler</div>
                <div className="gf-set-desc">Handle one-click install links · registered automatically</div>
              </div>
              <span className="gf-pill gf-pill-ok">Active</span>
            </div>
            <div className="gf-set-row">
              <div>
                <div className="gf-set-label">nxm:// handler</div>
                <div className="gf-set-desc">Handle Nexus Mods download links · registered automatically</div>
              </div>
              <span className="gf-pill gf-pill-ok">Active</span>
            </div>
          </>
        )}

      </div>

      <DiagnosticBundle open={showDiag} onClose={() => setShowDiag(false)} />
      <AutoDetectModal
        open={showAutoDetect}
        onClose={() => setShowAutoDetect(false)}
        onApplied={() => {
          if (auditResults) handleRunAudit();
        }}
      />
    </div>
  );
}
