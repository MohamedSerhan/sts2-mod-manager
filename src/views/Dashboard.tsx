import { Package, Layers, Gamepad2, Clock, ArrowUpCircle } from 'lucide-react';
import { Card } from '../components/Card';

const stats = [
  { label: 'Installed Mods', value: '0', icon: Package, color: 'text-primary' },
  { label: 'Active Profile', value: 'Default', icon: Layers, color: 'text-accent' },
  { label: 'Game Version', value: 'Unknown', icon: Gamepad2, color: 'text-success' },
];

export function DashboardView() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-bold text-text">Dashboard</h2>
        <p className="text-sm text-text-muted mt-1">Overview of your mod setup</p>
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-3 gap-4">
        {stats.map(({ label, value, icon: Icon, color }) => (
          <Card key={label} className="flex items-center gap-4">
            <div className={`p-2.5 rounded-lg bg-surface-hover ${color}`}>
              <Icon size={22} />
            </div>
            <div>
              <p className="text-xs text-text-muted">{label}</p>
              <p className="text-lg font-semibold text-text">{value}</p>
            </div>
          </Card>
        ))}
      </div>

      {/* Recent Activity */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <Clock size={18} className="text-text-muted" />
          <h3 className="text-sm font-semibold text-text">Recent Activity</h3>
        </div>
        <div className="flex flex-col items-center justify-center py-8 text-text-dim">
          <Clock size={32} className="mb-2 opacity-40" />
          <p className="text-sm">No recent activity</p>
          <p className="text-xs mt-1">Install or update mods to see activity here</p>
        </div>
      </Card>

      {/* Updates Available */}
      <Card>
        <div className="flex items-center gap-2 mb-4">
          <ArrowUpCircle size={18} className="text-text-muted" />
          <h3 className="text-sm font-semibold text-text">Updates Available</h3>
        </div>
        <div className="flex flex-col items-center justify-center py-8 text-text-dim">
          <ArrowUpCircle size={32} className="mb-2 opacity-40" />
          <p className="text-sm">No updates available</p>
          <p className="text-xs mt-1">All mods are up to date</p>
        </div>
      </Card>
    </div>
  );
}
