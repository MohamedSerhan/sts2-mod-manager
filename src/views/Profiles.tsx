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
  Files,
  AlertTriangle,
} from 'lucide-react';
import { Card } from '../components/Card';
import { Button } from '../components/Button';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmDialog';
import { KebabMenu, KebabSection, KebabDivider, KebabItem } from '../components/KebabMenu';
import { PublishModal } from '../components/PublishModal';
import {
  listProfiles,
  createProfile,
  switchProfile,
  snapshotProfile,
  deleteProfile,
  duplicateProfile,
  exportProfile,
  importProfile,
  installSharedProfile,
  getShareInfo,
  getProfileDrift,
} from '../hooks/useTauri';
import type { ProfileDrift } from '../hooks/useTauri';
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
  const [loadingShare] = useState<{ name: string; kind: 'share' | 'reshare' } | null>(null);
  const [shareResult, setShareResult] = useState<ShareResult | null>(null);
  const [copiedCode, setCopiedCode] = useState(false);
  const [copiedProfileCode, setCopiedProfileCode] = useState<string | null>(null);
  const [shareInfoMap, setShareInfoMap] = useState<Record<string, ShareResult>>({});
  const [publishTarget, setPublishTarget] = useState<{ profile: Profile; isReshare: boolean } | null>(null);
  const [driftMap, setDriftMap] = useState<Record<string, ProfileDrift>>({});
  const [switchingProfile, setSwitchingProfile] = useState<string | null>(null);
  // v5 batch 3 — Following / Published tabs.
  // "Following" = every profile you have. "Published" = ones you've shared (have a share code).
  const [tab, setTab] = useState<'following' | 'published'>('following');
  const { refreshAll, setActiveProfile, activeProfile } = useApp();
  const toastCtx = useToast();
  const confirm = useConfirm();

  useEffect(() => {
    loadProfiles();
  }, []);

  // Load share info and drift for all profiles
  useEffect(() => {
    if (profiles.length === 0) return;
    const loadShareInfos = async () => {
      const map: Record<string, ShareResult> = {};
      for (const p of profiles) {
        try {
          const info = await getShareInfo(p.name);
          if (info) map[p.name] = info;
        } catch { /* no share info */ }
      }
      setShareInfoMap(map);
    };
    loadShareInfos();

    // Load drift only for the active profile (other profiles will naturally differ from disk)
    const loadDrift = async () => {
      const map: Record<string, ProfileDrift> = {};
      if (activeProfile) {
        try {
          const drift = await getProfileDrift(activeProfile);
          if (drift.has_drift) map[activeProfile] = drift;
        } catch { /* ignore */ }
      }
      setDriftMap(map);
    };
    loadDrift();
  }, [profiles, activeProfile]);

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
    const ok = await confirm({
      title: `Delete profile "${name}"?`,
      body: 'The profile manifest will be removed. Mod files on disk stay where they are.',
      confirmLabel: 'Delete profile',
      destructive: true,
    });
    if (!ok) return;
    try {
      await deleteProfile(name);
      setProfiles((prev) => prev.filter((p) => p.name !== name));
      toastCtx.success(`Profile "${name}" deleted`);
    } catch (e) {
      toastCtx.error(`Failed to delete: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleDuplicate(name: string) {
    const newName = prompt(`Duplicate "${name}" as:`, `${name} (copy)`);
    if (!newName?.trim()) return;
    try {
      const profile = await duplicateProfile(name, newName.trim());
      setProfiles((prev) => [...prev, profile]);
      toastCtx.success(`Duplicated as "${profile.name}"`);
    } catch (e) {
      toastCtx.error(`Failed to duplicate: ${e instanceof Error ? e.message : String(e)}`);
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

  // Share + re-share are now driven by <PublishModal> which calls
  // shareProfile / reshareProfile internally. The legacy direct handlers
  // have been removed.

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
    <div className="gf-body">
      {/* Switching Profile Overlay (v5 loading) */}
      {switchingProfile && (
        <div className="gf-modal-back">
          <div className="gf-loading-card">
            <div className="gf-spinner" />
            <div className="gf-loading-msg">Activating "{switchingProfile}"</div>
            <div className="gf-loading-sub">
              Fetching profile data and downloading missing mods…
            </div>
            <div className="gf-loading-step">
              This may take a minute depending on the number of mods.
            </div>
          </div>
        </div>
      )}

      {/* Share Result Modal — v5 gf-modal */}
      {shareResult && (
        <div className="gf-modal-back">
          <div className="gf-modal" style={{ width: 540 }}>
            <div className="gf-modal-head">
              <div>
                <div className="gf-modal-title">Profile published</div>
                <div className="gf-modal-sub">Anyone with the code can install this exact set of mods.</div>
              </div>
              <button
                onClick={() => setShareResult(null)}
                className="gf-btn-3 gf-btn-icon"
                title="Close"
              >
                <X size={14} />
              </button>
            </div>
            <div className="gf-modal-body">
              <div className="gf-share-code">
                <div className="gf-share-code-text">
                  <div className="gf-share-code-eyebrow">Share code</div>
                  <div className="gf-share-code-value">{shareResult.owner}/{shareResult.code}</div>
                </div>
                <Button variant="secondary" size="sm" onClick={handleCopyCode}>
                  {copiedCode ? <Check size={14} /> : <Copy size={14} />}
                  {copiedCode ? 'Copied' : 'Copy'}
                </Button>
              </div>
              <div
                style={{
                  background: 'oklch(0.55 0.13 250 / 0.10)',
                  border: '1px solid oklch(0.55 0.13 250 / 0.3)',
                  borderRadius: 7,
                  padding: '10px 12px',
                  fontSize: 12,
                  color: 'oklch(0.85 0.07 250)',
                }}
              >
                This same code is reused if you re-share later — friends will see updates instead of having to follow a new code.
              </div>
            </div>
            <div className="gf-modal-foot">
              <div style={{ flex: 1 }} />
              <Button onClick={() => setShareResult(null)}>Done</Button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="gf-page-head">
        <div>
          <h1 className="gf-page-title">Your packs</h1>
          <p className="gf-page-sub">
            All the packs you follow, plus your own
          </p>
        </div>
        <div className="gf-page-actions">
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
            Add by code
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
            Snapshot current
          </Button>
          <Button size="sm" onClick={() => {
            setShowCreate(!showCreate);
            setShowImport(false);
            setShowImportCode(false);
          }}>
            <Plus size={14} />
            New profile
          </Button>
        </div>
      </div>

      {/* Following / Published tabs (v5 batch 3) */}
      <div className="gf-tabs gf-tabs-settings" style={{ marginBottom: 14 }}>
        <button
          className={`gf-tab ${tab === 'following' ? 'active' : ''}`}
          onClick={() => setTab('following')}
        >
          Following
          <span className="gf-tab-count">{profiles.length}</span>
        </button>
        <button
          className={`gf-tab ${tab === 'published' ? 'active' : ''}`}
          onClick={() => setTab('published')}
        >
          Published by you
          <span className="gf-tab-count">{Object.keys(shareInfoMap).length}</span>
        </button>
      </div>

      {/* Drift banner on the active profile (v5 batch 3) */}
      {activeProfile && driftMap[activeProfile] && (
        <div className="gf-banner gf-banner-warn" style={{ marginBottom: 14 }}>
          <AlertTriangle size={16} className="gf-banner-icon" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>{activeProfile} has drifted</div>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              {[
                driftMap[activeProfile].added.length && `${driftMap[activeProfile].added.length} new`,
                driftMap[activeProfile].removed.length && `${driftMap[activeProfile].removed.length} removed`,
                driftMap[activeProfile].toggled.length && `${driftMap[activeProfile].toggled.length} toggled`,
                (driftMap[activeProfile].version_changed?.length ?? 0) && `${driftMap[activeProfile].version_changed.length} version-changed`,
              ].filter(Boolean).join(' · ') || 'profile and disk are out of sync'}
              {' '}since the manifest. Repair to match exactly.
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => handleSwitch(activeProfile)}
            title="Re-apply this profile to match the manifest"
          >
            Repair
          </Button>
        </div>
      )}

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
        <div className="gf-empty">
          <div className="gf-empty-art"><Layers size={28} /></div>
          <div className="gf-empty-title">No profiles yet</div>
          <div className="gf-empty-sub">
            Create a profile to save your mod configuration, or import a code from a friend.
          </div>
        </div>
      ) : (() => {
        const visible = tab === 'published'
          ? profiles.filter((p) => shareInfoMap[p.name])
          : profiles;
        if (visible.length === 0) {
          return (
            <div className="gf-empty">
              <div className="gf-empty-art"><Layers size={28} /></div>
              <div className="gf-empty-title">You haven't published anything yet</div>
              <div className="gf-empty-sub">Share a profile to make it appear here. Friends paste your code to install the same set of mods.</div>
            </div>
          );
        }
        return (
        <div className="space-y-2">
          {visible.map((profile) => (
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
                {shareInfoMap[profile.name] && (
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <code className="text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 rounded select-all">
                      {shareInfoMap[profile.name].owner}/{shareInfoMap[profile.name].code}
                    </code>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        const code = `${shareInfoMap[profile.name].owner}/${shareInfoMap[profile.name].code}`;
                        navigator.clipboard.writeText(code).then(() => {
                          setCopiedProfileCode(profile.name);
                          setTimeout(() => setCopiedProfileCode(null), 2000);
                        }).catch(() => {});
                      }}
                      className="text-text-dim hover:text-text transition-colors"
                      title="Copy share code"
                    >
                      {copiedProfileCode === profile.name ? <Check size={12} /> : <Copy size={12} />}
                    </button>
                  </div>
                )}
                {driftMap[profile.name] && (
                  <div
                    className="flex items-start gap-2 mt-1.5 text-xs text-amber-400 bg-amber-500/10 rounded px-2 py-1"
                    title={
                      (driftMap[profile.name].version_changed ?? [])
                        .map((v) => `${v.name}: ${v.profile_version} → ${v.disk_version}`)
                        .join('\n') || undefined
                    }
                  >
                    <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                    <span>
                      Out of sync
                      {driftMap[profile.name].added.length > 0 && (
                        <> &middot; {driftMap[profile.name].added.length} new mod{driftMap[profile.name].added.length > 1 ? 's' : ''}</>
                      )}
                      {driftMap[profile.name].removed.length > 0 && (
                        <> &middot; {driftMap[profile.name].removed.length} removed</>
                      )}
                      {driftMap[profile.name].toggled.length > 0 && (
                        <> &middot; {driftMap[profile.name].toggled.length} toggled</>
                      )}
                      {(driftMap[profile.name].version_changed?.length ?? 0) > 0 && (
                        <> &middot; {driftMap[profile.name].version_changed.length} version{driftMap[profile.name].version_changed.length > 1 ? 's' : ''} changed</>
                      )}
                      {shareInfoMap[profile.name] && (
                        <> &mdash; re-share to update subscribers</>
                      )}
                    </span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1">
                {activeProfile === profile.name ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleSwitch(profile.name)}
                    title="Re-apply this profile to match the manifest"
                    disabled={switchingProfile !== null}
                  >
                    {switchingProfile === profile.name ? (
                      <RefreshCw size={14} className="animate-spin" />
                    ) : (
                      <RefreshCw size={14} />
                    )}
                  </Button>
                ) : (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => handleSwitch(profile.name)}
                    title="Activate profile (enable these mods)"
                    disabled={switchingProfile !== null}
                  >
                    {switchingProfile === profile.name ? (
                      <RefreshCw size={14} className="animate-spin" />
                    ) : (
                      <><Play size={14} /> Switch to</>
                    )}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPublishTarget({ profile, isReshare: !!shareInfoMap[profile.name] })}
                  title={shareInfoMap[profile.name] ? 'Re-share — same code, friends see an update' : 'Share — friends paste the code to install'}
                  disabled={loadingShare?.name === profile.name}
                >
                  <Share2 size={14} />
                  {shareInfoMap[profile.name] ? 'Re-share' : 'Share'}
                </Button>
                <KebabMenu title="More actions">
                  <KebabSection>
                    <KebabItem icon={<Camera size={12} />} onClick={() => handleSnapshot()}>
                      Snapshot from current install
                    </KebabItem>
                    <KebabItem icon={<Files size={12} />} onClick={() => handleDuplicate(profile.name)}>
                      Duplicate
                    </KebabItem>
                  </KebabSection>
                  <KebabDivider />
                  <KebabSection>
                    <KebabItem icon={<Download size={12} />} onClick={() => handleExport(profile.name)}>
                      Export JSON…
                    </KebabItem>
                    {shareInfoMap[profile.name] && (
                      <KebabItem
                        icon={<Copy size={12} />}
                        onClick={() => {
                          const code = `${shareInfoMap[profile.name].owner}/${shareInfoMap[profile.name].code}`;
                          navigator.clipboard.writeText(code).then(() => toastCtx.success('Share code copied'));
                        }}
                      >
                        Copy share code
                      </KebabItem>
                    )}
                  </KebabSection>
                  <KebabDivider />
                  <KebabItem
                    danger
                    icon={<Trash2 size={12} />}
                    onClick={() => handleDelete(profile.name)}
                  >
                    Delete profile…
                  </KebabItem>
                </KebabMenu>
              </div>
            </Card>
          ))}
        </div>
        );
      })()}

      <PublishModal
        open={!!publishTarget}
        profile={publishTarget?.profile ?? null}
        isReshare={publishTarget?.isReshare ?? false}
        onClose={() => setPublishTarget(null)}
        onShared={(result) => {
          setShareInfoMap((prev) => ({ ...prev, [publishTarget!.profile.name]: result }));
        }}
      />
    </div>
  );
}
