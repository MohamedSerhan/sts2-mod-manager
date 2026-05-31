/**
 * AdvancedSection — shared disclosure for power-user / destructive
 * actions, with state persisted to localStorage.
 *
 * Used by ModpackDetail (1.7.0 T9) to tuck Delete / Duplicate /
 * Export / Snapshot / Load-Order / Repair behind a click. Designed to
 * be reusable: any future surface that needs an "Advanced" gate (e.g.
 * debug controls in Settings) can drop this in and pick a unique
 * `localStorageKey` so the toggle survives a session restart.
 *
 * State model:
 *   - On mount, reads the persisted '1'/'0' flag from
 *     `localStorage[localStorageKey]`. Anything else (including null,
 *     a corrupted value, or a throwing Storage implementation) falls
 *     back to `defaultOpen` (default false).
 *   - On every toggle, writes the new state back. Write failures are
 *     swallowed so private-mode browsers don't crash the component.
 *
 * Accessibility:
 *   - The header is a native `<button type="button">` with
 *     `aria-expanded` reflecting state. The caret rotates via CSS to
 *     hint state without relying on a separate icon swap.
 *   - The body is unmounted when closed (rather than visibility-hidden)
 *     so heavy children don't pay for being collapsed.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../lib/utils';

interface Props {
  /** Optional title; falls back to i18n `common.advanced`. */
  title?: string;
  /** Required: localStorage key to persist open/closed state. */
  localStorageKey: string;
  /** Default open/closed state when localStorage is missing/invalid. */
  defaultOpen?: boolean;
  /** Body content; rendered only when open. */
  children: ReactNode;
}

export function AdvancedSection({
  title,
  localStorageKey,
  defaultOpen = false,
  children,
}: Props) {
  const { t } = useTranslation();
  const label = title ?? t('common.advanced');

  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(localStorageKey);
      if (stored === '1') return true;
      if (stored === '0') return false;
      return defaultOpen;
    } catch {
      return defaultOpen;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(localStorageKey, open ? '1' : '0');
    } catch {
      // localStorage might be disabled / full / blocked; non-fatal.
    }
  }, [open, localStorageKey]);

  return (
    <section className={cn('gf-advanced', open && 'open')}>
      <button
        type="button"
        className="gf-advanced-header"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <ChevronRight
          size={14}
          className={cn('gf-advanced-caret', open && 'open')}
          aria-hidden
        />
        <span className="gf-advanced-title">{label}</span>
      </button>
      {open && <div className="gf-advanced-body">{children}</div>}
    </section>
  );
}
