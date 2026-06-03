import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import {
  DEFAULT_LANGUAGE_PREFERENCE,
  LANGUAGE_STORAGE_KEY,
  getBrowserLocales,
  isRtlLanguage,
  loadLanguagePreference,
  resolveDetectedLanguage,
  saveLanguagePreference,
} from './language';

describe('language preference helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to auto when no preference is saved', () => {
    expect(loadLanguagePreference()).toBe(DEFAULT_LANGUAGE_PREFERENCE);
  });

  it('persists supported manual preferences in the app-owned key', () => {
    saveLanguagePreference('zh-Hans');

    expect(localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('zh-Hans');
    expect(loadLanguagePreference()).toBe('zh-Hans');
  });

  it('ignores invalid stored preferences', () => {
    localStorage.setItem(LANGUAGE_STORAGE_KEY, 'zh');

    expect(loadLanguagePreference()).toBe('auto');
  });
});

describe('resolveDetectedLanguage', () => {
  it('uses English for English browser locales', () => {
    expect(resolveDetectedLanguage(['en-US'])).toBe('en');
  });

  it('falls back to English for unsupported non-Chinese locales', () => {
    expect(resolveDetectedLanguage(['fr-FR', 'es-ES'])).toBe('en');
  });

  it('routes region-tagged Russian and Arabic locales to their base language', () => {
    // navigator.language is usually region-tagged (ru-RU, ar-SA, …); these must
    // resolve to the base locale via the primary-subtag fallback, not fall
    // through to English.
    expect(resolveDetectedLanguage(['ru-RU'])).toBe('ru');
    expect(resolveDetectedLanguage(['ru'])).toBe('ru');
    expect(resolveDetectedLanguage(['ar-EG'])).toBe('ar');
    expect(resolveDetectedLanguage(['ar-SA'])).toBe('ar');
    expect(resolveDetectedLanguage(['ar'])).toBe('ar');
  });

  it('still falls back to English for unsupported region-tagged locales', () => {
    expect(resolveDetectedLanguage(['fr-CA'])).toBe('en');
    expect(resolveDetectedLanguage(['es-MX', 'pt-BR'])).toBe('en');
  });

  it('routes Simplified Chinese locales to Simplified Chinese', () => {
    expect(resolveDetectedLanguage(['zh-CN'])).toBe('zh-Hans');
    expect(resolveDetectedLanguage(['zh-SG'])).toBe('zh-Hans');
    expect(resolveDetectedLanguage(['zh-Hans'])).toBe('zh-Hans');
  });

  it('routes Traditional Chinese locales to the available Chinese translation until zh-Hant exists', () => {
    expect(resolveDetectedLanguage(['zh-TW'])).toBe('zh-Hans');
    expect(resolveDetectedLanguage(['zh-HK'])).toBe('zh-Hans');
    expect(resolveDetectedLanguage(['zh-MO'])).toBe('zh-Hans');
  });

  it('future-proofs Traditional Chinese once zh-Hant is available', () => {
    expect(resolveDetectedLanguage(['zh-TW'], ['en', 'zh-Hans', 'zh-Hant'])).toBe('zh-Hant');
    expect(resolveDetectedLanguage(['zh-HK'], ['en', 'zh-Hans', 'zh-Hant'])).toBe('zh-Hant');
  });

  it('falls back to English when a Chinese locale is detected but no Chinese translation is registered', () => {
    // Defensive: the zh routing resolves a *target* script (zh-Hans / zh-Hant)
    // and then checks it is actually registered. If a build shipped without any
    // Chinese resources, the zh branch must yield no match (returning null
    // internally) and let the resolver fall through to English rather than
    // returning an unavailable code.
    expect(resolveDetectedLanguage(['zh-CN'], ['en'])).toBe('en');
    expect(resolveDetectedLanguage(['zh-SG'], ['en', 'ru'])).toBe('en');
    // Even a Traditional-region locale with neither zh-Hant nor zh-Hans
    // registered must not resolve to an unavailable script.
    expect(resolveDetectedLanguage(['zh-TW'], ['en'])).toBe('en');
    // …but a later supported locale in the list is still honoured.
    expect(resolveDetectedLanguage(['zh-CN', 'ru-RU'], ['en', 'ru'])).toBe('ru');
  });

  it('checks later browser locales before falling back to English', () => {
    expect(resolveDetectedLanguage(['fr-FR', 'zh-CN'])).toBe('zh-Hans');
  });

  it('falls back to English when no browser locales are supplied', () => {
    expect(resolveDetectedLanguage([])).toBe('en');
    expect(resolveDetectedLanguage(undefined)).toBe('en');
  });

  it('matches an exact supported code without going through the english/chinese routing', () => {
    // Pre-normalised match: `en` is in SUPPORTED_LANGUAGE_CODES verbatim,
    // so it should return via the early exact-match branch instead of
    // falling through to the `en`/`en-*` routing.
    expect(resolveDetectedLanguage(['en'])).toBe('en');
  });

  it('skips whitespace-only locales without throwing or matching English', () => {
    // A blank navigator.language string (seen on some embedded WebViews)
    // normalises to '' which is not a valid locale; the resolver should
    // skip it and fall through to the English default, not crash and not
    // pretend the empty string is English.
    expect(resolveDetectedLanguage(['   '])).toBe('en');
    // And when paired with a real locale later in the list, the blank
    // entry must not short-circuit the search.
    expect(resolveDetectedLanguage(['   ', 'zh-CN'])).toBe('zh-Hans');
  });
});

