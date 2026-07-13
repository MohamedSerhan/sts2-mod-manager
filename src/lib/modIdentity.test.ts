import { describe, expect, it } from 'vitest';

import { identitiesMatch, identityKeys, strongIdentityKeys } from './modIdentity';

describe('mod identity helpers', () => {
  it('normalizes identity keys and skips empty values', () => {
    expect(
      identityKeys({
        folder_name: '  ModFolder  ',
        mod_id: '',
        name: ' Display Name ',
      }),
    ).toEqual(['modfolder', 'display name']);
  });

  it('deduplicates repeated identity keys', () => {
    expect(
      identityKeys({
        folder_name: 'Same',
        mod_id: 'same',
        name: 'SAME',
      }),
    ).toEqual(['same']);
  });

  it('keeps strong identity keys separate from display names', () => {
    expect(
      strongIdentityKeys({
        folder_name: 'Folder',
        mod_id: 'ModId',
        name: 'Display',
      }),
    ).toEqual(['folder', 'modid']);
  });

  it('matches on strong keys before display names', () => {
    expect(
      identitiesMatch(
        { folder_name: 'folder-a', mod_id: null, name: 'Same Name' },
        { folder_name: 'folder-b', mod_id: null, name: 'Same Name' },
      ),
    ).toBe(false);

    expect(
      identitiesMatch(
        { folder_name: 'folder-a', mod_id: null, name: 'Old Name' },
        { folder_name: 'folder-a', mod_id: null, name: 'New Name' },
      ),
    ).toBe(true);
  });

  it('falls back to display names when strong keys are absent', () => {
    expect(
      identitiesMatch(
        { folder_name: null, mod_id: null, name: ' Same Name ' },
        { folder_name: '', mod_id: undefined, name: 'same name' },
      ),
    ).toBe(true);
  });

  it('ignores whitespace-only identity values', () => {
    expect(identityKeys({ folder_name: '   ', mod_id: null, name: 'Display' })).toEqual(['display']);
  });

  it('matches immediately when both sides share a mod_version_id', () => {
    expect(
      identitiesMatch(
        { mod_version_id: 'artifact-1', folder_name: 'folder-a', mod_id: null, name: 'A' },
        { mod_version_id: 'artifact-1', folder_name: 'folder-b', mod_id: null, name: 'B' },
      ),
    ).toBe(true);
  });

  it('does not fall through after a mod_version_id mismatch', () => {
    expect(
      identitiesMatch(
        { mod_version_id: 'artifact-old', folder_name: 'same', mod_id: 'same', name: 'Same' },
        { mod_version_id: 'artifact-new', folder_name: 'same', mod_id: 'same', name: 'Same' },
      ),
    ).toBe(false);
  });
});
