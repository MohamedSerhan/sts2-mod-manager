import { useState } from 'react';
import { Bug, Check, Copy, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { useToast } from '../contexts/ToastContext';
import { useApp } from '../contexts/AppContext';
import { readLogTail, getLogPath, openExternalUrl, listProfiles, uploadBugReport } from '../hooks/useTauri';
import { buildGitHubIssueUrl } from '../lib/githubLinks';

// 1.7.0 — "Report a bug". Reworked from the old support-bundle: builds a
// single redacted text report (description + app/game version + the
// active modpack's load order with versions & source links + the full
// installed mod list + recent logs), copies it to the clipboard, and
// opens a prefilled GitHub issue on the project repo. The reporter
// reviews + submits on github.com (no token needed). Sensitive data —
// home-folder paths, tokens, and the user's own sts2mm-profiles repo /
// username — is redacted; public mod source links are kept because they
// help triage.

interface Props {
  open: boolean;
  onClose: () => void;
}

export function DiagnosticBundle({ open, onClose }: Props) {
  const { t } = useTranslation();
  const toast = useToast();
  const { gameInfo, mods, activeProfile } = useApp();
  const [description, setDescription] = useState('');
  const [redactPaths, setRedactPaths] = useState(true);
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);

  if (!open) return null;

  function redact(s: string): string {
    // Tokens/secrets are ALWAYS stripped (an auth concern); home-folder
    // paths are stripped when the checkbox is on (a privacy concern).
    let out = s
      .replace(/gh[pousr]_[A-Za-z0-9]{36,}/g, '[REDACTED_GITHUB_TOKEN]')
      .replace(/github_pat_[A-Za-z0-9_]{82}/g, '[REDACTED_GITHUB_PAT]')
      .replace(
        /([?&])(api[_-]?key|key|token|access_token)=([^&\s]+)/gi,
        '$1$2=[REDACTED]',
      )
      // The user's own sharing repo (sts2mm-profiles under their account)
      // exposes their GitHub username — redact the owner. Mod source links
      // (github.com/author/mod, nexusmods.com/…) are public and kept.
      .replace(/(github\.com\/)([^/\s]+)(\/sts2mm-profiles)/gi, '$1<redacted>$3');

    if (!redactPaths) return out;
    out = out
      .replace(/([A-Za-z]:\\Users\\)([^\\\s]+)/g, '$1<redacted>')
      .replace(/(\/Users\/)([^/\s]+)/g, '$1<redacted>')
      .replace(/(\/home\/)([^/\s]+)/g, '$1<redacted>');
    return out;
  }

  /** Build the full, redacted bug report text. */
  async function buildReport(): Promise<string> {
    const logs = await readLogTail(500).catch(() => '');
    const logPath = await getLogPath().catch(() => '<unknown>');
    const appVersion = await getVersion().catch(() => '<unknown>');
    // uncovered (false branch): every supported host defines navigator.
    const platform = /* v8 ignore next */ typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown';

    // The active modpack's manifest IS the load order. The manifest rows
    // don't carry source links, so cross-reference the installed mods.
    let loadOrderLines: string[] = [];
    if (activeProfile) {
      try {
        const profiles = await listProfiles();
        const active = profiles.find((p) => p.name === activeProfile);
        if (active) {
          loadOrderLines = active.mods.map((m, i) => {
            const installed = mods.find(
              (x) => (x.folder_name ?? x.name) === (m.folder_name ?? m.name),
            );
            const links = [installed?.github_url, installed?.nexus_url]
              .filter(Boolean)
              .map((u) => `<${u}>`)
              .join(' ');
            const off = m.enabled ? '' : ` ${t('diagnosticBundle.reportDisabledInPack')}`;
            return `  ${i + 1}. ${m.name} ${m.version}${off}${links ? ` ${links}` : ''}`;
          });
        }
      } catch {
        /* load order is best-effort — skip the section on failure */
      }
    }

    const lines = [
      t('diagnosticBundle.reportHeader'),
      t('diagnosticBundle.reportGenerated', { date: new Date().toISOString() }),
      t('diagnosticBundle.reportAppVersion', { version: appVersion }),
      t('diagnosticBundle.reportPlatform', { platform }),
      '',
      t('diagnosticBundle.reportDescriptionSection'),
      description.trim() || t('diagnosticBundle.reportNoDescription'),
      '',
      t('diagnosticBundle.reportGameSection'),
      t('diagnosticBundle.reportGameVersion', { version: gameInfo?.game_version || '<unknown>' }),
      t('diagnosticBundle.reportValid', { valid: String(gameInfo?.valid ?? false) }),
      t('diagnosticBundle.reportModsOnDisk', {
        total: gameInfo?.mods_count ?? 0,
        disabled: gameInfo?.disabled_count ?? 0,
      }),
      '',
      t('diagnosticBundle.reportActiveProfileSection'),
      t('diagnosticBundle.reportProfileName', { name: activeProfile || 'Vanilla' }),
      ...(loadOrderLines.length
        ? ['', t('diagnosticBundle.reportLoadOrderSection'), ...loadOrderLines]
        : []),
      '',
      t('diagnosticBundle.reportInstalledModsSection'),
      ...mods.map(
        (m) =>
          `  ${m.enabled ? '✓' : '✗'} ${m.name} ${m.version}${m.pinned ? ' [frozen]' : ''}${m.github_url ? ` <${m.github_url}>` : ''}${m.nexus_url ? ` <${m.nexus_url}>` : ''}`,
      ),
      '',
      t('diagnosticBundle.reportLogTailSection'),
      t('diagnosticBundle.reportLogSource', { path: logPath }),
      '',
      logs || t('diagnosticBundle.reportLogEmpty'),
    ].join('\n');

    // Redact the whole assembled report in one pass so anything the user
    // typed into the description (or that shows up in the logs) is covered.
    return redact(lines);
  }

  async function copyToClipboard(report: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(report);
      return true;
    } catch {
      return false;
    }
  }

  /** Primary action: build the full report, then open a prefilled GitHub
   *  issue. Best path — upload the FULL report to the maintainer's ingest
   *  endpoint (no user token) and link it in the issue, so nothing is
   *  truncated and the user does nothing. Fallback (endpoint not configured
   *  / upload failed) — copy the full report to the clipboard and prefill a
   *  truncated issue body. */
  async function openBugReport() {
    if (busy) return;
    setBusy(true);
    try {
      const report = await buildReport();
      setGenerated(report);
      const title = t('diagnosticBundle.reportGitHubIssueTitle');

      // Try the zero-effort path: full report → maintainer endpoint → link.
      let reportUrl: string | null = null;
      try {
        reportUrl = await uploadBugReport(report);
      } catch {
        // Endpoint not configured for this build, or the upload failed —
        // fall through to the clipboard + truncated-issue path.
        reportUrl = null;
      }

      if (reportUrl) {
        // Issue body carries the user's note + a link to the full report,
        // so GitHub's URL limit never truncates the diagnostics. Redact the
        // free-text description the same way the report is redacted.
        const body = [
          redact(description.trim()) || t('diagnosticBundle.reportNoDescription'),
          '',
          t('diagnosticBundle.reportFullLogLink', { url: reportUrl }),
        ].join('\n');
        await openExternalUrl(buildGitHubIssueUrl(title, body));
        toast.success(t('diagnosticBundle.openedWithReportToast'));
        return;
      }

      // Fallback: clipboard is the safety net for the truncated body.
      const copied = await copyToClipboard(report);
      await openExternalUrl(buildGitHubIssueUrl(title, report));
      toast.success(
        copied
          ? t('diagnosticBundle.openedAndCopiedToast')
          : t('diagnosticBundle.openedToast'),
      );
    } catch (e) {
      toast.error(t('diagnosticBundle.buildFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  /** Secondary action: build + copy the full report without leaving the app. */
  async function copyReport() {
    if (busy) return;
    setBusy(true);
    try {
      const report = await buildReport();
      setGenerated(report);
      const copied = await copyToClipboard(report);
      if (copied) toast.success(t('diagnosticBundle.copiedToast'));
      else toast.info(t('diagnosticBundle.readyToast'));
    } catch (e) {
      toast.error(t('diagnosticBundle.buildFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gf-modal-back" onClick={onClose}>
      <div className="gf-modal" style={{ width: 600 }} onClick={(e) => e.stopPropagation()}>
        <div className="gf-modal-head">
          <div>
            <div className="gf-modal-title">{t('diagnosticBundle.title')}</div>
            <div className="gf-modal-sub">{t('diagnosticBundle.subtitle')}</div>
          </div>
          <button className="gf-btn-3 gf-btn-icon" onClick={onClose} title={t('common.close')}>
            <X size={14} />
          </button>
        </div>
        <div className="gf-modal-body">
          <label className="gf-bug-describe-label" htmlFor="gf-bug-describe">
            {t('diagnosticBundle.describeLabel')}
          </label>
          <textarea
            id="gf-bug-describe"
            className="gf-bug-describe"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('diagnosticBundle.describePlaceholder')}
            rows={4}
          />

          <div className="gf-diag-attached-note">{t('diagnosticBundle.attachedNote')}</div>
          <div className="gf-diag-list">
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>{t('diagnosticBundle.gameInfo')}</b>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>
                {gameInfo?.game_version
                  ? gameInfo.game_version
                  : gameInfo?.valid
                  ? t('diagnosticBundle.valid')
                  : t('diagnosticBundle.notDetected')}
              </span>
            </div>
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>{t('diagnosticBundle.modList')}</b>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>{t('diagnosticBundle.entriesCount', { count: mods.length })}</span>
            </div>
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>{t('diagnosticBundle.loadOrder')}</b>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>{activeProfile || t('common.vanilla')}</span>
            </div>
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>{t('diagnosticBundle.recentLogs')}</b>
              <span style={{ marginLeft: 'auto', fontSize: 11 }}>{t('diagnosticBundle.last500Lines')}</span>
            </div>
            <div className="gf-diag-item">
              <span style={{ color: 'var(--ink-mute)' }}>—</span>
              <span>{t('diagnosticBundle.sensitiveData')}</span>
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
                height: 160,
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
          <button className="gf-btn-2" onClick={copyReport} disabled={busy}>
            <Copy size={12} /> {t('diagnosticBundle.copyReport')}
          </button>
          <button className="gf-btn" onClick={openBugReport} disabled={busy}>
            {busy ? (
              t('diagnosticBundle.working')
            ) : (
              <>
                <Bug size={12} /> {t('diagnosticBundle.openBugReport')}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
