import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../lib/utils';

export interface SelectOption {
  value: string;
  label: ReactNode;
  disabled?: boolean;
}

interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  /** Forwarded to the trigger button so a `<label htmlFor>` can target it. */
  id?: string;
  /** Extra classes for the trigger button (e.g. sizing variants). */
  className?: string;
  disabled?: boolean;
  'aria-label'?: string;
  /** Inline overrides for the trigger (e.g. width: auto). */
  style?: CSSProperties;
  /** Shown when no option matches `value`. */
  placeholder?: string;
}

// Custom dropdown replacing native <select>. The OS draws native <select>
// popups, so they can't be styled or animated — this gives a consistent
// bordered trigger and an animated, themed listbox. Implements the ARIA
// combobox+listbox pattern: focus stays on the trigger and the highlighted
// option is tracked via aria-activedescendant, which keeps keyboard nav and
// testing-library queries (getByRole('combobox' | 'option')) straightforward.
export function Select({
  value,
  onChange,
  options,
  id,
  className,
  disabled,
  style,
  placeholder,
  'aria-label': ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listId = useId();

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  const close = useCallback((refocus = false) => {
    setOpen(false);
    setHighlight(-1);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    setOpen(true);
    // Start the highlight on the current selection (or first enabled option).
    const start = selectedIndex >= 0 ? selectedIndex : options.findIndex((o) => !o.disabled);
    setHighlight(start);
  }, [disabled, options, selectedIndex]);

  // Close on outside pointer + on viewport changes that would orphan the panel.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) close();
    }
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => window.removeEventListener('pointerdown', onPointerDown, true);
  }, [open, close]);

  function moveHighlight(dir: 1 | -1) {
    setHighlight((cur) => {
      const n = options.length;
      let next = cur;
      for (let i = 0; i < n; i++) {
        next = (next + dir + n) % n;
        if (!options[next]?.disabled) return next;
      }
      return cur;
    });
  }

  function commit(index: number) {
    const opt = options[index];
    if (!opt || opt.disabled) return;
    if (opt.value !== value) onChange(opt.value);
    close(true);
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveHighlight(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveHighlight(-1);
        break;
      case 'Home':
        e.preventDefault();
        setHighlight(options.findIndex((o) => !o.disabled));
        break;
      case 'End':
        e.preventDefault();
        for (let i = options.length - 1; i >= 0; i--) {
          if (!options[i].disabled) { setHighlight(i); break; }
        }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(highlight);
        break;
      case 'Escape':
        e.preventDefault();
        close(true);
        break;
      case 'Tab':
        close();
        break;
    }
  }

  return (
    <div className="gf-select-wrap" ref={wrapRef}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && highlight >= 0 ? `${listId}-opt-${highlight}` : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        className={cn('gf-select', open && 'is-open', className)}
        style={style}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className={cn('gf-select-value', !selected && 'is-placeholder')}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={15} className="gf-select-chevron" aria-hidden />
      </button>

      {open && (
        <ul
          id={listId}
          role="listbox"
          className="gf-select-panel"
          aria-label={ariaLabel}
        >
          {options.map((opt, i) => (
            <li
              key={opt.value}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={opt.value === value}
              aria-disabled={opt.disabled || undefined}
              className={cn(
                'gf-select-option',
                opt.value === value && 'is-selected',
                i === highlight && 'is-active',
                opt.disabled && 'is-disabled',
              )}
              // Use pointerdown so selection wins the race against the
              // outside-pointerdown close handler; preventDefault keeps
              // focus on the trigger.
              onPointerDown={(e) => { e.preventDefault(); commit(i); }}
              onMouseEnter={() => !opt.disabled && setHighlight(i)}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
