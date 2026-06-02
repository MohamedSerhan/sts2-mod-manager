import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, AlertTriangle, Folder, X, Layers, Play, Wrench, Share2 } from 'lucide-react';
import type { GameInfo } from '../types';
import { detectGamePath, setGamePath } from '../hooks/useTauri';
import { open } from '@tauri-apps/plugin-dialog';
import { LanguageSelect } from './LanguageSelect';

// 1.7.0 T8 — branched onboarding flow. Replaces the prior linear three-
// step wizard (detect game → credentials → profile choice) which pushed
// API keys upfront and assumed the user wanted a profile picker on the
// very first launch. The new flow asks ONE question — "Play modpacks
// others made" vs "Make or share modpacks" — then teaches the relevant
// path through the new IA. GitHub setup is deferred to share time
// (ShareSetupPanel inline in PublishModal); Nexus API key is deferred
// to the first manual Nexus install. Neither is mentioned by name as a
// required step here.
//
// State machine:
//   detect-game ─► audience ─► player-card-1 ─► player-card-2 ─► (done)
//                       │
//                       └─► creator-card-1 ─► creator-card-2 ─► (done)
//
// Skip is reachable from every step's footer. Back navigates one node
// up the tree; from the audience step, Back returns to detect-game
// (which the user can re-run / re-browse from). The card screens are
// not interactive forms — just title + body + CTA — so the only
// meaningful "back" target from a card is the audience choice.

type Step =
  | 'detect-game'
  | 'audience'
  | 'player-card-1'
  | 'player-card-2'
  | 'creator-card-1'
  | 'creator-card-2';

type GameSub = 'normal' | 'gameNotFound';

interface OnboardingProps {
  gameInfo: GameInfo | null;
  /** Closes the overlay + persists the dismissal flag. Used by the
   *  always-visible Skip button AND by the player-path "Got it" / the
   *  creator-path "I'll do it later" CTAs. */
  onSkip: () => void;
  /** Closes the overlay + persists the dismissal flag. Same effect as
   *  onSkip; the rename clarifies intent at call sites where the user
   *  finished the flow rather than abandoning it. */
  onComplete: () => void;
  /** Closes the overlay WITHOUT persisting the dismissal, so onboarding shows
   *  again next launch. Used by the detect-game step's Skip when no game has
   *  been found yet, so a no-game first-run user isn't locked out of the
   *  guided intro forever. Optional; falls back to onSkip when not provided. */
  onDismissWithoutPersist?: () => void;
  /** Creator path's primary CTA. Closes onboarding AND opens the
   *  CreateModpackWizard (or routes to the Modpacks page where the
   *  user can click Create — App.tsx owns the choice). Optional so
   *  tests can render the overlay without the full App shell. */
  onCreateModpack?: () => void;
  /** Player path's "Got it" CTA. Routes the user to the Home view
   *  where the Play button lives. Optional for the same reason as
   *  onCreateModpack. */
  onGoToHome?: () => void;
  /** Re-fetch the AppContext gameInfo after a successful detect /
   *  browse so the sidebar status pill flips green immediately
   *  (instead of waiting for a manual refresh elsewhere). */
  refreshGame: () => Promise<void> | void;
}

