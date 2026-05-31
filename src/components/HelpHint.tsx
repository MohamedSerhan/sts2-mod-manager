import { useState, useRef, useEffect } from 'react';
import { HelpCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '../lib/utils';

/**
 * Tiny inline "?" icon that opens a popover with a short answer
 * sourced from the FAQ keys at `help.faq.<helpKey>.a`.
 *
 * The topbar Help drawer (introduced in T14) remains the canonical
 * surface for the full FAQ. HelpHint is for *inline* clarification
 * placed right next to the thing being explained — "what does this
 * mean" without leaving the page.
 *
 * Reuses existing FAQ answers verbatim so the two surfaces never
 * drift in wording.
 */
interface Props {
  /**
   * Key under `help.faq.*`; the popover renders `help.faq.<helpKey>.a`.
   * No new hint copy is created — the same answer that appears in the
   * FAQ list is shown here.
   */
  helpKey: string;
  /** Optional className for positioning tweaks at the call site. */
  className?: string;
}

export function HelpHint({ helpKey, className }: Props) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn('gf-help-hint', className, open && 'open')}>
      <button
        type="button"
        className="gf-help-hint-btn"
        onClick={() => setOpen((o) => !o)}
        aria-label={t('common.whatsThis')}
        aria-expanded={open}
      >
        <HelpCircle size={14} />
      </button>
      {open && (
        <div className="gf-help-hint-popover" role="tooltip">
          {t(`help.faq.${helpKey}.a`)}
        </div>
      )}
    </div>
  );
}
