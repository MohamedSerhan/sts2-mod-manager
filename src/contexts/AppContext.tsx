import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { getGameInfo, getInstalledMods } from '../hooks/useTauri';
import type { GameInfo, ModInfo } from '../types';

interface AppContextType {
  gameInfo: GameInfo | null;
  mods: ModInfo[];
  loading: boolean;
  refreshGameInfo: () => Promise<void>;
  refreshMods: () => Promise<void>;
  refreshAll: () => Promise<void>;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [gameInfo, setGameInfo] = useState<GameInfo | null>(null);
  const [mods, setMods] = useState<ModInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshGameInfo = useCallback(async () => {
    try {
      const info = await getGameInfo();
      setGameInfo(info);
    } catch (e) {
      console.error('Failed to get game info:', e);
    }
  }, []);

  const refreshMods = useCallback(async () => {
    try {
      const installed = await getInstalledMods();
      setMods(installed);
    } catch (e) {
      console.error('Failed to get mods:', e);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([refreshGameInfo(), refreshMods()]);
    setLoading(false);
  }, [refreshGameInfo, refreshMods]);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  return (
    <AppContext.Provider value={{ gameInfo, mods, loading, refreshGameInfo, refreshMods, refreshAll }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextType {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
