import { describe, expect, it } from 'vitest';
import en from './en.json';
import zhHans from './zh-Hans.json';

type LocaleTree = Record<string, unknown>;

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
  'settings.sts2App',
  'settings.sts2Exe',
  'settings.sts2Pck',
  'sourceEditor.githubPlaceholder',
  'sourceEditor.nexusPlaceholder',
  'sourceEditor.ok',
]);

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
  it('keeps Simplified Chinese keys in sync with English', () => {
    const englishKeys = flattenKeys(en).sort();
    const chineseKeys = flattenKeys(zhHans).sort();

    expect(chineseKeys.filter((key) => !englishKeys.includes(key))).toEqual([]);
    expect(englishKeys.filter((key) => !chineseKeys.includes(key))).toEqual([]);
  });

  it('does not ship copied English strings in Simplified Chinese', () => {
    const englishLeaves = flattenLeaves(en);
    const chineseLeaves = new Map(flattenLeaves(zhHans));

    const untranslated = englishLeaves
      .filter(([key, value]) => chineseLeaves.get(key) === value && !SAME_AS_ENGLISH_ALLOWED.has(key))
      .map(([key]) => key);

    expect(untranslated).toEqual([]);
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
