import { ChevronDown, Link, Plus, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { KebabMenu, KebabSection, KebabItem } from './KebabMenu';
import type { ModLibrary } from '../hooks/useModLibrary';

interface AddModsMenuProps {
  lib: ModLibrary;
  /** Button styling. Pass `gf-btn gf-btn-sm` for the prominent (yellow)
   *  primary look, or `gf-btn gf-btn-2-sm` for the muted secondary one. */
  buttonClassName?: string;
}

/**
 * The single "+ Add mods ▾" dropdown shared by the Mod Library and the modpack
 * detail view — paste a URL or import a file from disk. Behavior comes
 * entirely from the `useModLibrary` hook the caller passes in, so each surface
 * adds mods into its own context.
 */
export function AddModsMenu({
  lib,
  buttonClassName = 'gf-btn gf-btn-2-sm',
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
      </KebabSection>
    </KebabMenu>
  );
}
