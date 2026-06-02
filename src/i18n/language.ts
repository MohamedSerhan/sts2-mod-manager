export const LANGUAGE_STORAGE_KEY = 'sts2mm-language';
export const DEFAULT_LANGUAGE = 'en';
export const DEFAULT_LANGUAGE_PREFERENCE = 'auto';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', labelKey: 'settings.language.en' },
  { code: 'zh-Hans', labelKey: 'settings.language.zhHans' },
  { code: 'ru', labelKey: 'settings.language.ru' },
  { code: 'ar', labelKey: 'settings.language.ar' },
] as const;

export type SupportedLanguageCode = (typeof SUPPORTED_LANGUAGES)[number]['code'];
export type LanguagePreference = SupportedLanguageCode | typeof DEFAULT_LANGUAGE_PREFERENCE;

export const SUPPORTED_LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((language) => language.code);
const TRADITIONAL_CHINESE_REGIONS = new Set(['tw', 'hk', 'mo']);

// Languages whose script is written right-to-left. Keyed by the primary subtag
// so `ar`, `ar-EG`, etc. all resolve to RTL even though only exact codes are
// registered in SUPPORTED_LANGUAGES. Drives the document `dir` attribute via
// applyDocumentDirection in ./index.
const RTL_LANGUAGE_SUBTAGS = new Set(['ar', 'he', 'fa', 'ur']);

export function isRtlLanguage(code: string | null | undefined): boolean {
  if (!code) return false;
  const base = code.trim().toLowerCase().split('-')[0];
  return RTL_LANGUAGE_SUBTAGS.has(base);
}

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
