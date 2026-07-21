import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { getActiveProfileId, getGameInfo, getInstalledMods, isGameRunning, checkSubscriptionUpdates, auditModVersions, updateAllMods, listProfiles } from '../hooks/useTauri';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { GameInfo, ModInfo, ModAuditEntry, ModAuditTarget, SubscriptionUpdate, UpdateApplyResult, UpdatePlanItem } from '../types';
import { useToast } from './ToastContext';
import { auditEntryKeys, auditTargetForMod, auditTargetKeys, type AuditRefreshTarget } from '../lib/auditState';
import { findProfileForIdentifier, isProfileUuid, safeProfileDisplayName } from '../lib/profileDisplay';

interface AppContextType {
  gameInfo: GameInfo | null;
  mods: ModInfo[];
  loading: boolean;
  activeProfile: string | null;
  activeProfileId: string | null;
  gameRunning: boolean;
  /** Per-pack updates available from upstream. Drives the badge on the
   *  Profiles sidebar item and the Home view's "update available" cards. */
  subUpdates: SubscriptionUpdate[];
  /** Latest mod-audit result. null = hasn't been run this session. Lifted
   *  here from Settings so the Mods view can show per-row "update available"
   *  pills without forcing the user to dig into Settings to discover them. */
  auditResults: ModAuditEntry[] | null;
  libraryVersionRevision: number;
  auditing: boolean;
  runAudit: (only?: AuditRefreshTarget[]) => Promise<void>;
  refreshAuditEntries: (targets: AuditRefreshTarget[]) => Promise<void>;
  refreshGameInfo: () => Promise<void>;
  refreshMods: () => Promise<void>;
  refreshAll: () => Promise<void>;
  refreshGameRunning: () => Promise<void>;
  refreshSubUpdates: () => Promise<void>;
  setActiveProfile: (profileId: string | null, displayName?: string | null) => void;
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
   *  an already-reviewed stable plan selection, toasts successful downloads,
   *  then re-audits just the touched rows. */
  updateAllGithub: (
    selectedPlans: UpdatePlanItem[],
    opts?: {
      profileId?: string | null;
      afterUpdate?: (updated: ModInfo[]) => Promise<void> | void;
    },
  ) => Promise<UpdateApplyResult[]>;
}

function indexAuditEntries(entries: ModAuditEntry[]): Map<string, ModAuditEntry> {
  const byKey = new Map<string, ModAuditEntry>();
  for (const entry of entries) {
    for (const key of auditMergeKeys(entry)) {
      byKey.set(key, entry);
    }
  }
  return byKey;
}

function auditMergeKeys(entry: ModAuditEntry): string[] {
  // Display names are only safe as a merge key for legacy audit rows that
  // lack artifact/folder identity; same-named local mods must stay distinct.
  const strongKeys = auditEntryKeys(entry).filter(
    (key) => key === entry.mod_version_id || key === entry.folder_name,
  );
  return strongKeys.length > 0 ? strongKeys : auditEntryKeys(entry);
}

function firstAuditReplacement(
  entry: ModAuditEntry,
  byKey: Map<string, ModAuditEntry>,
): ModAuditEntry | undefined {
  for (const key of auditMergeKeys(entry)) {
    const replacement = byKey.get(key);
    if (replacement) return replacement;
  }
  return undefined;
}

function mergeAuditResults(
  prev: ModAuditEntry[],
  fresh: ModAuditEntry[],
  requestedKeys?: Set<string>,
): ModAuditEntry[] {
  const byKey = indexAuditEntries(fresh);
  const existingKeys = new Set(prev.flatMap(auditMergeKeys));
  const usedFresh = new Set<ModAuditEntry>();
  const merged: ModAuditEntry[] = [];

  for (const entry of prev) {
    const replacement = firstAuditReplacement(entry, byKey);
    if (replacement) {
      if (!usedFresh.has(replacement)) {
        merged.push(replacement);
        usedFresh.add(replacement);
      }
      continue;
    }
    if (requestedKeys && auditMergeKeys(entry).some((key) => requestedKeys.has(key))) {
      continue;
    }
    merged.push(entry);
  }

  for (const entry of fresh) {
    const overlapsExisting = auditMergeKeys(entry).some((key) => existingKeys.has(key));
    if (!usedFresh.has(entry) && !overlapsExisting) {
      merged.push(entry);
      usedFresh.add(entry);
    }
  }

  return merged;
}

function normalizedIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLocaleLowerCase();
  return normalized || null;
}

/** Audit results are session-cached, while the Library can change after a
 * delete or an external filesystem refresh. Keep strong artifact/folder rows
 * only while that installed identity still exists; use names solely for
 * legacy audit payloads that do not carry a strong identity. */
function pruneAuditResultsForInstalledMods(
  audit: ModAuditEntry[] | null,
  installed: ModInfo[],
): ModAuditEntry[] | null {
  if (!audit) return audit;

  const installedStrongKeys = new Set<string>();
  const installedNames = new Set<string>();
  for (const mod of installed) {
    for (const value of [mod.mod_version_id, mod.folder_name]) {
      const key = normalizedIdentity(value);
      if (key) installedStrongKeys.add(key);
    }
    const name = normalizedIdentity(mod.name);
    if (name) installedNames.add(name);
  }

  return audit.filter((entry) => {
    const strongKeys = [entry.mod_version_id, entry.folder_name]
      .map(normalizedIdentity)
      .filter((key): key is string => Boolean(key));
    if (strongKeys.length > 0) {
      return strongKeys.some((key) => installedStrongKeys.has(key));
    }
    const name = normalizedIdentity(entry.mod_name);
    return Boolean(name && installedNames.has(name));
  });
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
  const [activeProfileId, setActiveProfileIdState] = useState<string | null>(null);
  const [gameRunning, setGameRunning] = useState<boolean>(false);
  const [subUpdates, setSubUpdates] = useState<SubscriptionUpdate[]>([]);
  const [auditResults, setAuditResults] = useState<ModAuditEntry[] | null>(null);
  const [libraryVersionRevision, setLibraryVersionRevision] = useState(0);
  const [auditing, setAuditing] = useState<boolean>(false);
  const [updatingAll, setUpdatingAll] = useState<boolean>(false);
  const gameRunningRef = useRef<boolean>(false);
  const toast = useToast();
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
      setLibraryVersionRevision((n) => n + 1);
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
      setAuditResults((previous) => pruneAuditResultsForInstalledMods(previous, installed));
    } catch (e) {
      console.error('Failed to get mods:', e);
    }
  }, []);

  const refreshAll = useCallback(async () => {
    setLoading(true);
    await Promise.all([refreshGameInfo(), refreshMods()]);
    // Load active profile and vanilla mode state from backend
    try {
      const [profile, profileId] = await Promise.all([
        invoke<string | null>('get_active_profile'),
        getActiveProfileId().catch(() => null),
      ]);
      const resolvedProfileId = profileId ?? (isProfileUuid(profile) ? profile : null);
      let displayName = safeProfileDisplayName(profile);
      if (!displayName && resolvedProfileId) {
        try {
          const profiles = await listProfiles();
          displayName = findProfileForIdentifier(profiles, resolvedProfileId)?.name ?? null;
        } catch {
          // Keep the backend id available even if the profile list is temporarily unavailable.
        }
      }
      setActiveProfileState(displayName);
      setActiveProfileIdState(resolvedProfileId);
    } catch { /* ignore */ }
    setLoading(false);
  }, [refreshGameInfo, refreshMods]);

  const setActiveProfile = useCallback((profileId: string | null, displayName?: string | null) => {
    setActiveProfileState(safeProfileDisplayName(displayName ?? profileId));
    setActiveProfileIdState(profileId);
    invoke('set_active_profile', { name: profileId }).catch(() => {});
  }, []);

  /** Run a full mod audit (GitHub + Nexus version checks for every linked
   *  mod). Result is cached in context so Settings and Mods can share it
   *  without refetching. Errors surface as a toast and leave the prior
   *  results in place. */
  const runAudit = useCallback(async (only?: AuditRefreshTarget[]) => {
    try {
      setAuditing(true);
      // `only` scopes the audit to specific mods (the modpack view audits
      // just its pack's mods); omitted = audit everything (All Mods view).
      const scoped = only && only.length > 0;
      const results = await auditModVersions(scoped ? only : undefined);
      if (scoped) {
        // A scoped re-check must NOT wipe updates already found on OTHER
        // mods by a prior full audit. Merge the fresh rows over the
        // existing ones (replace same-named, append new) via the functional
        // setter so a modpack-scoped audit doesn't clobber the shared
        // auditResults. When there's no prior audit, the scoped results
        // stand on their own.
        setAuditResults((prev) => {
          if (!prev) return results;
          return mergeAuditResults(prev, results, new Set(only.flatMap(auditTargetKeys)));
        });
      } else {
        setAuditResults(results);
      }
    } catch (e) {
      toast.error(t('app.auditFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setAuditing(false);
    }
  }, [toast, t]);

  /** Re-audit a targeted subset of mods and splice the fresh entries back
   *  into `auditResults`. Used after single-mod / bulk updates so rows
   *  flip from "X → Y" to "(latest)" without rescanning every mod. New
   *  entries (e.g. a mod that just landed via the Downloads watcher) get
   *  appended. */
  const refreshAuditEntries = useCallback(async (targets: AuditRefreshTarget[]) => {
    if (targets.length === 0) return;
    try {
      const fresh = await auditModVersions(targets);
      const requestedKeys = new Set(targets.flatMap(auditTargetKeys));
      setAuditResults((prev) => {
        if (!prev) return prev;
        return mergeAuditResults(prev, fresh, requestedKeys);
      });
    } catch {
      /* non-fatal — leaves existing rows in place */
    }
  }, []);

  const updateAllGithub = useCallback(async (
    selectedPlans: UpdatePlanItem[],
    opts?: {
      profileId?: string | null;
      afterUpdate?: (updated: ModInfo[]) => Promise<void> | void;
    },
  ): Promise<UpdateApplyResult[]> => {
    if (updatingAll || selectedPlans.length === 0) return [];
    setUpdatingAll(true);
    try {
      const results = await updateAllMods(
        selectedPlans.map((plan) => ({
          target: plan.target,
          expected_version: plan.target_version ?? '',
          provider: plan.provider,
        })),
        opts?.profileId ?? null,
      );
      const updated = results.flatMap((result) => (result.updated_mod ? [result.updated_mod] : []));
      if (updated.length > 0) setLibraryVersionRevision((n) => n + 1);
      await opts?.afterUpdate?.(updated);
      if (updated.length > 0) toast.success(t('app.updated', { count: updated.length }));
      await refreshAll();
      await refreshAuditEntries([
        ...selectedPlans.map((plan) => plan.target),
        ...updated.map((m) => auditTargetForMod(m)),
      ]);
      return results;
    } catch (e) {
      toast.error(t('app.updateFailed', { error: e instanceof Error ? e.message : String(e) }));
      return [];
    } finally {
      setUpdatingAll(false);
    }
  }, [updatingAll, toast, t, refreshAll, refreshAuditEntries]);

  // Auto-refresh audit rows when the downloads watcher catches a new mod
  // — only if an audit is currently loaded (don't surprise the user by
  // populating a fresh audit they didn't ask for).
  useEffect(() => {
    const unlisten = listen<{
      mod_name: string;
      file_name: string;
      replaced: string | null;
      mod_version_id?: string | null;
      folder_name?: string | null;
      mod_id?: string | null;
    }>(
      'mod-auto-installed',
      (event) => {
        if (auditResults === null) return;
        const targets: AuditRefreshTarget[] = [{
          mod_version_id: event.payload.mod_version_id ?? null,
          folder_name: event.payload.folder_name ?? null,
          mod_id: event.payload.mod_id ?? null,
          name: event.payload.mod_name,
        } satisfies ModAuditTarget];
        if (event.payload.replaced && event.payload.replaced !== event.payload.mod_name) {
          targets.push(event.payload.replaced);
        }
        refreshAuditEntries(targets);
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
    <AppContext.Provider value={{ gameInfo, mods, loading, activeProfile, activeProfileId, gameRunning, subUpdates, auditResults, libraryVersionRevision, auditing, runAudit, refreshAuditEntries, updatingAll, updateAllGithub, refreshGameInfo, refreshMods, refreshAll, refreshGameRunning, refreshSubUpdates, setActiveProfile, notifyNexusOpen }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppContextType {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
