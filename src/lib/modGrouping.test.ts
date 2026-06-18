import { describe, expect, it } from 'vitest';
import { logicalModKey, modVersionSortValue } from './modGrouping';

describe('logicalModKey', () => {
  it('groups by mod id, then source plus name, then name', () => {
    expect(logicalModKey({ name: 'Watcher', folder_name: 'Watcher', mod_id: 'Watcher' })).toBe('mod_id:watcher');
    expect(logicalModKey(
      { name: 'Lite', folder_name: 'Lite', mod_id: null },
      { name: 'Lite', source: null, github_url: null, nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/46' },
    )).toBe('source:https://www.nexusmods.com/slaythespire2/mods/46|name:lite');
    expect(logicalModKey({ name: 'Manual', folder_name: 'Manual', mod_id: null })).toBe('name:manual');
  });

  it('keeps locally installed versions grouped when their display names drift', () => {
    expect(logicalModKey(
      { name: 'StS2 Card Advisor', folder_name: 'Sts2CardAdvisor', mod_id: 'Sts2CardAdvisor' },
    )).toBe(logicalModKey(
      { name: 'Card Advisor', folder_name: 'Sts2CardAdvisor-v29', mod_id: 'Sts2CardAdvisor' },
    ));
  });

  it('keeps bundle containers separate from member runtime IDs', () => {
    const bundleKey = logicalModKey(
      { name: 'Pretty Pack', folder_name: 'PrettyPack', mod_id: null },
      {
        name: 'Pretty Pack',
        source: null,
        github_url: null,
        nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/979',
      },
    );
    const memberKey = logicalModKey({ name: 'BaseLib', folder_name: 'BaseLib', mod_id: 'BaseLib' });

    expect(bundleKey).toBe('source:https://www.nexusmods.com/slaythespire2/mods/979|name:pretty pack');
    expect(bundleKey).not.toBe(memberKey);
  });
});

describe('modVersionSortValue', () => {
  it('normalizes v-prefixed versions for selector sorting', () => {
    expect(modVersionSortValue('v1.4.3')).toBe('1.4.3');
    expect(modVersionSortValue('  V2.0 ')).toBe('2.0');
    expect(modVersionSortValue(null)).toBe('');
  });
});
