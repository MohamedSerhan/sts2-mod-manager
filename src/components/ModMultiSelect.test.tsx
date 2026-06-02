/**
 * ModMultiSelect — the shared checkbox mod picker (create-modpack wizard
 * step 2 + Edit-modpack modal). These tests focus on the 1.7.0 windowing:
 * a large library renders only a bounded first page (with a "Show more"
 * footer) instead of painting every matching row, while bulk select-all
 * still operates over the full filtered set — not just the visible page.
 */
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ModMultiSelect, type ModMultiSelectLabels } from './ModMultiSelect';
import { AllProviders } from '../__test__/providers';
import type { ModInfo } from '../types';

const modInfo = (overrides: Partial<ModInfo> = {}): ModInfo =>
  ({
    name: 'Mod',
    version: '1.0.0',
    description: '',
    enabled: true,
    files: [],
    source: null,
    hash: null,
    dependencies: [],
    size_bytes: 0,
    folder_name: 'Mod',
    mod_id: 'Mod',
    github_url: null,
    nexus_url: null,
    pinned: false,
    ...overrides,
  } as ModInfo);

// Zero-padded names so the default name sort is stable and "Mod 0" cleanly
// matches "Mod 001".."Mod 099" (99 of 120) for the search/reset test.
function makeMods(n: number): ModInfo[] {
  return Array.from({ length: n }, (_, i) => {
    const id = String(i + 1).padStart(3, '0');
    return modInfo({ name: `Mod ${id}`, folder_name: `mod-${id}`, mod_id: `mod-${id}` });
  });
}

const labels: ModMultiSelectLabels = {
  searchPlaceholder: 'Search mods',
  sortLabel: 'Sort',
  sortByName: 'Name',
  sortBySize: 'Size',
  sortByActive: 'Active',
  selectedCount: (count: number) => `Selected ${count}`,
  selectAll: 'Select all',
  deselectAll: 'Deselect all',
  noMods: 'No mods',
};

