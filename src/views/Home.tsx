import { useState, useEffect, useRef } from 'react';
import {
  Download,
  RefreshCw,
  Gamepad2,
  Settings,
  Trash2,
  Play,
  Wrench,
  ChevronRight,
  Plus,
  Share2,
  AlertTriangle,
  Copy,
  Check,
  MessageSquare,
  Link as LinkIcon,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useConfirm } from '../components/ConfirmDialog';
import { SubUpdateDetail } from '../components/SubUpdateDetail';
import { AboutCard } from '../components/AboutCard';
import { WhatsNewCard } from '../components/WhatsNewCard';
import {
  checkSubscriptionUpdates,
  applySubscriptionUpdate,
  repairModpackSubscription,
  getSubscriptions,
  getInstalledMods,
  unsubscribe,
  switchProfile,
  repairProfile,
  getProfileDrift,
  createBackup,
} from '../hooks/useTauri';
import { importShareCodeSmart, buildShareMessage, buildShareLink } from '../lib/shareImport';
import { getShareInfo, listProfiles } from '../hooks/useTauri';
import type { ShareResult, Profile } from '../types';
import { PublishModal } from '../components/PublishModal';
import type { SubscriptionUpdate, Subscription } from '../types';

function formatShareCode(shareId: string): string {
  const sep = shareId.includes(':') ? ':' : '/';
  const idx = shareId.indexOf(sep);
  if (idx === -1) return shareId;
  const owner = shareId.slice(0, idx);
  const raw = shareId.slice(idx + 1).replace(/-/g, '');
  const code = raw.length >= 12
    ? `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`
    : raw;
  return `${owner}/${code}`;
}

function packInitials(name: string): string {
  return name.split(/[\s_-]+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
}

/** Prominent share-code chip in the hero. Three separate copy actions
 *  because the user might want any one of them:
 *
 *  - **Copy code** — the raw `username/CODE`. Power-user paste-into-
 *    manager flow.
 *  - **Copy link** — the HTTPS install bridge URL on github.io. This is
 *    the link friends should drop in Discord / Slack / etc., because
 *    those apps only auto-linkify http/https — the raw sts2mm:// shows
 *    as un-clickable plain text. The bridge page on click fires the
 *    sts2mm:// for friends who have the manager, with download
 *    fallbacks for everyone else.
 *  - **Copy message** — the full paste-ready one-liner (intro + link +
 *    code) so the curator can drop a single chat message.
 *
 *  Each action shows a brief inline "Copied" state in addition to the
 *  toast so the click registers without the user having to track the
 *  toast stack. */
function ShareCodeChip({ code, packName }: { code: string; packName: string }) {
  const [copied, setCopied] = useState<'code' | 'link' | 'msg' | null>(null);
  const toast = useToast();

  const link = buildShareLink(code);
  const message = buildShareMessage(packName, code);

  async function copyTo(kind: 'code' | 'link' | 'msg', value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      toast.success(label);
      window.setTimeout(() => setCopied(null), 1600);
    } catch (e) {
      toast.error("Couldn't copy to clipboard");
    }
  }

  return (
    <div className="gf-sharecode-row">
      <button
        type="button"
        className={`gf-sharecode-chip${copied === 'code' ? ' is-copied' : ''}`}
        onClick={() => copyTo('code', code, 'Share code copied')}
        title="Click to copy the share code"
      >
        <span className="gf-sharecode-eyebrow">Share code</span>
        <span className="gf-sharecode-value">{code}</span>
        <span className="gf-sharecode-action">
          {copied === 'code' ? (
            <><Check size={13} /> Copied</>
          ) : (
            <><Copy size={13} /> Copy</>
          )}
        </span>
      </button>
      <button
        type="button"
        className={`gf-sharecode-msg-btn${copied === 'link' ? ' is-copied' : ''}`}
        onClick={() => copyTo('link', link, 'Install link copied — paste into Discord / chat')}
        title={`Copies the clickable install link: ${link}`}
      >
        {copied === 'link' ? (
          <><Check size={13} /> Copied link</>
        ) : (
          <><LinkIcon size={13} /> Copy link</>
        )}
      </button>
      <button
        type="button"
        className={`gf-sharecode-msg-btn${copied === 'msg' ? ' is-copied' : ''}`}
        onClick={() => copyTo('msg', message, 'Share message copied — paste into Discord / chat')}
        title={`Copies the full share message:\n\n${message}`}
      >
        {copied === 'msg' ? (
          <><Check size={13} /> Copied message</>
        ) : (
          <><MessageSquare size={13} /> Copy message</>
        )}
      </button>
    </div>
  );
}

