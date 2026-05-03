import { type InputHTMLAttributes } from 'react';
import { cn } from '../lib/utils';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
}

export function Input({ label, className, id, ...props }: InputProps) {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');

  return (
    <div className="flex flex-col gap-1.5">
      {label && (
        <label htmlFor={inputId} className="text-sm text-text-muted">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={cn(
          'bg-surface border border-border rounded-lg px-3 py-2 text-sm text-text',
          'placeholder:text-text-dim',
          'focus:outline-none focus:ring-2 focus:ring-primary/50 focus:border-primary',
          'transition-colors',
          className,
        )}
        {...props}
      />
    </div>
  );
}
