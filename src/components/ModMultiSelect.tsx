/**
 * ModMultiSelect — the checkbox mod picker shared by the create-modpack
 * wizard (step 2) and the "Edit modpack" modal. Owns its own search + sort
 * state and renders a filterable, sortable checkbox list with a
 * Select-all / Deselect-all toggle (operating on the visible/filtered set).
 *
 * Selection is controlled: the parent holds the `Set<string>` of selected
 * mod names and updates it via `onChange`. Labels are injected so the
 * component stays caller-agnostic (the wizard and the edit modal pass their
 * own i18n strings).
 */
import { useMemo, useState } from 'react';

import type { ModInfo } from '../types';

export type ModMultiSelectSort = 'name' | 'size' | 'enabled';

export interface ModMultiSelectLabels {
  searchPlaceholder: string;
  sortLabel: string;
  sortByName: string;
  sortBySize: string;
  sortByActive: string;
  selectedCount: (count: number) => string;
  selectAll: string;
  deselectAll: string;
  noMods: string;
}

export interface ModMultiSelectProps {
  /** Full installed-mod list to choose from. */
  mods: ModInfo[];
  /** Controlled selection (mod names). */
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  labels: ModMultiSelectLabels;
}

export function ModMultiSelect({ mods, selected, onChange, labels }: ModMultiSelectProps) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ModMultiSelectSort>('name');

  // Visible list — search filter (case-insensitive, by name) then sort.
  const visibleMods = useMemo(() => {
    const lower = search.trim().toLowerCase();
    const list = lower
      ? mods.filter((m) => m.name.toLowerCase().includes(lower))
      : [...mods];
    if (sort === 'name') {
      list.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sort === 'size') {
      list.sort((a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0));
    } else if (sort === 'enabled') {
      list.sort((a, b) => Number(b.enabled) - Number(a.enabled));
    }
    return list;
  }, [mods, search, sort]);

  function toggle(modName: string) {
    const next = new Set(selected);
    if (next.has(modName)) next.delete(modName);
    else next.add(modName);
    onChange(next);
  }

  // Bulk select/deselect over the currently-visible (filtered) rows.
  const allVisibleSelected =
    visibleMods.length > 0 && visibleMods.every((m) => selected.has(m.name));
  function toggleSelectAllVisible() {
    const next = new Set(selected);
    const names = visibleMods.map((m) => m.name);
    const everyChecked = names.length > 0 && names.every((n) => next.has(n));
    if (everyChecked) names.forEach((n) => next.delete(n));
    else names.forEach((n) => next.add(n));
    onChange(next);
  }

  return (
    <div className="gf-create-wizard-choose">
      <div className="gf-create-wizard-choose-controls">
        <input
          type="text"
          className="gf-set-input"
          placeholder={labels.searchPlaceholder}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={labels.searchPlaceholder}
        />
        <label className="gf-create-wizard-sort">
          <span className="gf-field-label">{labels.sortLabel}</span>
          <select
            className="gf-set-input"
            value={sort}
            onChange={(e) => setSort(e.target.value as ModMultiSelectSort)}
          >
            <option value="name">{labels.sortByName}</option>
            <option value="size">{labels.sortBySize}</option>
            <option value="enabled">{labels.sortByActive}</option>
          </select>
        </label>
      </div>
      <div className="gf-create-wizard-choose-actions">
        <span className="gf-create-wizard-selected-count" aria-live="polite">
          {labels.selectedCount(selected.size)}
        </span>
        {mods.length > 0 && (
          <button
            type="button"
            className="gf-link-button"
            onClick={toggleSelectAllVisible}
          >
            {allVisibleSelected ? labels.deselectAll : labels.selectAll}
          </button>
        )}
      </div>
      <div className="gf-create-wizard-list">
        {mods.length === 0 && (
          <div className="gf-create-wizard-empty">{labels.noMods}</div>
        )}
        {visibleMods.map((mod) => {
          const key = mod.folder_name ?? mod.name;
          const checked = selected.has(mod.name);
          return (
            <label key={key} className="gf-create-wizard-list-row">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(mod.name)}
                aria-label={mod.name}
              />
              <span className="gf-create-wizard-list-name">{mod.name}</span>
              <span className="gf-create-wizard-list-meta">v{mod.version}</span>
            </label>
          );
        })}
      </div>
    </div>
  );
}
