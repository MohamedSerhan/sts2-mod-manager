import { useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { RefreshCw, Search, Plus } from 'lucide-react';

import { fetchModpackBrowserPage } from '../hooks/useTauri';
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

function isRateLimit(err: unknown): boolean {
  // Only treat as rate-limit when the message actually says so, or it's a
  // 429. Bare 403s also come from auth/permission errors which need a
  // different message, not "rate-limiting us."
  const m = err instanceof Error ? err.message : String(err);
  return /\b429\b/.test(m) || /rate limit/i.test(m);
}

export function BrowseModpacksView({ onGoToProfiles }: Props = {}) {
  const { t } = useTranslation();
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
        <h2 className="gf-view-title">{t('browseModpacks.title')}</h2>
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
        <div className="gf-banner gf-banner-warn">
          {t('browseModpacks.rateLimited')}
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
            {t('browseModpacks.noPacks')}
          </div>
          {onGoToProfiles && (
            <button className="gf-btn-2" onClick={onGoToProfiles}>
              <Plus size={12} /> {t('browseModpacks.goProfiles')}
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
          <div className="gf-card-list">
            {page.cards.map((c) => (
              <button
                key={`${c.owner}/${c.code}`}
                className="gf-card gf-card-clickable"
                onClick={() => setSelected(c)}
              >
                <div className="gf-card-title">{c.name}</div>
                <div className="gf-card-sub">
                  @{c.owner} · {c.mod_count === 1 ? t('browseModpacks.modCount', { count: c.mod_count }) : t('browseModpacks.modCount_plural', { count: c.mod_count })} · {t('browseModpacks.updated', { time: relativeTime(c.updated_at, t) })}
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
