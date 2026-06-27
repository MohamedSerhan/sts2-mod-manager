import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AllProviders } from '../__test__/providers';
import type { LaunchHealthReport } from '../types';
import { LaunchHealthModal } from './LaunchHealthModal';

const baseReport = (overrides: Partial<LaunchHealthReport> = {}): LaunchHealthReport => ({
  active_profile_id: null,
  active_profile_name: null,
  current_game_version: null,
  last_launch_game_version: null,
  profile_game_version: null,
  game_version_changed_since_last_launch: false,
  profile_game_version_changed: false,
  known_incompatible_mods: [],
  dependency_blocked_mods: [],
  previous_failed_mods: [],
  ...overrides,
});

function renderModal(
  report: LaunchHealthReport,
  props: Partial<ComponentProps<typeof LaunchHealthModal>> = {},
) {
  const callbacks = {
    onStoreAndLaunch: vi.fn(),
    onLaunchAnyway: vi.fn(),
    onReview: vi.fn(),
    onCancel: vi.fn(),
  };
  const utils = render(
    <AllProviders>
      <LaunchHealthModal
        report={report}
        storing={false}
        {...callbacks}
        {...props}
      />
    </AllProviders>,
  );
  return { ...utils, callbacks };
}

describe('<LaunchHealthModal>', () => {
  it('shows a version-only warning without offering blocker storage', async () => {
    const user = userEvent.setup();
    const { callbacks, container } = renderModal(baseReport({
      game_version_changed_since_last_launch: true,
    }));

    expect(screen.getByRole('dialog', { name: /STS2 changed since this pack last launched/i })).toBeInTheDocument();
    expect(screen.getByText(/no active modpack was last used with a different STS2 build/i)).toBeInTheDocument();
    expect(screen.getByText(/Previous: vUnknown/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Store blocked mods and launch/i })).toBeNull();

    await user.click(container.querySelector('.gf-modal-back') as HTMLElement);
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
  });

  it('prioritizes previous launch failures and previews hidden blocker counts', () => {
    const manyFailed = Array.from({ length: 9 }, (_, index) => ({
      name: `Failed${index}`,
      display_name: index === 0 ? 'Readable Failed Mod' : null,
      version: `1.${index}`,
      folder_name: `Failed${index}`,
      mod_id: `Failed${index}`,
      reasons: ['load_failed' as const],
    }));
    const manyDependencyBlocked = Array.from({ length: 9 }, (_, index) => ({
      name: `Dependency${index}`,
      display_name: null,
      version: `2.${index}`,
      folder_name: `Dependency${index}`,
      mod_id: `Dependency${index}`,
      missing_dependencies: [`Missing${index}`],
    }));
    const manyIncompatible = Array.from({ length: 9 }, (_, index) => ({
      name: `Incompatible${index}`,
      display_name: null,
      version: `3.${index}`,
      folder_name: `Incompatible${index}`,
      mod_id: `Incompatible${index}`,
      min_game_version: `0.10${index}.0`,
    }));

    renderModal(baseReport({
      previous_failed_mods: manyFailed,
      dependency_blocked_mods: manyDependencyBlocked,
      known_incompatible_mods: manyIncompatible,
    }));

    expect(screen.getByRole('dialog', { name: /Review 9 mods that failed last launch/i })).toBeInTheDocument();
    expect(screen.getByText('Readable Failed Mod')).toBeInTheDocument();
    expect(screen.getByText(/missing Missing0/i)).toBeInTheDocument();
    expect(screen.getByText(/needs STS2 v0.100.0/i)).toBeInTheDocument();
    expect(screen.getAllByText('+1 more')).toHaveLength(3);
    expect(screen.getByRole('button', { name: /Store blocked mods and launch/i })).toBeInTheDocument();
  });

  it('uses dependency and incompatible titles when those are the leading blockers', () => {
    const { rerender } = render(
      <AllProviders>
        <LaunchHealthModal
          report={baseReport({
            dependency_blocked_mods: [{
              name: 'DependentMod',
              version: '1.0.0',
              missing_dependencies: ['BaseLib'],
            }],
          })}
          storing={false}
          onStoreAndLaunch={vi.fn()}
          onLaunchAnyway={vi.fn()}
          onReview={vi.fn()}
          onCancel={vi.fn()}
        />
      </AllProviders>,
    );

    expect(screen.getByRole('dialog', { name: /Review 1 mod with missing dependencies/i })).toBeInTheDocument();

    rerender(
      <AllProviders>
        <LaunchHealthModal
          report={baseReport({
            known_incompatible_mods: [{
              name: 'FutureMod',
              version: '2.0.0',
              min_game_version: '0.110.0',
            }],
          })}
          storing={false}
          onStoreAndLaunch={vi.fn()}
          onLaunchAnyway={vi.fn()}
          onReview={vi.fn()}
          onCancel={vi.fn()}
        />
      </AllProviders>,
    );

    expect(screen.getByRole('dialog', { name: /Review 1 mod that needs a newer STS2 build/i })).toBeInTheDocument();
  });

  it('treats omitted blocker lists as empty for older health reports', () => {
    renderModal({
      ...baseReport({
        profile_game_version_changed: true,
        active_profile_name: 'Daily Pack',
        profile_game_version: '0.104.0',
        current_game_version: '0.105.0',
      }),
      previous_failed_mods: undefined,
      dependency_blocked_mods: undefined,
      known_incompatible_mods: undefined,
    } as unknown as LaunchHealthReport);

    expect(screen.getByRole('dialog', { name: /STS2 changed since this pack last launched/i })).toBeInTheDocument();
    expect(screen.getByText(/Daily Pack was last used with a different STS2 build/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Store blocked mods and launch/i })).toBeNull();
  });

  it('disables modal exits and launch actions while storing blockers', async () => {
    const user = userEvent.setup();
    const { callbacks, container } = renderModal(
      baseReport({
        previous_failed_mods: [{
          name: 'BrokenMod',
          version: '1.0.0',
          reasons: ['load_failed'],
        }],
      }),
      { storing: true },
    );

    const dialog = screen.getByRole('dialog', { name: /Review 1 mod that failed last launch/i });
    for (const cancelButton of within(dialog).getAllByRole('button', { name: /^Cancel$/i })) {
      expect(cancelButton).toBeDisabled();
    }
    expect(within(dialog).getByRole('button', { name: /Review in Library/i })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /Launch anyway/i })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: /Storing/i })).toBeDisabled();

    await user.click(container.querySelector('.gf-modal-back') as HTMLElement);
    expect(callbacks.onCancel).not.toHaveBeenCalled();
  });
});
