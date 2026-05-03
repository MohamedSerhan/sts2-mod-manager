import { cn } from '../lib/utils';

type BadgeVariant = 'github' | 'nexus' | 'local' | 'default';

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const variantStyles: Record<BadgeVariant, string> = {
  github: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  nexus: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  local: 'bg-gray-500/15 text-gray-400 border-gray-500/30',
  default: 'bg-primary/15 text-primary border-primary/30',
};

export function Badge({ variant = 'default', children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border',
        variantStyles[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function getSourceVariant(source: string | null): BadgeVariant {
  if (!source) return 'local';
  const lower = source.toLowerCase();
  if (lower.includes('github')) return 'github';
  if (lower.includes('nexus')) return 'nexus';
  return 'local';
}
