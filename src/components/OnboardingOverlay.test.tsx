/**
 * 1.7.0 T8 — branched first-launch onboarding flow.
 *
 * The overlay used to be a linear three-step wizard (detect game →
 * credentials → profile choice). It's now a branched flow:
 *   detect-game → audience choice → 2 teaching cards per audience.
 *
 * Two big invariants the test suite enforces:
 *
 *   1. NO password-type input anywhere in the overlay. The credentials
 *      step is gone; the new flow never asks for a Nexus API key or
 *      a GitHub token at first launch. GitHub setup is deferred to
 *      share time (ShareSetupPanel) and Nexus key entry happens on
 *      the first manual Nexus install.
 *
 *   2. NO input labelled like a token/api-key field. We allow the
 *      WORD "GitHub" in the creator-path card 2 body (because that
 *      card explicitly tells the user the app handles GitHub setup
 *      later, not now), but no labelled INPUT may be present.
 *
 * Intentionally-uncovered branches:
 *
 *   - Platform-signature ternaries in `handleBrowse`'s error message
 *     and the detect-game fallback view. jsdom hard-codes
 *     `navigator.platform` to one value per process — see the OG file
 *     for the long explanation. Not worth bleeding state across tests
 *     for a string-literal swap.
 *   - `handleSomething` early-return guards on empty input strings:
 *     the button is `disabled` when the field is empty, so the guard
 *     is defensive belt-and-braces.
 */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

import { OnboardingOverlay } from './OnboardingOverlay';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';

type GameInfoLike = Partial<React.ComponentProps<typeof OnboardingOverlay>['gameInfo']>;

function setup(gameInfo: GameInfoLike | null = null) {
  const onSkip = vi.fn();
  const onComplete = vi.fn();
  const onCreateModpack = vi.fn();
  const onGoToHome = vi.fn();
  const onGoToModpacks = vi.fn();
  const refreshGame = vi.fn(async () => {});
  render(
    <OnboardingOverlay
      gameInfo={gameInfo as any}
      onSkip={onSkip}
      onComplete={onComplete}
      onCreateModpack={onCreateModpack}
      onGoToHome={onGoToHome}
      onGoToModpacks={onGoToModpacks}
      refreshGame={refreshGame}
    />,
  );
  return { onSkip, onComplete, onCreateModpack, onGoToHome, onGoToModpacks, refreshGame };
}

/** Walk from a freshly mounted overlay (with a valid game seeded so the
 *  detect-game step is already in its OK state) to the audience-choice
 *  step. */
async function advanceToAudience(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Continue$/i }));
  expect(await screen.findByText(/What do you want to do\?/i)).toBeInTheDocument();
}

describe('<OnboardingOverlay> step 1: detect-game', () => {
  it('renders the step-1 heading on mount when game is not yet valid', () => {
    setup({ valid: false } as any);
    expect(screen.getByText(/Find your Slay the Spire 2 install/i)).toBeInTheDocument();
    expect(screen.getByText(/Step 1 of 2/i)).toBeInTheDocument();
  });

  it('offers a language override during onboarding', () => {
    setup({ valid: false } as any);
    expect(screen.getByLabelText('Language')).toBeInTheDocument();
  });

  it('renders the gameNotFound view when gameInfo prop is null', () => {
    setup(null);
    expect(screen.getByText(/Couldn't auto-detect/i)).toBeInTheDocument();
  });

  it('renders the detected pill when initial gameInfo is valid', () => {
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    expect(screen.getByText(/Found Slay the Spire 2/i)).toBeInTheDocument();
    expect(screen.getByText('C:/STS2')).toBeInTheDocument();
  });

  it('Change button drops back to the manual-entry fallback', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await user.click(screen.getByRole('button', { name: /Change/i }));
    expect(screen.getByText(/Couldn't auto-detect/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/Steam|Slay the Spire 2/)).toBeInTheDocument();
  });

  it('Continue button is disabled until the game is detected', () => {
    setup({ valid: false } as any);
    expect(screen.getByRole('button', { name: /^Continue$/i })).toBeDisabled();
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
    await user.click(screen.getByRole('button', { name: /Try again/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'detect_game_path')).toBe(true);
    });
    expect(await screen.findByText(/Found Slay the Spire 2/i)).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: /Try again/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'detect_game_path')).toBe(true);
    });
    expect(screen.getByText(/Couldn't auto-detect/i)).toBeInTheDocument();
  });

  it('Try again button surfaces the gameNotFound state when detect_game_path throws', async () => {
    registerInvokeHandler('detect_game_path', () => {
      throw new Error('boom');
    });
    const user = userEvent.setup();
    setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Try again/i }));
    await waitFor(() => {
      expect(getInvokeCalls().some((c) => c.cmd === 'detect_game_path')).toBe(true);
    });
    expect(screen.getByText(/Couldn't auto-detect/i)).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: /Browse/i }));
    expect(await screen.findByText(/Found Slay the Spire 2/i)).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: /Browse/i }));
    expect(await screen.findByText(/doesn't look like a Slay the Spire 2 install/i)).toBeInTheDocument();
  });

  it('Browse button surfaces the error message when set_game_path throws', async () => {
    (openDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce('D:/Picked');
    registerInvokeHandler('set_game_path', () => {
      throw new Error('permission denied');
    });
    const user = userEvent.setup();
    setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Browse/i }));
    expect(await screen.findByText(/permission denied/i)).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: /Browse/i }));
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
    await user.click(screen.getByRole('button', { name: /Browse/i }));
    expect(await screen.findByText(/plain-string-error/i)).toBeInTheDocument();
  });

  it('Browse coerces non-string dialog selections via String() before validating', async () => {
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
    await user.click(screen.getByRole('button', { name: /Browse/i }));
    expect(await screen.findByText('E:/WeirdPath')).toBeInTheDocument();
  });

  it('Browse button is a no-op when the dialog returns null (user cancelled)', async () => {
    (openDialog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const user = userEvent.setup();
    setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Browse/i }));
    expect(screen.getByText(/Couldn't auto-detect/i)).toBeInTheDocument();
    expect(getInvokeCalls().some((c) => c.cmd === 'set_game_path')).toBe(false);
  });
});

