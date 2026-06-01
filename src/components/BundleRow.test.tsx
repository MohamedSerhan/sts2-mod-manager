/**
 * BundleRow tests — presentation of a multi-mod bundle row.
 *
 * Checks:
 *  - Comfortable density: display_name, Nexus link (href), version, all
 *    3 member names are visible.
 *  - Compact density: title visible, member names NOT rendered.
 *  - Nexus badge absent when nexus_url is null.
 *  - version absent when null.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BundleRow } from './BundleRow';
import type { Bundle, ProfileMembershipMod } from '../types';

// Providers not needed — BundleRow is fully presentational and only
// uses react-i18next which is pre-loaded by the setup file.

function makeBundle(overrides: Partial<Bundle> = {}): Bundle {
  return {
    bundle_id: 'FantasyBundle',
    display_name: 'Fantasy Overhaul Pack',
    nexus_url: 'https://nexusmods.com/mod/1234',
    version: '2.0.0',
    member_count: 3,
    ...overrides,
  };
}

function makeMember(name: string, display_name?: string): ProfileMembershipMod {
  return {
    name,
    version: '1.0.0',
    folder_name: name,
    mod_id: null,
    display_name: display_name ?? null,
    installed_enabled: true,
    profiles: [],
    bundle_id: 'FantasyBundle',
  };
}

const members = [
  makeMember('FantasyCore', 'Fantasy Core'),
  makeMember('FantasyArt', 'Fantasy Art Pack'),
  makeMember('FantasySound'),
];

describe('<BundleRow>', () => {
  describe('comfortable density', () => {
    it('shows the bundle display name', () => {
      render(
        <BundleRow bundle={makeBundle()} members={members} density="comfortable" />,
      );
      expect(screen.getByRole('heading', { name: 'Fantasy Overhaul Pack' })).toBeInTheDocument();
    });

    it('shows a Nexus link with the correct href', () => {
      render(
        <BundleRow bundle={makeBundle()} members={members} density="comfortable" />,
      );
      const link = screen.getByRole('link', { name: /nexus/i });
      expect(link).toHaveAttribute('href', 'https://nexusmods.com/mod/1234');
    });

    it('shows the version', () => {
      render(
        <BundleRow bundle={makeBundle()} members={members} density="comfortable" />,
      );
      expect(screen.getByText('v2.0.0')).toBeInTheDocument();
    });

    it('shows all three member display names', () => {
      render(
        <BundleRow bundle={makeBundle()} members={members} density="comfortable" />,
      );
      expect(screen.getByText('Fantasy Core')).toBeInTheDocument();
      expect(screen.getByText('Fantasy Art Pack')).toBeInTheDocument();
      // Falls back to mod name when display_name is absent
      expect(screen.getByText('FantasySound')).toBeInTheDocument();
    });

    it('shows the member count chip', () => {
      render(
        <BundleRow bundle={makeBundle()} members={members} density="comfortable" />,
      );
      // "3 mods" or similar (plural form)
      expect(screen.getByText(/3 mod/i)).toBeInTheDocument();
    });
  });

  describe('compact density', () => {
    it('shows the bundle title', () => {
      render(
        <BundleRow bundle={makeBundle()} members={members} density="compact" />,
      );
      expect(screen.getByRole('heading', { name: 'Fantasy Overhaul Pack' })).toBeInTheDocument();
    });

    it('does NOT show member names', () => {
      render(
        <BundleRow bundle={makeBundle()} members={members} density="compact" />,
      );
      expect(screen.queryByText('Fantasy Core')).not.toBeInTheDocument();
      expect(screen.queryByText('Fantasy Art Pack')).not.toBeInTheDocument();
      expect(screen.queryByText('FantasySound')).not.toBeInTheDocument();
    });
  });

  describe('when nexus_url is null', () => {
    it('shows no Nexus link', () => {
      render(
        <BundleRow
          bundle={makeBundle({ nexus_url: null })}
          members={members}
          density="comfortable"
        />,
      );
      expect(screen.queryByRole('link', { name: /nexus/i })).not.toBeInTheDocument();
    });
  });

  describe('when version is null', () => {
    it('shows no version chip', () => {
      render(
        <BundleRow
          bundle={makeBundle({ version: null })}
          members={members}
          density="comfortable"
        />,
      );
      // No "vX.Y.Z" text
      expect(screen.queryByText(/^v\d/)).not.toBeInTheDocument();
    });
  });
});
