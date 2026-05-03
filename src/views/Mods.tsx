import { useState, useEffect } from 'react';
import { Search, Upload, Link, Trash2, Package } from 'lucide-react';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { Badge, getSourceVariant } from '../components/Badge';
import { getInstalledMods, toggleMod, deleteMod } from '../hooks/useTauri';
import type { ModInfo } from '../types';

export function ModsView() {
  const [mods, setMods] = useState<ModInfo[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    loadMods();
  }, []);

  async function loadMods() {
    try {
      setLoading(true);
      setError(null);
      const installed = await getInstalledMods();
      setMods(installed);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleToggle(name: string, enable: boolean) {
    try {
      await toggleMod(name, enable);
      setMods((prev) =>
        prev.map((m) => (m.name === name ? { ...m, enabled: enable } : m)),
      );
    } catch (e) {
      console.error('Failed to toggle mod:', e);
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete mod "${name}"? This cannot be undone.`)) return;
    try {
      await deleteMod(name);
      setMods((prev) => prev.filter((m) => m.name !== name));
    } catch (e) {
      console.error('Failed to delete mod:', e);
    }
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
            {mods.length} mod{mods.length !== 1 ? 's' : ''} installed
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" size="sm">
            <Upload size={14} />
            Import Mod
          </Button>
          <Button variant="secondary" size="sm">
            <Link size={14} />
            Quick Add URL
          </Button>
        </div>
      </div>

      {/* Search / Filter */}
      <div className="relative">
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

      {/* Mod List */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-text-dim">
          <p className="text-sm">Loading mods...</p>
        </div>
      ) : error ? (
        <Card className="text-center py-8">
          <p className="text-danger text-sm">{error}</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={loadMods}>
            Retry
          </Button>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-12">
          <Package size={40} className="text-text-dim opacity-40 mb-3" />
          <p className="text-sm text-text-dim">
            {mods.length === 0
              ? 'No mods installed yet'
              : 'No mods match your filter'}
          </p>
          <p className="text-xs text-text-dim mt-1">
            Browse and install mods from the Browse tab
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
                  </div>
                  {mod.description && (
                    <p className="text-xs text-text-muted mt-0.5 truncate">
                      {mod.description}
                    </p>
                  )}
                </div>
              </div>
              <button
                onClick={() => handleDelete(mod.name)}
                className="p-1.5 rounded-md text-text-dim hover:text-danger hover:bg-danger/10 transition-colors"
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