describe('<OnboardingOverlay> step 2: audience choice', () => {
  it('renders the audience-choice heading after Continue from step 1', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    expect(screen.getByText(/Step 2 of 2/i)).toBeInTheDocument();
  });

  it('shows two large audience buttons with descriptions', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    expect(screen.getByRole('button', { name: /Play modpacks others made/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Make or share modpacks/i })).toBeInTheDocument();
  });

  it('player button routes to the player-path card 1', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Play modpacks others made/i }));
    expect(await screen.findByText(/Modpacks are saved sets of mods/i)).toBeInTheDocument();
  });

  it('creator button routes to the creator-path card 1', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Make or share modpacks/i }));
    expect(await screen.findByText(/Build a modpack/i)).toBeInTheDocument();
  });

  it('Back from audience returns to detect-game', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /^Back$/i }));
    expect(screen.getByText(/Find your Slay the Spire 2 install/i)).toBeInTheDocument();
  });
});

describe('<OnboardingOverlay> player path', () => {
  it('player card 1 → Next → player card 2', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Play modpacks others made/i }));
    await user.click(screen.getByRole('button', { name: /^Next$/i }));
    expect(await screen.findByText(/Press Play to start/i)).toBeInTheDocument();
  });

  it('player card 2 "Got it" CTA calls onComplete + onGoToHome', async () => {
    const user = userEvent.setup();
    const { onComplete, onGoToHome } = setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Play modpacks others made/i }));
    await user.click(screen.getByRole('button', { name: /^Next$/i }));
    await user.click(screen.getByRole('button', { name: /^Got it$/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onGoToHome).toHaveBeenCalledTimes(1);
  });

  it('player card 1 Back returns to audience choice', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Play modpacks others made/i }));
    await user.click(screen.getByRole('button', { name: /^Back$/i }));
    expect(screen.getByText(/What do you want to do\?/i)).toBeInTheDocument();
  });

  it('player card 2 Back returns to player card 1', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Play modpacks others made/i }));
    await user.click(screen.getByRole('button', { name: /^Next$/i }));
    await user.click(screen.getByRole('button', { name: /^Back$/i }));
    expect(screen.getByText(/Modpacks are saved sets of mods/i)).toBeInTheDocument();
  });
});

describe('<OnboardingOverlay> creator path', () => {
  it('creator card 1 → Next → creator card 2', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Make or share modpacks/i }));
    await user.click(screen.getByRole('button', { name: /^Next$/i }));
    expect(await screen.findByText(/Share when you're ready/i)).toBeInTheDocument();
  });

  it('creator card 2 "Create my first modpack" CTA calls onComplete + onCreateModpack', async () => {
    const user = userEvent.setup();
    const { onComplete, onCreateModpack } = setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Make or share modpacks/i }));
    await user.click(screen.getByRole('button', { name: /^Next$/i }));
    await user.click(screen.getByRole('button', { name: /Create my first modpack/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onCreateModpack).toHaveBeenCalledTimes(1);
  });

  it('creator card 2 "I\'ll do it later" CTA calls onComplete only', async () => {
    const user = userEvent.setup();
    const { onComplete, onCreateModpack } = setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Make or share modpacks/i }));
    await user.click(screen.getByRole('button', { name: /^Next$/i }));
    await user.click(screen.getByRole('button', { name: /I'll do it later/i }));
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onCreateModpack).not.toHaveBeenCalled();
  });

  it('creator card 1 Back returns to audience choice', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Make or share modpacks/i }));
    await user.click(screen.getByRole('button', { name: /^Back$/i }));
    expect(screen.getByText(/What do you want to do\?/i)).toBeInTheDocument();
  });

  it('creator card 2 Back returns to creator card 1', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Make or share modpacks/i }));
    await user.click(screen.getByRole('button', { name: /^Next$/i }));
    await user.click(screen.getByRole('button', { name: /^Back$/i }));
    expect(screen.getByText(/Build a modpack/i)).toBeInTheDocument();
  });
});

