import { useEffect, useState } from 'react';
import { Search, Star, Download, ExternalLink, Flame, Sparkles, Loader2, Plus } from 'lucide-react';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { QuickAddModal } from '../components/QuickAddModal';
import { BrowseDetail } from '../components/BrowseDetail';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import {
  searchGithubMods,
  downloadGithubMod,
  nexusGetTrending,
  nexusGetLatestAdded,
  openExternalUrl,
} from '../hooks/useTauri';
import { fuzzyRerank } from '../lib/fuzzy';
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
  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [detailRepo, setDetailRepo] = useState<GitHubRepo | null>(null);
  const [detailNexus, setDetailNexus] = useState<NexusModInfo | null>(null);

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
    const q = query.trim();
    if (!q) return;
    try {
      setLoading(true);
      const repos = await searchGithubMods(q);
      // Client-side rerank for typo tolerance + better short-query
      // matching. The backend already trimmed to STS2-relevant repos;
      // this just surfaces the row that best matches what the user typed.
      // Repo name carries more weight than description.
      const ranked = fuzzyRerank(repos, q, (r) => [
        r.name,
        r.full_name,
        r.description ?? '',
      ]);
      // If the fuzzy filter dropped everything (all candidates had zero
      // tolerable match against the query), fall back to whatever the
      // backend gave us — better to show "maybe relevant" rows than an
      // empty page.
      const finalList = ranked.length > 0 ? ranked : repos;
      setResults(finalList);
      if (finalList.length === 0) {
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
        // uncovered: cancelled-branch races useEffect cleanup against promise
        // resolution. High-cost, low-value to drive deterministically; the
        // happy path through this resolver is covered.
        if (cancelled) return;
        setNexusMods(mods);
      })
      .catch((e) => {
        // uncovered: cancelled-branch races useEffect cleanup against promise
        // rejection. Happy error paths through this handler are covered.
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes('Nexus API key not set')) {
          setNexusKeyMissing(true);
        } else {
          setNexusError(msg);
        }
      })
      .finally(() => {
        // uncovered: cancelled-branch only fires when the tab is switched
        // mid-flight. Non-cancelled path (the common case) is covered.
        if (!cancelled) setNexusLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  async function openNexusMod(modId: number) {
    const url = `https://www.nexusmods.com/${NEXUS_GAME_DOMAIN}/mods/${modId}`;
    try {
      await openExternalUrl(url);
    } catch (e) {
      toast.error(`Failed to open: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const tabBtn = (id: BrowseTab, label: string, Icon: typeof Search) => (
    <button
      onClick={() => setTab(id)}
      className={`gf-tab ${tab === id ? 'active' : ''}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      <Icon size={12} />
      {label}
    </button>
  );

  return (
    <div className="gf-body">
      <div className="gf-page-head">
        <div>
          <h1 className="gf-page-title">Browse mods</h1>
          <p className="gf-page-sub">GitHub installs in one click; Nexus opens in your browser (free-tier)</p>
        </div>
        <div className="gf-page-actions">
          <Button size="sm" onClick={() => setShowQuickAdd(true)}>
            <Plus size={14} /> Add by URL
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="gf-tabs" style={{ marginBottom: 14 }}>
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
                  <div onClick={() => setDetailRepo(repo)} style={{ cursor: 'pointer' }}>
                    <div className="flex items-start justify-between mb-2">
                      <div className="min-w-0">
                        <h3 className="text-sm font-semibold text-text truncate hover:underline">
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
            <>
              <div className="gf-banner gf-banner-info" style={{ marginBottom: 14 }}>
                <Sparkles size={16} className="gf-banner-icon" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>Nexus is hidden — set an API key to see Nexus mods</div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                    Nexus's free API does not allow general text search, but it does expose Trending and Latest Added lists.
                  </div>
                </div>
                {onGoToSettings && (
                  <Button variant="secondary" size="sm" onClick={onGoToSettings}>
                    Open Settings
                  </Button>
                )}
              </div>
            </>
          ) : nexusLoading ? (
            <div className="gf-empty">
              <div className="gf-empty-art"><Loader2 size={28} className="animate-spin" /></div>
              <div className="gf-empty-title">Loading {tab === 'nexus_trending' ? 'trending' : 'latest'} mods…</div>
            </div>
          ) : nexusError ? (
            <div className="gf-empty">
              <div className="gf-empty-art" style={{ color: 'oklch(0.65 0.18 25)' }}>!</div>
              <div className="gf-empty-title">Couldn't reach Nexus</div>
              <div className="gf-empty-sub">{nexusError}</div>
            </div>
          ) : nexusMods.length === 0 ? (
            <div className="gf-empty">
              <div className="gf-empty-art"><Sparkles size={28} /></div>
              <div className="gf-empty-title">No mods returned</div>
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {nexusMods.map((mod) => (
                <Card key={mod.mod_id} className="flex flex-col justify-between gap-3">
                  <div className="flex gap-3 cursor-pointer" onClick={() => setDetailNexus(mod)}>
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

      <QuickAddModal open={showQuickAdd} onClose={() => setShowQuickAdd(false)} />

      {detailRepo && (
        <BrowseDetail
          kind="github"
          repo={detailRepo}
          installing={installing === detailRepo.full_name}
          onClose={() => setDetailRepo(null)}
          onInstall={async () => {
            await handleInstall(detailRepo);
            setDetailRepo(null);
          }}
          onOpenExternal={() => openExternalUrl(detailRepo.html_url).catch(() => {})}
        />
      )}

      {detailNexus && (
        <BrowseDetail
          kind="nexus"
          mod={detailNexus}
          onClose={() => setDetailNexus(null)}
          onOpenExternal={() => openExternalUrl(`https://www.nexusmods.com/${NEXUS_GAME_DOMAIN}/mods/${detailNexus.mod_id}`).catch(() => {})}
        />
      )}
    </div>
  );
}
