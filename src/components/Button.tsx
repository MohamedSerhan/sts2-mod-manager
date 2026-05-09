import { type ButtonHTMLAttributes } from 'react';
import { cn } from '../lib/utils';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
type ButtonSize = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

// v5 — gold-flat primary, slate-fill secondary, ghost tertiary, red danger.
// Reuses `.gf-btn*` utility classes from styles.css so chrome buttons and
// view-level Button components share one visual language.
const variantClass: Record<ButtonVariant, string> = {
  primary: 'gf-btn',
  secondary: 'gf-btn-2',
  danger: 'gf-btn-3 gf-btn-danger',
  ghost: 'gf-btn-3',
};

const sizeClass: Record<ButtonVariant, Record<ButtonSize, string>> = {
  primary:   { sm: 'gf-btn-sm', md: '',           lg: 'gf-btn-lg' },
  secondary: { sm: 'gf-btn-2-sm', md: '',         lg: '' },
  danger:    { sm: '',          md: '',           lg: '' },
  ghost:     { sm: '',          md: '',           lg: '' },
};

export function Button({
  variant = 'primary',
  size = 'md',
  className,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn(
        variantClass[variant],
        sizeClass[variant][size],
        className,
      )}
      disabled={disabled}
      {...props}
    />
  );
}
