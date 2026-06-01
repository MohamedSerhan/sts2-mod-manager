/**
 * useModLibrary — shared mod-management logic for the "All installed mods"
 * view and the per-modpack detail view.
 *
 * Both surfaces render the same rich LibraryTable rows + the same toolbar
 * (Open folder / Import / Quick add URL / Auto-detect / Audit / Refresh)
 * and the same inline source editor. This hook owns all of that behavior
 * (state + handlers) so the two views stay in lockstep instead of drifting
 * apart. Each view supplies its own layout and its own row filter; this
 * hook supplies the actions.
 *
 * `targetPack`: when set (the modpack detail view), a freshly-installed mod
 * (Quick add URL / Import) is added to that pack's membership right away —
 * and, if it's the active pack, flipped on in the game folder — so it shows
 * up in the pack immediately. When unset (All Mods), installs just land on
 * disk, matching the historical behavior.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { open } from '@tauri-apps/plugin-dialog';
import { X } from 'lucide-react';

import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmDialog';
import { Button } from '../components/Button';
import { Card } from '../components/Card';
import { SourceEditor } from '../components/SourceEditor';
import { AutoDetectModal } from '../components/AutoDetectModal';
import { nexusFilesUrl } from '../lib/nexusUrl';
import type { Bundle, ModAuditEntry, ModInfo } from '../types';
import {
  deleteMod,
  installModFromFile,
  quickAddMod,
  openModsFolder,
  openExternalUrl,
  setModSource,
  setModSourcesFull,
  setModExtras,
  setModDisplayOverrides,
  setModSnooze,
  setModTags,
  getSubscriptions,
  setProfileModMembership,
  toggleMod,
  findGithubFromNexus,
  pinMod,
  unpinMod,
  repairMod,
  rollbackMod,
  updateMod,
} from './useTauri';

function displayNameFor(mod: ModInfo): string {
  return mod.display_name?.trim() || mod.name;
}

function ghRepoFromUrl(url: string | null): string {
  if (!url) return '';
  const match = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/?#]+)/);
  if (match) return match[1].replace(/\.git$/, '');
  return url;
}

function cleanOptional(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseManagerTags(input: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.split(',')) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((tag, index) => tag === b[index]);
}

export interface UseModLibraryOptions {
  /** When set, installs (Quick add URL / Import) add the new mod to this
   *  pack's membership immediately. Unset = All Mods (install to disk only). */
  targetPack?: string | null;
  /** When set, the Audit action checks ONLY these mods (the modpack view
   *  audits just its pack). Unset = audit everything (All Mods view).
   *  A function so callers can read the latest pack contents at click time. */
  auditScope?: () => string[];
}

