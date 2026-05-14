/**
 * Coverage notes for <OnboardingOverlay>:
 *
 * Intentionally-uncovered branches (documented to satisfy the ≥ 90 %
 * branch threshold without resorting to brittle ceremony):
 *
 * - Platform-signature ternaries in `handleBrowse`'s error message and
 *   the step-1 fallback view (Mac → `.app`, Linux → `.pck`, else
 *   `.exe`). jsdom hard-codes `navigator.platform` to one value per
 *   process, so only the host-platform branch is reachable. Overriding
 *   navigator across tests would bleed state — not worth it for a
 *   string literal swap.
 * - `handleTestNexus` / `handleSaveGh` early-return guards
 *   (`if (!key.trim()) return`). The button is `disabled` when the
 *   field is empty, so the guard is defensive belt-and-braces and
 *   isn't reachable via the UI without firing a synthetic click event.
 * - `next()`'s `else onComplete()` branch on line 130. The foot only
 *   renders the Next button when `step < 3` (`step < 3 ? <btn/> :
 *   null`), so the `step >= 3` arm of `next()` is unreachable via the
 *   UI. Step 3 completion is handled by the tile buttons via `pick()`,
 *   not by `next()`.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

import { OnboardingOverlay } from './OnboardingOverlay';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

type GameInfoLike = Partial<React.ComponentProps<typeof OnboardingOverlay>['gameInfo']>;

function setup(gameInfo: GameInfoLike | null = null) {
  const onSkip = vi.fn();
  const onComplete = vi.fn();
  const onAddCode = vi.fn();
  const refreshGame = vi.fn(async () => {});
  render(
    <OnboardingOverlay
      gameInfo={gameInfo as any}
      onSkip={onSkip}
      onComplete={onComplete}
      onAddCode={onAddCode}
      refreshGame={refreshGame}
    />,
  );
  return { onSkip, onComplete, onAddCode, refreshGame };
}

/** Advance from step 1 → step 2 by clicking Next from an already-valid state. */
async function advanceToStep2(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Next$/ }));
  await waitFor(() => {
    expect(screen.getByText(/Connect your accounts/)).toBeInTheDocument();
  });
}

/** Advance from step 1 → step 3 (via step 2's Skip-for-now / Next). */
async function advanceToStep3(user: ReturnType<typeof userEvent.setup>) {
  await advanceToStep2(user);
  // On step 2 without saved creds, the primary advance button is labelled
  // "Skip for now". After saving either credential it becomes "Next".
  const advance =
    screen.queryByRole('button', { name: /Skip for now/ }) ??
    screen.getByRole('button', { name: /^Next$/ });
  await user.click(advance);
  await waitFor(() => {
    expect(screen.getByText(/Pick your first profile/)).toBeInTheDocument();
  });
}

