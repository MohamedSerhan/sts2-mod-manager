import { useState } from 'react';
import { Check, Download, Folder, X } from 'lucide-react';
import { useToast } from '../contexts/ToastContext';
import { useApp } from '../contexts/AppContext';
import { readLogTail, getLogPath } from '../hooks/useTauri';

// v5 batch 4 — diagnostic bundle. Builds a self-contained text report from
// recent logs + game info + active profile + mod list, copies it to the
// clipboard (and offers to open the log folder so the user can attach the
// full file). No upload — user controls where it goes.

interface Props {
  open: boolean;
  onClose: () => void;
}

export function DiagnosticBundle({ open, onClose }: Props) {
  const toast = useToast();
  const { gameInfo, mods, activeProfile } = useApp();
  const [redactPaths, setRedactPaths] = useState(true);
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);

  if (!open) return null;

  function redact(s: string): string {
    if (!redactPaths) return s;
    // Replace any C:\Users\<name>\… with C:\Users\<redacted>\…
    return s
      .replace(/([A-Za-z]:\\Users\\)([^\\\s]+)/g, '$1<redacted>')
      .replace(/(\/Users\/)([^/\s]+)/g, '$1<redacted>')
      .replace(/(\/home\/)([^/\s]+)/g, '$1<redacted>');
  }

  async function generate() {
    if (busy) return;
    setBusy(true);
    try {
      const logs = await readLogTail(500).catch(() => '');
      const logPath = await getLogPath().catch(() => '<unknown>');
      const platform = typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';

      const report = [
        '=== STS2 Mod Manager — Support Bundle ===',
        `Generated: ${new Date().toISOString()}`,
        `Platform: ${platform}`,
        '',
        '--- Game ---',
        `Path: ${redact(gameInfo?.game_path || '<not set>')}`,
        `Valid: ${gameInfo?.valid ?? false}`,
        `Mods on disk: ${gameInfo?.mods_count ?? 0} (${gameInfo?.disabled_count ?? 0} disabled)`,
        '',
        '--- Active profile ---',
        `Name: ${activeProfile || 'Vanilla'}`,
        '',
        '--- Installed mods ---',
        ...mods.map((m) => `  ${m.enabled ? '✓' : '✗'} ${m.name} ${m.version}${m.pinned ? ' [pinned]' : ''}${m.github_url ? ` <${m.github_url}>` : ''}${m.nexus_url ? ` <${m.nexus_url}>` : ''}`),
        '',
        '--- Log tail (last 500 lines) ---',
        `Source: ${redact(logPath)}`,
        '',
        redact(logs || '<log empty>'),
      ].join('\n');

      setGenerated(report);
      try {
        await navigator.clipboard.writeText(report);
        toast.success('Diagnostic bundle copied to clipboard');
      } catch {
        toast.info('Bundle ready — scroll the preview to copy manually.');
      }
    } catch (e) {
      toast.error(`Couldn't build bundle: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function openInBrowser() {
    if (!generated) return;
    const body = encodeURIComponent(generated.slice(0, 6000));
    const title = encodeURIComponent('Bug report from STS2 Mod Manager');
    window.open(`https://github.com/MohamedSerhan/sts2-mod-manager/issues/new?title=${title}&body=${body}`, '_blank');
  }

  return (
    <div className="gf-modal-back" onClick={onClose}>
      <div className="gf-modal" style={{ width: 600 }} onClick={(e) => e.stopPropagation()}>
        <div className="gf-modal-head">
          <div>
            <div className="gf-modal-title">Generate support bundle</div>
            <div className="gf-modal-sub">
              Builds a single text report — game info, active profile, mod list, and recent logs.
              Nothing is uploaded; the bundle is copied to your clipboard so you can paste it wherever.
            </div>
          </div>
          <button className="gf-btn-3 gf-btn-icon" onClick={onClose} title="Close">
            <X size={14} />
          </button>
        </div>
        <div className="gf-modal-body">
          <div className="gf-diag-list">
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>Recent logs</b>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>last 500 lines</span>
            </div>
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>Active profile</b>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>{activeProfile || 'Vanilla'}</span>
            </div>
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>Mod list</b>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>{mods.length} entries</span>
            </div>
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>Game info</b>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>
                {gameInfo?.valid ? 'valid' : 'not detected'}
              </span>
            </div>
            <div className="gf-diag-item">
              <span style={{ color: 'var(--ink-mute)' }}>—</span>
              <span>API keys</span>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>excluded</span>
            </div>
          </div>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 12,
              fontSize: 12,
              color: 'var(--ink-mute)',
            }}
          >
            <input
              type="checkbox"
              checked={redactPaths}
              onChange={(e) => setRedactPaths(e.target.checked)}
            />
            Redact home-folder paths and usernames
          </label>

          {generated && (
            <textarea
              readOnly
              value={generated}
              style={{
                marginTop: 12,
                width: '100%',
                height: 180,
                fontFamily: 'ui-monospace, "JetBrains Mono", Menlo, monospace',
                fontSize: 11,
                background: 'var(--indigo-deep)',
                color: 'var(--ink)',
                border: '1px solid var(--indigo-line)',
                borderRadius: 7,
                padding: 9,
                resize: 'vertical',
              }}
            />
          )}
        </div>
        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={onClose}>Close</button>
          <div style={{ flex: 1 }} />
          {generated && (
            <button className="gf-btn-2" onClick={openInBrowser}>
              <Folder size={12} /> Open GitHub issue
            </button>
          )}
          <button className="gf-btn" onClick={generate} disabled={busy}>
            <Download size={12} /> {busy ? 'Generating…' : generated ? 'Re-generate' : 'Generate bundle'}
          </button>
        </div>
      </div>
    </div>
  );
}
