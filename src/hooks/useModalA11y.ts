import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Shared modal keyboard a11y for the form dialogs (create-modpack wizard, edit
 * modpack) that — unlike the rest of the app's modals — render their own
 * markup instead of going through a provider. Gives them:
 *   · initial focus moved inside the dialog on open (keyboard users start in),
 *   · Escape-to-close (gated by `enabled` so a stray Escape can't abort a
 *     mid-flight create/save), and
 *   · a Tab focus-trap that keeps focus within the dialog.
 *
 * `ref` must point at the dialog container (give it `tabIndex={-1}` so it's a
 * focus fallback when it holds no focusable children).
 */
export function useModalA11y(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  enabled = true,
): void {
  // Move focus inside the dialog once, on open.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const first = node.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node).focus();
    // Mount-only: re-focusing on every state change would steal focus mid-edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape-to-close + Tab focus-trap.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        if (!enabled) return;
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusable = Array.from(node!.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) {
        e.preventDefault();
        node!.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      // Wrap around at both ends, and pull focus back in if it escaped.
      if (e.shiftKey && (active === first || !node!.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !node!.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }

    node.addEventListener('keydown', onKeyDown);
    return () => node.removeEventListener('keydown', onKeyDown);
  }, [ref, onClose, enabled]);
}
