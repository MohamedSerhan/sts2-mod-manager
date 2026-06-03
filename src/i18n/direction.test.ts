import { afterEach, describe, expect, it } from 'vitest';
import i18n, { applyDocumentDirection } from '.';

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
