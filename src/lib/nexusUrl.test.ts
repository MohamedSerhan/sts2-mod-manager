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
});
