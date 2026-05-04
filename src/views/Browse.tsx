import { useState } from 'react';
import { Search, Star, Download, ExternalLink } from 'lucide-react';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { searchGithubMods, downloadGithubMod } from '../hooks/useTauri';
import type { GitHubRepo } from '../types';

export function BrowseView() {
  const { refreshAll } = useApp();
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GitHubRepo[]>([]);
  const [loading, setLoading] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);

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

  return (
    <div className="p-8 space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text">Browse Mods</h2>
        <p className="text-sm text-text-muted mt-1.5">
          Search GitHub for STS2 mods
        </p>
      </div>

      {/* Search Bar */}
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

      {/* Results */}
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
    </div>
  );
}
