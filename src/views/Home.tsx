import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Download,
  RefreshCw,
  Gamepad2,
  Settings,
  Play,
  Share2,
  Copy,
  Check,
  MessageSquare,
  Link as LinkIcon,
  Plus,
  History,
} from 'lucide-react';
import { useApp } from '../contexts/AppContext';
import { useToast } from '../contexts/ToastContext';
import { useClipboard } from '../hooks/useClipboard';
import { useConfirm } from '../components/ConfirmDialog';
import { SubUpdateDetail } from '../components/SubUpdateDetail';
import { WhatsNewCard } from '../components/WhatsNewCard';
import { AboutCard } from '../components/AboutCard';
import {
  checkSubscriptionUpdates,
  applySubscriptionUpdate,
  getSubscriptions,
  getShareInfo,
  listProfiles,
  switchProfile,
  getProfileDrift,
} from '../hooks/useTauri';
import { buildShareMessage, buildShareLink, importShareCodeSmart } from '../lib/shareImport';
import { switchResultDetails, switchResultHasProblems } from '../lib/switchResultSummary';
import { getModpackLastLaunch, recordModpackLaunch } from '../lib/modpackUsage';
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
  /** Opens the Modpacks page and the guided Create-modpack wizard. */
  onCreateModpack?: () => void;
  onLaunch?: () => void;
  onBlockingOperationChange?: (busy: boolean) => void;
}
export function HomeView({ onGoToSettings, onGoToMods: _onGoToMods, onGoToProfiles, onGoToBrowseModpacks, onCreateModpack, onLaunch, onBlockingOperationChange }: HomeProps) {
  const { t } = useTranslation();
  const { gameInfo, mods, refreshAll, activeProfile, activeProfileId, setActiveProfile, refreshSubUpdates } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [subUpdates, setSubUpdates] = useState<SubscriptionUpdate[]>([]);
  // Empty-state Quick-Add — paste a friend's share code right on Home.
  const [importCode, setImportCode] = useState('');
  const [importingCode, setImportingCode] = useState(false);
  const [applyingSub, setApplyingSub] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([]);
  const [updateDetail, setUpdateDetail] = useState<SubscriptionUpdate | null>(null);
  // Share info for the curator's OWN active profile (separate from
  // `activeSub` which only covers profiles received from someone else).
  // Without this, a curator looking at their own published pack on Home
  // saw no chip at all because the chip was gated on activeSub.
  const [activeProfileShare, setActiveProfileShare] = useState<ShareResult | null>(null);
  // PublishModal target. When the active profile isn't published yet,
  // the hero gets a "Share this pack" button that opens the modal
  // directly on Home (no detour through Profiles).
  const [publishTarget, setPublishTarget] = useState<{ profile: Profile; isReshare: boolean } | null>(null);
  // FR5 — "Recent modpacks" quick-switch strip. Profiles on disk are used
  // to filter stale launch-history entries and enrich the shelf with counts.
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [recentSwitching, setRecentSwitching] = useState<string | null>(null);
  const activeProfileKey = activeProfileId ?? activeProfile;
  const profileKey = (profile: Profile) => profile.id || profile.name;

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
      if (!activeProfileKey) { setActiveProfileShare(null); return; }
      try {
        const info = await getShareInfo(activeProfileKey);
        if (!cancelled) setActiveProfileShare(info);
      } catch {
        if (!cancelled) setActiveProfileShare(null);
      }
    }
    loadShareInfo();
    return () => { cancelled = true; };
  }, [activeProfileKey, mods]);

  async function loadSubscriptions() {
    try {
      const subs = await getSubscriptions();
      setSubscriptions(subs);
    } catch { /* ignore */ }
  }

  // FR5 — pull the on-disk pack names so launch history can be filtered
  // to packs that still exist. Re-pull on active-profile change (covers
  // switch, install, delete-active) — cheap directory listing.
  useEffect(() => {
    let cancelled = false;
    listProfiles()
      .then((list) => { if (!cancelled) setProfiles(list); })
      .catch(() => { /* keep last known names */ });
    return () => { cancelled = true; };
  }, [activeProfileKey]);

  // Up to 3 recently launched packs, excluding the one already active.
  const recent = useMemo(() => {
    const isActiveProfile = (profile: Profile) =>
      profileKey(profile) === activeProfileKey ||
      (activeProfileId == null && profile.name === activeProfile);
    return profiles
      .map((profile) => ({
        key: profileKey(profile),
        lastPlayed: getModpackLastLaunch(profile),
        profile,
      }))
      .filter((item) => item.lastPlayed > 0 && !isActiveProfile(item.profile))
      .sort((a, b) => b.lastPlayed - a.lastPlayed)
      .slice(0, 3)
      .map(({ key, lastPlayed, profile }) => ({
        key,
        name: profile.name,
        lastPlayed,
        modCount: profile.mods.length,
        enabledCount: profile.mods.filter((mod) => mod.enabled).length,
      }));
  }, [activeProfile, activeProfileId, activeProfileKey, profiles]);

  const formatRecentDate = (ts: number) =>
    new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(ts));

  /** FR5 — one-click switch from the Recent strip. Mirrors Profiles'
   *  handleSwitch semantics: warn when the current active pack has
   *  unsaved drift, record the launch, refresh app state. */
  async function handleQuickSwitch(key: string) {
    if (recentSwitching) return;
    const target = profiles.find((profile) => profileKey(profile) === key || profile.name === key);
    const targetName = target?.name ?? key;
    if (activeProfile && activeProfileKey) {
      try {
        const drift = await getProfileDrift(activeProfileKey);
        if (drift?.has_drift) {
          const ok = await confirm({
            title: t('profiles.confirm.switch.title', { name: activeProfile }),
            body: t('profiles.confirm.switch.body'),
            warning: t('profiles.confirm.switch.warning'),
            confirmLabel: t('profiles.confirm.switch.confirmLabel'),
            cancelLabel: t('profiles.confirm.switch.cancelLabel'),
          });
          if (!ok) return;
        }
      } catch { /* drift lookup failed — proceed with the switch */ }
    }
    try {
      setRecentSwitching(key);
      const result = await switchProfile(key);
      setActiveProfile(key, targetName);
      recordModpackLaunch(target ?? key);
      await refreshAll();
      const parts = switchResultDetails(result, t);
      if (parts.length > 0) {
        (switchResultHasProblems(result) ? toast.error : toast.info)(parts.join('. '));
      } else {
        toast.success(t('profiles.toast.switched', { name: targetName }));
      }
    } catch (e) {
      toast.error(t('profiles.toast.switchFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setRecentSwitching(null);
    }
  }

  async function checkSubs(showToast = false) {
    try {
      const u = await checkSubscriptionUpdates();
      const updates = u.filter((s) => s.has_update);
      setSubUpdates(updates);
      /* v8 ignore start -- Home only calls checkSubs() without showToast; Settings owns manual update checks. */
      if (showToast && updates.length === 0) {
        toast.success(t('home.toast.allUpToDate'));
      }
      /* v8 ignore stop */
    } catch (e) {
      /* v8 ignore start -- Home mount polling is silent; manual failure toasts live in explicit check flows. */
      if (showToast) {
        const errMsg = e instanceof Error ? e.message : String(e);
        toast.error(t('home.toast.checkFailed', { error: errMsg }));
      }
      /* v8 ignore stop */
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

  /** Open PublishModal for the active modpack — used by the hero's
   *  Share button. Looks up the on-disk Profile so PublishModal gets
   *  the exact same shape it sees from Profiles view. */
  async function openPublishForActive(profileName?: string) {
    const target = profileName ?? activeProfileKey;
    if (!target) return;
    try {
      const list = await listProfiles();
      const p = list.find((q) => profileKey(q) === target || q.name === target);
      if (p) setPublishTarget({ profile: p, isReshare: false });
      else toast.error(t('home.toast.profileNotFoundOnDisk'));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      toast.error(t('home.toast.couldntLoadProfile', { error: errMsg }));
    }
  }

  // Import a pasted share code from the empty state — the same smart router
  // as the Modpacks Quick-Add and deep links. On success refreshAll flips Home
  // to the active-modpack hero (or a toast confirms what happened).
  async function handleImportCode() {
    const code = importCode.trim();
    if (!code) return;
    try {
      setImportingCode(true);
      const subs = await getSubscriptions().catch(() => []);
      const outcome = await importShareCodeSmart(code, {
        confirm,
        subscriptions: subs,
        activeProfile,
        activeProfileId,
        subUpdates,
        t,
        onBusyChange: onBlockingOperationChange,
      });
      if (outcome.kind === 'cancelled') return;
      setImportCode('');
      await refreshAll();
      refreshSubUpdates();
      if (outcome.kind === 'installed') {
        toast.success(
          t('profiles.toast.importedModpack', { name: outcome.profile.name, count: outcome.profile.mods.length }),
        );
      } else if (outcome.kind === 'activated') {
        const parts = switchResultDetails(outcome.result, t, { includeLists: false });
        (switchResultHasProblems(outcome.result) ? toast.error : toast.info)(
          parts.length ? parts.join(', ') : t('profiles.toast.activated', { name: outcome.profileName }),
        );
      } else if (outcome.kind === 'reapplied') {
        const parts = switchResultDetails(outcome.result, t, { includeLists: false });
        (switchResultHasProblems(outcome.result) ? toast.error : toast.info)(
          parts.length ? parts.join(', ') : t('profiles.toast.reapplied', { name: outcome.profileName }),
        );
      } else if (outcome.kind === 'synced') {
        toast.success(t('profiles.toast.syncedUpToDate', { name: outcome.profileName }));
      } else if (outcome.kind === 'already-active') {
        toast.info(t('profiles.toast.alreadyActive', { name: outcome.profileName }));
      } else if (outcome.kind === 'own-published-exists') {
        toast.info(t('profiles.toast.ownPublishedAlreadyExists', { name: outcome.profileName }));
      }
    } catch (e) {
      toast.error(t('profiles.toast.importFailed', { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setImportingCode(false);
    }
  }

  const enabledMods = mods.filter((m) => m.enabled);
  const activeSub = subscriptions.find((s) =>
    s.profile_id === activeProfileKey || s.profile_name === activeProfile
  );
  const activeUpdate = subUpdates.find((s) =>
    s.profile_id === activeProfileKey || s.profile_name === activeProfile
  );

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

          {/* Hero actions — kept tight on the launcher. "Switch modpack"
              lives in the topbar profile chip (universal); "Repair"
              lives in Modpacks → modpack detail → Advanced (the
              canonical place for power actions). What stays here is
              what's contextual to the active modpack right now:
              Sync if it has an update, Share if the user just created
              it and hasn't published yet. */}
          <div className="gf-hero-actions">
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
          {/* Got a friend's code? Paste it right here — same smart import as
              the Modpacks Quick-Add, so newcomers don't have to navigate away
              first. */}
          <div className="gf-quickadd" style={{ marginTop: 18, marginBottom: 14, maxWidth: 480 }}>
            <div className="gf-quickadd-eyebrow">{t('modpacks.quickAdd.label')}</div>
            <div style={{ display: 'flex', gap: 8, marginTop: 11 }}>
              <input
                className="gf-input-hero"
                aria-label={t('modpacks.quickAdd.label')}
                placeholder={t('modpacks.quickAdd.placeholder')}
                value={importCode}
                onChange={(e) => setImportCode(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleImportCode()}
                disabled={importingCode}
              />
              <button
                type="button"
                className="gf-btn-2"
                onClick={handleImportCode}
                disabled={importingCode || !importCode.trim()}
              >
                {importingCode ? (
                  <RefreshCw size={14} className="animate-spin" />
                ) : (
                  <Plus size={14} />
                )}
                {t('modpacks.quickAdd.addBtn')}
              </button>
            </div>
          </div>
          <div className="gf-hero-empty-ctas">
            <button
              type="button"
              className="gf-btn gf-btn-lg"
              onClick={() => onGoToProfiles?.()}
            >
              {t('home.heroEmptyCta')}
            </button>
            <button
              type="button"
              className="gf-btn-2 gf-btn-lg"
              onClick={() => onGoToBrowseModpacks?.()}
            >
              {t('home.heroEmptyBrowse')}
            </button>
          </div>
        </div>
      )}

      {/* Secondary surface between the hero and the footer (spec: Home
          shows readiness + secondary actions, not just the play button).
          Only for an active modpack — the empty-state hero already guides
          a first-time user toward Modpacks. */}
      {activeProfile && (
        <div className="gf-home-secondary">
          <div className="gf-home-secondary-actions">
            <button
              type="button"
              className="gf-btn-3"
              onClick={() => onCreateModpack?.()}
            >
              <Plus size={13} /> {t('home.secondary.create')}
            </button>
            {subUpdates.length > 0 && (
              <button
                type="button"
                className="gf-btn-3"
                onClick={() => onGoToProfiles?.()}
              >
                <Download size={13} />{' '}
                {t('home.secondary.reviewUpdates', { count: subUpdates.length })}
              </button>
            )}
          </div>
        </div>
      )}

      {/* FR5 — Recent modpacks. One-click jump back to the packs the
          user actually plays. Sourced from the local launch history
          (localStorage), filtered to packs still on disk, capped at 3,
          and never shows the already-active pack. Hidden entirely until
          there is history — first-run Home stays uncluttered. */}
      {recent.length > 0 && (
        <section className="gf-home-recent" aria-labelledby="gf-home-recent-title">
          <div className="gf-home-recent-head">
            <div>
              <h2 id="gf-home-recent-title" className="gf-home-recent-title">
                <History size={14} /> {t('home.recent.title')}
              </h2>
              <p className="gf-home-recent-hint">{t('home.recent.hint')}</p>
            </div>
          </div>
          <div className="gf-home-recent-list">
            {recent.map((item) => (
              <button
                key={item.key}
                type="button"
                className="gf-home-recent-item"
                disabled={recentSwitching !== null}
                onClick={() => handleQuickSwitch(item.key)}
                title={t('home.recent.switchTitle', { name: item.name })}
                aria-label={t('home.recent.switchTitle', { name: item.name })}
              >
                <span className="gf-home-recent-main">
                  <span className="gf-home-recent-name">{item.name}</span>
                  <span className="gf-home-recent-meta">
                    {t('home.recent.lastPlayed', { date: formatRecentDate(item.lastPlayed) })}
                  </span>
                </span>
                <span className="gf-home-recent-stats">
                  <span>{t('home.recent.modCount', { count: item.modCount })}</span>
                  <span>{t('home.recent.enabledCount', { count: item.enabledCount })}</span>
                </span>
                <span className="gf-home-recent-action" aria-hidden>
                  {recentSwitching === item.key ? (
                    <RefreshCw size={13} className="animate-spin" />
                  ) : (
                    <Play size={13} />
                  )}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      {/* Pending updates for non-active modpacks are surfaced in the
          Modpacks page (Activity feed in the Yours tab). The active
          modpack's pending update is the "Sync available" pill +
          secondary buttons in the hero above. */}

      {/* Footer with attribution + version + diagnostic-bundle access.
          Sits below the hero so the launcher feels finished, not blank,
          and still keeps the play loop above-the-fold. */}
      <div className="gf-home-footer">
        <AboutCard />
      </div>

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
          if (activeProfileKey) {
            try {
              const info = await getShareInfo(activeProfileKey);
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
