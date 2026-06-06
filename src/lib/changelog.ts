/**
 * Minimal CHANGELOG.md parser.
 *
 * The repo's CHANGELOG.md is bundled at build time via Vite's `?raw`
 * import, so users see whatever was in the working tree when this build
 * was produced. The parser pulls out version sections + their body text,
 * which the Home view renders as a one-shot "What's new" card.
 *
 * We deliberately keep the format tolerant — version headings look like
 * `## [1.3.3] - 2026-05-11` OR `## [Unreleased]` OR `## [1.1.x] (rollup ...)`.
 * Anything that starts with `## [` after a version-style token is treated
 * as a section start.
 */

// Vite raw-text import — bundled into the JS at build time. The path is
// relative to this file (src/lib/), so we walk up two levels to the repo
// root.
import changelogRaw from '../../CHANGELOG.md?raw';
import ruChangelog from '../i18n/changelog/ru.json';
import arChangelog from '../i18n/changelog/ar.json';
import zhHansChangelog from '../i18n/changelog/zh-Hans.json';

/** The locales we ship bundled changelog translations for. */
type TranslationKey = 'ru' | 'ar' | 'zh-Hans';

/** Bundled per-locale translation maps: version string → translated markdown
 *  body. Generated at release time by scripts/translate-changelog.mjs. Partial
 *  so the type also models injected test maps that omit some locales. */
type ChangelogTranslations = Partial<Record<TranslationKey, Record<string, string>>>;
const BUNDLED_TRANSLATIONS: ChangelogTranslations = {
  ru: ruChangelog as Record<string, string>,
  ar: arChangelog as Record<string, string>,
  'zh-Hans': zhHansChangelog as Record<string, string>,
};

/** Map an i18n language code to a translation-file key, or null if there is no
 *  bundled translation for it (English, or an unsupported locale). */
function translationKeyForLocale(locale: string): TranslationKey | null {
  if (locale.startsWith('en')) return null;
  // No zh-Hant bundle yet — Traditional Chinese falls back to Simplified.
  if (locale.startsWith('zh')) return 'zh-Hans';
  const base = locale.split('-')[0];
  if (base === 'ru') return 'ru';
  if (base === 'ar') return 'ar';
  return null;
}

export interface ChangelogEntry {
  /** Raw version string from the heading — e.g. "1.3.3", "Unreleased",
   *  "1.1.x". May not parse as semver. */
  version: string;
  /** ISO-ish date string from the heading, when present. */
  date: string | null;
  /** Markdown body of the section (everything between this heading and
   *  the next `## [` heading). Already trimmed of leading/trailing
   *  whitespace. */
  body: string;
}

const HEADING_RE = /^##\s+\[([^\]]+)\](?:\s*-\s*([0-9]{4}-[0-9]{2}-[0-9]{2}))?/;

/** Parse the bundled CHANGELOG.md into entries. */
export function parseChangelog(raw: string = changelogRaw): ChangelogEntry[] {
  const lines = raw.split(/\r?\n/);
  const entries: ChangelogEntry[] = [];

  let current: ChangelogEntry | null = null;
  let buf: string[] = [];

  function flush() {
    if (!current) return;
    current.body = buf.join('\n').trim();
    entries.push(current);
    current = null;
    buf = [];
  }

  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      current = { version: m[1], date: m[2] ?? null, body: '' };
      continue;
    }
    if (current) buf.push(line);
  }
  flush();

  // Drop the link-reference footer (those are also `## [x]` shapes but
  // with no body — they tend to come at the end of the file). Defensive:
  // a real entry always has at least one non-empty body line.
  return entries.filter((e) => e.body.length > 0);
}

/** The latest *released* entry — i.e. skips `[Unreleased]`. Used by the
 *  in-app "What's new" card so users see their version's notes, not
 *  in-progress content. */
export function getLatestReleasedEntry(): ChangelogEntry | null {
  const all = parseChangelog();
  return all.find((e) => e.version.toLowerCase() !== 'unreleased') ?? null;
}

/** Look up a specific version's entry, or null if not in the changelog. */
export function getEntryForVersion(version: string): ChangelogEntry | null {
  const target = version.replace(/^v/i, '');
  return parseChangelog().find((e) => e.version === target) ?? null;
}

/** All entries newest-first (the file's natural order). */
export function getAllEntries(): ChangelogEntry[] {
  return parseChangelog();
}

/** Machine-translated markdown body for a changelog version in a given locale,
 *  or null when there is no translation (English locale, unsupported locale,
 *  version not translated, or a malformed map). Never throws — callers fall
 *  back to the English body. The `maps` arg is injectable for tests; the
 *  default is the bundled per-locale data. */
export function getTranslatedBody(
  version: string,
  locale: string,
  maps: ChangelogTranslations = BUNDLED_TRANSLATIONS,
): string | null {
  try {
    const key = translationKeyForLocale(locale);
    if (!key) return null;
    const body = maps[key]?.[version];
    return typeof body === 'string' && body.length > 0 ? body : null;
  } catch {
    return null;
  }
}
