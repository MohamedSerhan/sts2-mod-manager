import { useState, useEffect, useRef, type MouseEvent } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Home,
  Package,
  Search,
  Boxes,
  Layers,
  Settings,
  Play,
  GraduationCap,
  ExternalLink,
  AlertTriangle,
  ChevronDown,
  ArrowUpCircle,
  Minus,
  Square,
  X,
} from 'lucide-react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { cn } from './lib/utils';
import { ToastProvider, useToast } from './contexts/ToastContext';
import { AppProvider, useApp } from './contexts/AppContext';
import { ConfirmProvider, useConfirm } from './components/ConfirmDialog';
import { Badge } from './components/Badge';
import { importShareCodeSmart } from './lib/shareImport';
import { getSubscriptions } from './hooks/useTauri';
import { OnboardingOverlay } from './components/OnboardingOverlay';
import { LaunchSpinner } from './components/LaunchSpinner';
import { ProfileSwitcher } from './components/ProfileSwitcher';
import { HomeView } from './views/Home';
import { ModsView } from './views/Mods';
import { BrowseView } from './views/Browse';
import { BrowseModpacksView } from './views/BrowseModpacks';
import { ProfilesView } from './views/Profiles';
import { SettingsView } from './views/Settings';
import { TutorialView } from './views/Tutorial';
import { launchGame, launchVanilla, installModFromFile, openExternalUrl } from './hooks/useTauri';

type View = 'home' | 'profiles' | 'mods' | 'browse-mods' | 'browse-modpacks' | 'tutorial' | 'settings';
type ResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';

