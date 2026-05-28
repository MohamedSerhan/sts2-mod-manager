import { cn } from '../lib/utils';

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  /** Accessible name for the switch (the control has no visible text). */
  ariaLabel?: string;
  /** Native tooltip shown on hover. */
  title?: string;
}

// v5 — gold-flat tint when on (sized 32x18 to match `.gf-toggle`).
export function Toggle({ checked, onChange, disabled, ariaLabel, title }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn('gf-toggle', checked && 'on')}
    />
  );
}
