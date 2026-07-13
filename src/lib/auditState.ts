import type { ModAuditEntry, ModAuditTarget, UpdatePlanItem } from '../types';

export type AuditRefreshTarget = string | ModAuditTarget;

function uniqueNonEmpty(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function auditEntryKeys(entry: ModAuditEntry): string[] {
  return uniqueNonEmpty([entry.mod_version_id, entry.folder_name, entry.mod_name]);
}

export function auditEntryKey(entry: ModAuditEntry): string {
  return auditEntryKeys(entry)[0] ?? entry.mod_name;
}

export function auditTargetKeys(target: AuditRefreshTarget): string[] {
  if (typeof target === 'string') return uniqueNonEmpty([target]);
  return uniqueNonEmpty([target.mod_version_id, target.folder_name, target.mod_id, target.name]);
}

export function auditTargetKey(target: AuditRefreshTarget): string {
  return auditTargetKeys(target)[0] ?? '';
}

export function auditTargetForMod(mod: {
  mod_version_id?: string | null;
  folder_name?: string | null;
  mod_id?: string | null;
  name: string;
}): ModAuditTarget {
  return {
    mod_version_id: mod.mod_version_id ?? null,
    folder_name: mod.folder_name ?? null,
    mod_id: mod.mod_id ?? null,
    name: mod.name,
  };
}

export function isActionableUpdate(entry: ModAuditEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.pinned || entry.snoozed || !entry.needs_update) return false;
  if (entry.game_version_too_old || entry.latest_release_blocked_by_game_version) return false;
  if (entry.update_source === 'github') return Boolean(entry.latest_compatible_tag ?? entry.latest_release_with_assets_tag);
  if (entry.update_source === 'both') {
    return Boolean(entry.latest_compatible_tag ?? entry.latest_release_with_assets_tag ?? entry.nexus_update_available);
  }
  return Boolean(entry.nexus_update_available || entry.latest_compatible_tag || entry.latest_release_with_assets_tag);
}

export function isGithubBulkUpdate(entry: ModAuditEntry | undefined): boolean {
  if (!entry) return false;
  if (entry.pinned || entry.snoozed || !entry.needs_update) return false;
  if (entry.game_version_too_old || entry.latest_release_blocked_by_game_version) return false;
  if (entry.update_source !== 'github' && entry.update_source !== 'both') return false;
  return Boolean(entry.github_repo && (entry.latest_compatible_tag ?? entry.latest_release_with_assets_tag));
}

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
  return projectProviderUpdates(entries).downloadableCount;
}

export interface ProviderUpdateProjection {
  pendingPlans: UpdatePlanItem[];
  downloadablePlans: UpdatePlanItem[];
  downloadableCount: number;
  reviewCount: number;
  actionableCount: number;
  hasPending: boolean;
}

export function projectProviderUpdates(entries: ModAuditEntry[]): ProviderUpdateProjection {
  const pendingPlans = entries.flatMap((entry) => {
    const plan = entry.update_plan;
    if (!plan) return [];
    const pending = plan.selectable || plan.capability === 'manual' ||
      plan.capability === 'steam-managed' || plan.capability === 'frozen';
    return pending && (plan.selectable || plan.target_version) ? [plan] : [];
  });
  const downloadablePlans = pendingPlans.filter(
    (plan) => plan.selectable && plan.capability === 'downloadable',
  );
  const legacyDownloadableCount = entries.filter(
    (entry) => !entry.update_plan && isGithubBulkUpdate(entry),
  ).length;
  return {
    pendingPlans,
    downloadablePlans,
    downloadableCount: downloadablePlans.length + legacyDownloadableCount,
    reviewCount: pendingPlans.length + legacyDownloadableCount,
    actionableCount: pendingPlans.filter(
      (plan) => plan.provider !== 'steam' &&
        (plan.capability === 'downloadable' || plan.capability === 'manual'),
    ).length + legacyDownloadableCount,
    hasPending: pendingPlans.length > 0 || legacyDownloadableCount > 0,
  };
}
