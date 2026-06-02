import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw, X } from 'lucide-react';
import { autoDetectSources, setModSource } from '../hooks/useTauri';
import { useToast } from '../contexts/ToastContext';
import type { AutoDetectResult, AutoDetectMatch } from '../types';

// v5 batch 3 — Auto-detect sources modal. Scans installed mods against
// GitHub by name; user reviews matched / ambiguous / no-match before
// applying.

interface Props {
  open: boolean;
  onClose: () => void;
  onApplied: () => void;
  focusMod?: string | null;
}

export function AutoDetectModal({ open, onClose, onApplied, focusMod }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const [scanning, setScanning] = useState(false);
  const [result, setResult] = useState<AutoDetectResult | null>(null);
  const [applying, setApplying] = useState(false);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setScanning(true);
    setResult(null);
    setSkipped(new Set());
    autoDetectSources(focusMod ?? undefined)
      .then(setResult)
      .catch((e) => toast.error(t('autoDetect.scanFailed', { error: e instanceof Error ? e.message : String(e) })))
      .finally(() => setScanning(false));
  }, [open, focusMod]);

  if (!open) return null;

  const matched = result?.matched ?? [];
  const unmatched = result?.unmatched ?? [];
  const notChecked = result?.not_checked ?? [];
  const isRateLimited = result?.rate_limited === true;

  // Categorise matches by confidence (high / low). Auto-detect returns a
  // single confidence string per match; we treat anything not "high" as
  // ambiguous.
  const high = matched.filter((m) => m.confidence === 'high');
  const ambiguous = matched.filter((m) => m.confidence !== 'high');

  // Compute a human-readable "try again in N minutes" hint when we have a
  // reset timestamp.
  const resetMinutes: number | null = (() => {
    if (!result?.rate_limit_reset_at) return null;
    const secsAway = result.rate_limit_reset_at - Math.floor(Date.now() / 1000);
    if (secsAway <= 0) return null;
    return Math.ceil(secsAway / 60);
  })();

  const willApply = high.filter((m) => !skipped.has(m.mod_name));

  function toggleSkip(name: string) {
    setSkipped((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function handleApply() {
    // uncovered: render guard at line 197 (`{willApply.length > 0 && ...}`) keeps the
    // Apply button out of the DOM when willApply is empty, so this defensive early-exit
    // is unreachable from user interaction.
    if (willApply.length === 0) return;
    setApplying(true);
    let ok = 0;
    let fail = 0;
    for (const m of willApply) {
      try {
        await setModSource(m.mod_name, `github:${m.github_repo}`);
        ok++;
      } catch {
        fail++;
      }
    }
    setApplying(false);
    if (fail === 0) toast.success(t('autoDetect.linkedSuccess', { count: ok }));
    else toast.info(t('autoDetect.linkedPartial', { ok, fail }));
    onApplied();
    onClose();
  }

  return (
    <div className="gf-modal-back" onClick={onClose}>
      <div className="gf-modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="gf-modal-head">
          <div>
            <div className="gf-modal-title">
              {focusMod ? t('autoDetect.scopedTitle', { name: focusMod }) : t('autoDetect.title')}
            </div>
            <div className="gf-modal-sub">
              {t('autoDetect.subtitle')}
            </div>
          </div>
          <button className="gf-btn-3 gf-btn-icon" onClick={onClose} title={t('common.close')}>
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body">
          {scanning ? (
            <div style={{ padding: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--ink-mute)' }}>
              <RefreshCw size={14} className="animate-spin" />
              {t('autoDetect.scanning')}
            </div>
          ) : !result ? (
            <div style={{ padding: 18, color: 'var(--ink-mute)' }}>{t('autoDetect.noResult')}</div>
          ) : matched.length === 0 && unmatched.length === 0 && notChecked.length === 0 ? (
            // Nothing scanned. Either there are no mods installed, or every
            // installed mod already has a GitHub or Nexus source attached
            // (auto-detect skips those by design — we don't overwrite a
            // deliberate user choice). Spell that out so the user doesn't
            // see three confusing zero badges with no context.
            <div style={{ padding: 22 }}>
              {isRateLimited && (
                <div
                  role="alert"
                  style={{
                    marginBottom: 14,
                    padding: '10px 14px',
                    background: 'oklch(0.25 0.08 25 / 0.18)',
                    border: '1px solid oklch(0.55 0.16 25 / 0.45)',
                    borderRadius: 6,
                    fontSize: 12.5,
                    color: 'oklch(0.82 0.12 25)',
                    lineHeight: 1.55,
                  }}
                >
                  {t('autoDetect.rateLimitedBanner', {
                    context: result.authenticated ? 'auth' : 'unauth',
                    minutes: resetMinutes ?? '?',
                  })}
                </div>
              )}
              {result.skipped_already_linked && result.skipped_already_linked > 0 ? (
                <>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>
                    {t('autoDetect.allLinkedTitle')}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--ink-mute)', lineHeight: 1.55 }}>
                    {t('autoDetect.allLinkedBody', { count: result.skipped_already_linked })}
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>
                    {t('autoDetect.noModsTitle')}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--ink-mute)' }}>
                    {t('autoDetect.noModsBody')}
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              {/* Rate-limited banner — shown prominently above results so the
                  user understands why some mods show "not checked" instead of
                  a real result. Must NOT be mistaken for "no candidates". */}
              {isRateLimited && (
                <div
                  role="alert"
                  style={{
                    margin: '0 0 10px',
                    padding: '10px 14px',
                    background: 'oklch(0.25 0.08 25 / 0.18)',
                    border: '1px solid oklch(0.55 0.16 25 / 0.45)',
                    borderRadius: 6,
                    fontSize: 12.5,
                    color: 'oklch(0.82 0.12 25)',
                    lineHeight: 1.55,
                  }}
                >
                  {t('autoDetect.rateLimitedBanner', {
                    context: result.authenticated ? 'auth' : 'unauth',
                    minutes: resetMinutes ?? '?',
                  })}
                </div>
              )}
              <div className="gf-detect-stats">
                <div className="gf-detect-stat ok">
                  {high.length}
                  <span>{t('autoDetect.matched')}</span>
                </div>
                <div className="gf-detect-stat warn">
                  {ambiguous.length}
                  <span>{t('autoDetect.ambiguous')}</span>
                </div>
                <div className="gf-detect-stat err">
                  {unmatched.length}
                  <span>{t('autoDetect.noMatch')}</span>
                </div>
                {notChecked.length > 0 && (
                  <div className="gf-detect-stat" style={{ color: 'var(--ink-dim)' }}>
                    {notChecked.length}
                    <span>{t('autoDetect.notChecked')}</span>
                  </div>
                )}
              </div>
              {result.skipped_already_linked && result.skipped_already_linked > 0 && (
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--ink-dim)' }}>
                  {t('autoDetect.skippedAlreadyLinked', { count: result.skipped_already_linked })}
                </div>
              )}

              <div className="gf-detect-list" style={{ maxHeight: 320, overflowY: 'auto' }}>
                {high.map((m: AutoDetectMatch) => {
                  const isSkipped = skipped.has(m.mod_name);
                  return (
                    <div
                      key={m.mod_name}
                      className="gf-detect-row"
                      style={{ opacity: isSkipped ? 0.5 : 1, cursor: 'pointer' }}
                      onClick={() => toggleSkip(m.mod_name)}
                    >
                      <span className="gf-detect-led" />
                      <span className="gf-detect-name">{m.mod_name}</span>
                      <span className="gf-detect-match">{m.github_repo}</span>
                      <span style={{ fontSize: 10.5, color: 'var(--ink-dim)' }}>
                        {isSkipped ? t('autoDetect.skip') : t('autoDetect.link')}
                      </span>
                    </div>
                  );
                })}
                {ambiguous.map((m: AutoDetectMatch) => (
                  <div key={m.mod_name} className="gf-detect-row gf-detect-warn">
                    <span className="gf-detect-led" />
                    <span className="gf-detect-name">{m.mod_name}</span>
                    <span className="gf-detect-match">{m.github_repo}</span>
                    <span style={{ fontSize: 10.5, color: 'oklch(0.85 0.14 70)' }}>{m.confidence}</span>
                  </div>
                ))}
                {unmatched.map((name) => (
                  <div key={name} className="gf-detect-row gf-detect-err">
                    <span className="gf-detect-led" />
                    <span className="gf-detect-name">{name}</span>
                    <span className="gf-detect-match">{t('autoDetect.noCandidates')}</span>
                    <span style={{ fontSize: 10.5, color: 'oklch(0.82 0.16 25)' }}>—</span>
                  </div>
                ))}
                {notChecked.map((name) => (
                  <div key={name} className="gf-detect-row" style={{ opacity: 0.55 }}>
                    <span className="gf-detect-led" />
                    <span className="gf-detect-name">{name}</span>
                    <span className="gf-detect-match" style={{ color: 'var(--ink-dim)', fontStyle: 'italic' }}>
                      {t('autoDetect.notCheckedLabel')}
                    </span>
                    <span style={{ fontSize: 10.5, color: 'var(--ink-dim)' }}>—</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={onClose}>{t('common.cancel')}</button>
          <div style={{ flex: 1 }} />
          {willApply.length > 0 && (
            <button className="gf-btn" onClick={handleApply} disabled={applying}>
              {applying ? t('common.applying') : t('autoDetect.applyingMatches', { count: willApply.length })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
