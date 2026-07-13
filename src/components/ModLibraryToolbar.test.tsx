import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AllProviders } from '../__test__/providers';
import type { ModAuditEntry } from '../types';
import type { ModLibrary } from '../hooks/useModLibrary';
import { ModLibraryToolbar } from './ModLibraryToolbar';

function auditPlan(id: string, provider: 'github' | 'nexus' | 'steam', capability: 'downloadable' | 'manual' | 'steam-managed', selectable: boolean): ModAuditEntry {
  return {
    mod_name: id, folder_name: id, mod_version_id: id, github_repo: null,
    installed_version: '1.0.0', latest_release_tag: null,
    latest_release_with_assets_tag: null, latest_has_assets: false,
    needs_update: true, asset_names: [], releases_scanned: 0, error: null,
    nexus_url: null, nexus_version: null, nexus_update_available: false,
    update_source: provider === 'steam' ? null : provider,
    github_auto_detected: false, pinned: false,
    update_plans: [{
      target: { name: id, mod_version_id: id }, current_version: '1.0.0',
      target_version: '2.0.0', provider, source: provider === 'steam' ? null : 'https://example.com',
      capability, reason: '', selectable, pending: true,
    }],
  };
}

describe('<ModLibraryToolbar>', () => {
  it('reviews all eight provider plans, including Steam-managed updates', async () => {
    const auditResults = [
      auditPlan('alice', 'nexus', 'manual', false),
      auditPlan('deckstats', 'github', 'downloadable', true),
      auditPlan('remove-limit', 'nexus', 'manual', false),
      auditPlan('card-advisor', 'github', 'downloadable', true),
      auditPlan('save-path', 'nexus', 'manual', false),
      auditPlan('baselib', 'steam', 'steam-managed', false),
      auditPlan('ritsulib', 'steam', 'steam-managed', false),
      auditPlan('mspain', 'steam', 'steam-managed', false),
    ];
    const user = userEvent.setup();

    // The plan-sheet visibility now lives on the hook (F7) so per-row
    // provider pills can open the same sheet. The mock lib needs its
    // own tiny useState-backed pair so the toolbar's Review click can
    // actually toggle the sheet open in this unit-test seam.
    function Harness() {
      const [planSheetOpen, setPlanSheetOpen] = useState(false);
      const lib = {
        auditResults, auditing: false, updatingAll: false, refreshing: false,
        updateAllGithub: vi.fn(), handleRefresh: vi.fn(), handleCheckUpdates: vi.fn(),
        openUpdatePlanSource: vi.fn(), unfreezeUpdatePlan: vi.fn(),
        planSheetOpen,
        openPlanSheet: () => setPlanSheetOpen(true),
        closePlanSheet: () => setPlanSheetOpen(false),
      } as unknown as ModLibrary;
      return <ModLibraryToolbar lib={lib} />;
    }

    render(<AllProviders><Harness /></AllProviders>);

    const review = screen.getByRole('button', { name: 'Review 8 updates' });
    expect(screen.queryByRole('button', { name: 'Download 2 updates' })).not.toBeInTheDocument();
    await user.click(review);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });
});
