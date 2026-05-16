import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Badge, getSourceVariant } from './Badge';

describe('<Badge>', () => {
  it('renders children inside a span with the default variant class', () => {
    render(<Badge>v1.0</Badge>);
    const el = screen.getByText('v1.0');
    expect(el.tagName).toBe('SPAN');
    expect(el.className).toContain('gf-pill');
  });

  it.each([
    ['github', 'gf-pill-github'],
    ['nexus',  'gf-pill-nexus'],
    ['local',  'gf-pill-github'], // local re-uses the github pill style
    ['update', 'gf-pill-update'],
    ['ok',     'gf-pill-ok'],
    ['beta',   'gf-pill-beta'],
  ] as const)('renders the %s variant with class %s', (variant, expected) => {
    render(<Badge variant={variant}>x</Badge>);
    expect(screen.getByText('x').className).toContain(expected);
  });

  it('merges custom className', () => {
    render(<Badge className="extra-badge">x</Badge>);
    expect(screen.getByText('x').className).toContain('extra-badge');
  });
});

describe('getSourceVariant', () => {
  it('returns "local" for null/undefined/empty', () => {
    expect(getSourceVariant(null)).toBe('local');
  });

  it('returns "github" when source mentions github (any case)', () => {
    expect(getSourceVariant('github:owner/repo')).toBe('github');
    expect(getSourceVariant('https://GitHub.com/x/y')).toBe('github');
  });

  it('returns "nexus" when source mentions nexus (any case)', () => {
    expect(getSourceVariant('nexus://...')).toBe('nexus');
    expect(getSourceVariant('https://NexusMods.com/...')).toBe('nexus');
  });

  it('returns "local" for unfamiliar sources', () => {
    expect(getSourceVariant('drag-drop')).toBe('local');
    expect(getSourceVariant('manual')).toBe('local');
  });
});
