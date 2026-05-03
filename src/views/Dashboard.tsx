import { useState, useEffect } from 'react';
import { Package, Layers, Gamepad2, ArrowUpCircle, FolderOpen, RefreshCw } from 'lucide-react';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { checkForUpdates, openModsFolder } from '../hooks/useTauri';
import type { ModUpdate } from '../types';

export function DashboardView() {
  const { gameInfo, mods, refreshAll } = useApp();
  const toast = useToast();
  const [updates, setUpdates] = useState<ModUpdate[]>([]);
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  const enabledCount = mods.filter((m) => m.enabled).length;
  const disabledCount = mods.filter((m) => !m.enabled).length;
  const totalSize = mods.reduce((sum, m) => sum + m.size_bytes, 0);

  useEffect(() => {
    handleCheckUpdates();
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
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text">Dashboard</h2>
          <p className="text-sm text-text-muted mt-1">Overview of your mod setup</p>
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

      {/* Stats Row */}
      <div className="grid grid-cols-4 gap-4">
        <Card className="flex items-center gap-4">
          <div className="p-2.5 rounded-lg bg-surface-hover text-primary">
            <Package size={22} />
          </div>
          <div>
            <p className="text-xs text-text-muted">Active Mods</p>
            <p className="text-lg font-semibold text-text">{enabledCount}</p>
          </div>
        </Card>
        <Card className="flex items-center gap-4">
          <div className="p-2.5 rounded-lg bg-surface-hover text-yellow-400">
            <Package size={22} />
          </div>
          <div>
            <p className="text-xs text-text-muted">Disabled</p>
            <p className="text-lg font-semibold text-text">{disabledCount}</p>
          </div>
        </Card>
        <Card className="flex items-center gap-4">
          <div className="p-2.5 rounded-lg bg-surface-hover text-green-400">
            <Layers size={22} />
          </div>
          <div>
            <p className="text-xs text-text-muted">Total Size</p>
            <p className="text-lg font-semibold text-text">{formatBytes(totalSize)}</p>
          </div>
        </Card>
        <Card className="flex items-center gap-4">
          <div className="p-2.5 rounded-lg bg-surface-hover text-blue-400">
            <Gamepad2 size={22} />
          </div>
          <div>
            <p className="text-xs text-text-muted">Game Path</p>
            <p className="text-xs font-medium text-text truncate max-w-[140px]" title={gameInfo?.game_path || 'Not set'}>
              {gameInfo?.valid ? 'Configured' : 'Not set'}
            </p>
          </div>
        </Card>
      </div>

      {/* Updates Available */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <ArrowUpCircle size={18} className="text-text-muted" />
            <h3 className="text-sm font-semibold text-text">Updates Available</h3>
          </div>
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
        {updates.length > 0 ? (
          <div className="space-y-2">
            {updates.map((u) => (
              <div key={u.mod_name} className="flex items-center justify-between py-2 px-3 rounded-lg bg-surface-hover">
                <div>
                  <p className="text-sm font-medium text-text">{u.mod_name}</p>
                  <p className="text-xs text-text-dim">
                    {u.current_version} &rarr; {u.latest_version}
                  </p>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-8 text-text-dim">
            <ArrowUpCircle size={32} className="mb-2 opacity-40" />
            <p className="text-sm">
              {checkingUpdates ? 'Checking for updates...' : 'All mods are up to date'}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
