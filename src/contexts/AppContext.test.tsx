import { describe, expect, it } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AppProvider, useApp } from './AppContext';
import { ToastProvider } from './ToastContext';
import { ConfirmProvider } from '../components/ConfirmDialog';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

/**
 * AppContext is the load-bearing state container for the entire UI.
 * Other test files exercise it indirectly through views/components;
 * this file pins the contract for the context itself — refresh,
 * audit, notifyNexusOpen, subUpdates filtering, gameRunning polling.
 */

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <AppProvider>{children}</AppProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

/** Inline component that exposes the context for assertions. */
function Probe(props: { onCtx: (ctx: ReturnType<typeof useApp>) => void }) {
  const ctx = useApp();
  props.onCtx(ctx);
  return null;
}

describe('<AppProvider>', () => {
  it('refreshAll loads game info + installed mods + active profile', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      { name: 'BaseLib', version: '3.1.2', enabled: true, files: [] },
    ]);
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/games/STS2',
      mods_path: 'C:/games/STS2/mods',
      disabled_mods_path: 'C:/games/STS2/mods_disabled',
      mods_count: 1,
      disabled_count: 0,
      valid: true,
      game_version: '0.105.0',
    }));
    registerInvokeHandler('get_active_profile', () => 'My Pack');

    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );

    await waitFor(() => {
      expect(captured?.loading).toBe(false);
    });
    expect(captured?.gameInfo?.game_path).toBe('C:/games/STS2');
    expect(captured?.mods).toHaveLength(1);
    expect(captured?.activeProfile).toBe('My Pack');
  });

  it('audit run + result caching', async () => {
    const auditEntry = {
      mod_name: 'BaseLib',
      installed_version: '3.1.2',
      needs_update: false,
      pinned: false,
      asset_names: [],
      releases_scanned: 0,
      latest_has_assets: false,
      nexus_update_available: false,
      github_auto_detected: false,
    };
    registerInvokeHandler('audit_mod_versions', () => [auditEntry]);

    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => {
      expect(captured?.loading).toBe(false);
    });

    expect(captured?.auditResults).toBeNull();
    await act(async () => {
      await captured!.runAudit();
    });
    expect(captured?.auditResults).toHaveLength(1);
    expect(captured?.auditResults?.[0].mod_name).toBe('BaseLib');
  });

  it('audit failure surfaces a toast but does not blank prior results', async () => {
    let callCount = 0;
    registerInvokeHandler('audit_mod_versions', () => {
      callCount += 1;
      if (callCount === 1) return [{ mod_name: 'X', needs_update: false, pinned: false }];
      throw new Error('rate limit');
    });

    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    await act(async () => { await captured!.runAudit(); });
    expect(captured?.auditResults).toHaveLength(1);
    // Second audit fails — prior results stay
    await act(async () => { await captured!.runAudit(); });
    expect(captured?.auditResults).toHaveLength(1);
    expect(screen.getByText(/Audit failed.*rate limit/)).toBeInTheDocument();
  });

  it('refreshAuditEntries splices fresh rows over existing entries by mod_name', async () => {
    let mode: 'initial' | 'refresh' = 'initial';
    registerInvokeHandler('audit_mod_versions', (args) => {
      if (!args || !args.only) {
        // Full audit
        return [
          { mod_name: 'A', installed_version: '1.0.0', needs_update: false, pinned: false },
          { mod_name: 'B', installed_version: '1.0.0', needs_update: true, pinned: false },
        ];
      }
      // Targeted audit returns fresh rows + maybe a new one.
      mode = 'refresh';
      return [
        { mod_name: 'B', installed_version: '2.0.0', needs_update: false, pinned: false },
        { mod_name: 'C', installed_version: '0.1.0', needs_update: false, pinned: false }, // new
      ];
    });

    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    await act(async () => { await captured!.runAudit(); });
    expect(captured?.auditResults?.find((r) => r.mod_name === 'B')?.installed_version).toBe('1.0.0');

    await act(async () => { await captured!.refreshAuditEntries(['B', 'C']); });
    expect(mode).toBe('refresh');
    expect(captured?.auditResults?.find((r) => r.mod_name === 'A')?.installed_version).toBe('1.0.0'); // untouched
    expect(captured?.auditResults?.find((r) => r.mod_name === 'B')?.installed_version).toBe('2.0.0'); // refreshed
    expect(captured?.auditResults?.find((r) => r.mod_name === 'C')).toBeTruthy();             // appended
  });

  it("refreshAuditEntries with empty list is a no-op", async () => {
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    const callsBefore = getInvokeCalls().length;
    await act(async () => { await captured!.refreshAuditEntries([]); });
    expect(getInvokeCalls().length).toBe(callsBefore);
  });

  it('subUpdates filters to packs with has_update=true', async () => {
    registerInvokeHandler('check_subscription_updates', () => [
      { share_id: 'a', profile_name: 'Pack A', has_update: false, added_mods: [], updated_mods: [], removed_mods: [] },
      { share_id: 'b', profile_name: 'Pack B', has_update: true, added_mods: [{ name: 'X' }], updated_mods: [], removed_mods: [] },
    ]);

    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => {
      expect(captured?.subUpdates).toHaveLength(1);
    });
    expect(captured?.subUpdates[0].profile_name).toBe('Pack B');
  });

  it('setActiveProfile updates context and invokes set_active_profile', async () => {
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    act(() => {
      captured!.setActiveProfile('New Pack');
    });
    expect(captured?.activeProfile).toBe('New Pack');
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'set_active_profile' && c.args?.name === 'New Pack')).toBe(true);
    });
  });

  it('useApp throws clearly outside provider', () => {
    const Boom = () => {
      try { useApp(); } catch (e) { return <div>caught: {(e as Error).message}</div>; }
      return null;
    };
    const origErr = console.error;
    console.error = () => {};
    try {
      render(<Boom />);
    } finally {
      console.error = origErr;
    }
    expect(screen.getByText(/caught: useApp/)).toBeInTheDocument();
  });

  it('notifyNexusOpen surfaces a sticky toast with the mod name', async () => {
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    act(() => {
      captured!.notifyNexusOpen('AutoPath');
    });
    expect(screen.getByText(/Opened AutoPath on Nexus/)).toBeInTheDocument();
  });

  it('notifyNexusOpen supersedes the prior sticky toast', async () => {
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    act(() => { captured!.notifyNexusOpen('AutoPath'); });
    act(() => { captured!.notifyNexusOpen('BaseLib'); });
    expect(screen.queryByText(/Opened AutoPath on Nexus/)).toBeNull();
    expect(screen.getByText(/Opened BaseLib on Nexus/)).toBeInTheDocument();
  });

  it('updateAllGithub confirms, invokes update_all_mods, toasts, and refreshes audit rows', async () => {
    registerInvokeHandler('get_installed_mods', () => [
      { name: 'A', version: '1.0.0', enabled: true, files: [] },
    ]);
    registerInvokeHandler('get_game_info', () => ({
      game_path: 'C:/games/STS2', mods_path: 'C:/games/STS2/mods',
      disabled_mods_path: 'C:/games/STS2/mods_disabled',
      mods_count: 1, disabled_count: 0, valid: true, game_version: '0.105.0',
    }));
    registerInvokeHandler('get_active_profile', () => null);
    let updateAllCalls = 0;
    registerInvokeHandler('update_all_mods', () => {
      updateAllCalls += 1;
      return [{ name: 'A', version: '2.0.0', enabled: true, files: [] }];
    });
    let auditCalls = 0;
    registerInvokeHandler('audit_mod_versions', () => {
      auditCalls += 1;
      return [];
    });

    let captured: ReturnType<typeof useApp> | null = null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => expect(captured?.loading).toBe(false));

    // Kick the bulk update — confirm dialog will appear, click its primary
    // button to proceed.
    const user = userEvent.setup();
    let bulkPromise: Promise<void> | null = null;
    act(() => {
      bulkPromise = captured!.updateAllGithub(['A']);
    });
    const confirmBtn = await screen.findByRole('button', { name: /^Update 1 mod$/ });
    await user.click(confirmBtn);
    await bulkPromise!;

    expect(updateAllCalls).toBe(1);
    // Targeted re-audit happens after the bulk update completes.
    expect(auditCalls).toBe(1);
  });
});
