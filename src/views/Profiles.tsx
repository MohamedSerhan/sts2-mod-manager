import { useState, useEffect } from 'react';
import {
  Plus,
  Camera,
  Play,
  Download,
  Trash2,
  Upload,
  Layers,
  Share2,
  RefreshCw,
  Copy,
  Check,
  X,
  Key,
} from 'lucide-react';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import {
  listProfiles,
  createProfile,
  switchProfile,
  snapshotProfile,
  deleteProfile,
  exportProfile,
  importProfile,
  shareProfile,
  reshareProfile,
  installSharedProfile,
} from '../hooks/useTauri';
import type { Profile, ShareResult } from '../types';

export function ProfilesView() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [importJson, setImportJson] = useState('');
  const [showImportCode, setShowImportCode] = useState(false);
  const [importCode, setImportCode] = useState('');
  const [importingCode, setImportingCode] = useState(false);
  const [sharingProfile, setSharingProfile] = useState<string | null>(null);
  const [shareResult, setShareResult] = useState<ShareResult | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [switchingProfile, setSwitchingProfile] = useState<string | null>(null);
  const { refreshAll, setActiveProfile, activeProfile } = useApp();
  const toastCtx = useToast();

  useEffect(() => {
    loadProfiles();
  }, []);

  async function loadProfiles() {
    try {
      setLoading(true);
      setError(null);
      const list = await listProfiles();
      setProfiles(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    try {
      const profile = await createProfile(newName.trim());
      setProfiles((prev) => [...prev, profile]);
      setNewName('');
      setShowCreate(false);
      toastCtx.success(`Profile "${profile.name}" created`);
    } catch (e) {
      toastCtx.error(`Failed to create profile: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleSnapshot() {
    const name = prompt('Enter snapshot name:');
    if (!name?.trim()) return;
    try {
      const profile = await snapshotProfile(name.trim());
      setProfiles((prev) => [...prev, profile]);
      toastCtx.success(`Snapshot "${profile.name}" created with ${profile.mods.length} mods`);
    } catch (e) {
      toastCtx.error(`Failed to snapshot: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleSwitch(name: string) {
    try {
      setSwitchingProfile(name);
      const result = await switchProfile(name);
      setActiveProfile(name);
      await refreshAll();
      await loadProfiles();

      const parts: string[] = [];
      if (result.downloaded > 0) parts.push(`${result.downloaded} mod(s) downloaded`);
      if (result.failed_downloads && result.failed_downloads.length > 0) {
        parts.push(`${result.failed_downloads.length} failed: ${result.failed_downloads.join(', ')}`);
      }
      if (result.missing_mods.length > 0) {
        parts.push(`${result.missing_mods.length} still missing: ${result.missing_mods.join(', ')}`);
      }

      if (parts.length > 0) {
        toastCtx.info(`Switched to "${name}". ${parts.join('. ')}`);
      } else {
        toastCtx.success(`Switched to profile "${name}"`);
      }
    } catch (e) {
      toastCtx.error(`Failed to switch: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSwitchingProfile(null);
    }
  }

  async function handleExport(name: string) {
    try {
      const json = await exportProfile(name);
      await navigator.clipboard.writeText(json);
      toastCtx.success('Profile JSON copied to clipboard!');
    } catch (e) {
      toastCtx.error(`Failed to export: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete profile "${name}"?`)) return;
    try {
      await deleteProfile(name);
      setProfiles((prev) => prev.filter((p) => p.name !== name));
      toastCtx.success(`Profile "${name}" deleted`);
    } catch (e) {
      toastCtx.error(`Failed to delete: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleImport() {
    if (!importJson.trim()) return;
    try {
      const profile = await importProfile(importJson.trim());
      setProfiles((prev) => [...prev, profile]);
      setImportJson('');
      setShowImport(false);
      toastCtx.success(`Imported profile "${profile.name}"`);
    } catch (e) {
      toastCtx.error(`Failed to import: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleShare(name: string) {
    try {
      setSharingProfile(name);
      const result = await shareProfile(name);
      setShareResult(result);
      setCopiedCode(false);
    } catch (e) {
      toastCtx.error(`Failed to share: ${e instanceof Error ? e.message : String(e)}`);
      setSharingProfile(null);
    }
  }

  async function handleReshare(name: string) {
    try {
      setSharingProfile(name);
      const result = await reshareProfile(name);
      setShareResult(result);
      setCopiedCode(false);
      toastCtx.success('Profile re-shared! Same code, updated content.');
    } catch (e) {
      toastCtx.error(`Failed to re-share: ${e instanceof Error ? e.message : String(e)}`);
      setSharingProfile(null);
    }
  }

  async function handleCopyCode() {
    if (!shareResult) return;
    try {
      await navigator.clipboard.writeText(`${shareResult.owner}/${shareResult.code}`);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      // fallback: select the input
      toastCtx.info('Select the code and copy manually');
    }
  }

  async function handleImportFromCode() {
    const code = importCode.trim();
    if (!code) return;

    try {
      setImportingCode(true);
      const profile = await installSharedProfile(code);
      setProfiles((prev) => [...prev, profile]);
      setImportCode('');
      setShowImportCode(false);
      await refreshAll();
      toastCtx.success(`Imported modpack "${profile.name}" - ${profile.mods.length} mods. You're now subscribed for updates!`);
    } catch (e) {
      toastCtx.error(`Failed to import: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImportingCode(false);
    }
  }

  return (
    <div className="p-8 space-y-6">
      {/* Switching Profile Overlay */}
      {switchingProfile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <Card className="max-w-sm w-full mx-4 text-center space-y-4">
            <RefreshCw size={32} className="animate-spin text-primary mx-auto" />
            <h3 className="text-base font-semibold text-text">
              Activating "{switchingProfile}"
            </h3>
            <p className="text-sm text-text-muted">
              Fetching profile data and downloading missing mods...
            </p>
            <p className="text-xs text-text-dim">
              This may take a minute depending on the number of mods.
            </p>
          </Card>
        </div>
      )}

      {/* Share Result Modal */}
      {shareResult && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
          <Card className="max-w-md w-full mx-4 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-text">
                Profile Shared!
              </h3>
              <button
                onClick={() => {
                  setShareResult(null);
                  setSharingProfile(null);
                }}
                className="text-text-dim hover:text-text"
              >
                <X size={16} />
              </button>
            </div>
            <p className="text-xs text-text-muted">
              Send this code to your friends. They enter it in "Import Code" to get your modpack:
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={`${shareResult.owner}/${shareResult.code}`}
                className="flex-1 bg-background border border-border rounded-lg px-4 py-3 text-lg text-text font-mono font-bold text-center tracking-wider select-all focus:outline-none"
              />
              <Button size="sm" onClick={handleCopyCode}>
                {copiedCode ? <Check size={14} /> : <Copy size={14} />}
                {copiedCode ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <div className="text-xs text-text-dim space-y-1">
              <p>When you update your mods and re-share, the code stays the same.</p>
              <p>Your friends will see "Update available" on their Dashboard.</p>
            </div>
          </Card>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text">Profiles</h2>
          <p className="text-sm text-text-muted mt-1.5">
            Manage mod configurations and share with friends
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowImportCode(!showImportCode);
              setShowImport(false);
              setShowCreate(false);
            }}
          >
            <Key size={14} />
            Import Code
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowImport(!showImport);
              setShowImportCode(false);
              setShowCreate(false);
            }}
          >
            <Upload size={14} />
            Import JSON
          </Button>
          <Button variant="secondary" size="sm" onClick={handleSnapshot}>
            <Camera size={14} />
            Snapshot Current
          </Button>
          <Button size="sm" onClick={() => {
            setShowCreate(!showCreate);
            setShowImport(false);
            setShowImportCode(false);
          }}>
            <Plus size={14} />
            New Profile
          </Button>
        </div>
      </div>

      {/* Import Code Form */}
      {showImportCode && (
        <Card className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-text-muted block mb-1">
              Profile Code (from a friend)
            </label>
            <input
              type="text"
              value={importCode}
              onChange={(e) => setImportCode(e.target.value)}
              placeholder="username/XXXX-XXXX-XXXX"
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-text font-mono tracking-wider placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50"
              onKeyDown={(e) => e.key === 'Enter' && handleImportFromCode()}
              disabled={importingCode}
            />
          </div>
          <Button
            size="sm"
            onClick={handleImportFromCode}
            disabled={importingCode}
          >
            {importingCode ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            {importingCode ? 'Importing...' : 'Import'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowImportCode(false)}
          >
            Cancel
          </Button>
        </Card>
      )}

      {/* Create Profile Form */}
      {showCreate && (
        <Card className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-text-muted block mb-1">
              Profile Name
            </label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="My Profile"
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50"
              onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
            />
          </div>
          <Button size="sm" onClick={handleCreate}>
            Create
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowCreate(false)}
          >
            Cancel
          </Button>
        </Card>
      )}

      {/* Import Profile JSON Form */}
      {showImport && (
        <Card className="space-y-2">
          <label className="text-xs text-text-muted block">
            Paste profile JSON
          </label>
          <textarea
            value={importJson}
            onChange={(e) => setImportJson(e.target.value)}
            placeholder='{"name": "...", "mods": [...]}'
            rows={4}
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none font-mono"
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={handleImport}>
              Import
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowImport(false)}
            >
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {/* Profiles List */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-text-dim">
          <p className="text-sm">Loading profiles...</p>
        </div>
      ) : error ? (
        <Card className="text-center py-8">
          <p className="text-danger text-sm">{error}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={loadProfiles}
          >
            Retry
          </Button>
        </Card>
      ) : profiles.length === 0 ? (
        <Card className="flex flex-col items-center justify-center py-16">
          <Layers size={44} className="text-text-dim opacity-40 mb-4" />
          <p className="text-base text-text-dim">No profiles yet</p>
          <p className="text-sm text-text-dim mt-1.5">
            Create a profile to save your mod configuration, or import a code from a friend
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {profiles.map((profile) => (
            <Card
              key={profile.name}
              className={`flex items-center justify-between hover:bg-surface-hover transition-colors ${activeProfile === profile.name ? 'border-green-500/50 bg-green-500/5' : ''}`}
            >
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-text flex items-center gap-2">
                  {profile.name}
                  {activeProfile === profile.name && (
                    <span className="text-[10px] font-normal bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded">ACTIVE</span>
                  )}
                </h3>
                <div className="flex items-center gap-3 mt-1 text-xs text-text-dim">
                  <span>
                    {profile.mods.filter(m => m.enabled).length} enabled
                    {profile.mods.filter(m => !m.enabled).length > 0 && (
                      <>, {profile.mods.filter(m => !m.enabled).length} disabled</>
                    )}
                  </span>
                  {profile.game_version && <span>{profile.game_version}</span>}
                  <span>
                    {new Date(profile.created_at).toLocaleDateString()}
                  </span>
                  {profile.created_by && (
                    <span className="text-primary">by {profile.created_by}</span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSwitch(profile.name)}
                  title="Activate profile (enable these mods)"
                  disabled={switchingProfile !== null}
                >
                  {switchingProfile === profile.name ? (
                    <RefreshCw size={14} className="animate-spin" />
                  ) : (
                    <Play size={14} />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleShare(profile.name)}
                  title="Share profile (get a code for friends)"
                  disabled={sharingProfile === profile.name}
                >
                  {sharingProfile === profile.name ? (
                    <RefreshCw size={14} className="animate-spin" />
                  ) : (
                    <Share2 size={14} />
                  )}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleReshare(profile.name)}
                  title="Re-share (update for friends, same code)"
                  disabled={sharingProfile === profile.name}
                >
                  <RefreshCw size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleExport(profile.name)}
                  title="Export as JSON"
                >
                  <Download size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleDelete(profile.name)}
                  title="Delete profile"
                  className="hover:text-danger"
                >
                  <Trash2 size={14} />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
