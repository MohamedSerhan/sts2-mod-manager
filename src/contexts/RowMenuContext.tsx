// src/contexts/RowMenuContext.tsx
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  DEFAULT_ROW_MENU_CONFIG,
  loadRowMenuConfig,
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

  const value: RowMenuContextValue = {
    config,
    setOrder: (order) => setConfig((c) => ({ ...c, order })),
    toggleHidden: (id) => setConfig((c) => toggleHiddenPure(c, id)),
    reset: () => setConfig({ ...DEFAULT_ROW_MENU_CONFIG, order: [...DEFAULT_ROW_MENU_CONFIG.order] }),
  };

  return <RowMenuContext.Provider value={value}>{children}</RowMenuContext.Provider>;
}

export function useRowMenu(): RowMenuContextValue {
  return useContext(RowMenuContext);
}
