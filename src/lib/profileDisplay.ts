import type { Profile } from '../types';

const PROFILE_UUID_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PROFILE_UUID_RE = new RegExp(`^${PROFILE_UUID_SOURCE}$`, 'i');
const PROFILE_UUID_IN_TEXT_RE = new RegExp(`\\b${PROFILE_UUID_SOURCE}\\b`, 'gi');

export function isProfileUuid(value: string | null | undefined): boolean {
  return PROFILE_UUID_RE.test(value?.trim() ?? '');
}

export function safeProfileDisplayName(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || isProfileUuid(trimmed)) return null;
  return trimmed;
}

export function profileDisplayName(
  value: string | null | undefined,
  fallback: string,
): string {
  return safeProfileDisplayName(value) ?? fallback;
}

export function redactProfileUuids(value: string, replacement: string): string {
  return value.replace(PROFILE_UUID_IN_TEXT_RE, replacement);
}

export function findProfileForIdentifier(
  profiles: Profile[],
  identifier: string | null | undefined,
): Profile | null {
  const trimmed = identifier?.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLocaleLowerCase();
  return profiles.find((profile) =>
    profile.id === trimmed || profile.name.toLocaleLowerCase() === lower
  ) ?? null;
}

export function profileDisplayNameForIdentifier(
  profiles: Profile[],
  identifier: string | null | undefined,
  fallback: string,
): string {
  return findProfileForIdentifier(profiles, identifier)?.name
    ?? profileDisplayName(identifier, fallback);
}
