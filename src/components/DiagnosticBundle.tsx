import { useState } from 'react';
import { Check, Download, Folder, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../contexts/ToastContext';
import { useApp } from '../contexts/AppContext';
import { readLogTail, getLogPath, openExternalUrl } from '../hooks/useTauri';
import { buildGitHubIssueUrl } from '../lib/githubLinks';

// v5 batch 4 — diagnostic bundle. Builds a self-contained text report from
// recent logs + game info + active profile + mod list, copies it to the
// clipboard (and offers to open the log folder so the user can attach the
// full file). No upload — user controls where it goes.

interface Props {
  open: boolean;
  onClose: () => void;
}

export function DiagnosticBundle({ open, onClose }: Props) {
  const { t } = useTranslation();
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
    // uncovered: Defensive re-entrancy guard. The only caller is the
    // "Generate bundle" button at the bottom of the modal, which sets
    // `disabled={busy}` (see the JSX below) — React refuses to
    // dispatch onClick to disabled buttons, so this branch is
    // unreachable from the UI.
    /* v8 ignore start */
    if (busy) return;
    /* v8 ignore stop */
    setBusy(true);
    try {
      const logs = await readLogTail(500).catch(() => '');
      const logPath = await getLogPath().catch(() => '<unknown>');
      // uncovered (false branch): jsdom and every supported browser
      // define `navigator`. The `'unknown'` fallback exists to keep
      // tsc honest for non-browser hosts.
      const platform = /* v8 ignore next */ typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';

      const report = [
        t('diagnosticBundle.reportHeader'),
        t('diagnosticBundle.reportGenerated', { date: new Date().toISOString() }),
        t('diagnosticBundle.reportPlatform', { platform }),
        '',
        t('diagnosticBundle.reportGameSection'),
        t('diagnosticBundle.reportPath', { path: redact(gameInfo?.game_path || '<not set>') }),
        t('diagnosticBundle.reportValid', { valid: String(gameInfo?.valid ?? false) }),
        t('diagnosticBundle.reportModsOnDisk', { total: gameInfo?.mods_count ?? 0, disabled: gameInfo?.disabled_count ?? 0 }),
        '',
        t('diagnosticBundle.reportActiveProfileSection'),
        t('diagnosticBundle.reportProfileName', { name: activeProfile || 'Vanilla' }),
        '',
        t('diagnosticBundle.reportInstalledModsSection'),
        ...mods.map((m) => `  ${m.enabled ? '✓' : '✗'} ${m.name} ${m.version}${m.pinned ? ' [pinned]' : ''}${m.github_url ? ` <${m.github_url}>` : ''}${m.nexus_url ? ` <${m.nexus_url}>` : ''}`),
        '',
        t('diagnosticBundle.reportLogTailSection'),
        t('diagnosticBundle.reportLogSource', { path: redact(logPath) }),
        '',
        redact(logs || t('diagnosticBundle.reportLogEmpty')),
      ].join('\n');

      setGenerated(report);
      try {
        await navigator.clipboard.writeText(report);
        toast.success(t('diagnosticBundle.copiedToast'));
      } catch {
        toast.info(t('diagnosticBundle.readyToast'));
      }
    } catch (e) {
      toast.error(t('diagnosticBundle.buildFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function openInBrowser() {
    // uncovered: The "Open GitHub issue" button is only rendered while
    // `generated` is truthy (see `{generated && (<button onClick={openInBrowser}...`
    // in the foot below), so this defensive null-check cannot run from
    // the UI.
    /* v8 ignore start */
    if (!generated) return;
    /* v8 ignore stop */
    const url = buildGitHubIssueUrl(t('diagnosticBundle.reportGitHubIssueTitle'), generated);
    try {
      await openExternalUrl(url);
    } catch (e) {
      toast.error(t('diagnosticBundle.openIssueFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  return (
    <div className="gf-modal-back" onClick={onClose}>
      <div className="gf-modal" style={{ width: 600 }} onClick={(e) => e.stopPropagation()}>
        <div className="gf-modal-head">
          <div>
            <div className="gf-modal-title">{t('diagnosticBundle.title')}</div>
            <div className="gf-modal-sub">
              {t('diagnosticBundle.subtitle')}
            </div>
          </div>
          <button className="gf-btn-3 gf-btn-icon" onClick={onClose} title={t('common.close')}>
            <X size={14} />
          </button>
        </div>
        <div className="gf-modal-body">
          <div className="gf-diag-list">
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>{t('diagnosticBundle.recentLogs')}</b>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>{t('diagnosticBundle.last500Lines')}</span>
            </div>
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>{t('diagnosticBundle.activeProfile')}</b>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>{activeProfile || t('common.vanilla')}</span>
            </div>
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>{t('diagnosticBundle.modList')}</b>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>{t('diagnosticBundle.entriesCount', { count: mods.length })}</span>
            </div>
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>{t('diagnosticBundle.gameInfo')}</b>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>
                {gameInfo?.valid ? t('diagnosticBundle.valid') : t('diagnosticBundle.notDetected')}
              </span>
            </div>
            <div className="gf-diag-item">
              <span style={{ color: 'var(--ink-mute)' }}>—</span>
              <span>{t('diagnosticBundle.apiKeys')}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>{t('diagnosticBundle.excluded')}</span>
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
            {t('diagnosticBundle.redactCheckbox')}
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
          <button className="gf-btn-3" onClick={onClose}>{t('common.close')}</button>
          <div style={{ flex: 1 }} />
          {generated && (
            <button className="gf-btn-2" onClick={openInBrowser}>
              <Folder size={12} /> {t('diagnosticBundle.openGitHubIssue')}
            </button>
          )}
          <button className="gf-btn" onClick={generate} disabled={busy}>
            <Download size={12} /> {busy ? t('diagnosticBundle.generating') : generated ? t('diagnosticBundle.regenerate') : t('diagnosticBundle.generateBundle')}
          </button>
        </div>
      </div>
    </div>
  );
}
