import { cn } from '../lib/utils';

type BadgeVariant = 'github' | 'nexus' | 'local' | 'default' | 'update' | 'ok';

interface BadgeProps {
  variant?: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

// v5 — pills are uppercase + tracked. Source pills are neutral; warm reserved for state.
const variantClass: Record<BadgeVariant, string> = {
  github: 'gf-pill gf-pill-github',
  nexus: 'gf-pill gf-pill-nexus',
  local: 'gf-pill gf-pill-github',
  default: 'gf-pill gf-pill-github',
  update: 'gf-pill gf-pill-update',
  ok: 'gf-pill gf-pill-ok',
};

export function Badge({ variant = 'default', children, className }: BadgeProps) {
  return (
    <span className={cn(variantClass[variant], className)}>
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
