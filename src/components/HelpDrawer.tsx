import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import { HelpContent } from '../views/Help';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Slide-out right-side drawer that renders the shared <HelpContent />.
 * Wired up from the topbar `?` icon in App.tsx. Closes on Escape,
 * backdrop click, or the explicit close (X) button.
 *
 * The drawer renders nothing when `open` is false so the keydown
 * listener only activates while visible — no risk of a stray Escape
 * elsewhere closing a not-shown drawer and triggering side-effects.
 */
export function HelpDrawer({ open, onClose }: Props) {
  const { t } = useTranslation();

  useEffect(() => {
    if (!open) return;
    function handleEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEsc);
    return () => document.removeEventListener('keydown', handleEsc);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="gf-drawer-backdrop" onClick={onClose}>
      <aside
        className="gf-drawer gf-drawer-right"
        role="dialog"
        aria-label={t('topbar.help')}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="gf-drawer-header">
          <h2>{t('topbar.help')}</h2>
          <button
            type="button"
            className="gf-btn-3 gf-btn-icon"
            onClick={onClose}
            aria-label={t('common.close')}
            title={t('common.close')}
          >
            <X size={16} />
          </button>
        </header>
        <div className="gf-drawer-body">
          <HelpContent />
        </div>
      </aside>
    </div>
  );
}
