import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  FolderOpen,
  RotateCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import type { Profile } from "../types";
import {
  openModsFolder,
  restoreProfileModFromShare,
  setProfileModMembership,
} from "../hooks/useTauri";

/**
 * Recovery panel rendered inline inside PublishModal when the Rust
 * `share_profile` / `reshare_profile` command rejects with the "missing
 * bundles for N mod(s): …" pattern.
 *
 * Transient GitHub upload failures lead with "Try sharing again" because
 * the Rust share flow skips bundles that already uploaded and only
 * re-attempts the ones that failed.
 *
 * Missing local files need local action instead: remove the stale modpack
 * row, or reinstall that one mod from the last shared bundle / linked
 * source before publishing again.
 */

export type ModRepairStatus =
  | "pending"
  | "repairing"
  | "removing"
  | "success"
  | "removed"
  | "failed";
export type PublishIssueKind =
  | "missing_unrecoverable"
  | "missing_recoverable"
  | "preserved_remote_bundle"
  | "upload_failed"
  | "unknown";

export interface ParsedPublishIssue {
  name: string;
  kind: PublishIssueKind;
  detail?: string;
}

interface Props {
  profile: Profile;
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
  const mods = uniqueNames(
    (match[2] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
  const count = mods.length || parseInt(match[1] ?? "0", 10);
  const details = (match[3] ?? "").trim();
  return details ? { count, mods, details } : { count, mods };
}

function isUploadFailureDetail(details: string | null | undefined): boolean {
  if (!details) return false;
  return /already_exists|release asset|failed to upload|upload of|github|rate-limit|network/i.test(
    details,
  );
}

function isMissingLocalDetail(details: string | null | undefined): boolean {
  if (!details) return false;
  return /not installed locally|local files are missing|missing locally|not refreshed locally/i.test(
    details,
  );
}

function kindFromDetail(detail: string): PublishIssueKind {
  const marker = detail.match(/\[publish_issue:([a-z_]+)\]/i);
  if (marker) {
    const kind = marker[1] as PublishIssueKind;
    if (
      kind === "missing_unrecoverable" ||
      kind === "missing_recoverable" ||
      kind === "preserved_remote_bundle" ||
      kind === "upload_failed"
    ) {
      return kind;
    }
  }
  if (isMissingLocalDetail(detail)) return "missing_unrecoverable";
  if (isUploadFailureDetail(detail)) return "upload_failed";
  return "unknown";
}

function cleanIssueDetail(detail: string): string {
  return detail.replace(/\[publish_issue:[a-z_]+\]\s*/gi, "").trim();
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.trim().toLocaleLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function issuePriority(kind: PublishIssueKind): number {
  return kind === "upload_failed" ? 2 : 1;
}

export function parseMissingBundleIssues(
  modNames: string[],
  errorDetails?: string | null,
): ParsedPublishIssue[] {
  const issues: ParsedPublishIssue[] = [];
  const seen = new Map<string, number>();
  const addIssue = (issue: ParsedPublishIssue) => {
    const key = issue.name.trim().toLocaleLowerCase();
    if (!key) return;
    const existingIndex = seen.get(key);
    if (existingIndex == null) {
      seen.set(key, issues.length);
      issues.push(issue);
      return;
    }
    if (issuePriority(issue.kind) > issuePriority(issues[existingIndex].kind)) {
      issues[existingIndex] = issue;
    }
  };
  const segments = (errorDetails ?? "")
    .split(/\s+\|\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  for (const segment of segments) {
    const matchedName = modNames.find((name) => segment.startsWith(`${name}:`));
    const colon = segment.indexOf(":");
    const name =
      matchedName ?? (colon > 0 ? segment.slice(0, colon).trim() : "");
    if (!name) continue;
    const rawDetail = matchedName
      ? segment.slice(matchedName.length + 1).trim()
      : segment.slice(colon + 1).trim();
    const detail = cleanIssueDetail(rawDetail);
    const kind = kindFromDetail(rawDetail);
    addIssue({ name, kind, detail });
  }

  const explicitMissing = issues.some(
    (issue) =>
      issue.kind === "missing_unrecoverable" ||
      issue.kind === "missing_recoverable",
  );
  const explicitUpload = issues.some((issue) => issue.kind === "upload_failed");
  const defaultKind: PublishIssueKind =
    errorDetails && explicitUpload && !explicitMissing
      ? "upload_failed"
      : "missing_unrecoverable";

  for (const name of uniqueNames(modNames)) {
    const key = name.trim().toLocaleLowerCase();
    if (!seen.has(key)) {
      addIssue({ name, kind: defaultKind });
    }
  }

  return issues;
}

export function MissingBundlesPanel({
  profile,
  modNames,
  errorDetails,
  onRetryPublish,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const displayModNames = uniqueNames(modNames);
  const [statuses, setStatuses] = useState<Record<string, ModRepairStatus>>(
    () =>
      Object.fromEntries(
        displayModNames.map((n) => [n, "pending" as ModRepairStatus]),
      ),
  );
  const [repairing, setRepairing] = useState(false);
  const [sharing, setSharing] = useState(false);

  const busy = repairing || sharing;
  const issues = parseMissingBundleIssues(displayModNames, errorDetails);
  const hasUploadFailure = issues.some(
    (issue) => issue.kind === "upload_failed",
  );
  const localRecoveryNames = uniqueNames(
    issues
      .filter(
        (issue) =>
          issue.kind === "missing_unrecoverable" ||
          issue.kind === "missing_recoverable",
      )
      .map((issue) => issue.name),
  );
  const hasMissingLocal = localRecoveryNames.length > 0;
  const mixedFailure = hasUploadFailure && hasMissingLocal;
  const profileKey = profile.id || profile.name;
  const titleKey = mixedFailure
    ? "mixedTitle"
    : hasUploadFailure
      ? "uploadTitle"
      : "localTitle";
  const bodyKey = mixedFailure
    ? "mixedBody"
    : hasUploadFailure
      ? "uploadBody"
      : "localBody";
  const hintKey = mixedFailure
    ? "mixedHint"
    : hasUploadFailure
      ? "uploadHint"
      : "localHint";

  function profileModForName(name: string) {
    return profile.mods.find((mod) => mod.name === name);
  }

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

  async function handleReinstall() {
    setRepairing(true);
    // Track results across the pass so we don't have to chase React state
    // for the auto-retry decision (setState is batched and stale closures
    // make `statuses` inside the loop unreliable).
    const passResults: Record<string, ModRepairStatus> = { ...statuses };
    for (const name of localRecoveryNames) {
      if (passResults[name] === "success") continue; // skip already-fixed
      setStatuses((prev) => ({ ...prev, [name]: "repairing" }));
      try {
        const mod = profileModForName(name);
        await restoreProfileModFromShare(
          profileKey,
          mod?.name ?? name,
          mod?.folder_name ?? null,
          mod?.mod_id ?? null,
        );
        passResults[name] = "success";
        setStatuses((prev) => ({ ...prev, [name]: "success" }));
      } catch {
        passResults[name] = "failed";
        setStatuses((prev) => ({ ...prev, [name]: "failed" }));
      }
    }
    setRepairing(false);
    const allOk = localRecoveryNames.every((n) => passResults[n] === "success");
    if (allOk) {
      try {
        await onRetryPublish();
      } catch {
        // The parent's catch in handlePublish() already surfaces a toast.
        // Swallow here so a follow-up failure doesn't crash the panel.
      }
    }
  }

  async function handleRemoveFromPack() {
    setRepairing(true);
    const passResults: Record<string, ModRepairStatus> = { ...statuses };
    for (const name of localRecoveryNames) {
      if (passResults[name] === "removed") continue;
      const mod = profileModForName(name);
      setStatuses((prev) => ({ ...prev, [name]: "removing" }));
      try {
        await setProfileModMembership(
          profileKey,
          mod?.name ?? name,
          mod?.mod_version_id ?? null,
          mod?.folder_name ?? null,
          mod?.mod_id ?? null,
          false,
          mod?.source ?? null,
        );
        passResults[name] = "removed";
        setStatuses((prev) => ({ ...prev, [name]: "removed" }));
      } catch {
        passResults[name] = "failed";
        setStatuses((prev) => ({ ...prev, [name]: "failed" }));
      }
    }
    setRepairing(false);
    const allOk = localRecoveryNames.every((n) => passResults[n] === "removed");
    if (allOk) {
      try {
        await onRetryPublish();
      } catch {
        // The parent's catch in handlePublish() already surfaces a toast.
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
            {t(`publish.missingBundles.${titleKey}`)}
          </h2>
          <p className="gf-missing-bundles-body">
            {t(`publish.missingBundles.${bodyKey}`)}
          </p>
          <p className="gf-missing-bundles-subbody">
            {t(`publish.missingBundles.${hintKey}`)}
          </p>
          {errorDetails && (
            <p className="gf-missing-bundles-detail">
              {t("publish.missingBundles.lastError", { error: errorDetails })}
            </p>
          )}
        </div>
      </div>
      <ul className="gf-missing-bundles-list">
        {displayModNames.map((name) => {
          const status = statuses[name] ?? "pending";
          return (
            <li
              key={name}
              className={`gf-missing-bundles-item status-${status}`}
            >
              <span className="gf-missing-bundles-name">{name}</span>
              <span className={`gf-missing-bundles-status status-${status}`}>
                {(status === "success" || status === "removed") && (
                  <Check size={12} className="gf-missing-bundles-status-icon" />
                )}
                {status === "failed" && (
                  <X size={12} className="gf-missing-bundles-status-icon" />
                )}
                {status === "pending" &&
                  t("publish.missingBundles.statusPending")}
                {status === "repairing" &&
                  t("publish.missingBundles.statusRepairing")}
                {status === "removing" &&
                  t("publish.missingBundles.statusRemoving")}
                {status === "success" &&
                  t("publish.missingBundles.statusSuccess")}
                {status === "removed" &&
                  t("publish.missingBundles.statusRemoved")}
                {status === "failed" &&
                  t("publish.missingBundles.statusFailed")}
              </span>
              {status === "failed" && (
                <button
                  type="button"
                  className="gf-btn-3 gf-missing-bundles-folder"
                  onClick={handleOpenFolder}
                  title={t("publish.missingBundles.openFolderTitle")}
                >
                  <FolderOpen size={12} />{" "}
                  {t("publish.missingBundles.openFolder")}
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
          {t("common.cancel")}
        </button>
        <div style={{ flex: 1 }} />
        {hasMissingLocal && (
          <>
            <button
              type="button"
              className="gf-btn-2"
              disabled={busy}
              onClick={handleRemoveFromPack}
              title={t("publish.missingBundles.removeBtnTitle")}
            >
              <Trash2 size={12} />
              {repairing
                ? t("publish.missingBundles.fixing")
                : t("publish.missingBundles.removeBtn")}
            </button>
            <button
              type="button"
              className="gf-btn"
              disabled={busy}
              onClick={handleReinstall}
              title={t("publish.missingBundles.reinstallBtnTitle")}
            >
              <RotateCw size={12} />
              {repairing
                ? t("publish.missingBundles.fixing")
                : t("publish.missingBundles.reinstallBtn")}
            </button>
          </>
        )}
        {hasUploadFailure && (
          <button
            type="button"
            className="gf-btn"
            disabled={busy}
            onClick={handleShareAgain}
          >
            <Upload size={12} />
            {sharing
              ? t("publish.missingBundles.sharingAgain")
              : t("publish.missingBundles.shareAgainBtn")}
          </button>
        )}
      </div>
    </section>
  );
}
