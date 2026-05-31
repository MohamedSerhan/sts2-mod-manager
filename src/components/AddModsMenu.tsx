import { ChevronDown, FolderOpen, Link, Plus, Search, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { KebabMenu, KebabSection, KebabItem } from './KebabMenu';
import type { ModLibrary } from '../hooks/useModLibrary';

interface AddModsMenuProps {
  lib: ModLibrary;
  /** Button styling. Pass `gf-btn gf-btn-sm` for the prominent (yellow)
   *  primary look, or `gf-btn gf-btn-2-sm` for the muted secondary one. */
  buttonClassName?: string;
  /** Surface the "Auto-detect sources" item inside the menu. The Mod Library
   *  folds it in here; the modpack detail view keeps it in its Advanced
   *  kebab instead, so it passes this false (the default). */
  includeAutoDetect?: boolean;
}

/**
 * The single "+ Add mods ▾" dropdown shared by the Mod Library and the modpack
 * detail view — every way to add a mod gathered in one place: paste a URL,
 * import a file from disk, optionally auto-detect sources, or open the mods
 * folder. Behavior comes entirely from the `useModLibrary` hook the caller
 * passes in, so each surface adds mods into its own context.
 */
export function AddModsMenu({
  lib,
  buttonClassName = 'gf-btn gf-btn-2-sm',
  includeAutoDetect = false,
}: AddModsMenuProps) {
  const { t } = useTranslation();
  return (
    <KebabMenu
      align="right"
      title={t('modpack.detail.addMods')}
      buttonClassName={buttonClassName}
      trigger={
        <>
          <Plus size={14} /> {t('modpack.detail.addMods')} <ChevronDown size={13} />
        </>
      }
    >
      <KebabSection>
        <KebabItem icon={<Link size={12} />} onClick={() => lib.setShowQuickAdd(true)}>
          {t('mods.quickAddUrl')}
        </KebabItem>
        <KebabItem icon={<Upload size={12} />} onClick={lib.handleImportFile} disabled={lib.gameRunning}>
          {t('mods.importMod')}
        </KebabItem>
        {includeAutoDetect && (
          <KebabItem icon={<Search size={12} />} onClick={() => lib.setShowAutoDetect(true)}>
            {t('mods.autoDetectSources')}
          </KebabItem>
        )}
        <KebabItem icon={<FolderOpen size={12} />} onClick={lib.handleOpenFolder}>
          {t('mods.openFolder')}
        </KebabItem>
      </KebabSection>
    </KebabMenu>
  );
}
