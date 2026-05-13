import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SourceEditor } from './SourceEditor';
import type { ModInfo } from '../types';

const baseMod = (overrides: Partial<ModInfo> = {}): ModInfo => ({
  name: 'BaseLib',
  version: '3.1.2',
  description: '',
  enabled: true,
  files: [],
  source: null,
  hash: null,
  dependencies: [],
  size_bytes: 0,
  folder_name: 'BaseLib',
  mod_id: 'baselib',
  github_url: null,
  nexus_url: null,
  pinned: false,
  min_game_version: null,
  author: null,
  ...overrides,
});

describe('<SourceEditor>', () => {
  function renderEditor(mod: ModInfo, opts: Partial<React.ComponentProps<typeof SourceEditor>> = {}) {
    return render(
      <SourceEditor
        mod={mod}
        saving={false}
        findingGithub={false}
        onClose={opts.onClose ?? (() => {})}
        onClear={opts.onClear ?? (() => {})}
        onFindGithub={opts.onFindGithub ?? (() => {})}
        onSave={opts.onSave ?? (() => {})}
        {...opts}
      />,
    );
  }

  it('renders the editor title with the mod name', () => {
    renderEditor(baseMod());
    expect(screen.getByText('Sources for BaseLib')).toBeInTheDocument();
  });

  it('initial GitHub value is parsed from a full URL down to owner/repo', () => {
    renderEditor(baseMod({ github_url: 'https://github.com/Alchyr/BaseLib' }));
    const input = screen.getByPlaceholderText('owner/repo') as HTMLInputElement;
    expect(input.value).toBe('Alchyr/BaseLib');
  });

  it('initial Nexus URL stays verbatim', () => {
    renderEditor(baseMod({ nexus_url: 'https://www.nexusmods.com/sts2/mods/103' }));
    const input = screen.getByPlaceholderText(/nexusmods\.com\/sts2\/mods\/123/) as HTMLInputElement;
    expect(input.value).toBe('https://www.nexusmods.com/sts2/mods/103');
  });

  it('"empty" badge shows when a field is blank, "OK" when filled', async () => {
    const user = userEvent.setup();
    renderEditor(baseMod());
    // Three fields carry status badges: GitHub, Nexus, Other-link.
    // (Note has hint text only — it's free-form, no "filled vs empty" UX.)
    expect(screen.getAllByText('empty')).toHaveLength(3);
    await user.type(screen.getByPlaceholderText('owner/repo'), 'foo/bar');
    expect(screen.getByText(/OK/)).toBeInTheDocument();
    expect(screen.getAllByText('empty')).toHaveLength(2);
  });

  it('clear button next to GitHub clears the field', async () => {
    const user = userEvent.setup();
    renderEditor(baseMod({ github_url: 'https://github.com/Alchyr/BaseLib' }));
    await user.click(screen.getAllByText('clear')[0]);
    const input = screen.getByPlaceholderText('owner/repo') as HTMLInputElement;
    expect(input.value).toBe('');
  });

  it('shows the "Find GitHub" hint when only Nexus is filled', async () => {
    renderEditor(baseMod({ nexus_url: 'https://www.nexusmods.com/sts2/mods/103' }));
    expect(screen.getByText(/Nexus-only mod/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Find GitHub' })).toBeInTheDocument();
  });

  it('Find GitHub button calls onFindGithub', async () => {
    const onFindGithub = vi.fn();
    const user = userEvent.setup();
    renderEditor(baseMod({ nexus_url: 'https://www.nexusmods.com/sts2/mods/103' }), { onFindGithub });
    await user.click(screen.getByRole('button', { name: 'Find GitHub' }));
    expect(onFindGithub).toHaveBeenCalled();
  });

  it('"Find GitHub" is disabled and labelled "Searching…" while findingGithub=true', () => {
    renderEditor(
      baseMod({ nexus_url: 'https://www.nexusmods.com/sts2/mods/103' }),
      { findingGithub: true },
    );
    expect(screen.getByRole('button', { name: 'Searching…' })).toBeDisabled();
  });

  it('Save button passes both field values to onSave', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderEditor(baseMod(), { onSave });
    await user.type(screen.getByPlaceholderText('owner/repo'), 'foo/bar');
    await user.type(
      screen.getByPlaceholderText(/nexusmods\.com\/sts2\/mods\/123/),
      'https://www.nexusmods.com/sts2/mods/99',
    );
    await user.click(screen.getByRole('button', { name: /Save sources/ }));
    expect(onSave).toHaveBeenCalledWith(
      'foo/bar',
      'https://www.nexusmods.com/sts2/mods/99',
      '',
      '',
    );
  });

  it('Note and Other-link fields round-trip through onSave', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderEditor(baseMod(), { onSave });
    await user.type(
      screen.getByPlaceholderText(/downloaded from Patreon/),
      'got this from a friend',
    );
    await user.type(
      screen.getByPlaceholderText(/Patreon, X, Discord/),
      'https://example.com/post/1',
    );
    await user.click(screen.getByRole('button', { name: /Save sources/ }));
    expect(onSave).toHaveBeenCalledWith(
      '',
      '',
      'got this from a friend',
      'https://example.com/post/1',
    );
  });

  it('initial Note + custom_url come from mod fields', () => {
    renderEditor(
      baseMod({
        note: 'compat patch for v1.8 build',
        custom_url: 'https://example.com/post/1',
      }),
    );
    const noteEl = screen.getByPlaceholderText(/downloaded from Patreon/) as HTMLTextAreaElement;
    expect(noteEl.value).toBe('compat patch for v1.8 build');
    const urlEl = screen.getByPlaceholderText(/Patreon, X, Discord/) as HTMLInputElement;
    expect(urlEl.value).toBe('https://example.com/post/1');
  });

  it('Save shows "Saving…" + disables when saving=true', () => {
    renderEditor(baseMod(), { saving: true });
    expect(screen.getByRole('button', { name: /Saving…/ })).toBeDisabled();
  });

  it('Cancel + X close call onClose', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderEditor(baseMod(), { onClose });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    onClose.mockClear();
    await user.click(screen.getByTitle('Close editor'));
    expect(onClose).toHaveBeenCalled();
  });

  it('"Clear all links" only renders when at least one source exists', () => {
    const { rerender } = render(
      <SourceEditor
        mod={baseMod()}
        saving={false}
        findingGithub={false}
        onClose={() => {}}
        onClear={() => {}}
        onFindGithub={() => {}}
        onSave={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: /Clear all/i })).toBeNull();
    rerender(
      <SourceEditor
        mod={baseMod({ github_url: 'https://github.com/x/y' })}
        saving={false}
        findingGithub={false}
        onClose={() => {}}
        onClear={() => {}}
        onFindGithub={() => {}}
        onSave={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /Clear all/i })).toBeInTheDocument();
  });
});
