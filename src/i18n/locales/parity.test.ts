import { describe, expect, it } from 'vitest';
import en from './en.json';
import zhHans from './zh-Hans.json';
import ru from './ru.json';
import ar from './ar.json';

type LocaleTree = Record<string, unknown>;

// Brand names, file paths, placeholders, acronyms and language endonyms that
// intentionally stay identical across every locale. Shared by the copied-prose
// check for all non-English locales — a value listed here is allowed to match
// English in any of them (e.g. "GitHub", "Nexus", "OK", "Русский", "العربية").
const SAME_AS_ENGLISH_ALLOWED = new Set([
  'app.devBadge',        // DEV is an acronym — intentionally identical across locales
  'app.vanillaInitials',
  'browse.tabs.github',
  'browseDetail.github',
  'browseDetail.nexus',
  'modpacks.quickAdd.placeholder',
  'mods.gitHub',
  'mods.nexus',
  'mods.notePrefix',
  'onboarding.step1.browsePlaceholderLinux',
  'onboarding.step1.browsePlaceholderMac',
  'onboarding.step1.browsePlaceholderWindows',
  'profiles.form.jsonPlaceholder',
  'quickAdd.gitHubPill',
  'quickAdd.nexusPill',
  'quickAdd.urlPlaceholder',
  'settings.defaultPathLinux',
  'settings.defaultPathMac',
  'settings.defaultPathWin',
  'settings.language.en',
  'settings.language.zh',
  'settings.language.ru',  // endonym — shown identically in every locale's picker
  'settings.language.ar',  // endonym — shown identically in every locale's picker
  'settings.sts2App',
  'settings.sts2Exe',
  'settings.sts2Pck',
  'sourceEditor.githubPlaceholder',
  'sourceEditor.nexusPlaceholder',
  'sourceEditor.ok',
]);

// Every non-English locale that must stay key-for-key in sync with en.json.
// Russian and Arabic are AI-generated and pending human verification (see the
// PR description) — that does not exempt them from the parity gate: they must
// match en's key set exactly and must not ship copied English prose.
const NON_ENGLISH_LOCALES: ReadonlyArray<readonly [string, unknown]> = [
  ['Simplified Chinese', zhHans],
  ['Russian', ru],
  ['Arabic', ar],
];

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value as LocaleTree).flatMap(([key, child]) => {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    return flattenKeys(child, childPrefix);
  });
}

function flattenLeaves(value: unknown, prefix = ''): [string, string][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [[prefix, String(value)]] : [];
  }

  return Object.entries(value as LocaleTree).flatMap(([key, child]) => {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    return flattenLeaves(child, childPrefix);
  });
}

describe('locale resources', () => {
  const englishKeys = flattenKeys(en).sort();
  const englishLeaves = flattenLeaves(en);

  describe.each(NON_ENGLISH_LOCALES)('%s', (_name, locale) => {
    it('keeps its keys in sync with English', () => {
      const localeKeys = flattenKeys(locale).sort();

      expect(localeKeys.filter((key) => !englishKeys.includes(key))).toEqual([]);
      expect(englishKeys.filter((key) => !localeKeys.includes(key))).toEqual([]);
    });

    it('does not ship copied English strings', () => {
      const localeLeaves = new Map(flattenLeaves(locale));

      const untranslated = englishLeaves
        .filter(([key, value]) => localeLeaves.get(key) === value && !SAME_AS_ENGLISH_ALLOWED.has(key))
        .map(([key]) => key);

      expect(untranslated).toEqual([]);
    });
  });

  it('uses i18next plural resolution instead of manual suffix branching', () => {
    const sources = import.meta.glob('../../**/*.{ts,tsx}', {
      query: '?raw',
      import: 'default',
      eager: true,
    }) as Record<string, string>;
    const offenders = Object.entries(sources)
      .filter(([file]) => !file.includes('/__test__/') && !file.includes('.test.'))
      .filter(([, source]) => /t\(\s*['"][^'"]+_(?:one|other)['"]/.test(source))
      .map(([file]) => file.replace(/^\.\.\/\.\.\//, ''))
      .sort();

    expect(offenders).toEqual([]);
  });
});
