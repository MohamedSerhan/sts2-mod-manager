import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Card } from './Card';
import { Button } from './Button';
import { useToast } from '../contexts/ToastContext';

interface DevBuildAsset {
  name: string;
  url: string;
  platform: string;
}
interface DevBuild {
  pr: number;
  sha: string;
  title: string;
  published_at: string;
  windows_installer_url: string | null;
  assets: DevBuildAsset[];
}

/** Dev-build-only "switch which PR build is in the (Dev) slot" panel.
 *  Rendered by Settings only when the running build is a dev build. */
export function DevBuildsCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const [builds, setBuilds] = useState<DevBuild[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentSha, setCurrentSha] = useState('');
  const [installingPr, setInstallingPr] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<DevBuild[]>('list_dev_builds');
      setBuilds(list);
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
        if (m) setCurrentSha(m[1]);
      })
      .catch(() => {});
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSwitch(b: DevBuild) {
    if (!b.windows_installer_url || installingPr !== null) return;
    setInstallingPr(b.pr);
    try {
      await invoke('install_dev_build', { installerUrl: b.windows_installer_url });
      toast.success(t('devBuilds.installing', { pr: b.pr }));
    } catch (e) {
      toast.error(t('devBuilds.installFailed', { error: e instanceof Error ? e.message : String(e) }));
      setInstallingPr(null);
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
          <Button variant="ghost" size="sm" onClick={load}>
            {t('devBuilds.retry')}
          </Button>
        </div>
      )}

      {!loading && !error && builds?.length === 0 && <p>{t('devBuilds.empty')}</p>}

      {!loading && !error && builds && builds.length > 0 && (
        <ul className="gf-devbuilds-list">
          {builds.map((b) => {
            const isCurrent = b.sha !== '' && b.sha === currentSha;
            return (
              <li key={b.pr} className="gf-devbuilds-row">
                <div>
                  <strong>PR #{b.pr}</strong> · g{b.sha || '—'}
                  {isCurrent && <span className="gf-badge"> {t('devBuilds.current')}</span>}
                  <div className="gf-dim" title={b.title}>{new Date(b.published_at).toLocaleDateString()}</div>
                </div>
                <div className="gf-devbuilds-actions">
                  {b.windows_installer_url ? (
                    <Button
                      size="sm"
                      disabled={isCurrent || installingPr !== null}
                      onClick={() => handleSwitch(b)}
                    >
                      {installingPr === b.pr ? t('devBuilds.installingShort') : t('devBuilds.switchTo')}
                    </Button>
                  ) : (
                    <span className="gf-dim">{t('devBuilds.noWindowsBuild')}</span>
                  )}
                  {b.assets.map((a) => (
                    <Button
                      key={a.name}
                      variant="ghost"
                      size="sm"
                      onClick={() => openUrl(a.url).catch(() => {})}
                    >
                      {a.platform}
                    </Button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="gf-dim">{t('devBuilds.backToRelease')}</p>
    </Card>
  );
}
