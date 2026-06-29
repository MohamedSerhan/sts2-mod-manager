import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { Button } from './Button';
import { DiagnosticBundle } from './DiagnosticBundle';

interface AboutCardProps {
  onCheckForAppUpdate?: () => void | Promise<void>;
  checkingAppUpdate?: boolean;
}

/**
 * "About" footer for the Home screen. Lives below all primary content as a
 * low-weight footer (rule line, dim text, two utility actions) — not a
 * card. The user explicitly asked for footer treatment so the visual
 * weight stops fighting the actual home content above it.
 */
export function AboutCard({ onCheckForAppUpdate, checkingAppUpdate = false }: AboutCardProps) {
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState('');
  const [showDiag, setShowDiag] = useState(false);

  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  function handleCheckUpdateNow() {
    if (checkingAppUpdate) return;
    void onCheckForAppUpdate?.();
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
            <Button variant="ghost" size="sm" onClick={handleCheckUpdateNow} disabled={checkingAppUpdate}>
              {checkingAppUpdate ? t('about.checking') : t('about.checkForUpdates')}
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
