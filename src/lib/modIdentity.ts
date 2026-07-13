// Drift-tolerant identity matching between a pack's saved mod entries and
// the currently-installed mods (issue #174 part B).
//
// A curator can delete + reinstall a mod and have it land in a different
// on-disk folder (Nexus archives often unpack into version-suffixed
// folders). A saved pack entry's `folder_name` can therefore go stale while
// the mod is still "the same mod" by `mod_id` or by display `name`.
//
// This mirrors the backend's publish matcher
// (`publish_profile_mod_matches_installed` in src-tauri/src/sharing/mod.rs):
// build identity-key SETS per side from folder_name/mod_id ("strong" keys)
// plus the normalized name, and match on ANY intersection — preferring a
// strong-key intersection when both sides have strong keys, falling back to
// the name otherwise.

interface IdentityFields {
  name: string;
  mod_version_id?: string | null;
  folder_name?: string | null;
  mod_id?: string | null;
}

interface WorkshopSourceFields {
  install_source?: string | null;
  workshop_item_id?: string | null;
  workshop_url?: string | null;
  source?: string | null;
}

/** Shared Steam Workshop ownership heuristic for installed, membership, and
 * cached-version records. Keep destructive-action guards source-consistent. */
export function isWorkshopSource(entry: WorkshopSourceFields | null | undefined): boolean {
  if (!entry) return false;
  const source = entry.source?.trim().toLocaleLowerCase() ?? '';
  return entry.install_source === 'steam_workshop'
    || Boolean(entry.workshop_item_id)
    || Boolean(entry.workshop_url)
    || source.includes('steamcommunity.com/sharedfiles')
    || source.startsWith('steam://');
}

/** True only when Steam owns the installed artifact. A locally installed
 * GitHub/Nexus copy can legitimately carry Workshop discovery metadata and
 * must remain eligible for manager-owned update, repair, rollback, and delete
 * actions. */
export function isWorkshopOwned(entry: WorkshopSourceFields | null | undefined): boolean {
  return entry?.install_source === 'steam_workshop';
}

export function workshopSourceUrl(
  entry: WorkshopSourceFields | null | undefined,
): string | null {
  if (!entry) return null;
  if (entry.workshop_url) return entry.workshop_url;
  const source = entry.source?.trim() ?? '';
  return source.includes('steamcommunity.com/sharedfiles') || source.startsWith('steam://')
    ? source
    : null;
}

function pushKey(keys: string[], value: string | null | undefined) {
  if (!value) return;
  const trimmed = value.trim();
  if (!trimmed) return;
  const key = trimmed.toLowerCase();
  if (!keys.includes(key)) keys.push(key);
}

/** All identity keys for an entry: folder_name, mod_id, and name (in that
 *  order), lowercased + trimmed, skipping null/empty values. */
export function identityKeys(entry: IdentityFields): string[] {
  const keys: string[] = [];
  pushKey(keys, entry.folder_name);
  pushKey(keys, entry.mod_id);
  pushKey(keys, entry.name);
  return keys;
}

/** Just the "strong" identity keys (folder_name, mod_id) — the fields that
 *  uniquely identify an on-disk install, as opposed to the display name
 *  which can collide or drift. */
export function strongIdentityKeys(entry: IdentityFields): string[] {
  const keys: string[] = [];
  pushKey(keys, entry.folder_name);
  pushKey(keys, entry.mod_id);
  return keys;
}

function keysIntersect(a: string[], b: string[]): boolean {
  return a.some((key) => b.includes(key));
}

/**
 * Does `a` identify the same mod as `b`?
 *
 * If both sides have at least one strong key (folder_name/mod_id), match on
 * those exclusively. Otherwise fall back to matching on the full key set
 * (which includes the normalized name).
 */
export function identitiesMatch(a: IdentityFields, b: IdentityFields): boolean {
  if (a.mod_version_id && b.mod_version_id) {
    return a.mod_version_id === b.mod_version_id;
  }
  const aStrong = strongIdentityKeys(a);
  const bStrong = strongIdentityKeys(b);
  if (aStrong.length > 0 && bStrong.length > 0) {
    return keysIntersect(aStrong, bStrong);
  }
  return keysIntersect(identityKeys(a), identityKeys(b));
}
