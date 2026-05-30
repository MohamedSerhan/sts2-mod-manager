import { AlignJustify, LayoutList } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '../lib/utils';

export type ModListDensity = 'comfortable' | 'compact';

const DENSITY_KEY = 'sts2mm-mod-density';

function readDensity(): ModListDensity {
  try {
    return localStorage.getItem(DENSITY_KEY) === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

/**
 * Persisted comfortable/compact density for the mod lists (Mod Library +
 * modpack view). Remembered across sessions in localStorage so the preference
 * follows the user between the two surfaces.
 */
export function useModListDensity(): [ModListDensity, (d: ModListDensity) => void] {
  const [density, setDensityState] = useState<ModListDensity>(readDensity);
  const setDensity = useCallback((d: ModListDensity) => {
    setDensityState(d);
    try {
      localStorage.setItem(DENSITY_KEY, d);
    } catch {
      /* private mode / storage blocked — keep the in-memory choice */
    }
  }, []);
  return [density, setDensity];
}

interface ModViewToggleProps {
  density: ModListDensity;
  onChange: (d: ModListDensity) => void;
}

/**
 * Two-button segmented control that switches the mod list between the roomy
 * "comfortable" rows (description + full meta) and a denser "compact" list
 * (more rows on screen). Purely presentational — the caller owns the density.
 */
export function ModViewToggle({ density, onChange }: ModViewToggleProps) {
  const { t } = useTranslation();
  return (
    <div className="gf-view-toggle" role="group" aria-label={t('libraryTable.viewLabel')}>
      <button
        type="button"
        className={cn('gf-view-toggle-btn', density === 'comfortable' && 'is-active')}
        onClick={() => onChange('comfortable')}
        title={t('libraryTable.viewComfortable')}
        aria-label={t('libraryTable.viewComfortable')}
        aria-pressed={density === 'comfortable'}
      >
        <LayoutList size={14} />
      </button>
      <button
        type="button"
        className={cn('gf-view-toggle-btn', density === 'compact' && 'is-active')}
        onClick={() => onChange('compact')}
        title={t('libraryTable.viewCompact')}
        aria-label={t('libraryTable.viewCompact')}
        aria-pressed={density === 'compact'}
      >
        <AlignJustify size={14} />
      </button>
    </div>
  );
}
