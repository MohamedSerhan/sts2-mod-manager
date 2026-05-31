import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Search } from 'lucide-react';
import { Card } from './Card';
import { Button } from './Button';
import { useToast } from '../contexts/ToastContext';
import { listDevBuilds, switchDevBuild, type DevBuild } from '../hooks/useTauri';

/** Dev-build-only panel: list open PRs' dev builds and one-click switch the
 *  (Dev) slot between them. Rendered by Settings only on dev builds. */
export function DevBuildsCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const [builds, setBuilds] = useState<DevBuild[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentSha, setCurrentSha] = useState('');
  const [switchingPr, setSwitchingPr] = useState<number | null>(null);
  const [filter, setFilter] = useState('');
  const [openDownloads, setOpenDownloads] = useState<Set<number>>(new Set());

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setBuilds(await listDevBuilds());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    getVersion()
      .then((v) => {
        const m = v.match(/\.g([0-9a-f]+)/i);
        if (m) setCurrentSha(m[1].toLowerCase());
      })
      .catch(() => {});
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term || !builds) return builds ?? [];
    return builds.filter(
      (b) =>
        String(b.pr).includes(term) ||
        b.sha.toLowerCase().includes(term) ||
        b.title.toLowerCase().includes(term),
    );
  }, [builds, filter]);

  async function handleSwitch(b: DevBuild) {
    if (!b.manifest_url || switchingPr !== null) return;
    setSwitchingPr(b.pr);
    try {
      await switchDevBuild(b.manifest_url);
      toast.success(t('devBuilds.switching', { pr: b.pr }));
    } catch (e) {
      toast.error(t('devBuilds.switchFailed', { error: e instanceof Error ? e.message : String(e) }));
      setSwitchingPr(null);
    }
  }

  return (
    <Card>
      <h2>{t('devBuilds.title')}</h2>
      <p className="gf-dim">{t('devBuilds.subtitle')}</p>

      {loading && <p>{t('devBuilds.loading')}</p>}

      {error && (
        <div>
          <p className="gf-error">{t('devBuilds.error', { error })}</p>
          <Button variant="ghost" size="sm" onClick={load}>{t('devBuilds.retry')}</Button>
        </div>
      )}

      {!loading && !error && builds && builds.length > 0 && (
        <div className="gf-devbuilds-search">
          <Search size={14} style={{ color: 'var(--ink-dim)' }} />
          <input
            type="text"
            aria-label={t('devBuilds.search')}
            placeholder={t('devBuilds.search')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}

      {!loading && !error && builds?.length === 0 && <p>{t('devBuilds.empty')}</p>}
      {!loading && !error && builds && builds.length > 0 && filtered.length === 0 && (
        <p className="gf-dim">{t('devBuilds.noMatch')}</p>
      )}

      {!loading && !error && filtered.length > 0 && (
        <ul className="gf-devbuilds-list">
          {filtered.map((b) => {
            const isCurrent = b.sha !== '' && b.sha === currentSha;
            const isOpen = openDownloads.has(b.pr);
            return (
              <li key={b.pr} className="gf-devbuilds-row">
                <div className="gf-devbuilds-meta">
                  <div className="gf-devbuilds-pr">
                    <strong>PR #{b.pr}</strong>
                    <span className="gf-dim"> · g{b.sha || '—'}</span>
                    {isCurrent && <span className="gf-badge gf-badge-current">{t('devBuilds.current')}</span>}
                  </div>
                  <div className="gf-dim gf-devbuilds-date" title={b.title}>
                    {new Date(b.published_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="gf-devbuilds-actions">
                  {isCurrent ? (
                    <span className="gf-dim">{t('devBuilds.running')}</span>
                  ) : b.manifest_url ? (
                    <Button size="sm" disabled={switchingPr !== null} onClick={() => handleSwitch(b)}>
                      {switchingPr === b.pr ? t('devBuilds.switchingShort') : t('devBuilds.switchTo')}
                    </Button>
                  ) : (
                    <span className="gf-dim">{t('devBuilds.noWindowsBuild')}</span>
                  )}
                  <details
                    className="gf-devbuilds-downloads"
                    open={isOpen}
                    onToggle={(e) => {
                      const open = (e.currentTarget as HTMLDetailsElement).open;
                      setOpenDownloads((prev) => {
                        const next = new Set(prev);
                        if (open) next.add(b.pr); else next.delete(b.pr);
                        return next;
                      });
                    }}
                  >
                    <summary>{t('devBuilds.downloads')}</summary>
                    {isOpen && (
                      <div className="gf-devbuilds-dl-list">
                        {b.assets.map((a) => (
                          <button
                            key={a.name}
                            type="button"
                            className="gf-link-btn"
                            onClick={() => openUrl(a.url).catch(() => {})}
                          >
                            {a.platform}
                          </button>
                        ))}
                      </div>
                    )}
                  </details>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && !error && (
        <p className="gf-dim gf-devbuilds-foot">{t('devBuilds.backToRelease')}</p>
      )}
    </Card>
  );
}
