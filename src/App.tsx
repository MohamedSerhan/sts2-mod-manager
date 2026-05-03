import { useState } from 'react';
import { LayoutDashboard, Package, Search, Layers, Settings } from 'lucide-react';
import { cn } from './lib/utils';
import { DashboardView } from './views/Dashboard';
import { ModsView } from './views/Mods';
import { BrowseView } from './views/Browse';
import { ProfilesView } from './views/Profiles';
import { SettingsView } from './views/Settings';

type View = 'dashboard' | 'mods' | 'browse' | 'profiles' | 'settings';

const NAV_ITEMS: { id: View; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'mods', label: 'Mods', icon: Package },
  { id: 'browse', label: 'Browse', icon: Search },
  { id: 'profiles', label: 'Profiles', icon: Layers },
  { id: 'settings', label: 'Settings', icon: Settings },
];

export default function App() {
  const [activeView, setActiveView] = useState<View>('dashboard');

  return (
    <div className="flex h-screen w-screen overflow-hidden">
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
        {/* Status bar at bottom of sidebar */}
        <div className="p-3 border-t border-border text-xs text-text-dim">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-success" />
            Game detected
          </div>
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
