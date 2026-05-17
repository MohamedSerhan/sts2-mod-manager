import type { ReactNode } from 'react';
import type { TFunction } from 'i18next';
import { Trans } from 'react-i18next';
import type { Profile, Subscription, SubscriptionUpdate, SwitchProfileResult } from '../types';
import {
  fetchSharedProfile,
  installSharedProfile,
  switchProfile,
  applySubscriptionUpdate,
} from '../hooks/useTauri';
import type { ConfirmOptions } from '../components/ConfirmDialog';

type ConfirmFn = (
  opts: ConfirmOptions,
) => Promise<false | { confirmed: true; checked: boolean }>;

/**
 * Canonicalize a share code for equality comparison.
 *
 * Share codes come in many shapes that all mean the same thing:
 *   - `jess/AA5A-315D-61AE`     (user types this)
 *   - `jess/aa5a315d61ae`       (subscription record may store this)
 *   - `JESS/aa5a-315d-61ae`     (someone shouted the username in Discord)
 *   - `sts2mm://import/jess/AA5A-315D-61AE` (deep-link payload)
 *
 * Strip the protocol prefix (and `import/` path segment) if present,
 * lowercase the owner, strip dashes + lowercase the code half. Returns
 * `null` if the input doesn't look like a share code at all so callers
 * can fall through to the existing error path.
 */
