import { useState, useEffect } from 'react';
import {
  Download,
  Package,
  RefreshCw,
  CheckCircle2,
  Users,
  Clipboard,
  Gamepad2,
  Settings,
} from 'lucide-react';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import {
  installSharedProfile,
  checkSubscriptionUpdates,
  applySubscriptionUpdate,
  toggleMod,
  getSubscriptions,
} from '../hooks/useTauri';
import type { SubscriptionUpdate, Subscription } from '../types';

export function HomeView({ onGoToSettings }: { onGoToSettings: () => void }) {
  const { gameInfo, mods, refreshAll, refreshMods } = useApp();
  const toast = useToast();
  const [profileCode, setProfileCode] = useState('');
  const [importing, setImporting] = useState(false);
  const [subUpdates, setSubUpdates] = useState<SubscriptionUpdate[]>([]);
  const [applyingSub, setApplyingSub] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    loadSubscriptions();
    checkSubs();
  }, []);

  async function loadSubscriptions() {
    try {
      const subs = await getSubscriptions();
      setSubscriptions(subs);
    } catch { /* ignore */ }
  }

  async function checkSubs(showToast = false) {
    try {
      setChecking(true);
      const u = await checkSubscriptionUpdates();
      const updates = u.filter((s) => s.has_update);
      setSubUpdates(updates);
      if (showToast && updates.length === 0) {
        toast.success('All modpacks are up to date!');
      }
    } catch (e) {
      if (showToast) toast.error(`Check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setChecking(false);
    }
  }

  async function handleImportCode() {
    const code = profileCode.trim();
    if (!code) return;
    try {
      setImporting(true);
      const profile = await installSharedProfile(code);
      await refreshAll();
      await loadSubscriptions();
      toast.success(`Installed modpack "${profile.name}" with ${profile.mods.length} mods!`);
      setProfileCode('');
    } catch (e) {
      toast.error(`Failed to import: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  }

  async function handleApplySubUpdate(shareId: string) {
    try {
      setApplyingSub(shareId);
      const profile = await applySubscriptionUpdate(shareId);
      await refreshAll();
      setSubUpdates((prev) => prev.filter((s) => s.share_id !== shareId));
      toast.success(`Synced modpack "${profile.name}" - you're up to date!`);
    } catch (e) {
      toast.error(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApplyingSub(null);
    }
  }

  async function handleToggle(name: string, enable: boolean) {
    try {
      await toggleMod(name, enable);
      await refreshMods();
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const enabledMods = mods.filter((m) => m.enabled);
  const disabledMods = mods.filter((m) => !m.enabled);

  return (
    <div className="p-6 space-y-6 max-w-3xl mx-auto">
      {/* Welcome Header */}
      <div className="text-center pt-4 pb-2">
        <h2 className="text-3xl font-bold text-text">STS2 Mod Manager</h2>
        <p className="text-sm text-text-muted mt-2">
          Get set up with mods in seconds
        </p>
      </div>

      {/* Game not detected warning */}
      {!gameInfo?.valid && (
        <Card className="bg-red-500/10 border-red-500/30">
          <div className="flex items-center gap-3">
            <Gamepad2 size={20} className="text-red-400" />
            <div className="flex-1">
              <p className="text-sm font-medium text-red-400">Game Not Detected</p>
              <p className="text-xs text-text-dim mt-0.5">
                Slay the Spire 2 wasn't found automatically. Click Settings to set the path.
              </p>
            </div>
            <Button variant="secondary" size="sm" onClick={onGoToSettings}>
              <Settings size={14} />
              Settings
            </Button>
          </div>
        </Card>
      )}

      {/* Step 1: Enter Profile Code */}
      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/20 text-primary text-sm font-bold">
            1
          </div>
          <h3 className="text-sm font-semibold text-text">
            {subscriptions.length > 0 ? 'Import Another Modpack' : 'Enter Modpack Code'}
          </h3>
        </div>
        <p className="text-xs text-text-dim pl-9">
          Got a code from a friend? Paste it below to install their modpack instantly.
        </p>
        <div className="flex gap-2 pl-9">
          <div className="relative flex-1">
            <Clipboard size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-text-dim" />
            <input
              type="text"
              value={profileCode}
              onChange={(e) => setProfileCode(e.target.value)}
              placeholder="e.g. AA5A-315D-61AE"
              className="w-full bg-background border border-border rounded-lg pl-9 pr-3 py-2.5 text-sm text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono tracking-wider"
              onKeyDown={(e) => e.key === 'Enter' && handleImportCode()}
              disabled={importing}
            />
          </div>
          <Button onClick={handleImportCode} disabled={importing || !profileCode.trim()}>
            <Download size={14} />
            {importing ? 'Installing...' : 'Install'}
          </Button>
        </div>
      </Card>

      {/* Subscription Updates */}
      {subUpdates.length > 0 && (
        <Card className="bg-purple-500/10 border-purple-500/30 space-y-3">
          <div className="flex items-center gap-2">
            <Users size={18} className="text-purple-400" />
            <h3 className="text-sm font-semibold text-purple-400">
              Modpack Update{subUpdates.length !== 1 ? 's' : ''} Available
            </h3>
          </div>
          {subUpdates.map((sub) => (
            <div key={sub.share_id} className="bg-surface rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-text">{sub.profile_name}</p>
                  <p className="text-xs text-text-dim mt-0.5">
                    {sub.added_mods.length > 0 && (
                      <span className="text-green-400">+{sub.added_mods.length} new </span>
                    )}
                    {sub.updated_mods.length > 0 && (
                      <span className="text-blue-400">{sub.updated_mods.length} updated </span>
                    )}
                    {sub.removed_mods.length > 0 && (
                      <span className="text-red-400">-{sub.removed_mods.length} removed</span>
                    )}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={() => handleApplySubUpdate(sub.share_id)}
                  disabled={applyingSub === sub.share_id}
                >
                  {applyingSub === sub.share_id ? (
                    <RefreshCw size={14} className="animate-spin" />
                  ) : (
                    <Download size={14} />
                  )}
                  {applyingSub === sub.share_id ? 'Syncing...' : 'Update'}
                </Button>
              </div>
              <div className="text-xs text-text-dim mt-1 space-y-0.5">
                {sub.added_mods.length > 0 && <p>New: {sub.added_mods.join(', ')}</p>}
                {sub.updated_mods.length > 0 && (
                  <p>Updated: {sub.updated_mods.map((m) => `${m.name} (${m.old_version} ${'\u2192'} ${m.new_version})`).join(', ')}</p>
                )}
                {sub.removed_mods.length > 0 && <p>Removed: {sub.removed_mods.join(', ')}</p>}
              </div>
            </div>
          ))}
        </Card>
      )}

      {/* Subscribed Modpacks */}
      {subscriptions.length > 0 && subUpdates.length === 0 && (
        <Card className="space-y-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 size={18} className="text-green-400" />
            <h3 className="text-sm font-semibold text-text">Your Modpacks</h3>
            <span className="text-xs text-text-dim">(auto-synced)</span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => checkSubs(true)} disabled={checking}>
            <RefreshCw size={14} className={checking ? 'animate-spin' : ''} />
            {checking ? 'Checking...' : 'Check for Updates'}
          </Button>
          {subscriptions.map((sub) => (
            <div key={sub.share_id} className="flex items-center justify-between py-1.5 px-3 rounded-lg bg-surface-hover">
              <div>
                <p className="text-sm text-text">{sub.profile_name}</p>
                <p className="text-xs text-text-dim">
                  Last synced: {new Date(sub.last_synced).toLocaleDateString()}
                </p>
              </div>
              <span className="text-xs text-green-400">Up to date</span>
            </div>
          ))}
        </Card>
      )}

      {/* Step 2: Your Mods */}
      <Card className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/20 text-primary text-sm font-bold">
              2
            </div>
            <h3 className="text-sm font-semibold text-text">Your Mods</h3>
            <span className="text-xs text-text-dim">
              {enabledMods.length} active{disabledMods.length > 0 ? `, ${disabledMods.length} disabled` : ''}
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={() => refreshMods()}>
            <RefreshCw size={14} />
          </Button>
        </div>

        {mods.length === 0 ? (
          <div className="flex flex-col items-center py-8 text-text-dim">
            <Package size={32} className="mb-2 opacity-40" />
            <p className="text-sm">No mods installed yet</p>
            <p className="text-xs mt-1">Enter a modpack code above to get started</p>
          </div>
        ) : (
          <div className="space-y-1 max-h-[400px] overflow-y-auto">
            {mods.map((mod) => (
              <div
                key={mod.name}
                className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-surface-hover transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Toggle
                    checked={mod.enabled}
                    onChange={(checked) => handleToggle(mod.name, checked)}
                  />
                  <div className="min-w-0">
                    <span className="text-sm text-text truncate block">{mod.name}</span>
                    {mod.description && (
                      <span className="text-xs text-text-dim truncate block">{mod.description}</span>
                    )}
                  </div>
                </div>
                <span className="text-xs text-text-dim whitespace-nowrap ml-2">v{mod.version}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Step 3: Launch */}
      <Card className="space-y-3">
        <div className="flex items-center gap-2">
          <div className="flex items-center justify-center w-7 h-7 rounded-full bg-primary/20 text-primary text-sm font-bold">
            3
          </div>
          <h3 className="text-sm font-semibold text-text">Launch the game</h3>
        </div>
        <p className="text-xs text-text-dim pl-9">
          Use the green "Launch STS2" button in the sidebar to start the game with your mods.
        </p>
      </Card>

      {/* Help text */}
      <div className="text-center text-xs text-text-dim pt-2 pb-4 space-y-1">
        <p>Need to change the game path or add API keys?</p>
        <button onClick={onGoToSettings} className="text-primary hover:underline">
          Open Settings
        </button>
      </div>
    </div>
  );
}
