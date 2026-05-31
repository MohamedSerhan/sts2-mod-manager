/**
 * Targets the BlockRender `<p>` arm — the `case 'para'` branch of the
 * card's exhaustive switch. The real bundled CHANGELOG.md never has
 * prose paragraphs inside a release entry (writing rules in
 * CHANGELOG.md head force bullets only), so the case stays unreachable
 * unless we stub the changelog lookup. This file does exactly that —
 * isolated from the main component spec so the vi.mock factory only
 * fires for this suite.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { setMockAppVersion } from '../__test__/setup';

vi.mock('../lib/changelog', async () => {
  const actual: typeof import('../lib/changelog') = await vi.importActual('../lib/changelog');
  // Body intentionally has a `### Highlights` subhead followed by a
  // prose paragraph + a bullet. The paragraph is the load-bearing
  // shape — parseSimpleMarkdown emits a `para` block for it, and
  // BlockRender renders that as a `<p>`.
  const entry = {
    version: '1.99.0',
    date: '2026-06-01',
    body: '### Highlights\n\nA short prose summary about this release.\n\n- bullet one\n',
  };
  return {
    ...actual,
    getEntryForVersion: () => entry,
    getLatestReleasedEntry: () => entry,
  };
});

// Imported AFTER the mock so the component picks up the stubbed
// changelog module.
import { WhatsNewCard } from './WhatsNewCard';

beforeEach(() => {
  localStorage.clear();
});

describe('<WhatsNewCard> paragraph block rendering', () => {
  it('renders a <p> for paragraph blocks inside the entry body', async () => {
    setMockAppVersion('1.99.0');
    render(<WhatsNewCard />);
    await waitFor(() => {
      expect(screen.getByText(/A short prose summary/)).toBeInTheDocument();
    });
    // The paragraph block renders as a real <p> node (not inside the
    // bullets <ul>), exercising the case 'para' arm of BlockRender.
    const para = screen.getByText(/A short prose summary/);
    expect(para.tagName).toBe('P');
    // The subhead + bullet from the same body also survive — proves
    // dropEmptySections kept the section since it has visible content.
    expect(screen.getByText('Highlights')).toBeInTheDocument();
    expect(screen.getByText('bullet one')).toBeInTheDocument();
  });
});
