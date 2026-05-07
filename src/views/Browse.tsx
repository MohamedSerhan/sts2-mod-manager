import { useEffect, useState } from 'react';
import { Search, Star, Download, ExternalLink, Flame, Sparkles, Loader2 } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import {
  searchGithubMods,
  downloadGithubMod,
  nexusGetTrending,
  nexusGetLatestAdded,
} from '../hooks/useTauri';
import type { GitHubRepo, NexusModInfo } from '../types';

type BrowseTab = 'github' | 'nexus_trending' | 'nexus_latest';

const NEXUS_GAME_DOMAIN = 'slaythespire2';

interface BrowseViewProps {
  onGoToSettings?: () => void;
}

export function BrowseView({ onGoToSettings }: BrowseViewProps = {}) {
  const { refreshAll } = useApp();
  const toast = useToast();
  const [tab, setTab] = useState<BrowseTab>('github');

  // GitHub tab state
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);

  // Nexus tab state
  const [nexusMods, setNexusMods] = useState<NexusModInfo[]>([]);
  const [nexusLoading, setNexusLoading] = useState(false);
  const [nexusError, setNexusError] = useState<string | null>(null);
  const [nexusKeyMissing, setNexusKeyMissing] = useState(false);

  async function handleSearch() {
    if (!query.trim()) return;
    try {
      setLoading(true);
      const repos = await searchGithubMods(query.trim());
      setResults(repos);
      if (repos.length === 0) {
        toast.info('No mods found. Try different keywords.');
      }
    } catch (e) {
      toast.error(`Search failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleInstall(repo: GitHubRepo) {
    try {
      setInstalling(repo.full_name);
      const mod = await downloadGithubMod(repo.owner.login, repo.name);
      await refreshAll();
      toast.success(`Installed: ${mod.name}`);
    } catch (e) {
      toast.error(`Failed to install ${repo.name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling(null);
    }
  }

  useEffect(() => {
    if (tab === 'github') return;
    let cancelled = false;
    setNexusLoading(true);
    setNexusError(null);
    setNexusKeyMissing(false);
    setNexusMods([]);
    const fetcher = tab === 'nexus_trending' ? nexusGetTrending : nexusGetLatestAdded;
    fetcher()
      .then((mods) => {
        if (cancelled) return;
        setNexusMods(mods);
      })
      .catch((e) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Nexus API key not set')) {
          setNexusKeyMissing(true);
        } else {
          setNexusError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setNexusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  async function openNexusMod(modId: number) {
    const url = `https://www.nexusmods.com/${NEXUS_GAME_DOMAIN}/mods/${modId}`;
    try {
      await openUrl(url);
    } catch (e) {
      toast.error(`Failed to open: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const tabBtn = (id: BrowseTab, label: string, Icon: typeof Search) => (
    <button
      onClick={() => setTab(id)}
      className={`flex items-center gap-2 px-4 py-2 text-sm rounded-md transition-colors ${
        tab === id
          ? 'bg-primary text-white'
          : 'text-text-muted hover:text-text hover:bg-surface-hover'
      }`}
    >
      <Icon size={14} />
      {label}
    </button>
  );

  return (
    <div className="p-8 space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text">Browse Mods</h2>
        <p className="text-sm text-text-muted mt-1.5">
          Search GitHub or browse what's hot on Nexus Mods
        </p>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 bg-surface border border-border rounded-lg w-fit">
        {tabBtn('github', 'GitHub', Search)}
        {tabBtn('nexus_trending', 'Nexus Trending', Flame)}
        {tabBtn('nexus_latest', 'Nexus Latest', Sparkles)}
      </div>

      {tab === 'github' && (
        <>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSearch();
            }}
            className="flex gap-2"
          >
            <div className="relative flex-1">
              <Search
                size={16}
                className="absolute left-4 top-1/2 -translate-y-1/2 text-text-dim"
              />
              <input
                type="text"
                placeholder="Search for mods..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="w-full bg-surface border border-border rounded-lg pl-11 pr-4 py-3 text-sm text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary transition-colors"
              />
            </div>
            <Button type="submit" disabled={loading}>
              {loading ? 'Searching...' : 'Search'}
            </Button>
          </form>

          {results.length > 0 ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {results.map((repo) => (
                <Card key={repo.full_name} className="flex flex-col justify-between">
                  <div>
                    <div className="flex items-start justify-between mb-2">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-text truncate">
                          {repo.name}
                        </h3>
                        <p className="text-xs text-text-dim">{repo.full_name}</p>
                      </div>
                      <div className="flex items-center gap-1 text-xs text-yellow-400 ml-2 shrink-0">
                        <Star size={12} />
                        {repo.stargazers_count}
                      </div>
                    </div>
                    <p className="text-xs text-text-muted line-clamp-2 mb-3">
                      {repo.description || 'No description'}
                    </p>
                  </div>
                  <div className="flex items-center justify-between">
                    <Badge variant="github">GitHub</Badge>
                    <div className="flex gap-2 ml-auto">
                      <a
                        href={repo.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1.5 rounded-md text-text-dim hover:text-text hover:bg-surface-hover transition-colors"
                        title="View on GitHub"
                      >
                        <ExternalLink size={14} />
                      </a>
                      <Button
                        size="sm"
                        onClick={() => handleInstall(repo)}
                        disabled={installing === repo.full_name}
                      >
                        <Download size={14} />
                        {installing === repo.full_name ? 'Installing...' : 'Install'}
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            !loading && (
              <Card className="flex flex-col items-center justify-center py-16">
                <Search size={44} className="text-text-dim opacity-40 mb-4" />
                <p className="text-base text-text-dim">
                  Search for mods to get started
                </p>
                <p className="text-sm text-text-dim mt-1.5">
                  Try searching for game-related keywords
                </p>
              </Card>
            )
          )}
        </>
      )}

      {tab !== 'github' && (
        <>
          {nexusKeyMissing ? (
            <Card className="flex flex-col items-center justify-center py-16">
              <Sparkles size={44} className="text-text-dim opacity-40 mb-4" />
              <p className="text-base text-text">
                Set your Nexus API key in Settings to browse Nexus mods.
              </p>
              <p className="text-xs text-text-dim mt-2 max-w-md text-center">
                Nexus's free API does not allow general text search, but it does
                expose Trending and Latest Added lists.
              </p>
              {onGoToSettings && (
                <Button className="mt-4" onClick={onGoToSettings}>
                  Open Settings
                </Button>
              )}
            </Card>
          ) : nexusLoading ? (
            <Card className="flex flex-col items-center justify-center py-16">
              <Loader2 size={32} className="text-primary animate-spin mb-3" />
              <p className="text-sm text-text-muted">
                Loading {tab === 'nexus_trending' ? 'trending' : 'latest'} mods…
              </p>
            </Card>
          ) : nexusError ? (
            <Card className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-red-400">{nexusError}</p>
            </Card>
          ) : nexusMods.length === 0 ? (
            <Card className="flex flex-col items-center justify-center py-16">
              <p className="text-sm text-text-dim">No mods returned.</p>
            </Card>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {nexusMods.map((mod) => (
                <Card key={mod.mod_id} className="flex flex-col justify-between gap-3">
                  <div className="flex gap-3">
                    {mod.picture_url && (
                      <img
                        src={mod.picture_url}
                        alt=""
                        className="w-24 h-24 object-cover rounded-md border border-border shrink-0"
                        loading="lazy"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <h3 className="text-sm font-semibold text-text truncate">
                        {mod.name || `Mod #${mod.mod_id}`}
                      </h3>
                      <p className="text-xs text-text-dim">
                        {mod.author || 'Unknown author'}
                        {mod.version ? ` • v${mod.version}` : ''}
                      </p>
                      <p className="text-xs text-text-muted line-clamp-3 mt-1.5">
                        {mod.summary || mod.description || 'No description'}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <Badge variant="nexus">Nexus</Badge>
                    <Button size="sm" onClick={() => openNexusMod(mod.mod_id)}>
                      <ExternalLink size={14} />
                      Open on Nexus
                    </Button>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
