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
  Link,
  Copy,
  Check,
  X,
} from 'lucide-react';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
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
  const [showImportLink, setShowImportLink] = useState(false);
  const [importLink, setImportLink] = useState('');
  const [importingLink, setImportingLink] = useState(false);
  const [sharingProfile, setSharingProfile] = useState<string | null>(null);
  const [shareResult, setShareResult] = useState<ShareResult | null>(null);
  const [copiedUrl, setCopiedUrl] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    loadProfiles();
  }, []);

  // Auto-dismiss toast
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

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
    } catch (e) {
      console.error('Failed to create profile:', e);
    }
  }

  async function handleSnapshot() {
    const name = prompt('Enter snapshot name:');
    if (!name?.trim()) return;
    try {
      const profile = await snapshotProfile(name.trim());
      setProfiles((prev) => [...prev, profile]);
    } catch (e) {
      console.error('Failed to snapshot profile:', e);
    }
  }

  async function handleSwitch(name: string) {
    try {
      await switchProfile(name);
      await loadProfiles();
    } catch (e) {
      console.error('Failed to switch profile:', e);
    }
  }

  async function handleExport(name: string) {
    try {
      const json = await exportProfile(name);
      await navigator.clipboard.writeText(json);
      setToast('Profile JSON copied to clipboard!');
    } catch (e) {
      console.error('Failed to export profile:', e);
    }
  }

  async function handleDelete(name: string) {
    if (!confirm(`Delete profile "${name}"?`)) return;
    try {
      await deleteProfile(name);
      setProfiles((prev) => prev.filter((p) => p.name !== name));
    } catch (e) {
      console.error('Failed to delete profile:', e);
    }
  }

  async function handleImport() {
    if (!importJson.trim()) return;
    try {
      const profile = await importProfile(importJson.trim());
      setProfiles((prev) => [...prev, profile]);
      setImportJson('');
      setShowImport(false);
    } catch (e) {
      console.error('Failed to import profile:', e);
    }
  }

  async function handleShare(name: string) {
    try {
      setSharingProfile(name);
      const result = await shareProfile(name);
      setShareResult(result);
      setCopiedUrl(false);
    } catch (e) {
      setToast(`Failed to share: ${e instanceof Error ? e.message : String(e)}`);
      setSharingProfile(null);
    }
  }

  async function handleReshare(name: string) {
    try {
      setSharingProfile(name);
      const result = await reshareProfile(name);
      setShareResult(result);
      setCopiedUrl(false);
    } catch (e) {
      setToast(`Failed to re-share: ${e instanceof Error ? e.message : String(e)}`);
      setSharingProfile(null);
    }
  }

  async function handleCopyShareUrl() {
    if (!shareResult) return;
    try {
      await navigator.clipboard.writeText(shareResult.url);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch (e) {
      console.error('Failed to copy URL:', e);
    }
  }

  function extractShareId(input: string): string {
    const trimmed = input.trim();
    // Strip URL prefix if present
    const prefix = 'https://sts2mm.dev/p/';
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length).split('/')[0].split('?')[0];
    }
    // Also handle bare URLs without https://
    const barePrefix = 'sts2mm.dev/p/';
    if (trimmed.startsWith(barePrefix)) {
      return trimmed.slice(barePrefix.length).split('/')[0].split('?')[0];
    }
    // Assume it's a raw ID
    return trimmed;
  }

  async function handleImportFromLink() {
    if (!importLink.trim()) return;
    const id = extractShareId(importLink);
    if (!id) return;

    try {
      setImportingLink(true);
      const profile = await installSharedProfile(id);
      setProfiles((prev) => [...prev, profile]);
      setImportLink('');
      setShowImportLink(false);
      setToast(`Imported profile "${profile.name}" successfully!`);
    } catch (e) {
      setToast(`Failed to import: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImportingLink(false);
    }
  }

  return (
    <div className="p-6 space-y-4">
      {/* Toast Notification */}
      {toast && (
        <div className="fixed top-4 right-4 z-50 bg-surface border border-border rounded-lg px-4 py-3 shadow-lg flex items-center gap-2 text-sm text-text animate-in fade-in slide-in-from-top-2">
          <span>{toast}</span>
          <button
            onClick={() => setToast(null)}
            className="text-text-dim hover:text-text"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* Share Result Modal */}
      {shareResult && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
          <Card className="max-w-md w-full mx-4 space-y-3">
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
              Share this link with others so they can import your profile:
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                readOnly
                value={shareResult.url}
                className="flex-1 bg-background border border-border rounded-lg px-3 py-2 text-sm text-text font-mono select-all focus:outline-none"
              />
              <Button size="sm" onClick={handleCopyShareUrl}>
                {copiedUrl ? <Check size={14} /> : <Copy size={14} />}
                {copiedUrl ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="text-xs text-text-dim">
              Keep the secret token safe if you want to update this share later.
            </p>
          </Card>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text">Profiles</h2>
          <p className="text-sm text-text-muted mt-1">
            Manage mod configurations
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowImportLink(!showImportLink);
              setShowImport(false);
            }}
          >
            <Link size={14} />
            Import from Link
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setShowImport(!showImport);
              setShowImportLink(false);
            }}
          >
            <Upload size={14} />
            Import
          </Button>
          <Button variant="secondary" size="sm" onClick={handleSnapshot}>
            <Camera size={14} />
            Snapshot Current
          </Button>
          <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
            <Plus size={14} />
            New Profile
          </Button>
        </div>
      </div>

      {/* Import from Link Form */}
      {showImportLink && (
        <Card className="flex gap-2 items-end">
          <div className="flex-1">
            <label className="text-xs text-text-muted block mb-1">
              Profile Link or ID
            </label>
            <input
              type="text"
              value={importLink}
              onChange={(e) => setImportLink(e.target.value)}
              placeholder="https://sts2mm.dev/p/abc123 or just abc123"
              className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm text-text placeholder:text-text-dim focus:outline-none focus:ring-2 focus:ring-primary/50"
              onKeyDown={(e) => e.key === 'Enter' && handleImportFromLink()}
              disabled={importingLink}
            />
          </div>
          <Button
            size="sm"
            onClick={handleImportFromLink}
            disabled={importingLink}
          >
            {importingLink ? (
              <RefreshCw size={14} className="animate-spin" />
            ) : (
              <Download size={14} />
            )}
            {importingLink ? 'Importing...' : 'Import'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowImportLink(false)}
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

      {/* Import Profile Form */}
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
        <Card className="flex flex-col items-center justify-center py-12">
          <Layers size={40} className="text-text-dim opacity-40 mb-3" />
          <p className="text-sm text-text-dim">No profiles yet</p>
          <p className="text-xs text-text-dim mt-1">
            Create a profile to save your mod configuration
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {profiles.map((profile) => (
            <Card
              key={profile.name}
              className="flex items-center justify-between hover:bg-surface-hover transition-colors"
            >
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-text">
                  {profile.name}
                </h3>
                <div className="flex items-center gap-3 mt-1 text-xs text-text-dim">
                  <span>
                    {profile.mods.length} mod
                    {profile.mods.length !== 1 ? 's' : ''}
                  </span>
                  <span>{profile.game_version}</span>
                  <span>
                    {new Date(profile.created_at).toLocaleDateString()}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleSwitch(profile.name)}
                  title="Activate profile"
                >
                  <Play size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleShare(profile.name)}
                  title="Share profile"
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
                  title="Re-share (update existing share)"
                  disabled={sharingProfile === profile.name}
                >
                  <RefreshCw size={14} />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleExport(profile.name)}
                  title="Export profile"
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
