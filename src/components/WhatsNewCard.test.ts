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
  it('promotes ### lines to subhead blocks', () => {
    expect(blocks('### Added\n')).toEqual<Block[]>([
      { kind: 'subhead', text: 'Added' },
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
});
