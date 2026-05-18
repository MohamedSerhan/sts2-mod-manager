import { afterEach, describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_LANGUAGE_PREFERENCE,
  LANGUAGE_STORAGE_KEY,
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
