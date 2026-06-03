import { describe, expect, it } from 'vitest';

import { isNexusModsHost, nexusFilesUrl, parseNexusModInput } from './nexusUrl';

describe('nexus URL helpers', () => {
  it.each([
    [
      'https://www.nexusmods.com/slaythespire2/mods/42',
      'https://www.nexusmods.com/slaythespire2/mods/42?tab=files',
    ],
    [
      'https://nexusmods.com/sts2/mods/123',
      'https://www.nexusmods.com/sts2/mods/123?tab=files',
    ],
    [
      'nexusmods.com/sts2/mods/123',
      'https://www.nexusmods.com/sts2/mods/123?tab=files',
    ],
    [
      'nexus:slaythespire2/mods/99',
      'https://www.nexusmods.com/slaythespire2/mods/99?tab=files',
    ],
  ])('builds the Nexus files-tab URL for %s', (input, expected) => {
    expect(nexusFilesUrl(input)).toBe(expected);
  });

  it.each([
    'https://nexusmods.com.evil.test/sts2/mods/1',
    'https://evil.test/nexusmods.com/sts2/mods/1',
    'https://evilnexusmods.com/sts2/mods/1',
    'https://www.nexusmods.com/sts2/mods/not-a-number',
    'https://www.nexusmods.com/sts2%2Fevil/mods/1',
    'nexus:../mods/1',
  ])('rejects spoofed or malformed Nexus input %s', (input) => {
    expect(parseNexusModInput(input)).toBeNull();
    expect(nexusFilesUrl(input)).toBeNull();
  });

  it('only allowlists the Nexus root and www hostnames', () => {
    expect(isNexusModsHost('nexusmods.com')).toBe(true);
    expect(isNexusModsHost('www.nexusmods.com')).toBe(true);
    expect(isNexusModsHost('nexusmods.com.evil.test')).toBe(false);
  });

  it.each([
    '',           // empty
    '   ',        // whitespace only
  ])('returns null for empty/whitespace input %p', (input) => {
    // Hits the `if (!trimmed) return null` early-out before any matching.
    expect(parseNexusModInput(input)).toBeNull();
    expect(nexusFilesUrl(input)).toBeNull();
  });

  it.each([
    'just some text',                 // not a URL, not nexusmods.com/...
    'https://github.com/owner/repo',  // a real URL but wrong host shape for the shorthand
    'ftp://nexusmods.com/sts2/mods/1',// scheme not matched by normalizeUrlInput's http(s) test
  ])('returns null when the input is neither a known URL nor shorthand: %s', (input) => {
    // Falls through normalizeUrlInput → null (the `return null` for
    // inputs that don't start with http(s):// or (www.)nexusmods.com/).
    expect(parseNexusModInput(input)).toBeNull();
  });

  it.each([
    'http://',                        // valid scheme prefix but malformed URL → new URL throws
    'https://',
  ])('returns null when the URL constructor throws on %s', (input) => {
    // Passes normalizeUrlInput (starts with http(s)://) but `new URL()`
    // throws on the bare authority, exercising the catch branch.
    expect(parseNexusModInput(input)).toBeNull();
    expect(nexusFilesUrl(input)).toBeNull();
  });
});
