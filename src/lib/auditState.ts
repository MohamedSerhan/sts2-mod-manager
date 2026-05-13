import type { ModAuditEntry } from '../types';

export function isUpToDate(entry: ModAuditEntry): boolean {
  const hasSource = Boolean(entry.github_repo || entry.nexus_url);
  if (!hasSource) return false;
  if (entry.needs_update) return false;
  const hasRealError = Boolean(entry.error) && !entry.github_auto_detected;
  if (hasRealError) return false;
  const goneNoAssets =
    Boolean(entry.latest_release_tag) && !entry.latest_release_with_assets_tag;
  if (goneNoAssets) return false;
  if (entry.game_version_too_old) return false;
  return true;
}

export function countGithubUpdates(entries: ModAuditEntry[]): number {
  return entries.filter(
    (e) => e.needs_update && e.github_repo && e.latest_release_with_assets_tag,
  ).length;
}
