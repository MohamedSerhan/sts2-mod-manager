import { useState, useEffect } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { FolderSearch, Key, FolderOpen, RefreshCw, ClipboardCheck, ExternalLink, Download, Pin, PinOff } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Input } from '../components/Input';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import {
  detectGamePath,
  setGamePath,
  setNexusApiKey,
  setGithubToken,
  openGameFolder,
  openModsFolder,
  getApiKeyStatus,
  openLogFile,
  getLogPath,
  auditModVersions,
  repairModFolders,
  pinMod,
  unpinMod,
} from '../hooks/useTauri';
import type { ModAuditEntry } from '../types';

export function SettingsView() {
  const { gameInfo, refreshAll } = useApp();
  const toast = useToast();
  const [gamePath, setGamePathValue] = useState('');
  const [nexusKey, setNexusKey] = useState('');
  const [githubToken, setGithubTokenValue] = useState('');
  const [nexusKeySaved, setNexusKeySaved] = useState(false);
  const [githubTokenSaved, setGithubTokenSaved] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [auditing, setAuditing] = useState(false);
  const [auditResults, setAuditResults] = useState<ModAuditEntry[] | null>(null);

  useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);

  // Load current game path and key status on mount
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

  const [checkingUpdate, setCheckingUpdate] = useState(false);
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

  return (
    <div className="p-8 space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text">Settings</h2>
        <p className="text-sm text-text-muted mt-1.5">
          Configure your mod manager
        </p>
      </div>

      {/* Game Path */}
      <Card className="space-y-4">
        <h3 className="text-base font-semibold text-text flex items-center gap-2">
          <FolderSearch size={18} />
          Game Path
        </h3>
        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              placeholder="C:\Program Files\Steam\steamapps\common\Slay the Spire 2"
              value={gamePath}
              onChange={(e) => setGamePathValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSetGamePath()}
            />
          </div>
          <Button variant="secondary" size="md" onClick={handleBrowseGamePath}>
            Browse...
          </Button>
          <Button variant="secondary" size="md" onClick={handleDetectGame}>
            Auto-Detect
          </Button>
          <Button size="md" onClick={handleSetGamePath}>
            Save
          </Button>
        </div>
        {gameInfo?.valid && (
          <div className="flex gap-2 text-xs">
            <span className="text-green-400">
              {gameInfo.mods_count} mods detected
            </span>
            <span className="text-text-dim">|</span>
            <button onClick={handleOpenGameFolder} className="text-primary hover:underline">
              Open Game Folder
            </button>
            <span className="text-text-dim">|</span>
            <button onClick={handleOpenModsFolder} className="text-primary hover:underline">
              Open Mods Folder
            </button>
          </div>
        )}
      </Card>

      {/* Nexus API Key */}
      <Card className="space-y-4">
        <h3 className="text-base font-semibold text-text flex items-center gap-2">
          <Key size={18} />
          Nexus Mods API Key
          {nexusKeySaved && (
            <span className="text-xs text-green-400 font-normal ml-2">Saved</span>
          )}
        </h3>
        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              type="password"
              placeholder={nexusKeySaved ? '••••••••••••••••  (already saved, enter new value to replace)' : 'Enter your Nexus API key'}
              value={nexusKey}
              onChange={(e) => setNexusKey(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveNexusKey()}
            />
          </div>
          <Button size="md" onClick={handleSaveNexusKey}>
            Save
          </Button>
        </div>
        <a
          href="https://www.nexusmods.com/users/myaccount?tab=api"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline transition-colors"
        >
          Get your API key from Nexus Mods
        </a>
      </Card>

      {/* GitHub Token */}
      <Card className="space-y-4">
        <h3 className="text-base font-semibold text-text flex items-center gap-2">
          <Key size={18} />
          GitHub Token
          <span className="text-xs text-text-dim font-normal">(optional)</span>
          {githubTokenSaved && (
            <span className="text-xs text-green-400 font-normal ml-2">Saved</span>
          )}
        </h3>
        <div className="flex gap-2">
          <div className="flex-1">
            <Input
              type="password"
              placeholder={githubTokenSaved ? '••••••••••••••••  (already saved, enter new value to replace)' : 'ghp_xxxxxxxxxxxxxxxxxxxx'}
              value={githubToken}
              onChange={(e) => setGithubTokenValue(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSaveGithubToken()}
            />
          </div>
          <Button variant="secondary" size="md" onClick={handleSaveGithubToken}>
            Save
          </Button>
        </div>
        <p className="text-xs text-text-dim">
          Any token type works (classic or fine-grained). For sharing profiles, the token needs <strong>repo</strong> permission.
          Also increases API rate limit to 5,000 req/hr.
        </p>
      </Card>

      {/* Quick Actions */}
      <Card className="space-y-4">
        <h3 className="text-base font-semibold text-text flex items-center gap-2">
          <FolderOpen size={18} />
          Quick Actions
        </h3>
        <div className="flex gap-2 flex-wrap">
          <Button variant="secondary" size="sm" onClick={handleOpenGameFolder}>
            Open Game Folder
          </Button>
          <Button variant="secondary" size="sm" onClick={handleOpenModsFolder}>
            Open Mods Folder
          </Button>
          <Button variant="secondary" size="sm" onClick={async () => {
            try {
              await openLogFile();
            } catch {
              const path = await getLogPath().catch(() => 'unknown');
              toast.error(`Log file not found at: ${path}`);
            }
          }}>
            View Logs
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleCheckUpdateNow}
            disabled={checkingUpdate}
          >
            <RefreshCw size={14} className={checkingUpdate ? 'animate-spin' : ''} />
            {checkingUpdate ? 'Checking...' : 'Check for Mod Manager Updates'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              try {
                setAuditing(true);
                const results = await auditModVersions();
                setAuditResults(results);
              } catch (e) {
                toast.error(`Audit failed: ${e instanceof Error ? e.message : String(e)}`);
              } finally {
                setAuditing(false);
              }
            }}
            disabled={auditing}
          >
            <ClipboardCheck size={14} className={auditing ? 'animate-pulse' : ''} />
            {auditing ? 'Auditing...' : 'Audit Mod Versions'}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={async () => {
              try {
                const repairs = await repairModFolders();
                await refreshAll();
                if (repairs.length === 0) {
                  toast.success('All mod folders are correctly named — nothing to repair.');
                } else {
                  toast.success(
                    `Repaired ${repairs.length} folder${repairs.length !== 1 ? 's' : ''}: ` +
                    repairs.map(r => `${r.old_folder} → ${r.new_folder}`).join(', ')
                  );
                }
              } catch (e) {
                toast.error(`Repair failed: ${e instanceof Error ? e.message : String(e)}`);
              }
            }}
          >
            <RefreshCw size={14} />
            Repair Mod Folders
          </Button>
        </div>
      </Card>

      {/* Mod Version Audit */}
      {auditResults && (
        <Card className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-semibold text-text">Mod Version Audit</h3>
            <Button variant="ghost" size="sm" onClick={() => setAuditResults(null)}>Close</Button>
          </div>
          <div className="space-y-1 max-h-96 overflow-y-auto">
            {auditResults.map((entry) => {
              const hasAnySource = entry.github_repo || entry.nexus_url;
              // Don't treat auto-detected GitHub errors as real errors
              const hasRealError = entry.error && !entry.github_auto_detected;
              return (
              <div
                key={entry.mod_name}
                className={`text-xs px-3 py-2 rounded-lg ${
                  hasRealError
                    ? 'bg-red-500/10 text-red-400'
                    : entry.needs_update
                    ? 'bg-amber-500/10 text-amber-400'
                    : !hasAnySource
                    ? 'bg-surface text-text-dim'
                    : 'bg-green-500/10 text-green-400'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium flex items-center gap-1.5">
                    {entry.mod_name}
                    {entry.pinned && (
                      <span className="text-blue-400 text-[10px] font-normal flex items-center gap-0.5">
                        <Pin size={9} /> Pinned
                      </span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        try {
                          if (entry.pinned) {
                            await unpinMod(entry.mod_name);
                            toast.success(`Unpinned '${entry.mod_name}' — updates will be checked again.`);
                          } else {
                            await pinMod(entry.mod_name);
                            toast.success(`Pinned '${entry.mod_name}' — excluded from all update checks.`);
                          }
                          // Re-run audit to reflect change
                          const results = await auditModVersions();
                          setAuditResults(results);
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : String(err));
                        }
                      }}
                      className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors ${
                        entry.pinned
                          ? 'bg-blue-500/20 text-blue-300 hover:bg-blue-500/30'
                          : 'bg-surface text-text-dim hover:bg-surface-hover hover:text-text'
                      }`}
                      title={entry.pinned ? 'Unpin — re-enable update checking' : 'Pin — exclude from update checks'}
                    >
                      {entry.pinned ? <><PinOff size={9} /> Unpin</> : <><Pin size={9} /> Pin</>}
                    </button>
                    <span className="font-mono">
                    {hasRealError
                      ? 'ERROR'
                      : entry.needs_update
                      ? `${entry.installed_version} → ${
                          entry.update_source === 'nexus' || (!entry.latest_release_with_assets_tag && entry.nexus_version)
                            ? entry.nexus_version
                            : entry.latest_release_with_assets_tag
                        } (${entry.update_source || 'unknown'})`
                      : !hasAnySource
                      ? 'No source linked'
                      : `${entry.installed_version} (latest)`}
                  </span>
                  </span>
                </div>
                {/* Source links row */}
                <div className="flex items-center gap-3 mt-1">
                  {entry.github_repo && (
                    <a
                      href={`https://github.com/${entry.github_repo}/releases`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={`inline-flex items-center gap-1 hover:underline ${
                        entry.github_auto_detected ? 'text-text-dim' : 'text-primary'
                      }`}
                    >
                      <ExternalLink size={10} />
                      {entry.github_repo}
                      {entry.github_auto_detected && (
                        <span className="text-text-dim opacity-60">(auto-detected, not used for updates)</span>
                      )}
                    </a>
                  )}
                  {entry.nexus_url && (
                    <a
                      href={entry.nexus_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-primary hover:underline"
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
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500/20 text-amber-300 hover:bg-amber-500/30 transition-colors font-medium"
                    >
                      <Download size={10} />
                      Download latest from Nexus
                    </a>
                  )}
                </div>
                {/* GitHub-specific details (only for manually-linked repos) */}
                {entry.github_repo && !entry.github_auto_detected && (
                  <div className="text-text-dim mt-0.5">
                    {entry.latest_release_tag && entry.latest_release_with_assets_tag && entry.latest_release_tag !== entry.latest_release_with_assets_tag && (
                      <span className="text-amber-400">
                        latest tag {entry.latest_release_tag} has no files, using {entry.latest_release_with_assets_tag}
                      </span>
                    )}
                    {!entry.latest_has_assets && entry.latest_release_tag && !entry.latest_release_with_assets_tag && (
                      <span className="text-red-400">(no releases with downloadable files found)</span>
                    )}
                    {entry.releases_scanned > 1 && (
                      <span className="ml-2">({entry.releases_scanned} releases scanned)</span>
                    )}
                  </div>
                )}
                {entry.asset_names.length > 0 && (
                  <div className="text-text-dim mt-0.5">Assets: {entry.asset_names.join(', ')}</div>
                )}
                {hasRealError && <div className="mt-0.5">{entry.error}</div>}
              </div>
              );
            })}
          </div>
          <div className="text-xs text-text-dim border-t border-border pt-2">
            {auditResults.filter(r => r.needs_update).length} need updates &middot;
            {auditResults.filter(r => r.pinned).length} pinned &middot;
            {auditResults.filter(r => !r.github_repo && !r.nexus_url).length} unlinked &middot;
            {auditResults.filter(r => r.error && !r.github_auto_detected).length} errors &middot;
            {auditResults.filter(r => (r.github_repo || r.nexus_url) && !r.needs_update && !r.error).length} up to date
          </div>
        </Card>
      )}

      {/* Protocol Handlers */}
      <Card className="space-y-4">
        <h3 className="text-base font-semibold text-text">Protocol Handlers</h3>
        <div className="space-y-2">
          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm text-text">sts2mm:// handler</p>
              <p className="text-xs text-text-dim">
                Handle one-click install links (registered automatically)
              </p>
            </div>
            <span className="text-xs text-green-400">Active</span>
          </div>
          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm text-text">nxm:// handler</p>
              <p className="text-xs text-text-dim">
                Handle Nexus Mods download links (registered automatically)
              </p>
            </div>
            <span className="text-xs text-green-400">Active</span>
          </div>
        </div>
      </Card>

      {/* About */}
      <Card className="space-y-3">
        <h3 className="text-base font-semibold text-text">About</h3>
        <div className="text-xs text-text-dim space-y-1">
          <p>STS2 Mod Manager v{appVersion}</p>
          <p>Built with Tauri 2 + React + Rust</p>
          <p>Manage your Slay the Spire 2 mods with ease.</p>
        </div>
      </Card>
    </div>
  );
}
