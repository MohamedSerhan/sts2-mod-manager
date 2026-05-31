import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import { HelpContent } from '../views/Help';
import { useModalA11y } from '../hooks/useModalA11y';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Slide-out right-side drawer that renders the shared <HelpContent />.
 * Wired up from the topbar `?` icon in App.tsx. Closes on Escape,
 * backdrop click, or the explicit close (X) button.
 *
 * The inner panel is mounted only while `open`, so its focus management
 * (initial focus, Tab focus-trap, Escape-to-close) attaches exactly when
 * the drawer is shown and tears down when it closes — the same lifecycle
 * the create/edit-modpack modals rely on via useModalA11y.
 */
export function HelpDrawer({ open, onClose }: Props) {
  if (!open) return null;
  return <HelpDrawerPanel onClose={onClose} />;
}

function HelpDrawerPanel({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLElement>(null);
  // Move focus into the drawer on open, trap Tab inside it, and close on
  // Escape — the shared modal a11y the rest of the app's dialogs use.
  useModalA11y(panelRef, onClose);

  return (
    <div className="gf-drawer-backdrop" onClick={onClose}>
      <aside
        ref={panelRef}
        tabIndex={-1}
        className="gf-drawer gf-drawer-right"
        role="dialog"
        aria-modal="true"
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