describe('<OnboardingOverlay> Skip behaviour', () => {
  it('Skip button on detect-game calls onSkip', async () => {
    const user = userEvent.setup();
    const { onSkip, onComplete } = setup({ valid: false } as any);
    await user.click(screen.getByRole('button', { name: /Skip setup/i }));
    expect(onSkip).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('Skip is reachable from every step in the player branch', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    expect(screen.getByRole('button', { name: /Skip setup/i })).toBeInTheDocument();
    await advanceToAudience(user);
    expect(screen.getByRole('button', { name: /Skip setup/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Play modpacks others made/i }));
    expect(screen.getByRole('button', { name: /Skip setup/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Next$/i }));
    expect(screen.getByRole('button', { name: /Skip setup/i })).toBeInTheDocument();
  });

  it('Skip is reachable from every step in the creator branch', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    expect(screen.getByRole('button', { name: /Skip setup/i })).toBeInTheDocument();
    await advanceToAudience(user);
    expect(screen.getByRole('button', { name: /Skip setup/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Make or share modpacks/i }));
    expect(screen.getByRole('button', { name: /Skip setup/i })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /^Next$/i }));
    expect(screen.getByRole('button', { name: /Skip setup/i })).toBeInTheDocument();
  });

  it('Back is disabled on detect-game', () => {
    setup({ valid: false } as any);
    expect(screen.getByRole('button', { name: /^Back$/i })).toBeDisabled();
  });
});

describe('<OnboardingOverlay> credentials invariants (T8)', () => {
  // The new flow MUST NOT ask the user for any credentials. These tests
  // walk every step in both branches and assert that no
  // password-typed input ever appears, and no input is labelled like
  // a token / api-key / nexus field.

  function assertNoCredentialInputs() {
    const container = document.body;
    const passwordInputs = container.querySelectorAll('input[type="password"]');
    expect(passwordInputs.length).toBe(0);

    const allInputs = Array.from(container.querySelectorAll('input'));
    const credentialLabeled = allInputs.filter((input) => {
      const aria = input.getAttribute('aria-label') ?? '';
      const placeholder = input.getAttribute('placeholder') ?? '';
      const haystack = `${aria} ${placeholder}`.toLowerCase();
      return /token|api[\s.-]?key|nexus/.test(haystack);
    });
    expect(credentialLabeled).toEqual([]);
  }

  it('detect-game step exposes no credential inputs', () => {
    setup({ valid: false } as any);
    assertNoCredentialInputs();
  });

  it('audience step exposes no credential inputs', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    assertNoCredentialInputs();
  });

  it('player card 1 exposes no credential inputs', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Play modpacks others made/i }));
    assertNoCredentialInputs();
  });

  it('player card 2 exposes no credential inputs', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Play modpacks others made/i }));
    await user.click(screen.getByRole('button', { name: /^Next$/i }));
    assertNoCredentialInputs();
  });

  it('creator card 1 exposes no credential inputs', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Make or share modpacks/i }));
    assertNoCredentialInputs();
  });

  it('creator card 2 exposes no credential inputs (even though GitHub is mentioned)', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Make or share modpacks/i }));
    await user.click(screen.getByRole('button', { name: /^Next$/i }));
    // Sanity check: the card *does* mention GitHub by name to explain
    // it's handled at share time. We're verifying there's no input
    // field, not the absence of the word.
    const dialog = screen.getByText(/Share when you're ready/i).closest('.gf-wiz');
    expect(dialog).toBeTruthy();
    expect(within(dialog as HTMLElement).getByText(/GitHub/i)).toBeInTheDocument();
    assertNoCredentialInputs();
  });

  it('does not invoke any credential-saving tauri commands', async () => {
    const user = userEvent.setup();
    setup({ valid: true, game_path: 'C:/STS2' } as any);
    await advanceToAudience(user);
    await user.click(screen.getByRole('button', { name: /Make or share modpacks/i }));
    await user.click(screen.getByRole('button', { name: /^Next$/i }));
    await user.click(screen.getByRole('button', { name: /I'll do it later/i }));
    const calls = getInvokeCalls();
    expect(calls.find((c) => c.cmd === 'set_nexus_api_key')).toBeUndefined();
    expect(calls.find((c) => c.cmd === 'set_github_token')).toBeUndefined();
  });
});
