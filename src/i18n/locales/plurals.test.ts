import { describe, expect, it, beforeAll } from 'vitest';
import i18next, { type i18n } from 'i18next';
import ru from './ru.json';

// Regression for #136. Russian has three count buckets — one / few / many —
// but the locale only carried `_one` / `_other`, so n = 2..4 (few) and n = 5+
// (many) fell through to the English resource: "2 mods" rendered inside an
// otherwise-Russian UI. Adding `_few` / `_many` makes i18next's CLDR plural
// resolution pick the right Russian form.
describe('Russian plural resolution (#136)', () => {
  let render: (n: number, key?: string) => string;

  beforeAll(async () => {
    const inst: i18n = i18next.createInstance();
    await inst.init({
      lng: 'ru',
      fallbackLng: 'en',
      resources: { ru: { translation: ru } },
      interpolation: { escapeValue: false },
    });
    render = (n, key = 'home.heroModCount') => inst.t(key, { count: n });
  });

  it('picks one / few / many for the mod count', () => {
    expect(render(1)).toBe('1 мод'); // one
    expect(render(2)).toBe('2 мода'); // few
    expect(render(4)).toBe('4 мода'); // few
    expect(render(5)).toBe('5 модов'); // many
    expect(render(11)).toBe('11 модов'); // many — teens
    expect(render(21)).toBe('21 мод'); // one — n%10==1, n%100!=11
    expect(render(22)).toBe('22 мода'); // few
    expect(render(25)).toBe('25 модов'); // many
  });

  it('no longer leaks the English string for few/many counts', () => {
    // The Latin word "mod(s)" must never appear in the Russian render.
    for (const n of [0, 2, 3, 5, 8, 12, 100]) {
      expect(render(n)).not.toMatch(/mod/i);
    }
  });

  it('applies the same buckets to bundle.memberCount', () => {
    expect(render(1, 'bundle.memberCount')).toBe('1 мод');
    expect(render(3, 'bundle.memberCount')).toBe('3 мода');
    expect(render(8, 'bundle.memberCount')).toBe('8 модов');
  });
});
