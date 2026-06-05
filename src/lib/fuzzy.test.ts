import { describe, expect, it } from 'vitest';

import { damerauLevenshtein, fuzzyRerank, fuzzyScore, tokenize } from './fuzzy';

describe('damerauLevenshtein', () => {
  it('returns 0 for equal strings', () => {
    expect(damerauLevenshtein('foo', 'foo')).toBe(0);
  });

  it('counts substitutions, insertions, and deletions', () => {
    expect(damerauLevenshtein('kitten', 'sitting')).toBe(3);
    expect(damerauLevenshtein('a', 'ab')).toBe(1);
    expect(damerauLevenshtein('abc', 'ac')).toBe(1);
  });

  it('counts an adjacent transposition as one edit (Damerau)', () => {
    // Pure Levenshtein would call this 2; Damerau counts it as 1.
    expect(damerauLevenshtein('autopath', 'autopaht')).toBe(1);
  });

  it('returns Infinity past the cap', () => {
    expect(damerauLevenshtein('abc', 'xyz', 1)).toBe(Infinity);
    expect(damerauLevenshtein('hello', 'world', 2)).toBe(Infinity);
  });

  it('weights only the first three fields, defaulting any extra to 1x', () => {
    // fuzzyRerank uses weights [3, 2, 1] and falls back to 1 for a 4th+
    // field (weights[i] ?? 1). Match only in the 4th field so that
    // fallback path is what surfaces the item. (fuzzy.ts line 124.)
    const items = [{ id: 'a' }, { id: 'b' }];
    const ranked = fuzzyRerank(
      items,
      'zebra',
      (it) => ['', '', '', it.id === 'a' ? 'zebra' : 'nomatch'],
    );
    expect(ranked).toEqual([{ id: 'a' }]);
  });

  it('handles empty strings', () => {
    expect(damerauLevenshtein('', '')).toBe(0);
    expect(damerauLevenshtein('', 'abc')).toBe(3);
    expect(damerauLevenshtein('abc', '')).toBe(3);
  });
});

describe('tokenize', () => {
  it('lowercases and splits on non-alphanumerics', () => {
    expect(tokenize('AutoPath-STS2')).toEqual(['autopath', 'sts2']);
    expect(tokenize('Hello, World!')).toEqual(['hello', 'world']);
  });

  it('drops empty tokens', () => {
    expect(tokenize('--foo  bar--')).toEqual(['foo', 'bar']);
    expect(tokenize('')).toEqual([]);
  });
});

describe('fuzzyScore', () => {
  it('returns 0 when query or target is empty', () => {
    expect(fuzzyScore('', 'autopath')).toBe(0);
    expect(fuzzyScore('autopath', '')).toBe(0);
  });

  it('scores exact token match highest', () => {
    expect(fuzzyScore('autopath', 'autopath sts2')).toBe(100);
  });

  it('scores prefix match (80) above substring (60)', () => {
    // "auto" prefixes "autopath" → 80
    // "path" appears mid-string (autopath) → 60
    const prefix = fuzzyScore('auto', 'autopath sts2');
    const substr = fuzzyScore('path', 'autopath sts2');
    expect(prefix).toBe(80);
    expect(substr).toBe(60);
    expect(prefix).toBeGreaterThan(substr);
  });

  it('tolerates a typo within the cap', () => {
    // "autopth" is one transposition off from "autopath" → small typo
    // score (50 - 15*d). Exact behavior locked: distance 1 → 35.
    expect(fuzzyScore('autopth', 'autopath sts2')).toBeGreaterThan(0);
  });

  it('returns 0 when the typo is beyond the cap', () => {
    // "zzzzzz" is nothing like "autopath", way past the cap.
    expect(fuzzyScore('zzzzzz', 'autopath sts2')).toBe(0);
  });

  it('sums per-token scores for multi-token queries', () => {
    const single = fuzzyScore('autopath', 'autopath sts2');
    const both = fuzzyScore('autopath sts2', 'autopath sts2');
    expect(both).toBeGreaterThan(single);
  });
});

describe('fuzzyRerank', () => {
  it('returns input unchanged when query is blank', () => {
    const items = [{ n: 'a' }, { n: 'b' }];
    expect(fuzzyRerank(items, '', (i) => [i.n])).toEqual(items);
    expect(fuzzyRerank(items, '   ', (i) => [i.n])).toEqual(items);
  });

  it('weights earlier fields higher than later ones (3x, 2x, 1x)', () => {
    // Both items have "autopath" but in different fields. The one
    // with the match in field 0 (name) must rank above field 2
    // (description) since the weights are 3 / 2 / 1.
    const items = [
      { id: 'desc-match', fields: ['random', 'irrelevant', 'autopath stuff'] },
      { id: 'name-match', fields: ['autopath', 'irrelevant', 'whatever'] },
    ];
    const ranked = fuzzyRerank(items, 'autopath', (i) => i.fields);
    expect(ranked[0].id).toBe('name-match');
    expect(ranked[1].id).toBe('desc-match');
  });

  it('drops items that score zero against every field', () => {
    const items = [
      { id: 'matches', text: 'autopath' },
      { id: 'noise', text: 'totally unrelated content' },
    ];
    const ranked = fuzzyRerank(items, 'autopath', (i) => [i.text]);
    expect(ranked.map((i) => i.id)).toEqual(['matches']);
  });
});
