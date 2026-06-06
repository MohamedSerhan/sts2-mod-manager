import type { ModAuditEntry } from '../types';

export function isUpToDate(entry: ModAuditEntry): boolean {
  const hasSource = Boolean(entry.github_repo || entry.nexus_url);
  if (!hasSource) return false;
  // Snoozed mods don't count as "needs update" — the user has explicitly
  // chosen to wait for the next upstream release. Treat them as up-to-date
  // from the audit's perspective so the row gets the "Latest" pill instead
  // of a stale "update available" badge.
  if (entry.snoozed) return true;
  if (entry.needs_update) return false;
  const hasRealError = Boolean(entry.error) && !entry.github_auto_detected;
  if (hasRealError) return false;
  const goneNoAssets =
    Boolean(entry.latest_release_tag) && !entry.latest_release_with_assets_tag;
  const nexusCheckedCurrent =
    Boolean(entry.nexus_url || entry.nexus_version) && !entry.nexus_update_available;
  if (goneNoAssets && !nexusCheckedCurrent) return false;
  if (entry.game_version_too_old) return false;
  if (entry.latest_release_blocked_by_game_version) return false;
  return true;
}

export function countGithubUpdates(entries: ModAuditEntry[]): number {
  return entries.filter(
    (e) => e.needs_update && !e.snoozed && e.github_repo && e.latest_release_with_assets_tag,
  ).length;
}