// v5 — Single-hero "Continue with" home. Hero = active pack; quick-add code
// underneath; followed packs as compact rows below. Code-only quick-add
// (no URL, no zip) — those are progressive-disclosed elsewhere.
interface HomeProps {
  onGoToSettings: () => void;
  onGoToMods?: () => void;
  onGoToProfiles?: () => void;
  onSwitchPack?: () => void;
  onLaunch?: () => void;
  /**
   * Bumped from App when the user clicks "Add pack" elsewhere (profile
   * kebab today). Each change triggers focus + a one-shot pulse on the
   * share-code input so the user sees where to type.
   */
  focusCodeBarSignal?: number;
}
export function HomeView({ onGoToSettings, onGoToMods, onGoToProfiles, onSwitchPack, onLaunch, focusCodeBarSignal }: HomeProps) {
  const { gameInfo, mods, refreshAll, activeProfile, refreshSubUpdates, subUpdates: ctxSubUpdates } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [profileCode, setProfileCode] = useState('');
  const [importing, setImporting] = useState(false);
  const [subUpdates, setSubUpdates] = useState<SubscriptionUpdate[]>([]);
  const [applyingSub, setApplyingSub] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [, setChecking] = useState(false);
  const [repairingShareId, setRepairingShareId] = useState<string | null>(null);
  const [activatingProfile, setActivatingProfile] = useState<string | null>(null);
  const [updateDetail, setUpdateDetail] = useState<SubscriptionUpdate | null>(null);
  const [repairing, setRepairing] = useState(false);
  const codeBarRef = useRef<HTMLDivElement | null>(null);
  const codeInputRef = useRef<HTMLInputElement | null>(null);
  const [codeBarPulse, setCodeBarPulse] = useState(false);
  // Share info for the curator's OWN active profile (separate from
  // `activeSub` which only covers profiles received from someone else).
  // Without this, a curator looking at their own published pack on Home
  // saw no chip at all because the chip was gated on activeSub.
  const [activeProfileShare, setActiveProfileShare] = useState<ShareResult | null>(null);
  // PublishModal target. When the active profile isn't published yet,
  // the hero gets a "Share this pack" button that opens the modal
  // directly on Home (no detour through Profiles).
  const [publishTarget, setPublishTarget] = useState<{ profile: Profile; isReshare: boolean } | null>(null);

  useEffect(() => {
    loadSubscriptions();
    checkSubs();
  }, []);

  // Refresh share info whenever the active profile changes — covers
  // profile-switch, fresh publish, and unpublish (delete sidecar).
  // refreshAll bumps mods/gameInfo too, so we couple the share lookup
  // to that signal as a cheap "something changed" indicator.
  useEffect(() => {
    let cancelled = false;
    async function loadShareInfo() {
      if (!activeProfile) { setActiveProfileShare(null); return; }
      try {
        const info = await getShareInfo(activeProfile);
        if (!cancelled) setActiveProfileShare(info);
      } catch {
        if (!cancelled) setActiveProfileShare(null);
      }
    }
    loadShareInfo();
    return () => { cancelled = true; };
  }, [activeProfile, mods]);

  // When a sibling view asks to focus the code bar (Add Pack from kebab),
  // scroll it into view, focus the input, and pulse it briefly so the user
  // sees where the share code goes. Skip the very first render (signal=0).
  useEffect(() => {
    if (!focusCodeBarSignal) return;
    const el = codeBarRef.current;
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const input = codeInputRef.current;
    if (input) {
      // Wait one frame so the scroll starts before focus steals it back.
      requestAnimationFrame(() => input.focus({ preventScroll: true }));
    }
    setCodeBarPulse(true);
    const t = window.setTimeout(() => setCodeBarPulse(false), 1400);
    return () => window.clearTimeout(t);
  }, [focusCodeBarSignal]);

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
      // Smart router handles four cases:
      //   - brand-new pack → confirm + install
      //   - already subscribed + active + no update → friendly no-op
      //   - already subscribed + not active → "switch?" confirm
      //   - already subscribed + has update → "apply update?" confirm
      // Means the deep-link path can't drift from this — both go through
      // the same router with the same UX.
      const outcome = await importShareCodeSmart(code, {
        confirm,
        subscriptions,
        activeProfile,
        subUpdates: ctxSubUpdates,
      });
      if (outcome.kind === 'cancelled') return;

      await refreshAll();
      await loadSubscriptions();
      refreshSubUpdates();

      if (outcome.kind === 'installed') {
        const installedMods = await getInstalledMods();
        const installedNames = new Set(installedMods.map(m => m.name));
        const missing = outcome.profile.mods.filter(m => !installedNames.has(m.name));
        if (missing.length > 0) {
          toast.info(
            `Installed ${outcome.profile.mods.length - missing.length}/${outcome.profile.mods.length} mods. ` +
            `Missing: ${missing.map(m => m.name).join(', ')}. These need to be installed manually.`
          );
        } else {
          toast.success(`Installed modpack "${outcome.profile.name}" with ${outcome.profile.mods.length} mods!`);
        }
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
      // Keep AppContext (and thus the sidebar badge) in sync — the
      // background poll would catch this in 90s but the user expects
      // the badge to clear immediately.
      refreshSubUpdates();
      toast.success(`Synced modpack "${profile.name}" - you're up to date!`);
    } catch (e) {
      toast.error(`Sync failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setApplyingSub(null);
    }
  }

  async function handleUnsubscribe(shareId: string, profileName: string) {
    const ok = await confirm({
      title: `Unlink from "${profileName}"?`,
      body: "You'll stop receiving updates from the curator. The mods stay installed.",
      confirmLabel: 'Unlink',
      destructive: true,
    });
    if (!ok) return;
    try {
      await unsubscribe(shareId);
      setSubscriptions((prev) => prev.filter((s) => s.share_id !== shareId));
      setSubUpdates((prev) => prev.filter((s) => s.share_id !== shareId));
      refreshSubUpdates();
      toast.success(`Unlinked from "${profileName}"`);
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleRepairModpack(shareId: string) {
    const ok = await confirm({
      title: 'Repair this pack?',
      body: 'Repair wipes the mods folder and reinstalls every entry from the manifest. Use when the install has drifted or you suspect corruption.',
      checkbox: { label: 'Make a backup before repairing', defaultChecked: true },
      confirmLabel: 'Repair',
      destructive: true,
    });
    if (!ok) return;
    try {
      setRepairingShareId(shareId);
      await repairModpackSubscription(shareId);
      await refreshAll();
      toast.success('Modpack reinstalled');
    } catch (e) {
      toast.error(`Repair failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRepairingShareId(null);
    }
  }

  /** Repair the active profile from Home — same flow as the Profiles drift
   *  banner: confirm with orphan list, optional pre-backup, then call
   *  repair_profile (apply + delete orphans). */
  async function handleRepair(name: string) {
    let drift: Awaited<ReturnType<typeof getProfileDrift>> | null = null;
    try { drift = await getProfileDrift(name); } catch { /* fall through with no-orphans */ }
    const orphanCount = drift?.added.length ?? 0;
    const orphans = drift?.added ?? [];
    const orphanList = orphans.length > 8
      ? `${orphans.slice(0, 8).join(', ')}, …${orphans.length - 8} more`
      : orphans.join(', ');

    const ok = await confirm({
      title: `Repair "${name}"?`,
      body: orphanCount > 0
        ? `Re-applies the manifest and deletes ${orphanCount} mod file(s) that aren't in the profile: ${orphanList}.`
        : 'Re-applies the manifest exactly. Toggles, versions, and load order are restored from the saved snapshot.',
      warning: orphanCount > 0
        ? 'Orphan files will be permanently removed. Restore from a backup if you change your mind.'
        : undefined,
      confirmLabel: 'Repair',
      destructive: orphanCount > 0,
      checkbox: orphanCount > 0
        ? { label: 'Make a backup before repairing', defaultChecked: true }
        : undefined,
    });
    if (!ok) return;

    setRepairing(true);
    try {
      if (ok.checked) {
        try { await createBackup(); }
        catch (e) { toast.error(`Backup failed: ${e instanceof Error ? e.message : String(e)}`); }
      }
      const result = await repairProfile(name);
      await refreshAll();
      const summary: string[] = [];
      if (result.deleted_orphans.length > 0) {
        summary.push(`removed ${result.deleted_orphans.length} orphan mod${result.deleted_orphans.length === 1 ? '' : 's'}`);
      }
      if (result.downloaded > 0) summary.push(`downloaded ${result.downloaded}`);
      if (result.failed_downloads.length > 0) summary.push(`${result.failed_downloads.length} download(s) failed`);
      if (result.missing_mods.length > 0) summary.push(`${result.missing_mods.length} still missing`);
      toast.success(summary.length ? `Repaired "${name}" — ${summary.join(', ')}` : `Repaired "${name}"`);
    } catch (e) {
      toast.error(`Repair failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRepairing(false);
    }
  }

  async function handleActivateModpack(profileName: string) {
    if (activeProfile && activeProfile !== profileName) {
      try {
        const drift = await getProfileDrift(activeProfile);
        if (drift.has_drift) {
          const ok = await confirm({
            title: `Switch away from "${activeProfile}"?`,
            body: 'This profile has unsaved changes on disk. Switching applies another manifest and those working changes will not be saved to the current profile.',
            warning: 'Open Profiles and use Save changes first if you want to keep them.',
            confirmLabel: 'Switch anyway',
            cancelLabel: 'Stay here',
          });
          if (!ok) return;
        }
      } catch {
        // Drift is advisory. If it cannot be checked, keep activation usable.
      }
    }

    try {
      setActivatingProfile(profileName);
      const result = await switchProfile(profileName);
      await refreshAll();
      if (result.missing_mods.length > 0) {
        toast.info(`Activated "${profileName}". ${result.downloaded} downloaded, ${result.missing_mods.length} still missing.`);
      } else {
        toast.success(`Activated "${profileName}"`);
      }
    } catch (e) {
      toast.error(`Failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setActivatingProfile(null);
    }
  }

  const enabledMods = mods.filter((m) => m.enabled);
  const activeSub = subscriptions.find((s) => s.profile_name === activeProfile);
  const otherSubs = subscriptions.filter((s) => s.profile_name !== activeProfile);
  const activeUpdate = subUpdates.find((s) => s.profile_name === activeProfile);

  const heroName = activeProfile || 'Vanilla';
  // Share code source: prefer activeSub (a pack imported FROM someone),
  // fall back to activeProfileShare (the curator's own published pack
  // — sidecar on disk, no subscription record). Used to display "yep,
  // this is shareable, here's the code" UI on every active profile that
  // has one regardless of who wrote it.
  const heroCode = activeSub
    ? formatShareCode(activeSub.share_id)
    : activeProfileShare
    ? `${activeProfileShare.owner}/${activeProfileShare.code}`
    : null;
  // True if the active profile is locally owned (the user's own) and
  // hasn't been published yet — drives the "Share this pack" CTA.
  const canShareActive = !!activeProfile && !activeSub && !activeProfileShare;
  // Code lives in its own ShareCodeChip below, so it's not duplicated
  // in the meta line. The meta keeps just mod count + sync recency.
  const heroMeta = activeSub
    ? `${enabledMods.length} mods · synced ${new Date(activeSub.last_synced).toLocaleDateString()}`
    : activeProfileShare
    ? `${enabledMods.length} mods · published by you`
    : `${enabledMods.length} mods · ${activeProfile ? 'Local profile' : 'Built-in vanilla profile'}`;

  return (
    <div className="gf-body">
      {/* Importing overlay */}
      {importing && (
        <div className="gf-onb">
          <div className="gf-onb-card" style={{ width: 380, textAlign: 'center' }}>
            <RefreshCw size={32} className="mx-auto mb-3" style={{ color: 'var(--gf)', animation: 'spin 1s linear infinite' }} />
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Installing modpack</h3>
            <p style={{ fontSize: 13, color: 'var(--ink-mute)' }}>Downloading mods and setting up your profile…</p>
            <p style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 6 }}>This may take a few minutes for large modpacks.</p>
          </div>
        </div>
      )}

      {/* What's new card — one-shot per-version, dismissable. Sits above
          everything else so users see release notes before they start
          clicking around. */}
      <WhatsNewCard />

      {/* Game-not-detected warning */}
      {!gameInfo?.valid && (
        <div className="gf-banner gf-banner-warn" style={{ marginBottom: 14 }}>
          <Gamepad2 size={16} className="gf-banner-icon" />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600 }}>Game not detected</div>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              Slay the Spire 2 wasn't found automatically. Open Settings to set the path.
            </div>
          </div>
          <button className="gf-btn-3" onClick={onGoToSettings}>
            <Settings size={12} /> Settings
          </button>
        </div>
      )}

      {/* Hero — single "Continue with" pattern */}
      <div className="gf-hero">
        <div className="gf-hero-eyebrow">Continue with</div>
        <div className="gf-hero-title">
          {heroName}
          <span className="gf-pill gf-pill-active">ACTIVE</span>
        </div>
        <div className="gf-hero-meta">{heroMeta}</div>

        {heroCode && <ShareCodeChip code={heroCode} packName={heroName} />}

        {activeUpdate && (
          <div
            style={{
              marginTop: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '10px 12px',
              borderRadius: 8,
              background: 'var(--gf-tint)',
              border: '1px solid var(--gf-line)',
              color: 'var(--gf)',
              fontSize: 12.5,
            }}
          >
            <span className="gf-dot gf-dot-warn" />
            <span style={{ flex: 1, fontWeight: 600 }}>
              {(activeUpdate.added_mods.length || 0) + (activeUpdate.updated_mods.length || 0) + (activeUpdate.removed_mods.length || 0)} update
              {((activeUpdate.added_mods.length || 0) + (activeUpdate.updated_mods.length || 0) + (activeUpdate.removed_mods.length || 0)) === 1 ? '' : 's'} from author
            </span>
            <button
              className="gf-btn-2 gf-btn-2-sm"
              onClick={() => setUpdateDetail(activeUpdate)}
              disabled={applyingSub === activeUpdate.share_id}
            >
              View changes
            </button>
            <button
              className="gf-btn gf-btn-sm"
              onClick={() => handleApplySubUpdate(activeUpdate.share_id)}
              disabled={applyingSub === activeUpdate.share_id}
            >
              {applyingSub === activeUpdate.share_id ? (
                <RefreshCw size={11} className="animate-spin" />
              ) : (
                <Download size={11} />
              )}
              Sync updates
            </button>
          </div>
        )}

        <div className="gf-hero-actions">
          <button
            className="gf-btn gf-btn-lg"
            onClick={onLaunch}
            disabled={!onLaunch}
            title={onLaunch ? 'Launch STS2 with this pack' : 'Use the Launch button in the top bar'}
          >
            <Play size={11} fill="currentColor" /> Launch with this pack
          </button>
          <button
            className="gf-btn-2"
            onClick={onGoToMods}
            title="See and toggle the mods in this profile"
          >
            Manage mods
          </button>
          <button
            className="gf-btn-2"
            onClick={onSwitchPack}
            title="Switch to a different pack"
          >
            Switch pack
          </button>
          {activeProfile && (
            <button
              className="gf-btn-2"
              onClick={() => handleRepair(activeProfile)}
              disabled={repairing}
              title="Re-apply the manifest and delete any orphan mod files"
            >
              {repairing ? (
                <RefreshCw size={11} className="animate-spin" />
              ) : (
                <Wrench size={11} />
              )}
              {repairing ? 'Repairing…' : 'Repair'}
            </button>
          )}
          {/* Share-this-pack CTA — only renders when the active profile
              is the curator's own and hasn't been published yet. After
              publishing, the ShareCodeChip above takes over and this
              button collapses. */}
          {canShareActive && activeProfile && (
            <button
              className="gf-btn-2"
              onClick={async () => {
                // Load the real Profile object from disk so PublishModal
                // gets the exact same shape it would from Profiles view.
                try {
                  const list = await listProfiles();
                  const p = list.find((p) => p.name === activeProfile);
                  if (p) setPublishTarget({ profile: p, isReshare: false });
                  else toast.error("Couldn't find this profile on disk.");
                } catch (e) {
                  toast.error(`Couldn't load profile: ${e instanceof Error ? e.message : String(e)}`);
                }
              }}
              title="Publish this pack to a GitHub repo on your account so friends can install it with a code or link"
            >
              <Share2 size={11} /> Share this pack
            </button>
          )}
        </div>
        {activeProfile && (
          <div className="gf-hero-shortcut-tip">
            Tip: press <kbd className="gf-kbd">Ctrl</kbd>+<kbd className="gf-kbd">L</kbd> from anywhere to launch this pack.
          </div>
        )}
      </div>

      {/* Quick Add — code only */}
      <div
        ref={codeBarRef}
        className={`gf-quickadd${codeBarPulse ? ' gf-quickadd-pulse' : ''}`}
      >
        <div className="gf-quickadd-eyebrow">Drop a code, hit Add</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
          <input
            ref={codeInputRef}
            className="gf-input-hero"
            placeholder="username/AA5A-315D-61AE"
            value={profileCode}
            onChange={(e) => setProfileCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleImportCode()}
            disabled={importing}
          />
          <button
            className="gf-btn"
            onClick={handleImportCode}
            disabled={importing || !profileCode.trim()}
          >
            <Plus size={12} /> Add Pack
          </button>
        </div>
      </div>

      {/* Other packs */}
      {otherSubs.length > 0 && (
        <>
          <div className="gf-section-head">
            <div className="gf-section-eyebrow">
              Your other packs · {otherSubs.length}
            </div>
            <button
              type="button"
              onClick={() => onGoToProfiles?.()}
              className="gf-link-button"
              title="Open the Profiles page to manage every pack"
            >
              View all in Profiles <ChevronRight size={12} style={{ display: 'inline', verticalAlign: 'middle' }} />
            </button>
          </div>

          {otherSubs.map((sub) => {
            const update = subUpdates.find((s) => s.share_id === sub.share_id);
            const updateCount = update
              ? (update.added_mods.length || 0) + (update.updated_mods.length || 0) + (update.removed_mods.length || 0)
              : 0;
            const initials = packInitials(sub.profile_name);
            const prettyCode = formatShareCode(sub.share_id);
            // The code (raw) and the sts2mm:// message are interchangeable
            // ways to share this pack. Both available inline on every
            // row so the user doesn't have to navigate elsewhere to pass
            // it along.
            const handleCopyCode = async () => {
              try {
                await navigator.clipboard.writeText(prettyCode);
                toast.success(`Copied ${prettyCode}`);
              } catch {
                toast.error("Couldn't copy to clipboard");
              }
            };
            const handleCopyLink = async () => {
              try {
                await navigator.clipboard.writeText(buildShareLink(prettyCode));
                toast.success('Install link copied — paste into Discord / chat');
              } catch {
                toast.error("Couldn't copy to clipboard");
              }
            };
            const handleCopyMsg = async () => {
              try {
                await navigator.clipboard.writeText(buildShareMessage(sub.profile_name, prettyCode));
                toast.success('Share message copied — paste into Discord / chat');
              } catch {
                toast.error("Couldn't copy to clipboard");
              }
            };
            return (
              <div key={sub.share_id} className="gf-pack-row">
                <div className="gf-pack-avatar">{initials || 'P'}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{sub.profile_name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 2 }}>
                    {prettyCode} · {sub.curator ? `by ${sub.curator}` : 'community'} · last synced{' '}
                    {new Date(sub.last_synced).toLocaleDateString()}
                  </div>
                </div>
                {updateCount > 0 && (
                  <span className="gf-pill gf-pill-update">{updateCount} updates</span>
                )}
                <button
                  className="gf-btn-3 gf-btn-icon"
                  title={`Copy share code (${prettyCode})`}
                  onClick={handleCopyCode}
                >
                  <Copy size={12} />
                </button>
                <button
                  className="gf-btn-3 gf-btn-icon"
                  title="Copy install link — clickable in Discord / chat, routes friends through the install bridge"
                  onClick={handleCopyLink}
                >
                  <LinkIcon size={12} />
                </button>
                <button
                  className="gf-btn-3 gf-btn-icon"
                  title="Copy full share message — intro line + install link + raw code"
                  onClick={handleCopyMsg}
                >
                  <MessageSquare size={12} />
                </button>
                <button
                  className="gf-btn-2 gf-btn-2-sm"
                  onClick={() => handleActivateModpack(sub.profile_name)}
                  disabled={activatingProfile === sub.profile_name}
                  title="Switch to this pack"
                >
                  {activatingProfile === sub.profile_name ? (
                    <RefreshCw size={11} className="animate-spin" />
                  ) : (
                    <Play size={11} />
                  )}
                  Activate
                </button>
                <button
                  className="gf-btn-3 gf-btn-icon"
                  title="Wipe and reinstall"
                  onClick={() => handleRepairModpack(sub.share_id)}
                  disabled={repairingShareId === sub.share_id}
                >
                  {repairingShareId === sub.share_id ? (
                    <RefreshCw size={12} className="animate-spin" />
                  ) : (
                    <Wrench size={12} />
                  )}
                </button>
                <button
                  className="gf-btn-3 gf-btn-icon gf-btn-danger"
                  title="Unlink from this pack"
                  onClick={() => handleUnsubscribe(sub.share_id, sub.profile_name)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}
        </>
      )}

      {/* Pending update banner for non-active subs */}
      {subUpdates.filter((s) => s.profile_name !== activeProfile).length > 0 && (
        <>
          <div className="gf-section-head">
            <div className="gf-section-eyebrow">Updates available</div>
          </div>
          {subUpdates
            .filter((s) => s.profile_name !== activeProfile)
            .map((sub) => (
              <div
                key={sub.share_id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '11px 14px',
                  background: 'var(--gf-tint)',
                  border: '1px solid var(--gf-line)',
                  borderRadius: 8,
                  marginBottom: 6,
                }}
              >
                <AlertTriangle size={14} style={{ color: 'var(--gf)' }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{sub.profile_name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 2 }}>
                    {sub.added_mods.length > 0 && <span style={{ color: 'var(--ok)' }}>+{sub.added_mods.length} new </span>}
                    {sub.updated_mods.length > 0 && <span style={{ color: 'var(--gf)' }}>{sub.updated_mods.length} updated </span>}
                    {sub.removed_mods.length > 0 && <span style={{ color: 'var(--danger)' }}>-{sub.removed_mods.length} removed</span>}
                  </div>
                </div>
                <button
                  className="gf-btn-2 gf-btn-2-sm"
                  onClick={() => setUpdateDetail(sub)}
                  disabled={applyingSub === sub.share_id}
                >
                  Review
                </button>
                <button
                  className="gf-btn gf-btn-sm"
                  onClick={() => handleApplySubUpdate(sub.share_id)}
                  disabled={applyingSub === sub.share_id}
                >
                  {applyingSub === sub.share_id ? <RefreshCw size={11} className="animate-spin" /> : <Download size={11} />}
                  Sync
                </button>
              </div>
            ))}
        </>
      )}

      {/* Empty state — no packs yet */}
      {subscriptions.length === 0 && (
        <>
          <div className="gf-section-head">
            <div className="gf-section-eyebrow">Your packs</div>
          </div>
          <div className="gf-empty-card">
            <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--indigo-elev)', display: 'grid', placeItems: 'center', fontSize: 18 }}>
              <Plus size={16} />
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>Follow a friend's pack</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-dim)' }}>Paste their share code in the box above.</div>
          </div>
        </>
      )}

      {/* About — Home footer. Reference info + support actions, low
          visual weight, separator rule on top. */}
      <AboutCard />

      <SubUpdateDetail
        open={!!updateDetail}
        update={updateDetail}
        applying={updateDetail ? applyingSub === updateDetail.share_id : false}
        onClose={() => setUpdateDetail(null)}
        onApply={async (shareId) => {
          await handleApplySubUpdate(shareId);
          setUpdateDetail(null);
        }}
      />

      {/* PublishModal driven from the hero's "Share this pack" CTA. The
          modal handles its own token pre-flight, progress, and
          success state — we just need to refresh share info on close
          so the chip immediately renders the new code. */}
      <PublishModal
        open={!!publishTarget}
        profile={publishTarget?.profile ?? null}
        isReshare={publishTarget?.isReshare ?? false}
        onGoToSettings={onGoToSettings}
        onClose={async () => {
          setPublishTarget(null);
          if (activeProfile) {
            try {
              const info = await getShareInfo(activeProfile);
              setActiveProfileShare(info);
            } catch { /* leave stale; harmless */ }
          }
        }}
        onShared={(result) => {
          // Immediately flip the hero to the share-code chip without
          // waiting for the close handler.
          setActiveProfileShare(result);
        }}
      />
    </div>
  );
}
