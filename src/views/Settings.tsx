import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FolderSearch,
  Key,
  FolderOpen,
  RefreshCw,
  ExternalLink,
  Archive,
  RotateCcw,
  Trash2,
  Play,
  Download,
  Palette,
  SlidersHorizontal,
  ALargeSmall,
  Layers,
} from 'lucide-react';
import { GITHUB_TOKEN_TEMPLATE_URL } from '../lib/githubLinks';
import { open } from '@tauri-apps/plugin-dialog';
import { downloadDir } from '@tauri-apps/api/path';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmDialog';
import { LogsViewer } from '../components/LogsViewer';
import { LanguageSelect } from '../components/LanguageSelect';
import { ThemeSelect } from '../components/ThemeSelect';
import { UiScaleSlider } from '../components/UiScaleSlider';
import { Toggle } from '../components/Toggle';
import { AboutCard } from '../components/AboutCard';
import { RowMenuCustomizer } from '../components/RowMenuCustomizer';
import { DevBuildsCard } from '../components/DevBuildsCard';
import { isDevBuild } from '../lib/isDevBuild';
import {
  loadAutoAddInstallsToModpack,
  saveAutoAddInstallsToModpack,
} from '../lib/installPolicy';
import {
  detectGamePath,
  setGamePath,
  setNexusApiKey,
  setGithubToken,
  openExternalUrl,
  openGameFolder,
  openModsFolder,
  getApiKeyStatus,
  createBackup,
  createBackupPreserving,
  listBackups,
  restoreBackup,
  deleteBackup,
  getLaunchMode,
  setLaunchMode,
  getNexusDownloadDir,
  setNexusDownloadDir,
  getBackupRetention,
  setBackupRetention,
} from '../hooks/useTauri';
import type { LaunchMode } from '../hooks/useTauri';
import type { BackupInfo } from '../types';

type Tab = 'general' | 'accounts' | 'backups' | 'advanced';

