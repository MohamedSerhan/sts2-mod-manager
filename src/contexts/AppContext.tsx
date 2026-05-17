import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getGameInfo, getInstalledMods, isGameRunning, checkSubscriptionUpdates, auditModVersions, updateAllMods } from '../hooks/useTauri';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { GameInfo, ModInfo, ModAuditEntry, SubscriptionUpdate } from '../types';
import { useToast } from './ToastContext';
import { useConfirm } from '../components/ConfirmDialog';

interface AppContextType {
  gameInfo: GameInfo | null;
  mods: ModInfo[];
  loading: boolean;
  activeProfile: string | null;
  gameRunning: boolean;
  /** Per-pack updates available from upstream. Drives the badge on the
   *  Profiles sidebar item and the Home view's "update available" cards. */
  subUpdates: SubscriptionUpdate[];
  /** Latest mod-audit result. null = hasn't been run this session. Lifted
   *  here from Settings so the Mods view can show per-row "update available"
   *  pills without forcing the user to dig into Settings to discover them. */
  auditResults: ModAuditEntry[] | null;
  auditing: boolean;
  runAudit: () => Promise<void>;
  refreshAuditEntries: (names: string[]) => Promise<void>;
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
  /** True while updateAllGithub is in flight. Drives the toolbar's
   *  "Updating N…" disabled state in both Mods and Settings views. */
  updatingAll: boolean;
  /** Run a bulk update across every GitHub-sourced row in `names`. Shows
   *  a confirm, toasts a summary, then re-audits just the touched rows.
   *  Safe to call with a single name. */
  updateAllGithub: (githubUpdateNames: string[]) => Promise<void>;
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
  const [auditResults, setAuditResults] = useState<ModAuditEntry[] | null>(null);
  const [auditing, setAuditing] = useState<boolean>(false);
  const [updatingAll, setUpdatingAll] = useState<boolean>(false);
  const gameRunningRef = useRef<boolean>(false);
  const toast = useToast();
  const confirm = useConfirm();
  const { t } = useTranslation();
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
      t('app.nexusPendingToast', { modName }),
      'info',
    );
    const timeoutHandle = window.setTimeout(() => {
      // The toast has been up for too long without an install firing.
      // The user probably backed out; clean up so they don't see a
      // stale prompt.
      // uncovered (else branch): `dismissNexusPending()` always
      // `clearTimeout`s this handle before it can fire (both the
      // mod-auto-installed listener and a subsequent `notifyNexusOpen`
      // route through dismissNexusPending). The only path that reaches
      // this callback is one where nexusPendingRef.current still
      // points at the entry we just stored, so the id check is true.
      // The check is defensive against a hypothetical race that
      // single-threaded JS cannot produce here.
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
      // The Rust command returns ONE record per subscription regardless
      // of whether there's a pending update — the `has_update` flag is
      // what distinguishes them. Without this filter we'd light up the
      // Profiles "1 pack has updates · curator pushed an update" banner
      // immediately after every install (because the freshly-installed
      // pack comes back with has_update=false but still gets counted by
      // subUpdates.length on the consumer side). ProfileSwitcher does
      // the same filter; lifting it here keeps every consumer of the
      // context honest without each having to remember.
      setSubUpdates(updates.filter((u) => u.has_update));
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

  /** Run a full mod audit (GitHub + Nexus version checks for every linked
   *  mod). Result is cached in context so Settings and Mods can share it
   *  without refetching. Errors surface as a toast and leave the prior
   *  results in place. */
  const runAudit = useCallback(async () => {
    try {
      setAuditing(true);
      const results = await auditModVersions();
      setAuditResults(results);
    } catch (e) {
      toast.error(t('app.auditFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setAuditing(false);
    }
  }, [toast]);

  /** Re-audit a targeted subset of mods and splice the fresh entries back
   *  into `auditResults`. Used after single-mod / bulk updates so rows
   *  flip from "X → Y" to "(latest)" without rescanning every mod. New
   *  entries (e.g. a mod that just landed via the Downloads watcher) get
   *  appended. */
  const refreshAuditEntries = useCallback(async (names: string[]) => {
    if (names.length === 0) return;
    try {
      const fresh = await auditModVersions(names);
      const byName = new Map(fresh.map((e) => [e.mod_name, e]));
      setAuditResults((prev) => {
        if (!prev) return prev;
        const existingNames = new Set(prev.map((e) => e.mod_name));
        const merged = prev.map((e) => byName.get(e.mod_name) ?? e);
        for (const e of fresh) {
          if (!existingNames.has(e.mod_name)) merged.push(e);
        }
        return merged;
      });
    } catch {
      /* non-fatal — leaves existing rows in place */
    }
  }, []);

  const updateAllGithub = useCallback(async (githubUpdateNames: string[]) => {
    if (updatingAll || githubUpdateNames.length === 0) return;
    const ok = await confirm({
      title: t('app.updateConfirmTitle', { count: githubUpdateNames.length }),
      body: t('app.updateConfirmBody'),
      confirmLabel: t('app.updateConfirmLabel', { count: githubUpdateNames.length }),
    });
    if (!ok) return;
    setUpdatingAll(true);
    try {
      const updated = await updateAllMods();
      toast.success(
        updated.length === 0
          ? t('app.nothingToUpdate')
          : t('app.updated', { count: updated.length }),
      );
      await refreshAll();
      const names = Array.from(
        new Set([...githubUpdateNames, ...updated.map((m) => m.name)]),
      );
      await refreshAuditEntries(names);
    } catch (e) {
      toast.error(t('app.updateFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setUpdatingAll(false);
    }
  }, [updatingAll, confirm, toast, refreshAll, refreshAuditEntries]);

  // Auto-refresh audit rows when the downloads watcher catches a new mod
  // — only if an audit is currently loaded (don't surprise the user by
  // populating a fresh audit they didn't ask for).
  useEffect(() => {
    const unlisten = listen<{ mod_name: string; file_name: string; replaced: string | null }>(
      'mod-auto-installed',
      (event) => {
        if (auditResults === null) return;
        const names = [event.payload.mod_name];
        if (event.payload.replaced && event.payload.replaced !== event.payload.mod_name) {
          names.push(event.payload.replaced);
        }
        refreshAuditEntries(names);
      },
    );
    return () => {
      unlisten.then((fn) => fn());
    };
    // We only need to re-bind when the audit flips between null and
    // non-null; refreshAuditEntries is otherwise stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auditResults === null]);

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
    <AppContext.Provider value={{ gameInfo, mods, loading, activeProfile, gameRunning, subUpdates, auditResults, auditing, runAudit, refreshAuditEntries, updatingAll, updateAllGithub, refreshGameInfo, refreshMods, refreshAll, refreshGameRunning, refreshSubUpdates, setActiveProfile, notifyNexusOpen }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextType {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