export function OnboardingOverlay({
  gameInfo,
  onSkip,
  onComplete,
  onDismissWithoutPersist,
  onCreateModpack,
  onGoToHome,
  refreshGame,
}: OnboardingProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('detect-game');

  // ── Step 1 (detect-game) state ────────────────────────────────────
  const [detected, setDetected] = useState(gameInfo?.valid ?? false);
  const [detectedPath, setDetectedPath] = useState(gameInfo?.game_path ?? '');
  const [gameSub, setGameSub] = useState<GameSub>(gameInfo?.valid ? 'normal' : 'gameNotFound');
  const [manualPath, setManualPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [pathError, setPathError] = useState('');

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

  // ── Navigation helpers ────────────────────────────────────────────
  // The branched state machine does NOT have a single linear "next" /
  // "back" — each step picks its own destination. We keep these helpers
  // tiny so the JSX below stays readable.

  function goBack() {
    if (step === 'audience') setStep('detect-game');
    else if (step === 'player-card-1') setStep('audience');
    else if (step === 'player-card-2') setStep('player-card-1');
    else if (step === 'creator-card-1') setStep('audience');
    else if (step === 'creator-card-2') setStep('creator-card-1');
    // detect-game has nowhere to go back to — the button is disabled.
  }

  function pickPlayer() {
    setStep('player-card-1');
  }
  function pickCreator() {
    setStep('creator-card-1');
  }

  function finishPlayer() {
    // Player-path final CTA — close + route to Home where the Play
    // button lives.
    onComplete();
    onGoToHome?.();
  }

  function finishCreatorGo() {
    // Creator-path primary CTA — close + open the Create wizard (App.tsx
    // owns the actual surface; this just fires the callback).
    onComplete();
    onCreateModpack?.();
  }

  function finishCreatorLater() {
    // Creator-path secondary CTA — close, no routing.
    onComplete();
  }

  // ── Render ────────────────────────────────────────────────────────

  // Per-step heading metadata. Centralised so the heading row + step
  // indicator stay in sync without each step branch repeating it.
  const headings: Record<Step, { eyebrow: string; title: string; subtitle: string }> = {
    'detect-game': {
      eyebrow: t('onboarding.eyebrow.step1'),
      title: t('onboarding.step1.title'),
      subtitle: t('onboarding.step1.subtitle'),
    },
    audience: {
      eyebrow: t('onboarding.eyebrow.step2'),
      title: t('onboarding.step2.title'),
      subtitle: t('onboarding.step2.subtitle'),
    },
    'player-card-1': {
      eyebrow: t('onboarding.eyebrow.playerPath'),
      title: t('onboarding.playerPath.card1Title'),
      subtitle: t('onboarding.playerPath.card1Body'),
    },
    'player-card-2': {
      eyebrow: t('onboarding.eyebrow.playerPath'),
      title: t('onboarding.playerPath.card2Title'),
      subtitle: t('onboarding.playerPath.card2Body'),
    },
    'creator-card-1': {
      eyebrow: t('onboarding.eyebrow.creatorPath'),
      title: t('onboarding.creatorPath.card1Title'),
      subtitle: t('onboarding.creatorPath.card1Body'),
    },
    'creator-card-2': {
      eyebrow: t('onboarding.eyebrow.creatorPath'),
      title: t('onboarding.creatorPath.card2Title'),
      subtitle: t('onboarding.creatorPath.card2Body'),
    },
  };
  const heading = headings[step];

  return (
    <div className="gf-wiz-back">
      <div className="gf-wiz">
        <div className="gf-wiz-head">
          <div className="gf-wiz-head-row">
            <div className="gf-wiz-eyebrow">{heading.eyebrow}</div>
            <LanguageSelect compact />
          </div>
          <div className="gf-wiz-title">{heading.title}</div>
          <div className="gf-wiz-sub">{heading.subtitle}</div>
        </div>

        <div className="gf-wiz-body">
          {/* ── Step 1: Game detection ─────────────────────────────── */}
          {step === 'detect-game' && detected && gameSub === 'normal' && (
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
              <button
                className="gf-btn-3 gf-btn-2-sm"
                onClick={() => { setDetected(false); setGameSub('gameNotFound'); }}
              >
                {t('onboarding.step1.change')}
              </button>
            </div>
          )}

          {step === 'detect-game' && (!detected || gameSub === 'gameNotFound') && (
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

          {/* ── Step 2: Audience choice ────────────────────────────── */}
          {step === 'audience' && (
            <div style={{ display: 'grid', gap: 10 }}>
              <button
                type="button"
                onClick={pickPlayer}
                className="gf-wiz-audience"
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'flex-start',
                  textAlign: 'start',
                  padding: '14px 16px',
                  borderRadius: 10,
                  background: 'oklch(0.62 0.14 145 / 0.10)',
                  border: '1px solid oklch(0.62 0.14 145 / 0.5)',
                  color: 'var(--ink)',
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <span style={{ color: 'var(--ok)', flex: 'none', marginTop: 2 }}>
                  <Play size={20} fill="currentColor" />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t('onboarding.step2.playerCta')}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginTop: 3 }}>
                    {t('onboarding.step2.playerDesc')}
                  </div>
                </span>
              </button>

              <button
                type="button"
                onClick={pickCreator}
                className="gf-wiz-audience"
                style={{
                  display: 'flex',
                  gap: 12,
                  alignItems: 'flex-start',
                  textAlign: 'start',
                  padding: '14px 16px',
                  borderRadius: 10,
                  background: 'var(--indigo-deep)',
                  border: '1px solid var(--indigo-line)',
                  color: 'var(--ink)',
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                <span style={{ color: 'var(--ink-mute)', flex: 'none', marginTop: 2 }}>
                  <Wrench size={20} />
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{t('onboarding.step2.creatorCta')}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginTop: 3 }}>
                    {t('onboarding.step2.creatorDesc')}
                  </div>
                </span>
              </button>
            </div>
          )}

          {/* ── Player path cards ──────────────────────────────────── */}
          {step === 'player-card-1' && (
            <div className="gf-wiz-teach">
              <div className="gf-wiz-teach-icon" style={{ color: 'var(--ok)' }}>
                <Layers size={28} />
              </div>
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-mute)' }}>
                {t('onboarding.playerPath.card1Detail')}
              </p>
            </div>
          )}

          {step === 'player-card-2' && (
            <div className="gf-wiz-teach">
              <div className="gf-wiz-teach-icon" style={{ color: 'var(--ok)' }}>
                <Play size={28} fill="currentColor" />
              </div>
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-mute)' }}>
                {t('onboarding.playerPath.card2Detail')}
              </p>
            </div>
          )}

          {/* ── Creator path cards ─────────────────────────────────── */}
          {step === 'creator-card-1' && (
            <div className="gf-wiz-teach">
              <div className="gf-wiz-teach-icon" style={{ color: 'var(--ok)' }}>
                <Wrench size={28} />
              </div>
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-mute)' }}>
                {t('onboarding.creatorPath.card1Detail')}
              </p>
            </div>
          )}

          {step === 'creator-card-2' && (
            <div className="gf-wiz-teach">
              <div className="gf-wiz-teach-icon" style={{ color: 'var(--ok)' }}>
                <Share2 size={28} />
              </div>
              <p style={{ margin: 0, fontSize: 12.5, color: 'var(--ink-mute)' }}>
                {t('onboarding.creatorPath.card2Detail')}
              </p>
            </div>
          )}
        </div>

        <div className="gf-wiz-foot">
          <button
            className="gf-btn-3"
            onClick={goBack}
            disabled={step === 'detect-game'}
          >
            {t('common.back')}
          </button>
          {/* On the detect-game step with no game found yet, Skip must NOT
              permanently dismiss onboarding (the user can't pass the gate, so
              they'd otherwise be locked out of the guided intro forever). Use a
              non-persisting close + a label that signals it'll return. */}
          {step === 'detect-game' && !detected ? (
            <button className="gf-btn-3" onClick={onDismissWithoutPersist ?? onSkip}>
              {t('onboarding.setUpLater')}
            </button>
          ) : (
            <button className="gf-btn-3" onClick={onSkip}>
              {t('onboarding.skip')}
            </button>
          )}
          <div style={{ flex: 1 }} />

          {/* Step-specific primary action. The audience step has no
              primary CTA — the user picks one of the two big buttons
              in the body. The teaching cards each have their own
              advance CTA. */}
          {step === 'detect-game' && (
            <button
              className="gf-btn"
              onClick={() => setStep('audience')}
              disabled={!detected}
            >
              {t('onboarding.step1.continue')}
            </button>
          )}

          {step === 'player-card-1' && (
            <button className="gf-btn" onClick={() => setStep('player-card-2')}>
              {t('onboarding.next')}
            </button>
          )}

          {step === 'player-card-2' && (
            <button className="gf-btn" onClick={finishPlayer}>
              {t('onboarding.playerPath.cta')}
            </button>
          )}

          {step === 'creator-card-1' && (
            <button className="gf-btn" onClick={() => setStep('creator-card-2')}>
              {t('onboarding.next')}
            </button>
          )}

          {step === 'creator-card-2' && (
            <>
              <button className="gf-btn-3" onClick={finishCreatorLater}>
                {t('onboarding.creatorPath.ctaSkip')}
              </button>
              <button className="gf-btn" onClick={finishCreatorGo}>
                {t('onboarding.creatorPath.cta')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
