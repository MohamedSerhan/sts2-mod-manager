import { describe, it, expect } from 'vitest';
import type { ModAuditEntry } from '../types';
import {
  auditEntryKeys,
  auditEntryKey,
  auditTargetForMod,
  auditTargetKeys,
  auditTargetKey,
  isActionableUpdate,
  isGithubBulkUpdate,
  isUpToDate,
  countGithubUpdates,
  projectProviderUpdates,
} from './auditState';

function entry(over: Partial<ModAuditEntry>): ModAuditEntry {
  return {
    mod_name: 'X',
    folder_name: null,
    github_repo: null,
    installed_version: '1.0.0',
    latest_release_tag: null,
    latest_release_with_assets_tag: null,
    latest_has_assets: false,
    needs_update: false,
    asset_names: [],
    releases_scanned: 0,
    error: null,
    nexus_url: null,
    nexus_version: null,
    nexus_update_available: false,
    update_source: null,
    github_auto_detected: false,
    pinned: false,
    min_game_version: null,
    game_version_too_old: false,
    latest_release_min_game_version: null,
    latest_release_blocked_by_game_version: false,
    latest_compatible_tag: null,
    snoozed: false,
    ...over,
  };
}

describe('isUpToDate', () => {
  it('returns true when a GitHub-linked mod has no pending update and no problems', () => {
    expect(
      isUpToDate(entry({ github_repo: 'a/b', needs_update: false })),
    ).toBe(true);
  });

  it('returns true when a Nexus-linked mod has no pending update', () => {
    expect(
      isUpToDate(entry({ nexus_url: 'https://nexusmods.com/x', needs_update: false })),
    ).toBe(true);
  });

  it('returns false when the row has no source linked', () => {
    expect(isUpToDate(entry({ github_repo: null, nexus_url: null }))).toBe(false);
  });

  it('returns false when an update is pending', () => {
    expect(
      isUpToDate(entry({ github_repo: 'a/b', needs_update: true })),
    ).toBe(false);
  });

  it('returns false when the row has a real error (not auto-detected fallback)', () => {
    expect(
      isUpToDate(
        entry({ github_repo: 'a/b', error: '404', github_auto_detected: false }),
      ),
    ).toBe(false);
  });

  it('ignores errors when they are the auto-detected-fallback flavor', () => {
    expect(
      isUpToDate(
        entry({ github_repo: 'a/b', error: 'whatever', github_auto_detected: true }),
      ),
    ).toBe(true);
  });

  it('returns false when GitHub has a release but no installable assets', () => {
    expect(
      isUpToDate(
        entry({
          github_repo: 'a/b',
          latest_release_tag: 'v2',
          latest_release_with_assets_tag: null,
        }),
      ),
    ).toBe(false);
  });

  it('returns true when Nexus is current even if GitHub has no installable assets', () => {
    expect(
      isUpToDate(
        entry({
          github_repo: 'a/b',
          nexus_url: 'https://nexusmods.com/x',
          latest_release_tag: 'v2',
          latest_release_with_assets_tag: null,
          nexus_version: '1.0.0',
          nexus_update_available: false,
          needs_update: false,
        }),
      ),
    ).toBe(true);
  });

  it('returns false when the mod is incompatible with the installed game version', () => {
    expect(
      isUpToDate(entry({ github_repo: 'a/b', game_version_too_old: true })),
    ).toBe(false);
  });

  it('returns false when a newer release exists but is blocked by the game version', () => {
    expect(
      isUpToDate(entry({
        github_repo: 'a/b',
        latest_release_with_assets_tag: 'v2',
        latest_release_blocked_by_game_version: true,
      })),
    ).toBe(false);
  });
});

describe('countGithubUpdates', () => {
  it('counts only GitHub rows that have installable assets and a pending update', () => {
    const rows: ModAuditEntry[] = [
      entry({ mod_name: 'A', github_repo: 'a/a', needs_update: true, update_source: 'github', latest_release_with_assets_tag: 'v2' }),
      entry({ mod_name: 'B', github_repo: 'b/b', needs_update: true, update_source: 'github', latest_release_with_assets_tag: null }),
      entry({ mod_name: 'C', github_repo: null, nexus_url: 'x', needs_update: true }),
      entry({ mod_name: 'D', github_repo: 'd/d', needs_update: false, latest_release_with_assets_tag: 'v1' }),
    ];
    expect(countGithubUpdates(rows)).toBe(1);
  });

  it('does not count a GitHub row that lacks installable assets', () => {
    expect(countGithubUpdates([
      entry({ github_repo: 'a/a', needs_update: true, update_source: 'github', latest_release_with_assets_tag: null }),
    ])).toBe(0);
  });

  it('does not count a non-GitHub row even when needs_update is true', () => {
    expect(countGithubUpdates([
      entry({ nexus_url: 'x', needs_update: true }),
    ])).toBe(0);
  });

  it('does not count a Nexus-sourced update just because the row also has GitHub metadata', () => {
    const row = entry({
      github_repo: 'BAKAOLC/STS2-RitsuLib',
      nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/137',
      needs_update: true,
      update_source: 'nexus',
      latest_release_with_assets_tag: 'v0.4.23',
      nexus_update_available: true,
    });

    expect(isGithubBulkUpdate(row)).toBe(false);
    expect(countGithubUpdates([row])).toBe(0);
  });
});

