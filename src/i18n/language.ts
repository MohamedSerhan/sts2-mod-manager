export const LANGUAGE_STORAGE_KEY = 'sts2mm-language';
export const DEFAULT_LANGUAGE = 'en';
export const DEFAULT_LANGUAGE_PREFERENCE = 'auto';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', labelKey: 'settings.language.en' },
  { code: 'zh-Hans', labelKey: 'settings.language.zhHans' },
] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];
export type LanguagePreference = SupportedLanguageCode | typeof DEFAULT_LANGUAGE_PREFERENCE;

export const SUPPORTED_LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((language) => language.code);
const TRADITIONAL_CHINESE_REGIONS = new Set(['tw', 'hk', 'mo']);

export function isSupportedLanguagePreference(value: string | null): value is LanguagePreference {
  return value === DEFAULT_LANGUAGE_PREFERENCE || SUPPORTED_LANGUAGE_CODES.includes(value as SupportedLanguageCode);
}

export function loadLanguagePreference(storage: Storage | undefined = getStorage()): LanguagePreference {
  if (!storage) return DEFAULT_LANGUAGE_PREFERENCE;
  try {
    const saved = storage.getItem(LANGUAGE_STORAGE_KEY);
    return isSupportedLanguagePreference(saved) ? saved : DEFAULT_LANGUAGE_PREFERENCE;
  } catch {
    return DEFAULT_LANGUAGE_PREFERENCE;
  }
}

export function saveLanguagePreference(
  preference: LanguagePreference,
  storage: Storage | undefined = getStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    // A blocked storage write should not make the language selector crash.
  }
}

export function resolveDetectedLanguage(
  locales: readonly string[] | undefined,
  availableLanguages: readonly string[] = SUPPORTED_LANGUAGE_CODES,
): SupportedLanguageCode {
  for (const locale of locales ?? []) {
    const resolved = resolveOneLocale(locale, availableLanguages);
    if (resolved) return resolved;
  }
  return DEFAULT_LANGUAGE;
}

export function getBrowserLocales(): string[] {
  if (typeof navigator === 'undefined') return [];
  const languages = Array.isArray(navigator.languages) ? navigator.languages.filter(Boolean) : [];
  if (navigator.language) languages.push(navigator.language);
  return [...new Set(languages)];
}

function resolveOneLocale(locale: string, availableLanguages: readonly string[]): SupportedLanguageCode | null {
  const normalized = normalizeLocale(locale);
  if (!normalized) return null;

  if (availableLanguages.includes(normalized)) {
    return normalized as SupportedLanguageCode;
  }
  if (normalized === 'en' || normalized.startsWith('en-')) {
    return 'en';
  }
  if (normalized === 'zh' || normalized.startsWith('zh-')) {
    const target = isTraditionalChineseLocale(normalized) && availableLanguages.includes('zh-Hant')
      ? 'zh-Hant'
      : 'zh-Hans';
    return availableLanguages.includes(target) ? target as SupportedLanguageCode : null;
  }
  return null;
}

function normalizeLocale(locale: string): string {
  return locale.trim().replace(/_/g, '-').toLowerCase();
}

function isTraditionalChineseLocale(locale: string): boolean {
  const parts = locale.split('-');
  return parts.includes('hant') || parts.some((part) => TRADITIONAL_CHINESE_REGIONS.has(part));
}

function getStorage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
}
