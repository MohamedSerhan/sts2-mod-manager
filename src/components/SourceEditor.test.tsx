import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
  tags: [],
  display_name: null,
  display_description: null,
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
        onFindGithub={opts.onFindGithub ?? (async () => null)}
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
    const onFindGithub = vi.fn(async () => null);
    const user = userEvent.setup();
    renderEditor(baseMod({ nexus_url: 'https://www.nexusmods.com/sts2/mods/103' }), { onFindGithub });
    await user.click(screen.getByRole('button', { name: 'Find GitHub' }));
    expect(onFindGithub).toHaveBeenCalled();
  });

  // ── Bug 1: Find GitHub must reflect into the field, not just fire ──────
  // Previously onFindGithub returned void and the editor seeded `github`
  // from props only at mount, so a successful find left the field empty and
  // the Nexus-only banner up — and a subsequent Save then clobbered the
  // just-found repo with null. The Find handler now consumes the returned
  // repo and writes it into the field.
  it('a successful Find populates the GitHub field and drops the Nexus-only banner', async () => {
    const onFindGithub = vi.fn(async () => 'Alchyr/BaseLib');
    const user = userEvent.setup();
    renderEditor(baseMod({ nexus_url: 'https://www.nexusmods.com/sts2/mods/103' }), { onFindGithub });
    expect(screen.getByText(/Nexus-only mod/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Find GitHub' }));
    const input = screen.getByPlaceholderText('owner/repo') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('Alchyr/BaseLib'));
    // Banner + its Find button are gone once a GitHub source exists.
    expect(screen.queryByText(/Nexus-only mod/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Find GitHub' })).toBeNull();
  });

  it('a Find that returns a full GitHub URL is normalized to owner/repo in the field', async () => {
    const onFindGithub = vi.fn(async () => 'https://github.com/Alchyr/BaseLib');
    const user = userEvent.setup();
    renderEditor(baseMod({ nexus_url: 'https://www.nexusmods.com/sts2/mods/103' }), { onFindGithub });
    await user.click(screen.getByRole('button', { name: 'Find GitHub' }));
    const input = screen.getByPlaceholderText('owner/repo') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('Alchyr/BaseLib'));
  });

  it('a Find that returns null leaves the field empty and keeps the banner', async () => {
    const onFindGithub = vi.fn(async () => null);
    const user = userEvent.setup();
    renderEditor(baseMod({ nexus_url: 'https://www.nexusmods.com/sts2/mods/103' }), { onFindGithub });
    await user.click(screen.getByRole('button', { name: 'Find GitHub' }));
    await waitFor(() => expect(onFindGithub).toHaveBeenCalled());
    const input = screen.getByPlaceholderText('owner/repo') as HTMLInputElement;
    expect(input.value).toBe('');
    expect(screen.getByText(/Nexus-only mod/)).toBeInTheDocument();
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
      '',
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
      '',
      '',
      '',
    );
  });

  it('Display override fields round-trip through onSave', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderEditor(baseMod({ description: 'Manifest description' }), { onSave });
    await user.type(screen.getByPlaceholderText('BaseLib'), 'Friendly Base');
    await user.type(screen.getByPlaceholderText('Manifest description'), 'Readable description');
    await user.click(screen.getByRole('button', { name: /Save sources/ }));
    expect(onSave).toHaveBeenCalledWith(
      '',
      '',
      '',
      '',
      'Friendly Base',
      'Readable description',
      '',
    );
  });

  it('Tags field round-trips comma-separated categories through onSave', async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    renderEditor(baseMod({ tags: ['utility', 'beta'] }), { onSave });
    const tagsEl = screen.getByPlaceholderText(/utility, beta/i) as HTMLInputElement;
    expect(tagsEl.value).toBe('utility, beta');
    await user.clear(tagsEl);
    await user.type(tagsEl, 'QoL, beta, UI');
    await user.click(screen.getByRole('button', { name: /Save sources/ }));
    expect(onSave).toHaveBeenCalledWith(
      '',
      '',
      '',
      '',
      '',
      '',
      'QoL, beta, UI',
    );
  });

  it('initial display override values come from mod fields', () => {
    renderEditor(
      baseMod({
        display_name: 'Friendly Base',
        display_description: 'Readable description',
      }),
    );
    const nameEl = screen.getByPlaceholderText('BaseLib') as HTMLInputElement;
    expect(nameEl.value).toBe('Friendly Base');
    const descEl = screen.getByPlaceholderText('Shown in the Mods list') as HTMLTextAreaElement;
    expect(descEl.value).toBe('Readable description');
  });

  it('clear buttons next to display override fields reset those values', async () => {
    const user = userEvent.setup();
    renderEditor(
      baseMod({
        description: 'Manifest description',
        display_name: 'Friendly Base',
        display_description: 'Readable description',
      }),
    );
    const nameEl = screen.getByPlaceholderText('BaseLib') as HTMLInputElement;
    const nameField = nameEl.closest('.gf-src-edit-field') as HTMLElement;
    expect(nameField).not.toBeNull();
    await user.click(within(nameField).getByText('clear'));
    expect(nameEl.value).toBe('');

    const descEl = screen.getByPlaceholderText('Manifest description') as HTMLTextAreaElement;
    const descField = descEl.closest('.gf-src-edit-field') as HTMLElement;
    expect(descField).not.toBeNull();
    await user.click(within(descField).getByText('clear'));
    expect(descEl.value).toBe('');
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

  it('clear button next to Nexus clears the nexus input', async () => {
    const user = userEvent.setup();
    renderEditor(baseMod({ nexus_url: 'https://www.nexusmods.com/sts2/mods/77' }));
    const nexusInput = screen.getByPlaceholderText(/nexusmods\.com\/sts2\/mods\/123/) as HTMLInputElement;
    expect(nexusInput.value).toBe('https://www.nexusmods.com/sts2/mods/77');
    const nexusField = nexusInput.closest('.gf-src-edit-field') as HTMLElement;
    expect(nexusField).not.toBeNull();
    await user.click(within(nexusField).getByText('clear'));
    expect(nexusInput.value).toBe('');
  });

  it('clear button next to Note clears the textarea', async () => {
    const user = userEvent.setup();
    renderEditor(baseMod({ note: 'sticky note text' }));
    const noteEl = screen.getByPlaceholderText(/downloaded from Patreon/) as HTMLTextAreaElement;
    expect(noteEl.value).toBe('sticky note text');
    const noteField = noteEl.closest('.gf-src-edit-field') as HTMLElement;
    expect(noteField).not.toBeNull();
    await user.click(within(noteField).getByText('clear'));
    expect(noteEl.value).toBe('');
  });

  it('clear button next to Other-link clears the custom_url input', async () => {
    const user = userEvent.setup();
    renderEditor(baseMod({ custom_url: 'https://example.com/somewhere' }));
    const urlEl = screen.getByPlaceholderText(/Patreon, X, Discord/) as HTMLInputElement;
    expect(urlEl.value).toBe('https://example.com/somewhere');
    const urlField = urlEl.closest('.gf-src-edit-field') as HTMLElement;
    expect(urlField).not.toBeNull();
    await user.click(within(urlField).getByText('clear'));
    expect(urlEl.value).toBe('');
  });

  it('github_url that is not a github.com URL falls back to the raw string', () => {
    renderEditor(baseMod({ github_url: 'some-arbitrary-non-url-string' }));
    const input = screen.getByPlaceholderText('owner/repo') as HTMLInputElement;
    expect(input.value).toBe('some-arbitrary-non-url-string');
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
