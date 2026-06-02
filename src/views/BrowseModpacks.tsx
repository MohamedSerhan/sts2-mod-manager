import { useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { RefreshCw, Search, Plus } from 'lucide-react';

import { fetchModpackBrowserPage } from '../hooks/useTauri';
import { withTimeout } from '../lib/withTimeout';
import { BrowseModpackDetail } from '../components/BrowseModpackDetail';
import type { BrowserCard, BrowserPage } from '../types';

interface Props {
  onGoToProfiles?: () => void;
}

type TFunc = ReturnType<typeof useTranslation>['t'];

function relativeTime(iso: string, t: TFunc): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (secs < 60) return t('browseModpacks.justNow');
  if (secs < 3600) return t('browseModpacks.minutesAgo', { count: Math.floor(secs / 60) });
  if (secs < 86400) return t('browseModpacks.hoursAgo', { count: Math.floor(secs / 3600) });
  return t('browseModpacks.daysAgo', { count: Math.floor(secs / 86400) });
}

/** Collapse duplicate publishes by the same curator under the same pack
 *  name down to the most recently updated one. Some curators end up with
 *  two repos / two manifests for the same pack and the browser was
 *  showing both rows. Case-insensitive on name; owner stays exact. */
export function dedupeBrowserCards(cards: BrowserCard[]): BrowserCard[] {
  const newest = new Map<string, BrowserCard>();
  for (const card of cards) {
    const key = `${card.owner.toLowerCase()}/${card.name.trim().toLowerCase()}`;
    const existing = newest.get(key);
    if (!existing || Date.parse(card.updated_at) > Date.parse(existing.updated_at)) {
      newest.set(key, card);
    }
  }
  // Preserve original ordering of the surviving cards (the API ranks
  // them; we just drop the dupes that sat next to their newer twins).
  const survivorCodes = new Set(Array.from(newest.values()).map((c) => `${c.owner}/${c.code}`));
  return cards.filter((c) => survivorCodes.has(`${c.owner}/${c.code}`));
}

function isRateLimit(err: unknown): boolean {
  // Only treat as rate-limit when the message actually says so, or it's a
  // 429. Bare 403s also come from auth/permission errors which need a
  // different message, not "rate-limiting us."
  const m = err instanceof Error ? err.message : String(err);
  return /\b429\b/.test(m) || /rate limit/i.test(m);
}

/** Hard ceiling on how long we'll show skeletons before giving up. The
 *  backend bounds itself too (per-request + overall timeouts), so this is
 *  a frontend safety net: without it, any backend stall left the view
 *  stuck on skeletons forever with no error and no way to retry. */
const BROWSER_LOAD_TIMEOUT_MS = 45_000;

