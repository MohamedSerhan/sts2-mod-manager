import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { getGameInfo, getInstalledMods, isGameRunning, checkSubscriptionUpdates } from '../hooks/useTauri';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { GameInfo, ModInfo, SubscriptionUpdate } from '../types';
import { useToast } from './ToastContext';

interface AppContextType {
  gameInfo: GameInfo | null;
  mods: ModInfo[];
  loading: boolean;
  activeProfile: string | null;
  gameRunning: boolean;
  /** Per-pack updates available from upstream. Drives the badge on the
   *  Profiles sidebar item and the Home view's "update available" cards. */
  subUpdates: SubscriptionUpdate[];
  refreshGameInfo: () => Promise<void>;
  refreshMods: () => Promise<void>;
  refreshAll: () => Promise<void>;
  refreshGameRunning: () => Promise<void>;
  refreshSubUpdates: () => Promise<void>;
  setActiveProfile: (name: string | null) => void;
  /** Show a sticky toast telling the user "click Slow Download / Manual on
   *  Nexus" and keep it visible until the downloads-folder watcher reports
   *  the install (or a fail-safe timeout fires). The Nexus install path
   *  is always: open Files page → user clicks the free download button →
   *  zip lands in ~/Downloads → watcher emits `mod-auto-installed`. The
   *  toast was previously dismissing after 4s, well before any of those
   *  steps complete; this routes the dismissal to the actual completion
   *  signal instead. */
  notifyNexusOpen: (modName: string) => void;
}

/** Failsafe — if the watcher never fires (user closed the browser without
 *  downloading, Downloads folder isn't being watched, etc.), drop the
 *  sticky toast after this long so it doesn't loiter forever. */
const NEXUS_PENDING_TOAST_TIMEOUT_MS = 10 * 60 * 1000;

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [gameInfo, setGameInfo] = useState<GameInfo | null>(null);
  const [mods, setMods] = useState<ModInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeProfile, setActiveProfileState] = useState<string | null>(null);
  const [gameRunning, setGameRunning] = useState<boolean>(false);
  const [subUpdates, setSubUpdates] = useState<SubscriptionUpdate[]>([]);
  const gameRunningRef = useRef<boolean>(false);
  const toast = useToast();
  // Tracks the active "Nexus pending install" sticky toast so we can
  // dismiss it when the watcher reports an install (or when the user
  // opens a different Nexus mod, which supersedes the previous prompt).
  const nexusPendingRef = useRef<{ id: number; timeoutHandle: number } | null>(null);

  const dismissNexusPending = useCallback(() => {
    const pending = nexusPendingRef.current;
    if (!pending) return;
    nexusPendingRef.current = null;
    clearTimeout(pending.timeoutHandle);
    toast.dismiss(pending.id);
  }, [toast]);

  const notifyNexusOpen = useCallback((modName: string) => {
    // Supersede any earlier pending prompt — keep one sticky toast at a
    // time so the user isn't staring at a wall of "click Slow Download"
    // messages if they bounce between mods.
    dismissNexusPending();
    const id = toast.sticky(
      `Opened ${modName} on Nexus. Click "Slow Download" / "Manual" — the app will auto-install when the zip lands in your Downloads folder.`,
      'info',
    );
    const timeoutHandle = window.setTimeout(() => {
      // The toast has been up for too long without an install firing.
      // The user probably backed out; clean up so they don't see a
      // stale prompt.
      if (nexusPendingRef.current?.id === id) {
        nexusPendingRef.current = null;
        toast.dismiss(id);
      }
    }, NEXUS_PENDING_TOAST_TIMEOUT_MS);
    nexusPendingRef.current = { id, timeoutHandle };
  }, [toast, dismissNexusPending]);

  useEffect(() => {
    // The downloads watcher emits `mod-auto-installed` when ANY zip in
    // the watched Downloads folder gets caught + installed. Whether or
    // not that's the specific mod the user just opened on Nexus, the
    // sticky prompt has done its job — they took an action and a mod
    // landed. Dismiss.
    const unlisten = listen('mod-auto-installed', () => {
      dismissNexusPending();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [dismissNexusPending]);

  const refreshSubUpdates = useCallback(async () => {
    try {
      const updates = await checkSubscriptionUpdates();
      setSubUpdates(updates);
    } catch (e) {
      // Network hiccup — fail silently. The badge just won't update
      // until the next successful poll.
      console.debug('checkSubscriptionUpdates failed:', e);
    }
  }, []);

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

  // Poll for subscription updates so the Profiles sidebar item can show a
  // badge when followed packs have updates pending.
  //
  // 5 minutes (300s) is the cadence: with multiple subscriptions polled
  // unauthenticated, GitHub's 60-req/hour-per-IP limit was reachable at
  // the old 90s tick (1 sub: 40/hr; 2 subs: 80/hr — 429s every other hour).
  // The Rust side now passes the user's PAT when set, so authed users get
  // the 5000/hr ceiling — but the slower base cadence is also kinder to
  // unauthenticated users and to GitHub.
  useEffect(() => {
    refreshSubUpdates();
    const id = setInterval(refreshSubUpdates, 300_000);
    return () => clearInterval(id);
  }, [refreshSubUpdates]);

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
    <AppContext.Provider value={{ gameInfo, mods, loading, activeProfile, gameRunning, subUpdates, refreshGameInfo, refreshMods, refreshAll, refreshGameRunning, refreshSubUpdates, setActiveProfile, notifyNexusOpen }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextType {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