describe('isRtlLanguage', () => {
  it('flags right-to-left scripts (Arabic and friends) by primary subtag', () => {
    expect(isRtlLanguage('ar')).toBe(true);
    expect(isRtlLanguage('ar-EG')).toBe(true);
    expect(isRtlLanguage('AR')).toBe(true);
    expect(isRtlLanguage('he')).toBe(true);
    expect(isRtlLanguage('fa')).toBe(true);
    expect(isRtlLanguage('ur')).toBe(true);
  });

  it('treats left-to-right locales (including the other supported ones) as LTR', () => {
    expect(isRtlLanguage('en')).toBe(false);
    expect(isRtlLanguage('ru')).toBe(false);
    expect(isRtlLanguage('zh-Hans')).toBe(false);
    expect(isRtlLanguage('zh-Hant')).toBe(false);
  });

  it('is safe for empty / nullish input', () => {
    expect(isRtlLanguage('')).toBe(false);
    expect(isRtlLanguage(null)).toBe(false);
    expect(isRtlLanguage(undefined)).toBe(false);
  });
});

describe('loadLanguagePreference when the localStorage global is hostile', () => {
  let originalDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage');
  });

  afterEach(() => {
    if (originalDescriptor) {
      Object.defineProperty(window, 'localStorage', originalDescriptor);
    }
  });

  it('returns the default preference when accessing localStorage throws', () => {
    // Some privacy modes (Safari private browsing pre-15, locked-down
    // WebViews) throw SecurityError on the very first `localStorage`
    // property access. The default-arg helper must catch that and let
    // the UI boot with the "auto" default instead of crashing the app.
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get: () => {
        throw new Error('SecurityError: localStorage access blocked');
      },
    });

    expect(loadLanguagePreference()).toBe(DEFAULT_LANGUAGE_PREFERENCE);
  });
});

