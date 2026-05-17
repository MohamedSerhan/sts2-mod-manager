import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const [copied, setCopied] = useState<'code' | 'link' | 'msg' | null>(null);
  const toast = useToast();

  const link = buildShareLink(code);
  const message = buildShareMessage(packName, code, t);

  async function copyTo(kind: 'code' | 'link' | 'msg', value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      toast.success(label);
      window.setTimeout(() => setCopied(null), 1600);
    } catch (e) {
      toast.error(t('profiles.toast.cantCopyToClipboard'));
    }
  }

  return (
    <div className="gf-sharecode-row">
      <button
        type="button"
        className={`gf-sharecode-chip${copied === 'code' ? ' is-copied' : ''}`}
        onClick={() => copyTo('code', code, t('profiles.toast.shareCodeCopied'))}
        title={t('home.clickToCopyShareCode')}
      >
        <span className="gf-sharecode-eyebrow">{t('home.hero.title')}</span>
        <span className="gf-sharecode-value">{code}</span>
        <span className="gf-sharecode-action">
          {copied === 'code' ? (
            <><Check size={13} /> {t('common.copied')}</>
          ) : (
            <><Copy size={13} /> {t('common.copy')}</>
          )}
        </span>
      </button>
      <button
        type="button"
        className={`gf-sharecode-msg-btn${copied === 'link' ? ' is-copied' : ''}`}
        onClick={() => copyTo('link', link, t('profiles.toast.installLinkCopied'))}
        title={t('home.copyLinkTitle', { link })}
      >
        {copied === 'link' ? (
          <><Check size={13} /> {t('home.copiedLink')}</>
        ) : (
          <><LinkIcon size={13} /> {t('home.copyLink')}</>
        )}
      </button>
      <button
        type="button"
        className={`gf-sharecode-msg-btn${copied === 'msg' ? ' is-copied' : ''}`}
        onClick={() => copyTo('msg', message, t('profiles.toast.shareMessageCopied'))}
        title={t('home.copyMessageTitle', { message })}
      >
        {copied === 'msg' ? (
          <><Check size={13} /> {t('home.copiedMessage')}</>
        ) : (
          <><MessageSquare size={13} /> {t('home.copyMessage')}</>
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
  const { t } = useTranslation();
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
        toast.success(t('home.toast.allUpToDate'));
      }
    } catch (e) {
      if (showToast) {
        const errMsg = e instanceof Error ? e.message : String(e);
        toast.error(t('home.toast.checkFailed', { error: errMsg }));
      }
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
        t,
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
          toast.info(t('home.toast.installedPartial', {
            installed: outcome.profile.mods.length - missing.length,
            total: outcome.profile.mods.length,
            missing: missing.map(m => m.name).join(', '),
          }));
        } else {
          toast.success(t('home.toast.installedModpack', { name: outcome.profile.name, count: outcome.profile.mods.length }));
        }
      } else if (outcome.kind === 'activated') {
        toast.success(t('profiles.toast.activated', { name: outcome.profileName }));
      } else if (outcome.kind === 'reapplied') {
        const parts: string[] = [];
        if (outcome.result.downloaded > 0) parts.push(t('common.parts.downloaded', { count: outcome.result.downloaded }));
        if (outcome.result.failed_downloads.length > 0) parts.push(t('common.parts.failed', { count: outcome.result.failed_downloads.length }));
        if (outcome.result.missing_mods.length > 0) parts.push(t('common.parts.stillMissing', { count: outcome.result.missing_mods.length }));
        toast.info(parts.length
          ? t('profiles.toast.reappliedWithDetails', { name: outcome.profileName, details: parts.join(', ') })
          : t('profiles.toast.reapplied', { name: outcome.profileName }));
      } else if (outcome.kind === 'synced') {
        toast.success(t('profiles.toast.syncedUpToDate', { name: outcome.profileName }));
      } else if (outcome.kind === 'already-active') {
        toast.info(t('profiles.toast.alreadyActive', { name: outcome.profileName }));
      }
      setProfileCode('');
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('profiles.toast.importFailed', { error: errMsg }));
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
      toast.success(t('home.toast.syncedModpack', { name: profile.name }));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('profiles.toast.syncFailed', { error: errMsg }));
    } finally {
      setApplyingSub(null);
    }
  }

  async function handleUnsubscribe(shareId: string, profileName: string) {
    const ok = await confirm({
      title: t('home.unlinkTitle', { name: profileName }),
      body: t('home.unlinkBody'),
      confirmLabel: t('home.unlink'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await unsubscribe(shareId);
      setSubscriptions((prev) => prev.filter((s) => s.share_id !== shareId));
      setSubUpdates((prev) => prev.filter((s) => s.share_id !== shareId));
      refreshSubUpdates();
      toast.success(t('home.toast.unlinked', { name: profileName }));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('home.toast.failed', { error: errMsg }));
    }
  }

  async function handleRepairModpack(shareId: string) {
    const ok = await confirm({
      title: t('home.repairPackTitle'),
      body: t('home.repairPackBody'),
      checkbox: { label: t('home.repairPackBackupLabel'), defaultChecked: true },
      confirmLabel: t('home.repair'),
      destructive: true,
    });
    if (!ok) return;
    try {
      setRepairingShareId(shareId);
      await repairModpackSubscription(shareId);
      await refreshAll();
      toast.success(t('home.toast.reinstalled'));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('profiles.toast.repairFailed', { error: errMsg }));
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
      title: t('home.repairOrphanTitle', { name }),
      body: orphanCount > 0
        ? t('home.repairOrphanBody', { count: orphanCount, list: orphanList })
        : t('home.repairOrphanBodyNoOrphans'),
      warning: orphanCount > 0
        ? t('home.repairOrphanWarning')
        : undefined,
      confirmLabel: t('home.repair'),
      destructive: orphanCount > 0,
      checkbox: orphanCount > 0
        ? { label: t('home.repairPackBackupLabel'), defaultChecked: true }
        : undefined,
    });
    if (!ok) return;

    setRepairing(true);
    try {
      if (ok.checked) {
        try { await createBackup(); }
        catch (e) { const errMsg = e instanceof Error ? e.message : String(e); toast.error(t('profiles.toast.backupFailed', { error: errMsg })); }
      }
      const result = await repairProfile(name);
      await refreshAll();
      const summary: string[] = [];
      if (result.deleted_orphans.length > 0) {
        summary.push(t('common.parts.removedOrphans', { count: result.deleted_orphans.length }));
      }
      if (result.downloaded > 0) summary.push(t('common.parts.downloadedNum', { count: result.downloaded }));
      if (result.failed_downloads.length > 0) summary.push(t('common.parts.downloadsFailed', { count: result.failed_downloads.length }));
      if (result.missing_mods.length > 0) summary.push(t('common.parts.stillMissing', { count: result.missing_mods.length }));
      toast.success(summary.length
        ? t('profiles.toast.repairedWithDetails', { name, details: summary.join(', ') })
        : t('profiles.toast.repaired', { name }));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('profiles.toast.repairFailed', { error: errMsg }));
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
            title: t('home.switchAwayTitle', { name: activeProfile }),
            body: t('home.switchAwayBody'),
            warning: t('home.switchAwayWarning'),
            confirmLabel: t('home.switchAnyway'),
            cancelLabel: t('home.stayHere'),
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
        toast.info(t('home.toast.activatedWithDetails', {
          name: profileName,
          downloaded: result.downloaded,
          missing: result.missing_mods.length,
        }));
      } else {
        toast.success(t('home.toast.activated', { name: profileName }));
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('home.toast.failed', { error: errMsg }));
    } finally {
      setActivatingProfile(null);
    }
  }

  const enabledMods = mods.filter((m) => m.enabled);
  const activeSub = subscriptions.find((s) => s.profile_name === activeProfile);
  const otherSubs = subscriptions.filter((s) => s.profile_name !== activeProfile);
  const activeUpdate = subUpdates.find((s) => s.profile_name === activeProfile);

  const heroName = activeProfile || t('home.heroNameVanilla');
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
    ? t('home.heroMetaSubscribed', { count: enabledMods.length, date: new Date(activeSub.last_synced).toLocaleDateString() })
    : activeProfileShare
    ? t('home.heroMetaOwn', { count: enabledMods.length })
    : t('home.heroMetaLocal', { count: enabledMods.length, type: activeProfile ? t('home.heroMetaLocalProfile') : t('home.heroMetaBuiltinVanilla') });

  return (
    <div className="gf-body">
      {/* Importing overlay */}
      {importing && (
        <div className="gf-onb">
          <div className="gf-onb-card" style={{ width: 380, textAlign: 'center' }}>
            <RefreshCw size={32} className="mx-auto mb-3" style={{ color: 'var(--gf)', animation: 'spin 1s linear infinite' }} />
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>{t('common.installing')}</h3>
            <p style={{ fontSize: 13, color: 'var(--ink-mute)' }}>{t('home.importingOverlayTitle')}</p>
            <p style={{ fontSize: 12, color: 'var(--ink-dim)', marginTop: 6 }}>{t('home.importingOverlaySubtext')}</p>
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
            <div style={{ fontWeight: 600 }}>{t('home.gameNotDetected')}</div>
            <div style={{ fontSize: 12, opacity: 0.85 }}>
              {t('home.gameNotDetectedDesc')}
            </div>
          </div>
          <button className="gf-btn-3" onClick={onGoToSettings}>
            <Settings size={12} /> {t('nav.settings')}
          </button>
        </div>
      )}

      {/* Hero — single "Continue with" pattern */}
      <div className="gf-hero">
        <div className="gf-hero-eyebrow">{t('home.continueWith')}</div>
        <div className="gf-hero-title">
          {heroName}
          <span className="gf-pill gf-pill-active">{t('common.active')}</span>
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
              {t('home.updateAvailableCount', { count: (activeUpdate.added_mods.length || 0) + (activeUpdate.updated_mods.length || 0) + (activeUpdate.removed_mods.length || 0) })}
            </span>
            <button
              className="gf-btn-2 gf-btn-2-sm"
              onClick={() => setUpdateDetail(activeUpdate)}
              disabled={applyingSub === activeUpdate.share_id}
            >
              {t('home.viewChanges')}
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
              {t('home.syncUpdates')}
            </button>
          </div>
        )}

        <div className="gf-hero-actions">
          <button
            className="gf-btn gf-btn-lg"
            onClick={onLaunch}
            disabled={!onLaunch}
            title={onLaunch ? t('home.launchTitle') : t('home.noLaunchTitle')}
          >
            <Play size={11} fill="currentColor" /> {t('home.launchWithPack')}
          </button>
          <button
            className="gf-btn-2"
            onClick={onGoToMods}
            title={t('home.manageModsTitle')}
          >
            {t('home.manageMods')}
          </button>
          <button
            className="gf-btn-2"
            onClick={onSwitchPack}
            title={t('home.switchPackTitle')}
          >
            {t('home.switchPack')}
          </button>
          {activeProfile && (
            <button
              className="gf-btn-2"
              onClick={() => handleRepair(activeProfile)}
              disabled={repairing}
              title={t('home.reapplyTitle')}
            >
              {repairing ? (
                <RefreshCw size={11} className="animate-spin" />
              ) : (
                <Wrench size={11} />
              )}
              {repairing ? t('home.repairing') : t('home.repair')}
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
                  else toast.error(t('home.toast.profileNotFoundOnDisk'));
                } catch (e) {
                  const errMsg = e instanceof Error ? e.message : String(e);
                  toast.error(t('home.toast.couldntLoadProfile', { error: errMsg }));
                }
              }}
              title={t('home.shareThisPackTitle')}
            >
              <Share2 size={11} /> {t('home.shareThisPack')}
            </button>
          )}
        </div>
        {activeProfile && (
          <div className="gf-hero-shortcut-tip">
            {t('home.shortcutTip', { shortcut: 'Ctrl+L' })}
          </div>
        )}
      </div>

      {/* Quick Add — code only */}
      <div
        ref={codeBarRef}
        className={`gf-quickadd${codeBarPulse ? ' gf-quickadd-pulse' : ''}`}
      >
        <div className="gf-quickadd-eyebrow">{t('home.quickAddHeading')}</div>
        <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
          <input
            ref={codeInputRef}
            className="gf-input-hero"
            placeholder={t('home.hero.placeholder')}
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
            <Plus size={12} /> {t('home.quickAdd.add')}
          </button>
        </div>
      </div>

      {/* Other packs */}
      {otherSubs.length > 0 && (
        <>
          <div className="gf-section-head">
            <div className="gf-section-eyebrow">
              {t('home.yourOtherPacks')} · {otherSubs.length}
            </div>
            <button
              type="button"
              onClick={() => onGoToProfiles?.()}
              className="gf-link-button"
              title={t('home.viewAllInProfilesTitle')}
            >
              {t('home.viewAllInProfiles')} <ChevronRight size={12} style={{ display: 'inline', verticalAlign: 'middle' }} />
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
                toast.success(t('home.toast.codeCopied', { code: prettyCode }));
              } catch {
                toast.error(t('profiles.toast.cantCopyToClipboard'));
              }
            };
            const handleCopyLink = async () => {
              try {
                await navigator.clipboard.writeText(buildShareLink(prettyCode));
                toast.success(t('profiles.toast.installLinkCopied'));
              } catch {
                toast.error(t('profiles.toast.cantCopyToClipboard'));
              }
            };
            const handleCopyMsg = async () => {
              try {
                await navigator.clipboard.writeText(buildShareMessage(sub.profile_name, prettyCode, t));
                toast.success(t('profiles.toast.shareMessageCopied'));
              } catch {
                toast.error(t('profiles.toast.cantCopyToClipboard'));
              }
            };
            return (
              <div key={sub.share_id} className="gf-pack-row">
                <div className="gf-pack-avatar">{initials || 'P'}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600 }}>{sub.profile_name}</div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-mute)', marginTop: 2 }}>
                    {prettyCode} · {sub.curator !== null ? t('home.byCurator', { curator: sub.curator }) : t('home.community')} · {t('home.lastSynced')}{' '}
                    {new Date(sub.last_synced).toLocaleDateString()}
                  </div>
                </div>
                {updateCount > 0 && (
                  <span className="gf-pill gf-pill-update">{t('home.updatesPill', { count: updateCount })}</span>
                )}
                <button
                  className="gf-btn-3 gf-btn-icon"
                  title={t('home.copyShareCodeTitle', { code: prettyCode })}
                  onClick={handleCopyCode}
                >
                  <Copy size={12} />
                </button>
                <button
                  className="gf-btn-3 gf-btn-icon"
                  title={t('home.copyInstallLinkTitle')}
                  onClick={handleCopyLink}
                >
                  <LinkIcon size={12} />
                </button>
                <button
                  className="gf-btn-3 gf-btn-icon"
                  title={t('home.copyFullMessageTitle')}
                  onClick={handleCopyMsg}
                >
                  <MessageSquare size={12} />
                </button>
                <button
                  className="gf-btn-2 gf-btn-2-sm"
                  onClick={() => handleActivateModpack(sub.profile_name)}
                  disabled={activatingProfile === sub.profile_name}
                  title={t('home.switchToPack')}
                >
                  {activatingProfile === sub.profile_name ? (
                    <RefreshCw size={11} className="animate-spin" />
                  ) : (
                    <Play size={11} />
                  )}
                  {t('common.activate')}
                </button>
                <button
                  className="gf-btn-3 gf-btn-icon"
                  title={t('home.wipeAndReinstall')}
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
                  title={t('home.unlinkFromPack')}
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
            <div className="gf-section-eyebrow">{t('home.pendingUpdates')}</div>
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
                    {sub.added_mods.length > 0 && <span style={{ color: 'var(--ok)' }}>+{sub.added_mods.length}{t('home.newLabel')} </span>}
                    {sub.updated_mods.length > 0 && <span style={{ color: 'var(--gf)' }}>{sub.updated_mods.length}{t('home.updatedLabel')} </span>}
                    {sub.removed_mods.length > 0 && <span style={{ color: 'var(--danger)' }}>-{sub.removed_mods.length}{t('home.removedLabel')}</span>}
                  </div>
                </div>
                <button
                  className="gf-btn-2 gf-btn-2-sm"
                  onClick={() => setUpdateDetail(sub)}
                  disabled={applyingSub === sub.share_id}
                >
                  {t('home.review')}
                </button>
                <button
                  className="gf-btn gf-btn-sm"
                  onClick={() => handleApplySubUpdate(sub.share_id)}
                  disabled={applyingSub === sub.share_id}
                >
                  {applyingSub === sub.share_id ? <RefreshCw size={11} className="animate-spin" /> : <Download size={11} />}
                  {t('home.sync')}
                </button>
              </div>
            ))}
        </>
      )}

      {/* Empty state — no packs yet */}
      {subscriptions.length === 0 && (
        <>
          <div className="gf-section-head">
            <div className="gf-section-eyebrow">{t('home.yourPacks')}</div>
          </div>
          <div className="gf-empty-card">
            <div style={{ width: 36, height: 36, borderRadius: 8, background: 'var(--indigo-elev)', display: 'grid', placeItems: 'center', fontSize: 18 }}>
              <Plus size={16} />
            </div>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>{t('home.followFriendsPack')}</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-dim)' }}>{t('home.pasteCodeAbove')}</div>
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
