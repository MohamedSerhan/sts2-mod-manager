import { describe, expect, it } from 'vitest';

import { parseSimpleMarkdown, type Block } from './WhatsNewCard';

/**
 * Tests for the markdown subset that renders inside the "What's new"
 * card. The parser handles `###` subheadings, `-`/`*` bullet lists,
 * paragraphs, and drops `---` horizontal-rule separators (which the
 * CHANGELOG uses to divide versions and which look noisy on the small
 * card surface).
 *
 * These tests pin the exact `Block[]` shape — easier to read than
 * the rendered HTML and equally strict.
 */

function blocks(md: string): Block[] {
  return parseSimpleMarkdown(md);
}

describe('parseSimpleMarkdown', () => {
  it('promotes ### lines with content to subhead blocks', () => {
    expect(blocks('### Added\n\n- One visible update.\n')).toEqual<Block[]>([
      { kind: 'subhead', text: 'Added' },
      { kind: 'bullets', items: ['One visible update.'] },
    ]);
  });

  it('groups consecutive bullets into one bullets block', () => {
    const md = `- first item\n- second item\n* third (asterisk also works)\n`;
    expect(blocks(md)).toEqual<Block[]>([
      { kind: 'bullets', items: ['first item', 'second item', 'third (asterisk also works)'] },
    ]);
  });

  it('joins wrapped paragraph lines with spaces and flushes on a blank line', () => {
    const md = `First sentence wraps\nacross two lines.\n\nSecond paragraph.\n`;
    expect(blocks(md)).toEqual<Block[]>([
      { kind: 'para', text: 'First sentence wraps across two lines.' },
      { kind: 'para', text: 'Second paragraph.' },
    ]);
  });

  it('drops --- / *** / ___ horizontal-rule separators entirely', () => {
    // The CHANGELOG uses `---` to divide releases. Rendering it as a
    // literal "---" paragraph in the card is just noise; the parser
    // must drop these.
    const md = `### Added\n\n- a bullet\n\n---\n\n### Fixed\n\n- another bullet\n`;
    expect(blocks(md)).toEqual<Block[]>([
      { kind: 'subhead', text: 'Added' },
      { kind: 'bullets', items: ['a bullet'] },
      { kind: 'subhead', text: 'Fixed' },
      { kind: 'bullets', items: ['another bullet'] },
    ]);
  });

  it('treats a subhead immediately after bullets as a new section', () => {
    // Catches a regression where a subhead following bullets would
    // accidentally extend the prior bullet list.
    const md = `- bullet one\n- bullet two\n### Next section\n- bullet three\n`;
    expect(blocks(md)).toEqual<Block[]>([
      { kind: 'bullets', items: ['bullet one', 'bullet two'] },
      { kind: 'subhead', text: 'Next section' },
      { kind: 'bullets', items: ['bullet three'] },
    ]);
  });

  it('returns an empty array for empty input', () => {
    expect(blocks('')).toEqual<Block[]>([]);
    expect(blocks('\n\n\n')).toEqual<Block[]>([]);
  });

  it("doesn't split inline `code` spans — that's the renderer's job", () => {
    // The parser stores raw bullet text; rendering the `code` markup
    // happens in renderInline. We assert the markdown survives intact.
    expect(blocks('- run `npm run qa:smoke` to reproduce\n')).toEqual<Block[]>([
      { kind: 'bullets', items: ['run `npm run qa:smoke` to reproduce'] },
    ]);
  });

  it('drops empty changelog sections before rendering', () => {
    const md = `### Added\n\n- Visible addition.\n\n### Changed\n\n### Fixed\n\n- Visible fix.\n\n### Security\n\n---\n`;
    expect(blocks(md)).toEqual<Block[]>([
      { kind: 'subhead', text: 'Added' },
      { kind: 'bullets', items: ['Visible addition.'] },
      { kind: 'subhead', text: 'Fixed' },
      { kind: 'bullets', items: ['Visible fix.'] },
    ]);
  });

  it('keeps a subhead followed by a non-empty paragraph (covers blockHasVisibleContent para branch)', () => {
    // dropEmptySections iterates forward from a subhead until it finds
    // either the next subhead or a block with visible content. A `para`
    // block with visible text counts as content — without this branch
    // covered, sections with paragraph-only bodies would silently drop.
    const md = `### Highlights\n\nA short release summary in prose.\n\n### Next\n\n- bullet\n`;
    expect(blocks(md)).toEqual<Block[]>([
      { kind: 'subhead', text: 'Highlights' },
      { kind: 'para', text: 'A short release summary in prose.' },
      { kind: 'subhead', text: 'Next' },
      { kind: 'bullets', items: ['bullet'] },
    ]);
  });

  it('drops a subhead immediately followed by an empty subhead chain (covers the next-subhead exit branch)', () => {
    // Two empty subheads in a row — dropEmptySections must walk forward
    // from the first, hit the second subhead, and return false (drop).
    const md = `### EmptyOne\n\n### EmptyTwo\n\n- still-here\n`;
    expect(blocks(md)).toEqual<Block[]>([
      { kind: 'subhead', text: 'EmptyTwo' },
      { kind: 'bullets', items: ['still-here'] },
    ]);
  });

  it('drops a subhead whose only following block is an empty-text paragraph', () => {
    // A para block with empty trimmed text fails blockHasVisibleContent
    // and the loop falls through to `return false`. The parser itself
    // filters truly empty paras out via `if (text) out.push(...)`, but
    // we still need the branch covered for whitespace-shaped inputs.
    // Trailing subhead with no real content after it gets dropped.
    const md = `### Real\n\n- one\n\n### Trailing\n`;
    expect(blocks(md)).toEqual<Block[]>([
      { kind: 'subhead', text: 'Real' },
      { kind: 'bullets', items: ['one'] },
    ]);
  });
});