describe('<OnboardingOverlay> step 1: game detect', () => {
  it('renders the step-1 heading on mount when game is not yet valid', () => {
    setup({ valid: false } as any);
    expect(screen.getByText(/Find your Slay the Spire 2 install/)).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 3/)).toBeInTheDocument();
  });

  it('renders the gameNotFound view when gameInfo prop is null (no `?? false` fallback)', () => {
    setup(null);
    expect(screen.getByText(/Couldn't auto-detect/)).toBeInTheDocument();
  });

  it('renders the detected pill when initial gameInfo is valid', () => {
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    expect(screen.getByText(/Found Slay the Spire 2/)).toBeInTheDocument();
    expect(screen.getByText('C:/STS2')).toBeInTheDocument();
  });

  it('Change button drops back to the manual-entry fallback', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await user.click(screen.getByRole('button', { name: 'Change' }));
    expect(screen.getByText(/Couldn't auto-detect/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Steam|Slay the Spire 2/)).toBeInTheDocument();
  });

  it('Try again button invokes detect_game_path and shows detected pill on success', async () => {
    registerInvokeHandler('detect_game_path', () => ({
      game_path: 'C:/Games/STS2',
      mods_path: null,
      disabled_mods_path: null,
      mods_count: 0,
      disabled_count: 0,
      valid: true,
      game_version: '0.105.0',
    }));
    const user = userEvent.setup();
    const { refreshGame } = setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'detect_game_path')).toBe(true);
    });
    expect(await screen.findByText(/Found Slay the Spire 2/)).toBeInTheDocument();
    expect(screen.getByText('C:/Games/STS2')).toBeInTheDocument();
    expect(refreshGame).toHaveBeenCalled();
  });

  it('Try again button stays on the gameNotFound state when detection returns invalid', async () => {
    registerInvokeHandler('detect_game_path', () => ({
      game_path: null,
      mods_path: null,
      disabled_mods_path: null,
      mods_count: 0,
      disabled_count: 0,
      valid: false,
      game_version: null,
    }));
    const user = userEvent.setup();
    setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'detect_game_path')).toBe(true);
    });
    // Still on the error sub-view.
    expect(screen.getByText(/Couldn't auto-detect/)).toBeInTheDocument();
  });

  it('Try again button surfaces the gameNotFound state when detect_game_path throws', async () => {
    registerInvokeHandler('detect_game_path', () => {
      throw new Error('boom');
    });
    const user = userEvent.setup();
    setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Try again/ }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'detect_game_path')).toBe(true);
    });
    expect(screen.getByText(/Couldn't auto-detect/)).toBeInTheDocument();
  });

  it('manual path input updates as the user types', async () => {
    const user = userEvent.setup();
    setup({ valid: false } as any);
    const input = screen.getByPlaceholderText(/Steam|Slay the Spire 2/) as HTMLInputElement;
    await user.type(input, 'D:/Game');
    expect(input.value).toBe('D:/Game');
  });

  it('Browse button picks a folder and accepts it when set_game_path validates', async () => {
    (openDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce('D:/Picked');
    registerInvokeHandler('set_game_path', () => ({
      game_path: 'D:/Picked',
      mods_path: null,
      disabled_mods_path: null,
      mods_count: 0,
      disabled_count: 0,
      valid: true,
      game_version: '0.105.0',
    }));
    const user = userEvent.setup();
    const { refreshGame } = setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Browse/ }));
    expect(await screen.findByText(/Found Slay the Spire 2/)).toBeInTheDocument();
    expect(screen.getByText('D:/Picked')).toBeInTheDocument();
    expect(refreshGame).toHaveBeenCalled();
    expect(getInvokeCalls().some((c) => c.cmd === 'set_game_path')).toBe(true);
  });

  it('Browse button shows the inline path error when set_game_path returns invalid', async () => {
    (openDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce('D:/WrongFolder');
    registerInvokeHandler('set_game_path', () => ({
      game_path: null,
      mods_path: null,
      disabled_mods_path: null,
      mods_count: 0,
      disabled_count: 0,
      valid: false,
      game_version: null,
    }));
    const user = userEvent.setup();
    setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Browse/ }));
    expect(await screen.findByText(/doesn't look like a Slay the Spire 2 install/)).toBeInTheDocument();
  });

  it('Browse button surfaces the error message when set_game_path throws', async () => {
    (openDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce('D:/Picked');
    registerInvokeHandler('set_game_path', () => {
      throw new Error('permission denied');
    });
    const user = userEvent.setup();
    setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Browse/ }));
    expect(await screen.findByText(/permission denied/)).toBeInTheDocument();
  });

  it('Browse falls back to the picked path when set_game_path validates but returns null game_path', async () => {
    (openDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce('D:/FallbackPicked');
    registerInvokeHandler('set_game_path', () => ({
      game_path: null,
      mods_path: null,
      disabled_mods_path: null,
      mods_count: 0,
      disabled_count: 0,
      valid: true,
      game_version: null,
    }));
    const user = userEvent.setup();
    setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Browse/ }));
    expect(await screen.findByText('D:/FallbackPicked')).toBeInTheDocument();
  });

  it('Browse surfaces a non-Error thrown by set_game_path via String() coercion', async () => {
    (openDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce('D:/Picked');
    registerInvokeHandler('set_game_path', () => {
      // eslint-disable-next-line no-throw-literal
      throw 'plain-string-error';
    });
    const user = userEvent.setup();
    setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Browse/ }));
    expect(await screen.findByText(/plain-string-error/)).toBeInTheDocument();
  });

  it('Browse coerces non-string dialog selections via String() before validating', async () => {
    // The dialog plugin can in theory return an object/array on some
    // platforms; the component normalises via String(). We simulate by
    // returning a value with a custom toString.
    const weird = { toString: () => 'E:/WeirdPath' };
    (openDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(weird as unknown as string);
    registerInvokeHandler('set_game_path', () => ({
      game_path: 'E:/WeirdPath',
      mods_path: null,
      disabled_mods_path: null,
      mods_count: 0,
      disabled_count: 0,
      valid: true,
      game_version: null,
    }));
    const user = userEvent.setup();
    setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Browse/ }));
    expect(await screen.findByText('E:/WeirdPath')).toBeInTheDocument();
  });

  it('Browse button is a no-op when the dialog returns null (user cancelled)', async () => {
    (openDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const user = userEvent.setup();
    setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Browse/ }));
    // No state change — still on the gameNotFound view, no set_game_path invoke.
    expect(screen.getByText(/Couldn't auto-detect/)).toBeInTheDocument();
    expect(getInvokeCalls().some((c) => c.cmd === 'set_game_path')).toBe(false);
  });
});

