import { useState, useEffect, type MouseEvent } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Home,
  Package,
  Search,
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
import { openUrl } from '@tauri-apps/plugin-opener';
import { relaunch } from '@tauri-apps/plugin-process';
import { cn } from './lib/utils';
import { ToastProvider, useToast } from './contexts/ToastContext';
import { AppProvider, useApp } from './contexts/AppContext';
import { ConfirmProvider } from './components/ConfirmDialog';
import { OnboardingOverlay } from './components/OnboardingOverlay';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { LaunchSpinner } from './components/LaunchSpinner';
import { ProfileSwitcher } from './components/ProfileSwitcher';
import { HomeView } from './views/Home';
import { ModsView } from './views/Mods';
import { BrowseView } from './views/Browse';
import { ProfilesView } from './views/Profiles';
import { SettingsView } from './views/Settings';
import { TutorialView } from './views/Tutorial';
import { launchGame, launchVanilla, installModFromFile } from './hooks/useTauri';

type View = 'home' | 'profiles' | 'mods' | 'browse' | 'tutorial' | 'settings';
type ResizeDirection = 'East' | 'North' | 'NorthEast' | 'NorthWest' | 'South' | 'SouthEast' | 'SouthWest' | 'West';

// v5 IA — 4 main nav items, Tutorial+Settings in the foot. Backups absorbed
// into Settings as a tab. Dashboard cut (was redundant with Home).
const NAV: { id: View; label: string; icon: typeof Home }[] = [
  { id: 'home',     label: 'Home',     icon: Home },
  { id: 'profiles', label: 'Profiles', icon: Layers },
  { id: 'mods',     label: 'Mods',     icon: Package },
  { id: 'browse',   label: 'Browse',   icon: Search },
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

function AppInner() {
  const [activeView, setActiveView] = useState<View>('home');
  const { gameInfo, mods, refreshAll, activeProfile, gameRunning } = useApp();
  const toast = useToast();
  const [dragOver, setDragOver] = useState(false);
  const [appUpdate, setAppUpdate] = useState<Update | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [appVersion, setAppVersion] = useState('');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showShortcuts, setShowShortcuts] = useState(false);
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
    const unlisten1 = listen<{ mod_name: string; file_name: string; replaced: string | null }>('mod-auto-installed', (event) => {
      const { mod_name, file_name, replaced } = event.payload;
      if (replaced) {
        toast.success(`Updated "${replaced}" → "${mod_name}" from ${file_name}`);
      } else {
        toast.success(`Mod "${mod_name}" auto-installed from ${file_name}`);
      }
      refreshAll();
    });
    const unlisten2 = listen<{ file_name: string; error: string }>('mod-auto-install-failed', (event) => {
      toast.error(`Failed to install ${event.payload.file_name}: ${event.payload.error}`);
    });
    return () => { unlisten1.then(f => f()); unlisten2.then(f => f()); };
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
      await openUrl(RELEASES_URL);
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

  // Global keyboard shortcuts (v5 batch 4 — see ShortcutsOverlay for the
  // canonical map). Only fires when no input/textarea is focused.
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
      // Help / shortcuts
      if (e.key === '?' || (e.shiftKey && e.key === '/')) {
        e.preventDefault(); setShowShortcuts((v) => !v); return;
      }
      if (e.key === 'Escape' && showShortcuts) {
        e.preventDefault(); setShowShortcuts(false); return;
      }
      // Navigation 1-4
      if (!mod && !e.shiftKey && !e.altKey) {
        if (e.key === '1') { e.preventDefault(); setActiveView('home'); return; }
        if (e.key === '2') { e.preventDefault(); setActiveView('profiles'); return; }
        if (e.key === '3') { e.preventDefault(); setActiveView('mods'); return; }
        if (e.key === '4') { e.preventDefault(); setActiveView('browse'); return; }
        if (e.key === '/') {
          // Focus the first search input on the active view.
          const search = document.querySelector<HTMLInputElement>('.gf-search input');
          if (search) { e.preventDefault(); search.focus(); }
          return;
        }
      }
      // Mod-key shortcuts
      if (mod && (e.key === ',' || e.key === ',')) {
        e.preventDefault(); setActiveView('settings'); return;
      }
      if (mod && (e.key === 'l' || e.key === 'L')) {
        e.preventDefault();
        if (!gameRunning && !launching) handleLaunchGame();
        return;
      }
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showOnboarding, showShortcuts, gameRunning, launching]);

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
        if (file.name.endsWith('.zip')) {
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
          toast.error(`Unsupported file: ${file.name}. Only .zip files are supported.`);
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

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden relative">
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
            <span>STS2 Mods</span>
          </div>

          {NAV.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveView(id)}
              className={cn('gf-nav', activeView === id && 'active')}
            >
              <Icon size={14} className="gf-nav-icon" />
              <span>{label}</span>
            </button>
          ))}

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
                title={gameRunning ? 'Close STS2 first' : 'Launch the game without any mods (vanilla)'}
                className="gf-btn-2 gf-btn-2-sm"
              >
                <Play size={11} /> Vanilla
              </button>
              <button
                onClick={handleLaunchGame}
                disabled={gameRunning}
                title={gameRunning ? 'Close STS2 first' : 'Launch STS2 with the active profile'}
                className="gf-btn"
              >
                <Play size={12} />
                Launch STS2
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
            {activeView === 'profiles' && <ProfilesView />}
            {activeView === 'mods' && <ModsView />}
            {activeView === 'browse' && <BrowseView onGoToSettings={() => setActiveView('settings')} />}
            {activeView === 'tutorial' && <TutorialView advancedMode={false} onGoToSettings={() => setActiveView('settings')} />}
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

            {/* Keyboard shortcuts overlay (? to open) */}
            {showShortcuts && (
              <ShortcutsOverlay onClose={() => setShowShortcuts(false)} />
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
