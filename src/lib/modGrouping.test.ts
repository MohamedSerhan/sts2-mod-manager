import { describe, expect, it } from 'vitest';
import { logicalModKey, modVersionSortValue } from './modGrouping';

describe('logicalModKey', () => {
  it('groups by mod id plus name, then source plus name, then name', () => {
    expect(logicalModKey({ name: 'Watcher', folder_name: 'Watcher', mod_id: 'Watcher' })).toBe('mod_id:watcher|name:watcher');
    expect(logicalModKey(
      { name: 'Lite', folder_name: 'Lite', mod_id: null },
      { name: 'Lite', source: null, github_url: null, nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/46' },
    )).toBe('source:https://www.nexusmods.com/slaythespire2/mods/46|name:lite');
    expect(logicalModKey({ name: 'Manual', folder_name: 'Manual', mod_id: null })).toBe('name:manual');
  });
});

describe('modVersionSortValue', () => {
  it('normalizes v-prefixed versions for selector sorting', () => {
    expect(modVersionSortValue('v1.4.3')).toBe('1.4.3');
    expect(modVersionSortValue('  V2.0 ')).toBe('2.0');
    expect(modVersionSortValue(null)).toBe('');
  });
});
