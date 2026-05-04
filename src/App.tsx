import { useState, useEffect } from 'react';
import { LayoutDashboard, Package, Search, Layers, Settings, Play } from 'lucide-react';
import { cn } from './lib/utils';
import { ToastProvider, useToast } from './contexts/ToastContext';
import { AppProvider, useApp } from './contexts/AppContext';
import { DashboardView } from './views/Dashboard';
import { ModsView } from './views/Mods';
import { BrowseView } from './views/Browse';
import { ProfilesView } from './views/Profiles';
import { SettingsView } from './views/Settings';
import { launchGame, launchVanilla, installModFromFile } from './hooks/useTauri';

type View = 'dashboard' | 'mods' | 'browse' | 'profiles' | 'settings';

const NAV_ITEMS: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'mods', label: 'Mods', icon: Package },
  { id: 'browse', label: 'Browse', icon: Search },
  { id: 'profiles', label: 'Profiles', icon: Layers },
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
  const [activeView, setActiveView] = useState<View>('dashboard');
  const { gameInfo, mods, refreshAll } = useApp();
  const toast = useToast();
  const [dragOver, setDragOver] = useState(false);

  const enabledCount = mods.filter((m) => m.enabled).length;
  const totalCount = mods.length;

  async function handleLaunchGame() {
    try {
      await launchGame();
      toast.success('Launching STS2 via Steam (auto-backup created)...');
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

  return (
    <div className="flex h-screen w-screen overflow-hidden relative">
      {/* Drag-and-drop overlay */}
      {dragOver && (
        <div className="absolute inset-0 z-30 bg-primary/10 border-2 border-dashed border-primary rounded-lg flex items-center justify-center">
          <div className="text-center">
            <Package size={48} className="mx-auto mb-2 text-primary" />
            <p className="text-lg font-semibold text-primary">Drop .zip to install mod</p>
          </div>
        </div>
      )}

      {/* Sidebar */}
      <nav className="w-[220px] flex-shrink-0 bg-surface border-r border-border flex flex-col">
        <div className="p-4 border-b border-border">
          <h1 className="text-lg font-bold text-text">STS2 Mod Manager</h1>
          <p className="text-xs text-text-dim mt-0.5">v0.1.0</p>
        </div>
        <div className="flex-1 py-2">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setActiveView(id)}
              className={cn(
                'w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors',
                activeView === id
                  ? 'bg-primary/10 text-primary border-r-2 border-primary'
                  : 'text-text-muted hover:bg-surface-hover hover:text-text'
              )}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </div>
        {/* Launch Game Buttons */}
        <div className="px-3 pb-2 space-y-1">
          <button
            onClick={handleLaunchGame}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium transition-colors"
          >
            <Play size={16} />
            Launch STS2
          </button>
          <button
            onClick={handleLaunchVanilla}
            className="w-full flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg bg-surface-hover hover:bg-yellow-600/20 text-text-muted text-xs font-medium transition-colors border border-border"
          >
            Launch Vanilla (no mods)
          </button>
        </div>
        {/* Status bar at bottom of sidebar */}
        <div className="p-3 border-t border-border text-xs text-text-dim space-y-1">
          <div className="flex items-center gap-1.5">
            <div className={cn(
              'w-2 h-2 rounded-full',
              gameInfo?.valid ? 'bg-green-500' : 'bg-red-500'
            )} />
            {gameInfo?.valid ? 'Game detected' : 'Game not detected'}
          </div>
          {gameInfo?.valid && (
            <div className="text-text-dim pl-3.5">
              {enabledCount} active / {totalCount} total mods
            </div>
          )}
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 overflow-auto bg-background">
        {activeView === 'dashboard' && <DashboardView />}
        {activeView === 'mods' && <ModsView />}
        {activeView === 'browse' && <BrowseView />}
        {activeView === 'profiles' && <ProfilesView />}
        {activeView === 'settings' && <SettingsView />}
      </main>
    </div>
  );
}