// v5 — tabbed Settings shell. Tabs are stateful; tab content is rendered
// inline beneath the tab strip. All existing handlers preserved.
export function SettingsView({
  goToGeneralSignal,
  openRowMenuSettingsSignal = 0,
}: {
  goToGeneralSignal?: number;
  openRowMenuSettingsSignal?: number;
}) {
  const { gameInfo, refreshAll } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('general');
  const rowMenuCardRef = useRef<HTMLDivElement>(null);
  const [rowMenuFlash, setRowMenuFlash] = useState(false);

  // The top-bar "STS2 detected" status jumps here; when Settings is already
  // open on another sub-tab, this signal pulls the user back to General
  // (where the game path lives) instead of the click doing nothing (#138).
  useEffect(() => {
    if (goToGeneralSignal) setTab('general');
  }, [goToGeneralSignal]);

  // ── General ─────────────────────────────────────────
  const [gamePath, setGamePathValue] = useState('');
  const [launchMode, setLaunchModeValue] = useState<LaunchMode>('steam');
  const [savingLaunchMode, setSavingLaunchMode] = useState(false);
  const [autoAddInstallsToModpack, setAutoAddInstallsToModpack] = useState(
    loadAutoAddInstallsToModpack,
  );
  const [nexusDownloadDir, setNexusDownloadDirValue] = useState<string | null>(null);
  // The OS default Downloads folder, resolved once on mount. Shown in the
  // read-only path box when no custom folder is set, so the box always names
  // the folder actually being watched — the backend watcher falls back to this
  // same directory (dirs::download_dir()) when nexus_download_dir is unset.
  const [defaultDownloadDir, setDefaultDownloadDir] = useState<string | null>(null);

  // ── Accounts ────────────────────────────────────────
  const [nexusKey, setNexusKey] = useState('');
  const [githubToken, setGithubTokenValue] = useState('');
  const [nexusKeySaved, setNexusKeySaved] = useState(false);
  const [githubTokenSaved, setGithubTokenSaved] = useState(false);

  // ── Backups ─────────────────────────────────────────
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [backupBusy, setBackupBusy] = useState<string | null>(null);
  const [backupRetention, setBackupRetentionValue] = useState<number>(2);
  const [savingRetention, setSavingRetention] = useState(false);

  // ── Updates (Advanced) ──────────────────────────────
  const [checkingUpdate, setCheckingUpdate] = useState(false);

  // ── Dev-builds gate ─────────────────────────────────
  const [showDevBuilds, setShowDevBuilds] = useState(false);
  useEffect(() => {
    isDevBuild().then(setShowDevBuilds).catch(() => {});
  }, []);

  // ── Deep-link from "Customize menu…" kebab item ──────
  // When the signal bumps, switch to the General tab and scroll/highlight the customizer card.
  useEffect(() => {
    if (openRowMenuSettingsSignal === 0) return;
    setTab('general');
    // Defer one frame so the general tab content is mounted before we scroll.
    const id = setTimeout(() => {
      rowMenuCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setRowMenuFlash(true);
      setTimeout(() => setRowMenuFlash(false), 1200);
    }, 0);
    return () => clearTimeout(id);
  }, [openRowMenuSettingsSignal]);

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
  useEffect(() => {
    getNexusDownloadDir().then(setNexusDownloadDirValue).catch(() => {});
  }, []);
  useEffect(() => {
    getBackupRetention().then(setBackupRetentionValue).catch(() => {});
  }, []);
  useEffect(() => {
    downloadDir().then(setDefaultDownloadDir).catch(() => {});
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

  async function handleChangeBackupRetention(count: number) {
    if (count === backupRetention || savingRetention) return;
    const previous = backupRetention;
    setSavingRetention(true);
    setBackupRetentionValue(count);
    try {
      const saved = await setBackupRetention(count);
      setBackupRetentionValue(saved);
      toast.success(
        saved === 0
          ? t('settings.backups.retentionSavedOff')
          : t('settings.backups.retentionSaved', { count: saved }),
      );
    } catch (e) {
      setBackupRetentionValue(previous);
      toast.error(t('settings.backups.retentionFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setSavingRetention(false);
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

  function handleChangeAutoAddInstallsToModpack(enabled: boolean) {
    setAutoAddInstallsToModpack(enabled);
    saveAutoAddInstallsToModpack(enabled);
  }

  async function handleBrowseNexusDownloadDir() {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('settings.general.nexusDownloadDirSelect'),
      });
      if (!selected) return;
      const picked = typeof selected === 'string' ? selected : String(selected);
      const result = await setNexusDownloadDir(picked);
      setNexusDownloadDirValue(result);
      toast.success(t('settings.general.nexusDownloadDirSaved'));
    } catch (e) {
      toast.error(t('settings.general.nexusDownloadDirError', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleResetNexusDownloadDir() {
    try {
      await setNexusDownloadDir('');
      setNexusDownloadDirValue(null);
      toast.success(t('settings.general.nexusDownloadDirReset2'));
    } catch (e) {
      toast.error(t('settings.general.nexusDownloadDirError', { error: e instanceof Error ? e.message : String(e) }));
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
    { id: 'advanced', label: t('settings.tabs.advanced') },
    // Help lives in the topbar `?` drawer (always one click). It used
    // to also be a Settings tab but that was redundant — the drawer is
    // the canonical surface.
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
                      <button type="button" onClick={handleOpenGameFolder} className="gf-link-button">
                        {t('settings.general.openGameFolder')}
                      </button>
                      {' · '}
                      <button type="button" onClick={handleOpenModsFolder} className="gf-link-button">
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
                        background: selected ? 'color-mix(in oklch, var(--gold-tint-base) 8%, transparent)' : 'var(--indigo-panel)',
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
                <Layers size={16} />
                {t('settings.general.installPolicy')}
              </h3>
              <div className="gf-set-desc" style={{ marginTop: -6 }}>
                {t('settings.general.autoAddInstallsToModpackDesc')}
              </div>
              <div
                className="gf-launch-mode-row"
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '10px 12px',
                  borderRadius: 7,
                  border: '1px solid var(--indigo-line)',
                  background: 'var(--indigo-panel)',
                }}
              >
                <Toggle
                  checked={autoAddInstallsToModpack}
                  onChange={handleChangeAutoAddInstallsToModpack}
                  ariaLabel={t('settings.general.autoAddInstallsToModpack')}
                  title={t('settings.general.autoAddInstallsToModpack')}
                />
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                    {t('settings.general.autoAddInstallsToModpack')}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--ink-mute)' }}>
                    {autoAddInstallsToModpack
                      ? t('settings.general.autoAddInstallsToModpackOn')
                      : t('settings.general.autoAddInstallsToModpackOff')}
                  </span>
                </div>
              </div>
            </Card>

            <Card className="space-y-4" data-testid="nexus-download-dir-card" style={{ marginTop: 8 }}>
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <Download size={16} />
                {t('settings.general.nexusDownloadDir')}
              </h3>
              <div className="gf-set-desc" style={{ marginTop: -6 }}>
                {t('settings.general.nexusDownloadDirDesc')}
              </div>
              <div className="gf-field" style={{ margin: 0 }}>
                <div className="gf-input-row">
                  <input
                    className="gf-set-input"
                    readOnly
                    value={nexusDownloadDir ?? defaultDownloadDir ?? ''}
                    placeholder={t('settings.general.nexusDownloadDirDefault')}
                    style={{ flex: 1, cursor: 'default' }}
                  />
                  <Button variant="secondary" size="sm" onClick={handleBrowseNexusDownloadDir}>
                    {t('settings.general.nexusDownloadDirBrowse')}
                  </Button>
                  {nexusDownloadDir && (
                    <Button variant="secondary" size="sm" onClick={handleResetNexusDownloadDir}>
                      {t('settings.general.nexusDownloadDirReset')}
                    </Button>
                  )}
                </div>
                <div className="gf-help muted">
                  <span>
                    {nexusDownloadDir
                      ? t('settings.general.nexusDownloadDirCustom')
                      : t('settings.general.nexusDownloadDirDefault')}
                  </span>
                </div>
              </div>
            </Card>

            <Card className="space-y-4" style={{ marginTop: 8 }}>
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <Key size={16} />
                {t('settings.language.label')}
              </h3>
              <LanguageSelect />
            </Card>

            <Card className="space-y-4" style={{ marginTop: 8 }}>
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <Palette size={16} />
                {t('settings.theme.label')}
              </h3>
              <ThemeSelect />
            </Card>

            <Card className="space-y-4" style={{ marginTop: 8 }}>
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <ALargeSmall size={16} />
                {t('settings.display.label')}
              </h3>
              <div className="gf-set-desc" style={{ marginTop: -6 }}>
                {t('settings.display.desc')}
              </div>
              <UiScaleSlider />
            </Card>

            <div
              ref={rowMenuCardRef}
              data-testid="row-menu-card"
              className={rowMenuFlash ? 'gf-row-menu-card-flash' : undefined}
            >
              <Card className="space-y-4" style={{ marginTop: 8 }}>
                <h3 className="text-base font-semibold text-text flex items-center gap-2">
                  <SlidersHorizontal size={16} />
                  {t('settings.rowMenu.title')}
                </h3>
                <RowMenuCustomizer />
              </Card>
            </div>
            {/* 1.7.0 v7 — About card relocated from the Home page footer.
                Home is now the single-block launcher; reference info +
                support links live in Settings → General where they're
                discoverable but out of the way. */}
            <AboutCard />
          </>
        )}

        {tab === 'accounts' && (
          <>
            <Card className="space-y-4">
              <h3 className="text-base font-semibold text-text flex items-center gap-2">
                <Key size={18} />
                {t('settings.accounts.nexusKey')}
                {nexusKeySaved && (
                  <span className="gf-pill gf-pill-update" style={{ marginInlineStart: 6 }}>{t('settings.accounts.saved')}</span>
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
                  <span className="gf-pill gf-pill-update" style={{ marginInlineStart: 6 }}>{t('settings.accounts.saved')}</span>
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
                    {t('settings.accounts.githubPatIntro')}
                    <br />
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
            <Card className="space-y-3" data-testid="backup-retention-card" style={{ marginBottom: 10 }}>
              <div className="gf-set-label">{t('settings.backups.retentionTitle')}</div>
              <div className="gf-set-desc" style={{ marginTop: -4 }}>
                {t('settings.backups.retentionDesc')}
              </div>
              <div className="gf-input-row" style={{ alignItems: 'center', gap: 10 }}>
                <label htmlFor="backup-retention-select" className="gf-set-label" style={{ fontSize: 13 }}>
                  {t('settings.backups.retentionLabel')}
                </label>
                <select
                  id="backup-retention-select"
                  className="gf-set-input"
                  value={backupRetention}
                  disabled={savingRetention}
                  onChange={(e) => handleChangeBackupRetention(Number(e.target.value))}
                  style={{ width: 'auto', minWidth: 140 }}
                >
                  {Array.from({ length: 11 }, (_, n) => n).map((n) => (
                    <option key={n} value={n}>
                      {n === 0 ? t('settings.backups.retentionOff') : String(n)}
                    </option>
                  ))}
                </select>
              </div>
              {backupRetention === 0 && (
                <div className="gf-help muted">
                  <span>{t('settings.backups.retentionOffHint')}</span>
                </div>
              )}
            </Card>
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
                          <span className="gf-pill gf-pill-update" style={{ marginInlineStart: 8 }}>{t('settings.backups.newest')}</span>
                        )}
                      </div>
                      <div className="gf-backup-meta">
                        {b.mod_count} {t('settings.backups.files', { count: b.mod_count })} · {formatSizeMb(b.size_bytes)}
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

            {showDevBuilds && <DevBuildsCard />}
          </>
        )}

      </div>
    </div>
  );
}
