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
        <label htmlFor={inputId} className="text-xs font-medium text-text-muted">
          {label}
        </label>
      )}
      <input
        id={inputId}
        className={cn('gf-input', className)}
        {...props}
      />
    </div>
  );
}
