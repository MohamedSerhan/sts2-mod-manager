import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  RefreshCw,
  Gamepad2,
  Settings,
  Play,
  Wrench,
  Share2,
  Copy,
  Check,
  MessageSquare,
  Link as LinkIcon,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useClipboard } from '../hooks/useClipboard';
import { useConfirm } from '../components/ConfirmDialog';
import { SubUpdateDetail } from '../components/SubUpdateDetail';
import { WhatsNewCard } from '../components/WhatsNewCard';
import {
  checkSubscriptionUpdates,
  applySubscriptionUpdate,
  getSubscriptions,
  switchProfile,
  repairProfile,
  getProfileDrift,
  createBackup,
} from '../hooks/useTauri';
import { buildShareMessage, buildShareLink } from '../lib/shareImport';
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
  // useClipboard centralises the navigator.clipboard.writeText + toast +
  // copied-state-reset triplet that previously lived inline here, in
  // Profiles, and in PublishModal. The `kind` arg lets each chip
  // highlight itself when active.
  const { copy, copied } = useClipboard({ resetMs: 1600 });

  const link = buildShareLink(code);
  const message = buildShareMessage(packName, code, t);

  async function copyTo(kind: 'code' | 'link' | 'msg', value: string, label: string) {
    await copy(value, kind, {
      successMessage: label,
      // The previous inline handler used `profiles.toast.cantCopyToClipboard`
      // for failures — keep that exact key so the wording the user already
      // saw on failure stays unchanged.
      failureMessage: 'profiles.toast.cantCopyToClipboard',
    });
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

// v7 — Single-block launcher Home. The hero IS the page: active modpack
// with Play + contextual pills, OR an empty-state pointing to Modpacks.
// Quick-Add code paste relocated to the Modpacks toolbar where modpack
// management already lives. The Other Packs list, About Card, and
// secondary cards are gone — Modpacks page handles that surface.
interface HomeProps {
  onGoToSettings: () => void;
  /** Kept in the props shape for callers that still pass it (App.tsx
   *  wires it through). The hero no longer has a "Manage mods" button
   *  in 1.7's launcher-first redesign, so this prop is now a no-op
   *  inside Home itself — but removing it from the type would force a
   *  cascade through every render-site for no behavioral gain. */
  onGoToMods?: () => void;
  /** Navigates to the Modpacks page (Yours tab). Used by the empty-state
   *  hero's single CTA — Modpacks owns Quick-Add, Create, and Browse
   *  now, so one button gets the user to all three flows. */
  onGoToProfiles?: () => void;
  /** Retired in 1.7 v7 — Browse is reached via the Modpacks page's
   *  Browse tab. Kept in the type for backward-compatible call sites
   *  (App.tsx still passes it). */
  onGoToBrowseModpacks?: () => void;
  onSwitchPack?: () => void;
  onLaunch?: () => void;
}
export function HomeView({ onGoToSettings, onGoToMods: _onGoToMods, onGoToProfiles, onGoToBrowseModpacks: _onGoToBrowseModpacks, onSwitchPack, onLaunch }: HomeProps) {
  const { t } = useTranslation();
  const { gameInfo, mods, refreshAll, activeProfile, refreshSubUpdates } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [subUpdates, setSubUpdates] = useState<SubscriptionUpdate[]>([]);
  const [applyingSub, setApplyingSub] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [, setChecking] = useState(false);
  const [updateDetail, setUpdateDetail] = useState<SubscriptionUpdate | null>(null);
  const [repairing, setRepairing] = useState(false);
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

  /** Open PublishModal for the active modpack — used by the hero's
   *  Share button. Looks up the on-disk Profile so PublishModal gets
   *  the exact same shape it sees from Profiles view. */
  async function openPublishForActive(profileName?: string) {
    const target = profileName ?? activeProfile;
    if (!target) return;
    try {
      const list = await listProfiles();
      const p = list.find((q) => q.name === target);
      if (p) setPublishTarget({ profile: p, isReshare: false });
      else toast.error(t('home.toast.profileNotFoundOnDisk'));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('home.toast.couldntLoadProfile', { error: errMsg }));
    }
  }

  // Silence the unused-var warning for `switchProfile`: kept available
  // for future hero secondary actions (still imported because we may
  // wire a "switch via hero shortcut" in a later iteration).
  void switchProfile;

  const enabledMods = mods.filter((m) => m.enabled);
  const activeSub = subscriptions.find((s) => s.profile_name === activeProfile);
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
  // hasn't been published yet — drives the "Share this pack" CTA and
  // the "Not yet shared" pill.
  const canShareActive = !!activeProfile && !activeSub && !activeProfileShare;

  return (
    <div className="gf-body">
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

      {/* Hero — single-block launcher. Two shapes:
            · Active modpack       → name + mod count + Play (one big CTA)
                                     plus pill row (sync/unshared) and
                                     small secondary actions.
            · No active modpack    → friendly empty-state with ONE primary
                                     CTA — "Open Modpacks". Modpacks page
                                     owns Quick-Add / Create / Browse, so
                                     one button gets you to all three.
          Quick-Add code paste, Other Packs list, and About Card all
          left Home in 1.7 v7. Home is the launcher; Modpacks is where
          you manage modpacks. */}
      {activeProfile ? (
        <div className="gf-hero gf-hero-active">
          <div className="gf-hero-eyebrow">{t('home.continueWith')}</div>
          <div className="gf-hero-active-row">
            <div className="gf-hero-active-meta">
              <div className="gf-hero-title">
                {heroName}
                <span className="gf-pill gf-pill-active">{t('common.active')}</span>
              </div>
              <div className="gf-hero-meta">
                {t('home.heroModCount', { count: enabledMods.length })}
              </div>
              <div className="gf-hero-pills">
                {activeUpdate && (
                  <span className="gf-pill gf-pill-update">{t('home.syncPillReady')}</span>
                )}
                {canShareActive && (
                  <span className="gf-pill gf-pill-warn">{t('home.sharePillReady')}</span>
                )}
              </div>
            </div>
            <button
              className="gf-btn gf-btn-lg gf-hero-play"
              onClick={onLaunch}
              disabled={!onLaunch}
              title={onLaunch ? t('home.launchTitle') : t('home.noLaunchTitle')}
            >
              <Play size={14} fill="currentColor" /> {t('app.launch.modded')}
            </button>
          </div>

          {heroCode && <ShareCodeChip code={heroCode} packName={heroName} />}

          <div className="gf-hero-actions">
            <button
              className="gf-btn-2"
              onClick={onSwitchPack}
              title={t('home.switchPackTitle')}
            >
              {t('app.switchActivePack')}
            </button>
            {activeUpdate && (
              <button
                className="gf-btn-2"
                onClick={() => handleApplySubUpdate(activeUpdate.share_id)}
                disabled={applyingSub === activeUpdate.share_id}
                title={t('home.syncUpdates')}
              >
                {applyingSub === activeUpdate.share_id ? (
                  <RefreshCw size={11} className="animate-spin" />
                ) : (
                  <Download size={11} />
                )}
                {t('home.heroSyncBtn')}
              </button>
            )}
            {activeUpdate && (
              <button
                className="gf-btn-3"
                onClick={() => setUpdateDetail(activeUpdate)}
                disabled={applyingSub === activeUpdate.share_id}
              >
                {t('home.viewChanges')}
              </button>
            )}
            {/* Repair only as a quiet secondary action — kept so users
                with drift can still recover from Home without bouncing
                to Profiles. */}
            <button
              className="gf-btn-3"
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
            {/* Share-this-pack CTA — only renders when the active modpack
                is the user's own and hasn't been published yet. After
                publishing, the ShareCodeChip above takes over and this
                button collapses. */}
            {canShareActive && (
              <button
                className="gf-btn-2"
                onClick={() => openPublishForActive()}
                title={t('home.shareThisPackTitle')}
              >
                <Share2 size={11} /> {t('modpack.share')}
              </button>
            )}
          </div>
          <div className="gf-hero-shortcut-tip">
            {t('home.shortcutTip', { shortcut: 'Ctrl+L' })}
          </div>
        </div>
      ) : (
        <div className="gf-hero gf-hero-empty">
          <h1 className="gf-hero-empty-title">{t('home.heroEmptyTitle')}</h1>
          <p className="gf-hero-empty-body">{t('home.heroEmptyBody')}</p>
          <div className="gf-hero-empty-ctas">
            <button
              type="button"
              className="gf-btn gf-btn-lg"
              onClick={() => onGoToProfiles?.()}
            >
              {t('home.heroEmptyCta')}
            </button>
          </div>
        </div>
      )}

      {/* Pending updates for non-active modpacks are surfaced in the
          Modpacks page (Activity feed in the Yours tab). The active
          modpack's pending update is the "Sync available" pill +
          secondary buttons in the hero above. */}

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