describe('projectProviderUpdates', () => {
  it('counts only selectable downloads while retaining manual and Steam review evidence', () => {
    const entries = [
      entry({ mod_version_id: 'ritsu-local', mod_name: 'RitsuLib', update_plan: {
        target: { name: 'RitsuLib', mod_version_id: 'ritsu-local' }, current_version: '0.4.41',
        target_version: '0.4.42', provider: 'github+nexus', source: 'https://github.com/BAKAOLC/STS2-RitsuLib',
        capability: 'downloadable', reason: '', selectable: true,
      } }),
      entry({ mod_version_id: 'ritsu-steam', mod_name: 'RitsuLib', update_plan: {
        target: { name: 'RitsuLib', mod_version_id: 'ritsu-steam' }, current_version: '0.4.41',
        target_version: '0.4.42', provider: 'steam', source: null,
        capability: 'steam-managed', reason: '', selectable: false,
      } }),
      entry({ mod_version_id: 'manual', mod_name: 'Manual Mod', update_plan: {
        target: { name: 'Manual Mod', mod_version_id: 'manual' }, current_version: '1.0.0',
        target_version: '2.0.0', provider: 'nexus', source: 'https://www.nexusmods.com/slaythespire2/mods/1',
        capability: 'manual', reason: '', selectable: false,
      } }),
    ];

    const projection = projectProviderUpdates(entries);
    expect(projection.downloadableCount).toBe(1);
    expect(projection.pendingPlans).toHaveLength(3);
    expect(projection.hasPending).toBe(true);
  });

  it('counts every non-Steam review action while retaining all provider plans', () => {
    const plans = [
      ['alice', 'nexus', 'manual', false],
      ['deckstats', 'github', 'downloadable', true],
      ['remove-limit', 'nexus', 'manual', false],
      ['card-advisor', 'github', 'downloadable', true],
      ['save-path', 'nexus', 'manual', false],
      ['baselib-steam', 'steam', 'steam-managed', false],
      ['ritsulib-steam', 'steam', 'steam-managed', false],
      ['mspain-steam', 'steam', 'steam-managed', false],
    ] as const;
    const projection = projectProviderUpdates(plans.map(([id, provider, capability, selectable]) =>
      entry({
        mod_version_id: id,
        mod_name: id,
        update_plan: {
          target: { name: id, mod_version_id: id },
          current_version: '1.0.0',
          target_version: '2.0.0',
          provider,
          source: provider === 'steam' ? null : `https://example.com/${id}`,
          capability,
          reason: '',
          selectable,
        },
      }),
    ));

    expect(projection.actionableCount).toBe(5);
    expect(projection.downloadableCount).toBe(2);
    expect(projection.pendingPlans).toHaveLength(8);
    expect(projection.pendingPlans.filter((plan) => plan.provider === 'steam')).toHaveLength(3);
  });
});

describe('audit identity helpers', () => {
  it('keys audit entries and refresh targets by the strongest available identity', () => {
    expect(auditEntryKey(entry({ mod_version_id: 'artifact', folder_name: 'Folder', mod_name: 'Name' }))).toBe('artifact');
    expect(auditEntryKey(entry({ folder_name: 'Folder', mod_name: 'Name' }))).toBe('Folder');
    expect(auditTargetKey('Legacy')).toBe('Legacy');
    expect(auditTargetKey({ mod_version_id: null, folder_name: null, mod_id: 'mod-id', name: 'Name' })).toBe('mod-id');
    expect(auditTargetForMod({ mod_version_id: 'artifact', folder_name: 'Folder', mod_id: 'mod-id', name: 'Name' })).toEqual({
      mod_version_id: 'artifact',
      folder_name: 'Folder',
      mod_id: 'mod-id',
      name: 'Name',
    });
  });

  it('exposes every stable identity so targeted refreshes can replace stale artifact rows', () => {
    expect(auditEntryKeys(entry({ mod_version_id: 'artifact-old', folder_name: 'Folder', mod_name: 'Name' }))).toEqual([
      'artifact-old',
      'Folder',
      'Name',
    ]);
    expect(auditTargetKeys({
      mod_version_id: 'artifact-new',
      folder_name: 'Folder',
      mod_id: 'mod-id',
      name: 'Name',
    })).toEqual([
      'artifact-new',
      'Folder',
      'mod-id',
      'Name',
    ]);
  });
});

