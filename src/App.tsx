import { useState, useEffect } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { listen } from '@tauri-apps/api/event';
import { Home, LayoutDashboard, Package, Search, Layers, Settings, Play, ChevronRight, Wrench, GraduationCap, ExternalLink } from 'lucide-react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { openUrl } from '@tauri-apps/plugin-opener';
import { relaunch } from '@tauri-apps/plugin-process';
import { cn } from './lib/utils';
import { ToastProvider, useToast } from './contexts/ToastContext';
import { AppProvider, useApp } from './contexts/AppContext';
import { HomeView } from './views/Home';
import { DashboardView } from './views/Dashboard';
import { ModsView } from './views/Mods';
import { BrowseView } from './views/Browse';
import { ProfilesView } from './views/Profiles';
import { SettingsView } from './views/Settings';
import { TutorialView } from './views/Tutorial';
import { launchGame, launchVanilla, installModFromFile } from './hooks/useTauri';

type View = 'home' | 'dashboard' | 'mods' | 'browse' | 'profiles' | 'tutorial' | 'settings';

const SIMPLE_NAV: { id: View; label: string; icon: typeof Home }[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'mods', label: 'My Mods', icon: Package },
  { id: 'tutorial', label: 'Tutorial', icon: GraduationCap },
  { id: 'settings', label: 'Settings', icon: Settings },
];

const ADVANCED_NAV: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'mods', label: 'Mods', icon: Package },
  { id: 'browse', label: 'Browse', icon: Search },
  { id: 'profiles', label: 'Profiles', icon: Layers },
  { id: 'tutorial', label: 'Tutorial', icon: GraduationCap },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function App() {
  return (
    <ToastProvider>
      <AppProvider>
        <AppInner />
      </AppProvider>
    </ToastProvider>
  );
}

