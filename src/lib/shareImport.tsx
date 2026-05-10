import type { ReactNode } from 'react';
import type { Profile } from '../types';
import { fetchSharedProfile, installSharedProfile } from '../hooks/useTauri';
import type { ConfirmOptions } from '../components/ConfirmDialog';

type ConfirmFn = (
  opts: ConfirmOptions,
) => Promise<false | { confirmed: true; checked: boolean }>;

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

  const body: ReactNode = (
    <div style={{ fontSize: 12.5, lineHeight: 1.55 }}>
      <div style={{ marginBottom: 8 }}>
        <b>{preview.name}</b>
        {preview.created_by && (
          <span style={{ opacity: 0.7 }}>
            {' '}
            · by {preview.created_by}
          </span>
        )}
      </div>
      <div style={{ marginBottom: 10 }}>
        Installs <b>{modCount}</b> mod{modCount === 1 ? '' : 's'} from{' '}
        {uniqueHosts.length === 1 ? 'this source' : 'these sources'}:
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
          <li style={{ opacity: 0.6 }}>(no source URLs declared)</li>
        )}
      </ul>
    </div>
  );

  const result = await confirm({
    title: 'Install this modpack?',
    body,
    warning:
      'Modpacks run code (DLLs) inside Slay the Spire 2. Only install from creators you trust.',
    confirmLabel: `Install ${modCount} mod${modCount === 1 ? '' : 's'}`,
    cancelLabel: 'Cancel',
    width: 540,
  });

  if (!result) return null;
  return await installSharedProfile(code);
}
