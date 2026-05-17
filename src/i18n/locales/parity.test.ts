import { describe, expect, it } from 'vitest';
import en from './en.json';
import zhHans from './zh-Hans.json';

type LocaleTree = Record<string, unknown>;

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value as LocaleTree).flatMap(([key, child]) => {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    return flattenKeys(child, childPrefix);
  });
}

describe('locale resources', () => {
  it('keeps Simplified Chinese keys in sync with English', () => {
    const englishKeys = flattenKeys(en).sort();
    const chineseKeys = flattenKeys(zhHans).sort();

    expect(chineseKeys.filter((key) => !englishKeys.includes(key))).toEqual([]);
    expect(englishKeys.filter((key) => !chineseKeys.includes(key))).toEqual([]);
  });
});
