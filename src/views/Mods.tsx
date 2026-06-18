import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  FolderOpen,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Search,
} from 'lucide-react';
import { Button } from '../components/Button';
import { LibraryTable, NO_TAGS_FILTER_VALUE } from '../components/LibraryTable';
import { ModLibraryToolbar } from '../components/ModLibraryToolbar';
import { useModLibrary } from '../hooks/useModLibrary';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmDialog';
import { HelpHint } from '../components/HelpHint';
import { Select } from '../components/Select';
import { BrowseView } from './Browse';
import {
  deleteAllMods,
  enableAllMods,
  disableAllMods,
} from '../hooks/useTauri';

interface ModsViewProps {
  /** 1.7.0 T17 — legacy advanced-mode toggle was removed when the
   *  per-row drawer absorbed source pills + Freeze/Delete disclosure.
   *  The prop is kept (unused) so older callers don't break, but it
   *  has no effect — Library is now uniformly "advanced". */
  advancedMode?: boolean;
  /** 1.7.0 T16 — handler for the "Manage active modpack →" bridge
   *  links. Routes the user to the Modpacks view with the active
   *  modpack's detail view auto-opened. */
  onManageActiveModpack?: () => void;
  /** Forwarded to BrowseView's "Nexus key missing → open Settings"
   *  banner. Only consumed when the Browse tab is active. */
  onGoToSettings?: () => void;
  /** 1.7.0 — initial outer-tab selection. 'browse' lands users on the
   *  Browse-mods tab (the absorbed top-level view); 'installed' is
   *  the default and shows installed mods. */
  initialTab?: 'installed' | 'browse';
}

