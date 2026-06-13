import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Check, FolderOpen, RotateCw, Upload, X } from 'lucide-react';
import { openModsFolder, repairMod } from '../hooks/useTauri';

/**
 * Recovery panel rendered inline inside PublishModal when the Rust
 * `share_profile` / `reshare_profile` command rejects with the "missing
 * bundles for N mod(s): …" pattern.
 *
 * Issue #164: the overwhelmingly common cause of this error is a TRANSIENT
 * upload failure — a network blip or a GitHub rate-limit while uploading
 * one mod's bundle — which is why "a different mod fails every time". The
 * right remedy for that is simply to share again: the share flow skips
 * bundles that already uploaded and only re-attempts the ones that failed.
 * So the PRIMARY action here is "Try sharing again" (`onRetryPublish`).
 *
 * "Repair these mods" remains as a SECONDARY remedy for the genuinely-
 * broken case (corrupt/missing local files), where repairing reinstalls
 * each mod from its linked GitHub source. That needs a linked source and
 * does nothing for a pure upload failure, so it's deliberately demoted.
 * On partial failure, each failed row gets an "Open mod folder" link so
 * the curator can fix the underlying problem manually; already-succeeded
 * rows are skipped on the retry pass.
 */

export type ModRepairStatus = 'pending' | 'repairing' | 'success' | 'failed';

interface Props {
  /** Mod names parsed out of the Rust error message. */
  modNames: string[];
  /** Last backend error for the failed uploads, when Rust could identify it. */
  errorDetails?: string | null;
  /**
   * Called once after every mod's repair succeeded. The parent re-runs
   * the original `share_profile` / `reshare_profile` call so the publish
   * completes without forcing the curator to manually retry.
   */
  onRetryPublish: () => Promise<void>;
  /** Closes the panel + the parent modal. */
  onCancel: () => void;
}

/**
 * Parse the Rust "missing bundles" publish-failure message.
 *
 * Source format (see `src-tauri/src/sharing.rs`):
 *   "Could not publish profile '<NAME>': missing bundles for <N> mod(s):
 *    <A>, <B>, .... Restore or reinstall these mods, then share again
 *    so the manifest can repair them later."
 *
 * Returns `{ count, mods }` on a match, or `null` for any other error
 * shape (network failures, GitHub API errors, token issues, etc.) so
 * the caller can fall back to the existing toast handling.
 */
