import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
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

type KebabPlacement = 'bottom' | 'top';

interface KebabMenuLayout {
  placement: KebabPlacement;
  maxHeight: number | null;
}

const DEFAULT_MENU_LAYOUT: KebabMenuLayout = {
  placement: 'bottom',
  maxHeight: null,
};
const MENU_GAP_PX = 4;
const VIEWPORT_MARGIN_PX = 8;

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
  const [menuLayout, setMenuLayout] = useState<KebabMenuLayout>(DEFAULT_MENU_LAYOUT);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const updateMenuLayout = useCallback(() => {
    const button = buttonRef.current;
    const menu = menuRef.current;
    if (!button || !menu) return;

    const buttonRect = button.getBoundingClientRect();
    const viewportHeight =
      window.innerHeight || document.documentElement.clientHeight || 0;
    const menuHeight = menu.scrollHeight || menu.getBoundingClientRect().height;
    const availableBelow = Math.max(
      0,
      viewportHeight - buttonRect.bottom - MENU_GAP_PX - VIEWPORT_MARGIN_PX,
    );
    const availableAbove = Math.max(
      0,
      buttonRect.top - MENU_GAP_PX - VIEWPORT_MARGIN_PX,
    );
    const placement: KebabPlacement =
      menuHeight > availableBelow && availableAbove > availableBelow
        ? 'top'
        : 'bottom';
    const availableHeight =
      placement === 'top' ? availableAbove : availableBelow;
    const maxHeight =
      menuHeight > availableHeight ? Math.floor(availableHeight) : null;

    setMenuLayout((prev) => {
      if (prev.placement === placement && prev.maxHeight === maxHeight) {
        return prev;
      }
      return { placement, maxHeight };
    });
  }, []);

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

  useLayoutEffect(() => {
    if (!open) {
      setMenuLayout(DEFAULT_MENU_LAYOUT);
      return;
    }
    updateMenuLayout();
    window.addEventListener('resize', updateMenuLayout);
    window.addEventListener('scroll', updateMenuLayout, true);
    return () => {
      window.removeEventListener('resize', updateMenuLayout);
      window.removeEventListener('scroll', updateMenuLayout, true);
    };
  }, [children, open, updateMenuLayout]);

  const buttonClass = buttonClassName ?? (size === 'sm' ? 'gf-btn-3 gf-btn-icon gf-btn-2-sm' : 'gf-btn-3 gf-btn-icon');
  const menuStyle: CSSProperties & { '--gf-kebab-max-height'?: string } =
    align === 'left'
      ? { insetInlineEnd: 'auto', insetInlineStart: 0 }
      : {};
  if (menuLayout.maxHeight !== null) {
    menuStyle['--gf-kebab-max-height'] = `${menuLayout.maxHeight}px`;
  }
  const menuClassName = [
    'gf-kebab',
    menuLayout.placement === 'top' ? 'gf-kebab-top' : '',
    menuLayout.maxHeight !== null ? 'gf-kebab-scrollable' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    // `gf-kebab-open` raises this wrapper's z-index while the menu is open so
    // it (and its absolutely-positioned popover) wins against later sibling
    // rows. That alone suffices for containers that don't create a stacking
    // context (e.g. `.gf-card`). But the Mod Library rows
    // (`.gf-profile-library-row`) and load-order rows set
    // `will-change: transform`, which DOES establish a stacking context and
    // traps this wrapper's z-index inside the row — so styles.css also lifts
    // the owning row via `:has(.gf-kebab-open)`. (issue #162)
    <div
      ref={wrapRef}
      className={open ? 'gf-kebab-wrap gf-kebab-open' : 'gf-kebab-wrap'}
      style={{ position: 'relative', display: 'inline-block' }}
    >
      <button
        ref={buttonRef}
        className={buttonClass}
        onClick={(e) => {
          e.stopPropagation();
          if (!open) setMenuLayout(DEFAULT_MENU_LAYOUT);
          setOpen((v) => !v);
        }}
        title={resolvedTitle}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {trigger ?? <MoreHorizontal size={14} />}
      </button>
      {open && (
        <div
          ref={menuRef}
          className={menuClassName}
          role="menu"
          style={menuStyle}
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