describe('storage-failure resilience', () => {
  it('loadLanguagePreference returns the default when storage is unavailable', () => {
    expect(loadLanguagePreference(undefined)).toBe(DEFAULT_LANGUAGE_PREFERENCE);
  });

  it('loadLanguagePreference returns the default when storage.getItem throws', () => {
    const blocked: Storage = {
      length: 0,
      clear: () => {},
      getItem: () => { throw new Error('SecurityError: storage access blocked'); },
      key: () => null,
      removeItem: () => {},
      setItem: () => {},
    };
    expect(loadLanguagePreference(blocked)).toBe(DEFAULT_LANGUAGE_PREFERENCE);
  });

  it('saveLanguagePreference is a no-op when storage is unavailable', () => {
    expect(() => saveLanguagePreference('zh-Hans', undefined)).not.toThrow();
  });

  it('saveLanguagePreference swallows storage.setItem failures', () => {
    const writes: string[] = [];
    const blocked: Storage = {
      length: 0,
      clear: () => {},
      getItem: () => null,
      key: () => null,
      removeItem: () => {},
      setItem: () => {
        writes.push('attempted');
        throw new Error('QuotaExceededError');
      },
    };
    expect(() => saveLanguagePreference('zh-Hans', blocked)).not.toThrow();
    expect(writes).toEqual(['attempted']);
  });
});

describe('getBrowserLocales', () => {
  afterEach(() => {
    // Restore the real jsdom navigator so later suites detect the env normally.
    vi.unstubAllGlobals();
  });

  it('returns an empty list when navigator is unavailable', () => {
    // Pure node / SSR contexts that import i18n only for strings have no
    // navigator; detection must yield no locales rather than throwing.
    vi.stubGlobal('navigator', undefined);
    expect(getBrowserLocales()).toEqual([]);
  });

  it('combines navigator.languages with navigator.language and de-duplicates', () => {
    vi.stubGlobal('navigator', {
      languages: ['ru-RU', 'en-US'],
      language: 'ru-RU',
    });
    // navigator.language ('ru-RU') is already present in languages, so the
    // Set-dedupe collapses the duplicate while preserving order/first-seen.
    expect(getBrowserLocales()).toEqual(['ru-RU', 'en-US']);
  });

  it('appends navigator.language not already present in navigator.languages', () => {
    vi.stubGlobal('navigator', {
      languages: ['ar-EG'],
      language: 'fr-FR',
    });
    expect(getBrowserLocales()).toEqual(['ar-EG', 'fr-FR']);
  });

  it('drops falsy entries from navigator.languages', () => {
    vi.stubGlobal('navigator', {
      languages: ['', 'en-US', undefined],
      language: 'en-US',
    });
    // The empty string and undefined are filtered out; 'en-US' from .language
    // is a duplicate and de-duplicated away.
    expect(getBrowserLocales()).toEqual(['en-US']);
  });

  it('falls back to navigator.language when navigator.languages is not an array', () => {
    // Some WebViews expose navigator.language but not the languages array;
    // the Array.isArray guard must skip the missing list and still surface
    // the single language.
    vi.stubGlobal('navigator', {
      languages: undefined,
      language: 'zh-CN',
    });
    expect(getBrowserLocales()).toEqual(['zh-CN']);
  });

  it('returns an empty list when neither languages nor language is present', () => {
    vi.stubGlobal('navigator', {});
    expect(getBrowserLocales()).toEqual([]);
  });
});

describe('storage helpers when the localStorage global is absent', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loadLanguagePreference uses the default when localStorage is undefined', () => {
    // Node/SSR (and some hardened WebViews) have no localStorage binding at
    // all, so `typeof localStorage === 'undefined'`. The default-arg storage
    // resolver must hand back undefined and the loader must boot on "auto".
    vi.stubGlobal('localStorage', undefined);
    expect(typeof localStorage).toBe('undefined');
    expect(loadLanguagePreference()).toBe(DEFAULT_LANGUAGE_PREFERENCE);
  });

  it('saveLanguagePreference is a silent no-op when localStorage is undefined', () => {
    // Same missing-binding case for the writer: the default-arg resolver
    // returns undefined, so the guard short-circuits before touching storage
    // and the selector can never crash on an absent localStorage.
    vi.stubGlobal('localStorage', undefined);
    expect(typeof localStorage).toBe('undefined');
    expect(() => saveLanguagePreference('ru')).not.toThrow();
  });
});