// v5 IA — 4 main nav items, Tutorial+Settings in the foot. Backups absorbed
// into Settings as a tab. Dashboard cut (was redundant with Home).
const NAV: { id: View; label: string; icon: typeof Home }[] = [
  { id: 'home',     label: 'Home',     icon: Home },
  { id: 'profiles', label: 'Profiles', icon: Layers },
  { id: 'mods',     label: 'Mods',     icon: Package },
  { id: 'browse-mods',     label: 'Browse Mods',     icon: Search },
  { id: 'browse-modpacks', label: 'Browse Modpacks', icon: Boxes },
];
const FOOT_NAV: { id: View; label: string; icon: typeof Home }[] = [
  { id: 'tutorial', label: 'Tutorial', icon: GraduationCap },
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
    <ToastProvider>
      <ConfirmProvider>
        <AppProvider>
          <AppInner />
        </AppProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

/** Build the "preserved N config files" toast message. Includes up to
 *  three filenames inline so the user can see what was kept at a
 *  glance; beyond that the count + "(and N more)" keeps it readable.
 *  Used both for the downloads-watcher single-event flow AND for the
 *  per-mod `mod-configs-preserved` event from update_mod / repair_mod /
 *  update_all_mods.
 */
function formatPreservedConfigsMessage(modName: string, files: string[]): string {
  const n = files.length;
  const shown = files.slice(0, 3).join(', ');
  const tail = n > 3 ? ` (and ${n - 3} more)` : '';
  return `Preserved ${n} config file${n === 1 ? '' : 's'} you edited in "${modName}": ${shown}${tail}`;
}

function AppInner() {
  const [activeView, setActiveView] = useState<View>('home');
  const { gameInfo, mods, refreshAll, activeProfile, gameRunning, subUpdates, refreshSubUpdates } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [dragOver, setDragOver] = useState(false);
  const [appUpdate, setAppUpdate] = useState<Update | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showProfileSwitcher, setShowProfileSwitcher] = useState(false);
  // Bumped whenever something elsewhere in the UI wants Home's share-code
  // input to grab focus + pulse (e.g. clicking "Add pack" in the profile
  // switcher). Each bump triggers a one-shot effect in Home; the value
  // itself is meaningless, only the change matters.
  const [focusCodeBarSignal, setFocusCodeBarSignal] = useState(0);
  const [launching, setLaunching] = useState<null | 'modded' | 'vanilla'>(null);

  useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);

  // First-launch onboarding wizard (v5 batch 4). Shown once unless dismissed.
  useEffect(() => {
    let dismissed = false;
    try { dismissed = localStorage.getItem('sts2mm-onboarded') === 'true'; } catch {}
    if (dismissed) return;
    setShowOnboarding(true);
  }, []);

  function dismissOnboarding() {
    setShowOnboarding(false);
    try { localStorage.setItem('sts2mm-onboarded', 'true'); } catch {}
  }

  // Listen for auto-installed mods from the Downloads watcher
  useEffect(() => {
    const unlisten1 = listen<{
      mod_name: string;
      file_name: string;
      replaced: string | null;
      preserved_configs?: string[];
    }>('mod-auto-installed', (event) => {
      const { mod_name, file_name, replaced, preserved_configs } = event.payload;
      if (replaced) {
        toast.success(`Updated "${replaced}" → "${mod_name}" from ${file_name}`);
      } else {
        toast.success(`Mod "${mod_name}" auto-installed from ${file_name}`);
      }
      // Preserved-configs toast fires as its own event for non-watcher
      // updates (update_mod / update_all_mods). The watcher inlines the
      // list on the auto-installed event, so emit the toast here.
      if (preserved_configs && preserved_configs.length > 0) {
        toast.info(formatPreservedConfigsMessage(mod_name, preserved_configs));
      }
      refreshAll();
    });
    const unlisten2 = listen<{ file_name: string; error: string }>('mod-auto-install-failed', (event) => {
      toast.error(`Failed to install ${event.payload.file_name}: ${event.payload.error}`);
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
        ? `Skipped 1 mod: ${skipped[0].mod_name} needs game v${skipped[0].min_game_version} (you have v${skipped[0].user_game_version || '?'}).`
        : `Skipped ${skipped.length} mods (need a newer game build than yours): ${skipped.map((s) => s.mod_name).join(', ')}.`;
      toast.info(`Modpack "${profile_name}" applied. ${summary}`);
    });
    return () => {
      unlisten1.then(f => f());
      unlisten2.then(f => f());
      unlisten3.then(f => f());
      unlistenPreserve.then(f => f());
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
  const subUpdatesRef = useRef(subUpdates);
  useEffect(() => { activeProfileRef.current = activeProfile; }, [activeProfile]);
  useEffect(() => { subUpdatesRef.current = subUpdates; }, [subUpdates]);

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
          subUpdates: subUpdatesRef.current,
        });
        if (outcome.kind === 'cancelled') return;

        await refreshAll();
        refreshSubUpdates();

        if (outcome.kind === 'installed') {
          toast.success(
            `Installed modpack "${outcome.profile.name}" — ${outcome.profile.mods.length} mods. You're subscribed for updates!`,
          );
        } else if (outcome.kind === 'activated') {
          toast.success(`Switched to "${outcome.profileName}"`);
        } else if (outcome.kind === 'reapplied') {
          const parts: string[] = [];
          if (outcome.result.downloaded > 0) parts.push(`${outcome.result.downloaded} downloaded`);
          if (outcome.result.failed_downloads.length > 0) parts.push(`${outcome.result.failed_downloads.length} failed`);
          if (outcome.result.missing_mods.length > 0) parts.push(`${outcome.result.missing_mods.length} still missing`);
          toast.info(parts.length ? `Re-applied "${outcome.profileName}" - ${parts.join(', ')}.` : `Re-applied "${outcome.profileName}".`);
        } else if (outcome.kind === 'synced') {
          toast.success(`Synced "${outcome.profileName}" — you're up to date!`);
        } else if (outcome.kind === 'already-active') {
          toast.info(`You're already on "${outcome.profileName}".`);
        }
      } catch (e) {
        toast.error(`Couldn't open share link: ${e instanceof Error ? e.message : String(e)}`);
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

  // Check for app updates on launch and every 24 hours while the app is open
  useEffect(() => {
    function doCheck() {
      check()
        .then((update) => {
          if (update) setAppUpdate(update);
        })
        .catch((e) => {
          console.warn('Update check failed:', e);
        });
    }

    doCheck();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const interval = setInterval(doCheck, ONE_DAY_MS);
    return () => clearInterval(interval);
  }, []);

  const RELEASES_URL = 'https://github.com/MohamedSerhan/sts2-mod-manager/releases/latest';

  async function handleInstallUpdate() {
    if (!appUpdate || updateInstalling) return;
    setUpdateInstalling(true);
    try {
      await appUpdate.downloadAndInstall();
      toast.success('Update installed. Restarting...');
      await relaunch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(
        `Update failed: ${msg}. If you installed via .deb or .rpm, use the AppImage build for seamless updates, or click Download to get the new package manually.`
      );
      setUpdateInstalling(false);
    }
  }

  async function handleDownloadUpdate() {
    try {
      await openExternalUrl(RELEASES_URL);
    } catch (e) {
      toast.error(`Failed to open browser: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const enabledCount = mods.filter((m) => m.enabled).length;
  const totalCount = mods.length;

  async function handleLaunchGame() {
    if (launching) return;
    setLaunching('modded');
    try {
      await launchGame();
      toast.success('Launching STS2 via Steam (auto-backup created)...');
      // Keep the spinner up briefly so the user sees the transition;
      // hide once the Steam launcher takes over the foreground.
      setTimeout(() => { setLaunching(null); refreshAll(); }, 2500);
    } catch (e) {
      setLaunching(null);
      toast.error(`Failed to launch game: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleLaunchVanilla() {
    if (launching) return;
    setLaunching('vanilla');
    try {
      await launchVanilla();
      toast.success('Launching STS2 in vanilla mode (all mods disabled, backup created)...');
      await refreshAll();
      setTimeout(() => setLaunching(null), 2500);
    } catch (e) {
      setLaunching(null);
      toast.error(`Failed to launch: ${e instanceof Error ? e.message : String(e)}`);
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
        if (!gameRunning && !launching) handleLaunchGame();
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showOnboarding, gameRunning, launching]);

  // Drag-and-drop zip import
  useEffect(() => {
    function handleDragOver(e: DragEvent) {
      e.preventDefault();
      if (e.dataTransfer?.types.includes('Files')) {
        setDragOver(true);
      }
    }
    function handleDragLeave(e: DragEvent) {
      e.preventDefault();
      setDragOver(false);
    }
    async function handleDrop(e: DragEvent) {
      e.preventDefault();
      setDragOver(false);
      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      for (const file of Array.from(files)) {
        const lower = file.name.toLowerCase();
        const isSupportedArchive =
          lower.endsWith('.zip') || lower.endsWith('.7z') || lower.endsWith('.rar');
        if (isSupportedArchive) {
          try {
            // @ts-expect-error -- Tauri exposes file.path on dropped files
            const filePath = file.path as string;
            if (filePath) {
              const mod = await installModFromFile(filePath);
              toast.success(`Installed mod: ${mod.name}`);
              await refreshAll();
            }
          } catch (err) {
            toast.error(`Failed to install ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          toast.error(`Unsupported file: ${file.name}. Use .zip, .7z, or .rar.`);
        }
      }
    }

    document.addEventListener('dragover', handleDragOver);
    document.addEventListener('dragleave', handleDragLeave);
    document.addEventListener('drop', handleDrop);
    return () => {
      document.removeEventListener('dragover', handleDragOver);
      document.removeEventListener('dragleave', handleDragLeave);
      document.removeEventListener('drop', handleDrop);
    };
  }, [refreshAll, toast]);

  const profileInitials = (activeProfile || 'Vanilla')
    .split(/[\s_-]+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  function handleExternalAnchorClick(event: MouseEvent<HTMLDivElement>) {
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

    event.preventDefault();
    openExternalUrl(url.href).catch((e) => {
      toast.error(`Failed to open link: ${e instanceof Error ? e.message : String(e)}`);
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
          <span className="gf-titlebar-title" data-tauri-drag-region>STS2 Mod Manager</span>
        </div>
        <div className="gf-titlebar-controls">
          <button className="gf-titlebar-btn" title="Minimize" onClick={handleTitlebarMin}>
            <Minus size={12} />
          </button>
          <button className="gf-titlebar-btn" title="Maximize" onClick={handleTitlebarMax}>
            <Square size={10} />
          </button>
          <button className="gf-titlebar-btn gf-titlebar-close" title="Close" onClick={handleTitlebarClose}>
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
              <div className="gf-dropzone-title">Drop to install</div>
              <div className="gf-dropzone-sub">.zip — we'll detect the source for you</div>
            </div>
          </div>
        )}

        {/* Sidebar — 4 main nav, foot has Tutorial+Settings, status block, version */}
        <nav className="gf-sidebar">
          <div className="gf-brand">
            <div className="gf-brand-mark">✦</div>
            <span className="gf-brand-title">
              <span className="gf-brand-game">Slay the Spire 2</span>
              <span className="gf-brand-tag">Mod Manager</span>
            </span>
          </div>

          {NAV.map(({ id, label, icon: Icon }) => {
            // Profiles gets a count badge when followed packs have
            // pending updates — same data the Home view's "update
            // available" cards consume, lifted to AppContext so the
            // sidebar can read it from anywhere.
            const badge = id === 'profiles' && subUpdates.length > 0 ? subUpdates.length : null;
            return (
              <button
                key={id}
                onClick={() => setActiveView(id)}
                className={cn('gf-nav', activeView === id && 'active')}
              >
                <Icon size={14} className="gf-nav-icon" />
                <span className="gf-nav-label">{label}</span>
                {id === 'browse-modpacks' && (
                  <Badge
                    variant="beta"
                    className="gf-nav-beta"
                    title="The public modpack browser is still being tuned."
                    ariaHidden
                  >
                    Beta
                  </Badge>
                )}
                {badge !== null && (
                  <span className="gf-nav-badge" title={`${badge} pack${badge === 1 ? '' : 's'} ${badge === 1 ? 'has' : 'have'} an update available`}>
                    {badge}
                  </span>
                )}
              </button>
            );
          })}

          <div className="gf-side-foot">
            {FOOT_NAV.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setActiveView(id)}
                className={cn('gf-nav', activeView === id && 'active')}
              >
                <Icon size={14} className="gf-nav-icon" />
                <span>{label}</span>
              </button>
            ))}

            {/* Status block */}
            <div className="gf-side-status">
              <div className="gf-side-stat-row">
                <span className={cn('gf-side-stat-dot', !gameInfo?.valid && 'err')} />
                <span className="gf-side-stat-label">
                  {gameInfo?.valid ? 'STS2 detected' : 'Game not found'}
                </span>
              </div>
              {gameInfo?.valid && (
                <div className="gf-side-stat-meta">
                  {enabledCount} active / {totalCount} mods
                </div>
              )}
              {appVersion && <div className="gf-side-version">v{appVersion}</div>}
            </div>
          </div>
        </nav>

        {/* Main column: top bar + content */}
        <div className="flex-1 min-w-0 flex flex-col">
          {/* Top bar — profile chip + Vanilla + Launch */}
          <div className="gf-top">
            <div style={{ position: 'relative' }}>
              <button
                className="gf-prof"
                onClick={() => setShowProfileSwitcher((v) => !v)}
                title="Switch active pack"
              >
                <div className="gf-prof-avatar">{profileInitials || 'VA'}</div>
                <div className="gf-prof-text">
                  <span className="gf-prof-eyebrow">Active Profile</span>
                  <span className="gf-prof-name">{activeProfile || 'Vanilla'}</span>
                </div>
                <span className="gf-prof-meta">
                  {enabledCount} active / {totalCount} mods
                </span>
                <ChevronDown
                  size={14}
                  style={{
                    opacity: 0.4,
                    marginLeft: 4,
                    transform: showProfileSwitcher ? 'rotate(180deg)' : undefined,
                    transition: 'transform 0.15s',
                  }}
                />
              </button>
              {showProfileSwitcher && (
                <ProfileSwitcher
                  onClose={() => setShowProfileSwitcher(false)}
                  onAddPack={() => {
                    setActiveView('home');
                    setFocusCodeBarSignal((n) => n + 1);
                  }}
                  onManageAll={() => setActiveView('profiles')}
                />
              )}
            </div>

            <div className="flex gap-1.5">
              <button
                onClick={handleLaunchVanilla}
                disabled={gameRunning}
                title={
                  gameRunning
                    ? 'Close STS2 first'
                    : 'Launches Slay the Spire 2 with all mods temporarily disabled (auto-backup first).'
                }
                className="gf-btn-2 gf-btn-2-sm"
              >
                <Play size={11} /> Vanilla — no mods
              </button>
              <button
                onClick={handleLaunchGame}
                disabled={gameRunning}
                title={
                  gameRunning
                    ? 'Close STS2 first'
                    : `Launch Slay the Spire 2 with ${activeProfile || 'no active profile'}`
                }
                className="gf-btn"
              >
                <Play size={12} fill="currentColor" />
                <span className="gf-launch-label">
                  Launch{activeProfile ? <> · <span className="gf-launch-prof">{activeProfile}</span></> : ''}
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
                  <div style={{ fontWeight: 600 }}>Slay the Spire 2 is running</div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                    Mod and profile changes are paused until the game closes — touching files now can crash the game.
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
                      ? `Installing v${appUpdate.version}...`
                      : `Mod Manager v${appUpdate.version} is available`}
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.8 }}>
                    {updateInstalling
                      ? 'The app will restart when this finishes.'
                      : `You're on v${appUpdate.currentVersion}.`}
                  </div>
                </div>
                <button
                  onClick={() => setUpdateDismissed(true)}
                  disabled={updateInstalling}
                  className="gf-btn-3"
                >
                  Dismiss
                </button>
                <button
                  onClick={handleDownloadUpdate}
                  disabled={updateInstalling}
                  title="Open GitHub releases page to download manually"
                  className="gf-btn-3"
                >
                  <ExternalLink size={11} /> Download
                </button>
                <button
                  onClick={handleInstallUpdate}
                  disabled={updateInstalling}
                  className="gf-btn gf-btn-sm"
                >
                  {updateInstalling ? 'Installing...' : 'Install & Restart'}
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
                onSwitchPack={() => setShowProfileSwitcher(true)}
                onLaunch={handleLaunchGame}
                focusCodeBarSignal={focusCodeBarSignal}
              />
            )}
            {activeView === 'profiles' && <ProfilesView onGoToSettings={() => setActiveView('settings')} />}
            {activeView === 'mods' && <ModsView />}
            {activeView === 'browse-mods' && <BrowseView onGoToSettings={() => setActiveView('settings')} />}
            {activeView === 'browse-modpacks' && (
              <BrowseModpacksView onGoToProfiles={() => setActiveView('profiles')} />
            )}
            {activeView === 'tutorial' && <TutorialView onGoToSettings={() => setActiveView('settings')} />}
            {activeView === 'settings' && <SettingsView />}

            {/* First-launch onboarding wizard (v5 batch 4) */}
            {showOnboarding && (
              <OnboardingOverlay
                gameInfo={gameInfo}
                onSkip={dismissOnboarding}
                onComplete={dismissOnboarding}
                onAddCode={() => setActiveView('home')}
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
          </main>
        </div>
      </div>
    </div>
  );
}
