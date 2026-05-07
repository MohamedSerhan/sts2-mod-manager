import { useState, useEffect } from 'react';
import {
  Package,
  Layers,
  Gamepad2,
  ArrowUpCircle,
  FolderOpen,
  RefreshCw,
  Download,
  Wand2,
  Bell,
  CheckCircle2,
  Users,
  ArrowRight,
  ExternalLink,
} from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import {
  checkForUpdates,
  updateMod,
  updateAllMods,
  openModsFolder,
  autoDetectSources,
  checkSubscriptionUpdates,
  applySubscriptionUpdate,
} from '../hooks/useTauri';
import type { ModUpdate, SubscriptionUpdate } from '../types';

export function DashboardView() {
  const { gameInfo, mods, refreshAll } = useApp();
  const toast = useToast();
  const [updates, setUpdates] = useState<ModUpdate[]>([]);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [updatingMod, setUpdatingMod] = useState<string | null>(null);
  const [updatingAll, setUpdatingAll] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [subUpdates, setSubUpdates] = useState<SubscriptionUpdate[]>([]);
  const [_checkingSubs, setCheckingSubs] = useState(false);
  const [applyingSub, setApplyingSub] = useState<string | null>(null);

  const enabledCount = mods.filter((m) => m.enabled).length;
  const disabledCount = mods.filter((m) => !m.enabled).length;
  const totalSize = mods.reduce((sum, m) => sum + m.size_bytes, 0);
  const linkedCount = mods.filter((m) => m.github_url || m.nexus_url).length;
  const unlinkedCount = mods.length - linkedCount;

  useEffect(() => {
    handleCheckUpdates();
    handleCheckSubs();
  }, []);

  async function handleCheckUpdates() {
    try {
      setCheckingUpdates(true);
      const u = await checkForUpdates();
      setUpdates(u);
    } catch {
      // No game path set yet, or no network - that's fine
    } finally {
      setCheckingUpdates(false);
    }
  }

  async function handleCheckSubs() {
    try {
      setCheckingSubs(true);
      const u = await checkSubscriptionUpdates();
      setSubUpdates(u.filter((s) => s.has_update));
    } catch {
      // No subscriptions or network issue
    } finally {
      setCheckingSubs(false);
    }
  }

  async function handleUpdateMod(name: string) {
    try {
      setUpdatingMod(name);
      await updateMod(name);
      await refreshAll();
      setUpdates((prev) => prev.filter((u) => u.mod_name !== name));
      toast.success(`Updated: ${name}`);
    } catch (e) {
      toast.error(`Failed to update ${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUpdatingMod(null);
    }
  }

  const githubUpdates = updates.filter((u) => u.source_type === 'github');
  const nexusUpdates = updates.filter((u) => u.source_type === 'nexus');

  async function handleUpdateAll() {
    try {
      setUpdatingAll(true);
      const results = await updateAllMods();
      await refreshAll();
      setUpdates((prev) => prev.filter((u) => u.source_type !== 'github'));
      const msg = `Auto-updated ${results.length} mod${results.length !== 1 ? 's' : ''}`;
      if (nexusUpdates.length > 0) {
        toast.success(`${msg}. ${nexusUpdates.length} Nexus mod${nexusUpdates.length !== 1 ? 's' : ''} need manual download.`);
      } else {
        toast.success(msg);
      }
    } catch (e) {
      toast.error(`Update failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setUpdatingAll(false);
    }
  }

  async function handleOpenNexus(url: string) {
    try {
      await openUrl(url);
    } catch (e) {
      toast.error(`Failed to open URL: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleAutoDetect() {
    try {
      setDetecting(true);
      const result = await autoDetectSources();
      await refreshAll();
      if (result.matched.length > 0) {
        toast.success(
          `Linked ${result.matched.length} mod${result.matched.length !== 1 ? 's' : ''} to GitHub. ` +
          (result.unmatched.length > 0
            ? `${result.unmatched.length} could not be matched.`
            : 'All mods are now linked!')
        );
      } else {
        toast.info('No new matches found. Link mods manually in the Mods view.');
      }
      // Refresh updates after linking
      handleCheckUpdates();
    } catch (e) {
      toast.error(`Auto-detect failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setDetecting(false);
    }
  }

  async function handleApplySubUpdate(shareId: string) {
    try {
      setApplyingSub(shareId);
      const profile = await applySubscriptionUpdate(shareId);
      await refreshAll();
      setSubUpdates((prev) => prev.filter((s) => s.share_id !== shareId));
      toast.success(`Synced modpack "${profile.name}" - you're up to date!`);
    } catch (e) {
      toast.error(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApplyingSub(null);
    }
  }

  async function handleOpenFolder() {
    try {
      await openModsFolder();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  return (
    <div className="p-8 space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text">Dashboard</h2>
          <p className="text-sm text-text-muted mt-1.5">Overview of your mod setup</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={handleOpenFolder}>
            <FolderOpen size={14} />
            Open Mods Folder
          </Button>
          <Button variant="secondary" size="sm" onClick={() => refreshAll()}>
            <RefreshCw size={14} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Game Status Banner */}
      {!gameInfo?.valid && (
        <Card className="bg-red-500/10 border-red-500/30">
          <div className="flex items-center gap-3">
            <Gamepad2 size={20} className="text-red-400" />
            <div>
              <p className="text-sm font-medium text-red-400">Game Not Detected</p>
              <p className="text-xs text-text-dim mt-0.5">
                Go to Settings to auto-detect or manually set your STS2 game path.
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Subscription Updates Banner (for friends) */}
      {subUpdates.length > 0 && (
        <Card className="bg-purple-500/10 border-purple-500/30">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Users size={18} className="text-purple-400" />
              <h3 className="text-sm font-semibold text-purple-400">
                Modpack Update{subUpdates.length !== 1 ? 's' : ''} Available
              </h3>
            </div>
          </div>
          <div className="space-y-3">
            {subUpdates.map((sub) => (
              <div key={sub.share_id} className="bg-surface rounded-lg p-3">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-sm font-medium text-text">{sub.profile_name}</p>
                    <p className="text-xs text-text-dim">
                      {sub.added_mods.length > 0 && (
                        <span className="text-green-400">+{sub.added_mods.length} new </span>
                      )}
                      {sub.updated_mods.length > 0 && (
                        <span className="text-blue-400">{sub.updated_mods.length} updated </span>
                      )}
                      {sub.removed_mods.length > 0 && (
                        <span className="text-red-400">-{sub.removed_mods.length} removed</span>
                      )}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => handleApplySubUpdate(sub.share_id)}
                    disabled={applyingSub === sub.share_id}
                  >
                    {applyingSub === sub.share_id ? (
                      <RefreshCw size={14} className="animate-spin" />
                    ) : (
                      <Download size={14} />
                    )}
                    {applyingSub === sub.share_id ? 'Syncing...' : 'Apply Update'}
                  </Button>
                </div>
                {/* Details */}
                <div className="text-xs text-text-dim space-y-0.5">
                  {sub.added_mods.length > 0 && (
                    <p>New: {sub.added_mods.join(', ')}</p>
                  )}
                  {sub.updated_mods.length > 0 && (
                    <p>
                      Updated:{' '}
                      {sub.updated_mods
                        .map((m) => `${m.name} (${m.old_version} ${'\u2192'} ${m.new_version})`)
                        .join(', ')}
                    </p>
                  )}
                  {sub.removed_mods.length > 0 && (
                    <p>Removed: {sub.removed_mods.join(', ')}</p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Stats Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card className="flex items-center gap-4">
          <div className="p-3 rounded-xl bg-surface-hover text-primary">
            <Package size={24} />
          </div>
          <div>
            <p className="text-sm text-text-muted">Active Mods</p>
            <p className="text-2xl font-semibold text-text">{enabledCount}</p>
          </div>
        </Card>
        <Card className="flex items-center gap-4">
          <div className="p-3 rounded-xl bg-surface-hover text-yellow-400">
            <Package size={24} />
          </div>
          <div>
            <p className="text-sm text-text-muted">Disabled</p>
            <p className="text-2xl font-semibold text-text">{disabledCount}</p>
          </div>
        </Card>
        <Card className="flex items-center gap-4">
          <div className="p-3 rounded-xl bg-surface-hover text-green-400">
            <Layers size={24} />
          </div>
          <div>
            <p className="text-sm text-text-muted">Total Size</p>
            <p className="text-2xl font-semibold text-text">{formatBytes(totalSize)}</p>
          </div>
        </Card>
        <Card className="flex items-center gap-4">
          <div className="p-3 rounded-xl bg-surface-hover text-blue-400">
            <Gamepad2 size={24} />
          </div>
          <div>
            <p className="text-sm text-text-muted">Game Path</p>
            <p className="text-sm font-medium text-text truncate max-w-[160px]" title={gameInfo?.game_path || 'Not set'}>
              {gameInfo?.valid ? 'Configured' : 'Not set'}
            </p>
          </div>
        </Card>
      </div>

      {/* Auto-detect Sources (curator tool) */}
      {unlinkedCount > 0 && (
        <Card className="bg-yellow-500/5 border-yellow-500/20">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Wand2 size={18} className="text-yellow-400" />
              <div>
                <p className="text-sm font-medium text-text">
                  {unlinkedCount} mod{unlinkedCount !== 1 ? 's' : ''} not linked to a source
                </p>
                <p className="text-xs text-text-dim mt-0.5">
                  Link mods to GitHub repos so updates are detected automatically.
                  Auto-detect tries to match by name.
                </p>
              </div>
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={handleAutoDetect}
              disabled={detecting}
            >
              <Wand2 size={14} className={detecting ? 'animate-spin' : ''} />
              {detecting ? 'Detecting...' : 'Auto-Detect'}
            </Button>
          </div>
        </Card>
      )}

      {/* Mod Updates */}
      <Card>
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <ArrowUpCircle size={20} className="text-text-muted" />
            <h3 className="text-base font-semibold text-text">Mod Updates</h3>
            {updates.length > 0 && (
              <span className="text-xs text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                {updates.length}
              </span>
            )}
          </div>
          <div className="flex gap-2">
            {githubUpdates.length > 0 && (
              <Button
                size="sm"
                onClick={handleUpdateAll}
                disabled={updatingAll}
              >
                <Download size={14} />
                {updatingAll ? 'Updating...' : `Update All GitHub (${githubUpdates.length})`}
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              onClick={handleCheckUpdates}
              disabled={checkingUpdates}
            >
              <RefreshCw size={14} className={checkingUpdates ? 'animate-spin' : ''} />
              {checkingUpdates ? 'Checking...' : 'Check'}
            </Button>
          </div>
        </div>
        {updates.length > 0 ? (
          <div className="space-y-2">
            {updates.map((u) => (
              <div key={u.mod_name} className="flex items-center justify-between py-3 px-4 rounded-xl bg-surface-hover">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-text">{u.mod_name}</p>
                  <div className="flex items-center gap-2 text-xs text-text-dim">
                    <span>{u.current_version}</span>
                    <ArrowRight size={10} />
                    <span className="text-green-400">{u.latest_version}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                      u.source_type === 'nexus' ? 'bg-orange-500/15 text-orange-400' : 'bg-blue-500/15 text-blue-400'
                    }`}>
                      {u.source_type === 'nexus' ? 'Nexus' : 'GitHub'}
                    </span>
                  </div>
                </div>
                {u.source_type === 'nexus' ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleOpenNexus(u.download_url)}
                  >
                    <ExternalLink size={14} />
                    Download from Nexus
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => handleUpdateMod(u.mod_name)}
                    disabled={updatingMod === u.mod_name || updatingAll}
                  >
                    {updatingMod === u.mod_name ? (
                      <RefreshCw size={14} className="animate-spin" />
                    ) : (
                      <Download size={14} />
                    )}
                    {updatingMod === u.mod_name ? 'Updating...' : 'Update'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-12 text-text-dim">
            {linkedCount > 0 ? (
              <>
                <CheckCircle2 size={32} className="mb-2 text-green-400/40" />
                <p className="text-sm">
                  {checkingUpdates ? 'Checking for updates...' : 'All mods are up to date'}
                </p>
              </>
            ) : (
              <>
                <Bell size={32} className="mb-2 opacity-40" />
                <p className="text-sm">
                  {checkingUpdates ? 'Checking...' : 'Link mods to sources to enable update checking'}
                </p>
                <p className="text-xs mt-1">
                  Go to the Mods tab and click a mod to link it to its GitHub page
                </p>
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
