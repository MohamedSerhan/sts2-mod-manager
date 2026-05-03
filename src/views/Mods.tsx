import { useState } from 'react';
import { Search, Upload, Link, Trash2, Package, RefreshCw, FolderOpen, ToggleLeft, ToggleRight, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { Badge, getSourceVariant } from '../components/Badge';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import {
  toggleMod,
  deleteMod,
  installModFromFile,
  quickAddMod,
  enableAllMods,
  disableAllMods,
  openModsFolder,
} from '../hooks/useTauri';

export function ModsView() {
  const { mods, refreshMods, refreshAll } = useApp();
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAddUrl, setQuickAddUrl] = useState('');
  const [quickAdding, setQuickAdding] = useState(false);

  const enabledCount = mods.filter((m) => m.enabled).length;
  const disabledCount = mods.filter((m) => !m.enabled).length;

  async function handleToggle(name: string, enable: boolean) {
    try {
      await toggleMod(name, enable);
      await refreshMods();
      toast.success(`${name} ${enable ? 'enabled' : 'disabled'}`);
    } catch (e) {
      toast.error(`Failed to toggle ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete mod "${name}"? This cannot be undone.`)) return;
    try {
      await deleteMod(name);
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
    try {
      setQuickAdding(true);
      const result = await quickAddMod(quickAddUrl.trim());
      if (result.type === 'github_installed') {
        await refreshAll();
        toast.success(`Installed: ${result.mod_info.name}`);
      } else {
        toast.info(`Found Nexus mod: ${result.nexus_info.name || 'Unknown'}. Use "Download with Mod Manager" on Nexus.`);
      }
      setQuickAddUrl('');
      setShowQuickAdd(false);
    } catch (e) {
      toast.error(`Quick add failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setQuickAdding(false);
    }
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

  const filtered = mods.filter((m) =>
    m.name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <div className="p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text">Installed Mods</h2>
          <p className="text-sm text-text-muted mt-1">
            {enabledCount} active, {disabledCount} disabled
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={handleOpenFolder}>
            <FolderOpen size={14} />
            Open Folder
          </Button>
          <Button variant="secondary" size="sm" onClick={handleImportFile}>
            <Upload size={14} />
            Import Mod
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setShowQuickAdd(!showQuickAdd)}>
            <Link size={14} />
            Quick Add URL
          </Button>
          <Button variant="secondary" size="sm" onClick={() => refreshMods()}>
            <RefreshCw size={14} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Quick Add URL Form */}
      {showQuickAdd && (
        <Card className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-text-muted block mb-1">
              GitHub URL, Nexus URL, or github:owner/repo
            </label>
            <input
              type="text"
              value={quickAddUrl}
              onChange={(e) => setQuickAddUrl(e.target.value)}
              placeholder="https://github.com/user/mod or nexus:slaythefire2/mods/123"
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50"
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
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search
            size={16}
            className="absolute left-3 top-1/2 -translate-y-1/2 text-text-dim"
          />
          <input
            type="text"
            placeholder="Search mods..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full bg-surface border border-border rounded-lg pl-9 pr-3 py-2 text-sm text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
          />
        </div>
        {mods.length > 0 && (
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={handleEnableAll} title="Enable all mods">
              <ToggleRight size={14} />
              Enable All
            </Button>
            <Button variant="ghost" size="sm" onClick={handleDisableAll} title="Disable all mods">
              <ToggleLeft size={14} />
              Disable All
            </Button>
          </div>
        )}
      </div>

      {/* Mod List */}
      {filtered.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-12">
          <Package size={40} className="text-text-dim opacity-40 mb-3" />
          <p className="text-sm text-text-dim">
            {mods.length === 0
              ? 'No mods installed yet'
              : 'No mods match your filter'}
          </p>
          <p className="text-xs text-text-dim mt-1">
            {mods.length === 0
              ? 'Import a .zip, use Quick Add, or browse GitHub mods'
              : 'Try a different search term'}
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((mod) => (
            <Card
              key={mod.name}
              className="flex items-center justify-between hover:bg-surface-hover transition-colors"
            >
              <div className="flex items-center gap-4 min-w-0">
                <Toggle
                  checked={mod.enabled}
                  onChange={(checked) => handleToggle(mod.name, checked)}
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text truncate">
                      {mod.name}
                    </span>
                    <span className="text-xs text-text-dim">v{mod.version}</span>
                    <Badge variant={getSourceVariant(mod.source)}>
                      {mod.source || 'Local'}
                    </Badge>
                    {mod.size_bytes > 0 && (
                      <span className="text-xs text-text-dim">{formatBytes(mod.size_bytes)}</span>
                    )}
                  </div>
                  {mod.description && (
                    <p className="text-xs text-text-muted mt-0.5 truncate">
                      {mod.description}
                    </p>
                  )}
                  {mod.files.length > 0 && (
                    <p className="text-xs text-text-dim mt-0.5">
                      {mod.files.length} file{mod.files.length !== 1 ? 's' : ''}
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleDelete(mod.name)}
                className="p-1.5 rounded-md text-text-dim hover:text-red-400 hover:bg-red-500/10 transition-colors"
                title="Delete mod"
              >
                <Trash2 size={16} />
              </button>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