/** Controlled wrapper so onChange round-trips selection back into the picker. */
function Harness({ mods }: { mods: ModInfo[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  return (
    <ModMultiSelect mods={mods} selected={selected} onChange={setSelected} labels={labels} />
  );
}

function renderPicker(mods: ModInfo[]) {
  return render(
    <AllProviders>
      <Harness mods={mods} />
    </AllProviders>,
  );
}

describe('<ModMultiSelect> windowing', () => {
  it('renders only the first page of a 100+ mod library and pages in the rest', async () => {
    const user = userEvent.setup();
    renderPicker(makeMods(120));

    // Bounded initial render — 50 of 120, not all 120.
    expect(screen.getAllByRole('checkbox')).toHaveLength(50);
    expect(screen.getByText('Showing 50 of 120')).toBeInTheDocument();

    // Reveal the next full page.
    await user.click(screen.getByRole('button', { name: /show 50 more/i }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(100);
    expect(screen.getByText('Showing 100 of 120')).toBeInTheDocument();

    // ...then the last partial page; once everything shows, the footer goes away.
    await user.click(screen.getByRole('button', { name: /show 20 more/i }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(120);
    expect(screen.queryByText(/showing/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show .* more/i })).not.toBeInTheDocument();
  });

  it('does not window a small library (no footer under one page)', () => {
    renderPicker(makeMods(8));
    expect(screen.getAllByRole('checkbox')).toHaveLength(8);
    expect(screen.queryByText(/showing/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /show .* more/i })).not.toBeInTheDocument();
  });

  it('Select all selects every filtered mod, not just the visible page', async () => {
    const user = userEvent.setup();
    renderPicker(makeMods(120));
    expect(screen.getByText('Selected 0')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Select all$/i }));

    // All 120 are selected even though only the first 50 rows are mounted.
    expect(screen.getByText('Selected 120')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(50);
  });

  it('changing the search resets paging back to the first page', async () => {
    const user = userEvent.setup();
    renderPicker(makeMods(120));

    // Expand to the second page first.
    await user.click(screen.getByRole('button', { name: /show 50 more/i }));
    expect(screen.getAllByRole('checkbox')).toHaveLength(100);

    // A search narrows to 99 matches AND snaps the page back to the first 50.
    await user.type(screen.getByRole('textbox', { name: /search mods/i }), 'Mod 0');
    expect(screen.getByText('Showing 50 of 99')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(50);
  });
});

describe('<ModMultiSelect> selected peek', () => {
  it('expands the selected-count toggle to list chosen mod names', async () => {
    const user = userEvent.setup();
    const mods = [
      modInfo({ name: 'Alpha', folder_name: 'alpha' }),
      modInfo({ name: 'Beta', folder_name: 'beta' }),
      modInfo({ name: 'Gamma', folder_name: 'gamma' }),
    ];

    function PeekHarness() {
      const [selected, setSelected] = useState<Set<string>>(new Set(['alpha', 'gamma']));
      return (
        <ModMultiSelect mods={mods} selected={selected} onChange={setSelected} labels={labels} />
      );
    }

    render(
      <AllProviders>
        <PeekHarness />
      </AllProviders>,
    );

    // Peek is closed by default — the panel doesn't exist yet.
    expect(screen.queryByTestId('mod-multiselect-selected-peek')).not.toBeInTheDocument();

    // Click the "Selected 2" toggle button to open the peek.
    await user.click(screen.getByRole('button', { name: /Selected 2/i }));

    const peek = screen.getByTestId('mod-multiselect-selected-peek');
    // Alpha and Gamma are selected — both should appear.
    expect(peek).toHaveTextContent('Alpha');
    expect(peek).toHaveTextContent('Gamma');
    // Beta is NOT selected — should not appear in the peek panel.
    expect(peek).not.toHaveTextContent('Beta');
  });

  it('shows the empty hint when nothing is selected', async () => {
    const user = userEvent.setup();
    renderPicker([modInfo({ name: 'Alpha', folder_name: 'alpha' })]);

    // Nothing is selected initially; click the "Selected 0" toggle.
    await user.click(screen.getByRole('button', { name: /Selected 0/i }));

    const peek = screen.getByTestId('mod-multiselect-selected-peek');
    expect(peek).toHaveTextContent(/no mods selected/i);
    expect(peek).not.toHaveTextContent('Alpha');
  });
});

describe('<ModMultiSelect> folder-name visibility', () => {
  // A mod whose on-disk folder differs from its display name — the case the
  // user hit ("Stats the Spire" lives in folder "stats_the_spire").
  const divergent = modInfo({
    name: 'Stats the Spire',
    folder_name: 'stats_the_spire',
    mod_id: 'sts2_community_stats',
  });
  // A mod whose folder == name: the folder line should be suppressed as noise.
  const aligned = modInfo({ name: 'BaseLib', folder_name: 'BaseLib', mod_id: 'BaseLib' });

  it('finds a mod by its on-disk folder name, not just the display name', async () => {
    const user = userEvent.setup();
    renderPicker([divergent, aligned]);
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);

    // Searching the folder string surfaces the mod whose DISPLAY name
    // ("Stats the Spire") doesn't contain it.
    await user.type(screen.getByRole('textbox', { name: /search mods/i }), 'stats_the_spire');
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(1);
    expect(screen.getByText('Stats the Spire')).toBeInTheDocument();
    expect(screen.queryByText('BaseLib')).not.toBeInTheDocument();
  });

  it('finds a mod by its mod_id too', async () => {
    const user = userEvent.setup();
    renderPicker([divergent, aligned]);
    await user.type(screen.getByRole('textbox', { name: /search mods/i }), 'community_stats');
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByText('Stats the Spire')).toBeInTheDocument();
  });

  it('shows the folder as a secondary label only when it differs from the name', () => {
    renderPicker([divergent, aligned]);
    // Divergent → folder shown.
    expect(screen.getByText('stats_the_spire')).toBeInTheDocument();
    // Aligned (folder == name) → the name appears once, no duplicate folder line.
    expect(screen.getAllByText('BaseLib')).toHaveLength(1);
  });
});
