import { useState, useEffect, useRef, useCallback, type CSSProperties, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Home,
  Package,
  Layers,
  Settings,
  Play,
  HelpCircle,
  ExternalLink,
  AlertTriangle,
  ChevronDown,
  ArrowUpCircle,
  Minus,
  Square,
  X,
  Loader2,
} from 'lucide-react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { isDevBuild } from './lib/isDevBuild';
import { cn } from './lib/utils';
import { ToastProvider, useToast } from './contexts/ToastContext';
import { AppProvider, useApp } from './contexts/AppContext';
import { ConfirmProvider, useConfirm } from './components/ConfirmDialog';
import { ThemeProvider } from './theme/ThemeContext';
import { RowMenuProvider } from './contexts/RowMenuContext';
import { ROW_MENU_OPEN_EVENT } from './lib/rowMenuConfig';
import { loadAutoAddInstallsToModpack } from './lib/installPolicy';
import { UiScaleProvider } from './display/UiScaleContext';
import { importShareCodeSmart } from './lib/shareImport';
import { switchResultDetails, switchResultHasProblems } from './lib/switchResultSummary';
import { getSubscriptions } from './hooks/useTauri';
import { OnboardingOverlay } from './components/OnboardingOverlay';
import { LaunchSpinner } from './components/LaunchSpinner';
import { LaunchHealthModal } from './components/LaunchHealthModal';
import { ProfileSwitcher } from './components/ProfileSwitcher';
import { HelpDrawer } from './components/HelpDrawer';
import { SidebarResizeHandle } from './components/SidebarResizeHandle';
import { LocalizedAppErrorBoundary, RendererErrorReporter } from './components/AppErrorBoundary';
import { recordModpackLaunch } from './lib/modpackUsage';
import { profileDisplayName, safeProfileDisplayName } from './lib/profileDisplay';
import { useResizableSidebar } from './hooks/useResizableSidebar';
import { useFailedUpdateRecovery } from './hooks/useFailedUpdateRecovery';
import {
  loadNavigationLayout,
  NAVIGATION_LAYOUT_CHANGE_EVENT,
  type NavigationLayout,
} from './display/navigationLayout';
import { HomeView } from './views/Home';
import { ModsView } from './views/Mods';
import { ProfilesView } from './views/Profiles';
import { SettingsView } from './views/Settings';
import { launchGame, launchVanilla, getLaunchHealth, installAppUpdate, installModFromFile, listProfiles, openExternalUrl, resolveLaunchHealthBlockers, setProfileModMembership, toggleMod } from './hooks/useTauri';
import type { LaunchHealthReport, ModAuditTarget, Profile } from './types';

// View IDs include legacy ones ('browse-mods', 'browse-modpacks')
// so internal handlers + deep-links that pre-date the 1.7.0 IA
// collapse still resolve to a sensible surface — the view router
// below maps them onto the new Library/Modpacks tabs. The top nav
// itself only exposes the four canonical ids. Help moved entirely
// to the topbar drawer + Settings tab.
type View = 'home' | 'profiles' | 'mods' | 'browse-mods' | 'browse-modpacks' | 'settings';
type ResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';

// Primary navigation: Home / Modpacks / Library / Settings. The first
// three live in NAV; Settings lives in FOOT_NAV so the default sidebar
// can keep it visually separated while the optional topbar renders one row.
// Browse Mods is a tab inside Library (formerly Mods); Browse Modpacks
// is a tab inside Modpacks. Help is a `?` icon in the topbar that
// opens a slide-out HelpDrawer, mirrored as a Settings tab. The
// user's central note: each nav item should map to ONE thing.
const NAV: { id: View; label: string; icon: typeof Home }[] = [
  { id: 'home',     label: 'Home',     icon: Home },
  { id: 'profiles', label: 'Modpacks', icon: Layers },
  { id: 'mods',     label: 'Mod Library', icon: Package },
];
const FOOT_NAV: { id: View; label: string; icon: typeof Home }[] = [
  { id: 'settings', label: 'Settings', icon: Settings },
];

const RESIZE_HANDLES: { direction: ResizeDirection; className: string }[] = [
  { direction: 'North', className: 'gf-resize-n' },
  { direction: 'NorthEast', className: 'gf-resize-ne' },
  { direction: 'East', className: 'gf-resize-e' },
  { direction: 'SouthEast', className: 'gf-resize-se' },
  { direction: 'South', className: 'gf-resize-s' },
  { direction: 'SouthWest', className: 'gf-resize-sw' },
  { direction: 'West', className: 'gf-resize-w' },
  { direction: 'NorthWest', className: 'gf-resize-nw' },
];

export default function App() {
  return (
    <ThemeProvider>
      <RowMenuProvider>
        <UiScaleProvider>
          <ToastProvider>
            <ConfirmProvider>
              <AppProvider>
                <RendererErrorReporter />
                <LocalizedAppErrorBoundary>
                  <AppInner />
                </LocalizedAppErrorBoundary>
              </AppProvider>
            </ConfirmProvider>
          </ToastProvider>
        </UiScaleProvider>
      </RowMenuProvider>
    </ThemeProvider>
  );
}


