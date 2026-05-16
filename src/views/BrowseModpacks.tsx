import { useEffect, useState } from 'react';
import { RefreshCw, Search, Plus } from 'lucide-react';

import { fetchModpackBrowserPage } from '../hooks/useTauri';
import { Badge } from '../components/Badge';
import { BrowseModpackDetail } from '../components/BrowseModpackDetail';
import type { BrowserCard, BrowserPage } from '../types';

interface Props {
  onGoToProfiles?: () => void;
}

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function isRateLimit(err: unknown): boolean {
  // Only treat as rate-limit when the message actually says so, or it's a
  // 429. Bare 403s also come from auth/permission errors which need a
  // different message, not "rate-limiting us."
  const m = err instanceof Error ? err.message : String(err);
  return /\b429\b/.test(m) || /rate limit/i.test(m);
}

export function BrowseModpacksView({ onGoToProfiles }: Props = {}) {
  const [page, setPage] = useState<BrowserPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [rateLimited, setRateLimited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BrowserCard | null>(null);

  async function load(force = false) {
    setLoading(true);
    setRateLimited(false);
    setError(null);
    try {
      const result = await fetchModpackBrowserPage(1, force);
      setPage(result);
    } catch (e) {
      if (isRateLimit(e)) {
        setRateLimited(true);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <div className="gf-view">
      <div className="gf-view-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <h2 className="gf-view-title">Browse Modpacks</h2>
          <Badge variant="beta" title="The public modpack browser is still being tuned.">Beta</Badge>
        </div>
        <button
          className="gf-btn-3"
          onClick={() => load(true)}
          disabled={loading}
          title="Refresh"
        >
          <RefreshCw size={14} className={loading ? 'gf-spin' : undefined} />
          {page && !loading
            ? ` Last refreshed ${relativeTime(new Date(page.fetched_at * 1000).toISOString())}`
            : ''}
        </button>
      </div>

      {page?.stale && (
        <div className="gf-banner gf-banner-warn">
          Showing cached results — couldn't reach GitHub.
        </div>
      )}

      {rateLimited && (
        <div className="gf-banner gf-banner-warn">
          GitHub is rate-limiting us — try again in a minute, or connect a GitHub token in Settings for a higher limit.
        </div>
      )}

      {error && <div className="gf-banner gf-banner-error">{error}</div>}

      {loading && !page && (
        <div className="gf-card-list">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="gf-card gf-skeleton" style={{ height: 64 }} />
          ))}
        </div>
      )}

      {page && page.cards.length === 0 && !rateLimited && !error && (
        <div className="gf-empty">
          <Search size={28} />
          <div className="gf-empty-title">
            No public modpacks found yet — be the first to share one!
          </div>
          {onGoToProfiles && (
            <button className="gf-btn-2" onClick={onGoToProfiles}>
              <Plus size={12} /> Go to Profiles
            </button>
          )}
        </div>
      )}

      {page && page.cards.length > 0 && (
        <>
          <div
            style={{
              marginBottom: 12,
              padding: '10px 14px',
              fontSize: 12.5,
              color: 'var(--ink-mute)',
              lineHeight: 1.55,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <span>
              Want yours here too? Publish a new pack — or re-share an existing one — from
              Profiles and pick <b style={{ color: 'var(--ink)' }}>Public</b> visibility.
            </span>
            {onGoToProfiles && (
              <button className="gf-btn-3" onClick={onGoToProfiles}>
                <Plus size={12} /> Go to Profiles
              </button>
            )}
          </div>
          <div className="gf-card-list">
            {page.cards.map((c) => (
              <button
                key={`${c.owner}/${c.code}`}
                className="gf-card gf-card-clickable"
                onClick={() => setSelected(c)}
              >
                <div className="gf-card-title">{c.name}</div>
                <div className="gf-card-sub">
                  @{c.owner} · {c.mod_count} mod{c.mod_count === 1 ? '' : 's'} · Updated{' '}
                  {relativeTime(c.updated_at)}
                </div>
              </button>
            ))}
          </div>
        </>
      )}
      </div>
      {selected && (
        <BrowseModpackDetail
          card={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}
