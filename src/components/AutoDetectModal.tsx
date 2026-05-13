import { useEffect, useState } from 'react';
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
}

export function AutoDetectModal({ open, onClose, onApplied }: Props) {
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
    autoDetectSources()
      .then(setResult)
      .catch((e) => toast.error(`Auto-detect failed: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => setScanning(false));
  }, [open]);

  if (!open) return null;

  const matched = result?.matched ?? [];
  const unmatched = result?.unmatched ?? [];

  // Categorise matches by confidence (high / low). Auto-detect returns a
  // single confidence string per match; we treat anything not "high" as
  // ambiguous.
  const high = matched.filter((m) => m.confidence === 'high');
  const ambiguous = matched.filter((m) => m.confidence !== 'high');

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
    if (fail === 0) toast.success(`Linked ${ok} mod${ok === 1 ? '' : 's'} to GitHub sources`);
    else toast.info(`${ok} linked · ${fail} failed`);
    onApplied();
    onClose();
  }

  return (
    <div className="gf-modal-back" onClick={onClose}>
      <div className="gf-modal" style={{ width: 640 }} onClick={(e) => e.stopPropagation()}>
        <div className="gf-modal-head">
          <div>
            <div className="gf-modal-title">Auto-detect sources</div>
            <div className="gf-modal-sub">
              Scan installed mods against GitHub by name. Review matches before
              applying — high-confidence matches are pre-selected.
            </div>
          </div>
          <button className="gf-btn-3 gf-btn-icon" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body">
          {scanning ? (
            <div style={{ padding: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, color: 'var(--ink-mute)' }}>
              <RefreshCw size={14} className="animate-spin" />
              Scanning…
            </div>
          ) : !result ? (
            <div style={{ padding: 18, color: 'var(--ink-mute)' }}>No result.</div>
          ) : matched.length === 0 && unmatched.length === 0 ? (
            // Nothing scanned. Either there are no mods installed, or every
            // installed mod already has a GitHub or Nexus source attached
            // (auto-detect skips those by design — we don't overwrite a
            // deliberate user choice). Spell that out so the user doesn't
            // see three confusing zero badges with no context.
            <div style={{ padding: 22 }}>
              {result.skipped_already_linked && result.skipped_already_linked > 0 ? (
                <>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>
                    Nothing to detect — every mod already has a source.
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--ink-mute)', lineHeight: 1.55 }}>
                    All {result.skipped_already_linked} installed mod
                    {result.skipped_already_linked === 1 ? ' has' : 's have'} a GitHub or Nexus link
                    attached, so auto-detect left them alone. To re-link a specific mod manually,
                    open the Mods view, expand the row, and edit its source.
                  </div>
                </>
              ) : (
                <>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--ink)', marginBottom: 6 }}>
                    No mods to scan.
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--ink-mute)' }}>
                    Install some mods first.
                  </div>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="gf-detect-stats">
                <div className="gf-detect-stat ok">
                  {high.length}
                  <span>matched</span>
                </div>
                <div className="gf-detect-stat warn">
                  {ambiguous.length}
                  <span>ambiguous</span>
                </div>
                <div className="gf-detect-stat err">
                  {unmatched.length}
                  <span>no match</span>
                </div>
              </div>
              {result.skipped_already_linked && result.skipped_already_linked > 0 && (
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--ink-dim)' }}>
                  {result.skipped_already_linked} mod{result.skipped_already_linked === 1 ? '' : 's'}{' '}
                  skipped — already linked.
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
                        {isSkipped ? 'skip' : 'link'}
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
                    <span className="gf-detect-match">no candidates</span>
                    <span style={{ fontSize: 10.5, color: 'oklch(0.82 0.16 25)' }}>—</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={onClose}>Cancel</button>
          <div style={{ flex: 1 }} />
          {willApply.length > 0 && (
            <button className="gf-btn" onClick={handleApply} disabled={applying}>
              {applying ? 'Applying…' : `Apply ${willApply.length} match${willApply.length === 1 ? '' : 'es'}`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
