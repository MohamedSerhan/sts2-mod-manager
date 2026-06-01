/**
 * BundleRow — renders a multi-mod bundle as a single collapsible row
 * in the LibraryTable.
 *
 * Keeps the same visual language as LibraryRow: Card wrapper, source
 * badge, version chip, title. Comfortable density adds the member-name
 * list beneath the title; compact hides it.
 *
 * In focused (active-modpack) mode, an optional `membership` prop enables
 * a pack-level "In Modpack" control that adds/removes ALL members at once.
 *
 * Intentionally presentational — owns no Tauri calls.
 */
import { useTranslation } from 'react-i18next';
import { Check, Minus, X } from 'lucide-react';
import { Badge } from './Badge';
import { Card } from './Card';
import type { Bundle, ProfileMembershipMod } from '../types';

/** Focused-mode aggregate membership state for the bundle. */
export interface BundleMembership {
  /** 'in' = all members included, 'out' = none, 'partial' = mixed */
  state: 'in' | 'out' | 'partial';
  onToggle: () => void;
  busy?: boolean;
}

export interface BundleRowProps {
  bundle: Bundle;
  members: ProfileMembershipMod[];
  density: 'comfortable' | 'compact';
  /** Present only in focused (active-modpack) mode. */
  membership?: BundleMembership;
}

function memberDisplayName(m: ProfileMembershipMod): string {
  return m.display_name?.trim() || m.name;
}

export function BundleRow({ bundle, members, density, membership }: BundleRowProps) {
  const { t } = useTranslation();

  return (
    <Card className="gf-profile-library-row gf-bundle-row" data-testid="bundle-row">
      <div className="gf-profile-library-main">
        <div className="gf-profile-library-identity min-w-0">
          <div className="gf-profile-library-titlerow">
            <h3 className="gf-profile-library-title">{bundle.display_name}</h3>
            <span className="gf-row-tagcluster">
              {bundle.nexus_url && (
                <a
                  href={bundle.nexus_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="gf-source-link"
                  title={t('mods.viewOnNexus', { url: bundle.nexus_url })}
                >
                  <Badge variant="nexus">{t('mods.nexus')}</Badge>
                </a>
              )}
              {!bundle.nexus_url && (
                <Badge variant="local">{t('mods.local')}</Badge>
              )}
              {bundle.version && (
                <span className="gf-meta-version">v{bundle.version.replace(/^v/i, '')}</span>
              )}
              <span className="gf-pill gf-pill-github">
                {t('bundle.memberCount', { count: members.length })}
              </span>
            </span>
          </div>
          {density === 'comfortable' && (
            <ul
              className="gf-bundle-members"
              aria-label={t('bundle.membersAria', { name: bundle.display_name })}
            >
              {members.map((m) => (
                <li key={m.folder_name ?? m.mod_id ?? m.name} className="gf-bundle-member-name">
                  {memberDisplayName(m)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {membership && (
        <div className="gf-profile-library-row-actions">
          <button
            type="button"
            className={`gf-row-inpack gf-row-inpack--bundle${membership.state === 'in' ? ' is-in' : membership.state === 'partial' ? ' is-partial' : ''}`}
            onClick={membership.onToggle}
            disabled={membership.busy}
            aria-label={t('bundle.toggleInPackAria', { name: bundle.display_name })}
            data-testid="bundle-membership-toggle"
          >
            {membership.state === 'in' && <Check size={12} />}
            {membership.state === 'partial' && <Minus size={12} />}
            {membership.state === 'out' && <X size={12} />}
            <span className="gf-row-inpack-label">
              {membership.state === 'in'
                ? t('bundle.inPack')
                : membership.state === 'partial'
                  ? t('bundle.partiallyInPack')
                  : t('bundle.notInPack')}
            </span>
          </button>
        </div>
      )}
    </Card>
  );
}
