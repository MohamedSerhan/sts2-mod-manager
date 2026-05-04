import { type HTMLAttributes } from 'react';
import { cn } from '../lib/utils';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  noPadding?: boolean;
}

export function Card({ className, noPadding, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'bg-surface border border-border rounded-xl',
        !noPadding && 'p-5',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
