// Lightweight typo-tolerant fuzzy matcher used by the Browse search rerank.
//
// We don't need a full Lucene-grade scorer here — the GitHub API already
// did the heavy lifting (page-level recall). Our job is to take the
// returned list and surface the rows that best match what the user typed
// even when:
//   - they typed only part of a name ("auto" should rank "autopath-sts2"
//     above mods whose only "auto" hit is in a long readme),
//   - they made a typo ("autopth" should still find autopath).
//
// The scoring is intentionally simple:
//   1. Tokenize both query and target on non-alphanumerics.
//   2. For each query token, find the best-scoring token in the target
//      via exact / prefix / substring / Damerau-Levenshtein-distance ≤ 2.
//   3. Weight matches in the repo's name far above matches in description.

/**
 * Damerau–Levenshtein distance with an early-out cap. Returns Infinity if
 * the distance exceeds `cap` so callers can short-circuit comparisons that
 * are definitely too far off.
 */
export function damerauLevenshtein(a: string, b: string, cap = 3): number {
  if (a === b) return 0;
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > cap) return Infinity;
  if (al === 0) return bl;
  if (bl === 0) return al;

  // Two-row dynamic programming table — we only need the previous two
  // rows to compute the current one (Damerau adds the transposition step).
  let prev2: number[] = new Array(bl + 1).fill(0);
  let prev: number[] = new Array(bl + 1).fill(0);
  let curr: number[] = new Array(bl + 1).fill(0);
  for (let j = 0; j <= bl; j++) prev[j] = j;

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,        // insertion
        prev[j] + 1,            // deletion
        prev[j - 1] + cost,     // substitution
      );
      // transposition (Damerau)
      if (
        i > 1 &&
        j > 1 &&
        a.charCodeAt(i - 1) === b.charCodeAt(j - 2) &&
        a.charCodeAt(i - 2) === b.charCodeAt(j - 1)
      ) {
        curr[j] = Math.min(curr[j], prev2[j - 2] + 1);
      }
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > cap) return Infinity;
    [prev2, prev, curr] = [prev, curr, prev2];
  }
  return prev[bl];
}

/** Lowercase + split on non-alphanumerics, stripping empties. */
export function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean);
}

/**
 * Score how well `target` (a string composed of multiple words) matches
 * the user's `query` tokens. Higher is better; 0 means nothing matched
 * within tolerance.
 */
export function fuzzyScore(query: string, target: string): number {
  const qTokens = tokenize(query);
  if (qTokens.length === 0) return 0;
  const tTokens = tokenize(target);
  if (tTokens.length === 0) return 0;

  let total = 0;
  for (const q of qTokens) {
    let best = 0;
    for (const t of tTokens) {
      let s = 0;
      if (t === q) s = 100;
      else if (t.startsWith(q)) s = 80;
      else if (t.includes(q)) s = 60;
      else {
        // Tolerate small typos. Cap at 2 edits — anything more is a
        // different word, not a typo.
        const cap = q.length >= 6 ? 2 : 1;
        const d = damerauLevenshtein(q, t, cap);
        if (d !== Infinity) s = Math.max(0, 50 - d * 15);
      }
      if (s > best) best = s;
    }
    total += best;
  }
  return total;
}

/**
 * Rerank an array of items by fuzzy relevance to `query`.
 *
 * `getText` returns one or more strings to score against per item. Strings
 * earlier in the returned array carry more weight (3x for the first, 2x
 * for the second, 1x for the rest) so a hit in the repo's name beats one
 * in its description.
 *
 * Items scoring 0 against ALL fields are dropped — they didn't match in
 * any tolerable way and would be noise.
 */
export function fuzzyRerank<T>(
  items: T[],
  query: string,
  getText: (item: T) => string[],
): T[] {
  if (!query.trim()) return items;
  const weights = [3, 2, 1];
  const scored = items.map((item) => {
    const fields = getText(item);
    let score = 0;
    fields.forEach((f, i) => {
      const w = weights[i] ?? 1;
      score += w * fuzzyScore(query, f);
    });
    return { item, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.filter((s) => s.score > 0).map((s) => s.item);
}
