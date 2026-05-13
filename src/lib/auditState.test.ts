import { describe, it, expect } from 'vitest';
import type { ModAuditEntry } from '../types';
import { isUpToDate, countGithubUpdates } from './auditState';

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

  it('returns false when the mod is incompatible with the installed game version', () => {
    expect(
      isUpToDate(entry({ github_repo: 'a/b', game_version_too_old: true })),
    ).toBe(false);
  });
});

describe('countGithubUpdates', () => {
  it('counts only GitHub rows that have installable assets and a pending update', () => {
    const rows: ModAuditEntry[] = [
      entry({ mod_name: 'A', github_repo: 'a/a', needs_update: true, latest_release_with_assets_tag: 'v2' }),
      entry({ mod_name: 'B', github_repo: 'b/b', needs_update: true, latest_release_with_assets_tag: null }),
      entry({ mod_name: 'C', github_repo: null, nexus_url: 'x', needs_update: true }),
      entry({ mod_name: 'D', github_repo: 'd/d', needs_update: false, latest_release_with_assets_tag: 'v1' }),
    ];
    expect(countGithubUpdates(rows)).toBe(1);
  });

  it('does not count a GitHub row that lacks installable assets', () => {
    expect(countGithubUpdates([
      entry({ github_repo: 'a/a', needs_update: true, latest_release_with_assets_tag: null }),
    ])).toBe(0);
  });

  it('does not count a non-GitHub row even when needs_update is true', () => {
    expect(countGithubUpdates([
      entry({ nexus_url: 'x', needs_update: true }),
    ])).toBe(0);
  });
});
