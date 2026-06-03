import { useRef, useState, type RefObject } from 'react';
import { AlertTriangle, Bug, Check, Copy, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getVersion } from '@tauri-apps/api/app';
import { useToast } from '../contexts/ToastContext';
import { useApp } from '../contexts/AppContext';
import {
  readLogTail,
  getLogPath,
  openExternalUrl,
  listProfiles,
  uploadBugReport,
  bugReportEndpointHost,
} from '../hooks/useTauri';
import { buildGitHubIssueUrl } from '../lib/githubLinks';
import { useModalA11y } from '../hooks/useModalA11y';

// 1.7.0 — "Report a bug". Reworked from the old support-bundle: builds a
// single redacted text report (description + app/game version + the
// active modpack's load order with versions & source links + the full
// installed mod list + recent logs), copies it to the clipboard, and
// opens a prefilled GitHub issue on the project repo. The reporter
// reviews + submits on github.com (no token needed). Sensitive data —
// home-folder paths, tokens, and the user's own sts2mm-profiles repo /
// username — is redacted; public mod source links are kept because they
// help triage.
//
// Uploading the full report to the maintainer's endpoint is irrevocable
// (it becomes a world-readable link that persists ~90 days), so it's a
// deliberate TWO-STEP flow: the first "Report a bug" click builds and
// shows the redacted preview, then — only when an upload endpoint is
// configured for this build — pauses on a consent banner naming the host;
// a second, explicitly-labelled "Upload & open issue" click is what
// actually sends it. Builds with no endpoint (dev / forks) skip the
// upload entirely and take the no-egress clipboard path.

interface Props {
  open: boolean;
  onClose: () => void;
}

export function DiagnosticBundle({ open, onClose }: Props) {
  if (!open) return null;
  return <DiagnosticBundlePanel onClose={onClose} />;
}

function DiagnosticBundlePanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { gameInfo, mods, activeProfile } = useApp();
  const [description, setDescription] = useState('');
  const [redactPaths, setRedactPaths] = useState(true);
  const [busy, setBusy] = useState(false);
  const [generated, setGenerated] = useState<string | null>(null);
  // Host of the upload endpoint, learned at report-build time. When set we
  // pause on a consent banner (`awaitingConsent`) before any upload happens.
  const [uploadHost, setUploadHost] = useState<string | null>(null);
  const [awaitingConsent, setAwaitingConsent] = useState(false);
  const modalRef = useRef<HTMLElement>(null);
  useModalA11y(modalRef, onClose);

  function redact(s: string): string {
    // Tokens/secrets are ALWAYS stripped (an auth concern); home-folder
    // paths are stripped when the checkbox is on (a privacy concern).
    let out = s
      .replace(/gh[pousr]_[A-Za-z0-9]{36,}/g, '[REDACTED_GITHUB_TOKEN]')
      .replace(/github_pat_[A-Za-z0-9_]{82}/g, '[REDACTED_GITHUB_PAT]')
      // Any bearer token, not just gh* ones (e.g. a JWT / Nexus token), should
      // an "Authorization: Bearer …" line ever reach the log tail. The
      // (?!\[) skips a token the gh* rules above already turned into a
      // "[REDACTED_…]" placeholder, so those keep their specific marker.
      .replace(/(authorization:\s*bearer\s+)(?!\[)\S+/gi, '$1[REDACTED]')
      .replace(
        /([?&])(api[_-]?key|key|token|access_token)=([^&\s]+)/gi,
        '$1$2=[REDACTED]',
      )
      // The user's own sharing repo (sts2mm-profiles under their account)
      // exposes their GitHub username — redact the owner across every host the
      // share flow touches: the web repo, raw file content, and the REST API.
      // Mod source links (github.com/author/mod, nexusmods.com/…) are public
      // and kept; scoping each pattern to `/sts2mm-profiles` leaves them alone.
      .replace(/(github\.com\/)([^/\s]+)(\/sts2mm-profiles)/gi, '$1<redacted>$3')
      .replace(/(raw\.githubusercontent\.com\/)([^/\s]+)(\/sts2mm-profiles)/gi, '$1<redacted>$3')
      .replace(/(api\.github\.com\/repos\/)([^/\s]+)(\/sts2mm-profiles)/gi, '$1<redacted>$3');

    if (!redactPaths) return out;
    out = out
      // Match the whole username up to the next path separator (NOT the next
      // space) so a spaced Windows account like "C:\Users\John Doe\…" is fully
      // redacted; bounding on the trailing "\" stops it eating following prose.
      .replace(/([A-Za-z]:\\Users\\)([^\\\r\n]+)(\\)/g, '$1<redacted>$3')
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
      t('diagnosticBundle.reportProfileName', { name: activeProfile || t('common.vanilla') }),
      ...(loadOrderLines.length
        ? ['', t('diagnosticBundle.reportLoadOrderSection'), ...loadOrderLines]
        : []),
      '',
      t('diagnosticBundle.reportInstalledModsSection'),
      ...mods.map(
        (m) =>
          `  ${m.enabled ? '✓' : '✗'} ${m.name} ${m.version}${m.pinned ? ` ${t('diagnosticBundle.reportFrozenMarker')}` : ''}${m.github_url ? ` <${m.github_url}>` : ''}${m.nexus_url ? ` <${m.nexus_url}>` : ''}`,
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

  /** No-egress path: copy the full report to the clipboard and prefill a
   *  short GitHub issue that asks the reporter to paste it. The full report
   *  is far larger than a prefilled-issue URL can carry, so we DON'T stuff it
   *  into the URL — GitHub would truncate the logs (the exact problem we're
   *  avoiding). Only if the clipboard is unavailable do we fall back to a
   *  truncated body, so at least partial diagnostics reach the issue. Nothing
   *  leaves the machine here — used for builds with no upload endpoint, and as
   *  the fallback when a configured upload fails. */
  async function fallbackToClipboard(report: string) {
    const title = t('diagnosticBundle.reportGitHubIssueTitle');
    const copied = await copyToClipboard(report);
    if (copied) {
      const body = [
        redact(description.trim()) || t('diagnosticBundle.reportNoDescription'),
        '',
        t('diagnosticBundle.pasteReportNote'),
      ].join('\n');
      await openExternalUrl(buildGitHubIssueUrl(title, body));
      toast.success(t('diagnosticBundle.openedAndCopiedToast'));
    } else {
      await openExternalUrl(buildGitHubIssueUrl(title, report));
      toast.success(t('diagnosticBundle.openedToast'));
    }
  }

  /** Step 1 (primary "Report a bug" button): build the full report and show
   *  the redacted preview. If this build has an upload endpoint, learn its
   *  host and PAUSE on a consent banner — the upload (irrevocable, public for
   *  ~90 days) must be a separate, deliberate click. If there's no endpoint
   *  (dev / fork builds), nothing can be uploaded, so go straight to the
   *  no-egress clipboard path. */
  async function handleReport() {
    if (busy) return;
    setBusy(true);
    try {
      const report = await buildReport();
      setGenerated(report);
      // Learn the destination fresh at click time so the consent names the
      // exact host and we never enter consent for a build that can't upload.
      const host = await bugReportEndpointHost().catch(() => null);
      if (host) {
        setUploadHost(host);
        setAwaitingConsent(true);
      } else {
        await fallbackToClipboard(report);
      }
    } catch (e) {
      toast.error(t('diagnosticBundle.buildFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  /** Step 2 (only reachable after `handleReport` shows the consent banner):
   *  the user has read the preview + the "this uploads to <host>, public for
   *  ~90 days" notice and explicitly chosen to send it. Upload the FULL report
   *  to the maintainer's endpoint and link it in a prefilled issue, so nothing
   *  is truncated. If the upload fails, fall back to the clipboard path rather
   *  than dropping the report. */
  async function confirmUpload() {
    // The button is disabled while busy, so no re-entry guard is needed; we
    // only narrow `generated` (always set once the consent banner shows).
    if (!generated) return;
    setBusy(true);
    try {
      const title = t('diagnosticBundle.reportGitHubIssueTitle');
      let reportUrl: string | null = null;
      try {
        reportUrl = await uploadBugReport(generated);
      } catch {
        reportUrl = null;
      }
      if (reportUrl) {
        // Issue body carries the user's note + a link to the full report, so
        // GitHub's URL limit never truncates the diagnostics. Redact the
        // free-text description the same way the report is redacted.
        const body = [
          redact(description.trim()) || t('diagnosticBundle.reportNoDescription'),
          '',
          t('diagnosticBundle.reportFullLogLink', { url: reportUrl }),
        ].join('\n');
        await openExternalUrl(buildGitHubIssueUrl(title, body));
        toast.success(t('diagnosticBundle.openedWithReportToast'));
      } else {
        await fallbackToClipboard(generated);
      }
      setAwaitingConsent(false);
    } catch (e) {
      toast.error(t('diagnosticBundle.buildFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  }

  /** Any edit to inputs that feed the report invalidates the built preview,
   *  so drop back out of the consent step — the user must rebuild (and re-see
   *  the preview) before they can upload stale content. */
  function invalidatePending() {
    if (awaitingConsent) setAwaitingConsent(false);
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
      <div
        ref={modalRef as RefObject<HTMLDivElement>}
        className="gf-modal"
        style={{ width: 600 }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gf-diagnostic-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="gf-modal-head">
          <div>
            <div id="gf-diagnostic-title" className="gf-modal-title">{t('diagnosticBundle.title')}</div>
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
            onChange={(e) => {
              setDescription(e.target.value);
              invalidatePending();
            }}
            placeholder={t('diagnosticBundle.describePlaceholder')}
            rows={4}
          />

          <div className="gf-diag-attached-note">{t('diagnosticBundle.attachedNote')}</div>
          <div className="gf-diag-list">
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>{t('diagnosticBundle.gameInfo')}</b>
              <span style={{ marginInlineStart: 'auto', fontSize: 11 }}>
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
              <span style={{ marginInlineStart: 'auto', fontSize: 11 }}>{t('diagnosticBundle.entriesCount', { count: mods.length })}</span>
            </div>
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>{t('diagnosticBundle.loadOrder')}</b>
              <span style={{ marginInlineStart: 'auto', fontSize: 11 }}>{activeProfile || t('common.vanilla')}</span>
            </div>
            <div className="gf-diag-item">
              <span className="check"><Check size={12} /></span>
              <b style={{ color: 'var(--ink)' }}>{t('diagnosticBundle.recentLogs')}</b>
              <span style={{ marginInlineStart: 'auto', fontSize: 11 }}>{t('diagnosticBundle.last500Lines')}</span>
            </div>
            <div className="gf-diag-item">
              <span style={{ color: 'var(--ink-mute)' }}>—</span>
              <span>{t('diagnosticBundle.sensitiveData')}</span>
              <span style={{ marginInlineStart: 'auto', fontSize: 11 }}>{t('diagnosticBundle.excluded')}</span>
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
              onChange={(e) => {
                setRedactPaths(e.target.checked);
                invalidatePending();
              }}
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

          {awaitingConsent && (
            <div className="gf-banner gf-banner-warn" role="alert" style={{ marginTop: 12, marginBottom: 0 }}>
              <span className="gf-banner-icon"><AlertTriangle size={16} /></span>
              <span style={{ fontSize: 12.5, lineHeight: 1.5 }}>
                {t('diagnosticBundle.uploadConsent', { host: uploadHost })}
              </span>
            </div>
          )}
        </div>
        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={onClose}>{t('common.close')}</button>
          <div style={{ flex: 1 }} />
          <button className="gf-btn-2" onClick={copyReport} disabled={busy}>
            <Copy size={12} /> {t('diagnosticBundle.copyReport')}
          </button>
          {awaitingConsent ? (
            <button className="gf-btn" onClick={confirmUpload} disabled={busy}>
              {busy ? (
                t('diagnosticBundle.working')
              ) : (
                <>
                  <Upload size={12} /> {t('diagnosticBundle.uploadAndOpen')}
                </>
              )}
            </button>
          ) : (
            <button className="gf-btn" onClick={handleReport} disabled={busy}>
              {busy ? (
                t('diagnosticBundle.working')
              ) : (
                <>
                  <Bug size={12} /> {t('diagnosticBundle.openBugReport')}
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