export function useModLibrary(opts: UseModLibraryOptions = {}) {
  const { targetPack, auditScope } = opts;
  const { t } = useTranslation();
  const {
    mods,
    bundles,
    refreshMods,
    refreshAll,
    gameRunning,
    gameInfo,
    notifyNexusOpen,
    auditResults,
    auditing,
    runAudit,
    updatingAll,
    updateAllGithub,
    activeProfile,
    refreshAuditEntries,
  } = useApp();
  const toast = useToast();

  const [showQuickAdd, setShowQuickAdd] = useState(false);
  const [showAutoDetect, setShowAutoDetect] = useState(false);
  const [quickAddUrl, setQuickAddUrl] = useState('');
  const [quickAdding, setQuickAdding] = useState(false);
  // Per-row source editor opens inside the row's slot. The view owns which
  // row's editor is open so the LibraryTable callbacks can drive it.
  const [sourceEditorRowKey, setSourceEditorRowKey] = useState<string | null>(null);
  const [savingSource, setSavingSource] = useState(false);
  const [findingGithub, setFindingGithub] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Per-row spinner state, keyed by `folder_name ?? name` so two same-named
  // mods don't share a spinner.
  const [updatingKey, setUpdatingKey] = useState<string | null>(null);
  const [repairingKey, setRepairingKey] = useState<string | null>(null);
  const [rollingBackKey, setRollingBackKey] = useState<string | null>(null);

  // Map ROW KEY → audit row, for O(1) per-row lookup in render.
  const auditByKey = useMemo(() => {
    const m = new Map<string, NonNullable<typeof auditResults>[number]>();
    if (auditResults) {
      for (const a of auditResults) {
        const key = a.folder_name ?? a.mod_name;
        m.set(key, a);
      }
    }
    return m;
  }, [auditResults]);

  // ModInfo lookup by row key — threaded through to the row kebab so the
  // menu can read github_url, tags, pinned, etc. without re-fetching.
  const modInfoByKey = useMemo(() => {
    const m = new Map<string, ModInfo>();
    for (const mod of mods) {
      const key = mod.folder_name ?? mod.name;
      m.set(key, mod);
    }
    return m;
  }, [mods]);

  /** Bundle lookup by bundle_id — O(1) access for LibraryTable grouping. */
  const bundlesById = useMemo(() => {
    const m = new Map<string, Bundle>();
    for (const b of bundles) {
      m.set(b.bundle_id, b);
    }
    return m;
  }, [bundles]);

  const confirm = useConfirm();

  /** Add a just-installed mod to the target pack (and enable it in-game if
   *  that pack is active). No-op when there's no target pack.
   *
   *  Re-adding a mod that's already installed + active is common (e.g.
   *  Quick-adding a mod already in the pack to update it). setProfileMod-
   *  Membership is idempotent, but toggleMod(enable=true) errors when the
   *  mod is already active (it looks for it in mods_disabled). So only
   *  flip it on when it's actually stored. */
  async function addToTargetPack(mod: ModInfo) {
    if (!targetPack) return;
    // Flip it ON in the live game folder FIRST when the target is the active
    // pack: toggle_mod guards on the game running (and can fail the move) while
    // the membership write doesn't — toggling first keeps disk + manifest in
    // sync instead of recording a membership the live folder never received.
    if (activeProfile === targetPack && !mod.enabled) {
      await toggleMod(mod.name, mod.folder_name ?? null, true);
    }
    await setProfileModMembership(
      targetPack,
      mod.name,
      mod.folder_name ?? null,
      mod.mod_id ?? null,
      true,
    );
  }

  // A followed (subscribed) pack isn't ours to edit, so installing a mod "into"
  // it would fail server-side and strand the file in the library. When the
  // modpack view targets a followed pack we stop BEFORE installing and explain,
  // instead of half-completing the add.
  async function targetPackIsFollowed(): Promise<boolean> {
    if (!targetPack) return false;
    try {
      const subs = await getSubscriptions();
      return subs.some((s) => s.profile_name.toLowerCase() === targetPack.toLowerCase());
    } catch {
      return false;
    }
  }

  async function handleInlineUpdate(mod: ModInfo) {
    const key = mod.folder_name ?? mod.name;
    if (updatingKey) return;
    setUpdatingKey(key);
    try {
      const info = await updateMod(mod.name, mod.folder_name);
      toast.success(t('mods.toast.updated', { name: mod.name, version: info.version }));
      await refreshAll();
      const names = info.name !== mod.name ? [mod.name, info.name] : [mod.name];
      await refreshAuditEntries(names);
    } catch (e) {
      const updateErrMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('mods.toast.updateFailed', { name: mod.name, error: updateErrMsg }));
    } finally {
      setUpdatingKey(null);
    }
  }

  async function handleTogglePin(mod: ModInfo) {
    try {
      if (mod.pinned) {
        await unpinMod(mod.name, mod.folder_name);
        toast.success(t('mods.toast.unpinned', { name: mod.name }));
      } else {
        await pinMod(mod.name, mod.folder_name);
        toast.success(t('mods.toast.pinned', { name: mod.name }));
      }
      await refreshMods();
    } catch (e) {
      const action = mod.pinned ? t('mods.toast.unpinAction') : t('mods.toast.pinAction');
      toast.error(t('mods.toast.pinFailed', { action, name: mod.name, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleRepair(mod: ModInfo) {
    /* v8 ignore start */
    if (!mod.github_url) {
      toast.error(t('mods.toast.repairNoGithub', { name: mod.name }));
      return;
    }
    /* v8 ignore stop */
    const ok = await confirm({
      title: t('mods.repairConfirmTitle', { name: mod.name }),
      body: t('mods.repairConfirmBody'),
      confirmLabel: t('mods.repairNow'),
    });
    if (!ok) return;
    const key = mod.folder_name ?? mod.name;
    setRepairingKey(key);
    try {
      const info = await repairMod(mod.name, mod.folder_name);
      toast.success(t('mods.toast.repaired', { name: info.name, version: info.version }));
      await refreshAll();
    } catch (e) {
      const repairErrMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('mods.toast.repairFailed', { name: mod.name, error: repairErrMsg }));
    } finally {
      setRepairingKey(null);
    }
  }

  async function handleRollback(mod: ModInfo) {
    /* v8 ignore start */
    if (!mod.github_url) {
      toast.error(t('mods.rollbackNoSource', { name: mod.name }));
      return;
    }
    /* v8 ignore stop */
    const ok = await confirm({
      title: t('mods.rollbackConfirmTitle', { name: mod.name }),
      body: t('mods.rollbackConfirmBody'),
      warning: t('mods.rollbackConfirmWarning'),
      confirmLabel: t('mods.rollbackNow'),
    });
    if (!ok) return;
    const key = mod.folder_name ?? mod.name;
    setRollingBackKey(key);
    try {
      const info = await rollbackMod(mod.name, mod.folder_name);
      toast.success(t('mods.toast.rolledBack', { name: info.name, version: info.version }));
      await refreshAll();
      const names = info.name !== mod.name ? [mod.name, info.name] : [mod.name];
      await refreshAuditEntries(names);
    } catch (e) {
      toast.error(t('mods.toast.rollbackFailed', { name: mod.name, error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRollingBackKey(null);
    }
  }

  async function handleDelete(mod: ModInfo) {
    const ok = await confirm({
      title: t('mods.deleteConfirmTitle', { name: mod.name }),
      body: t('mods.deleteConfirmBody'),
      confirmLabel: t('mods.delete'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteMod(mod.name, mod.folder_name);
      await refreshMods();
      toast.success(t('mods.toast.deleted', { name: mod.name }));
    } catch (e) {
      const delErrMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('mods.toast.deleteFailed', { name: mod.name, error: delErrMsg }));
    }
  }

  async function handleImportFile() {
    try {
      if (await targetPackIsFollowed()) {
        toast.info(t('mods.toast.followedPackNoAdd', { pack: targetPack }));
        return;
      }
      const selected = await open({
        multiple: false,
        filters: [{ name: t('mods.importArchiveFilter'), extensions: ['zip', '7z', 'rar'] }],
      });
      if (!selected) return;
      // `open({ multiple: false })` resolves to a single path or null; the
      // guard above already ruled out null, so this is just the string.
      const mod = await installModFromFile(selected);
      await addToTargetPack(mod);
      await refreshAll();
      toast.success(t('mods.toast.installed', { name: mod.name }));
    } catch (e) {
      const impErrMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('mods.toast.importFailed', { error: impErrMsg }));
    }
  }

  async function handleQuickAdd() {
    if (!quickAddUrl.trim()) return;
    if (await targetPackIsFollowed()) {
      toast.info(t('mods.toast.followedPackNoAdd', { pack: targetPack }));
      return;
    }
    const input = quickAddUrl.trim();
    try {
      setQuickAdding(true);
      const result = await quickAddMod(input);
      if (result.type === 'github_installed') {
        await addToTargetPack(result.mod_info);
        await refreshAll();
        toast.success(t('mods.toast.installed', { name: result.mod_info.name }));
      } else {
        const filesUrl = nexusFilesUrl(input);
        if (filesUrl) {
          await openExternalUrl(filesUrl);
          notifyNexusOpen(result.nexus_info.name || t('quickAdd.nexusMod'));
        } else {
          toast.info(t('mods.toast.foundNexusMod', { name: result.nexus_info.name || t('quickAdd.unknown') }));
        }
      }
      setQuickAddUrl('');
      setShowQuickAdd(false);
    } catch (e) {
      const qaErrMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('mods.toast.quickAddFailed', { error: qaErrMsg }));
    } finally {
      setQuickAdding(false);
    }
  }

  async function handleOpenFolder() {
    try {
      await openModsFolder();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function handleClearSource(modName: string, folderName: string | null) {
    try {
      await setModSource(modName, '', folderName);
      await refreshMods();
      toast.info(t('mods.toast.sourceCleared', { name: modName }));
    } catch (e) {
      toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleCopyVersion(mod: ModInfo) {
    try {
      await navigator.clipboard.writeText(mod.version);
      toast.success(t('mods.toast.versionCopied', { version: mod.version }));
    } catch {
      toast.error(t('mods.toast.couldNotCopy'));
    }
  }

  async function handleFindGithubFromNexus(mod: ModInfo) {
    const key = mod.folder_name ?? mod.name;
    try {
      setFindingGithub(key);
      const repo = await findGithubFromNexus(mod.name, mod.folder_name);
      if (repo) {
        await refreshMods();
        toast.success(t('mods.toast.foundGitHub', { repo }));
      } else {
        toast.info(t('mods.toast.noGitHubInNexus', { name: mod.name }));
      }
    } catch (e) {
      toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setFindingGithub(null);
    }
  }

  async function handleSnooze(mod: ModInfo, auditTag: string | null) {
    try {
      await setModSnooze(mod.name, auditTag, mod.folder_name);
      await refreshAuditEntries([mod.name]);
      toast.success(t('mods.toast.snoozed', { name: mod.name }));
    } catch (e) {
      toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  async function handleUnsnooze(mod: ModInfo) {
    try {
      await setModSnooze(mod.name, null, mod.folder_name);
      await refreshAuditEntries([mod.name]);
      toast.success(t('mods.toast.unsnoozed', { name: mod.name }));
    } catch (e) {
      toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
    }
  }

  function handleOpenExternalUrl(url: string, mod: ModInfo) {
    if (mod.nexus_url && url === mod.nexus_url) {
      notifyNexusOpen(mod.name);
    }
    openExternalUrl(url).catch(() => {});
  }

  async function handleRefresh() {
    setRefreshing(true);
    try {
      await refreshMods();
    } finally {
      setRefreshing(false);
    }
  }

  async function handleCheckUpdates() {
    // Scope to the pack's mods in the modpack view; full audit otherwise.
    await runAudit(auditScope ? auditScope() : undefined);
  }

  /** Inline Quick-add URL form, shown when `showQuickAdd` is on. Shared
   *  verbatim by both the All Mods view and the modpack view. */
  function renderQuickAddForm(): ReactNode {
    if (!showQuickAdd) return null;
    return (
      <Card className="flex gap-3 items-end">
        <div className="flex-1">
          <label className="text-sm text-text-muted block mb-1.5">
            {t('mods.quickAddLabel')}
          </label>
          <input
            type="text"
            value={quickAddUrl}
            onChange={(e) => setQuickAddUrl(e.target.value)}
            placeholder={t('mods.quickAddPlaceholder')}
            className="w-full bg-background border border-border rounded-lg px-4 py-2.5 text-sm text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50"
            onKeyDown={(e) => e.key === 'Enter' && handleQuickAdd()}
            disabled={quickAdding}
          />
        </div>
        <Button size="sm" onClick={handleQuickAdd} disabled={quickAdding}>
          {quickAdding ? t('mods.adding') : t('mods.add')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowQuickAdd(false)}
          aria-label={t('common.close')}
        >
          <X size={14} />
        </Button>
      </Card>
    );
  }

  /** Auto-detect-sources modal. Mounting is gated on `showAutoDetect`. */
  function renderAutoDetectModal(): ReactNode {
    return (
      <AutoDetectModal
        open={showAutoDetect}
        onClose={() => setShowAutoDetect(false)}
        onApplied={() => {
          refreshMods();
          // If an audit already ran, re-run it so the newly-linked rows
          // pick up their update status without a manual re-audit.
          if (auditResults) runAudit();
        }}
      />
    );
  }

  /** Toggle the inline source editor: clicking the open row closes it. */
  function onEditSources(mod: ModInfo) {
    const key = mod.folder_name ?? mod.name;
    setSourceEditorRowKey((cur) => (cur === key ? null : key));
  }

  function renderSourceEditor(mod: ModInfo): ReactNode {
    const rowKey = mod.folder_name ?? mod.name;
    if (sourceEditorRowKey !== rowKey) return undefined;
    return (
      <SourceEditor
        mod={mod}
        findingGithub={findingGithub === rowKey}
        onClose={() => setSourceEditorRowKey(null)}
        onClear={() => handleClearSource(mod.name, mod.folder_name)}
        onFindGithub={() => handleFindGithubFromNexus(mod)}
        onSave={async (gh, nx, note, customUrl, displayName, displayDescription, tagsInput) => {
          try {
            setSavingSource(true);
            const nextGithub = cleanOptional(gh);
            const nextNexus = cleanOptional(nx);
            if (
              nextGithub !== (cleanOptional(ghRepoFromUrl(mod.github_url)))
              || nextNexus !== (mod.nexus_url ?? null)
            ) {
              await setModSourcesFull(mod.name, nextGithub, nextNexus, mod.folder_name);
            }

            const nextNote = cleanOptional(note);
            const nextCustomUrl = cleanOptional(customUrl);
            if (
              nextNote !== (mod.note ?? null)
              || nextCustomUrl !== (mod.custom_url ?? null)
            ) {
              await setModExtras(mod.name, nextNote, nextCustomUrl, mod.folder_name);
            }

            const nextDisplayName = cleanOptional(displayName);
            const nextDisplayDescription = cleanOptional(displayDescription);
            if (
              nextDisplayName !== (mod.display_name ?? null)
              || nextDisplayDescription !== (mod.display_description ?? null)
            ) {
              await setModDisplayOverrides(
                mod.name,
                nextDisplayName,
                nextDisplayDescription,
                mod.folder_name,
              );
            }

            const nextTags = parseManagerTags(tagsInput);
            if (!sameTags(nextTags, mod.tags ?? [])) {
              await setModTags(mod.name, nextTags, mod.folder_name);
            }
            await refreshMods();
            toast.success(t('mods.toast.sourcesSaved', { name: displayNameFor(mod) }));
            setSourceEditorRowKey(null);
          } catch (e) {
            toast.error(t('mods.toast.allFailed', { error: e instanceof Error ? e.message : String(e) }));
          } finally {
            setSavingSource(false);
          }
        }}
        saving={savingSource}
      />
    );
  }

  /** Bundle of action props to spread straight into <LibraryTable>, so both
   *  views wire the rich-row surface identically. */
  const tableActionProps = {
    modInfoByKey,
    auditByKey,
    gameRunning,
    gameVersion: gameInfo?.game_version ?? null,
    updatingKey,
    repairingKey,
    rollingBackKey,
    anyUpdating: updatingKey !== null,
    anyRecoveryInFlight: repairingKey !== null || rollingBackKey !== null,
    onUpdate: handleInlineUpdate,
    onTogglePin: handleTogglePin,
    onSnooze: (mod: ModInfo, audit: ModAuditEntry | undefined) =>
      handleSnooze(mod, audit?.latest_release_with_assets_tag ?? null),
    onUnsnooze: handleUnsnooze,
    onRepair: handleRepair,
    onRollback: handleRollback,
    onDelete: handleDelete,
    onCopyVersion: handleCopyVersion,
    onOpenModsFolder: handleOpenFolder,
    onEditSources,
    onFindGithubFromNexus: handleFindGithubFromNexus,
    onOpenExternalUrl: handleOpenExternalUrl,
    renderSourceEditor,
  };

  return {
    // Raw context passthroughs the toolbar needs.
    mods,
    bundles,
    bundlesById,
    gameRunning,
    auditResults,
    auditing,
    updatingAll,
    updateAllGithub,
    // Toolbar state.
    showQuickAdd,
    setShowQuickAdd,
    showAutoDetect,
    setShowAutoDetect,
    quickAddUrl,
    setQuickAddUrl,
    quickAdding,
    refreshing,
    // Toolbar actions.
    handleOpenFolder,
    handleImportFile,
    handleQuickAdd,
    handleRefresh,
    handleCheckUpdates,
    // Toolbar render helpers (quick-add form + auto-detect modal).
    renderQuickAddForm,
    renderAutoDetectModal,
    // Per-row lookups (also exposed for views that need them directly).
    modInfoByKey,
    auditByKey,
    // Spread-in bundle for LibraryTable.
    tableActionProps,
  };

}

export type ModLibrary = ReturnType<typeof useModLibrary>;