function AppInner() {
  const [activeView, setActiveView] = useState<View>('home');
  const [advancedMode, setAdvancedMode] = useState(() => {
    try {
      return localStorage.getItem('sts2mm-advanced-mode') === 'true';
    } catch {
      return false;
    }
  });
  const { gameInfo, mods, refreshAll, activeProfile } = useApp();
  const toast = useToast();
  const [dragOver, setDragOver] = useState(false);
  const [appUpdate, setAppUpdate] = useState<Update | null>(null);
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const [updateInstalling, setUpdateInstalling] = useState(false);
  const [appVersion, setAppVersion] = useState('');

  useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);

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
      // Seamless in-app updates only work when running the AppImage build.
      // .deb and .rpm installs require pkexec/sudo elevation which is
      // unreliable (Wayland, non-sudo users, polkit misconfigurations).
      // In those cases the install attempt fails here — guide the user to
      // download the AppImage (or the new .deb/.rpm) manually instead.
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

  function toggleAdvancedMode() {
    const next = !advancedMode;
    setAdvancedMode(next);
    try {
      localStorage.setItem('sts2mm-advanced-mode', String(next));
    } catch { /* ignore */ }
    if (!next && !['home', 'mods', 'tutorial', 'settings'].includes(activeView)) {
      setActiveView('home');
    }
  }

  async function handleLaunchGame() {
    try {
      await launchGame();
      toast.success('Launching STS2 via Steam (auto-backup created)...');
      setTimeout(() => refreshAll(), 1000);
    } catch (e) {
      toast.error(`Failed to launch game: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleLaunchVanilla() {
    try {
      await launchVanilla();
      toast.success('Launching STS2 in vanilla mode (all mods disabled, backup created)...');
      await refreshAll();
    } catch (e) {
      toast.error(`Failed to launch: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

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

  const navItems = advancedMode ? ADVANCED_NAV : SIMPLE_NAV;

  return (
    <div className="flex h-screen w-screen overflow-hidden relative">
      {/* Drag-and-drop overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-30 bg-primary/10 border-2 border-dashed border-primary rounded-xl flex items-center justify-center">
          <div className="text-center">
            <Package size={48} className="mx-auto mb-3 text-primary" />
            <p className="text-lg font-semibold text-primary">Drop .zip to install mod</p>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <nav className="w-[240px] flex-shrink-0 bg-surface border-r border-border flex flex-col">
        <div className="px-5 py-5 border-b border-border">
          <h1 className="text-lg font-bold text-text tracking-tight">STS2 Mod Manager</h1>
          {appVersion && <p className="text-xs text-text-dim mt-1">v{appVersion}</p>}
        </div>

        <div className="flex-1 py-3 px-2">
          {navItems.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveView(id)}
              className={cn(
                'w-full flex items-center gap-3 px-4 py-3 text-sm rounded-lg mb-0.5 transition-colors',
                activeView === id
                  ? 'bg-primary/10 text-primary font-medium'
                  : 'text-text-muted hover:bg-surface-hover hover:text-text'
              )}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </div>

        {/* Advanced Mode Toggle */}
        <div className="px-3 pb-2">
          <button
            onClick={toggleAdvancedMode}
            className={cn(
              'w-full flex items-center gap-2 px-4 py-2.5 rounded-lg text-xs font-medium transition-colors',
              advancedMode
                ? 'bg-primary/10 text-primary border border-primary/30'
                : 'text-text-dim hover:text-text hover:bg-surface-hover border border-transparent'
            )}
          >
            <Wrench size={14} />
            <span className="flex-1 text-left">Advanced Mode</span>
            <ChevronRight size={12} className={cn('transition-transform', advancedMode && 'rotate-90')} />
          </button>
        </div>

        {/* Launch Game Buttons */}
        <div className="px-3 pb-3 space-y-1.5">
          <button
            onClick={handleLaunchGame}
            className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-semibold transition-colors shadow-lg shadow-green-600/20"
          >
            <Play size={16} />
            {activeProfile ? `Launch STS2 (${activeProfile})` : 'Launch STS2'}
          </button>
          <button
            onClick={handleLaunchVanilla}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg bg-surface-hover hover:bg-yellow-600/20 text-text-muted text-xs font-medium transition-colors border border-border"
          >
            Launch Vanilla (no mods)
          </button>
        </div>

        {/* Status bar */}
        <div className="px-4 py-3 border-t border-border text-xs text-text-dim space-y-1.5">
          <div className="flex items-center gap-2">
            <div className={cn(
              'w-2 h-2 rounded-full',
              gameInfo?.valid ? 'bg-green-500' : 'bg-red-500'
            )} />
            <span>{gameInfo?.valid ? 'Game detected' : 'Game not detected'}</span>
          </div>
          {gameInfo?.valid && (
            <div className="pl-4 text-text-dim">
              {enabledCount} active / {totalCount} total mods
            </div>
          )}
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 overflow-auto bg-background">
        {/* App Update Banner */}
        {appUpdate && !updateDismissed && (
          <div className="bg-blue-600/90 text-white px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-sm font-medium">
                {updateInstalling
                  ? `Installing v${appUpdate.version}...`
                  : `Update available: v${appUpdate.version} (you have v${appUpdate.currentVersion})`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleInstallUpdate}
                disabled={updateInstalling}
                className="px-3 py-1 bg-white text-blue-600 rounded text-xs font-semibold hover:bg-blue-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {updateInstalling ? 'Installing...' : 'Install & Restart'}
              </button>
              <button
                onClick={handleDownloadUpdate}
                disabled={updateInstalling}
                title="Open GitHub releases page to download manually"
                className="flex items-center gap-1 px-3 py-1 bg-white/20 hover:bg-white/30 text-white rounded text-xs font-semibold transition-colors disabled:opacity-50"
              >
                <ExternalLink size={11} />
                Download
              </button>
              <button
                onClick={() => setUpdateDismissed(true)}
                disabled={updateInstalling}
                className="px-2 py-1 text-white/70 hover:text-white text-xs transition-colors disabled:opacity-50"
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        {activeView === 'home' && <HomeView onGoToSettings={() => setActiveView('settings')} />}
        {activeView === 'dashboard' && <DashboardView />}
        {activeView === 'mods' && <ModsView advancedMode={advancedMode} />}
        {activeView === 'browse' && <BrowseView onGoToSettings={() => setActiveView('settings')} />}
        {activeView === 'profiles' && <ProfilesView />}
        {activeView === 'tutorial' && <TutorialView advancedMode={advancedMode} onGoToSettings={() => setActiveView('settings')} />}
        {activeView === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}
