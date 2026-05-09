import { type HTMLAttributes } from 'react';
import { cn } from '../lib/utils';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  noPadding?: boolean;
}

// v5 — indigo panel + 1px indigo-line border + 10px radius.
export function Card({ className, noPadding, children, ...props }: CardProps) {
  return (
    <div
      className={cn(
        'gf-card',
        !noPadding && 'p-5',
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