export function BrowseModpacksView({ onGoToProfiles }: Props = {}) {
  const { t } = useTranslation();
  const [page, setPage] = useState<BrowserPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [rateLimited, setRateLimited] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BrowserCard | null>(null);
  const [query, setQuery] = useState('');

  // `isCancelled` lets the mount effect abort its in-flight load on unmount
  // (the fetch can be parked behind the 45s timeout, well past teardown).
  // Without the guard, the awaited setState fires on an unmounted component.
  // Button-initiated loads (Retry / Refresh) pass no guard — they're always
  // live because the component is mounted to host the button.
  async function load(force = false, isCancelled: () => boolean = () => false) {
    setLoading(true);
    setRateLimited(false);
    setError(null);
    try {
      const result = await withTimeout(
        fetchModpackBrowserPage(1, force),
        BROWSER_LOAD_TIMEOUT_MS,
        t('browseModpacks.timedOut'),
      );
      if (isCancelled()) return;
      setPage(result);
    } catch (e) {
      if (isCancelled()) return;
      if (isRateLimit(e)) {
        setRateLimited(true);
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      if (!isCancelled()) setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    load(false, () => cancelled);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Client-side filter over the loaded cards (name + author). The list is
  // already deduped; the search just narrows it.
  const allCards = page ? dedupeBrowserCards(page.cards) : [];
  const q = query.trim().toLowerCase();
  const visibleCards = q
    ? allCards.filter(
        (c) => c.name.toLowerCase().includes(q) || c.owner.toLowerCase().includes(q),
      )
    : allCards;

  return (
    <>
      <div className="gf-view">
      <div className="gf-view-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <h2 className="gf-view-title">{t('browseModpacks.title')}</h2>
        </div>
        <button
          className="gf-btn-3"
          onClick={() => load(true)}
          disabled={loading}
          title={t('browseModpacks.refresh')}
        >
          <RefreshCw size={14} className={loading ? 'gf-spin' : undefined} />
          {page && !loading
            ? ` ${t('browseModpacks.lastRefreshed', { time: relativeTime(new Date(page.fetched_at * 1000).toISOString(), t) })}`
            : ''}
        </button>
      </div>

      {page?.stale && (
        <div className="gf-banner gf-banner-warn">
          {t('browseModpacks.cached')}
        </div>
      )}

      {rateLimited && (
        <div
          className="gf-banner gf-banner-warn"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}
        >
          <span>{t('browseModpacks.rateLimited')}</span>
          <button className="gf-btn-3" onClick={() => load(true)} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'gf-spin' : undefined} /> {t('browseModpacks.tryAgain')}
          </button>
        </div>
      )}

      {error && (
        <div
          className="gf-banner gf-banner-error"
          style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}
        >
          <span>{error}</span>
          <button className="gf-btn-3" onClick={() => load(true)} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'gf-spin' : undefined} /> {t('browseModpacks.tryAgain')}
          </button>
        </div>
      )}

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
            {t('browseModpacks.noPacks')}
          </div>
          {onGoToProfiles && (
            <button className="gf-btn-2" onClick={onGoToProfiles}>
              <Plus size={12} /> {t('browseModpacks.goProfiles')}
            </button>
          )}
        </div>
      )}

      {page && allCards.length > 0 && (
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
              <Trans
                i18nKey="browseModpacks.cta"
                components={{ 1: <b style={{ color: 'var(--ink)' }} /> }}
              />
            </span>
            {onGoToProfiles && (
              <button className="gf-btn-3" onClick={onGoToProfiles}>
                <Plus size={12} /> {t('browseModpacks.goProfiles')}
              </button>
            )}
          </div>
          {/* flex:none — this shared search class is `flex: 1 1 280px`, which
              is right inside the row toolbar it was built for but stretches
              vertically here (Browse lays its children out in a column),
              ballooning the bar. Pin it to its natural height. */}
          <label className="gf-profile-library-search" style={{ marginBottom: 12, flex: 'none' }}>
            <Search size={13} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('browseModpacks.searchPlaceholder')}
              aria-label={t('browseModpacks.searchPlaceholder')}
            />
          </label>
          {visibleCards.length === 0 ? (
            <div className="gf-empty">
              <Search size={28} />
              <div className="gf-empty-title">{t('browseModpacks.noMatches')}</div>
            </div>
          ) : (
            <div className="gf-card-list">
              {visibleCards.map((c) => (
                <button
                  key={`${c.owner}/${c.code}`}
                  className="gf-card gf-card-clickable"
                  onClick={() => setSelected(c)}
                >
                  <div className="gf-card-title">{c.name}</div>
                  <div className="gf-card-sub">
                    @{c.owner} · {t('browseModpacks.modCount', { count: c.mod_count })} · {t('browseModpacks.updated', { time: relativeTime(c.updated_at, t) })}
                  </div>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      </div>
      {selected && (
        <BrowseModpackDetail
          card={selected}
          onClose={() => setSelected(null)}
          onInstalled={onGoToProfiles}
        />
      )}
    </>
  );
}
