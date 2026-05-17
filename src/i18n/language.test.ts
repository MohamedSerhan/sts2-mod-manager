import { describe, expect, it, beforeEach } from 'vitest';
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
});
