import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, ExternalLink, Info, Upload, X } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { Profile, ShareResult } from '../types';
import { shareProfile, reshareProfile, getApiKeyStatus } from '../hooks/useTauri';
import { useToast } from '../contexts/ToastContext';
import { buildShareMessage } from '../lib/shareImport';

// Publish-current modal. Three states:
//   1) Pre-flight    — show what's included AND any blockers (missing
//      GitHub token, etc.) BEFORE the upload starts.
//   2) Progress      — live "Bundling mod 5 of 20…" updates from the
//      Rust side so a multi-minute publish doesn't look like a hang.
//   3) Success       — share code + sts2mm:// quick-share line +
//      link to the auto-created `sts2mm-profiles` repo + warning
//      about any mods that failed to upload.

interface Props {
  open: boolean;
  profile: Profile | null;
  isReshare?: boolean;
  onClose: () => void;
  onShared?: (result: ShareResult) => void;
  /** Called when the user clicks the "Open Settings" CTA on the missing-
   *  token pre-flight error. Parent navigates to Settings → Accounts so
   *  the curator doesn't have to figure out where the token field lives. */
  onGoToSettings?: () => void;
}

interface ShareProgress {
  profile_name: string;
  stage: 'bundling' | 'uploading-manifest' | 'done';
  current: number;
  total: number;
  mod_name: string | null;
}

