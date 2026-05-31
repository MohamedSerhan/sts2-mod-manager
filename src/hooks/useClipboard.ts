import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useToast } from '../contexts/ToastContext';

/**
 * Centralized "copy to clipboard" hook.
 *
 * Why it exists: Home, Profiles, and PublishModal each grew their own
 * `navigator.clipboard.writeText` + `setCopied(kind)` + `setTimeout(...,
 * setCopied(null))` shape. The three implementations drifted on timer
 * length (1500ms vs 1600ms vs 1800ms), on toast wording, and on which
 * surfaces show a toast at all — meaning a wording change had to be
 * applied in three places and was easy to miss. Centralising here means:
 *
 *  - The clipboard API call lives in one place, so a future fallback
 *    (e.g. legacy `document.execCommand('copy')` for non-secure-context
 *    surfaces) only needs to be wired once.
 *  - The "Copied" highlight state stays consistent across surfaces.
 *  - The failure path always speaks the user's language (the toast goes
 *    through i18n, never a raw "couldn't copy" English string).
 *
 * Usage:
 * ```ts
 * const { copy, copied } = useClipboard();
 * <button onClick={() => copy(code, 'code')}>
 *   {copied === 'code' ? 'Copied!' : 'Copy'}
 * </button>
 * ```
 *
 * Pass `successMessage` to override the default "Copied!" toast wording
 * — e.g. "Share code copied to clipboard". Pass `showToast: false` for
 * surfaces that have their own inline feedback and don't want to stack
 * a toast on top (PublishModal does this).
 */
export interface UseClipboardOpts {
  /** How long the `copied` state stays truthy after a successful copy.
   *  Default 1500ms — long enough for the user to see the highlight,
   *  short enough that a follow-up click feels fresh. */
  resetMs?: number;
}

export interface CopyOpts {
  /** i18n-translated success message. Defaults to `common.copied`
   *  ("Copied!"). Pass `null` to suppress the toast entirely. */
  successMessage?: string | null;
  /** i18n-translated failure message. Defaults to a generic "couldn't
   *  copy to clipboard". The hook will append the underlying error
   *  message via the `{{error}}` placeholder when present. */
  failureMessage?: string;
}

export function useClipboard(opts: UseClipboardOpts = {}) {
  const { resetMs = 1500 } = opts;
  const { t } = useTranslation();
  const toast = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  // `useRef<number | null>` (not `NodeJS.Timeout`) — jsdom returns a
  // numeric timer ID from `setTimeout`, matching browser behaviour.
  const timerRef = useRef<number | null>(null);

  // Clear any pending reset timer on unmount so we don't try to set
  // state on a teardown component. Cheap insurance — React already
  // warns about it, but the warning is easy to miss in test logs.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  /**
   * Copy `text` to the clipboard. `kind` (optional) is the value that
   * `copied` reflects after a successful write — useful for callers
   * with multiple copy buttons (share code, install link, share
   * message) that want to highlight the one just used. Pass any string
   * that's meaningful to the caller; the hook treats it as opaque.
   *
   * Returns `true` on success, `false` if the clipboard write threw.
   * Callers that need finer-grained error handling can pass
   * `successMessage: null` and react to the boolean themselves.
   */
  const copy = useCallback(
    async (
      text: string,
      kind: string = 'value',
      copyOpts: CopyOpts = {},
    ): Promise<boolean> => {
      const successMessage =
        copyOpts.successMessage === undefined
          ? t('common.copied')
          : copyOpts.successMessage;
      const failureKey = copyOpts.failureMessage ?? 'common.copyFailed';
      try {
        await navigator.clipboard.writeText(text);
        setCopied(kind);
        if (successMessage !== null) {
          toast.success(successMessage);
        }
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
        }
        timerRef.current = window.setTimeout(() => {
          setCopied(null);
          timerRef.current = null;
        }, resetMs);
        return true;
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        // The failureKey may or may not include an `{{error}}`
        // placeholder. i18next is happy to ignore an unused variable,
        // so passing it unconditionally is safe — older callers that
        // used a fixed string ("Couldn't copy to clipboard") will keep
        // showing their original wording without the error tail.
        toast.error(t(failureKey, { error }));
        return false;
      }
    },
    [t, toast, resetMs],
  );

  return { copy, copied };
}