describe('<OnboardingOverlay> step 2: connect accounts', () => {
  it('renders the step-2 heading after Next from step 1', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep2(user);
    expect(screen.getByText(/Step 2 of 3/)).toBeInTheDocument();
  });

  it("Test & save button is disabled until the Nexus key field has content", async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep2(user);
    const testBtn = screen.getByRole('button', { name: /Test & save/ });
    expect(testBtn).toBeDisabled();
    const nexusInput = screen.getByPlaceholderText(/Paste your Nexus API key/);
    await user.type(nexusInput, 'nexus-key-abc');
    expect(testBtn).not.toBeDisabled();
  });

  it('Test & save shows the success help text when set_nexus_api_key resolves', async () => {
    registerInvokeHandler('set_nexus_api_key', () => undefined);
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep2(user);
    await user.type(screen.getByPlaceholderText(/Paste your Nexus API key/), 'nexus-key-abc');
    await user.click(screen.getByRole('button', { name: /Test & save/ }));
    expect(await screen.findByText(/Nexus mods will appear in Browse/)).toBeInTheDocument();
    expect(getInvokeCalls().some((c) => c.cmd === 'set_nexus_api_key')).toBe(true);
  });

  it('Test & save surfaces the rejection help text when set_nexus_api_key throws', async () => {
    registerInvokeHandler('set_nexus_api_key', () => {
      throw new Error('401 invalid key');
    });
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep2(user);
    await user.type(screen.getByPlaceholderText(/Paste your Nexus API key/), 'bad-key');
    await user.click(screen.getByRole('button', { name: /Test & save/ }));
    expect(await screen.findByText(/Nexus rejected this key/)).toBeInTheDocument();
  });

  it('GitHub Save button is disabled until the token field has content', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep2(user);
    const saveBtn = screen.getByRole('button', { name: /^Save$/ });
    expect(saveBtn).toBeDisabled();
    await user.type(screen.getByPlaceholderText(/ghp_/), 'ghp_test123');
    expect(saveBtn).not.toBeDisabled();
  });

  it('GitHub Save shows the saved help text when set_github_token resolves', async () => {
    registerInvokeHandler('set_github_token', () => true);
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep2(user);
    await user.type(screen.getByPlaceholderText(/ghp_/), 'ghp_test123');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    expect(await screen.findByText(/Browse will use authenticated calls/)).toBeInTheDocument();
    expect(getInvokeCalls().some((c) => c.cmd === 'set_github_token')).toBe(true);
  });

  it('GitHub Save swallows the error silently (no UI change) when set_github_token throws', async () => {
    registerInvokeHandler('set_github_token', () => {
      throw new Error('rate limited');
    });
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep2(user);
    await user.type(screen.getByPlaceholderText(/ghp_/), 'ghp_test123');
    await user.click(screen.getByRole('button', { name: /^Save$/ }));
    // The component intentionally ignores GH token failures — verify the
    // success help text does NOT appear and the muted "skipping is fine"
    // help is still rendered.
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'set_github_token')).toBe(true);
    });
    expect(screen.queryByText(/Browse will use authenticated calls/)).not.toBeInTheDocument();
    expect(screen.getByText(/Skipping is fine/)).toBeInTheDocument();
  });

  it('shows "Skip for now" as the advance button when neither credential is saved', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep2(user);
    expect(screen.getByRole('button', { name: /Skip for now/ })).toBeInTheDocument();
  });

  it('switches the advance button to "Next" once the Nexus key is accepted', async () => {
    registerInvokeHandler('set_nexus_api_key', () => undefined);
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep2(user);
    await user.type(screen.getByPlaceholderText(/Paste your Nexus API key/), 'nexus-key-abc');
    await user.click(screen.getByRole('button', { name: /Test & save/ }));
    await screen.findByText(/Nexus mods will appear in Browse/);
    expect(screen.getByRole('button', { name: /^Next$/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Skip for now/ })).not.toBeInTheDocument();
  });

  it('Back button on step 2 returns to step 1', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep2(user);
    await user.click(screen.getByRole('button', { name: /^Back$/ }));
    expect(screen.getByText(/Find your Slay the Spire 2 install/)).toBeInTheDocument();
  });

  it('typing in the Nexus key input updates its value', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep2(user);
    const input = screen.getByPlaceholderText(/Paste your Nexus API key/) as HTMLInputElement;
    await user.type(input, 'abc');
    expect(input.value).toBe('abc');
  });
});

