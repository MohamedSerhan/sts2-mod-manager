import { describe, expect, it } from 'vitest';

import {
  buildShareLink,
  buildShareMessage,
  canonicalShareCode,
  prettyShareCode,
} from './shareImport';

describe('canonicalShareCode', () => {
  it.each([
    ['jess/AA5A-315D-61AE',                      'jess/aa5a315d61ae'],
    ['jess/aa5a315d61ae',                        'jess/aa5a315d61ae'],
    ['JESS/aa5a-315d-61ae',                      'jess/aa5a315d61ae'],
    ['sts2mm://import/jess/AA5A-315D-61AE',      'jess/aa5a315d61ae'],
    ['sts2mm://install/JESS/AA5A-315D-61AE',     'jess/aa5a315d61ae'],
  ])('canonicalizes %s', (input, expected) => {
    expect(canonicalShareCode(input)).toBe(expected);
  });

  it.each([
    ['', null],
    ['nope', null],
    ['/just-code', null],          // empty owner
    ['owner/', null],              // empty code
    ['just owner no slash', null], // missing slash
  ])('returns null for invalid %s', (input, expected) => {
    expect(canonicalShareCode(input)).toBe(expected);
  });

  it('strips ?query and #fragment garbage', () => {
    expect(canonicalShareCode('jess/AA5A-315D-61AE?ref=discord')).toBe('jess/aa5a315d61ae');
    expect(canonicalShareCode('jess/AA5A-315D-61AE#x')).toBe('jess/aa5a315d61ae');
  });

  it('trims whitespace', () => {
    expect(canonicalShareCode('  jess/AA5A-315D-61AE  ')).toBe('jess/aa5a315d61ae');
  });
});

describe('prettyShareCode', () => {
  it('reformats a 12-character code as AAAA-BBBB-CCCC, uppercased', () => {
    expect(prettyShareCode('jess/aa5a315d61ae')).toBe('jess/AA5A-315D-61AE');
  });

  it('leaves short codes alone (uppercased)', () => {
    expect(prettyShareCode('jess/short')).toBe('jess/SHORT');
  });

  it('returns input as-is when there is no slash', () => {
    expect(prettyShareCode('weirdinput')).toBe('weirdinput');
  });
});

describe('buildShareLink', () => {
  it('encodes the code into a c= query param under the install bridge', () => {
    const link = buildShareLink('jess/AA5A-315D-61AE');
    expect(link).toBe('https://mohamedserhan.github.io/sts2-mod-manager/i.html?c=jess%2FAA5A-315D-61AE');
  });

  it('round-trips unicode owners cleanly', () => {
    const link = buildShareLink('jess-😀/AA5A');
    expect(link).toContain('?c=');
    expect(decodeURIComponent(link.split('?c=')[1])).toBe('jess-😀/AA5A');
  });
});

describe('buildShareMessage', () => {
  it('includes pack name + link + code', () => {
    const msg = buildShareMessage('Daily Pack', 'jess/AA5A-315D-61AE');
    expect(msg).toContain('Daily Pack');
    expect(msg).toContain('jess/AA5A-315D-61AE');
    expect(msg).toContain(buildShareLink('jess/AA5A-315D-61AE'));
  });
});
