import { useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { AlertTriangle, Check, Copy, ExternalLink, Info, Link as LinkIcon, MessageSquare, Upload, X } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import type { Profile, ShareResult } from '../types';
import { shareProfile, reshareProfile, getApiKeyStatus, setModpackListing, openExternalUrl } from '../hooks/useTauri';
import { useToast } from '../contexts/ToastContext';
import { useClipboard } from '../hooks/useClipboard';
import { buildShareMessage, buildShareLink } from '../lib/shareImport';
import { ShareSetupPanel } from './ShareSetupPanel';
import { MissingBundlesPanel, parseMissingBundlesError } from './MissingBundlesPanel';

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
  const { t } = useTranslation();
  // Shared clipboard hook. PublishModal historically suppressed the
  // success toast (the modal itself shows a clear "Copied" inline
  // state, so an extra toast was overkill) — we preserve that by
  // passing `successMessage: null` in handleCopy below. Reset is
  // slightly longer here (1800ms) because the modal stays open and
  // the user reads the inline state more carefully than a transient
  // chip on a list row.
  const { copy, copied } = useClipboard({ resetMs: 1800 });
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState<ShareResult | null>(null);
  const [tokenSet, setTokenSet] = useState<boolean | null>(null);
  const [progress, setProgress] = useState<ShareProgress | null>(null);
  const [visibility, setVisibility] = useState<'private' | 'public'>('private');
  /**
   * Inline-repair state. Populated when the Rust publish command rejects
   * with the "missing bundles for N mod(s): …" pattern (see Solo's bug
   * report). Renders <MissingBundlesPanel> instead of toasting a raw
   * error string — the curator can repair the bad bundles in-modal and
   * the publish auto-retries.
   */
  const [missingBundles, setMissingBundles] = useState<string[] | null>(null);

  // Refresh token status whenever the modal opens so we don't show stale
  // "token missing" state if the curator just set it in Settings.
  useEffect(() => {
    if (!open) {
      setShared(null);
      setProgress(null);
      setBusy(false);
      setMissingBundles(null);
      return;
    }
    let cancelled = false;
    getApiKeyStatus()
      // uncovered: `cancelled` true-branch fires only if the modal unmounts
      // between this then/catch's scheduling and resolution — a StrictMode-
      // style race that jsdom's single-mount test runner can't reliably hit.
      .then((s) => { if (!cancelled) setTokenSet(s.github_token_set); })
      .catch(() => { if (!cancelled) setTokenSet(false); });
    // Initialize the visibility selector from the profile's current
    // listing state so re-shares pre-select what the curator chose
    // last time. Default for first-time curators is "Friends only".
    setVisibility(profile?.public === true ? 'public' : 'private');
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
  //
  // Counts come from the saved profile manifest. Mod Library edits the
  // manifest as a set of references into the local mod library, and publish
  // must not silently re-add unrelated installed mods from disk.
  const enabledCount = profile.mods.filter((m) => m.enabled).length;
  const disabledCount = profile.mods.filter((m) => !m.enabled).length;
  const totalCount = profile.mods.length;

  async function handlePublish() {
    // uncovered: dead at runtime — line 77 already short-circuits the render
    // when !profile, so the Publish button only exists when profile is truthy.
    if (!profile) return;
    const listPublic = visibility === 'public';
    setBusy(true);
    setProgress({
      profile_name: profile.name,
      stage: 'bundling',
      current: 0,
      total: 0,
      mod_name: null,
    });
    try {
      const result = await (isReshare
        ? reshareProfile(profile.name, listPublic)
        : shareProfile(profile.name, listPublic));
      setShared(result);
      onShared?.(result);

      // Partial-fail toast — curators used to find out about silent mod-
      // upload failures only when a confused friend complained later.
      if (result.failed_uploads && result.failed_uploads.length > 0) {
        const count = result.failed_uploads.length;
        const list = result.failed_uploads.slice(0, 5).join(', ');
        const more = result.failed_uploads.length > 5
          ? t('publish.failedUploadsMore', { count: result.failed_uploads.length - 5 })
          : '';
        toast.error(t('publish.failedUploadsToast', { count, list, more }));
      } else {
        toast.success(isReshare ? t('publish.updatePushedToast') : t('publish.profilePublishedToast'));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Solo bug repro: when the Rust side rejects with "missing bundles
      // for N mod(s): …", swap the raw-error toast for an in-modal
      // recovery panel that repairs the bundles and auto-retries the
      // publish. Other publish failures (network, GitHub API, token)
      // fall through to the normal toast.
      const parsed = parseMissingBundlesError(msg);
      if (parsed && parsed.mods.length > 0) {
        setMissingBundles(parsed.mods);
      } else {
        toast.error(t('publish.publishFailed', { error: msg }));
      }
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  async function handleCopy(kind: 'code' | 'link' | 'msg') {
    // uncovered: Copy buttons only render inside `{shared && (...)}` and after
    // the `!profile` early-return above, so both checks are dead at runtime.
    if (!shared || !profile) return;
    const codeStr = `${shared.owner}/${shared.code}`;
    const text =
      kind === 'code' ? codeStr
      : kind === 'link' ? buildShareLink(codeStr)
      : buildShareMessage(profile.name, codeStr, t);
    // PublishModal historically did NOT toast on success — the inline
    // "Copied" state on the button itself is feedback enough, and a
    // toast on top of an already-open modal felt noisy. The hook
    // honours that via `successMessage: null`.
    await copy(text, kind, {
      successMessage: null,
      failureMessage: 'publish.couldntCopy',
    });
  }

  function handleDone() {
    setShared(null);
    setBusy(false);
    setProgress(null);
    setMissingBundles(null);
    onClose();
  }

  async function openRepo() {
    // uncovered: Open-repo button only renders inside `{shared.repo_url && (...)}`,
    // so this guard is dead at runtime.
    if (!shared?.repo_url) return;
    try { await openExternalUrl(shared.repo_url); }
    catch (e) { toast.error(t('publish.couldntOpenBrowser', { error: e instanceof Error ? e.message : String(e) })); }
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
                  ? t('publish.updatePushed')
                  : t('publish.profilePublished')
                : isReshare
                ? t('publish.reshareTitle', { name: profile.name })
                : t('publish.publishTitle', { name: profile.name })}
            </div>
            <div className="gf-modal-sub">
              {shared
                ? t('publish.sharedSubtitle')
                : isReshare
                ? t('publish.reshareSubtitle')
                : t('publish.publishSubtitle')}
            </div>
          </div>
          <button className="gf-btn-3 gf-btn-icon" onClick={handleDone} disabled={busy} title={t('common.close')}>
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body">
          {/* Solo bug recovery: when the Rust publish rejected with
              "missing bundles for N mod(s)", the user used to see only a
              raw error toast and was left guessing what "Restore or
              reinstall these mods" meant. The inline panel below lists
              the affected mods with per-mod status, repairs them
              sequentially via `repair_mod`, and auto-retries the publish
              on full success. */}
          {missingBundles && missingBundles.length > 0 && (
            <MissingBundlesPanel
              modNames={missingBundles}
              onRetryPublish={async () => {
                setMissingBundles(null);
                await handlePublish();
              }}
              onCancel={handleDone}
            />
          )}

          {/* Pre-flight: token missing — show the inline ShareSetupPanel
              right inside the share modal. It explains in plain language
              WHY GitHub is needed and lets the curator paste a token +
              save without leaving the share flow. After a successful save,
              `onSaved` re-checks the token status; the modal naturally
              transitions to the normal publish-ready render. Curators who
              would still prefer to manage the token from Settings can
              click "Configure later in Settings". */}
          {!missingBundles && blockedByMissingToken && (
            <ShareSetupPanel
              onSaved={async () => {
                try {
                  const status = await getApiKeyStatus();
                  setTokenSet(status.github_token_set);
                } catch {
                  // Ignore — the user can retry. The panel keeps its own
                  // inline error state when set_github_token itself fails;
                  // a status re-check failure here is rare and recoverable.
                }
              }}
              onConfigureLater={() => {
                onGoToSettings?.();
                handleDone();
              }}
            />
          )}

          {!shared && !blockedByMissingToken && !busy && !missingBundles && (
            <>
              <div className="gf-field">
                <label className="gf-field-label">{t('publish.packName')}</label>
                <input
                  className="gf-set-input"
                  defaultValue={profile.name}
                  readOnly
                  style={{ width: '100%' }}
                />
              </div>
              <div className="gf-field">
                <label className="gf-field-label">{t('publish.whatsIncluded')}</label>
                <div className="gf-includes">
                  <div className="gf-includes-row">
                    <span className="gf-includes-stat">{totalCount}</span> {t('publish.modsTotal')}
                  </div>
                  <div className="gf-includes-row">
                    <span className="gf-includes-stat">{enabledCount}</span> {t('publish.activeLabel')}
                    {disabledCount > 0 && (
                      <>
                        {' · '}
                        <span className="gf-includes-stat">{disabledCount}</span> {t('publish.disabledLabel')}
                      </>
                    )}
                  </div>
                  {profile.created_by && (
                    <div className="gf-includes-row">
                      <Trans
                        i18nKey="publish.curatedBy"
                        values={{ name: profile.created_by }}
                        components={{ bold: <b style={{ color: 'var(--ink)' }} /> }}
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Visibility — inline selector (YouTube / Steam Workshop /
                  Thunderstore pattern). Default is "Friends only" so first-
                  time curators don't accidentally publicly list a personal
                  pack. The success view keeps a toggle for last-minute
                  changes of mind. */}
              <div className="gf-field">
                <label className="gf-field-label">{t('publish.visibility')}</label>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <label
                    style={{
                      display: 'flex',
                      gap: 10,
                      alignItems: 'flex-start',
                      padding: '10px 12px',
                      border: `1px solid ${visibility === 'private' ? 'var(--gf-line, var(--indigo-line))' : 'var(--indigo-line)'}`,
                      borderRadius: 7,
                      cursor: 'pointer',
                      background: visibility === 'private' ? 'var(--indigo-elev)' : 'transparent',
                    }}
                  >
                    <input
                      type="radio"
                      name="visibility"
                      checked={visibility === 'private'}
                      onChange={() => setVisibility('private')}
                      style={{ marginTop: 2 }}
                    />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                        {t('publish.friendsOnly')} <span style={{ color: 'var(--ink-mute)', fontWeight: 400 }}>· {t('publish.friendsOnlyDefault')}</span>
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--ink-mute)', lineHeight: 1.5, marginTop: 2 }}>
                        {t('publish.friendsOnlyDesc')}
                      </div>
                    </div>
                  </label>
                  <label
                    style={{
                      display: 'flex',
                      gap: 10,
                      alignItems: 'flex-start',
                      padding: '10px 12px',
                      border: `1px solid ${visibility === 'public' ? 'var(--gf-line, var(--indigo-line))' : 'var(--indigo-line)'}`,
                      borderRadius: 7,
                      cursor: 'pointer',
                      background: visibility === 'public' ? 'var(--indigo-elev)' : 'transparent',
                    }}
                  >
                    <input
                      type="radio"
                      name="visibility"
                      checked={visibility === 'public'}
                      onChange={() => setVisibility('public')}
                      style={{ marginTop: 2 }}
                    />
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
                        {t('publish.public')}
                      </div>
                      <div style={{ fontSize: 12, color: 'var(--ink-mute)', lineHeight: 1.5, marginTop: 2 }}>
                        {t('publish.publicDesc')}
                      </div>
                    </div>
                  </label>
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
                    <Trans i18nKey="publish.publicRepoNote">
                      <b />
                      <code />
                    </Trans>
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
                  ? t('publish.uploadingManifest')
                  : progress?.mod_name
                  ? t('publish.bundlingMod', { current: progress.current, total: progress.total, name: progress.mod_name })
                  : t('publish.preparing')}
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
                <Trans i18nKey="publish.progressNote">
                  <code />
                </Trans>
              </div>
            </div>
          )}

          {shared && (
            <>
              <div className="gf-share-code">
                <div className="gf-share-code-text">
                  <div className="gf-share-code-eyebrow">{t('publish.shareCode')}</div>
                  <div className="gf-share-code-value">
                    {shared.owner}/{shared.code}
                  </div>
                </div>
                <button
                  className="gf-btn-2 gf-btn-2-sm"
                  onClick={() => handleCopy('code')}
                  title={t('publish.copyCodeTitle')}
                >
                  {copied === 'code' ? <Check size={12} /> : <Copy size={12} />}
                  {copied === 'code' ? t('publish.codeCopied') : t('publish.copyCode')}
                </button>
                <button
                  className="gf-btn-2 gf-btn-2-sm"
                  onClick={() => handleCopy('link')}
                  title={t('publish.copyLinkTitle')}
                >
                  {copied === 'link' ? <Check size={12} /> : <LinkIcon size={12} />}
                  {copied === 'link' ? t('publish.linkCopied') : t('publish.copyLink')}
                </button>
                <button
                  className="gf-btn-2 gf-btn-2-sm"
                  onClick={() => handleCopy('msg')}
                  title={t('publish.copyMessageTitle')}
                >
                  {copied === 'msg' ? <Check size={12} /> : <MessageSquare size={12} />}
                  {copied === 'msg' ? t('publish.messageCopied') : t('publish.copyMessage')}
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
                  {t('publish.reuseNote')}
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
                  <ExternalLink size={12} /> {t('publish.openRepo')}
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
                    <b>
                      {t('publish.failedUploadsSummary', { count: shared.failed_uploads.length })}
                    </b>{' '}
                    {shared.failed_uploads.slice(0, 5).join(', ')}
                    {shared.failed_uploads.length > 5 && t('publish.failedUploadsMore', { count: shared.failed_uploads.length - 5 })}.{' '}
                    {t('publish.failedUploadsHelp')}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, fontSize: 12 }}>
                <span style={{ color: 'var(--ink-mute)' }}>{t('publish.listedPublicly')}</span>
                <ListingToggle profileName={profile.name} initial={visibility === 'public'} />
              </div>
            </>
          )}
        </div>

        {/* While the MissingBundlesPanel owns the action surface (Repair /
            Cancel), the normal modal footer must stay out of the way —
            otherwise the curator sees two Cancel buttons and confusing
            disabled-state interactions. */}
        {!missingBundles && (
        <div className="gf-modal-foot">
          {!shared && !busy ? (
            <>
              <button className="gf-btn-3" onClick={handleDone}>{t('common.cancel')}</button>
              <div style={{ flex: 1 }} />
              <button
                className="gf-btn"
                onClick={handlePublish}
                disabled={busy || blockedByMissingToken || tokenSet === null}
              >
                <Upload size={12} /> {isReshare ? t('publish.pushUpdate') : t('common.publish')}
              </button>
            </>
          ) : busy ? (
            <>
              <div style={{ flex: 1 }} />
              <button className="gf-btn-3" disabled>{t('common.publishing')}</button>
            </>
          ) : (
            <>
              <div style={{ flex: 1 }} />
              <button className="gf-btn" onClick={handleDone}>{t('common.done')}</button>
            </>
          )}
        </div>
        )}
      </div>
    </div>
  );
}

function ListingToggle({ profileName, initial }: { profileName: string; initial: boolean }) {
  const toast = useToast();
  const { t } = useTranslation();
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function flip() {
    if (busy) return;
    const next = !on;
    setBusy(true);
    try {
      await setModpackListing(profileName, next);
      setOn(next);
      toast.success(next ? t('publish.listedToast') : t('publish.hiddenToast'));
    } catch (e) {
      toast.error(t('publish.listingFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }
  return (
    <button className="gf-btn-3" onClick={flip} disabled={busy}>
      {on ? t('common.yes') : t('common.no')}
    </button>
  );
}
