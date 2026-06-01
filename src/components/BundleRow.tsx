/**
 * BundleRow — renders a multi-mod bundle as a single collapsible row
 * in the "All installed mods" (no-focus) LibraryTable.
 *
 * Keeps the same visual language as LibraryRow: Card wrapper, source
 * badge, version chip, title. Comfortable density adds the member-name
 * list beneath the title; compact hides it.
 *
 * Intentionally presentational — owns no Tauri calls.
 */
import { useTranslation } from 'react-i18next';
import { Badge } from './Badge';
import { Card } from './Card';
import type { Bundle, ProfileMembershipMod } from '../types';

export interface BundleRowProps {
  bundle: Bundle;
  members: ProfileMembershipMod[];
  density: 'comfortable' | 'compact';
}

function memberDisplayName(m: ProfileMembershipMod): string {
  return m.display_name?.trim() || m.name;
}

export function BundleRow({ bundle, members, density }: BundleRowProps) {
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
    </Card>
  );
}