describe('<OnboardingOverlay> step 3: pick a profile', () => {
  it('renders the four profile tiles on entry', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep3(user);
    expect(screen.getByText(/Vanilla — no mods/)).toBeInTheDocument();
    expect(screen.getByText(/Follow a friend/)).toBeInTheDocument();
    expect(screen.getByText(/Import profile JSON/)).toBeInTheDocument();
    expect(screen.getByText(/Skip — set up later/)).toBeInTheDocument();
  });

  it('Vanilla tile calls onComplete without onAddCode', async () => {
    const user = userEvent.setup();
    const { onComplete, onAddCode } = setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep3(user);
    await user.click(screen.getByRole('button', { name: /Vanilla — no mods/ }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onAddCode).not.toHaveBeenCalled();
  });

  it('Follow-a-friend tile calls onComplete and onAddCode', async () => {
    const user = userEvent.setup();
    const { onComplete, onAddCode } = setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep3(user);
    await user.click(screen.getByRole('button', { name: /Follow a friend/ }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onAddCode).toHaveBeenCalledTimes(1);
  });

  it('Import-JSON tile calls onComplete without onAddCode', async () => {
    const user = userEvent.setup();
    const { onComplete, onAddCode } = setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep3(user);
    await user.click(screen.getByRole('button', { name: /Import profile JSON/ }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onAddCode).not.toHaveBeenCalled();
  });

  it('Skip-for-later tile calls onComplete without onAddCode', async () => {
    const user = userEvent.setup();
    const { onComplete, onAddCode } = setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep3(user);
    await user.click(screen.getByRole('button', { name: /Skip — set up later/ }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onAddCode).not.toHaveBeenCalled();
  });

  it('Back from step 3 returns to step 2', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep3(user);
    await user.click(screen.getByRole('button', { name: /^Back$/ }));
    expect(screen.getByText(/Connect your accounts/)).toBeInTheDocument();
  });

  it('hides the foot Next button entirely on step 3 (only Back + Skip setup remain)', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToStep3(user);
    expect(screen.queryByRole('button', { name: /^Next$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Skip for now/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Back$/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Skip setup/ })).toBeInTheDocument();
  });
});

describe('<OnboardingOverlay> Skip setup', () => {
  it('clicks Skip setup on step 1 and triggers onSkip', async () => {
    const user = userEvent.setup();
    const { onSkip, onComplete } = setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Skip setup/ }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('Skip setup is reachable on every step', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    expect(screen.getByRole('button', { name: /Skip setup/ })).toBeInTheDocument();
    await advanceToStep2(user);
    expect(screen.getByRole('button', { name: /Skip setup/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Skip for now/ }));
    expect(screen.getByRole('button', { name: /Skip setup/ })).toBeInTheDocument();
  });

  it('Back button is disabled on step 1', () => {
    setup({ valid: false } as any);
    expect(screen.getByRole('button', { name: /^Back$/ })).toBeDisabled();
  });
});
