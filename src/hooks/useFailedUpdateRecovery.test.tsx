import { type ReactNode } from 'react';
import { act, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { ConfirmProvider } from '../components/ConfirmDialog';
import { ToastProvider } from '../contexts/ToastContext';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import { useFailedUpdateRecovery } from './useFailedUpdateRecovery';

function Providers({ children }: { children: ReactNode }) {
  return (
    <ToastProvider>
      <ConfirmProvider>{children}</ConfirmProvider>
    </ToastProvider>
  );
}

const snoozeCalls = () => getInvokeCalls().filter((c) => c.cmd === 'set_mod_snooze');

describe('useFailedUpdateRecovery', () => {
  it('does not prompt when the failed update has no version to skip', async () => {
    const { result } = renderHook(() => useFailedUpdateRecovery(), { wrapper: Providers });
    let recovered = true;

    await act(async () => {
      recovered = await result.current({
        modName: 'NoVersion',
        skipVersion: '  ',
        error: new Error('missing tag'),
      });
    });

    expect(recovered).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(snoozeCalls()).toHaveLength(0);
  });

  it('truncates long failure reasons and reports Error skip-save failures', async () => {
    registerInvokeHandler('set_mod_snooze', () => {
      throw new Error('settings locked');
    });
    const user = userEvent.setup();
    const { result } = renderHook(() => useFailedUpdateRecovery(), { wrapper: Providers });
    let recovery!: Promise<boolean>;

    act(() => {
      recovery = result.current({
        modName: 'Route Planner',
        displayName: 'Route Planner',
        folderName: null,
        skipVersion: ' v2.0.0 ',
        error: new Error(` ${'archive '.repeat(40)} `),
      });
    });

    const dialog = await screen.findByRole('dialog', {
      name: /Could not install update for Route Planner/i,
    });
    expect(within(dialog).getByText(/Reason: .*archive.*\.\.\./i)).toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: /Skip this update/i }));

    let recovered = true;
    await act(async () => {
      recovered = await recovery;
    });

    expect(recovered).toBe(false);
    expect(snoozeCalls()[0].args).toEqual({
      modName: 'Route Planner',
      folderName: null,
      latestTag: 'v2.0.0',
    });
    expect(await screen.findByText(/Could not skip this update: settings locked/i)).toBeInTheDocument();
  });

  it('reports non-Error skip-save failures', async () => {
    registerInvokeHandler('set_mod_snooze', () => {
      throw 'permission denied';
    });
    const user = userEvent.setup();
    const { result } = renderHook(() => useFailedUpdateRecovery(), { wrapper: Providers });
    let recovery!: Promise<boolean>;

    act(() => {
      recovery = result.current({
        modName: 'BareFailure',
        folderName: 'BareFailure',
        skipVersion: 'v3.0.0',
        error: 'install failed',
      });
    });

    const dialog = await screen.findByRole('dialog', {
      name: /Could not install update for BareFailure/i,
    });
    await user.click(within(dialog).getByRole('button', { name: /Skip this update/i }));

    let recovered = true;
    await act(async () => {
      recovered = await recovery;
    });

    expect(recovered).toBe(false);
    expect(await screen.findByText(/Could not skip this update: permission denied/i)).toBeInTheDocument();
  });

  it('keeps a saved skip even when the refresh callback fails', async () => {
    registerInvokeHandler('set_mod_snooze', () => true);
    const user = userEvent.setup();
    const { result } = renderHook(() => useFailedUpdateRecovery(), { wrapper: Providers });
    let recovery!: Promise<boolean>;

    act(() => {
      recovery = result.current({
        modName: 'FallbackName',
        displayName: '  ',
        folderName: 'FallbackName',
        skipVersion: 'v4.0.0',
        error: '   ',
        onSkipped: () => {
          throw new Error('refresh failed');
        },
      });
    });

    const dialog = await screen.findByRole('dialog', {
      name: /Could not install update for FallbackName/i,
    });
    expect(within(dialog).getByText(/Reason: Unknown install error\./i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /Skip this update/i }));

    let recovered = false;
    await act(async () => {
      recovered = await recovery;
    });

    expect(recovered).toBe(true);
    expect(await screen.findByText(/Skipped this failed update for 'FallbackName'/i)).toBeInTheDocument();
  });
});
