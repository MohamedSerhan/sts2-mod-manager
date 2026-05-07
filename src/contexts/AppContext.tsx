import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { getGameInfo, getInstalledMods, isGameRunning } from '../hooks/useTauri';
import { invoke } from '@tauri-apps/api/core';
import type { GameInfo, ModInfo } from '../types';

interface AppContextType {
  gameInfo: GameInfo | null;
  mods: ModInfo[];
  loading: boolean;
  activeProfile: string | null;
  gameRunning: boolean;
  refreshGameInfo: () => Promise<void>;
  refreshMods: () => Promise<void>;
  refreshAll: () => Promise<void>;
  refreshGameRunning: () => Promise<void>;
  setActiveProfile: (name: string | null) => void;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [gameInfo, setGameInfo] = useState<GameInfo | null>(null);
  const [mods, setMods] = useState<ModInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeProfile, setActiveProfileState] = useState<string | null>(null);
  const [gameRunning, setGameRunning] = useState<boolean>(false);
  const gameRunningRef = useRef<boolean>(false);

  const refreshGameRunning = useCallback(async () => {
    try {
      const running = await isGameRunning();
      if (running !== gameRunningRef.current) {
        gameRunningRef.current = running;
        setGameRunning(running);
      }
    } catch (e) {
      // Detection failed — assume game is not running so user isn't blocked.
      console.debug('isGameRunning check failed:', e);
    }
  }, []);

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
    // Load active profile and vanilla mode state from backend
    try {
      const profile = await invoke<string | null>('get_active_profile');
      setActiveProfileState(profile);
    } catch { /* ignore */ }
    setLoading(false);
  }, [refreshGameInfo, refreshMods]);

  const setActiveProfile = useCallback((name: string | null) => {
    setActiveProfileState(name);
    invoke('set_active_profile', { name }).catch(() => {});
  }, []);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  // Poll for game running state. 3s feels responsive without burning CPU on
  // process enumeration; refresh installed mods after the game exits since
  // it may have left the mods folder in a different state.
  useEffect(() => {
    refreshGameRunning();
    const id = setInterval(() => {
      const wasRunning = gameRunningRef.current;
      refreshGameRunning().then(() => {
        if (wasRunning && !gameRunningRef.current) {
          refreshMods();
        }
      });
    }, 3000);
    return () => clearInterval(id);
  }, [refreshGameRunning, refreshMods]);

  return (
    <AppContext.Provider value={{ gameInfo, mods, loading, activeProfile, gameRunning, refreshGameInfo, refreshMods, refreshAll, refreshGameRunning, setActiveProfile }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextType {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
