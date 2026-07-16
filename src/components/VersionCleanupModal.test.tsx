import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmProvider } from './ConfirmDialog';
import { VersionCleanupModal } from './VersionCleanupModal';
import { chooseOption } from '../__test__/selectHelpers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import type { LibraryVersionCleanupPreview, LocalModVersionOption } from '../types';

function option(
  id: string,
  version: string,
  overrides: Partial<LocalModVersionOption> = {},
): LocalModVersionOption {
  return {
    mod_version_id: id,
    name: 'RitsuLib',
    version,
    folder_name: `RitsuLib-${version}`,
    mod_id: 'RitsuLib',
    installed: false,
    installed_enabled: false,
    cached: true,
    pinned: false,
    used_by_profiles: [],
    ...overrides,
  };
}

function preview(): LibraryVersionCleanupPreview {
  const old = option('ritsu-454', '0.4.54');
  const active = option('ritsu-456', '0.4.56', {
    installed: true,
    installed_enabled: true,
    used_by_profiles: ['Stable'],
  });
  const newest = option('ritsu-457', '0.4.57');
  const steam = option('ritsu-steam', '0.4.57', {
    install_source: 'steam_workshop',
    workshop_item_id: '123',
    installed: true,
  });
  return {
    recommended_count: 1,
    protected_count: 2,
    families: [{
      family_key: 'mod_id:ritsulib',
      display_name: '[BASE] RitsuLib',
      candidates: [
        {
          option: newest,
          provider: 'github',
          recommended: false,
          protected: false,
          reasons: ['newest_copy'],
          replacement_candidates: [],
        },
        {
          option: active,
          provider: 'github',
          recommended: false,
          protected: true,
          reasons: ['active', 'profile_used'],
          replacement_candidates: [newest, old, steam],
        },
        {
          option: old,
          provider: 'github',
          recommended: true,
          protected: false,
          reasons: ['recommended_old'],
          replacement_candidates: [],
        },
        {
          option: steam,
          provider: 'steam',
          recommended: false,
          protected: true,
          reasons: ['steam_managed'],
          replacement_candidates: [],
        },
      ],
    }],
  };
}

function pagedPreview(count = 25): LibraryVersionCleanupPreview {
  return {
    recommended_count: 0,
    protected_count: count,
    families: Array.from({ length: count }, (_, index) => {
      const number = index + 1;
      return {
        family_key: `family-${number}`,
        display_name: `Family ${number}`,
        candidates: [{
          option: option(`family-${number}-version`, `1.0.${number}`),
          provider: index === count - 1 ? 'nexus' : 'local',
          recommended: false,
          protected: true,
          reasons: ['profile_used'],
          replacement_candidates: [],
        }],
      };
    }),
  };
}

function renderModal(onComplete = vi.fn()) {
  render(
    <ConfirmProvider>
      <VersionCleanupModal open onClose={vi.fn()} onComplete={onComplete} />
    </ConfirmProvider>,
  );
  return onComplete;
}

