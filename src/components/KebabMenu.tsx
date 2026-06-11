import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MoreHorizontal } from 'lucide-react';

// v5 batch 2/3 — generic ⋯ kebab popover. Wraps a trigger button + a
// dropdown menu. Click outside / Esc dismiss. Items are passed as children.
//
//   <KebabMenu>
//     <KebabSection head="From this install">
//       <KebabItem icon={<Refresh />} onClick={...}>Snapshot</KebabItem>
//       <KebabItem icon={<Wrench />} onClick={...}>Repair</KebabItem>
//     </KebabSection>
//     <KebabDivider />
//     <KebabItem danger icon={<Trash />} onClick={...}>Delete profile…</KebabItem>
//   </KebabMenu>

interface KebabMenuProps {
  children: ReactNode;
  size?: 'sm' | 'md';
  align?: 'left' | 'right';
  title?: string;
  buttonClassName?: string;
  /** Custom trigger content. When provided, it replaces the default ⋯
   *  icon — lets the same popover power a labeled dropdown like
   *  "+ Add mods ▾". */
  trigger?: ReactNode;
}

export function KebabMenu({
  children,
  size = 'md',
  align = 'right',
  title,
  buttonClassName,
  trigger,
}: KebabMenuProps) {
  const { t } = useTranslation();
  const resolvedTitle = title ?? t('common.moreActions');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    }
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener('keydown', onKey);
    const closeTimer = setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(closeTimer);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const buttonClass = buttonClassName ?? (size === 'sm' ? 'gf-btn-3 gf-btn-icon gf-btn-2-sm' : 'gf-btn-3 gf-btn-icon');

  return (
    // `gf-kebab-open` raises this wrapper's z-index while the menu is open.
    // The wrapper is `position: relative`, but a row's `.gf-card` only sets a
    // `transition` (not a `transform`/`will-change`), so it does NOT establish
    // a stacking context — meaning sibling rows later in DOM order would paint
    // OVER this absolutely-positioned popover (issue #162). Lifting the open
    // wrapper's z-index makes it (and its popover) win against following rows.
    <div
      ref={wrapRef}
      className={open ? 'gf-kebab-wrap gf-kebab-open' : 'gf-kebab-wrap'}
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <button
        className={buttonClass}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={resolvedTitle}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {trigger ?? <MoreHorizontal size={14} />}
      </button>
      {open && (
        <div
          className="gf-kebab"
          role="menu"
          style={align === 'left' ? { insetInlineEnd: 'auto', insetInlineStart: 0 } : undefined}
          onClick={(e) => e.stopPropagation()}
        >
          <KebabContext.Provider value={{ close: () => setOpen(false) }}>
            {children}
          </KebabContext.Provider>
        </div>
      )}
    </div>
  );
}

import { createContext, useContext } from 'react';

interface KebabCtx {
  close: () => void;
}
const KebabContext = createContext<KebabCtx>({ close: () => {} });

export function KebabSection({ head, children }: { head?: string; children: ReactNode }) {
  return (
    <div className="gf-kebab-section">
      {head && <div className="gf-kebab-head">{head}</div>}
      {children}
    </div>
  );
}

export function KebabDivider() {
  return <div className="gf-kebab-divider" />;
}

interface KebabItemProps {
  icon?: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /**
   * Optional dim secondary line shown under the main label. Use for plain-
   * language explanations of jargon-y actions ("Freeze", "Repair", etc.) so a
   * first-time user knows what they're about to do without hovering.
   */
  description?: ReactNode;
  children: ReactNode;
}

export function KebabItem({ icon, onClick, danger, disabled, description, children }: KebabItemProps) {
  const { close } = useContext(KebabContext);
  return (
    <button
      role="menuitem"
      type="button"
      disabled={disabled}
      className={`gf-kebab-item ${danger ? 'gf-kebab-danger' : ''} ${description ? 'gf-kebab-item-multiline' : ''}`}
      onClick={() => {
        if (disabled) return;
        close();
        onClick?.();
      }}
    >
      <span className="gf-kebab-ico">{icon}</span>
      <span style={{ flex: 1, textAlign: 'start', minWidth: 0 }}>
        <span className="gf-kebab-label">{children}</span>
        {description && <span className="gf-kebab-desc">{description}</span>}
      </span>
    </button>
  );
}