function AppInner() {
  const { t } = useTranslation();
  const [activeView, setActiveView] = useState<View>('home');
  const [navigationLayout, setNavigationLayout] = useState<NavigationLayout>(() => loadNavigationLayout());
  const { gameInfo, mods, refreshAll, refreshAuditEntries, activeProfile, activeProfileId, gameRunning, subUpdates, refreshSubUpdates } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const promptFailedUpdateSkip = useFailedUpdateRecovery();
  const sidebar = useResizableSidebar();
  const [dragOver, setDragOver] = useState(false);
  const [appUpdate, setAppUpdate] = useState<Update | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [checkingAppUpdate, setCheckingAppUpdate] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showProfileSwitcher, setShowProfileSwitcher] = useState(false);
  // 1.7.0 T16 — bumped by sibling surfaces (Mods view "Manage active
  // modpack →" link) when they want Modpacks to open the active
  // modpack's detail view on entry. Replaces the legacy
  // openModLibrarySignal which targeted the removed standalone Mod
  // Library workspace.
  const [openActiveModpackSignal, setOpenActiveModpackSignal] = useState(0);
  const [showHelpDrawer, setShowHelpDrawer] = useState(false);
  // Bumped whenever a sibling view (ProfileSwitcher's "Add pack",
  // onboarding's paste-code action) wants the Modpacks toolbar's
  // Quick-Add input to focus + pulse. The bump triggers a one-shot
  // effect inside ProfilesView. Replaces the 1.7-v6 `focusCodeBarSignal`
  // pump that targeted Home's now-removed Quick-Add card.
  const [focusModpacksCodeBarSignal, setFocusModpacksCodeBarSignal] = useState(0);
  // 1.7.0 T8 — incremented when the branched onboarding's creator-
  // path final CTA fires. ProfilesView observes the bump and opens
  // the guided CreateModpackWizard. Same one-shot signal pattern as
  // the focus pump above.
  const [openCreateWizardSignal, setOpenCreateWizardSignal] = useState(0);
  // Bumped by the top-bar "STS2 detected" status to force Settings back to
  // its General sub-tab even when Settings is already open (#138).
  const [settingsGeneralSignal, setSettingsGeneralSignal] = useState(0);
  // Bumped when the kebab's "Customize menu…" item fires ROW_MENU_OPEN_EVENT.
  // SettingsView observes the bump and scrolls/highlights the customizer card.
  const [openRowMenuSettingsSignal, setOpenRowMenuSettingsSignal] = useState(0);
  const [launching, setLaunching] = useState<null | 'modded' | 'vanilla'>(null);
  const [launchChecking, setLaunchChecking] = useState(false);
  const [launchHealthReport, setLaunchHealthReport] = useState<LaunchHealthReport | null>(null);
  const [launchHealthStoring, setLaunchHealthStoring] = useState(false);
  const [blockingModpackOperation, setBlockingModpackOperation] = useState(false);
  const [activeProfileSummary, setActiveProfileSummary] = useState<{
    key: string;
    profile: Profile | null;
  } | null>(null);
  const [isDev, setIsDev] = useState(false);
  useEffect(() => {
    isDevBuild().then(setIsDev).catch(() => {});
  }, []);

  useEffect(() => {
    function onNavigationLayoutChange(event: Event) {
      const value = (event as CustomEvent<{ value?: NavigationLayout }>).detail?.value;
      setNavigationLayout(value === 'topbar' || value === 'sidebar' ? value : loadNavigationLayout());
    }
    window.addEventListener(NAVIGATION_LAYOUT_CHANGE_EVENT, onNavigationLayoutChange);
    return () => window.removeEventListener(NAVIGATION_LAYOUT_CHANGE_EVENT, onNavigationLayoutChange);
  }, []);

  // Deep-link: "Customize menu…" kebab item dispatches ROW_MENU_OPEN_EVENT →
  // route to Settings and bump the signal so SettingsView scrolls/highlights the card.
  useEffect(() => {
    function onOpen() {
      setActiveView('settings');
      setOpenRowMenuSettingsSignal((n) => n + 1);
    }
    window.addEventListener(ROW_MENU_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(ROW_MENU_OPEN_EVENT, onOpen);
  }, []);

  // First-launch onboarding wizard (v5 batch 4). Shown once unless dismissed.
  useEffect(() => {
    let dismissed = false;
    try { dismissed = localStorage.getItem('sts2mm-onboarded') === 'true'; } catch {}
    if (dismissed) return;
    setShowOnboarding(true);
  }, []);

  // `persist` defaults true (the normal "done / not interested" dismissal).
  // The detect-game step passes false when no game is found yet, so a no-game
  // first-run user — who can otherwise only Skip — still sees onboarding again
  // next launch (e.g. once they've installed STS2) instead of being locked out.
  function dismissOnboarding(persist = true) {
    setShowOnboarding(false);
    if (persist) {
      try { localStorage.setItem('sts2mm-onboarded', 'true'); } catch {}
    }
  }

  // Build the "preserved N config files" toast message. Includes up to
  // three filenames inline so the user can see what was kept at a
  // glance; beyond that the count + "(and N more)" keeps it readable.
  const formatPreservedConfigsMessage = (modName: string, files: string[]): string => {
    const n = files.length;
    const shown = files.slice(0, 3).join(', ');
    const base = t('app.toast.preservedConfigs', { count: n, mod: modName, files: shown });
    const tail = n > 3 ? t('app.toast.preservedConfigs_more', { count: n - 3 }) : '';
    return `${base}${tail}`;
  };

  // "Couldn't re-apply N config files" — same shape as the preserved toast, but
  // a warning: the update overwrote these and the restore failed, so the user
  // has to redo those edits. (Rust leaves the baseline untouched so a later
  // update can still recover them.)
  const formatLostConfigsMessage = (modName: string, files: string[]): string => {
    const n = files.length;
    const shown = files.slice(0, 3).join(', ');
    const base = t('app.toast.lostConfigs', { count: n, mod: modName, files: shown });
    const tail = n > 3 ? t('app.toast.lostConfigs_more', { count: n - 3 }) : '';
    return `${base}${tail}`;
  };

  // Listen for auto-installed mods from the Downloads watcher
  useEffect(() => {
    const unlisten1 = listen<{
      mod_name: string;
      file_name: string;
      replaced: string | null;
      preserved_configs?: string[];
      incompatible?: {
        min_game_version: string;
        user_game_version: string;
      } | null;
    }>('mod-auto-installed', (event) => {
      const { mod_name, file_name, replaced, preserved_configs, incompatible } = event.payload;
      if (incompatible) {
        const args = {
          mod: mod_name,
          name: mod_name,
          replaced: replaced ?? mod_name,
          file: file_name,
          version: incompatible.min_game_version,
          gameVersion: incompatible.user_game_version || '?',
        };
        toast.error(
          replaced
            ? t('app.toast.replacedModUnsupported', args)
            : t('app.toast.autoInstalledUnsupported', args),
        );
      } else if (replaced) {
        toast.success(t('app.toast.replacedMod', { replaced, mod: mod_name, file: file_name }));
      } else {
        toast.success(t('app.toast.autoInstalled', { name: mod_name, file: file_name }));
      }
      // Preserved-configs toast fires as its own event for non-watcher
      // updates (update_mod / update_all_mods). The watcher inlines the
      // list on the auto-installed event, so emit the toast here.
      if (preserved_configs && preserved_configs.length > 0) {
        toast.info(formatPreservedConfigsMessage(mod_name, preserved_configs));
      }
      refreshAll();
    });
    const unlisten2 = listen<{
      file_name: string;
      error: string;
      mod_name?: string | null;
      folder_name?: string | null;
      mod_id?: string | null;
      mod_version_id?: string | null;
      skip_version?: string | null;
    }>('mod-auto-install-failed', async (event) => {
      const {
        file_name,
        error,
        mod_name,
        folder_name,
        mod_id,
        mod_version_id,
        skip_version,
      } = event.payload;
      if (mod_name && skip_version) {
        const target: ModAuditTarget = {
          mod_version_id: mod_version_id ?? null,
          folder_name: folder_name ?? null,
          mod_id: mod_id ?? null,
          name: mod_name,
        };
        const skipped = await promptFailedUpdateSkip({
          modName: mod_name,
          folderName: folder_name ?? null,
          skipVersion: skip_version,
          error,
          onSkipped: () => refreshAuditEntries([target]),
        });
        if (skipped) return;
      }
      toast.error(t('app.toast.installFailed', { file: file_name, error }));
    });
    // Emitted by update_mod / repair_mod / update_all_mods whenever an
    // update carried forward user-edited config files. The downloads
    // watcher path uses the inline `preserved_configs` field on
    // `mod-auto-installed` instead (single event, simpler frontend).
    const unlistenPreserve = listen<{ mod_name: string; files: string[] }>(
      'mod-configs-preserved',
      (event) => {
        const { mod_name, files } = event.payload;
        if (files.length === 0) return;
        toast.info(formatPreservedConfigsMessage(mod_name, files));
      },
    );
    // Emitted when an update could NOT re-apply user-edited configs (restore
    // failed after extraction). A warning, not a quiet info — those edits are
    // gone and need redoing.
    const unlistenLost = listen<{ mod_name: string; files: string[] }>(
      'mod-configs-lost',
      (event) => {
        const { mod_name, files } = event.payload;
        if (files.length === 0) return;
        toast.error(formatLostConfigsMessage(mod_name, files));
      },
    );
    // Modpack apply / subscription update emits this when one or more
    // mods in the pack require a newer game version than the user's
    // STS2 ships. We've already deleted the offending files (the install
    // would have produced a useless artifact); just tell the user
    // why those mods aren't there.
    const unlisten3 = listen<{
      profile_name: string;
      skipped: { mod_name: string; min_game_version: string; user_game_version: string }[];
    }>('modpack-mods-skipped', (event) => {
      const { profile_name, skipped } = event.payload;
      if (skipped.length === 0) return;
      const summary = skipped.length === 1
        ? t('app.skippedMod', { name: skipped[0].mod_name, version: skipped[0].min_game_version, gameVersion: skipped[0].user_game_version || '?' })
        : t('app.skippedMods', { n: skipped.length, names: skipped.map((s) => s.mod_name).join(', ') });
      toast.info(t('app.toast.modpackApplied', { name: profile_name, summary }));
    });
    return () => {
      unlisten1.then(f => f());
      unlisten2.then(f => f());
      unlisten3.then(f => f());
      unlistenPreserve.then(f => f());
      unlistenLost.then(f => f());
    };
  }, []);

  // ── sts2mm:// deep-link handler ────────────────────────────────────
  // A friend clicks a share link → OS routes the URL to our app → the
  // Rust on_open_url callback (lib.rs setup) emits `sts2mm-open-url`
  // AND buffers it in AppState (in case React isn't mounted yet — cold
  // start). On mount we drain the buffer, then listen for live URLs.
  // Both paths route into the SAME smart router the manual paste flow
  // uses, so "already have this pack" cases (activate / apply pending
  // update / no-op) get the same handling regardless of how the code
  // arrived.
  //
  // The listener-registration effect runs once and uses refs to read
  // the LATEST activeProfile + subUpdates at the moment the URL fires —
  // otherwise a stale closure would tell the smart router "the active
  // profile is whatever it was at app startup" and incorrect
  // `already-active` toasts would slip through.
  const activeProfileRef = useRef(activeProfile);
  const activeProfileIdRef = useRef(activeProfileId);
  const subUpdatesRef = useRef(subUpdates);
  useEffect(() => { activeProfileRef.current = activeProfile; }, [activeProfile]);
  useEffect(() => { activeProfileIdRef.current = activeProfileId; }, [activeProfileId]);
  useEffect(() => { subUpdatesRef.current = subUpdates; }, [subUpdates]);

  // The modpack the user is currently viewing in ProfilesView (null when
  // they're on a list/other view). A zip dropped while viewing a pack
  // auto-joins it — same "added through the modpack view → in the pack"
  // behavior as Quick add / Import. A ref so the global drop handler reads
  // the latest without re-binding its listeners.
  const viewedPackRef = useRef<{ id: string; name: string } | null>(null);
  const handleViewedModpackChange = useCallback((profile: { id: string; name: string } | null) => {
    viewedPackRef.current = profile;
  }, []);

  // De-dupe ref: a URL can arrive via two paths (cold-start buffer
  // drain AND the live `sts2mm-open-url` event) within milliseconds of
  // each other. Without de-dupe the user gets two confirm dialogs back
  // to back — or worse, two parallel installs that race.
  //
  // We use a TIME-WINDOW dedupe (URL → last-seen timestamp), not a
  // permanent set, because the user legitimately re-fires the same URL
  // when they: cancel a confirm dialog and want to retry from the
  // bridge page, click the bridge button a minute later, or hit
  // "Try again" after the stalled banner appears. Anything beyond
  // DEDUPE_WINDOW_MS is treated as a fresh user intent. Duplicate
  // emits from the two channels arrive within ~1ms of each other so
  // 2s is generous; the prior implementation pinned the URL forever
  // and made cancel-then-retry silently no-op.
  const processedUrlsRef = useRef<Map<string, number>>(new Map());
  const DEDUPE_WINDOW_MS = 2000;

  useEffect(() => {
    let active = true;

    async function route(url: string) {
      if (!active) return;
      const now = Date.now();
      const lastSeen = processedUrlsRef.current.get(url);
      if (lastSeen !== undefined && now - lastSeen < DEDUPE_WINDOW_MS) {
        console.debug(
          `Deep-link: skipping duplicate URL within ${DEDUPE_WINDOW_MS}ms window:`,
          url,
        );
        return;
      }
      processedUrlsRef.current.set(url, now);

      // Switch to Home so the user has the share-code context visible
      // behind the confirm dialog — disorienting otherwise if they were
      // mid-Audit when the click came in.
      setActiveView('home');

      try {
        // The smart router's canonicalShareCode helper strips the
        // protocol + action prefix and passes a clean owner/CODE
        // string to the Rust install commands. We pass the raw URL
        // through unmodified — canonicalization happens inside the
        // router so every share-code surface in the app goes through
        // the same parsing path.
        const subs = await getSubscriptions().catch(() => []);
        const outcome = await importShareCodeSmart(url, {
          confirm,
          subscriptions: subs,
          activeProfile: activeProfileRef.current,
          activeProfileId: activeProfileIdRef.current,
          subUpdates: subUpdatesRef.current,
          t,
          onBusyChange: setBlockingModpackOperation,
        });
        if (outcome.kind === 'cancelled') return;

        await refreshAll();
        refreshSubUpdates();

      if (outcome.kind === 'installed') {
        toast.success(
          t('home.toast.installedModpack', { name: outcome.profile.name, count: outcome.profile.mods.length }),
        );
        } else if (outcome.kind === 'activated') {
          const parts = switchResultDetails(outcome.result, t, { includeLists: false });
          (switchResultHasProblems(outcome.result) ? toast.error : toast.info)(parts.length > 0
            ? parts.join(', ')
            : t('profiles.toast.activated', { name: outcome.profileName }));
        } else if (outcome.kind === 'reapplied') {
          const parts = switchResultDetails(outcome.result, t, { includeLists: false });
          (switchResultHasProblems(outcome.result) ? toast.error : toast.info)(parts.length > 0
            ? parts.join(', ')
            : t('profiles.toast.reapplied', { name: outcome.profileName }));
        } else if (outcome.kind === 'synced') {
          toast.success(t('profiles.toast.syncedUpToDate', { name: outcome.profileName }));
        } else if (outcome.kind === 'already-active') {
          toast.info(t('profiles.toast.alreadyActive', { name: outcome.profileName }));
        } else if (outcome.kind === 'own-published-exists') {
          toast.info(t('profiles.toast.ownPublishedAlreadyExists', { name: outcome.profileName }));
        }
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        toast.error(t('app.toast.couldntOpenShare', { error: errMsg }));
        // No explicit delete needed — the time-window dedupe ages the
        // entry out in 2s, well within any human-paced retry.
      }
    }

    // 1. Drain any URL that arrived before we mounted (cold start).
    invoke<string | null>('consume_pending_deep_link')
      .then((url) => {
        if (url) route(url);
      })
      .catch(() => { /* command may be missing during dev hot-reload — fine */ });

    // 2. Listen for live URLs (warm hits — user clicks another share
    //    link while the app is already running).
    const unlisten = listen<string>('sts2mm-open-url', (event) => {
      if (event.payload) route(event.payload);
    });

    return () => {
      active = false;
      unlisten.then((f) => f());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check for app updates on launch and every 24h — but NOT on dev builds.
  // A dev build deliberately runs a pre-release; the "update to the latest
  // release" nag is counterproductive there (build management lives in the
  // Dev Builds section instead). Release builds are unchanged.
  useEffect(() => {
    let active = true;
    let interval: ReturnType<typeof setInterval> | undefined;
    function doCheck() {
      check()
        .then((update) => {
          if (update) setAppUpdate(update);
        })
        .catch((e) => {
          console.warn('Update check failed:', e);
        });
    }
    isDevBuild().then((dev) => {
      if (!active || dev) return;
      doCheck();
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      interval = setInterval(doCheck, ONE_DAY_MS);
    });
    return () => {
      active = false;
      if (interval) clearInterval(interval);
    };
  }, []);

  const RELEASES_URL = 'https://github.com/MohamedSerhan/sts2-mod-manager/releases/latest';

  async function handleCheckAppUpdateNow() {
    if (checkingAppUpdate) return;
    setCheckingAppUpdate(true);
    try {
      const update = await check();
      if (!update) {
        setAppUpdate(null);
        toast.success(t('about.latestVersion'));
        return;
      }
      setAppUpdate(update);
      setUpdateDismissed(false);
    } catch (e) {
      toast.error(t('about.updateCheckFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setCheckingAppUpdate(false);
    }
  }

  async function handleInstallUpdate() {
    if (!appUpdate || updateInstalling) return;
    setUpdateInstalling(true);
    try {
      await installAppUpdate();
      toast.success(t('app.toast.updateInstalled'));
      await relaunch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(t('app.updateFailed', { error: msg }));
      setUpdateInstalling(false);
    }
  }

  async function handleDownloadUpdate() {
    try {
      await openExternalUrl(RELEASES_URL);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('app.toast.browserFailed', { error: errMsg }));
    }
  }

  const activeProfileKey = activeProfileId ?? activeProfile;
  const activePackMods = activeProfileSummary?.key === activeProfileKey
    ? activeProfileSummary.profile?.mods ?? []
    : [];
  const activeProfileDisplayName =
    activeProfileSummary?.profile?.name ?? safeProfileDisplayName(activeProfile);
  const activeProfileLabel = activeProfileKey
    ? activeProfileDisplayName ?? t('quickAdd.unknown')
    : t('common.vanilla');
  const launchProfileLabel = activeProfileKey
    ? activeProfileDisplayName ?? t('quickAdd.unknown')
    : t('app.launch.noActiveProfile');
  const enabledCount = activePackMods.filter((m) => m.enabled).length;
  const totalCount = activePackMods.length;
  const useTopNavigation = navigationLayout === 'topbar';
  const navLabels: Partial<Record<View, string>> = {
    home: t('nav.home'),
    profiles: t('nav.profiles'),
    mods: t('nav.mods'),
    settings: t('nav.settings'),
  };
  const renderNavButtons = (items: { id: View; label: string; icon: typeof Home }[]) =>
    items.map(({ id, icon: Icon }) => {
      const badge = id === 'profiles' && subUpdates.length > 0 ? subUpdates.length : null;
      return (
        <button
          key={id}
          onClick={() => setActiveView(id)}
          className={cn('gf-nav', activeView === id && 'active')}
        >
          <Icon size={14} className="gf-nav-icon" />
          <span className="gf-nav-label">{navLabels[id]}</span>
          {badge !== null && (
            <span className="gf-nav-badge" title={t('app.packUpdateTooltip', { count: badge, badge })}>
              {badge}
            </span>
          )}
        </button>
      );
    });

  useEffect(() => {
    if (!activeProfileKey) {
      setActiveProfileSummary(null);
      return;
    }
    let cancelled = false;
    listProfiles()
      .then((profiles) => {
        if (cancelled) return;
        const profile = profiles.find((p) => p.id === activeProfileKey || p.name === activeProfileKey) ?? null;
        setActiveProfileSummary({ key: activeProfileKey, profile });
      })
      .catch(() => {
        if (!cancelled) setActiveProfileSummary({ key: activeProfileKey, profile: null });
      });
    return () => { cancelled = true; };
  }, [activeProfileKey, mods]);

  function launchHealthHasHardBlockers(report: LaunchHealthReport): boolean {
    return (report.previous_failed_mods ?? []).length > 0
      || (report.known_incompatible_mods ?? []).length > 0
      || (report.dependency_blocked_mods ?? []).length > 0;
  }

  function launchHealthHasRisks(report: LaunchHealthReport): boolean {
    return launchHealthHasHardBlockers(report)
      || report.game_version_changed_since_last_launch
      || report.profile_game_version_changed;
  }

  async function launchModdedNow() {
    if (launching) return;
    setLaunchHealthReport(null);
    setLaunching('modded');
    try {
      await launchGame();
      const launchedProfile = activeProfileSummary?.profile;
      if (launchedProfile) {
        recordModpackLaunch(launchedProfile);
      } else if (activeProfileId && activeProfileDisplayName) {
        recordModpackLaunch({ id: activeProfileId, name: activeProfileDisplayName });
      } else if (safeProfileDisplayName(activeProfileKey)) {
        recordModpackLaunch(profileDisplayName(activeProfileKey, ''));
      }
      toast.success(t('app.toast.launching'));
      // Keep the spinner up briefly so the user sees the transition;
      // hide once the Steam launcher takes over the foreground.
      setTimeout(() => { setLaunching(null); refreshAll(); }, 2500);
    } catch (e) {
      setLaunching(null);
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('app.toast.launchFailed', { error: errMsg }));
    }
  }

  async function handleLaunchGame() {
    if (launching || launchChecking) return;
    setLaunchChecking(true);
    try {
      const report = await getLaunchHealth();
      if (launchHealthHasRisks(report)) {
        setLaunchHealthReport(report);
        return;
      }
    } catch (e) {
      console.warn('Launch health check failed:', e);
    } finally {
      setLaunchChecking(false);
    }
    await launchModdedNow();
  }

  async function handleLaunchHealthStoreAndLaunch() {
    if (launchHealthStoring || launching) return;
    setLaunchHealthStoring(true);
    try {
      const result = await resolveLaunchHealthBlockers();
      if (result.moved.length > 0) {
        toast.success(t('launchHealth.storedBlockedMods', { count: result.moved.length }));
      } else {
        toast.info(t('launchHealth.storeBlockedModsNone'));
      }
      await refreshAll();
      const nextReport = await getLaunchHealth();
      if (result.failed.length > 0) {
        const list = result.failed.map((item) => item.name).slice(0, 5).join(', ');
        toast.error(t('launchHealth.storeBlockedModsPartial', { list }));
        setLaunchHealthReport(nextReport);
        return;
      }
      if (launchHealthHasHardBlockers(nextReport)) {
        setLaunchHealthReport(nextReport);
        toast.error(t('launchHealth.blockersRemain'));
        return;
      }
      setLaunchHealthReport(null);
      await launchModdedNow();
    } catch (e) {
      toast.error(t('launchHealth.storeBlockedModsFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setLaunchHealthStoring(false);
    }
  }

  function handleLaunchHealthReview() {
    setLaunchHealthReport(null);
    setActiveView('mods');
  }

  async function handleLaunchHealthLaunchAnyway() {
    if (launchHealthStoring) return;
    setLaunchHealthReport(null);
    await launchModdedNow();
  }

  function handleLaunchHealthCancel() {
    if (launchHealthStoring) return;
    setLaunchHealthReport(null);
  }

  async function handleLaunchVanilla() {
    if (launching) return;
    setLaunching('vanilla');
    try {
      await launchVanilla();
      toast.success(t('app.toast.launchingVanilla'));
      await refreshAll();
      setTimeout(() => setLaunching(null), 2500);
    } catch (e) {
      setLaunching(null);
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('app.toast.launchVanillaFailed', { error: errMsg }));
    }
  }

  // Custom titlebar window controls (Tauri). Errors are logged so a missing
  // capability shows up in the console rather than failing silently.
  async function handleTitlebarMin() {
    try { await getCurrentWindow().minimize(); }
    catch (e) { console.warn('minimize failed:', e); }
  }
  async function handleTitlebarMax() {
    try { await getCurrentWindow().toggleMaximize(); }
    catch (e) { console.warn('toggleMaximize failed:', e); }
  }
  async function handleTitlebarClose() {
    try { await getCurrentWindow().close(); }
    catch (e) { console.warn('close failed:', e); }
  }
  async function handleResizeStart(direction: ResizeDirection, e: MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    e.stopPropagation();
    try { await getCurrentWindow().startResizeDragging(direction); }
    catch (err) { console.warn(`resize ${direction} failed:`, err); }
  }

  // Global keyboard shortcut: Ctrl/Cmd + L launches the active profile.
  // The other shortcuts (nav 1-4, focus search, settings, ?-overlay) were
  // pruned in v1.0.5 — they were inconsistent and underused; a single
  // discoverable launch chord is more valuable than a sprawling map.
  useEffect(() => {
    function isTypingTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      const tag = t.tagName.toUpperCase();
      return tag === 'INPUT' || tag === 'TEXTAREA' || t.isContentEditable;
    }
    function handler(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (showOnboarding) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        if (!gameRunning && !launching && !launchChecking) handleLaunchGame();
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showOnboarding, gameRunning, launching, launchChecking]);

  // Drag-and-drop archive import. Tauri v2 handles OS file drops natively
  // (dragDropEnabled defaults to true), which SUPPRESSES the webview's HTML5
  // drag events — so the old document-level dragover/drop handlers never fired
  // in the real app (only in a plain browser). Listen to Tauri's own
  // window-level drag events instead: the drop event hands us absolute file
  // PATHS directly (no fragile File.path access), and because the events are
  // window-level there's no per-element flicker to defend against.
  useEffect(() => {
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const track = (p: Promise<() => void>) => {
      p.then((fn) => { if (disposed) fn(); else unlisteners.push(fn); }).catch(() => {
        /* not inside a Tauri webview (e.g. plain-browser unit tests) */
      });
    };

    async function handleDroppedPaths(paths: string[]) {
      // Dropped archives install to the Library by default. If the user opted
      // into target-pack auto-add, also join the viewed pack and block followed
      // packs before the install starts.
      const pack = viewedPackRef.current;
      const autoAddToViewedPack = !!pack && loadAutoAddInstallsToModpack();
      if (pack && autoAddToViewedPack) {
        try {
          const subs = await getSubscriptions();
          if (subs.some((s) => s.profile_id === pack.id || s.profile_name.toLowerCase() === pack.name.toLowerCase())) {
            toast.info(t('mods.toast.followedPackNoAdd', { pack: pack.name }));
            return;
          }
        } catch {
          /* couldn't check subscriptions — fall through and attempt the install */
        }
      }
      for (const filePath of paths) {
        const name = filePath.split(/[\\/]/).pop() || filePath;
        const lower = name.toLowerCase();
        const isSupportedArchive =
          lower.endsWith('.zip') || lower.endsWith('.7z') || lower.endsWith('.rar');
        if (!isSupportedArchive) {
          toast.error(t('app.toast.unsupportedFile', { name }));
          continue;
        }
        try {
          const mod = await installModFromFile(filePath);
          if (pack && autoAddToViewedPack) {
            try {
              // Enable it in the live game folder FIRST when dropping into the
              // active pack: toggle_mod guards on the game running (and can
              // fail the move) while the membership write doesn't — toggling
              // first keeps disk + manifest in sync. (Only when it isn't
              // already active; toggle_mod errors on an already-active mod.)
              if ((pack.id === activeProfileIdRef.current || (!activeProfileIdRef.current && pack.name === activeProfileRef.current)) && !mod.enabled) {
                await toggleMod(mod.name, mod.folder_name ?? null, true);
              }
              await setProfileModMembership(
                pack.id,
                mod.name,
                mod.mod_version_id ?? null,
                mod.folder_name ?? null,
                mod.mod_id ?? null,
                true,
                mod.source ?? mod.github_url ?? mod.nexus_url ?? null,
              );
              toast.success(t('app.toast.installedModToPack', { name: mod.name, pack: pack.name }));
            } catch {
              // Membership failed — the mod is still installed on disk.
              toast.success(t('app.toast.installedMod', { name: mod.name }));
            }
          } else {
            toast.success(t('app.toast.installedMod', { name: mod.name }));
          }
          await refreshAll();
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          toast.error(t('app.toast.installZipFailed', { file: name, error: errMsg }));
        }
      }
    }

    track(listen('tauri://drag-enter', () => setDragOver(true)));
    track(listen('tauri://drag-leave', () => setDragOver(false)));
    track(
      listen<{ paths: string[] }>('tauri://drag-drop', (event) => {
        setDragOver(false);
        void handleDroppedPaths(event.payload?.paths ?? []);
      }),
    );

    return () => {
      disposed = true;
      unlisteners.forEach((fn) => fn());
    };
  }, [refreshAll, toast]);

  const profileInitials = activeProfileLabel
    .split(/[\s_-]+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  function handleExternalAnchorClick(event: MouseEvent<HTMLDivElement>) {
    /* v8 ignore start -- browser click guard permutations depend on native event shape; opener success/failure and ignored-link behavior are tested. */
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.altKey ||
      event.ctrlKey ||
      event.shiftKey
    ) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const anchor = target?.closest('a[href]');
    if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute('download')) {
      return;
    }

    const rawHref = anchor.getAttribute('href');
    if (!rawHref) return;

    let url: URL;
    try {
      url = new URL(rawHref, window.location.href);
    } catch {
      return;
    }

    if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
      return;
    }
    /* v8 ignore stop */

    event.preventDefault();
    openExternalUrl(url.href).catch((e) => {
      toast.error(t('app.toast.openLinkFailed', { error: e instanceof Error ? e.message : String(e) }));
    });
  }

  return (
    <div
      className="flex flex-col h-screen w-screen overflow-hidden relative"
      onClickCapture={handleExternalAnchorClick}
    >
      {/* Custom titlebar (Tauri drag region + window controls) */}
      <div className="gf-titlebar" data-tauri-drag-region>
        <div className="gf-titlebar-app" data-tauri-drag-region>
          <div className="gf-titlebar-mark" data-tauri-drag-region>✦</div>
          <span className="gf-titlebar-title" data-tauri-drag-region>{t('app.windowTitle')}</span>
          {isDev && <span className="gf-titlebar-dev" title={t('app.devBuildTitle')}>{t('app.devBadge')}</span>}
        </div>
        <div className="gf-titlebar-controls">
          <button className="gf-titlebar-btn" title={t('app.minimize')} onClick={handleTitlebarMin}>
            <Minus size={12} />
          </button>
          <button className="gf-titlebar-btn" title={t('app.maximize')} onClick={handleTitlebarMax}>
            <Square size={10} />
          </button>
          <button className="gf-titlebar-btn gf-titlebar-close" title={t('app.close')} onClick={handleTitlebarClose}>
            <X size={12} />
          </button>
        </div>
      </div>

      {RESIZE_HANDLES.map(({ direction, className }) => (
        <div
          key={direction}
          className={cn('gf-resize-handle', className)}
          onMouseDown={(e) => handleResizeStart(direction, e)}
          aria-hidden="true"
        />
      ))}

      <div className="flex flex-1 min-h-0 relative">
        {/* Drag-and-drop overlay (v5 dropzone) */}
        {dragOver && (
          <div className="gf-dropzone">
            <div className="gf-dropzone-card">
              <div className="gf-dropzone-icon">
                <Package size={28} />
              </div>
              <div className="gf-dropzone-title">{t('app.dragDrop.textActive')}</div>
              <div className="gf-dropzone-sub">{t('app.dragDrop.text')}</div>
            </div>
          </div>
        )}

        {/* Main column: top bar + content. Primary navigation moved from
            the old left sidebar into the topbar (Home / Modpacks / Library
            / Settings on the left, profile chip + status + launch on the
            right). The brand mark + app name live in the custom titlebar. */}
        {!useTopNavigation && (
          <nav
            className="gf-sidebar"
            style={{ '--gf-sidebar-width': `${sidebar.width}px` } as CSSProperties}
          >
            {renderNavButtons(NAV)}
            <div className="gf-side-foot">{renderNavButtons(FOOT_NAV)}</div>
            <SidebarResizeHandle sidebar={sidebar} />
          </nav>
        )}

        <div className="flex-1 min-w-0 flex flex-col">
          {/* Top bar — nav + profile chip + Vanilla + Launch */}
          <div className={cn('gf-top', useTopNavigation && 'has-topnav')}>
            {/* Top navigation. Settings (formerly the sidebar foot item)
                joins the same row. Keeps the `gf-nav` class so the active
                state + badge styles carry over. */}
            {useTopNavigation && (
              <nav className="gf-topnav">
                {renderNavButtons([...NAV, ...FOOT_NAV])}
              </nav>
            )}

            <div className="gf-top-chip" style={{ position: 'relative' }}>
              <button
                className="gf-prof"
                onClick={() => setShowProfileSwitcher((v) => !v)}
                title={t('app.switchActivePack')}
              >
                <div className="gf-prof-avatar">{profileInitials || t('app.vanillaInitials')}</div>
                <div className="gf-prof-text">
                  <span className="gf-prof-eyebrow">{t('app.activeProfile')}</span>
                  <span className="gf-prof-name">{activeProfileLabel}</span>
                </div>
                <span className="gf-prof-meta">
                  {t('app.modCount', { enabled: enabledCount, total: totalCount })}
                </span>
                <ChevronDown
                  size={14}
                  style={{
                    opacity: 0.4,
                    marginInlineStart: 4,
                    transform: showProfileSwitcher ? 'rotate(180deg)' : undefined,
                    transition: 'transform 0.15s',
                  }}
                />
              </button>
              {showProfileSwitcher && (
                <ProfileSwitcher
                  onClose={() => setShowProfileSwitcher(false)}
                  onAddPack={() => {
                    // Quick-Add lives on Modpacks now (1.7 v7). Route
                    // there and pulse the toolbar input so the user sees
                    // where to type.
                    setActiveView('profiles');
                    setFocusModpacksCodeBarSignal((n) => n + 1);
                  }}
                  onManageAll={() => setActiveView('profiles')}
                />
              )}
            </div>

            {/* STS2 detection status — shown on every screen so the user
                can tell at a glance whether the game folder is wired up
                (the previous at-a-glance signal was a sidebar status block
                that got dropped in the 1.7.0 consolidation). Clicking jumps
                to Settings, where the game path is configured. On a narrow
                topbar the launch controls drop to their own row below this
                status (see the @container rule in styles.css), so the
                status ends up directly above the launch button. */}
            <button
              onClick={() => {
                setActiveView('settings');
                setSettingsGeneralSignal((n) => n + 1);
              }}
              title={
                gameInfo?.valid
                  ? t('topbar.gameDetectedTitle', { path: gameInfo.game_path })
                  : t('topbar.gameNotFoundTitle')
              }
              className={cn('gf-game-status', gameInfo?.valid ? 'is-ok' : 'is-warn')}
            >
              {gameInfo?.valid ? (
                <span className="gf-game-status-dot" aria-hidden />
              ) : (
                <AlertTriangle size={13} aria-hidden />
              )}
              <span className="gf-game-status-label">
                {gameInfo?.valid ? t('topbar.gameDetected') : t('topbar.gameNotFound')}
              </span>
            </button>
            {/* Launch controls (help + vanilla + modded launch) grouped so
                they wrap together onto a row below the STS2 status when the
                topbar gets narrow. */}
            <div className="gf-top-launch">
              {/* 1.7.0 — Help moved out of the sidebar. The `?` button
                  opens a slide-out HelpDrawer (right side) that renders
                  the same content the Settings → Help tab shows. */}
              <button
                onClick={() => setShowHelpDrawer(true)}
                title={t('topbar.help')}
                aria-label={t('topbar.help')}
                className="gf-btn-3 gf-btn-icon"
              >
                <HelpCircle size={16} />
              </button>
              <button
                onClick={handleLaunchVanilla}
                disabled={gameRunning}
                title={
                  gameRunning
                    ? t('app.closeSts2First')
                    : t('app.vanillaDesc')
                }
                className="gf-btn-2 gf-btn-2-sm"
              >
                <Play size={11} /> {t('app.launch.vanilla')}
              </button>
              <button
                onClick={handleLaunchGame}
                disabled={gameRunning || launchChecking}
                title={
                  gameRunning
                    ? t('app.closeSts2First')
                    : launchChecking
                      ? t('launchHealth.checking')
                    : t('app.launch.moddedTitle', { profile: launchProfileLabel })
                }
                className="gf-btn"
              >
                {launchChecking ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Play size={12} fill="currentColor" />
                )}
                <span className="gf-launch-label">
                  {launchChecking ? t('launchHealth.checkingShort') : t('app.launch.modded')}{activeProfileKey ? <> · <span className="gf-launch-prof">{activeProfileLabel}</span></> : ''}
                </span>
              </button>
            </div>
          </div>

          {/* Game-running banner — v5 warn style */}
          {gameRunning && (
            <div style={{ padding: '10px 22px 0' }}>
              <div className="gf-banner gf-banner-warn">
                <AlertTriangle size={16} className="gf-banner-icon" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>{t('app.gameRunning')}</div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                    {t('app.gameRunningDesc')}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* App-update banner — v5 info style */}
          {appUpdate && !updateDismissed && (
            <div style={{ padding: '10px 22px 0' }}>
              <div className="gf-banner gf-banner-info">
                <ArrowUpCircle size={16} className="gf-banner-icon" />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600 }}>
                    {updateInstalling
                      ? t('app.installing', { version: appUpdate.version })
                      : t('app.updateAvailableBanner', { version: appUpdate.version })}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    {updateInstalling
                      ? t('app.willRestart')
                      : t('app.currentVersion', { version: appUpdate.currentVersion })}
                  </div>
                  <div className="gf-banner-security-note">
                    {t('app.windowsSecurityNote')}
                  </div>
                </div>
                <button
                  onClick={() => setUpdateDismissed(true)}
                  disabled={updateInstalling}
                  className="gf-btn-3"
                >
                  {t('common.dismiss')}
                </button>
                <button
                  onClick={handleDownloadUpdate}
                  disabled={updateInstalling}
                  title={t('app.downloadManual')}
                  className="gf-btn-3"
                >
                  <ExternalLink size={11} /> {t('app.download')}
                </button>
                <button
                  onClick={handleInstallUpdate}
                  disabled={updateInstalling}
                  className="gf-btn gf-btn-sm"
                >
                  {updateInstalling ? t('app.installingLabel') : t('app.installAndRestartLabel')}
                </button>
              </div>
            </div>
          )}

          {/* Active view */}
          <main className="flex-1 min-h-0 overflow-auto" style={{ position: 'relative' }}>
            {activeView === 'home' && (
              <HomeView
                onGoToSettings={() => setActiveView('settings')}
                onGoToMods={() => setActiveView('mods')}
                onGoToProfiles={() => setActiveView('profiles')}
                onGoToBrowseModpacks={() => setActiveView('browse-modpacks')}
                onCreateModpack={() => {
                  // Route to Modpacks + pump the Create-wizard signal so
                  // ProfilesView opens the guided wizard on entry (same
                  // one-shot pattern the creator-onboarding CTA uses).
                  setActiveView('profiles');
                  setOpenCreateWizardSignal((n) => n + 1);
                }}
                onLaunch={handleLaunchGame}
                onBlockingOperationChange={setBlockingModpackOperation}
                onCheckForAppUpdate={handleCheckAppUpdateNow}
                checkingAppUpdate={checkingAppUpdate}
              />
            )}
            {/* Modpacks view. The legacy 'browse-modpacks' view-id
                redirects here with the Browse tab pre-selected so old
                handlers / deep-links keep working without rewiring. */}
            {(activeView === 'profiles' || activeView === 'browse-modpacks') && (
              <ProfilesView
                onGoToSettings={() => setActiveView('settings')}
                openActiveModpackSignal={openActiveModpackSignal}
                initialTab={activeView === 'browse-modpacks' ? 'browse' : 'yours'}
                focusQuickAddSignal={focusModpacksCodeBarSignal}
                openCreateWizardSignal={openCreateWizardSignal}
                onCreateWizardConsumed={() => setOpenCreateWizardSignal(0)}
                onViewedModpackChange={handleViewedModpackChange}
                onBlockingOperationChange={setBlockingModpackOperation}
              />
            )}
            {/* Library view. The legacy 'browse-mods' view-id
                redirects here with the Browse tab pre-selected so the
                Nexus "open settings" handler etc. keep working. */}
            {(activeView === 'mods' || activeView === 'browse-mods') && (
              <ModsView
                onManageActiveModpack={() => {
                  // T16 — bumps the Modpacks "open active modpack
                  // detail view" signal and routes the user there.
                  // ProfilesView observes the bump and opens
                  // selectedModpack = activeProfile on next render.
                  setOpenActiveModpackSignal((signal) => signal + 1);
                  setActiveView('profiles');
                }}
                onGoToSettings={() => setActiveView('settings')}
                initialTab={activeView === 'browse-mods' ? 'browse' : 'installed'}
              />
            )}
            {activeView === 'settings' && (
              <SettingsView
                goToGeneralSignal={settingsGeneralSignal}
                openRowMenuSettingsSignal={openRowMenuSettingsSignal}
                onCheckForAppUpdate={handleCheckAppUpdateNow}
                checkingAppUpdate={checkingAppUpdate}
              />
            )}

            {/* 1.7.0 T8 — branched first-launch onboarding. The flow
                asks the user ONE question (Play vs Make/Share) then
                teaches the relevant path through the new IA. GitHub
                token + Nexus API key are NOT mentioned in onboarding —
                share-time GitHub setup lives inside ShareSetupPanel,
                and Nexus key entry happens on the first manual
                Nexus install. */}
            {showOnboarding && (
              <OnboardingOverlay
                gameInfo={gameInfo}
                onSkip={() => dismissOnboarding(true)}
                onComplete={() => dismissOnboarding(true)}
                onDismissWithoutPersist={() => dismissOnboarding(false)}
                onCreateModpack={() => {
                  // Creator-path final CTA. Close + route to Modpacks
                  // + pump the Create-wizard signal so ProfilesView
                  // opens the guided wizard on entry.
                  dismissOnboarding();
                  setActiveView('profiles');
                  setOpenCreateWizardSignal((n) => n + 1);
                }}
                onGoToHome={() => {
                  dismissOnboarding();
                  setActiveView('home');
                }}
                refreshGame={refreshAll}
              />
            )}

            {/* Launching-game spinner */}
            {launching && (
              <LaunchSpinner
                vanilla={launching === 'vanilla'}
                onCancel={() => setLaunching(null)}
              />
            )}

            {launchHealthReport && (
              <LaunchHealthModal
                report={launchHealthReport}
                storing={launchHealthStoring}
                onStoreAndLaunch={handleLaunchHealthStoreAndLaunch}
                onLaunchAnyway={handleLaunchHealthLaunchAnyway}
                onReview={handleLaunchHealthReview}
                onCancel={handleLaunchHealthCancel}
              />
            )}

            {/* Slide-out Help drawer, opened from the topbar `?`. */}
            <HelpDrawer open={showHelpDrawer} onClose={() => setShowHelpDrawer(false)} />
            {blockingModpackOperation && (
              <div className="gf-app-blocker" role="status" aria-live="polite" aria-busy="true">
                <div className="gf-app-blocker-panel">
                  <Loader2 size={20} className="gf-spin" aria-hidden />
                  <div className="gf-app-blocker-title">{t('browseModpacks.installingModpack')}</div>
                </div>
              </div>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}
