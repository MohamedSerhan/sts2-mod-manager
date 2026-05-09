import { useEffect, useRef, useState, type ReactNode } from 'react';
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
}

export function KebabMenu({
  children,
  size = 'md',
  align = 'right',
  title = 'More actions',
  buttonClassName,
}: KebabMenuProps) {
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
    const t = setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearTimeout(t);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const buttonClass = buttonClassName ?? (size === 'sm' ? 'gf-btn-3 gf-btn-icon gf-btn-2-sm' : 'gf-btn-3 gf-btn-icon');

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        className={buttonClass}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div
          className="gf-kebab"
          role="menu"
          style={align === 'left' ? { right: 'auto', left: 0 } : undefined}
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
  children: ReactNode;
}

export function KebabItem({ icon, onClick, danger, disabled, children }: KebabItemProps) {
  const { close } = useContext(KebabContext);
  return (
    <button
      role="menuitem"
      type="button"
      disabled={disabled}
      className={`gf-kebab-item ${danger ? 'gf-kebab-danger' : ''}`}
      onClick={() => {
        if (disabled) return;
        close();
        onClick?.();
      }}
    >
      <span className="gf-kebab-ico">{icon}</span>
      <span style={{ flex: 1, textAlign: 'left' }}>{children}</span>
    </button>
  );
}
