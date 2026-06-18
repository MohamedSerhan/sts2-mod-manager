/**
 * ModMultiSelect — the checkbox mod picker shared by the create-modpack
 * wizard (step 2) and the "Edit modpack" modal. Owns its own search + sort
 * state and renders a filterable, sortable checkbox list with a
 * Select-all / Deselect-all toggle (operating on the visible/filtered set).
 *
 * Selection is controlled: the parent holds the `Set<string>` of selected
 * mod KEYS (`folder_name ?? name`) and updates it via `onChange`. Keying by
 * folder — not display name — is what lets two installed mods that share a
 * manifest name be selected (and pruned) independently. Labels are injected
 * so the component stays caller-agnostic (the wizard and the edit modal pass
 * their own i18n strings).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { ModInfo } from '../types';
import { Select } from './Select';

// Cap the initial render so a 100+ mod library doesn't paint hundreds of
// checkbox rows at once; a "Show more" footer pages in the rest on demand.
const PAGE_SIZE = 50;

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
  /** Controlled selection, keyed by `folder_name ?? name`. */
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
  labels: ModMultiSelectLabels;
}

export function ModMultiSelect({ mods, selected, onChange, labels }: ModMultiSelectProps) {
  const { t } = useTranslation();
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<ModMultiSelectSort>('name');
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [peekOpen, setPeekOpen] = useState(false);

  // Filtered list — search filter then sort. Search matches the display
  // name AND the on-disk folder name / mod id / display override, so a mod
  // whose folder differs from its manifest name (e.g. folder "stats_the_spire"
  // shown as "Stats the Spire", or a Nexus "...-979-2-1-..." folder) is still
  // findable by whatever the user remembers it as. This is the FULL match
  // set; the render is paged below via `shownMods`.
  const filteredMods = useMemo(() => {
    const lower = search.trim().toLowerCase();
    const matches = (m: ModInfo) =>
      m.name.toLowerCase().includes(lower) ||
      (m.folder_name?.toLowerCase().includes(lower) ?? false) ||
      (m.mod_id?.toLowerCase().includes(lower) ?? false) ||
      (m.display_name?.toLowerCase().includes(lower) ?? false);
    const list = lower ? mods.filter(matches) : [...mods];
    if (sort === 'name') {
      list.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sort === 'size') {
      list.sort((a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0));
    } else if (sort === 'enabled') {
      list.sort((a, b) => Number(b.enabled) - Number(a.enabled));
    }
    return list;
  }, [mods, search, sort]);

  // All selected mods' display names — independent of search/sort/paging so the
  // peek shows every selected mod, not just the visible page. Keyed by
  // folder_name (stable unique id) so two mods with the same display_name
  // both appear without React silently dropping the duplicate key.
  const selectedNames = useMemo(
    () =>
      mods
        .filter((m) => selected.has(m.folder_name ?? m.name))
        .map((m) => ({ key: m.folder_name ?? m.name, label: m.display_name?.trim() || m.name }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [mods, selected],
  );

  // Reset paging whenever the match set changes out from under us, so the
  // footer never reads "Showing 50 of 200" against a freshly-filtered list.
  useEffect(() => {
    setVisibleLimit(PAGE_SIZE);
  }, [search, sort]);

  // Only the first `visibleLimit` matches are actually rendered.
  const shownMods = filteredMods.slice(0, visibleLimit);

  function toggle(modKey: string) {
    const next = new Set(selected);
    if (next.has(modKey)) next.delete(modKey);
    else next.add(modKey);
    onChange(next);
  }

  // Bulk select/deselect over the full filtered set (every search match,
  // not just the rows currently paged into view).
  const allFilteredSelected =
    filteredMods.length > 0 && filteredMods.every((m) => selected.has(m.folder_name ?? m.name));
  function toggleSelectAllFiltered() {
    const next = new Set(selected);
    const keys = filteredMods.map((m) => m.folder_name ?? m.name);
    const everyChecked = keys.length > 0 && keys.every((k) => next.has(k));
    if (everyChecked) keys.forEach((k) => next.delete(k));
    else keys.forEach((k) => next.add(k));
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
          <Select
            aria-label={labels.sortLabel}
            value={sort}
            onChange={(v) => setSort(v as ModMultiSelectSort)}
            options={[
              { value: 'name', label: labels.sortByName },
              { value: 'size', label: labels.sortBySize },
              { value: 'enabled', label: labels.sortByActive },
            ]}
          />
        </label>
      </div>
      <div className="gf-create-wizard-choose-actions">
        <button
          type="button"
          className="gf-create-wizard-selected-count gf-create-wizard-selected-toggle"
          aria-expanded={peekOpen}
          aria-controls="gf-create-wizard-selected-peek"
          onClick={() => setPeekOpen((o) => !o)}
        >
          <span aria-live="polite">{labels.selectedCount(selected.size)}</span>
          <span className="gf-create-wizard-health-hint">
            {peekOpen ? t('createModpack.step2HideSelected') : t('createModpack.step2ShowSelected')}
          </span>
        </button>
        {mods.length > 0 && (
          <button
            type="button"
            className="gf-link-button"
            onClick={toggleSelectAllFiltered}
          >
            {allFilteredSelected ? labels.deselectAll : labels.selectAll}
          </button>
        )}
      </div>
      {peekOpen && (
        <div
          id="gf-create-wizard-selected-peek"
          data-testid="mod-multiselect-selected-peek"
          className="gf-create-wizard-selected-peek"
        >
          {selectedNames.length === 0 ? (
            <span className="gf-create-wizard-empty">{t('createModpack.step2NoneSelected')}</span>
          ) : (
            <ul>
              {selectedNames.map(({ key, label }) => (
                <li key={key}>{label}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="gf-create-wizard-list">
        {mods.length === 0 && (
          <div className="gf-create-wizard-empty">{labels.noMods}</div>
        )}
        {shownMods.map((mod) => {
          const key = mod.folder_name ?? mod.name;
          const checked = selected.has(key);
          // Surface the on-disk folder when it differs from the shown name,
          // so two same-named mods are distinguishable and a mod with an
          // unusual folder (Nexus "Name-979-2-1-…") can be matched to disk.
          const shownName = mod.display_name ?? mod.name;
          const folder = mod.folder_name;
          const showFolder = !!folder && folder !== shownName;
          return (
            <label key={key} className="gf-create-wizard-list-row">
              <input
                type="checkbox"
                checked={checked}
                onChange={() => toggle(key)}
                aria-label={shownName}
              />
              <span className="gf-create-wizard-list-name">
                {shownName}
                {showFolder && (
                  <span className="gf-create-wizard-list-folder" title={folder ?? undefined}>
                    {folder}
                  </span>
                )}
              </span>
              <span className="gf-create-wizard-list-meta">v{mod.version}</span>
            </label>
          );
        })}
      </div>
      {filteredMods.length > shownMods.length && (
        <div className="gf-create-wizard-choose-actions">
          <span className="gf-create-wizard-selected-count" aria-live="polite">
            {t('profiles.library.showing', {
              shown: shownMods.length,
              total: filteredMods.length,
            })}
          </span>
          <button
            type="button"
            className="gf-link-button"
            onClick={() => setVisibleLimit((limit) => limit + PAGE_SIZE)}
          >
            {t('profiles.library.showMore', {
              count: Math.min(PAGE_SIZE, filteredMods.length - shownMods.length),
            })}
          </button>
        </div>
      )}
    </div>
  );
}