export function ModsView({ onManageActiveModpack, onGoToSettings, initialTab = 'installed' }: ModsViewProps = {}) {
  // 1.7.0 outer Installed/Browse tabs.
  const [outerTab, setOuterTab] = useState<'installed' | 'browse'>(initialTab);
  useEffect(() => {
    setOuterTab(initialTab);
  }, [initialTab]);
  const { t } = useTranslation();
  // All per-row + install + toolbar behavior lives in the shared hook so
  // the All Mods view and the modpack view stay identical. No targetPack:
  // installs here just land on disk (the All Mods list isn't pack-scoped).
  const lib = useModLibrary();
  const { mods, gameRunning, tableActionProps } = lib;
  const { refreshMods, activeProfile } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [priorityTag, setPriorityTag] = useState('');
  // Bulk enable/disable changes mods' enabled state but not the installed
  // SET, so the focused membership grid (used when a modpack is active)
  // wouldn't re-fetch and the row toggles stayed stale. Bumping this nonce
  // after a bulk op forces LibraryTable to re-pull the grid. (refreshMods
  // alone only updates the header counts, which read from appMods.)
  const [bulkReloadNonce, setBulkReloadNonce] = useState(0);

  // ── Bulk actions (All-Mods-only; operate on the whole install) ──────
  async function handleEnableAll() {
    try {
      await enableAllMods();
      await refreshMods();
      setBulkReloadNonce((n) => n + 1);
      toast.success(t('mods.toast.allEnabled'));
    } catch (e) {
      toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleDisableAll() {
    try {
      await disableAllMods();
      await refreshMods();
      setBulkReloadNonce((n) => n + 1);
      toast.success(t('mods.toast.allDisabled'));
    } catch (e) {
      toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleDeleteAll() {
    const ok = await confirm({
      title: t('mods.deleteAllConfirmTitle', { count: mods.length }),
      body: t('mods.deleteAllConfirmBody'),
      warning: t('mods.deleteAllConfirmWarning'),
      confirmLabel: t('mods.deleteEverything'),
      destructive: true,
      typedPhrase: 'delete all',
    });
    if (!ok) return;
    try {
      const deleted = await deleteAllMods();
      await refreshMods();
      toast.success(t('mods.toast.deletedMultiple', { count: deleted }));
    } catch (e) {
      toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  // Tags present across the install, for the page-level Tag picker. Choosing
  // one feeds LibraryTable's `priorityTag`: it reorders (selected tag first,
  // then the rest A–Z by tag, untagged last) rather than hiding anything.
  const tagOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const mod of mods) {
      for (const tag of mod.tags ?? []) {
        const trimmed = tag.trim();
        if (!trimmed) continue;
        const key = trimmed.toLocaleLowerCase();
        if (!seen.has(key)) seen.set(key, trimmed);
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, {
      sensitivity: 'base',
      numeric: true,
    }));
  }, [mods]);

  const totalCount = mods.length;
  const enabledCount = mods.filter((m) => m.enabled).length;
  const disabledCount = mods.filter((m) => !m.enabled).length;

  return (
    <div className="gf-body">
      {/* 1.7.0 — outer Installed/Browse tab strip. Kept at the very top of
          the page so it reads as the primary view switcher (it swaps the
          whole page between the installed library and the mod browser),
          consistent across the Mod Library and Modpacks pages. */}
      <div className="gf-tabs" style={{ marginBottom: 14 }}>
        <button
          className={`gf-tab ${outerTab === 'installed' ? 'active' : ''}`}
          onClick={() => setOuterTab('installed')}
        >
          {t('library.tabs.installed')}
        </button>
        <button
          className={`gf-tab ${outerTab === 'browse' ? 'active' : ''}`}
          onClick={() => setOuterTab('browse')}
        >
          {t('library.tabs.browse')}
        </button>
      </div>

      {/* Header — only on the Installed tab. The Browse tab's
          BrowseView component renders its own page-head, so we'd
          stack two headers if this stayed unconditional. */}
      {outerTab === 'installed' && (
      <div className="gf-page-head">
        <div>
          {/* 1.7.0 — heading reframed from "Your mods" to "All installed
              mods" so users don't read it as "the active modpack's mods". */}
          <h1 className="gf-page-title">{t('mods.allInstalledTitle')}</h1>
          <p className="gf-page-sub">
            {t('mods.subtitle', { total: totalCount, enabled: enabledCount, disabled: disabledCount > 0 ? t('mods.subtitleDisabledSuffix', { count: disabledCount }) : '' })}
          </p>
          <p className="gf-page-sub">
            {t('mods.allInstalledSubtitle')}
            <HelpHint helpKey="storedMeaning" />
          </p>
          {onManageActiveModpack && (
            <button
              type="button"
              className="gf-link-button"
              onClick={onManageActiveModpack}
            >
              {t('mods.manageActiveModpackLink')}
            </button>
          )}
        </div>
        <ModLibraryToolbar lib={lib} />
      </div>
      )}

      {outerTab === 'browse' && <BrowseView onGoToSettings={onGoToSettings} />}

      {outerTab === 'installed' && (
        <>
      {/* Quick Add URL form (shared) — shown when the toolbar Quick-Add
          button is toggled on. */}
      {lib.renderQuickAddForm()}

      {/* Tag priority picker + bulk actions strip. LibraryTable owns the
          per-table search + sort below; this row carries page-level
          affordances (tag priority, enable/disable/delete-all). */}
      {(tagOptions.length > 0 || mods.length > 0) && (
        <div className="gf-toolbar">
          {mods.length > 0 && (
            <label className="gf-sort-control">
              <span>{t('mods.tags.label')}</span>
              <Select
                aria-label={t('mods.tags.label')}
                value={priorityTag}
                onChange={setPriorityTag}
                options={[
                  { value: '', label: t('mods.tags.all') },
                  { value: NO_TAGS_FILTER_VALUE, label: t('mods.tags.noTags') },
                  ...tagOptions.map((tag) => ({ value: tag, label: tag })),
                ]}
              />
            </label>
          )}
          {mods.length > 0 && (
            <div className="flex gap-1.5">
              <Button variant="ghost" size="sm" onClick={lib.handleOpenFolder} title={t('mods.openModsFolder')}>
                <FolderOpen size={14} />
                {t('mods.openModsFolder')}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleEnableAll} disabled={gameRunning} title={gameRunning ? t('mods.closeSts2First') : t('mods.enableAll')}>
                <ToggleRight size={14} />
                {t('mods.enableAll')}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleDisableAll} disabled={gameRunning} title={gameRunning ? t('mods.closeSts2First') : t('mods.disableAll')}>
                <ToggleLeft size={14} />
                {t('mods.disableAll')}
              </Button>
              <Button variant="danger" size="sm" onClick={handleDeleteAll} disabled={gameRunning} title={gameRunning ? t('mods.closeSts2First') : t('mods.deleteAll')}>
                <Trash2 size={14} />
                {t('mods.deleteAll')}
              </Button>
              {/* Yellow-outline shortcut to the same auto-detect flow offered in
                  the "+ Add mods" menu — placed at the end of the bulk-action row.
                  Not gated on gameRunning: it only searches GitHub, never touches
                  the mods folder. */}
              <Button variant="ghost" size="sm" className="gf-btn-accent" onClick={() => lib.setShowAutoDetect(true)} title={t('mods.autoDetectSources')}>
                <Search size={14} />
                {t('mods.autoDetectSources')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Library table — same row component the ModpackDetail view
          uses. Pass `modpackName={activeProfile}` so when there's an
          active modpack, the per-row checkbox column appears for
          quick add-to / remove-from membership editing; when no
          modpack is active, the table runs in no-focus mode (no
          checkboxes, no drag). */}
      <LibraryTable
        modpackName={activeProfile}
        priorityTag={priorityTag}
        reloadToken={`bulk:${bulkReloadNonce}|versions:${lib.versionOptionsReloadToken}`}
        {...tableActionProps}
      />
        </>
      )}

      {/* Auto-detect sources modal (shared). */}
      {lib.renderAutoDetectModal()}
    </div>
  );
}