describe('isActionableUpdate', () => {
  it('requires a non-pinned, non-snoozed update with an actionable target', () => {
    expect(isActionableUpdate(undefined)).toBe(false);
    expect(isActionableUpdate(entry({ needs_update: true, pinned: true, latest_release_with_assets_tag: 'v2' }))).toBe(false);
    expect(isActionableUpdate(entry({ needs_update: true, snoozed: true, latest_release_with_assets_tag: 'v2' }))).toBe(false);
    expect(isActionableUpdate(entry({ needs_update: true, game_version_too_old: true, latest_release_with_assets_tag: 'v2' }))).toBe(false);
    expect(isActionableUpdate(entry({ needs_update: true, latest_release_blocked_by_game_version: true, latest_release_with_assets_tag: 'v2' }))).toBe(false);
    expect(isActionableUpdate(entry({ needs_update: true, update_source: 'github', latest_release_with_assets_tag: 'v2' }))).toBe(true);
    expect(isActionableUpdate(entry({ needs_update: true, update_source: 'github', latest_release_with_assets_tag: null }))).toBe(false);
    expect(isActionableUpdate(entry({ needs_update: true, update_source: 'nexus', nexus_update_available: true }))).toBe(true);
    expect(isActionableUpdate(entry({ needs_update: true, update_source: 'both', nexus_update_available: true }))).toBe(true);
    expect(isActionableUpdate(entry({ needs_update: true, update_source: 'both', latest_release_with_assets_tag: 'v2' }))).toBe(true);
    expect(isActionableUpdate(entry({ needs_update: true, update_source: null, latest_compatible_tag: 'v2' }))).toBe(true);
    expect(isActionableUpdate(entry({ needs_update: false, latest_release_with_assets_tag: 'v2' }))).toBe(false);
  });
});

describe('snooze', () => {
  it('treats a snoozed mod as up-to-date even when needs_update is true', () => {
    // Audit's needs_update reflects upstream truth (a newer tag exists).
    // Snooze is the user's "stop bugging me" override — isUpToDate
    // honors it so the row shows the Latest pill, not the update badge.
    const row = entry({
      github_repo: 'a/b',
      needs_update: true,
      latest_release_with_assets_tag: 'v2',
      snoozed: true,
    });
    expect(isUpToDate(row)).toBe(true);
  });

  it('excludes snoozed rows from the GitHub update count', () => {
    const rows: ModAuditEntry[] = [
      entry({ mod_name: 'A', github_repo: 'a/a', needs_update: true, update_source: 'github', latest_release_with_assets_tag: 'v2' }),
      entry({ mod_name: 'B', github_repo: 'b/b', needs_update: true, update_source: 'github', latest_release_with_assets_tag: 'v2', snoozed: true }),
    ];
    expect(countGithubUpdates(rows)).toBe(1);
  });

  it('reverts to "needs update" once snoozed is false (auto-expiry happens on backend)', () => {
    // The audit clears the `snoozed` flag when upstream advances past
    // `snoozed_until_tag`. From the TS side that means the entry simply
    // arrives with snoozed=false again — and the existing needs_update
    // path takes over without any extra TS bookkeeping.
    const row = entry({
      github_repo: 'a/b',
      needs_update: true,
      update_source: 'github',
      latest_release_with_assets_tag: 'v3',
      snoozed: false,
    });
    expect(isUpToDate(row)).toBe(false);
    expect(countGithubUpdates([row])).toBe(1);
  });
});

describe('key fallbacks and source-specific actionability', () => {
  it('falls back to the bare mod name when an entry exposes no identity keys', () => {
    expect(auditEntryKey(entry({ mod_version_id: null, folder_name: null, mod_name: '' }))).toBe('');
  });

  it('falls back to an empty key when a refresh target exposes no identity', () => {
    expect(auditTargetKey({ mod_version_id: null, folder_name: null, mod_id: null, name: '' })).toBe('');
  });

  it('actions a GitHub mod off its compatible tag before the assets tag', () => {
    expect(
      isActionableUpdate(entry({
        needs_update: true,
        update_source: 'github',
        latest_compatible_tag: 'v9',
        latest_release_with_assets_tag: null,
      })),
    ).toBe(true);
  });

  it('actions a default-source mod off its release-with-assets tag alone', () => {
    expect(
      isActionableUpdate(entry({
        needs_update: true,
        update_source: null,
        nexus_update_available: false,
        latest_compatible_tag: null,
        latest_release_with_assets_tag: 'v9',
      })),
    ).toBe(true);
  });

  it('does not action a default-source mod with no usable target', () => {
    expect(
      isActionableUpdate(entry({
        needs_update: true,
        update_source: null,
        nexus_update_available: false,
        latest_compatible_tag: null,
        latest_release_with_assets_tag: null,
      })),
    ).toBe(false);
  });
});
