import type { ModInfo, ProfileMembershipMod } from '../types';

function normalize(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase();
}

export function logicalModKey(
  mod: Pick<ModInfo | ProfileMembershipMod, 'name' | 'folder_name' | 'mod_id'>,
  info?: Pick<ModInfo, 'name' | 'github_url' | 'nexus_url' | 'source'> | null,
): string {
  const modId = normalize(mod.mod_id);
  const name = normalize(info?.name ?? mod.name);
  if (modId) return `mod_id:${modId}`;
  return `name:${name}`;
}

export function modVersionSortValue(version: string | null | undefined): string {
  return normalize(version).replace(/^v/, '');
}