export function parseMissingBundlesError(
  errorMsg: string,
): { count: number; mods: string[]; details?: string } | null {
  if (!errorMsg) return null;
  const match = errorMsg.match(
    /missing bundles for (\d+) mod\(s?\):\s*(.+?)\.\s*(?:Details:\s*(.+?)\.\s*)?Restore or reinstall/is,
  );
  if (!match) return null;
  const count = parseInt(match[1] ?? '0', 10);
  const mods = (match[2] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const details = (match[3] ?? '').trim();
  return details ? { count, mods, details } : { count, mods };
}

function isUploadFailureDetail(details: string | null | undefined): boolean {
  if (!details) return false;
  return /already_exists|release asset|failed to upload|upload of|github|rate-limit|network/i.test(details);
}

export function MissingBundlesPanel({
  modNames,
  errorDetails,
  onRetryPublish,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const [statuses, setStatuses] = useState<Record<string, ModRepairStatus>>(() =>
    Object.fromEntries(modNames.map((n) => [n, 'pending' as ModRepairStatus])),
  );
  const [repairing, setRepairing] = useState(false);
  const [sharing, setSharing] = useState(false);

  const busy = repairing || sharing;
  const uploadFailure = isUploadFailureDetail(errorDetails);

  // Primary remedy for the transient-upload case (issue #164): just run
  // the share again. The Rust share flow re-attempts only the bundles
  // that didn't already upload, so this is cheap and usually fixes it.
  async function handleShareAgain() {
    setSharing(true);
    try {
      await onRetryPublish();
    } catch {
      // The parent's catch in handlePublish() already surfaces a toast
      // (and may re-render this very panel if it failed again).
    } finally {
      setSharing(false);
    }
  }

  async function handleRepair() {
    setRepairing(true);
    // Track results across the pass so we don't have to chase React state
    // for the auto-retry decision (setState is batched and stale closures
    // make `statuses` inside the loop unreliable).
    const passResults: Record<string, ModRepairStatus> = { ...statuses };
    for (const name of modNames) {
      if (passResults[name] === 'success') continue; // skip already-fixed
      setStatuses((prev) => ({ ...prev, [name]: 'repairing' }));
      try {
        await repairMod(name);
        passResults[name] = 'success';
        setStatuses((prev) => ({ ...prev, [name]: 'success' }));
      } catch {
        passResults[name] = 'failed';
        setStatuses((prev) => ({ ...prev, [name]: 'failed' }));
      }
    }
    setRepairing(false);
    const allOk = modNames.every((n) => passResults[n] === 'success');
    if (allOk) {
      try {
        await onRetryPublish();
      } catch {
        // The parent's catch in handlePublish() already surfaces a toast.
        // Swallow here so a follow-up failure doesn't crash the panel.
      }
    }
  }

  async function handleOpenFolder() {
    try {
      await openModsFolder();
    } catch {
      // Best-effort; if the OS shell rejects there's nothing useful to do.
    }
  }

  return (
    <section className="gf-missing-bundles" role="alert" aria-live="polite">
      <div className="gf-missing-bundles-head">
        <AlertTriangle size={16} className="gf-missing-bundles-icon" />
        <div>
          <h2 className="gf-missing-bundles-title">
            {uploadFailure
              ? t('publish.missingBundles.uploadTitle')
              : t('publish.missingBundles.title')}
          </h2>
          <p className="gf-missing-bundles-body">
            {uploadFailure
              ? t('publish.missingBundles.uploadBody')
              : t('publish.missingBundles.body')}
          </p>
          <p className="gf-missing-bundles-subbody">
            {uploadFailure
              ? t('publish.missingBundles.uploadHint')
              : t('publish.missingBundles.repairHint')}
          </p>
          {errorDetails && (
            <p className="gf-missing-bundles-detail">
              {t('publish.missingBundles.lastError', { error: errorDetails })}
            </p>
          )}
        </div>
      </div>
      <ul className="gf-missing-bundles-list">
        {modNames.map((name) => {
          const status = statuses[name] ?? 'pending';
          return (
            <li
              key={name}
              className={`gf-missing-bundles-item status-${status}`}
            >
              <span className="gf-missing-bundles-name">{name}</span>
              <span className={`gf-missing-bundles-status status-${status}`}>
                {status === 'success' && (
                  <Check size={12} className="gf-missing-bundles-status-icon" />
                )}
                {status === 'failed' && (
                  <X size={12} className="gf-missing-bundles-status-icon" />
                )}
                {status === 'pending' && t('publish.missingBundles.statusPending')}
                {status === 'repairing' && t('publish.missingBundles.statusRepairing')}
                {status === 'success' && t('publish.missingBundles.statusSuccess')}
                {status === 'failed' && t('publish.missingBundles.statusFailed')}
              </span>
              {status === 'failed' && (
                <button
                  type="button"
                  className="gf-btn-3 gf-missing-bundles-folder"
                  onClick={handleOpenFolder}
                  title={t('publish.missingBundles.openFolderTitle')}
                >
                  <FolderOpen size={12} /> {t('publish.missingBundles.openFolder')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      <div className="gf-missing-bundles-actions">
        <button
          type="button"
          className="gf-btn-3"
          onClick={onCancel}
          disabled={busy}
        >
          {t('common.cancel')}
        </button>
        <div style={{ flex: 1 }} />
        {!uploadFailure && (
          /* Secondary remedy: repair genuinely-broken local files. Needs a
              linked GitHub source; does nothing for a pure upload failure. */
          <button
            type="button"
            className="gf-btn-2"
            disabled={busy}
            onClick={handleRepair}
            title={t('publish.missingBundles.repairBtnTitle')}
          >
            <RotateCw size={12} />
            {repairing
              ? t('publish.missingBundles.repairing')
              : t('publish.missingBundles.repairBtn')}
          </button>
        )}
        {/* Primary remedy: re-run the share. Re-uploads only the bundles
            that failed; the common transient-failure fix for issue #164. */}
        <button
          type="button"
          className="gf-btn"
          disabled={busy}
          onClick={handleShareAgain}
        >
          <Upload size={12} />
          {sharing
            ? t('publish.missingBundles.sharingAgain')
            : t('publish.missingBundles.shareAgainBtn')}
        </button>
      </div>
    </section>
  );
}
