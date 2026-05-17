import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Button } from './Button';
import { useToast } from '../contexts/ToastContext';
import { DiagnosticBundle } from './DiagnosticBundle';

/**
 * "About" footer for the Home screen. Lives below all primary content as a
 * low-weight footer (rule line, dim text, two utility actions) — not a
 * card. The user explicitly asked for footer treatment so the visual
 * weight stops fighting the actual home content above it.
 */
export function AboutCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const [appVersion, setAppVersion] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [showDiag, setShowDiag] = useState(false);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  async function handleCheckUpdateNow() {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const update = await check();
      if (!update) {
        toast.success(t('about.latestVersion'));
        return;
      }
      toast.success(t('about.updateAvailable', { version: update.version }));
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      toast.error(t('about.updateCheckFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setCheckingUpdate(false);
    }
  }

  return (
    <>
      <footer className="gf-about-footer">
        <div className="gf-about-footer-line">
          <span className="gf-about-footer-glyph" aria-hidden>✦</span>
          <span className="gf-about-footer-text">
            <strong>{t('about.title')}</strong>
            <span className="gf-about-footer-sep">·</span>
            v{appVersion || '—'}
            <span className="gf-about-footer-sep">·</span>
            {t('about.madeBy')}{' '}
            <a
              href="https://github.com/MohamedSerhan"
              target="_blank"
              rel="noopener noreferrer"
              className="gf-about-footer-link"
            >
              Mohamed Serhan
            </a>
            <span className="gf-about-footer-sep">·</span>
            {t('about.license')}
          </span>
          <span className="gf-about-footer-actions">
            <Button variant="ghost" size="sm" onClick={handleCheckUpdateNow} disabled={checkingUpdate}>
              {checkingUpdate ? t('about.checking') : t('about.checkForUpdates')}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowDiag(true)}>
              {t('about.generateSupportBundle')}
            </Button>
          </span>
        </div>
      </footer>
      <DiagnosticBundle open={showDiag} onClose={() => setShowDiag(false)} />
    </>
  );
}
