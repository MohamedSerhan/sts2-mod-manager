import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { Button } from './Button';
import { useToast } from '../contexts/ToastContext';
import { DiagnosticBundle } from './DiagnosticBundle';

/**
 * Compact "About" card — shown at the bottom of Home so the version, author,
 * and the two power-user actions (Check for updates, Generate support
 * bundle) are always one click away. Previously this only existed buried
 * under Settings → About, which the user couldn't find.
 */
export function AboutCard() {
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
        toast.success('You are on the latest version.');
        return;
      }
      toast.success(`v${update.version} available — installing...`);
      await update.downloadAndInstall();
      await relaunch();
    } catch (e) {
      toast.error(`Update check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setCheckingUpdate(false);
    }
  }

  return (
    <>
      <div className="gf-about-card">
        <div className="gf-about-glyph">✦</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 16, fontWeight: 600 }}>STS2 Mod Manager</div>
          <div style={{ fontSize: 12.5, color: 'var(--ink-mute)', marginTop: 4 }}>
            v{appVersion || '—'} · built for Slay the Spire 2 · Tauri 2 + React + Rust
          </div>
          <div style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 8 }}>
            Made by{' '}
            <a
              href="https://github.com/MohamedSerhan"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--gf)' }}
              className="hover:underline"
            >
              Mohamed Serhan
            </a>
            {' · '}open source · MIT license
          </div>
        </div>
        <div className="gf-about-actions">
          <Button variant="secondary" size="sm" onClick={handleCheckUpdateNow} disabled={checkingUpdate}>
            {checkingUpdate ? 'Checking...' : 'Check for updates'}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setShowDiag(true)}>
            Generate support bundle
          </Button>
        </div>
      </div>
      <DiagnosticBundle open={showDiag} onClose={() => setShowDiag(false)} />
    </>
  );
}
