import { useState } from 'react';
import { Check, AlertTriangle, ExternalLink, Folder, X, GitBranch } from 'lucide-react';
import type { GameInfo } from '../types';
import { GITHUB_TOKEN_TEMPLATE_URL } from '../lib/githubLinks';
import {
  detectGamePath,
  openExternalUrl,
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
  const [ghOpenError, setGhOpenError] = useState('');

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
        setPathError(`This folder doesn't look like a Slay the Spire 2 install (no ${signature} found) — pick the install root.`);
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

  async function handleOpenGithubTokenTemplate() {
    setGhOpenError('');
    try {
      await openExternalUrl(GITHUB_TOKEN_TEMPLATE_URL);
    } catch (e) {
      setGhOpenError(e instanceof Error ? e.message : String(e));
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
          <div className="gf-wiz-eyebrow">Step {step} of 3</div>
          {step === 1 && (
            <>
              <div className="gf-wiz-title">Find your Slay the Spire 2 install</div>
              <div className="gf-wiz-sub">
                We'll auto-detect via Steam. You can override anytime in Settings.
              </div>
            </>
          )}
          {step === 2 && (
            <>
              <div className="gf-wiz-title">Connect your accounts (optional)</div>
              <div className="gf-wiz-sub">
                Nexus needs an API key for downloads. GitHub auth raises the rate limit.
                Skip both to start with public Browse only.
              </div>
            </>
          )}
          {step === 3 && (
            <>
              <div className="gf-wiz-title">Pick your first profile</div>
              <div className="gf-wiz-sub">
                Start vanilla, follow a friend's pack, or import a JSON. You can always switch.
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
                <div className="gf-wiz-detect-t">Found Slay the Spire 2</div>
                <div className="gf-wiz-detect-s" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {detectedPath}
                </div>
              </div>
              <button className="gf-btn-3 gf-btn-2-sm" onClick={() => { setDetected(false); setGameSub('gameNotFound'); }}>
                Change
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
                  <div className="gf-wiz-detect-t">Couldn't auto-detect Slay the Spire 2</div>
                  <div className="gf-wiz-detect-s">
                    Pick the folder containing{' '}
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
                  {busy ? 'Detecting…' : 'Try again'}
                </button>
              </div>
              <div className="gf-field" style={{ marginTop: 14 }}>
                <label className="gf-field-label">Pick the install folder manually</label>
                <div className="gf-input-row">
                  <input
                    className={`gf-set-input ${pathError ? 'is-err' : ''}`}
                    value={manualPath}
                    onChange={(e) => setManualPath(e.target.value)}
                    placeholder={
                      typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
                        ? '~/Library/Application Support/Steam/steamapps/common/Slay the Spire 2'
                        : typeof navigator !== 'undefined' && /Linux/.test(navigator.platform)
                        ? '~/.steam/steam/steamapps/common/Slay the Spire 2'
                        : 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Slay the Spire 2'
                    }
                  />
                  <button className="gf-btn-3" onClick={handleBrowse} disabled={busy}>
                    <Folder size={12} /> Browse…
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
                <label className="gf-field-label">Nexus Mods API key (recommended)</label>
                <div className="gf-input-row">
                  <input
                    className={`gf-set-input ${nexusOk ? 'is-ok' : keySub === 'keyRejected' ? 'is-err' : ''}`}
                    type="password"
                    value={nexusKey}
                    onChange={(e) => setNexusKey(e.target.value)}
                    placeholder="Paste your Nexus API key"
                  />
                  <button className="gf-btn-3" onClick={handleTestNexus} disabled={keyTesting || !nexusKey.trim()}>
                    {keyTesting ? 'Testing…' : 'Test & save'}
                  </button>
                </div>
                {nexusOk && (
                  <div className="gf-help ok">
                    <Check size={11} /> Saved — Nexus mods will appear in Browse.
                  </div>
                )}
                {keySub === 'keyRejected' && (
                  <div className="gf-help err">
                    <X size={11} /> Nexus rejected this key.{' '}
                    <a href="https://www.nexusmods.com/users/myaccount?tab=api" target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', textDecoration: 'underline' }}>
                      Generate a new one →
                    </a>
                  </div>
                )}
                {!nexusOk && keySub !== 'keyRejected' && (
                  <div className="gf-help muted">Skip if you only use GitHub mods.</div>
                )}
                <div className="gf-help muted" style={{ marginTop: 4, fontSize: 11 }}>
                  Free Nexus account is fine. To install a Nexus mod, you'll
                  click "Slow Download" / "Manual" on Nexus — the app catches
                  the zip from your Downloads folder. (Nexus Premium's
                  instant-download API isn't wired in.)
                </div>
              </div>

              <div className="gf-field">
                <label className="gf-field-label">GitHub token (optional — raises rate limit 60→5000/hr)</label>
                <div className="gf-input-row">
                  <input
                    className={`gf-set-input ${ghSaved ? 'is-ok' : ''}`}
                    type="password"
                    value={ghToken}
                    onChange={(e) => setGhToken(e.target.value)}
                    placeholder="ghp_… (or leave blank)"
                  />
                  <button className="gf-btn-3" onClick={handleSaveGh} disabled={!ghToken.trim()}>
                    <GitBranch size={12} /> Save
                  </button>
                  <button className="gf-btn-3" onClick={handleOpenGithubTokenTemplate}>
                    <ExternalLink size={12} /> Create scoped token
                  </button>
                </div>
                {ghSaved && (
                  <div className="gf-help ok">
                    <Check size={11} /> Saved — Browse will use authenticated calls.
                  </div>
                )}
                {!ghSaved && (
                  <div className="gf-help muted">Skipping is fine — you'll just hit rate limits faster on Browse.</div>
                )}
                {ghOpenError && (
                  <div className="gf-help err">
                    <X size={11} /> Couldn't open GitHub token page: {ghOpenError}
                  </div>
                )}
                <div className="gf-help muted" style={{ marginTop: 4, fontSize: 11 }}>
                  <b>Required to publish modpacks</b> — needs <code>repo</code> scope (classic PAT) or{' '}
                  <code>Contents: R/W</code> + <code>Administration: R/W</code> (fine-grained).
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div style={{ display: 'grid', gap: 8 }}>
              {(
                [
                  ['Vanilla — no mods', 'Game launches stock — toggle mods on later', 'vanilla'],
                  ["Follow a friend (paste code)", 'Type or paste a code like jess/XYZ4', 'follow'],
                  ['Import profile JSON', 'Drop or pick a .json exported from another install', 'json'],
                  ['Skip — set up later', 'You can re-run setup from Settings → General', 'skip'],
                ] as const
              ).map(([t, b, action], i) => (
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
                  <div style={{ fontWeight: 600 }}>{t}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 3 }}>{b}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="gf-wiz-foot">
          <button className="gf-btn-3" onClick={back} disabled={step === 1}>
            Back
          </button>
          <button className="gf-btn-3" onClick={onSkip}>
            Skip setup
          </button>
          <div style={{ flex: 1 }} />
          {step < 3 ? (
            // On step 2, the accounts are optional. If the user hasn't saved
            // either credential, surface the primary action as "Skip" so it's
            // clear they're moving on without entering anything — instead of
            // implying "Next" means saving was already done.
            <button className="gf-btn" onClick={next}>
              {step === 2 && !nexusOk && !ghSaved ? (
                'Skip for now'
              ) : (
                <>Next <ExternalLink size={11} style={{ transform: 'rotate(-45deg)' }} /></>
              )}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
