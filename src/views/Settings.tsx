import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
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
import { GITHUB_TOKEN_TEMPLATE_URL } from '../lib/githubLinks';
import { nexusFilesUrl } from '../lib/nexusUrl';
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
import { LanguageSelect } from '../components/LanguageSelect';
import {
  detectGamePath,
  setGamePath,
  setNexusApiKey,
  setGithubToken,
  openExternalUrl,
  openGameFolder,
  openModsFolder,
  getApiKeyStatus,
  pinMod,
  unpinMod,
  updateMod,
  createBackup,
  createBackupPreserving,
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
  const { t } = useTranslation();
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
      toast.error(t('settings.backups.loadFailed', { error: e instanceof Error ? e.message : String(e) }));
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

  // The `mod-auto-installed` event handler that auto-refreshes audit rows
  // after a Downloads-folder catch moved to AppContext (so the Mods view
  // gets the same behavior without re-binding the listener here).

  async function handleCreateBackup() {
    setBackupBusy('create');
    try {
      const name = await createBackup();
      toast.success(t('settings.backups.created', { name }));
      await refreshBackups();
    } catch (e) {
      toast.error(t('settings.backups.createFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBackupBusy(null);
    }
  }

  async function handleRestoreBackup(name: string) {
    const ok = await confirm({
      title: t('settings.backups.restoreConfirmTitle'),
      body: t('settings.backups.restoreConfirmBody'),
      confirmLabel: t('settings.backups.restoreConfirmLabel'),
      destructive: true,
      checkbox: { label: t('settings.backups.restoreCheckbox'), defaultChecked: true },
    });
    if (!ok) return;
    setBackupBusy(name);
    try {
      if (ok.checked) {
        try { await createBackupPreserving(name); } catch { /* non-fatal */ }
      }
      await restoreBackup(name);
      await refreshAll();
      toast.success(t('settings.backups.restored'));
    } catch (e) {
      toast.error(t('settings.backups.restoreFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBackupBusy(null);
    }
  }

  async function handleDeleteBackup(name: string) {
    const ok = await confirm({
      title: t('settings.backups.deleteConfirmTitle'),
      body: t('settings.backups.deleteConfirmBody'),
      confirmLabel: t('settings.backups.delete'),
      destructive: true,
    });
    if (!ok) return;
    setBackupBusy(name);
    try {
      await deleteBackup(name);
      toast.success(t('settings.backups.deleted'));
      await refreshBackups();
    } catch (e) {
      toast.error(t('settings.backups.deleteFailed', { error: e instanceof Error ? e.message : String(e) }));
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
        toast.success(t('settings.general.gameDetected'));
      } else {
        toast.error(t('settings.general.couldNotAutoDetect'));
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
        toast.success(t('settings.general.gamePathUpdated'));
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
        title: t('settings.general.selectSts2Folder'),
      });
      if (!selected) return;
      const picked = typeof selected === 'string' ? selected : String(selected);
      setGamePathValue(picked);
      const info = await setGamePath(picked);
      if (info.valid && info.game_path) {
        setGamePathValue(info.game_path);
        await refreshAll();
        toast.success(t('settings.general.gamePathUpdated'));
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
      toast.success(mode === 'steam' ? t('settings.general.launchModeSetSteam') : t('settings.general.launchModeSetDirect'));
    } catch (e) {
      setLaunchModeValue(previous);
      toast.error(t('settings.general.failedUpdateLaunchMode', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSavingLaunchMode(false);
    }
  }

  async function handleSaveNexusKey() {
    if (!nexusKey.trim()) return;
    try {
      await setNexusApiKey(nexusKey.trim());
      toast.success(t('settings.accounts.nexusKeySaved'));
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
      toast.success(t('settings.accounts.githubTokenSaved'));
      setGithubTokenValue('');
      setGithubTokenSaved(true);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleOpenGithubTokenTemplate() {
    try {
      await openExternalUrl(GITHUB_TOKEN_TEMPLATE_URL);
    } catch (e) {
      toast.error(t('settings.accounts.openGithubTokenPageFailed', { error: e instanceof Error ? e.message : String(e) }));
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
      toast.success(t('settings.audit.updatedToToast', { name: modName, version: info.version }));
      await refreshAll();
      // Re-audit only this mod (and the manifest name if install_mod_from_zip
      // ended up rewriting it) so the row flips fast — no full audit needed.
      const names = info.name !== modName ? [modName, info.name] : [modName];
      await refreshAuditEntries(names);
    } catch (e) {
      toast.error(t('settings.audit.updateFailedToast', { name: modName, error: e instanceof Error ? e.message : String(e) }));
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
        toast.success(t('settings.advanced.latestVersion'));
        return;
      }
      toast.success(t('settings.advanced.versionAvailable', { version: update.version }));
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      toast.error(t('settings.advanced.updateCheckFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setCheckingUpdate(false);
    }
  }

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: 'general',  label: t('settings.tabs.general') },
    { id: 'accounts', label: t('settings.tabs.accounts') },
    { id: 'backups',  label: t('settings.tabs.backups'),  count: backups.length || undefined },
    { id: 'audit',    label: t('settings.tabs.audit'),    count: auditResults?.filter(r => r.needs_update).length || undefined },
    { id: 'advanced', label: t('settings.tabs.advanced') },
    // About moved to the Home screen footer (v1.0.4) — kept the section in
    // history because the diag-bundle action and update-check now live there.
  ];

  return (
    <div className="gf-body" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="gf-page-head">
        <div>
          <h1 className="gf-page-title">{t('settings.title')}</h1>
          <p className="gf-page-sub">{t('settings.subtitle')}</p>
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
                {t('settings.general.gamePath')}
              </h3>
              <div className="gf-field" style={{ margin: 0 }}>
                <div className="gf-input-row">
                  <input
                    className={`gf-set-input ${gameInfo?.valid ? 'is-ok' : gamePath && !gameInfo?.valid ? 'is-err' : ''}`}
                    placeholder={
                      typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
                        ? t('settings.defaultPathMac')
                        : typeof navigator !== 'undefined' && /Linux/.test(navigator.platform)
                        ? t('settings.defaultPathLinux')
                        : t('settings.defaultPathWin')
                    }
                    value={gamePath}
                    onChange={(e) => setGamePathValue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSetGamePath()}
                    style={{ flex: 1 }}
                  />
                  <Button variant="secondary" size="sm" onClick={handleBrowseGamePath}>
                    {t('settings.general.browse')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={handleDetectGame}>
                    {t('settings.general.autoDetect')}
                  </Button>
                  <Button size="sm" onClick={handleSetGamePath}>
                    {t('settings.general.save')}
                  </Button>
                </div>
                {gameInfo?.valid ? (
                  <div className="gf-help ok">
                    <span>✓</span>
                    <span>
                      {t('settings.general.verified', { count: gameInfo.mods_count })} ·{' '}
                      <button onClick={handleOpenGameFolder} className="hover:underline" style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', padding: 0 }}>
                        {t('settings.general.openGameFolder')}
                      </button>
                      {' · '}
                      <button onClick={handleOpenModsFolder} className="hover:underline" style={{ background: 'none', border: 0, color: 'inherit', cursor: 'pointer', padding: 0 }}>
                        {t('settings.general.openModsFolder')}
                      </button>
                    </span>
                  </div>
                ) : gamePath ? (
                  <div className="gf-help err">
                    <span>!</span>
                    <span>
                      {t('settings.general.couldNotVerify', {
                        file:
                          typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
                            ? t('settings.sts2App')
                            : typeof navigator !== 'undefined' && /Linux/.test(navigator.platform)
                            ? t('settings.sts2Pck')
                            : t('settings.sts2Exe'),
                      })}
                    </span>
                  </div>
                ) : (
                  <div className="gf-help muted">
                    <span>{t('settings.general.autoDetectHint')}</span>
                  </div>
                )}
              </div>
            </Card>

            <Card className="space-y-4" style={{ marginTop: 8 }}>
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <Play size={16} />
                {t('settings.general.launch')}
              </h3>
              <div className="gf-set-desc" style={{ marginTop: -6 }}>
                {t('settings.general.launchDesc')}
              </div>
              <div role="radiogroup" aria-label={t('settings.general.launchModeAria')} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {([
                  {
                    value: 'steam' as LaunchMode,
                    title: t('settings.general.steamRecommended'),
                    desc: t('settings.general.steamDesc'),
                  },
                  {
                    value: 'direct' as LaunchMode,
                    title: t('settings.general.direct'),
                    desc: t('settings.general.directDesc'),
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

            <Card className="space-y-4" style={{ marginTop: 8 }}>
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <Key size={16} />
                {t('settings.language.label')}
              </h3>
              <LanguageSelect />
            </Card>
          </>
        )}

        {tab === 'accounts' && (
          <>
            <Card className="space-y-4">
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <Key size={18} />
                {t('settings.accounts.nexusKey')}
                {nexusKeySaved && (
                  <span className="gf-pill gf-pill-update" style={{ marginLeft: 6 }}>{t('settings.accounts.saved')}</span>
                )}
              </h3>
              <div className="gf-field" style={{ margin: 0 }}>
                <div className="gf-input-row">
                  <input
                    className={`gf-set-input ${nexusKeySaved && !nexusKey ? 'is-ok' : ''}`}
                    type="password"
                    placeholder={nexusKeySaved ? t('settings.accounts.nexusSavedPlaceholder') : t('settings.accounts.nexusPlaceholder')}
                    value={nexusKey}
                    onChange={(e) => setNexusKey(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveNexusKey()}
                    style={{ flex: 1 }}
                  />
                  <Button size="sm" onClick={handleSaveNexusKey}>
                    {t('common.save')}
                  </Button>
                </div>
                {nexusKeySaved && !nexusKey ? (
                  <div className="gf-help ok">
                    <span>✓</span><span>{t('settings.accounts.nexusSavedHelp')}</span>
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
                        {t('settings.accounts.nexusApiLink')} <ExternalLink size={11} />
                      </a>
                    </span>
                  </div>
                )}
                <div className="gf-help muted" style={{ marginTop: 6, fontSize: 11.5 }}>
                  <span>
                    {t('settings.accounts.nexusTierNote')}
                  </span>
                </div>
              </div>
            </Card>

            <Card className="space-y-4" style={{ marginTop: 8 }}>
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <Key size={18} />
                {t('settings.accounts.githubToken')}
                <span className="text-xs text-text-dim font-normal">{t('settings.accounts.optional')}</span>
                {githubTokenSaved && (
                  <span className="gf-pill gf-pill-update" style={{ marginLeft: 6 }}>{t('settings.accounts.saved')}</span>
                )}
              </h3>
              <div className="gf-field" style={{ margin: 0 }}>
                <div className="gf-input-row">
                  <input
                    className={`gf-set-input ${githubTokenSaved && !githubToken ? 'is-ok' : ''}`}
                    type="password"
                    placeholder={githubTokenSaved ? t('settings.accounts.githubSavedPlaceholder') : t('settings.accounts.githubPlaceholder')}
                    value={githubToken}
                    onChange={(e) => setGithubTokenValue(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSaveGithubToken()}
                    style={{ flex: 1 }}
                  />
                  <Button variant="secondary" size="sm" onClick={handleSaveGithubToken}>
                    {t('common.save')}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={handleOpenGithubTokenTemplate}>
                    <ExternalLink size={14} />
                    {t('settings.accounts.createScopedToken')}
                  </Button>
                </div>
                {githubTokenSaved && !githubToken && (
                  <div className="gf-help ok">
                    <span>✓</span><span>{t('settings.accounts.githubSavedHelp')}</span>
                  </div>
                )}
                <div className="gf-help muted">
                  <span>
                    {t('settings.accounts.githubHelp')}
                    <br />
                    {t('settings.accounts.githubScopesTitle')}
                    <ul style={{ margin: '4px 0 0 14px', padding: 0, listStyle: 'disc' }}>
                      <li><b>{t('settings.accounts.githubClassicPat')}</b></li>
                      <li>
                        <b>{t('settings.accounts.githubFinePat')}</b>
                      </li>
                    </ul>
                  </span>
                </div>
              </div>
            </Card>
          </>
        )}

        {tab === 'backups' && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <div>
                <div className="gf-set-label" style={{ fontSize: 14 }}>{t('settings.backups.title')}</div>
                <div className="gf-set-desc">{t('settings.backups.desc')}</div>
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <Button variant="secondary" size="sm" onClick={handleOpenModsFolder}>
                  <FolderOpen size={14} /> {t('settings.backups.openFolder')}
                </Button>
                <Button size="sm" onClick={handleCreateBackup} disabled={backupBusy !== null}>
                  <Archive size={14} />
                  {backupBusy === 'create' ? t('settings.backups.creating') : t('settings.backups.create')}
                </Button>
              </div>
            </div>
            {backups.length === 0 ? (
              <div className="gf-empty">
                <div className="gf-empty-art"><Archive size={28} /></div>
                <div className="gf-empty-title">{t('settings.backups.noBackups')}</div>
                <div className="gf-empty-sub">{t('settings.backups.noBackupsHint')}</div>
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
                          <span className="gf-pill gf-pill-update" style={{ marginLeft: 8 }}>{t('settings.backups.newest')}</span>
                        )}
                      </div>
                      <div className="gf-backup-meta">
                        {b.mod_count} {b.mod_count === 1 ? t('settings.backups.files_one', { count: 1 }) : t('settings.backups.files_other', { count: b.mod_count })} · {formatSizeMb(b.size_bytes)}
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
                      {busy ? t('settings.backups.restoring') : t('settings.backups.restore')}
                    </Button>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => handleDeleteBackup(b.name)}
                      disabled={anyBusy}
                      title={t('settings.backups.deleteTitle')}
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
                    <div className="gf-set-label" style={{ fontSize: 14 }}>{t('settings.audit.title')}</div>
                    <div className="gf-set-desc">{t('settings.audit.desc')}</div>
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
                        title={ghUpdates.length === 1 ? t('settings.audit.updateAll_one', { count: ghUpdates.length }) : t('settings.audit.updateAll_other', { count: ghUpdates.length })}
                      >
                        {updatingAll ? (
                          <RefreshCw size={14} className="animate-spin" />
                        ) : (
                          <Download size={14} />
                        )}
                        {updatingAll
                          ? t('settings.audit.updatingAll', { count: ghUpdates.length })
                          : (ghUpdates.length === 1 ? t('settings.audit.updateAll_one', { count: ghUpdates.length }) : t('settings.audit.updateAll_other', { count: ghUpdates.length }))}
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => setShowAutoDetect(true)} disabled={updatingAll}>
                      {t('settings.audit.autoDetectSources')}
                    </Button>
                    <Button
                      variant={ghUpdates.length >= 2 ? 'ghost' : 'secondary'}
                      size="sm"
                      onClick={runAudit}
                      disabled={auditing || updatingAll}
                    >
                      <ClipboardCheck size={14} className={auditing ? 'animate-pulse' : ''} />
                      {auditing ? t('settings.audit.auditing') : auditResults ? t('settings.audit.reaudit') : t('settings.audit.run')}
                    </Button>
                  </div>
                </div>
              );
            })()}

            {auditResults === null ? (
              <div className="gf-empty">
                <div className="gf-empty-art"><ClipboardCheck size={28} /></div>
                <div className="gf-empty-title">{t('settings.audit.noAudit')}</div>
                <div className="gf-empty-sub">{t('settings.audit.noAuditHint')}</div>
                <div style={{ marginTop: 14 }}>
                  <Button onClick={runAudit} disabled={auditing}>
                    <ClipboardCheck size={14} /> {auditing ? t('settings.audit.auditing') : t('settings.audit.run')}
                  </Button>
                </div>
              </div>
            ) : auditResults.length === 0 ? (
              <div className="gf-empty">
                <div className="gf-empty-art"><ClipboardCheck size={28} /></div>
                <div className="gf-empty-title">{t('settings.audit.noMods')}</div>
                <div className="gf-empty-sub">{t('settings.audit.noModsHint')}</div>
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
                              <span className="gf-pill gf-pill-ok" title={t('settings.onLatestRelease')}>
                                <Check size={9} /> {t('settings.audit.latest')}
                              </span>
                            )}
                            {entry.pinned && (
                              <span className="gf-pill" style={{ background: 'var(--indigo-elev)', color: 'var(--ink-mute)' }}>
                                <Pin size={9} /> {t('settings.audit.pinned')}
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
                                    ? t('settings.updateGameBlocked', { version: entry.latest_release_with_assets_tag, compatibleVersion: entry.latest_compatible_tag })
                                    : t('settings.downloadInstall', { tag: entry.latest_compatible_tag ?? entry.latest_release_with_assets_tag })
                                }
                              >
                                {updatingMod === entry.mod_name || updatingAll ? (
                                  <><RefreshCw size={10} className="animate-spin" /> {t('settings.audit.updating')}</>
                                ) : (
                                  <><Download size={10} /> {t('settings.audit.update')}</>
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
                                    toast.success(t('settings.unpinnedToast', { name: entry.mod_name }));
                                  } else {
                                    await pinMod(entry.mod_name, folder);
                                    toast.success(t('settings.pinnedToast', { name: entry.mod_name }));
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
                              title={entry.pinned ? t('settings.audit.unpinTooltip') : t('settings.audit.pinTooltip')}
                            >
                              {entry.pinned ? <><PinOff size={9} /> {t('settings.audit.unpin')}</> : <><Pin size={9} /> {t('settings.audit.pin')}</>}
                            </button>
                            <span
                              className="gf-audit-mono"
                              title={
                                isGone
                                  ? t('settings.noAssetTooltip', { version: entry.latest_release_tag ?? '' })
                                  : undefined
                              }
                            >
                              {hasRealError
                                ? t('settings.audit.error')
                                : entry.needs_update
                                ? t('settings.audit.versionArrow', {
                                    installed: entry.installed_version,
                                    available:
                                      entry.update_source === 'nexus' || (!entry.latest_release_with_assets_tag && entry.nexus_version)
                                        ? entry.nexus_version
                                        : entry.latest_compatible_tag ?? entry.latest_release_with_assets_tag,
                                  })
                                : !hasAnySource
                                ? t('settings.audit.noSource')
                                : isGone
                                ? t('settings.audit.nexusReleaseMissing', { version: entry.installed_version })
                                : `${entry.installed_version} ${t('settings.audit.latest2')}`}
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
                                <span className="text-text-dim opacity-60">{t('settings.audit.autoDetected')}</span>
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
                              {entry.nexus_version ? t('settings.audit.nexusVersion', { version: entry.nexus_version }) : t('settings.nexusFallback')}
                            </a>
                          )}
                          {entry.nexus_update_available && entry.nexus_url && (
                            <a
                              href={nexusFilesUrl(entry.nexus_url) ?? `${entry.nexus_url}?tab=files`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="gf-pill gf-pill-update inline-flex items-center gap-1 hover:underline"
                            >
                              <Download size={10} /> {t('settings.audit.downloadFromNexus')}
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
                            title={t('settings.auditGameVersionBlock', { declared: entry.min_game_version, installed: gameInfo?.game_version ?? 'unknown' })}
                          >
                            ⚠ {t('settings.auditWontLoad', { version: entry.min_game_version, installed: gameInfo?.game_version ?? '?' })}
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
                              title={t('settings.auditCompatTag', { latest: entry.latest_release_with_assets_tag, required: entry.latest_release_min_game_version ?? '?', compatible: entry.latest_compatible_tag })}
                            >
                              ↺ {t('settings.auditCompatTagVisible', { latest: entry.latest_release_with_assets_tag, required: entry.latest_release_min_game_version ?? '?', compatible: entry.latest_compatible_tag })}
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
                              title={t('settings.auditAlreadyCompat', { version: entry.latest_release_with_assets_tag, required: entry.latest_release_min_game_version ?? '?', installed: entry.installed_version })}
                            >
                              ↺ {t('settings.auditAlreadyCompatVisible', { version: entry.latest_release_with_assets_tag, required: entry.latest_release_min_game_version ?? '?', installed: entry.installed_version })}
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
                        {okCount} {t('settings.audit.upToDate')}
                      </div>
                      <div className="gf-audit-foot-stat">
                        <span className="gf-audit-led gf-audit-led-update" />
                        {updateCount} {t('settings.audit.updatesAvailable')}
                      </div>
                      {incompatibleCount > 0 && (
                        <div
                          className="gf-audit-foot-stat"
                          title={t('settings.audit.wontLoadTitle', { version: gameInfo?.game_version ?? '?' })}
                        >
                          <span className="gf-audit-led gf-audit-led-warn" />
                          {incompatibleCount} {t('settings.audit.wontLoad')}
                        </div>
                      )}
                      {goneCount > 0 && (
                        <div
                          className="gf-audit-foot-stat"
                          title={t('settings.audit.goneTitle')}
                        >
                          <span className="gf-audit-led gf-audit-led-warn" />
                          {goneCount === 1 ? t('settings.audit.releasesMissingAssets_one', { count: goneCount }) : t('settings.audit.releasesMissingAssets_other', { count: goneCount })}
                        </div>
                      )}
                      <div className="gf-audit-foot-stat">
                        <span className="gf-audit-led gf-audit-led-gone" />
                        {errCount === 1 ? t('settings.audit.errorCount_one', { count: errCount }) : t('settings.audit.errorCount_other', { count: errCount })}
                      </div>
                      <div className="gf-audit-foot-stat" style={{ marginLeft: 'auto', color: 'var(--ink-dim)' }}>
                        {t('settings.audit.pinnedCount', { count: pinnedCount })} · {t('settings.audit.unlinkedCount', { count: unlinkedCount })}
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
            <div className="gf-section-title" style={{ marginTop: 0 }}>{t('settings.advanced.quickActions')}</div>
            <Card className="space-y-3">
              <div className="flex gap-2 flex-wrap">
                <Button variant="secondary" size="sm" onClick={handleOpenGameFolder}>
                  <FolderOpen size={14} /> {t('settings.advanced.openGameFolder')}
                </Button>
                <Button variant="secondary" size="sm" onClick={handleOpenModsFolder}>
                  <FolderOpen size={14} /> {t('settings.advanced.openModsFolder')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={handleCheckUpdateNow}
                  disabled={checkingUpdate}
                >
                  <RefreshCw size={14} className={checkingUpdate ? 'animate-spin' : ''} />
                  {checkingUpdate ? t('settings.advanced.checking') : t('settings.advanced.checkForUpdates')}
                </Button>
              </div>
            </Card>

            <div className="gf-section-title">{t('settings.advanced.inAppLogs')}</div>
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
