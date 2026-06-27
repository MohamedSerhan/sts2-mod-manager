import { describe, expect, it } from 'vitest';

import {
  findProfileForIdentifier,
  isProfileUuid,
  profileDisplayName,
  profileDisplayNameForIdentifier,
  redactProfileUuids,
  safeProfileDisplayName,
} from './profileDisplay';
import type { Profile } from '../types';

const UUID = '731aeaec-7f3d-4859-baec-16219701e2e7';

describe('profileDisplay helpers', () => {
  it('detects UUID-shaped profile ids', () => {
    expect(isProfileUuid(UUID)).toBe(true);
    expect(isProfileUuid('TesterW')).toBe(false);
  });

  it('returns display names but suppresses UUID fallbacks', () => {
    expect(safeProfileDisplayName(' TesterW ')).toBe('TesterW');
    expect(safeProfileDisplayName(UUID)).toBeNull();
    expect(profileDisplayName(UUID, 'Unknown')).toBe('Unknown');
  });

  it('resolves profile identifiers to display names when profiles are available', () => {
    const profiles = [
      { id: UUID, name: 'TesterW', mods: [], created_at: '2026-01-01' },
    ] as Profile[];

    expect(findProfileForIdentifier(profiles, UUID)?.name).toBe('TesterW');
    expect(profileDisplayNameForIdentifier(profiles, UUID, 'Unknown')).toBe('TesterW');
  });

  it('redacts UUIDs embedded in toast or error text', () => {
    expect(redactProfileUuids(`Repair failed for ${UUID}`, 'Unknown')).toBe('Repair failed for Unknown');
  });
});
