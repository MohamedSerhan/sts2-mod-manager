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
  Play,
  Check,
} from 'lucide-react';
import { isUpToDate } from '../lib/auditState';
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
  pinMod,
  unpinMod,
  updateMod,
  createBackup,
  listBackups,
  restoreBackup,
  deleteBackup,
  getLaunchMode,
  setLaunchMode,
} from '../hooks/useTauri';
import type { LaunchMode } from '../hooks/useTauri';
import type { BackupInfo } from '../types';

type Tab = 'general' | 'accounts' | 'backups' | 'audit' | 'advanced';

// v5 — tabbed Settings shell. Tabs are stateful; tab content is rendered
// inline beneath the tab strip. All existing handlers preserved.
export function SettingsView() {
  const { gameInfo, refreshAll, auditResults, auditing, runAudit, refreshAuditEntries, updatingAll, updateAllGithub } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>('general');

  // ── General ─────────────────────────────────────────
  const [gamePath, setGamePathValue] = useState('');
  const [launchMode, setLaunchModeValue] = useState<LaunchMode>('steam');
  const [savingLaunchMode, setSavingLaunchMode] = useState(false);

  // ── Accounts ────────────────────────────────────────
  const [nexusKey, setNexusKey] = useState('');
  const [githubToken, setGithubTokenValue] = useState('');
  const [nexusKeySaved, setNexusKeySaved] = useState(false);
  const [githubTokenSaved, setGithubTokenSaved] = useState(false);

  // ── Audit ───────────────────────────────────────────
  // Audit state (auditing + auditResults + refreshAuditEntries) lives in
  // AppContext so the Mods view can share it. Keep updatingMod local —
  // it's a Settings-only UI spinner.
  const [updatingMod, setUpdatingMod] = useState<string | null>(null);

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
  useEffect(() => {
    getLaunchMode().then(setLaunchModeValue).catch(() => {});
  }, []);

  // When a mod is auto-installed by the Downloads watcher (NXM link or
  // The `mod-auto-installed` event handler that auto-refreshes audit rows
  // after a Downloads-folder catch moved to AppContext (so the Mods view
  // gets the same behavior without re-binding the listener here).

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

  async function handleChangeLaunchMode(mode: LaunchMode) {
    if (mode === launchMode || savingLaunchMode) return;
    setSavingLaunchMode(true);
    const previous = launchMode;
    setLaunchModeValue(mode);
    try {
      await setLaunchMode(mode);
      toast.success(`Launch mode set to ${mode === 'steam' ? 'Steam' : 'Direct'}`);
    } catch (e) {
      setLaunchModeValue(previous);
      toast.error(`Failed to update launch mode: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingLaunchMode(false);
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

  // runAudit + refreshAuditEntries now live in AppContext as runAudit
  // and refreshAuditEntries. Settings consumes them directly via useApp().

  // Update a single mod inline from the audit row. Only available for mods
  // whose source is GitHub — Nexus mods still require the user to download
  // through the browser via the existing "Download from Nexus" pill.
  async function handleUpdateOne(modName: string, folderName: string | null) {
    if (updatingMod) return;
    setUpdatingMod(modName);
    try {
      const info = await updateMod(modName, folderName);
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
                    <span>!</span>
                    <span>
                      Couldn't verify{' '}
                      {typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
                        ? 'SlayTheSpire2.app'
                        : typeof navigator !== 'undefined' && /Linux/.test(navigator.platform)
                        ? 'SlayTheSpire2.pck'
                        : 'SlayTheSpire2.exe'}{' '}
                      in this folder. Pick the install root, not a subfolder.
                    </span>
                  </div>
                ) : (
                  <div className="gf-help muted">
                    <span>Click <b>Auto-detect</b> to find your Steam install, or <b>Browse</b> to pick the folder manually.</span>
                  </div>
                )}
              </div>
            </Card>

            <Card className="space-y-4" style={{ marginTop: 8 }}>
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <Play size={16} />
                Launch
              </h3>
              <div className="gf-set-desc" style={{ marginTop: -6 }}>
                How the Launch button and <code>Ctrl/⌘ L</code> start Slay the Spire 2.
              </div>
              <div role="radiogroup" aria-label="Launch mode" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {([
                  {
                    value: 'steam' as LaunchMode,
                    title: 'Steam (recommended)',
                    desc: 'Launches via Steam. Required for cloud saves, achievements, and Proton on Linux.',
                  },
                  {
                    value: 'direct' as LaunchMode,
                    title: 'Direct',
                    desc: 'Skips the Steam launcher and runs the game executable. Steam itself still needs to be running — STS2 uses Steamworks for saves and achievements. Useful for Family Sharing borrowers (the lender\'s library lock blocks normal Steam launches) and Steam offline mode. Not supported for Proton/Linux installs.',
                  },
                ]).map((opt) => {
                  const selected = launchMode === opt.value;
                  return (
                    <label
                      key={opt.value}
                      className="gf-launch-mode-row"
                      style={{
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: 10,
                        padding: '10px 12px',
                        borderRadius: 7,
                        border: `1px solid ${selected ? 'var(--gf)' : 'var(--indigo-line)'}`,
                        background: selected ? 'oklch(0.65 0.13 70 / 0.08)' : 'var(--indigo-panel)',
                        cursor: savingLaunchMode ? 'progress' : 'pointer',
                        opacity: savingLaunchMode && !selected ? 0.7 : 1,
                      }}
                    >
                      <input
                        type="radio"
                        name="launch-mode"
                        value={opt.value}
                        checked={selected}
                        disabled={savingLaunchMode}
                        onChange={() => handleChangeLaunchMode(opt.value)}
                        style={{ marginTop: 2, accentColor: 'var(--gf)' }}
                      />
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                          {opt.title}
                        </span>
                        <span style={{ fontSize: 12, color: 'var(--ink-mute)' }}>
                          {opt.desc}
                        </span>
                      </div>
                    </label>
                  );
                })}
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
                <div className="gf-help muted" style={{ marginTop: 6, fontSize: 11.5 }}>
                  <span>
                    Free-tier only. To install a Nexus mod, click the
                    "Slow Download" / "Manual" button on Nexus — the app
                    catches the zip from your <code>Downloads</code> folder.
                    The "Mod Manager Download" button isn't wired through.
                    Nexus Premium's instant-download API isn't either, so
                    paid subscribers don't get faster downloads here.
                  </span>
                </div>
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
                      Optional for browsing GitHub mods (raises rate limit to 5,000 req/hr from
                      60/hr without auth). <b>Required</b> if you want to publish modpacks.
                      <br />
                      Scopes for sharing:
                      <ul style={{ margin: '4px 0 0 14px', padding: 0, listStyle: 'disc' }}>
                        <li><b>Classic PAT</b> — check the <code>repo</code> scope.</li>
                        <li>
                          <b>Fine-grained PAT</b> — repository access scoped to <code>sts2mm-profiles</code>{' '}
                          (or "All repositories"), with{' '}
                          <b>Contents: Read and write</b> + <b>Administration: Read and write</b>{' '}
                          (Administration is only needed for the one-time repo create; you can drop it after).
                        </li>
                      </ul>
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
              // gating below. We require latest_release_with_assets_tag too
              // — same reason the per-row Update button does: rows where
              // GitHub's latest release has no installable asset can't be
              // updated via update_mod and would just produce errors during
              // a bulk Update all.
              const ghUpdates = auditResults
                ? auditResults
                    .filter((r) => r.needs_update && r.github_repo && r.latest_release_with_assets_tag)
                    .map((r) => r.mod_name)
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
                        onClick={() => updateAllGithub(ghUpdates)}
                        disabled={updatingAll || updatingMod !== null}
                        title={`Update ${ghUpdates.length} GitHub-sourced mods (skips pinned)`}
                      >
                        {updatingAll ? (
                          <RefreshCw size={14} className="animate-spin" />
                        ) : (
                          <Download size={14} />
                        )}
                        {updatingAll
                          ? `Updating ${ghUpdates.length}…`
                          : `Update ${ghUpdates.length} mod${ghUpdates.length === 1 ? '' : 's'}`}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setShowAutoDetect(true)} disabled={updatingAll}>
                      Auto-detect sources
                    </Button>
                    <Button
                      variant={ghUpdates.length >= 2 ? 'ghost' : 'secondary'}
                      size="sm"
                      onClick={runAudit}
                      disabled={auditing || updatingAll}
                    >
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
                  <Button onClick={runAudit} disabled={auditing}>
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
                    const isIncompatible = !!entry.game_version_too_old;
                    // Incompatible takes precedence over OK so the row reads
                    // as "won't load" instead of "up to date" — but updates
                    // and real errors still take precedence over it,
                    // because the user can fix those by clicking Update /
                    // resolving the error before they have to think about
                    // the game-version mismatch.
                    const state: 'ok' | 'update' | 'gone' | 'unlinked' | 'error' | 'incompatible' =
                      hasRealError ? 'error'
                        : entry.needs_update ? 'update'
                        : !hasAnySource ? 'unlinked'
                        : isIncompatible ? 'incompatible'
                        : isGone ? 'gone'
                        : 'ok';
                    const ledClass = {
                      ok: 'gf-audit-led-ok',
                      update: 'gf-audit-led-update',
                      gone: 'gf-audit-led-warn',
                      incompatible: 'gf-audit-led-warn',
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
                            {isUpToDate(entry) && (
                              <span className="gf-pill gf-pill-ok" title="On the source's latest installable release.">
                                <Check size={9} /> Latest
                              </span>
                            )}
                            {entry.pinned && (
                              <span className="gf-pill" style={{ background: 'var(--indigo-elev)', color: 'var(--ink-mute)' }}>
                                <Pin size={9} /> PINNED
                              </span>
                            )}
                          </span>
                          <span className="flex items-center gap-2">
                            {entry.needs_update &&
                              entry.github_repo &&
                              entry.latest_release_with_assets_tag &&
                              (entry.update_source === 'github' || entry.update_source === 'both') && (
                              // Only show the Update button when GitHub
                              // specifically has an actionable update —
                              // i.e. there's an installable asset AND
                              // the walked-back compatible tag is newer
                              // than what's installed. If only Nexus
                              // flagged an update, the Nexus pill below
                              // handles it; clicking Update would call
                              // update_mod which goes through GitHub and
                              // (post-walk-back) refuses, surfacing as a
                              // confusing error toast. Gating on
                              // update_source keeps the button honest.
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  handleUpdateOne(entry.mod_name, entry.folder_name ?? null);
                                }}
                                disabled={updatingMod === entry.mod_name || updatingAll}
                                className="gf-btn gf-btn-sm"
                                title={
                                  entry.latest_release_blocked_by_game_version && entry.latest_compatible_tag
                                    ? `Latest v${entry.latest_release_with_assets_tag} requires game v${entry.latest_release_min_game_version ?? '?'}. ` +
                                      `Will install the newest compatible release: v${entry.latest_compatible_tag}.`
                                    : `Download and install v${entry.latest_compatible_tag ?? entry.latest_release_with_assets_tag}`
                                }
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
                                  // Pass folder_name so two same-named
                                  // mods are pinned independently. Falls
                                  // back to display-name keying when the
                                  // audit row didn't carry a folder.
                                  const folder = entry.folder_name ?? null;
                                  if (entry.pinned) {
                                    await unpinMod(entry.mod_name, folder);
                                    toast.success(`Unpinned '${entry.mod_name}' — updates will be checked again.`);
                                  } else {
                                    await pinMod(entry.mod_name, folder);
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
                                      : entry.latest_compatible_tag ?? entry.latest_release_with_assets_tag
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
                        {entry.game_version_too_old && entry.min_game_version && (
                          <div
                            className="mt-1 ml-4"
                            style={{
                              fontSize: 11,
                              color: 'oklch(0.78 0.16 60)',
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                            }}
                            title={
                              `This mod's manifest declares min_game_version=${entry.min_game_version}. ` +
                              `Your STS2 install reports ${gameInfo?.game_version ?? 'unknown'}. ` +
                              `Until you update STS2 (or switch beta branches), the game's loader will silently skip this mod.`
                            }
                          >
                            ⚠ Won't load on your game (needs Slay the Spire 2 ≥ v
                            {entry.min_game_version}; you have v
                            {gameInfo?.game_version ?? '?'}). Use Repair on the
                            Mods row to roll back to a compatible release.
                          </div>
                        )}
                        {entry.latest_release_blocked_by_game_version && (
                          entry.latest_compatible_tag ? (
                            <div
                              className="mt-1 ml-4"
                              style={{
                                fontSize: 11,
                                color: 'var(--ink-dim)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                              }}
                              title={
                                `Latest release v${entry.latest_release_with_assets_tag} requires game v${entry.latest_release_min_game_version ?? '?'}. ` +
                                `Update will walk back to v${entry.latest_compatible_tag}, the newest release compatible with your STS2 build.`
                              }
                            >
                              ↺ Latest v{entry.latest_release_with_assets_tag} needs
                              game v{entry.latest_release_min_game_version ?? '?'};
                              Update will install v{entry.latest_compatible_tag}{' '}
                              (newest compatible).
                            </div>
                          ) : (
                            <div
                              className="mt-1 ml-4"
                              style={{
                                fontSize: 11,
                                color: 'var(--ink-dim)',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 6,
                              }}
                              title={
                                `Latest release v${entry.latest_release_with_assets_tag} requires game v${entry.latest_release_min_game_version ?? '?'}. ` +
                                `You're already on v${entry.installed_version}, the newest release that runs on your current STS2 build. ` +
                                `Update STS2 (or switch beta branches) to pick up the newer mod release.`
                              }
                            >
                              ↺ Latest v{entry.latest_release_with_assets_tag} needs
                              game v{entry.latest_release_min_game_version ?? '?'};
                              you're on v{entry.installed_version} — the newest
                              version that runs on your game.
                            </div>
                          )
                        )}
                      </div>
                    );
                  })}
                </div>
                {(() => {
                  const incompatibleCount = auditResults.filter(r => r.game_version_too_old).length;
                  const okCount = auditResults.filter(isUpToDate).length;
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
                      {incompatibleCount > 0 && (
                        <div
                          className="gf-audit-foot-stat"
                          title={
                            `These mods declare a min_game_version above your detected STS2 build (v${gameInfo?.game_version ?? '?'}). ` +
                            `Use Repair on each Mods row to roll back to a compatible release.`
                          }
                        >
                          <span className="gf-audit-led gf-audit-led-warn" />
                          {incompatibleCount} won't load
                        </div>
                      )}
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
          </>
        )}

      </div>

      <DiagnosticBundle open={showDiag} onClose={() => setShowDiag(false)} />
      <AutoDetectModal
        open={showAutoDetect}
        onClose={() => setShowAutoDetect(false)}
        onApplied={() => {
          if (auditResults) runAudit();
        }}
      />
    </div>
  );
}
