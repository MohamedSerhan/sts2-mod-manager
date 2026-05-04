import { useState } from 'react';
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
  ChevronDown,
  ChevronUp,
  Save,
} from 'lucide-react';
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
  setModSource,
  findGithubFromNexus,
} from '../hooks/useTauri';

export function ModsView({ advancedMode = false }: { advancedMode?: boolean }) {
  const { mods, refreshMods, refreshAll } = useApp();
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [quickAddUrl, setQuickAddUrl] = useState('');
  const [quickAdding, setQuickAdding] = useState(false);
  const [expandedMod, setExpandedMod] = useState<string | null>(null);
  const [editingSource, setEditingSource] = useState<string | null>(null);
  const [sourceInput, setSourceInput] = useState('');
  const [savingSource, setSavingSource] = useState(false);
  const [findingGithub, setFindingGithub] = useState<string | null>(null);

  const enabledCount = mods.filter((m) => m.enabled).length;
  const disabledCount = mods.filter((m) => !m.enabled).length;
  const linkedCount = mods.filter((m) => m.github_url || m.nexus_url).length;

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

  async function handleSaveSource(modName: string) {
    if (!sourceInput.trim()) return;
    try {
      setSavingSource(true);
      await setModSource(modName, sourceInput.trim());
      await refreshMods();
      toast.success(`Source linked for ${modName}`);
      setEditingSource(null);
      setSourceInput('');
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSavingSource(false);
    }
  }

  async function handleClearSource(modName: string) {
    try {
      await setModSource(modName, '');
      await refreshMods();
      toast.info(`Source link cleared for ${modName}`);
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function startEditSource(modName: string) {
    setEditingSource(modName);
    setSourceInput('');
    setExpandedMod(modName);
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
          <h2 className="text-2xl font-bold text-text">{advancedMode ? 'Installed Mods' : 'My Mods'}</h2>
          <p className="text-sm text-text-muted mt-1">
            {enabledCount} active, {disabledCount} disabled
            {advancedMode && linkedCount > 0 && (
              <span className="text-green-400 ml-2">
                ({linkedCount} linked for auto-updates)
              </span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm" onClick={handleOpenFolder}>
            <FolderOpen size={14} />
            Open Folder
          </Button>
          {advancedMode && (
            <>
              <Button variant="secondary" size="sm" onClick={handleImportFile}>
                <Upload size={14} />
                Import Mod
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setShowQuickAdd(!showQuickAdd)}>
                <Link size={14} />
                Quick Add URL
              </Button>
            </>
          )}
          <Button variant="secondary" size="sm" onClick={() => refreshMods()}>
            <RefreshCw size={14} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Quick Add URL Form (advanced only) */}
      {advancedMode && showQuickAdd && (
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
          {filtered.map((mod) => {
            const isExpanded = expandedMod === mod.name;
            const hasLinks = mod.github_url || mod.nexus_url;

            return (
              <Card
                key={mod.name}
                className="hover:bg-surface-hover transition-colors"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4 min-w-0">
                    <Toggle
                      checked={mod.enabled}
                      onChange={(checked) => handleToggle(mod.name, checked)}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-text truncate">
                          {mod.name}
                        </span>
                        <span className="text-xs text-text-dim">v{mod.version}</span>
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
                        <p className="text-xs text-text-muted mt-0.5 truncate">
                          {mod.description}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    {advancedMode && (
                      <button
                        onClick={() => isExpanded ? setExpandedMod(null) : startEditSource(mod.name)}
                        className="p-1.5 rounded-md text-text-dim hover:text-primary hover:bg-primary/10 transition-colors"
                        title="Link to GitHub/Nexus for auto-updates"
                      >
                        {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                      </button>
                    )}
                    {advancedMode && (
                      <button
                        onClick={() => handleDelete(mod.name)}
                        className="p-1.5 rounded-md text-text-dim hover:text-red-400 hover:bg-red-500/10 transition-colors"
                        title="Delete mod"
                      >
                        <Trash2 size={16} />
                      </button>
                    )}
                  </div>
                </div>

                {/* Expanded: source linking panel (advanced only) */}
                {advancedMode && isExpanded && (
                  <div className="mt-3 pt-3 border-t border-border/50 space-y-2">
                    <div className="flex items-center gap-2 text-xs text-text-dim">
                      <span>{mod.files.length} file{mod.files.length !== 1 ? 's' : ''}</span>
                      {mod.dependencies.length > 0 && (
                        <>
                          <span className="text-text-dim">|</span>
                          <span>Depends on: {mod.dependencies.join(', ')}</span>
                        </>
                      )}
                    </div>

                    {/* Find GitHub from Nexus button */}
                    {mod.nexus_url && !mod.github_url && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={async () => {
                          try {
                            setFindingGithub(mod.name);
                            const repo = await findGithubFromNexus(mod.name);
                            if (repo) {
                              await refreshMods();
                              toast.success(`Found GitHub repo for ${mod.name}: ${repo}`);
                            } else {
                              toast.info(`No GitHub link found in Nexus description for ${mod.name}`);
                            }
                          } catch (e) {
                            toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
                          } finally {
                            setFindingGithub(null);
                          }
                        }}
                        disabled={findingGithub === mod.name}
                      >
                        <GitBranch size={12} />
                        {findingGithub === mod.name ? 'Searching Nexus...' : 'Find GitHub from Nexus'}
                      </Button>
                    )}

                    {/* Current links */}
                    {hasLinks && (
                      <div className="flex gap-3 items-center text-xs">
                        {mod.github_url && (
                          <a href={mod.github_url} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-1 text-blue-400 hover:underline">
                            <GitBranch size={12} /> {mod.github_url.replace('https://github.com/', '')}
                            <ExternalLink size={10} />
                          </a>
                        )}
                        {mod.nexus_url && (
                          <a href={mod.nexus_url} target="_blank" rel="noopener noreferrer"
                            className="flex items-center gap-1 text-orange-400 hover:underline">
                            Nexus <ExternalLink size={10} />
                          </a>
                        )}
                        <button
                          onClick={() => handleClearSource(mod.name)}
                          className="text-text-dim hover:text-red-400 ml-auto"
                          title="Remove source links"
                        >
                          <X size={12} />
                        </button>
                      </div>
                    )}

                    {/* Link source form */}
                    {editingSource === mod.name ? (
                      <div className="flex gap-2 items-center">
                        <input
                          type="text"
                          value={sourceInput}
                          onChange={(e) => setSourceInput(e.target.value)}
                          placeholder="github:owner/repo, Nexus URL, or owner/repo"
                          className="flex-1 bg-background border border-border rounded-lg px-3 py-1.5 text-xs text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50"
                          onKeyDown={(e) => e.key === 'Enter' && handleSaveSource(mod.name)}
                          disabled={savingSource}
                          autoFocus
                        />
                        <Button size="sm" onClick={() => handleSaveSource(mod.name)} disabled={savingSource}>
                          <Save size={12} />
                          {savingSource ? 'Saving...' : 'Save'}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setEditingSource(null)}>
                          <X size={12} />
                        </Button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startEditSource(mod.name)}
                        className="text-xs text-primary hover:underline"
                      >
                        {hasLinks ? '+ Add another source link' : '+ Link to GitHub or Nexus for auto-updates'}
                      </button>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
