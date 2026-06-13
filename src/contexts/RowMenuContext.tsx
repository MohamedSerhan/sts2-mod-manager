// src/contexts/RowMenuContext.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_ROW_MENU_CONFIG,
  DEFAULT_ROW_MENU_ORDER,
  loadRowMenuConfig,
  normalizeConfig,
  saveRowMenuConfig,
  setShowCustomizeEntry as setShowCustomizeEntryPure,
  toggleHidden as toggleHiddenPure,
  type RowMenuConfig,
  type RowMenuItemId,
} from '../lib/rowMenuConfig';

interface RowMenuContextValue {
  config: RowMenuConfig;
  setOrder: (order: RowMenuItemId[]) => void;
  toggleHidden: (id: RowMenuItemId) => void;
  setShowCustomizeEntry: (show: boolean) => void;
  reset: () => void;
}

// Default value = safe fallback when a component renders outside the provider
// (e.g. an isolated unit test). Mutators are no-ops; config is the default.
const RowMenuContext = createContext<RowMenuContextValue>({
  config: DEFAULT_ROW_MENU_CONFIG,
  setOrder: () => {},
  toggleHidden: () => {},
  setShowCustomizeEntry: () => {},
  reset: () => {},
});

export function RowMenuProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<RowMenuConfig>(() => loadRowMenuConfig());

  useEffect(() => {
    saveRowMenuConfig(config);
  }, [config]);

  const setOrder = useCallback(
    (order: RowMenuItemId[]) => setConfig((c) => normalizeConfig({ ...c, order })),
    [],
  );
  const toggleHidden = useCallback(
    (id: RowMenuItemId) => setConfig((c) => toggleHiddenPure(c, id)),
    [],
  );
  const setShowCustomizeEntry = useCallback(
    (show: boolean) => setConfig((c) => setShowCustomizeEntryPure(c, show)),
    [],
  );
  const reset = useCallback(
    () => setConfig({ ...DEFAULT_ROW_MENU_CONFIG, order: [...DEFAULT_ROW_MENU_ORDER] }),
    [],
  );
  const value = useMemo(
    () => ({ config, setOrder, toggleHidden, setShowCustomizeEntry, reset }),
    [config, setOrder, toggleHidden, setShowCustomizeEntry, reset],
  );

  return <RowMenuContext.Provider value={value}>{children}</RowMenuContext.Provider>;
}

export function useRowMenu(): RowMenuContextValue {
  return useContext(RowMenuContext);
}
