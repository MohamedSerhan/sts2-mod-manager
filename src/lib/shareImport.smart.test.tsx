import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';

import {
  importShareCodeSmart,
  installSharedProfileWithConfirm,
} from './shareImport';
import type { ConfirmOptions } from '../components/ConfirmDialog';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

/**
 * Tests the smart-import router. It branches across four states based
 * on subscription/active/update presence; we cover each.
 */

type ConfirmResult = false | { confirmed: true; checked: boolean };
const confirmAccept = async (): Promise<ConfirmResult> => ({ confirmed: true as const, checked: false });
const confirmReject = async (): Promise<ConfirmResult> => false;

const mockT = ((key: string, vars?: Record<string, unknown>) => {
  if (vars) return `[${key}] ${JSON.stringify(vars)}`;
  return `[${key}]`;
}) as any;

describe('importShareCodeSmart', () => {
  it('Case 1: brand-new pack → installs after confirm (installed outcome)', async () => {
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'Imported',
      mods: [],
      created_at: '2026-01-01',
    }));
    registerInvokeHandler('install_shared_profile', () => ({
      name: 'Imported',
      mods: [],
      created_at: '2026-01-01',
    }));
    const outcome = await importShareCodeSmart('alice/AA5A-315D-61AE', {
      confirm: confirmAccept,
      subscriptions: [],
      activeProfile: null,
      subUpdates: [],
      t: mockT,
    });
    expect(outcome.kind).toBe('installed');
    if (outcome.kind === 'installed') {
      expect(outcome.profile.name).toBe('Imported');
    }
  });

  it('Case 1: brand-new pack with confirm rejected → cancelled outcome', async () => {
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'Imported',
      mods: [],
      created_at: '2026-01-01',
    }));
    const outcome = await importShareCodeSmart('alice/AA5A-315D-61AE', {
      confirm: confirmReject,
      subscriptions: [],
      activeProfile: null,
      subUpdates: [],
      t: mockT,
    });
    expect(outcome.kind).toBe('cancelled');
  });

  it('Case 2: already subscribed + active + no update → re-applies active pack', async () => {
    registerInvokeHandler('switch_profile', () => ({
      applied: true,
      downloaded: 1,
      missing_mods: [],
      failed_downloads: [],
    }));

    const outcome = await importShareCodeSmart('alice/AA5A-315D-61AE', {
      confirm: confirmAccept,
      subscriptions: [{
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'Imported',
        last_synced: '2026-05-01',
        last_known_remote_sha: 'sha',
        subscribed_at: '2026-01-01',
      } as any],
      activeProfile: 'Imported',
      subUpdates: [],
      t: mockT,
    });
    expect(outcome.kind).toBe('reapplied');
    if (outcome.kind === 'reapplied') {
      expect(outcome.profileName).toBe('Imported');
      expect(outcome.result.downloaded).toBe(1);
    }
    expect(getInvokeCalls().filter((c) => c.cmd === 'switch_profile')).toHaveLength(1);
  });

  it('Case 3: subscribed but not active → activated outcome after confirm', async () => {
    registerInvokeHandler('switch_profile', () => ({
      activated: true,
      downloaded: 0,
      missing_mods: [],
    }));
    const outcome = await importShareCodeSmart('alice/AA5A-315D-61AE', {
      confirm: confirmAccept,
      subscriptions: [{
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'Imported',
        last_synced: '2026-05-01',
        last_known_remote_sha: 'sha',
        subscribed_at: '2026-01-01',
      } as any],
      activeProfile: 'OtherPack',
      subUpdates: [],
      t: mockT,
    });
    expect(outcome.kind).toBe('activated');
  });

  it('Case 4: pending update → synced outcome after confirm', async () => {
    registerInvokeHandler('apply_subscription_update', () => ({
      name: 'Imported',
      mods: [],
      created_at: '2026-01-01',
    }));
    const outcome = await importShareCodeSmart('alice/AA5A-315D-61AE', {
      confirm: confirmAccept,
      subscriptions: [{
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'Imported',
        last_synced: '2026-05-01',
        last_known_remote_sha: 'sha',
        subscribed_at: '2026-01-01',
      } as any],
      activeProfile: 'Imported',
      subUpdates: [{
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'Imported',
        has_update: true,
        added_mods: ['NewMod'],
        updated_mods: [],
        removed_mods: [],
        remote_profile: null,
      }],
      t: mockT,
    });
    expect(outcome.kind).toBe('synced');
  });

  it('Case 4: pending update with confirm rejected → cancelled', async () => {
    const outcome = await importShareCodeSmart('alice/AA5A-315D-61AE', {
      confirm: confirmReject,
      subscriptions: [{
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'Imported',
        last_synced: '2026-05-01',
        last_known_remote_sha: 'sha',
        subscribed_at: '2026-01-01',
      } as any],
      activeProfile: 'Imported',
      subUpdates: [{
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'Imported',
        has_update: true,
        added_mods: ['X'],
        updated_mods: [],
        removed_mods: [],
        remote_profile: null,
      }],
      t: mockT,
    });
    expect(outcome.kind).toBe('cancelled');
  });

  it('garbage code falls through to the install path which surfaces its own parse error', async () => {
    registerInvokeHandler('fetch_shared_profile_cmd', () => {
      throw new Error('Invalid share code: garbage');
    });
    let thrown: unknown = null;
    try {
      await importShareCodeSmart('garbage', {
        confirm: confirmAccept,
        subscriptions: [],
        activeProfile: null,
        subUpdates: [],
        t: mockT,
      });
    } catch (e) {
      thrown = e;
    }
    expect(String(thrown)).toMatch(/Invalid share code/);
  });

  it('Case 3: subscribed but not active + rejected confirm cancels without switching', async () => {
    const outcome = await importShareCodeSmart('alice/AA5A-315D-61AE', {
      confirm: confirmReject,
      subscriptions: [{
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'Imported',
        last_synced: '2026-05-01',
        last_known_remote_sha: 'sha',
        subscribed_at: '2026-01-01',
      } as any],
      activeProfile: 'OtherPack',
      subUpdates: [],
      t: mockT,
    });
    expect(outcome.kind).toBe('cancelled');
    expect(getInvokeCalls().some((c) => c.cmd === 'switch_profile')).toBe(false);
  });

  it('Case 4: pending update summary handles updated and removed mods', async () => {
    registerInvokeHandler('apply_subscription_update', () => ({
      name: 'Imported',
      mods: [],
      created_at: '2026-01-01',
    }));
    const outcome = await importShareCodeSmart('alice/AA5A-315D-61AE', {
      confirm: confirmAccept,
      subscriptions: [{
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'Imported',
        last_synced: '2026-05-01',
        last_known_remote_sha: 'sha',
        subscribed_at: '2026-01-01',
      } as any],
      activeProfile: 'Imported',
      subUpdates: [{
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'Imported',
        has_update: true,
        added_mods: [],
        updated_mods: [{
          name: 'Changed',
          old_version: '1.0.0',
          new_version: '1.1.0',
        }],
        removed_mods: ['Removed'],
        remote_profile: null,
      }],
      t: mockT,
    });
    expect(outcome.kind).toBe('synced');
  });

  it('Case 4: pending update summary handles empty per-mod details', async () => {
    registerInvokeHandler('apply_subscription_update', () => ({
      name: 'Imported',
      mods: [],
      created_at: '2026-01-01',
    }));
    const outcome = await importShareCodeSmart('alice/AA5A-315D-61AE', {
      confirm: confirmAccept,
      subscriptions: [{
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'Imported',
        last_synced: '2026-05-01',
        last_known_remote_sha: 'sha',
        subscribed_at: '2026-01-01',
      } as any],
      activeProfile: 'Imported',
      subUpdates: [{
        share_id: 'alice/AA5A-315D-61AE',
        profile_name: 'Imported',
        has_update: true,
        added_mods: [],
        updated_mods: [],
        removed_mods: [],
        remote_profile: null,
      }],
      t: mockT,
    });
    expect(outcome.kind).toBe('synced');
  });

  it('non-canonical input that still resolves → installed outcome', async () => {
    // `no-slash-here` has no `/`, so canonicalShareCode returns null and the
    // smart router falls through to installSharedProfileWithConfirm with the
    // raw input. We mock that path to succeed, exercising the `installed`
    // arm of the `!canonical` return ternary.
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'Fallback Install',
      mods: [],
      created_at: '2026-01-01',
    }));
    registerInvokeHandler('install_shared_profile', () => ({
      name: 'Fallback Install',
      mods: [],
      created_at: '2026-01-01',
    }));

    const outcome = await importShareCodeSmart('no-slash-here', {
      confirm: confirmAccept,
      subscriptions: [],
      activeProfile: null,
      subUpdates: [],
      t: mockT,
    });

    expect(outcome.kind).toBe('installed');
    if (outcome.kind === 'installed') {
      expect(outcome.profile.name).toBe('Fallback Install');
    }
    // The raw (un-canonicalized) input was handed to the fetch/install path.
    expect(getInvokeCalls().filter((c) => c.cmd === 'install_shared_profile')).toHaveLength(1);
  });

  it('non-canonical input with confirm rejected → cancelled outcome', async () => {
    // Same `!canonical` fall-through, but the user rejects the consent dialog
    // so installSharedProfileWithConfirm returns null → the `cancelled` arm of
    // the same ternary.
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'Fallback Install',
      mods: [],
      created_at: '2026-01-01',
    }));

    const outcome = await importShareCodeSmart('no-slash-here', {
      confirm: confirmReject,
      subscriptions: [],
      activeProfile: null,
      subUpdates: [],
      t: mockT,
    });

    expect(outcome.kind).toBe('cancelled');
    // Rejected before install — nothing was installed.
    expect(getInvokeCalls().some((c) => c.cmd === 'install_shared_profile')).toBe(false);
  });

  it('install confirmation lists a non-URL source verbatim (URL parse falls back to the raw string)', async () => {
    // A mod whose bundle_url is a bare token rather than an http(s) URL:
    // `new URL(s)` throws, so the host-extraction catch returns the raw
    // string and it shows up as-is in the source list (covering both the
    // catch fallback and the "render the hosts" branch).
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'Odd-Source Pack',
      mods: [
        {
          name: 'Local Mod',
          version: '1.0.0',
          source: 'not-a-valid-url',
          bundle_url: null,
          files: [],
          enabled: true,
        },
        {
          name: 'Web Mod',
          version: '1.0.0',
          source: null,
          bundle_url: 'https://github.com/owner/repo/releases/download/v1/m.zip',
          files: [],
          enabled: true,
        },
      ],
      created_at: '2026-01-01',
    }));
    registerInvokeHandler('install_shared_profile', () => ({
      name: 'Odd-Source Pack',
      mods: [],
      created_at: '2026-01-01',
    }));

    let confirmedBody: unknown = null;
    const captureConfirm = async (opts: ConfirmOptions): Promise<ConfirmResult> => {
      confirmedBody = opts.body;
      return { confirmed: true as const, checked: false };
    };

    const profile = await installSharedProfileWithConfirm(
      'alice/AA5A-315D-61AE',
      captureConfirm,
      mockT,
    );

    expect(profile?.name).toBe('Odd-Source Pack');
    // The consent dialog body is the React node we build; render it to plain
    // text and assert BOTH the parsed host and the raw non-URL token appear.
    const { render } = await import('@testing-library/react');
    const { container } = render(confirmedBody as ReactElement);
    expect(container.textContent).toContain('not-a-valid-url');
    expect(container.textContent).toContain('github.com');
    expect(getInvokeCalls().filter((c) => c.cmd === 'install_shared_profile')).toHaveLength(1);
  });

  it('install confirmation handles manifests without creator or source URLs', async () => {
    registerInvokeHandler('fetch_shared_profile_cmd', () => ({
      name: 'Source-less Pack',
      mods: [
        {
          name: 'Manual Mod',
          version: 'unknown',
          source: null,
          bundle_url: null,
          files: [],
          enabled: true,
        },
      ],
      created_at: '2026-01-01',
    }));
    registerInvokeHandler('install_shared_profile', () => ({
      name: 'Source-less Pack',
      mods: [],
      created_at: '2026-01-01',
    }));

    const profile = await installSharedProfileWithConfirm(
      'alice/AA5A-315D-61AE',
      confirmAccept,
      mockT,
    );

    expect(profile?.name).toBe('Source-less Pack');
    expect(getInvokeCalls().filter((c) => c.cmd === 'install_shared_profile')).toHaveLength(1);
  });
});