describe('<VersionCleanupModal>', () => {
  it('preselects only recommended old versions and executes exact ids', async () => {
    registerInvokeHandler('preview_library_version_cleanup', preview);
    registerInvokeHandler('execute_library_version_cleanup', () => [{
      mod_version_id: 'ritsu-454',
      success: true,
      switched_active: false,
      remapped_profiles: 0,
      deleted_disk: false,
      deleted_cache: true,
      removed_record: true,
    }]);
    const onComplete = renderModal();
    const user = userEvent.setup();

    expect(await screen.findByText('[BASE] RitsuLib')).toBeInTheDocument();
    expect(screen.getByText(/keeps its saved GitHub or Nexus source link/i)).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Edit protected versions/i })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /RitsuLib v0\.4\.54/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /RitsuLib v0\.4\.56/i })).toBeDisabled();
    const newestCheckboxes = screen.getAllByRole('checkbox', { name: /RitsuLib v0\.4\.57/i });
    const githubNewest = newestCheckboxes.find((checkbox) =>
      checkbox.closest('.gf-version-cleanup-candidate')?.textContent?.includes('GitHub'));
    const steamNewest = newestCheckboxes.find((checkbox) =>
      checkbox.closest('.gf-version-cleanup-candidate')?.textContent?.includes('Steam'));
    expect(githubNewest).not.toBeDisabled();
    expect(githubNewest).not.toBeChecked();
    expect(steamNewest).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Remove selected/i }));
    await user.click(await screen.findByRole('button', { name: /Remove versions/i }));

    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual({
        cmd: 'execute_library_version_cleanup',
        args: { items: [{ mod_version_id: 'ritsu-454', replacement_mod_version_id: null }] },
      });
    });
    expect(onComplete).toHaveBeenCalled();
  });

  it('keeps the cleanup result visible when removing the last reviewable family', async () => {
    let previewCalls = 0;
    registerInvokeHandler('preview_library_version_cleanup', () => {
      previewCalls += 1;
      return previewCalls === 1 ? preview() : {
        recommended_count: 0,
        protected_count: 0,
        families: [],
      };
    });
    registerInvokeHandler('execute_library_version_cleanup', () => [{
      mod_version_id: 'ritsu-454',
      success: true,
      switched_active: false,
      remapped_profiles: 0,
      deleted_disk: false,
      deleted_cache: true,
      removed_record: true,
    }]);
    renderModal();
    const user = userEvent.setup();

    await screen.findByText('[BASE] RitsuLib');
    await user.click(screen.getByRole('button', { name: /Remove selected/i }));
    await user.click(await screen.findByRole('button', { name: /Remove versions/i }));

    expect(await screen.findByText(/Removed: 1.*Failed: 0/i)).toBeInTheDocument();
    expect(screen.getByText(/No mod currently has multiple versions to review/i)).toBeInTheDocument();
  });

  it('requires an explicit retained replacement for protected versions', async () => {
    registerInvokeHandler('preview_library_version_cleanup', preview);
    registerInvokeHandler('execute_library_version_cleanup', () => [{
      mod_version_id: 'ritsu-456',
      success: true,
      switched_active: true,
      remapped_profiles: 1,
      deleted_disk: true,
      deleted_cache: true,
      removed_record: true,
    }]);
    renderModal();
    const user = userEvent.setup();

    await screen.findByText('[BASE] RitsuLib');
    await user.click(screen.getByRole('checkbox', { name: /Edit protected versions/i }));
    await user.click(screen.getByRole('checkbox', { name: /RitsuLib v0\.4\.54/i }));
    await user.click(screen.getByRole('checkbox', { name: /RitsuLib v0\.4\.56/i }));
    expect(screen.getByRole('button', { name: /Remove selected/i })).toBeDisabled();

    await chooseOption(
      user,
      /Replacement for \[BASE\] RitsuLib v0\.4\.56/i,
      /v0\.4\.57.*Saved in Versions/i,
    );
    await user.click(screen.getByRole('button', { name: /Remove selected/i }));
    await user.click(await screen.findByRole('button', { name: /Remove versions/i }));

    await waitFor(() => {
      expect(getInvokeCalls()).toContainEqual({
        cmd: 'execute_library_version_cleanup',
        args: { items: [{
          mod_version_id: 'ritsu-456',
          replacement_mod_version_id: 'ritsu-457',
        }] },
      });
    });
  });

  it('prevents a retained replacement from also being selected for removal', async () => {
    registerInvokeHandler('preview_library_version_cleanup', preview);
    renderModal();
    const user = userEvent.setup();

    await screen.findByText('[BASE] RitsuLib');
    await user.click(screen.getByRole('checkbox', { name: /Edit protected versions/i }));
    await user.click(screen.getByRole('checkbox', { name: /RitsuLib v0\.4\.54/i }));
    await user.click(screen.getByRole('checkbox', { name: /RitsuLib v0\.4\.56/i }));
    await chooseOption(
      user,
      /Replacement for \[BASE\] RitsuLib v0\.4\.56/i,
      /v0\.4\.57.*Saved in Versions/i,
    );

    const githubNewest = screen.getAllByRole('checkbox', { name: /RitsuLib v0\.4\.57/i })
      .find((checkbox) => checkbox.closest('.gf-version-cleanup-candidate')?.textContent?.includes('GitHub'));
    expect(githubNewest).toBeDisabled();
    expect(githubNewest).not.toBeChecked();
    expect(githubNewest).toHaveAttribute('title', 'Retained replacement');
    expect(screen.getByText('Retained replacement')).toBeInTheDocument();

    await user.click(githubNewest as HTMLElement);
    expect(githubNewest).not.toBeChecked();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Remove selected/i })).toBeEnabled();
  });

  it('stages every removable family copy against one retained version', async () => {
    registerInvokeHandler('preview_library_version_cleanup', preview);
    renderModal();
    const user = userEvent.setup();

    await screen.findByText('[BASE] RitsuLib');
    await chooseOption(
      user,
      /Version to keep for \[BASE\] RitsuLib/i,
      /v0\.4\.57.*Steam Workshop.*Stored on disk/i,
    );
    await user.click(screen.getByRole('button', { name: /Keep only this version/i }));

    expect(screen.getByRole('checkbox', { name: /Edit protected versions/i })).toBeChecked();
    const steam = screen.getAllByRole('checkbox', { name: /RitsuLib v0\.4\.57/i })
      .find((checkbox) => checkbox.closest('.gf-version-cleanup-candidate')?.textContent?.includes('Steam'));
    const github = screen.getAllByRole('checkbox', { name: /RitsuLib v0\.4\.57/i })
      .find((checkbox) => checkbox.closest('.gf-version-cleanup-candidate')?.textContent?.includes('GitHub'));
    expect(steam).not.toBeChecked();
    expect(github).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /RitsuLib v0\.4\.56/i })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /RitsuLib v0\.4\.54/i })).toBeChecked();
    expect(screen.getByRole('button', { name: /Remove selected/i })).toBeEnabled();
  });

  it('never enables Steam-managed versions for local removal', async () => {
    registerInvokeHandler('preview_library_version_cleanup', preview);
    renderModal();
    const user = userEvent.setup();

    await screen.findByText('[BASE] RitsuLib');
    await user.click(screen.getByRole('checkbox', { name: /Edit protected versions/i }));
    const steam = screen.getAllByRole('checkbox', { name: /RitsuLib v0\.4\.57/i })
      .find((checkbox) => checkbox.closest('.gf-version-cleanup-candidate')?.textContent?.includes('Steam'));
    expect(steam).toBeDisabled();
  });

  it('explains protected versions and marks each protected row with a lock badge', async () => {
    registerInvokeHandler('preview_library_version_cleanup', preview);
    renderModal();

    await screen.findByText('[BASE] RitsuLib');
    const help = screen.getByRole('img', { name: /About protected versions/i });
    expect(help).toHaveAttribute('title', expect.stringContaining('always shown and marked'));
    expect(screen.getByRole('checkbox', { name: /Edit protected versions/i })).not.toBeChecked();

    const active = screen.getByRole('checkbox', { name: /RitsuLib v0\.4\.56/i });
    const activeBadge = within(active.closest('.gf-version-cleanup-candidate') as HTMLElement)
      .getByText('Protected');
    expect(activeBadge).toHaveAttribute('title', expect.stringContaining('Used by a modpack'));
    const steam = screen.getAllByRole('checkbox', { name: /RitsuLib v0\.4\.57/i })
      .find((checkbox) => checkbox.closest('.gf-version-cleanup-candidate')?.textContent?.includes('Steam'));
    const steamBadge = within(steam?.closest('.gf-version-cleanup-candidate') as HTMLElement)
      .getByText('Protected');
    expect(steamBadge).toHaveAttribute('title', expect.stringContaining('Managed by Steam'));
    expect(screen.getAllByText('Protected')).toHaveLength(2);
  });

  it('retries a failed preview and renders the empty state', async () => {
    let attempts = 0;
    registerInvokeHandler('preview_library_version_cleanup', () => {
      attempts += 1;
      if (attempts === 1) throw new Error('preview unavailable');
      return { families: [], recommended_count: 0, protected_count: 0 };
    });
    renderModal();
    const user = userEvent.setup();

    expect(await screen.findByRole('alert')).toHaveTextContent('preview unavailable');
    await user.click(screen.getByRole('button', { name: /Retry/i }));

    expect(await screen.findByText(/No old versions to clean up/i)).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('keeps large previews bounded and filters by version and provider', async () => {
    registerInvokeHandler('preview_library_version_cleanup', () => pagedPreview());
    renderModal();
    const user = userEvent.setup();

    expect(await screen.findByText('Family 20')).toBeInTheDocument();
    expect(screen.getByText('Family 20').closest('details')).toHaveAttribute('open');
    expect(screen.queryByText('Family 25')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Show more.*5/i }));
    expect(screen.getByText('Family 25')).toBeInTheDocument();

    const search = screen.getByRole('textbox', { name: /Search mods or versions/i });
    await user.type(search, '1.0.25');
    expect(screen.getByText('Family 25')).toBeInTheDocument();
    expect(screen.queryByText('Family 20')).not.toBeInTheDocument();
    await user.clear(search);
    await user.type(search, 'nexus');
    expect(screen.getByText('Family 25')).toBeInTheDocument();
    expect(screen.queryByText('Family 24')).not.toBeInTheDocument();
  });

  it('cancels confirmation without executing and closes only from outside the dialog', async () => {
    registerInvokeHandler('preview_library_version_cleanup', preview);
    const onClose = vi.fn();
    render(
      <ConfirmProvider>
        <VersionCleanupModal open onClose={onClose} onComplete={vi.fn()} />
      </ConfirmProvider>,
    );
    const user = userEvent.setup();

    await screen.findByText('[BASE] RitsuLib');
    const cleanupDialog = screen.getByRole('dialog', { name: /Clean up stored versions/i });
    await user.click(cleanupDialog);
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /Remove selected/i }));
    const confirmDialog = await screen.findByRole('dialog', { name: /Remove the selected versions/i });
    await user.click(within(confirmDialog).getAllByRole('button', { name: /^Cancel$/i })[1]);
    expect(getInvokeCalls().some((call) => call.cmd === 'execute_library_version_cleanup')).toBe(false);

    await user.click(cleanupDialog.parentElement as HTMLElement);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('shows item failures without refreshing the library and clears advanced selections', async () => {
    registerInvokeHandler('preview_library_version_cleanup', preview);
    registerInvokeHandler('execute_library_version_cleanup', () => [{
      mod_version_id: 'ritsu-454',
      success: false,
      error: 'file is locked',
      switched_active: false,
      remapped_profiles: 0,
      deleted_disk: false,
      deleted_cache: false,
      removed_record: false,
    }]);
    const onComplete = renderModal();
    const user = userEvent.setup();

    await screen.findByText('[BASE] RitsuLib');
    const advanced = screen.getByRole('checkbox', { name: /Edit protected versions/i });
    await user.click(advanced);
    const active = screen.getByRole('checkbox', { name: /RitsuLib v0\.4\.56/i });
    await user.click(active);
    expect(active).toBeChecked();
    await user.click(advanced);
    expect(active).not.toBeChecked();
    expect(active).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /Remove selected/i }));
    await user.click(await screen.findByRole('button', { name: /Remove versions/i }));
    expect(await screen.findByText('file is locked')).toBeInTheDocument();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('surfaces an execution error and lets the header close button dismiss the modal', async () => {
    registerInvokeHandler('preview_library_version_cleanup', preview);
    registerInvokeHandler('execute_library_version_cleanup', () => {
      throw 'cleanup unavailable';
    });
    const onClose = vi.fn();
    render(
      <ConfirmProvider>
        <VersionCleanupModal open onClose={onClose} onComplete={vi.fn()} />
      </ConfirmProvider>,
    );
    const user = userEvent.setup();

    await screen.findByText('[BASE] RitsuLib');
    await user.click(screen.getByRole('button', { name: /Remove selected/i }));
    await user.click(await screen.findByRole('button', { name: /Remove versions/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cleanup unavailable');

    await user.click(screen.getAllByRole('button', { name: /^Close$/i })[0]);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
