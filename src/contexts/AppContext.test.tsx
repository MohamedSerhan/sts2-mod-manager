import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { listen as listenMock } from '@tauri-apps/api/event';

import { AppProvider, useApp } from './AppContext';
import { ToastProvider } from './ToastContext';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

/** Locate the most-recent `listen(event, cb)` registration installed by
 *  AppProvider during render and return the registered handler. Loud
 *  failure if none is found so we don't silently miss a regression. */
function getListenHandler<T>(event: string): (e: { payload: T }) => void {
  const spy = vi.mocked(listenMock);
  const reg = [...spy.mock.calls].reverse().find((c) => c[0] === event);
  expect(reg, `expected a listen('${event}', cb) registration`).toBeDefined();
  return reg![1] as (e: { payload: T }) => void;
}

/**
 * AppContext is the load-bearing state container for the entire UI.
 * Other test files exercise it indirectly through views/components;
 * this file pins the contract for the context itself — refresh,
 * audit, notifyNexusOpen, subUpdates filtering, gameRunning polling.
 */

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <ToastProvider>
      <AppProvider>{children}</AppProvider>
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

  it('setActiveProfile swallows a backend failure so the UI stays responsive', async () => {
    registerInvokeHandler('set_active_profile', () => { throw new Error('write failed'); });
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    act(() => { captured!.setActiveProfile('Doomed Pack'); });
    // The optimistic state update happens regardless; the rejection is
    // swallowed by the inline .catch(() => {}) so React doesn't see an
    // unhandled rejection.
    expect(captured?.activeProfile).toBe('Doomed Pack');
    // Flush microtasks so the rejected invoke resolves.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(captured?.activeProfile).toBe('Doomed Pack');
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

  it('mod-auto-installed event dismisses the pending Nexus sticky toast', async () => {
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    act(() => { captured!.notifyNexusOpen('AutoPath'); });
    expect(screen.getByText(/Opened AutoPath on Nexus/)).toBeInTheDocument();
    // Grab the handler AppProvider registered for `mod-auto-installed`
    // and fire it directly — covers the dismiss-via-watcher branch.
    const handler = getListenHandler<{ mod_name: string; file_name: string; replaced: string | null }>(
      'mod-auto-installed',
    );
    act(() => {
      handler({ payload: { mod_name: 'AutoPath', file_name: 'AutoPath.zip', replaced: null } });
    });
    await waitFor(() => {
      expect(screen.queryByText(/Opened AutoPath on Nexus/)).toBeNull();
    });
  });

  it('refreshSubUpdates failure is logged at debug level and does not crash', async () => {
    registerInvokeHandler('check_subscription_updates', () => { throw new Error('rate limit'); });
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    await waitFor(() => {
      expect(debugSpy).toHaveBeenCalledWith(
        'checkSubscriptionUpdates failed:',
        expect.any(Error),
      );
    });
    expect(captured?.subUpdates).toEqual([]);
    debugSpy.mockRestore();
  });

  it('refreshGameRunning failure leaves gameRunning=false and logs at debug', async () => {
    registerInvokeHandler('is_game_running_cmd', () => { throw new Error('proc enum failed'); });
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    await waitFor(() => {
      expect(debugSpy).toHaveBeenCalledWith(
        'isGameRunning check failed:',
        expect.any(Error),
      );
    });
    expect(captured?.gameRunning).toBe(false);
    debugSpy.mockRestore();
  });

  it('refreshGameRunning flips state when isGameRunning toggles true', async () => {
    let running = false;
    registerInvokeHandler('is_game_running_cmd', () => running);
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    expect(captured?.gameRunning).toBe(false);
    // Flip the underlying signal, then re-invoke refreshGameRunning from
    // the context — exercises the `running !== gameRunningRef.current`
    // branch and the setGameRunning(true) state update.
    running = true;
    await act(async () => { await captured!.refreshGameRunning(); });
    expect(captured?.gameRunning).toBe(true);
  });

  it('refreshGameInfo failure logs an error and leaves prior gameInfo intact', async () => {
    let firstCall = true;
    registerInvokeHandler('get_game_info', () => {
      if (firstCall) {
        firstCall = false;
        return {
          game_path: 'C:/games/STS2',
          mods_path: 'C:/games/STS2/mods',
          disabled_mods_path: 'C:/games/STS2/mods_disabled',
          mods_count: 0,
          disabled_count: 0,
          valid: true,
          game_version: '0.105.0',
        };
      }
      throw new Error('fs read failed');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    expect(captured?.gameInfo?.game_path).toBe('C:/games/STS2');
    // Second refreshGameInfo throws — gameInfo should NOT be wiped.
    await act(async () => { await captured!.refreshGameInfo(); });
    expect(errSpy).toHaveBeenCalledWith('Failed to get game info:', expect.any(Error));
    expect(captured?.gameInfo?.game_path).toBe('C:/games/STS2');
    errSpy.mockRestore();
  });

  it('refreshMods failure logs an error and leaves prior mods intact', async () => {
    let firstCall = true;
    registerInvokeHandler('get_installed_mods', () => {
      if (firstCall) {
        firstCall = false;
        return [{ name: 'BaseLib', version: '3.1.2', enabled: true, files: [] }];
      }
      throw new Error('mods read failed');
    });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    expect(captured?.mods).toHaveLength(1);
    await act(async () => { await captured!.refreshMods(); });
    expect(errSpy).toHaveBeenCalledWith('Failed to get mods:', expect.any(Error));
    expect(captured?.mods).toHaveLength(1);
    errSpy.mockRestore();
  });

  it('refreshAll swallows get_active_profile errors and still clears loading', async () => {
    registerInvokeHandler('get_active_profile', () => { throw new Error('db locked'); });
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    expect(captured?.activeProfile).toBeNull();
  });

  it('runAudit failure with a non-Error rejection still surfaces a string toast', async () => {
    registerInvokeHandler('audit_mod_versions', () => { throw 'bare string failure'; });
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    await act(async () => { await captured!.runAudit(); });
    expect(screen.getByText(/Audit failed.*bare string failure/)).toBeInTheDocument();
    // auditing flag must have reverted in the finally block.
    expect(captured?.auditing).toBe(false);
  });

  it('refreshAuditEntries before runAudit is a no-op (auditResults is still null)', async () => {
    // Targeted audit returns a row, but auditResults === null so the
    // setter short-circuits — covers the `if (!prev) return prev` branch.
    registerInvokeHandler('audit_mod_versions', () => [
      { mod_name: 'X', installed_version: '1.0', needs_update: false, pinned: false },
    ]);
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    expect(captured?.auditResults).toBeNull();
    await act(async () => { await captured!.refreshAuditEntries(['X']); });
    // Still null — the merge path bailed because prev was null.
    expect(captured?.auditResults).toBeNull();
  });

  it('refreshAuditEntries swallows a targeted-audit failure', async () => {
    let callCount = 0;
    registerInvokeHandler('audit_mod_versions', () => {
      callCount += 1;
      if (callCount === 1) {
        return [{ mod_name: 'A', installed_version: '1.0', needs_update: false, pinned: false }];
      }
      throw new Error('GitHub 403');
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
    // Targeted refresh throws — prior rows must stay put.
    await act(async () => { await captured!.refreshAuditEntries(['A']); });
    expect(captured?.auditResults).toHaveLength(1);
    expect(captured?.auditResults?.[0].installed_version).toBe('1.0');
  });

  it('mod-auto-installed event refreshes audit entries when an audit is loaded', async () => {
    let auditCalls = 0;
    let lastArgs: Record<string, unknown> | undefined;
    registerInvokeHandler('audit_mod_versions', (args) => {
      auditCalls += 1;
      lastArgs = args;
      if (auditCalls === 1) {
        return [{ mod_name: 'A', installed_version: '1.0', needs_update: false, pinned: false }];
      }
      // Targeted refresh response.
      return [
        { mod_name: 'A', installed_version: '2.0', needs_update: false, pinned: false },
        { mod_name: 'NewMod', installed_version: '0.1', needs_update: false, pinned: false },
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
    expect(captured?.auditResults).toHaveLength(1);

    // The audit listener re-binds when `auditResults === null` flips, so
    // grab the most-recent listener AFTER runAudit completes.
    const handler = getListenHandler<{ mod_name: string; file_name: string; replaced: string | null }>(
      'mod-auto-installed',
    );
    await act(async () => {
      handler({
        payload: { mod_name: 'NewMod', file_name: 'NewMod-0.1.zip', replaced: 'A' },
      });
      // Let the spawned refreshAuditEntries promise settle.
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(captured?.auditResults?.find((r) => r.mod_name === 'NewMod')).toBeTruthy();
    });
    expect(captured?.auditResults?.find((r) => r.mod_name === 'A')?.installed_version).toBe('2.0');
    // The targeted audit call should have included BOTH names — the
    // event's mod_name and its replaced field.
    expect(lastArgs?.only).toEqual(['NewMod', 'A']);
  });

  it('mod-auto-installed event with replaced === mod_name dedupes to a single name', async () => {
    let lastArgs: Record<string, unknown> | undefined;
    let auditCalls = 0;
    registerInvokeHandler('audit_mod_versions', (args) => {
      auditCalls += 1;
      lastArgs = args;
      if (auditCalls === 1) {
        return [{ mod_name: 'Same', installed_version: '1.0', needs_update: false, pinned: false }];
      }
      return [{ mod_name: 'Same', installed_version: '2.0', needs_update: false, pinned: false }];
    });
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    await act(async () => { await captured!.runAudit(); });

    const handler = getListenHandler<{ mod_name: string; file_name: string; replaced: string | null }>(
      'mod-auto-installed',
    );
    await act(async () => {
      handler({ payload: { mod_name: 'Same', file_name: 'Same.zip', replaced: 'Same' } });
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(captured?.auditResults?.[0].installed_version).toBe('2.0');
    });
    // Only one name passed in (not duplicated) since replaced === mod_name.
    expect(lastArgs?.only).toEqual(['Same']);
  });

  it('mod-auto-installed event is ignored when no audit has been loaded', async () => {
    let auditCalls = 0;
    registerInvokeHandler('audit_mod_versions', () => {
      auditCalls += 1;
      return [];
    });
    let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
    render(
      <Wrap>
        <Probe onCtx={(c) => { captured = c; }} />
      </Wrap>,
    );
    await waitFor(() => { expect(captured?.loading).toBe(false); });
    expect(captured?.auditResults).toBeNull();

    const handler = getListenHandler<{ mod_name: string; file_name: string; replaced: string | null }>(
      'mod-auto-installed',
    );
    await act(async () => {
      handler({ payload: { mod_name: 'X', file_name: 'X.zip', replaced: null } });
      await Promise.resolve();
    });
    // No targeted audit fired because auditResults was null.
    expect(auditCalls).toBe(0);
    expect(captured?.auditResults).toBeNull();
  });

  describe('with fake timers', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('game-running polling: running→stopped transition triggers a mods refresh', async () => {
      let running = true;
      let modsCalls = 0;
      registerInvokeHandler('is_game_running_cmd', () => running);
      registerInvokeHandler('get_installed_mods', () => {
        modsCalls += 1;
        return [{ name: 'BaseLib', version: '3.1.2', enabled: true, files: [] }];
      });
      let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
      render(
        <Wrap>
          <Probe onCtx={(c) => { captured = c; }} />
        </Wrap>,
      );
      // Flush all pending microtasks (mount effects, refreshAll promises).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(captured?.loading).toBe(false);
      expect(captured?.gameRunning).toBe(true);
      const baselineModCalls = modsCalls;
      // First poll tick: still running, no transition → no extra mods call.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(modsCalls).toBe(baselineModCalls);
      expect(captured?.gameRunning).toBe(true);
      // Flip to stopped and tick again — should detect transition and
      // re-fetch installed mods.
      running = false;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(captured?.gameRunning).toBe(false);
      expect(modsCalls).toBeGreaterThan(baselineModCalls);
    });

    it('subUpdates polling re-runs every 5 minutes', async () => {
      let calls = 0;
      registerInvokeHandler('check_subscription_updates', () => {
        calls += 1;
        return [];
      });
      render(
        <Wrap>
          <Probe onCtx={() => {}} />
        </Wrap>,
      );
      // Initial call from the mount-effect.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const initial = calls;
      expect(initial).toBeGreaterThan(0);
      // One full 300_000ms interval → one additional call.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300_000);
      });
      expect(calls).toBe(initial + 1);
    });

    it('Nexus pending toast auto-dismisses after the failsafe timeout', async () => {
      let captured: ReturnType<typeof useApp> | null = null as unknown as ReturnType<typeof useApp> | null;
      render(
        <Wrap>
          <Probe onCtx={(c) => { captured = c; }} />
        </Wrap>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(captured?.loading).toBe(false);
      act(() => { captured!.notifyNexusOpen('SlowMod'); });
      expect(screen.getByText(/Opened SlowMod on Nexus/)).toBeInTheDocument();
      // Advance past the 10-minute failsafe — the timeout fires and the
      // pending toast is dismissed. Also flush the ToastItem fade timer
      // (FADE_MS=250ms) so the DOM node actually unmounts.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 500);
      });
      expect(screen.queryByText(/Opened SlowMod on Nexus/)).toBeNull();
    });

    it('unmount mid-poll cancels intervals and does not fire after teardown', async () => {
      let runningCalls = 0;
      registerInvokeHandler('is_game_running_cmd', () => {
        runningCalls += 1;
        return false;
      });
      const { unmount } = render(
        <Wrap>
          <Probe onCtx={() => {}} />
        </Wrap>,
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const callsAfterMount = runningCalls;
      unmount();
      // Advance past several poll intervals — interval was cleared, no
      // further is_game_running_cmd invocations should be observed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });
      expect(runningCalls).toBe(callsAfterMount);
    });
  });
});
