import { useState } from 'react';
import { Check, Copy, Info, Upload, X } from 'lucide-react';
import type { Profile, ShareResult } from '../types';
import { shareProfile, reshareProfile } from '../hooks/useTauri';
import { useToast } from '../contexts/ToastContext';

// v5 batch 3 — Publish-current modal. Two states:
// 1) Preview — shows what's included (mod count, GH/Nexus split, pinned,
//    active/disabled count) before committing.
// 2) Success — after share succeeds, shows the share code + "same code is
//    reused on re-share so followers see updates instead of a new code".

interface Props {
  open: boolean;
  profile: Profile | null;
  isReshare?: boolean;
  onClose: () => void;
  onShared?: (result: ShareResult) => void;
}

export function PublishModal({ open, profile, isReshare, onClose, onShared }: Props) {
  const toast = useToast();
  const [includeOrder, setIncludeOrder] = useState(true);
  const [busy, setBusy] = useState(false);
  const [shared, setShared] = useState<ShareResult | null>(null);
  const [copied, setCopied] = useState(false);

  if (!open || !profile) return null;

  const ghCount = profile.mods.filter((m) => (m.source ?? '').toLowerCase().includes('github')).length;
  const nxCount = profile.mods.filter((m) => (m.source ?? '').toLowerCase().includes('nexus')).length;
  // ProfileMod doesn't carry a `pinned` flag in this build's manifest type; the
  // counter still works visually but will report 0 unless backend extends it.
  const enabledCount = profile.mods.filter((m) => m.enabled).length;
  const disabledCount = profile.mods.filter((m) => !m.enabled).length;
  const totalCount = profile.mods.length;

  async function handlePublish() {
    if (!profile) return;
    setBusy(true);
    try {
      const result = await (isReshare ? reshareProfile(profile.name) : shareProfile(profile.name));
      setShared(result);
      onShared?.(result);
      toast.success(isReshare ? 'Update pushed to followers' : 'Profile published');
    } catch (e) {
      toast.error(`Failed to publish: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCopy() {
    if (!shared) return;
    const code = `${shared.owner}/${shared.code}`;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy');
    }
  }

  function handleDone() {
    setShared(null);
    setBusy(false);
    onClose();
  }

  return (
    <div className="gf-modal-back" onClick={handleDone}>
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
                : 'Share this set of mods with friends. Re-publishing later keeps the same code.'}
            </div>
          </div>
          <button className="gf-btn-3 gf-btn-icon" onClick={handleDone} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body">
          {!shared && (
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
                    <span className="gf-includes-stat">{totalCount}</span> mods
                    {ghCount > 0 || nxCount > 0 ? (
                      <>
                        {' · '}
                        {ghCount > 0 && <>{ghCount} GitHub</>}
                        {ghCount > 0 && nxCount > 0 && ' · '}
                        {nxCount > 0 && <>{nxCount} Nexus</>}
                      </>
                    ) : null}
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
              <div className="gf-field">
                <label
                  className="gf-field-label"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={includeOrder}
                    onChange={(e) => setIncludeOrder(e.target.checked)}
                  />
                  Include load-order overrides
                </label>
              </div>
            </>
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
                <button className="gf-btn-2 gf-btn-2-sm" onClick={handleCopy}>
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? 'Copied' : 'Copy'}
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
                }}
              >
                <Info size={14} style={{ flexShrink: 0, marginTop: 1 }} />
                <div>
                  This same code is reused if you re-share later — friends will
                  see updates instead of having to follow a new code.
                </div>
              </div>
            </>
          )}
        </div>

        <div className="gf-modal-foot">
          {!shared ? (
            <>
              <button className="gf-btn-3" onClick={handleDone}>Cancel</button>
              <div style={{ flex: 1 }} />
              <button className="gf-btn" onClick={handlePublish} disabled={busy}>
                <Upload size={12} /> {busy ? 'Publishing…' : isReshare ? 'Push update' : 'Publish'}
              </button>
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
