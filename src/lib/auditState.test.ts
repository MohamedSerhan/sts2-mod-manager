import { describe, it, expect } from 'vitest';
import type { ModAuditEntry } from '../types';
import {
  auditEntryKeys,
  auditEntryKey,
  auditTargetForMod,
  auditTargetKeys,
  auditTargetKey,
  isUpToDate,
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

function githubPlan(name: string, pending = true) {
  return {
    target: { name, mod_version_id: `${name}-version` },
    current_version: '1', target_version: '2', provider: 'github', source: `https://github.com/x/${name}`,
    capability: 'downloadable' as const, reason: '', selectable: pending, pending,
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

describe('projectProviderUpdates', () => {
  it('keeps distinct pending Steam, GitHub, and Nexus plans from one audit record', () => {
    const entries = [entry({
      mod_version_id: 'ritsu',
      mod_name: 'RitsuLib',
      update_plans: [
        {
          target: { name: 'RitsuLib', mod_version_id: 'ritsu' }, current_version: '0.4.41',
          target_version: '0.4.42', provider: 'github', source: 'https://github.com/BAKAOLC/STS2-RitsuLib',
          capability: 'downloadable', reason: '', selectable: true, pending: true,
        },
        {
          target: { name: 'RitsuLib', mod_version_id: 'ritsu' }, current_version: '0.4.41',
          target_version: '0.4.42', provider: 'nexus', source: 'https://www.nexusmods.com/slaythespire2/mods/1',
          capability: 'manual', reason: '', selectable: false, pending: true,
        },
        {
          target: { name: 'RitsuLib', mod_version_id: 'ritsu' }, current_version: '0.4.41',
          target_version: '0.4.42', provider: 'nexus', source: 'https://www.nexusmods.com/slaythespire2/mods/1',
          capability: 'manual', reason: 'duplicate input', selectable: false, pending: true,
        },
        {
          target: { name: 'RitsuLib', mod_version_id: 'ritsu' }, current_version: '0.4.41',
          target_version: null, provider: 'steam', source: 'https://steamcommunity.com/sharedfiles/filedetails/?id=1',
          capability: 'steam-managed', reason: '', selectable: false, pending: true,
        },
      ],
    })];

    const projection = projectProviderUpdates(entries);
    expect(projection.downloadableCount).toBe(1);
    expect(projection.pendingPlans).toHaveLength(3);
    expect(projection.pendingPlans.map((plan) => plan.provider)).toEqual(['github', 'nexus', 'steam']);
    expect(projection.hasPending).toBe(true);
  });

  it.each([
    ['Steam + Nexus', ['steam', 'nexus']],
    ['Steam + GitHub', ['steam', 'github']],
    ['Steam + GitHub + Nexus', ['steam', 'github', 'nexus']],
  ] as const)('keeps every pending provider for %s on the same record', (_label, providers) => {
    const update_plans = providers.map((provider) => ({
      target: { name: 'BaseLib', mod_version_id: 'baselib-workshop' },
      current_version: '1.0.0',
      target_version: provider === 'steam' ? null : '2.0.0',
      provider,
      source: `https://example.com/${provider}`,
      capability: provider === 'steam' ? 'steam-managed' as const
        : provider === 'github' ? 'downloadable' as const : 'manual' as const,
      reason: '',
      selectable: provider === 'github',
      pending: true,
    }));

    expect(projectProviderUpdates([entry({ update_plans })]).pendingPlans.map(
      (plan) => plan.provider,
    )).toEqual(providers);
  });

  it('uses one legacy update_plan only when update_plans fan-out is absent', () => {
    const legacy = githubPlan('Legacy');
    const replacement = { ...githubPlan('Legacy'), target_version: '3.0.0' };

    expect(projectProviderUpdates([entry({ update_plan: legacy })]).pendingPlans).toEqual([legacy]);
    expect(projectProviderUpdates([entry({
      update_plan: legacy,
      update_plans: [replacement],
    })]).pendingPlans).toEqual([replacement]);
    expect(projectProviderUpdates([entry({
      update_plan: legacy,
      update_plans: [],
    })]).pendingPlans).toEqual([]);
  });

  it('ignores serialized up-to-date Nexus, Steam, GitHub, and frozen plans', () => {
    const update_plans = [
      ['nexus', 'manual'],
      ['steam', 'steam-managed'],
      ['github', 'downloadable'],
      ['github', 'frozen'],
    ].map(([provider, capability], index) => ({
      target: { name: `Current ${index}`, mod_version_id: `current-${index}` },
      current_version: '1.0.0',
      target_version: provider === 'steam' ? null : '1.0.0',
      provider,
      source: null,
      capability: capability as 'manual' | 'steam-managed' | 'downloadable' | 'frozen',
      reason: '',
      selectable: false,
      pending: false,
    }));

    expect(projectProviderUpdates([entry({ update_plans })])).toEqual({
      pendingPlans: [],
      downloadablePlans: [],
      downloadableCount: 0,
      reviewCount: 0,
      actionableCount: 0,
      hasPending: false,
    });
  });

  it('treats authoritative non-pending plans as current despite stale legacy needs_update', () => {
    const current = entry({
      github_repo: 'owner/repo',
      needs_update: true,
      update_plans: [{
        ...githubPlan('Current'),
        selectable: false,
        pending: false,
        target_version: '1.0.0',
      }],
    });

    expect(isUpToDate(current)).toBe(true);
    expect(isUpToDate(entry({
      github_repo: 'owner/repo',
      needs_update: true,
      update_plans: [],
    }))).toBe(true);
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
        update_plans: [{
          target: { name: id, mod_version_id: id },
          current_version: '1.0.0',
          target_version: '2.0.0',
          provider,
          source: provider === 'steam' ? null : `https://example.com/${id}`,
          capability,
          reason: '',
          selectable,
          pending: true,
        }],
      }),
    ));

    expect(projection.actionableCount).toBe(5);
    expect(projection.downloadableCount).toBe(2);
    expect(projection.reviewCount).toBe(8);
    expect(projection.pendingPlans).toHaveLength(8);
    expect(projection.pendingPlans.filter((plan) => plan.provider === 'steam')).toHaveLength(3);
  });

  it('collapses the same grouped provider action without merging distinct Nexus lanes', () => {
    const nexusPlan = (
      artifactId: string,
      currentVersion: string,
      targetVersion: string,
    ) => ({
      target: {
        name: 'BaseLib',
        mod_id: 'BaseLib',
        mod_version_id: artifactId,
      },
      current_version: currentVersion,
      target_version: targetVersion,
      provider: 'nexus',
      source: 'https://www.nexusmods.com/slaythespire2/mods/103',
      capability: 'manual' as const,
      reason: '',
      selectable: false,
      pending: true,
    });
    const projection = projectProviderUpdates([
      entry({
        mod_name: 'BaseLib',
        mod_version_id: 'baselib-nexus',
        update_plans: [nexusPlan('baselib-nexus', '3.3.1', '3.3.5')],
      }),
      entry({
        mod_name: 'BaseLib',
        mod_version_id: 'baselib-steam',
        update_plans: [
          nexusPlan('baselib-steam', '3.3.1', '3.3.5'),
          nexusPlan('baselib-beta', '3.2.0-beta', '3.3.0-beta'),
        ],
      }),
    ]);

    expect(projection.pendingPlans).toHaveLength(2);
    expect(projection.actionableCount).toBe(2);
    expect(projection.pendingPlans.map((plan) => plan.current_version)).toEqual([
      '3.3.1',
      '3.2.0-beta',
    ]);
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
      entry({ mod_name: 'A', github_repo: 'a/a', needs_update: true, update_source: 'github', latest_release_with_assets_tag: 'v2', update_plans: [githubPlan('A')] }),
      entry({ mod_name: 'B', github_repo: 'b/b', needs_update: true, update_source: 'github', latest_release_with_assets_tag: 'v2', snoozed: true, update_plans: [githubPlan('B', false)] }),
    ];
    expect(projectProviderUpdates(rows).downloadableCount).toBe(1);
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
      update_plans: [githubPlan('a')],
    });
    expect(isUpToDate(row)).toBe(false);
    expect(projectProviderUpdates([row]).downloadableCount).toBe(1);
  });
});

describe('key fallbacks', () => {
  it('falls back to the bare mod name when an entry exposes no identity keys', () => {
    expect(auditEntryKey(entry({ mod_version_id: null, folder_name: null, mod_name: '' }))).toBe('');
  });

  it('falls back to an empty key when a refresh target exposes no identity', () => {
    expect(auditTargetKey({ mod_version_id: null, folder_name: null, mod_id: null, name: '' })).toBe('');
  });
});
