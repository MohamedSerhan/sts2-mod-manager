// src/contexts/RowMenuContext.tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  DEFAULT_ROW_MENU_CONFIG,
  DEFAULT_ROW_MENU_ORDER,
  loadRowMenuConfig,
  normalizeConfig,
  saveRowMenuConfig,
  toggleHidden as toggleHiddenPure,
  type RowMenuConfig,
  type RowMenuItemId,
} from '../lib/rowMenuConfig';

interface RowMenuContextValue {
  config: RowMenuConfig;
  setOrder: (order: RowMenuItemId[]) => void;
  toggleHidden: (id: RowMenuItemId) => void;
  reset: () => void;
}

// Default value = safe fallback when a component renders outside the provider
// (e.g. an isolated unit test). Mutators are no-ops; config is the default.
const RowMenuContext = createContext<RowMenuContextValue>({
  config: DEFAULT_ROW_MENU_CONFIG,
  setOrder: () => {},
  toggleHidden: () => {},
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
  const reset = useCallback(
    () => setConfig({ ...DEFAULT_ROW_MENU_CONFIG, order: [...DEFAULT_ROW_MENU_ORDER] }),
    [],
  );
  const value = useMemo(
    () => ({ config, setOrder, toggleHidden, reset }),
    [config, setOrder, toggleHidden, reset],
  );

  return <RowMenuContext.Provider value={value}>{children}</RowMenuContext.Provider>;
}

export function useRowMenu(): RowMenuContextValue {
  return useContext(RowMenuContext);
}
