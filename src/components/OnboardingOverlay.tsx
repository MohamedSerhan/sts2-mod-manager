import { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Check, AlertTriangle, ExternalLink, Folder, X, GitBranch } from 'lucide-react';
import type { GameInfo } from '../types';
import {
  detectGamePath,
  setGamePath,
  setNexusApiKey,
  setGithubToken,
} from '../hooks/useTauri';
import { open } from '@tauri-apps/plugin-dialog';

// v5 batch 4 — three-step onboarding wizard. Replaces the earlier static
// checklist overlay. Steps: detect game → connect accounts → pick profile.
// Each step has a normal happy path and clear failure states.

interface OnboardingProps {
  gameInfo: GameInfo | null;
  onSkip: () => void;
  onComplete: () => void;
  onAddCode: () => void;
  refreshGame: () => Promise<void>;
}

type Step = 1 | 2 | 3;
type GameSub = 'normal' | 'gameNotFound';
type KeySub = 'normal' | 'keyRejected';

export function OnboardingOverlay({
  gameInfo,
  onSkip,
  onComplete,
  onAddCode,
  refreshGame,
}: OnboardingProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(1);

  // Step 1 — game detection
  const [detected, setDetected] = useState(gameInfo?.valid ?? false);
  const [detectedPath, setDetectedPath] = useState(gameInfo?.game_path ?? '');
  const [gameSub, setGameSub] = useState<GameSub>(gameInfo?.valid ? 'normal' : 'gameNotFound');
  const [manualPath, setManualPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [pathError, setPathError] = useState('');

  // Step 2 — accounts
  const [nexusKey, setNexusKey] = useState('');
  const [keySub, setKeySub] = useState<KeySub>('normal');
  const [keyTesting, setKeyTesting] = useState(false);
  const [nexusOk, setNexusOk] = useState(false);
  const [ghToken, setGhToken] = useState('');
  const [ghSaved, setGhSaved] = useState(false);

  async function handleDetect() {
    try {
      setBusy(true);
      const info = await detectGamePath();
      if (info.valid && info.game_path) {
        setDetected(true);
        setDetectedPath(info.game_path);
        setGameSub('normal');
        await refreshGame();
      } else {
        setGameSub('gameNotFound');
      }
    } catch {
      setGameSub('gameNotFound');
    } finally {
      setBusy(false);
    }
  }

  async function handleBrowse() {
    try {
      const selected = await open({ directory: true, multiple: false });
      if (!selected) return;
      const picked = typeof selected === 'string' ? selected : String(selected);
      setManualPath(picked);
      setBusy(true);
      const info = await setGamePath(picked);
      if (info.valid) {
        setDetected(true);
        setDetectedPath(info.game_path ?? picked);
        setGameSub('normal');
        setPathError('');
        await refreshGame();
      } else {
        // Platform-specific cue for what the install root should look like.
        const signature =
          typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
            ? 'SlayTheSpire2.app'
            : typeof navigator !== 'undefined' && /Linux/.test(navigator.platform)
            ? 'SlayTheSpire2.pck'
            : 'SlayTheSpire2.exe';
        setPathError(t('onboarding.step1.pathError', { signature }));
      }
    } catch (e) {
      setPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleTestNexus() {
    if (!nexusKey.trim()) return;
    setKeyTesting(true);
    try {
      await setNexusApiKey(nexusKey.trim());
      setNexusOk(true);
      setKeySub('normal');
    } catch {
      setNexusOk(false);
      setKeySub('keyRejected');
    } finally {
      setKeyTesting(false);
    }
  }

  async function handleSaveGh() {
    if (!ghToken.trim()) return;
    try {
      await setGithubToken(ghToken.trim());
      setGhSaved(true);
    } catch {
      // ignore — token is optional
    }
  }

  function next() {
    if (step < 3) setStep((s) => (s + 1) as Step);
    else onComplete();
  }

  function back() {
    if (step > 1) setStep((s) => (s - 1) as Step);
  }

  function pick(action: 'vanilla' | 'follow' | 'json' | 'skip') {
    if (action === 'follow') {
      onComplete();
      onAddCode();
    } else {
      onComplete();
    }
  }

  return (
    <div className="gf-wiz-back">
      <div className="gf-wiz">
        <div className="gf-wiz-rail">
          <div className={`gf-wiz-step ${step > 1 ? 'done' : step === 1 ? 'active' : ''}`} />
          <div className={`gf-wiz-step ${step > 2 ? 'done' : step === 2 ? 'active' : ''}`} />
          <div className={`gf-wiz-step ${step === 3 ? 'active' : ''}`} />
        </div>

        <div className="gf-wiz-head">
          <div className="gf-wiz-eyebrow">{t('onboarding.stepIndicator', { step })}</div>
          {step === 1 && (
            <>
              <div className="gf-wiz-title">{t('onboarding.step1.title')}</div>
              <div className="gf-wiz-sub">
                {t('onboarding.step1.subtitle')}
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <div className="gf-wiz-title">{t('onboarding.step2.title')}</div>
              <div className="gf-wiz-sub">
                {t('onboarding.step2.subtitle')}
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <div className="gf-wiz-title">{t('onboarding.step3.title')}</div>
              <div className="gf-wiz-sub">
                {t('onboarding.step3.subtitle')}
              </div>
            </>
          )}
        </div>

        <div className="gf-wiz-body">
          {step === 1 && detected && gameSub === 'normal' && (
            <div className="gf-wiz-detect ok">
              <span className="gf-wiz-detect-ico" style={{ color: 'var(--ok)' }}>
                <Check size={22} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="gf-wiz-detect-t">{t('onboarding.step1.found')}</div>
                <div className="gf-wiz-detect-s" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {detectedPath}
                </div>
              </div>
              <button className="gf-btn-3 gf-btn-2-sm" onClick={() => { setDetected(false); setGameSub('gameNotFound'); }}>
                {t('onboarding.step1.change')}
              </button>
            </div>
          )}

          {step === 1 && (!detected || gameSub === 'gameNotFound') && (
            <>
              <div className="gf-wiz-detect err">
                <span className="gf-wiz-detect-ico" style={{ color: 'oklch(0.82 0.16 25)' }}>
                  <AlertTriangle size={22} />
                </span>
                <div style={{ flex: 1 }}>
                  <div className="gf-wiz-detect-t">{t('onboarding.step1.notFound')}</div>
                  <div className="gf-wiz-detect-s">
                    {t('onboarding.step1.pickFolder')}
                    <code>
                      {typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
                        ? 'SlayTheSpire2.app'
                        : typeof navigator !== 'undefined' && /Linux/.test(navigator.platform)
                        ? 'SlayTheSpire2.pck'
                        : 'SlayTheSpire2.exe'}
                    </code>
                    .
                  </div>
                </div>
                <button className="gf-btn-2 gf-btn-2-sm" onClick={handleDetect} disabled={busy}>
                  {busy ? t('onboarding.step1.detecting') : t('onboarding.step1.tryAgain')}
                </button>
              </div>
              <div className="gf-field" style={{ marginTop: 14 }}>
                <label className="gf-field-label">{t('onboarding.step1.browseLabel')}</label>
                <div className="gf-input-row">
                  <input
                    className={`gf-set-input ${pathError ? 'is-err' : ''}`}
                    value={manualPath}
                    onChange={(e) => setManualPath(e.target.value)}
                    placeholder={
                      typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
                        ? t('onboarding.step1.browsePlaceholderMac')
                        : typeof navigator !== 'undefined' && /Linux/.test(navigator.platform)
                        ? t('onboarding.step1.browsePlaceholderLinux')
                        : t('onboarding.step1.browsePlaceholderWindows')
                    }
                  />
                  <button className="gf-btn-3" onClick={handleBrowse} disabled={busy}>
                    <Folder size={12} /> {t('onboarding.step1.browse')}
                  </button>
                </div>
                {pathError && (
                  <div className="gf-help err">
                    <X size={11} /> {pathError}
                  </div>
                )}
              </div>
            </>
          )}

          {step === 2 && (
            <div style={{ display: 'grid', gap: 12 }}>
              <div className="gf-field">
                <label className="gf-field-label">{t('onboarding.step2.nexusLabel')}</label>
                <div className="gf-input-row">
                  <input
                    className={`gf-set-input ${nexusOk ? 'is-ok' : keySub === 'keyRejected' ? 'is-err' : ''}`}
                    type="password"
                    value={nexusKey}
                    onChange={(e) => setNexusKey(e.target.value)}
                    placeholder={t('onboarding.step2.nexusPlaceholder')}
                  />
                  <button className="gf-btn-3" onClick={handleTestNexus} disabled={keyTesting || !nexusKey.trim()}>
                    {keyTesting ? t('onboarding.step2.testing') : t('onboarding.step2.testSave')}
                  </button>
                </div>
                {nexusOk && (
                  <div className="gf-help ok">
                    <Check size={11} /> {t('onboarding.step2.nexusSaved')}
                  </div>
                )}
                {keySub === 'keyRejected' && (
                  <div className="gf-help err">
                    <X size={11} /> {t('onboarding.step2.nexusRejected')}
                    <a href="https://www.nexusmods.com/users/myaccount?tab=api" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>
                      {t('onboarding.step2.generateNew')}
                    </a>
                  </div>
                )}
                {!nexusOk && keySub !== 'keyRejected' && (
                  <div className="gf-help muted">{t('onboarding.step2.nexusSkipHint')}</div>
                )}
                <div className="gf-help muted" style={{ marginTop: 4, fontSize: 11 }}>
                  {t('onboarding.step2.nexusFreeNote')}
                </div>
              </div>

              <div className="gf-field">
                <label className="gf-field-label">{t('onboarding.step2.ghLabel')}</label>
                <div className="gf-input-row">
                  <input
                    className={`gf-set-input ${ghSaved ? 'is-ok' : ''}`}
                    type="password"
                    value={ghToken}
                    onChange={(e) => setGhToken(e.target.value)}
                    placeholder={t('onboarding.step2.ghPlaceholder')}
                  />
                  <button className="gf-btn-3" onClick={handleSaveGh} disabled={!ghToken.trim()}>
                    <GitBranch size={12} /> {t('common.save')}
                  </button>
                </div>
                {ghSaved && (
                  <div className="gf-help ok">
                    <Check size={11} /> {t('onboarding.step2.ghSaved')}
                  </div>
                )}
                {!ghSaved && (
                  <div className="gf-help muted">{t('onboarding.step2.ghSkipHint')}</div>
                )}
                <div className="gf-help muted" style={{ marginTop: 4, fontSize: 11 }}>
                  <Trans i18nKey="onboarding.step2.ghRequiredNote">
                    <b />
                    <code />
                    <code />
                    <code />
                  </Trans>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div style={{ display: 'grid', gap: 8 }}>
              {(
                [
                  [t('onboarding.step3.optionVanilla.title'), t('onboarding.step3.optionVanilla.desc'), 'vanilla'],
                  [t('onboarding.step3.optionFollow.title'), t('onboarding.step3.optionFollow.desc'), 'follow'],
                  [t('onboarding.step3.optionImport.title'), t('onboarding.step3.optionImport.desc'), 'json'],
                  [t('onboarding.step3.optionSkip.title'), t('onboarding.step3.optionSkip.desc'), 'skip'],
                ] as const
              ).map(([label, desc, action], i) => (
                <button
                  key={action}
                  onClick={() => pick(action)}
                  style={{
                    textAlign: 'left',
                    padding: '12px 14px',
                    borderRadius: 9,
                    background: i === 0 ? 'oklch(0.62 0.14 145 / 0.10)' : 'var(--indigo-deep)',
                    border: `1px solid ${i === 0 ? 'oklch(0.62 0.14 145 / 0.5)' : 'var(--indigo-line)'}`,
                    color: 'var(--ink)',
                    fontSize: 13,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{label}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 3 }}>{desc}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="gf-wiz-foot">
          <button className="gf-btn-3" onClick={back} disabled={step === 1}>
            {t('common.back')}
          </button>
          <button className="gf-btn-3" onClick={onSkip}>
            {t('onboarding.skipSetup')}
          </button>
          <div style={{ flex: 1 }} />
          {step < 3 ? (
            <button className="gf-btn" onClick={next}>
              {step === 2 && !nexusOk && !ghSaved ? (
                t('onboarding.skipForNow')
              ) : (
                <>{t('common.next')} <ExternalLink size={11} style={{ transform: 'rotate(-45deg)' }} /></>
              )}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
