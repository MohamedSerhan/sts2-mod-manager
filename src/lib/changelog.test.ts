import { describe, expect, it } from 'vitest';

import {
  getAllEntries,
  getEntryForVersion,
  getLatestReleasedEntry,
  getTranslatedBody,
  parseChangelog,
} from './changelog';

/**
 * Tests for the CHANGELOG.md parser used by the "What's new" card.
 *
 * The parser is intentionally tolerant — it has to handle every
 * heading shape the repo's CHANGELOG.md throws at it. These tests
 * pin the shapes we actually use today, plus the edge cases that
 * have broken it historically (link-reference footnotes, rollup
 * headings without dates, etc.).
 */

const SAMPLE = `# Changelog

Header prose that the parser must ignore.

## [Unreleased]

### Added

- Working bullet here.

## [1.3.3] - 2026-05-11

### Fixed

- BaseLib BOM regression. The body is non-empty so this entry is kept.

---

## [1.1.x] (rollup — 2026-03/04)

### Added

- A rollup heading without an ISO date. The parser must still keep this
  entry (its body is non-empty).

## [0.0.1] - 2025-12-01

This release has no headings under it, only body text.

## [1.3.0]

Body for an entry whose heading has neither a dash nor a date.

[Unreleased]: https://example.com/compare/1.3.3...HEAD
[1.3.3]: https://example.com/releases/1.3.3
`;

describe('parseChangelog', () => {
  it('returns one entry per ## [version] heading', () => {
    const entries = parseChangelog(SAMPLE);
    // Five entries: Unreleased, 1.3.3, 1.1.x, 0.0.1, 1.3.0. The two
    // link-reference footnotes at the end have empty bodies and are
    // filtered out.
    expect(entries.map((e) => e.version)).toEqual([
      'Unreleased',
      '1.3.3',
      '1.1.x',
      '0.0.1',
      '1.3.0',
    ]);
  });

  it('extracts the ISO date when present and leaves date=null otherwise', () => {
    const entries = parseChangelog(SAMPLE);
    const byVersion = Object.fromEntries(entries.map((e) => [e.version, e.date]));
    expect(byVersion['1.3.3']).toBe('2026-05-11');
    expect(byVersion['0.0.1']).toBe('2025-12-01');
    expect(byVersion['Unreleased']).toBeNull();
    // Rollup heading with parens after the version doesn't match the
    // date capture group → null. This is the historical bug we want
    // pinned: an over-eager regex would mistake "rollup" or the paren
    // contents for the date.
    expect(byVersion['1.1.x']).toBeNull();
    expect(byVersion['1.3.0']).toBeNull();
  });

  it("trims the body and drops entries whose body is empty (link-reference footer)", () => {
    const entries = parseChangelog(SAMPLE);
    // Body should be trimmed of surrounding whitespace.
    const unreleased = entries.find((e) => e.version === 'Unreleased')!;
    expect(unreleased.body.startsWith('### Added')).toBe(true);
    expect(unreleased.body).not.toMatch(/\n$/);
    expect(unreleased.body).not.toMatch(/^\n/);
    // The `[Unreleased]: https://...` link reference shares the shape
    // but has no body and must be filtered. We assert this by counting:
    // five entries above, two link references, so total 5.
    expect(entries).toHaveLength(5);
  });

  it("preserves --- separators inside an entry's body", () => {
    // The rendering layer (parseSimpleMarkdown / WhatsNewCard) is
    // responsible for dropping `---` lines from display. The parser
    // here keeps them so that responsibility lives in one place.
    const entries = parseChangelog(SAMPLE);
    const v133 = entries.find((e) => e.version === '1.3.3')!;
    expect(v133.body).toContain('---');
  });

  it('returns an empty array on input with no version headings', () => {
    expect(parseChangelog('# Changelog\n\nJust prose.\n')).toEqual([]);
  });
});

/**
 * The three convenience wrappers (getAllEntries / getLatestReleasedEntry /
 * getEntryForVersion) parse the *bundled* CHANGELOG.md (the no-arg
 * parseChangelog path). We assert structural invariants rather than exact
 * version strings so the tests don't churn on every release bump, while
 * still exercising the wrapper logic end-to-end against the real file.
 */
describe('changelog convenience wrappers (bundled CHANGELOG.md)', () => {
  it('getAllEntries returns the parsed bundled entries, all with non-empty bodies', () => {
    const all = getAllEntries();
    // The bundled changelog always has content, so this is non-empty.
    expect(all.length).toBeGreaterThan(0);
    // getAllEntries is a thin pass-through of the no-arg parser — same shape.
    expect(all).toEqual(parseChangelog());
    // The link-reference-footer filter means every returned entry has a body.
    expect(all.every((e) => e.body.length > 0)).toBe(true);
    // The bundled file keeps an [Unreleased] section.
    expect(all.some((e) => e.version.toLowerCase() === 'unreleased')).toBe(true);
  });

  it('getLatestReleasedEntry returns the first non-Unreleased entry', () => {
    const latest = getLatestReleasedEntry();
    expect(latest).not.toBeNull();
    expect(latest!.version.toLowerCase()).not.toBe('unreleased');
    // It must equal the first released (non-Unreleased) entry in file order.
    const firstReleased = getAllEntries().find(
      (e) => e.version.toLowerCase() !== 'unreleased',
    );
    expect(latest).toEqual(firstReleased);
  });

  it('getEntryForVersion matches a real version and strips a leading v', () => {
    const latest = getLatestReleasedEntry()!;
    // Exact version → same entry.
    expect(getEntryForVersion(latest.version)).toEqual(latest);
    // Leading "v" is stripped before matching, so "v<version>" resolves too.
    expect(getEntryForVersion(`v${latest.version}`)).toEqual(latest);
  });

  it('getEntryForVersion returns null for a version not in the changelog', () => {
    expect(getEntryForVersion('0.0.0-does-not-exist')).toBeNull();
  });
});

describe('getTranslatedBody', () => {
  const MAPS = {
    ru: { '9.9.9': '### Добавлено\n- Переведено' },
    ar: { '9.9.9': '### تمت الإضافة\n- مترجم' },
    'zh-Hans': { '9.9.9': '### 新增\n- 已翻译' },
  };

  it('returns the translated body for a present version + locale', () => {
    expect(getTranslatedBody('9.9.9', 'ru', MAPS)).toBe('### Добавлено\n- Переведено');
    expect(getTranslatedBody('9.9.9', 'zh-Hans', MAPS)).toBe('### 新增\n- 已翻译');
  });

  it('normalizes region subtags and zh variants to the file key', () => {
    expect(getTranslatedBody('9.9.9', 'ru-RU', MAPS)).toBe('### Добавлено\n- Переведено');
    expect(getTranslatedBody('9.9.9', 'zh-Hant', MAPS)).toBe('### 新增\n- 已翻译'); // zh-Hant falls back to zh-Hans bundle
  });

  it('returns null for English, unknown locale, or missing version', () => {
    expect(getTranslatedBody('9.9.9', 'en', MAPS)).toBeNull();
    expect(getTranslatedBody('9.9.9', 'en-US', MAPS)).toBeNull();
    expect(getTranslatedBody('9.9.9', 'de', MAPS)).toBeNull();
    expect(getTranslatedBody('0.0.0-absent', 'ru', MAPS)).toBeNull();
  });

  it('never throws against the real bundled maps (default arg)', () => {
    expect(() => getTranslatedBody('0.0.0-absent', 'ru')).not.toThrow();
    expect(getTranslatedBody('0.0.0-absent', 'ru')).toBeNull();
  });
});