export function PublishModal({ open, profile, isReshare, onClose, onShared, onGoToSettings }: Props) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState<ShareResult | null>(null);
  const [copied, setCopied] = useState<'code' | 'msg' | null>(null);
  const [tokenSet, setTokenSet] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<ShareProgress | null>(null);

  // Refresh token status whenever the modal opens so we don't show stale
  // "token missing" state if the curator just set it in Settings.
  useEffect(() => {
    if (!open) {
      setShared(null);
      setProgress(null);
      setBusy(false);
      return;
    }
    let cancelled = false;
    getApiKeyStatus()
      .then((s) => { if (!cancelled) setTokenSet(s.github_token_set); })
      .catch(() => { if (!cancelled) setTokenSet(false); });
    return () => { cancelled = true; };
  }, [open]);

  // Live progress from the Rust publish loop. Cleared on stage=done; the
  // success state takes over from there.
  useEffect(() => {
    if (!busy) return;
    const unlisten = listen<ShareProgress>('share-progress', (event) => {
      if (event.payload.stage === 'done') {
        setProgress(null);
      } else {
        setProgress(event.payload);
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, [busy]);

  if (!open || !profile) return null;

  // The unreliable GH/Nexus counter was removed: a mod can be bundled
  // without any `source` string, which used to make the modal say
  // "20 mods · 0 GitHub · 0 Nexus" and confuse first-time curators.
  // The honest summary is just total + enabled split.
  const enabledCount = profile.mods.filter((m) => m.enabled).length;
  const disabledCount = profile.mods.filter((m) => !m.enabled).length;
  const totalCount = profile.mods.length;

  async function handlePublish() {
    if (!profile) return;
    setBusy(true);
    setProgress({
      profile_name: profile.name,
      stage: 'bundling',
      current: 0,
      total: 0,
      mod_name: null,
    });
    try {
      const result = await (isReshare ? reshareProfile(profile.name) : shareProfile(profile.name));
      setShared(result);
      onShared?.(result);

      // Partial-fail toast — curators used to find out about silent mod-
      // upload failures only when a confused friend complained later.
      if (result.failed_uploads && result.failed_uploads.length > 0) {
        const list = result.failed_uploads.slice(0, 5).join(', ');
        const more = result.failed_uploads.length > 5
          ? `, +${result.failed_uploads.length - 5} more`
          : '';
        toast.error(
          `${result.failed_uploads.length} mod${result.failed_uploads.length === 1 ? '' : 's'} failed to upload: ${list}${more}. Friends installing this code will see "missing mod" for these — try re-publishing.`,
        );
      } else {
        toast.success(isReshare ? 'Update pushed to followers' : 'Profile published');
      }
    } catch (e) {
      toast.error(`Failed to publish: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function handleCopy(kind: 'code' | 'msg') {
    if (!shared || !profile) return;
    const codeStr = `${shared.owner}/${shared.code}`;
    const text = kind === 'code' ? codeStr : buildShareMessage(profile.name, codeStr);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1800);
    } catch {
      toast.error('Could not copy to clipboard');
    }
  }

  function handleDone() {
    setShared(null);
    setBusy(false);
    setProgress(null);
    onClose();
  }

  async function openRepo() {
    if (!shared?.repo_url) return;
    try { await openUrl(shared.repo_url); }
    catch (e) { toast.error(`Couldn't open browser: ${e instanceof Error ? e.message : String(e)}`); }
  }

  // Pre-flight error: GitHub token not set. We block publishing rather
  // than letting the curator click through to a raw error toast.
  const blockedByMissingToken = tokenSet === false && !shared && !busy;

  return (
    <div className="gf-modal-back" onClick={busy ? undefined : handleDone}>
      <div className="gf-modal" style={{ width: 560 }} onClick={(e) => e.stopPropagation()}>
        <div className="gf-modal-head">
          <div>
            <div className="gf-modal-title">
              {shared
                ? isReshare
                  ? 'Update pushed'
                  : 'Profile published'
                : isReshare
                ? `Re-share ${profile.name}?`
                : `Publish ${profile.name}`}
            </div>
            <div className="gf-modal-sub">
              {shared
                ? 'Anyone with the code can install this exact set of mods.'
                : isReshare
                ? "Same code — followers will see an update prompt next time they open the app."
                : 'Uploads your mod files to a GitHub repo on your account so friends can install them.'}
            </div>
          </div>
          <button className="gf-btn-3 gf-btn-icon" onClick={handleDone} disabled={busy} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body">
          {/* Pre-flight: token missing — block the publish click and
              point the user at Settings instead of letting them hit
              a raw error toast. */}
          {blockedByMissingToken && (
            <div
              style={{
                background: 'oklch(0.55 0.13 25 / 0.10)',
                border: '1px solid oklch(0.55 0.13 25 / 0.35)',
                borderRadius: 8,
                padding: '12px 14px',
                marginBottom: 14,
                display: 'flex',
                gap: 10,
                alignItems: 'flex-start',
              }}
            >
              <AlertTriangle size={16} style={{ color: 'oklch(0.78 0.16 25)', marginTop: 1, flexShrink: 0 }} />
              <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.55 }}>
                <div style={{ fontWeight: 600, color: 'var(--ink)', marginBottom: 4 }}>
                  GitHub token required
                </div>
                <div style={{ color: 'var(--ink-mute)' }}>
                  Publishing uploads your mod files to a GitHub repo on your account, so the manager needs
                  a personal access token with <code>repo</code> scope (or, for fine-grained tokens,
                  <code> Contents: R/W</code> + <code>Administration: R/W</code>).
                </div>
                {onGoToSettings && (
                  <button
                    className="gf-btn-2 gf-btn-2-sm"
                    style={{ marginTop: 10 }}
                    onClick={() => { onGoToSettings(); handleDone(); }}
                  >
                    Open Settings → Accounts
                  </button>
                )}
              </div>
            </div>
          )}

          {!shared && !blockedByMissingToken && !busy && (
            <>
              <div className="gf-field">
                <label className="gf-field-label">Pack name</label>
                <input
                  className="gf-set-input"
                  defaultValue={profile.name}
                  readOnly
                  style={{ width: '100%' }}
                />
              </div>
              <div className="gf-field">
                <label className="gf-field-label">What's included</label>
                <div className="gf-includes">
                  <div className="gf-includes-row">
                    <span className="gf-includes-stat">{totalCount}</span> mods total
                  </div>
                  <div className="gf-includes-row">
                    <span className="gf-includes-stat">{enabledCount}</span> active
                    {disabledCount > 0 && (
                      <>
                        {' · '}
                        <span className="gf-includes-stat">{disabledCount}</span> disabled (will be excluded)
                      </>
                    )}
                  </div>
                  {profile.created_by && (
                    <div className="gf-includes-row">
                      curated by <b style={{ color: 'var(--ink)' }}>{profile.created_by}</b>
                    </div>
                  )}
                </div>
              </div>

              {/* Consent — first-time curators get a public repo on
                  their GitHub profile without ever being told. Tell
                  them up front, just once (re-shares skip this since
                  the repo already exists). */}
              {!isReshare && (
                <div
                  style={{
                    background: 'oklch(0.55 0.13 250 / 0.10)',
                    border: '1px solid oklch(0.55 0.13 250 / 0.3)',
                    borderRadius: 7,
                    padding: '10px 12px',
                    fontSize: 12,
                    color: 'oklch(0.85 0.07 250)',
                    display: 'flex',
                    gap: 9,
                  }}
                >
                  <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <div>
                    The manager will create a <b>public</b> repo called <code>sts2mm-profiles</code> on
                    your GitHub account (if you don't already have one) to hold your published packs +
                    mod bundles. You can re-publish updates later to the same code; you can also delete
                    or make it private on GitHub at any time.
                  </div>
                </div>
              )}
            </>
          )}

          {/* Progress state — visible during the publish run. */}
          {busy && (
            <div style={{ padding: '4px 2px' }}>
              <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--ink)' }}>
                {progress?.stage === 'uploading-manifest'
                  ? 'Uploading profile manifest…'
                  : progress?.mod_name
                  ? `Bundling mod ${progress.current} of ${progress.total}: ${progress.mod_name}`
                  : 'Preparing…'}
              </div>
              {progress?.total && progress.total > 0 && progress.stage === 'bundling' && (
                <div
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
                      width: `${Math.min(100, Math.round((progress.current / progress.total) * 100))}%`,
                      height: '100%',
                      background: 'var(--gf)',
                      transition: 'width 200ms ease',
                    }}
                  />
                </div>
              )}
              <div style={{ fontSize: 11.5, color: 'var(--ink-dim)' }}>
                This can take a minute or two for big packs — your mod files are being zipped + uploaded
                to your <code>sts2mm-profiles</code> repo one at a time. Don't close the window.
              </div>
            </div>
          )}

          {shared && (
            <>
              <div className="gf-share-code">
                <div className="gf-share-code-text">
                  <div className="gf-share-code-eyebrow">Share code</div>
                  <div className="gf-share-code-value">
                    {shared.owner}/{shared.code}
                  </div>
                </div>
                <button className="gf-btn-2 gf-btn-2-sm" onClick={() => handleCopy('code')}>
                  {copied === 'code' ? <Check size={12} /> : <Copy size={12} />}
                  {copied === 'code' ? 'Copied' : 'Copy'}
                </button>
                <button
                  className="gf-btn-2 gf-btn-2-sm"
                  onClick={() => handleCopy('msg')}
                  title="Copy a paste-ready share message with the sts2mm:// one-click link + install instructions"
                >
                  {copied === 'msg' ? <Check size={12} /> : <Copy size={12} />}
                  {copied === 'msg' ? 'Copied' : 'Copy message'}
                </button>
              </div>

              <div
                style={{
                  background: 'oklch(0.55 0.13 250 / 0.10)',
                  border: '1px solid oklch(0.55 0.13 250 / 0.3)',
                  borderRadius: 7,
                  padding: '10px 12px',
                  fontSize: 12,
                  color: 'oklch(0.85 0.07 250)',
                  display: 'flex',
                  gap: 9,
                  marginTop: 10,
                }}
              >
                <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  This same code is reused if you re-share later — friends will see updates instead of
                  having to follow a new code.
                </div>
              </div>

              {shared.repo_url && (
                <button
                  type="button"
                  className="gf-btn-3"
                  onClick={openRepo}
                  style={{
                    marginTop: 10,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    fontSize: 12,
                  }}
                  title={shared.repo_url}
                >
                  <ExternalLink size={12} /> Open my profiles repo on GitHub
                </button>
              )}

              {shared.failed_uploads && shared.failed_uploads.length > 0 && (
                <div
                  style={{
                    background: 'oklch(0.55 0.13 25 / 0.10)',
                    border: '1px solid oklch(0.55 0.13 25 / 0.35)',
                    borderRadius: 7,
                    padding: '10px 12px',
                    fontSize: 12,
                    color: 'oklch(0.86 0.10 25)',
                    display: 'flex',
                    gap: 9,
                    marginTop: 10,
                  }}
                >
                  <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                  <div>
                    <b>{shared.failed_uploads.length} mod{shared.failed_uploads.length === 1 ? '' : 's'} failed to upload:</b>{' '}
                    {shared.failed_uploads.slice(0, 5).join(', ')}
                    {shared.failed_uploads.length > 5 && `, +${shared.failed_uploads.length - 5} more`}.{' '}
                    Friends installing this code will see "missing mod" for these — re-publish to retry.
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="gf-modal-foot">
          {!shared && !busy ? (
            <>
              <button className="gf-btn-3" onClick={handleDone}>Cancel</button>
              <div style={{ flex: 1 }} />
              <button
                className="gf-btn"
                onClick={handlePublish}
                disabled={busy || blockedByMissingToken || tokenSet === null}
              >
                <Upload size={12} /> {isReshare ? 'Push update' : 'Publish'}
              </button>
            </>
          ) : busy ? (
            <>
              <div style={{ flex: 1 }} />
              <button className="gf-btn-3" disabled>Publishing…</button>
            </>
          ) : (
            <>
              <div style={{ flex: 1 }} />
              <button className="gf-btn" onClick={handleDone}>Done</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
