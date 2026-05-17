import { useEffect, useState } from 'react';
import { X, Download, ExternalLink } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { BrowserCard, Profile } from '../types';
import { fetchSharedProfile, installSharedProfile } from '../hooks/useTauri';
import { useTranslation } from 'react-i18next';
import { useToast } from '../contexts/ToastContext';

interface Props {
  card: BrowserCard;
  onClose: () => void;
  onInstalled?: () => void;
}

interface InstallProgress {
  profile_name: string;
  stage: 'fetching-manifest' | 'checking' | 'downloading' | 'applying' | 'subscribing' | 'done';
  current: number;
  total: number;
  mod_name: string | null;
}

/**
 * Detail panel for a single browser card. Opens when the curator clicks
 * a row in BrowseModpacksView; fetches the full profile manifest so the
 * user can see the mod list before committing to an install.
 *
 * Wire format note: `fetchSharedProfile` / `installSharedProfile` both
 * take a single string in the `"owner/code"` shape — the Rust side
 * splits on `/` to resolve the GitHub repo + manifest path.
 */
export function BrowseModpackDetail({ card, onClose, onInstalled }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<InstallProgress | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchSharedProfile(`${card.owner}/${card.code}`)
      .then((p) => {
        if (!cancelled) setProfile(p);
      })
      .catch((e) => {
        if (!cancelled) {
          toast.error(t('browseModpacks.couldntLoad', { error: e instanceof Error ? e.message : String(e) }));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [card.owner, card.code, toast]);

  useEffect(() => {
    const shareCode = `${card.owner}/${card.code}`;
    const unlisten = listen<InstallProgress>('modpack-install-progress', (event) => {
      if (event.payload.profile_name !== card.name && event.payload.profile_name !== shareCode) {
        return;
      }
      if (event.payload.stage === 'done') {
        setProgress(null);
      } else {
        setProgress(event.payload);
      }
    });
    return () => {
      unlisten.then((f) => f());
    };
  }, [card.code, card.name, card.owner]);

  async function handleInstall() {
    setInstalling(true);
    setProgress({
      profile_name: card.name,
      stage: 'fetching-manifest',
      current: 0,
      total: 0,
      mod_name: null,
    });
    try {
      await installSharedProfile(`${card.owner}/${card.code}`);
      toast.success(t('browseModpacks.installed', { name: card.name }));
      onInstalled?.();
      onClose();
    } catch (e) {
      toast.error(t('browseModpacks.installFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setInstalling(false);
      setProgress(null);
    }
  }

  async function openCuratorProfile() {
    try {
      await openUrl(`https://github.com/${card.owner}`);
    } catch {
      /* noop — opener failures aren't worth a toast here */
    }
  }

  function progressLabel() {
    if (!progress) return t('browseModpacks.preparingInstall');
    if (progress.stage === 'fetching-manifest') return t('browseModpacks.fetchingManifest');
    if (progress.stage === 'applying') return t('browseModpacks.applyingProfile');
    if (progress.stage === 'subscribing') return t('browseModpacks.subscribing');
    if (progress.mod_name && progress.total > 0) {
      const key = progress.stage === 'downloading' ? 'browseModpacks.downloadingMod' : 'browseModpacks.checkingMod';
      return t(key, { current: progress.current, total: progress.total, name: progress.mod_name });
    }
    return t('browseModpacks.installingModpack');
  }

  const progressPercent = progress?.total
    ? Math.min(100, Math.round((progress.current / progress.total) * 100))
    : 0;

  return (
    <div className="gf-modal-back" onClick={installing ? undefined : onClose}>
      <div
        className="gf-modal"
        style={{ width: 560 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gf-modal-head">
          <div>
            <div className="gf-modal-title">{card.name}</div>
            <div className="gf-modal-sub">
              <button
                className="gf-btn-3"
                onClick={openCuratorProfile}
                title={t('browseModpacks.openCurator')}
                style={{ padding: '2px 6px', fontSize: 12.5 }}
              >
                @{card.owner} <ExternalLink size={11} />
              </button>
              {' · '}
              {t('browseModpacks.modCount', { count: card.mod_count })}
            </div>
          </div>
          <button
            className="gf-btn-3 gf-btn-icon"
            onClick={onClose}
            disabled={installing}
            title={t('common.close')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body">
          {loading && <div style={{ color: 'var(--ink-mute)' }}>{t('common.loading')}</div>}
          {profile && (
            <div className="gf-mod-list">
              {profile.mods.map((m) => (
                <div key={m.name} className="gf-mod-row">
                  <span>{m.name}</span>
                  <span className="gf-dim">{m.version}</span>
                </div>
              ))}
            </div>
          )}

          {installing && (
            <div style={{ padding: '12px 2px 2px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--ink)' }}>
                {progressLabel()}
              </div>
              <div
                role="progressbar"
                aria-label={t('browseModpacks.installingModpack')}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progressPercent}
                style={{
                  width: '100%',
                  height: 8,
                  background: 'var(--indigo-elev)',
                  borderRadius: 999,
                  overflow: 'hidden',
                  marginBottom: 6,
                }}
              >
                <div
                  style={{
                    width: progressPercent > 0 ? `${progressPercent}%` : '12%',
                    height: '100%',
                    background: 'var(--gf)',
                    transition: 'width 200ms ease',
                  }}
                />
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--ink-dim)' }}>
                {t('browseModpacks.largePackNote')}
              </div>
            </div>
          )}
        </div>

        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={onClose} disabled={installing}>
            {t('common.cancel')}
          </button>
          <div style={{ flex: 1 }} />
          <button
            className="gf-btn"
            onClick={handleInstall}
            disabled={installing || !profile}
          >
            <Download size={12} /> {installing ? t('common.installing') : t('common.install')}
          </button>
        </div>
      </div>
    </div>
  );
}
