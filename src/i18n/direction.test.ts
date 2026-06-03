import { afterEach, describe, expect, it, vi } from 'vitest';
import i18n, { applyDocumentDirection, resolveLanguagePreference } from '.';

// Verifies the RTL wiring added for Arabic: applyDocumentDirection mirrors the
// <html> dir/lang attributes off the active locale, and the languageChanged
// listener registered in ./index keeps them in sync on every switch.
describe('document direction (RTL)', () => {
  afterEach(async () => {
    // Leave the shared jsdom document back in the LTR default so this suite
    // can't leak dir="rtl" into others. (setup.ts also resets to 'en' before
    // each test, but be explicit since we mutate documentElement directly.)
    await i18n.changeLanguage('en');
  });

  it('sets dir="rtl" + lang for Arabic and flips back to ltr otherwise', () => {
    applyDocumentDirection('ar');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('ar');

    applyDocumentDirection('en');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('en');

    // A non-English LTR locale stays left-to-right.
    applyDocumentDirection('zh-Hans');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('zh-Hans');
  });

  it('flips the document direction when the active language changes', async () => {
    await i18n.changeLanguage('ar');
    expect(document.documentElement.getAttribute('dir')).toBe('rtl');
    expect(document.documentElement.getAttribute('lang')).toBe('ar');

    await i18n.changeLanguage('ru');
    expect(document.documentElement.getAttribute('dir')).toBe('ltr');
    expect(document.documentElement.getAttribute('lang')).toBe('ru');
  });
});

describe('resolveLanguagePreference', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a manual preference verbatim without consulting the browser', () => {
    // The non-"auto" branch must short-circuit detection entirely: even with a
    // browser that would auto-detect Arabic, an explicit choice wins.
    vi.stubGlobal('navigator', { languages: ['ar-EG'], language: 'ar-EG' });
    expect(resolveLanguagePreference('ru')).toBe('ru');
    expect(resolveLanguagePreference('zh-Hans')).toBe('zh-Hans');
    expect(resolveLanguagePreference('en')).toBe('en');
  });

  it('detects from the browser locales when the preference is "auto"', () => {
    // The "auto" branch routes through getBrowserLocales → resolveDetectedLanguage.
    vi.stubGlobal('navigator', { languages: ['ru-RU'], language: 'ru-RU' });
    expect(resolveLanguagePreference('auto')).toBe('ru');

    vi.stubGlobal('navigator', { languages: ['fr-FR'], language: 'fr-FR' });
    expect(resolveLanguagePreference('auto')).toBe('en');
  });
});

describe('applyDocumentDirection without a DOM', () => {
  afterEach(() => {
    // Restore the real jsdom document immediately so neither this suite's other
    // hooks nor later suites observe the stubbed-away global.
    vi.unstubAllGlobals();
  });

  it('is a no-op when document is undefined (node/SSR string-only import)', () => {
    // i18n is sometimes imported purely for its translations in a non-DOM
    // context. applyDocumentDirection must detect the missing `document`
    // global and return without throwing instead of dereferencing
    // documentElement.
    vi.stubGlobal('document', undefined);
    expect(typeof document).toBe('undefined');
    expect(() => applyDocumentDirection('ar')).not.toThrow();
  });
});