export function canonicalShareCode(input: string): string | null {
  if (!input) return null;
  let s = input.trim();

  // Deep-link form: sts2mm://import/<owner>/<code> — strip the protocol +
  // any leading path segment that names the action.
  if (s.toLowerCase().startsWith('sts2mm://')) {
    s = s.slice('sts2mm://'.length);
    // Optional action path segment (`import/`, `install/`, etc.). Tolerant
    // because the friend who shares the URL might paste a slightly different
    // shape than what we documented; the code+owner is the part that matters.
    s = s.replace(/^[a-z]+\//i, '');
  }

  // Strip a trailing query string or fragment — share URLs in the wild
  // sometimes pick up `?ref=...` analytics garbage that would otherwise
  // poison the equality check.
  s = s.split('?')[0].split('#')[0];

  const slashIdx = s.indexOf('/');
  if (slashIdx <= 0) return null;
  const owner = s.slice(0, slashIdx).toLowerCase();
  const code = s.slice(slashIdx + 1).replace(/-/g, '').toLowerCase();
  if (!owner || !code) return null;
  return `${owner}/${code}`;
}

/** Format a canonical code back into `owner/AAAA-BBBB-CCCC` for display. */
export function prettyShareCode(canonical: string): string {
  const slashIdx = canonical.indexOf('/');
  if (slashIdx === -1) return canonical;
  const owner = canonical.slice(0, slashIdx);
  const raw = canonical.slice(slashIdx + 1);
  if (raw.length < 12) return `${owner}/${raw.toUpperCase()}`;
  const c = raw.toUpperCase();
  return `${owner}/${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8, 12)}`;
}

/** Base URL of the GitHub Pages install-bridge page. The page reads `?c=`
 *  out of the query and routes to `sts2mm://import/<code>` on click,
 *  with download fallbacks for friends who don't have the manager yet.
 *
 *  Why we don't put the raw `sts2mm://` URL in share messages anymore:
 *  Discord, Slack, iMessage etc. only auto-linkify http/https URLs —
 *  custom protocol schemes appear as plain text the recipient has to
 *  copy-paste into a browser bar. The HTTPS bridge URL is clickable
 *  everywhere AND lets us show a preview card + install fallback for
 *  recipients without the manager. */
const INSTALL_BRIDGE_BASE = 'https://mohamedserhan.github.io/sts2-mod-manager/i.html';

/** Build the clickable HTTPS install URL for a share code. Encode the
 *  `c=` value so an owner with non-ASCII or unusual characters round-
 *  trips cleanly (rare but real). */
export function buildShareLink(code: string): string {
  return `${INSTALL_BRIDGE_BASE}?c=${encodeURIComponent(code)}`;
}

/** Build the paste-ready share message — used by every "Copy as message"
 *  affordance in the app. Centralizing here means a wording change in
 *  one place propagates to all surfaces (hero chip, PublishModal,
 *  Profiles row, Other Packs row, kebab menus) without drift.
 *
 *  `code` should already be in `owner/CODE` form (with or without
 *  dashes — we don't reformat it because both are valid input to the
 *  smart router, and over-formatting risks losing a recipient who's
 *  used to a different shape). */
export function buildShareMessage(packName: string, code: string, t: TFunction): string {
  const link = buildShareLink(code);
  return (
    t('shareImport.shareMessageJoinPack', { packName }) + '\n' +
    '\n' +
    t('shareImport.shareMessageInstall', { link }) + '\n' +
    t('shareImport.shareMessagePasteCode', { code })
  );
}

/**
 * Outcome of an import request. The smart router returns one of these so
 * the caller (Home paste flow, deep-link listener, anything else) can
 * pick the right toast without re-deriving the state.
 */
export type ImportOutcome =
  | { kind: 'installed'; profile: Profile }
  | { kind: 'activated'; profileName: string }
  | { kind: 'reapplied'; profileName: string; result: SwitchProfileResult }
  | { kind: 'synced'; profileName: string }
  | { kind: 'already-active'; profileName: string }
  | { kind: 'cancelled' };

/**
 * Fetch a shared profile's manifest, show the user every host we'd
 * download mods from, and only proceed with the install if they confirm.
 *
 * Why this exists: share codes are pasted from Discord/Twitter etc., and
 * strangers can publish a profile pointing at a malicious GitHub repo.
 * The install path then runs the resulting DLLs inside Slay the Spire 2's
 * process. Listing the sources up front is the minimum viable consent
 * step — same threat model as Steam Workshop, but Workshop at least shows
 * the page first.
 *
 * Returns the installed Profile on confirm, or `null` if the user
 * cancelled. Throws on fetch / install failures so the caller can toast.
 */
export async function installSharedProfileWithConfirm(
  code: string,
  confirm: ConfirmFn,
  t: TFunction,
): Promise<Profile | null> {
  // Fetch metadata only — no mod files downloaded yet.
  const preview = await fetchSharedProfile(code);

  // Build a deduped list of source hosts. Prefer bundle_url (where the
  // zip actually lives) over the legacy `source` field.
  const sourceUrls = preview.mods
    .map((m) => m.bundle_url || m.source)
    .filter((s): s is string => !!s);
  const uniqueHosts = Array.from(
    new Set(
      sourceUrls.map((s) => {
        try {
          return new URL(s).host;
        } catch {
          return s;
        }
      }),
    ),
  ).sort();

  const modCount = preview.mods.length;
  const sourceLabel = uniqueHosts.length === 1 ? t('shareImport.thisSource') : t('shareImport.theseSources');

  const body: ReactNode = (
    <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
      <div style={{ marginBottom: 8 }}>
        <b>{preview.name}</b>
        {preview.created_by && (
          <span style={{ opacity: 0.7 }}>
            {' '}
            {t('shareImport.byCreator', { creator: preview.created_by })}
          </span>
        )}
      </div>
      <div style={{ marginBottom: 10 }}>
        <Trans
          i18nKey="shareImport.installsModsFrom"
          values={{ count: modCount, source: sourceLabel }}
          components={{ 1: <b /> }}
        />
        :
      </div>
      <ul
        style={{
          margin: 0,
          paddingLeft: 18,
          maxHeight: 180,
          overflowY: 'auto',
          fontFamily:
            'var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
          fontSize: 11.5,
          opacity: 0.85,
        }}
      >
        {uniqueHosts.length > 0 ? (
          uniqueHosts.map((h) => <li key={h}>{h}</li>)
        ) : (
          <li style={{ opacity: 0.6 }}>{t('shareImport.noSourceUrls')}</li>
        )}
      </ul>
    </div>
  );

  const result = await confirm({
    title: t('shareImport.installConfirmTitle'),
    body,
    warning: t('shareImport.installConfirmWarning'),
    confirmLabel: t('shareImport.installConfirmLabel', { count: modCount }),
    cancelLabel: t('common.cancel'),
    width: 540,
  });

  if (!result) return null;
  return await installSharedProfile(code);
}

interface SmartImportOpts {
  confirm: ConfirmFn;
  subscriptions: Subscription[];
  activeProfile: string | null;
  subUpdates: SubscriptionUpdate[];
  t: TFunction;
}

/**
 * Smart entry point for share-code imports — used by BOTH the manual paste
 * flow on Home and the `sts2mm://` deep-link listener. Resolves four
 * states before showing any UI:
 *
 *   1. Brand-new pack → falls through to installSharedProfileWithConfirm
 *      (the source-host consent dialog you've seen before).
 *   2. Already subscribed AND active AND no update pending → re-apply
 *      the local manifest via switchProfile. This is intentionally not a
 *      no-op: if the user deleted a bundled mod manually, re-importing the
 *      same code should restore the missing files.
 *   3. Already subscribed but not active (no update) → confirm dialog
 *      "Switch to '<name>'?" then switchProfile.
 *   4. Already subscribed with an update available (active or not) →
 *      confirm dialog "<name> has X mod changes — apply update?" then
 *      applySubscriptionUpdate.
 *
 * Centralising this here means the deep-link path can't drift from the
 * manual-paste path — a friend clicking a link gets the same handling
 * the user typing the code would.
 */
export async function importShareCodeSmart(
  input: string,
  opts: SmartImportOpts,
): Promise<ImportOutcome> {
  const canonical = canonicalShareCode(input);
  if (!canonical) {
    // Let the existing install path produce the parse error the user is
    // used to seeing — it has more context (it'll mention "owner/CODE"
    // expected shape).
    const profile = await installSharedProfileWithConfirm(input, opts.confirm, opts.t);
    return profile
      ? { kind: 'installed', profile }
      : { kind: 'cancelled' };
  }

  // Pretty form of the canonical code: `owner/AAAA-BBBB-CCCC`. This is
  // what we pass to the Rust install/fetch commands — those run their
  // own canonicalization, but they can't handle a `sts2mm://` prefix
  // (`parse_share_code` splits on the first `/` and the would-be owner
  // is `sts2mm:`, which fails the GitHub-username validator). Always
  // hand Rust the clean code, not the raw deep-link URL.
  const pretty = prettyShareCode(canonical);

  // Match against existing subscriptions using the canonical form. The
  // share_id stored in subscriptions may be `owner/HEX` or `owner/AAAA-...`
  // depending on when it was first installed — normalize both sides.
  const match = opts.subscriptions.find(
    (s) => canonicalShareCode(s.share_id) === canonical,
  );

  if (!match) {
    const profile = await installSharedProfileWithConfirm(pretty, opts.confirm, opts.t);
    return profile
      ? { kind: 'installed', profile }
      : { kind: 'cancelled' };
  }

  const pending = opts.subUpdates.find(
    (u) => canonicalShareCode(u.share_id) === canonical,
  );
  const isActive = opts.activeProfile === match.profile_name;
  // `pretty` was already declared above for the new-pack install path;
  // the rest of the function reuses it via the outer-scope binding.

  // Case 4: an update is pending — that's almost always the right action
  // to surface, regardless of whether the pack is currently active.
  // Apply on confirm. Re-uses applySubscriptionUpdate which already
  // handles activation as a side effect.
  if (pending) {
    const { t } = opts;
    const changeCount =
      (pending.added_mods.length || 0) +
      (pending.updated_mods.length || 0) +
      (pending.removed_mods.length || 0);
    const summaryBits: ReactNode[] = [];
    if (pending.added_mods.length > 0) {
      summaryBits.push(
        <span key="added" style={{ color: 'var(--ok)' }}>
          {t('shareImport.updateSummaryAdded', { count: pending.added_mods.length })}
        </span>,
      );
    }
    if (pending.updated_mods.length > 0) {
      summaryBits.push(
        <span key="updated" style={{ color: 'var(--gf)' }}>
          {t('shareImport.updateSummaryUpdated', { count: pending.updated_mods.length })}
        </span>,
      );
    }
    if (pending.removed_mods.length > 0) {
      summaryBits.push(
        <span key="removed" style={{ color: 'var(--danger)' }}>
          {t('shareImport.updateSummaryRemoved', { count: pending.removed_mods.length })}
        </span>,
      );
    }
    const body: ReactNode = (
      <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
        <div style={{ marginBottom: 8 }}>
          <Trans
            i18nKey="shareImport.updateDialogAlreadyHave"
            values={{ profileName: match.profile_name, code: pretty }}
            components={{ 1: <b /> }}
          />
        </div>
        <div style={{ marginBottom: 4 }}>
          <Trans
            i18nKey="shareImport.updateDialogCuratorPushed"
            values={{ count: changeCount }}
            components={{ 1: <b /> }}
          />
        </div>
        <div style={{ display: 'flex', gap: 12, fontSize: 12 }}>
          {summaryBits.length > 0 ? summaryBits : <span style={{ opacity: 0.7 }}>{t('shareImport.updateDialogNoSummary')}</span>}
        </div>
      </div>
    );
    const ok = await opts.confirm({
      title: t('shareImport.updateDialogTitle'),
      body,
      confirmLabel: t('shareImport.updateDialogConfirmLabel'),
      cancelLabel: t('shareImport.updateDialogCancelLabel'),
      width: 480,
    });
    if (!ok) return { kind: 'cancelled' };
    await applySubscriptionUpdate(match.share_id);
    return { kind: 'synced', profileName: match.profile_name };
  }

  // Case 2: already active, no pending update — re-apply. A friend may
  // paste/click the same share code after manually deleting one bundled
  // mod; switchProfile is the Rust path that restores missing bundle_url
  // entries from the saved manifest.
  if (isActive) {
    const result = await switchProfile(match.profile_name);
    return { kind: 'reapplied', profileName: match.profile_name, result };
  }

  // Case 3: subscribed but not active — offer to switch.
  const { t } = opts;
  const body: ReactNode = (
    <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
      <div>
        <Trans
          i18nKey="shareImport.switchDialogAlreadyHave"
          values={{ profileName: match.profile_name, code: pretty }}
          components={{ 1: <b /> }}
        />
      </div>
      <div style={{ marginTop: 6, opacity: 0.85 }}>
        {t('shareImport.switchDialogActivatePrompt')}
      </div>
    </div>
  );
  const ok = await opts.confirm({
    title: t('shareImport.switchDialogTitle', { profileName: match.profile_name }),
    body,
    confirmLabel: t('common.activate'),
    cancelLabel: t('common.cancel'),
    width: 480,
  });
  if (!ok) return { kind: 'cancelled' };
  await switchProfile(match.profile_name);
  return { kind: 'activated', profileName: match.profile_name };
}
