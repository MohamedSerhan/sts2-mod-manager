/**
 * ModLibraryToolbar — the action cluster for the Mod Library page header: one
 * prominent "+ Add mods" dropdown (paste URL · import file), the Audit /
 * Update-all state machine, and Refresh.
 *
 * The per-modpack view builds its own toolbar around the same shared
 * <AddModsMenu>, so the two surfaces offer the exact same add affordances.
 * All behavior comes from the `useModLibrary` hook; this component is pure
 * presentation. The Quick-add form and Auto-detect modal are separate render
 * helpers on the hook (`renderQuickAddForm` / `renderAutoDetectModal`) so the
 * view can position them in its own body.
 */
import { useTranslation } from 'react-i18next';
import { ClipboardCheck, ListChecks, RefreshCw } from 'lucide-react';

import { Button } from './Button';
import { AddModsMenu } from './AddModsMenu';
import { projectProviderUpdates } from '../lib/auditState';
import type { ModLibrary } from '../hooks/useModLibrary';
import { UpdatePlanSheet } from './UpdatePlanSheet';

export function ModLibraryToolbar({ lib }: { lib: ModLibrary }) {
  const { t } = useTranslation();
  // Sheet visibility lives on the hook so the per-row provider-evidence
  // pills can open the same sheet (F7). Keep the same local var names
  // here for a minimum-diff render body.
  const showPlan = lib.planSheetOpen;
  const setShowPlan = (open: boolean) => (open ? lib.openPlanSheet() : lib.closePlanSheet());
  const {
    auditResults,
    auditing,
    updatingAll,
    updateAllGithub,
    refreshing,
    handleRefresh,
    handleCheckUpdates,
  } = lib;

  return (
    <div className="gf-page-actions">
      {/* One prominent (yellow) entry point for every way to add a mod —
          matches the modpack view's "+ Add mods" dropdown. */}
      <AddModsMenu lib={lib} buttonClassName="gf-btn gf-btn-sm" />
      {(() => {
        const projection = projectProviderUpdates(auditResults ?? []);
        const hasPending = projection.hasPending;
        const hasSteamAdvisory = projection.pendingPlans.some((plan) => plan.provider === 'steam');

        if (auditing) {
          return (
            <Button variant="secondary" size="sm" disabled title={t('mods.checking')}>
              <ClipboardCheck size={14} className="animate-pulse" />
              {t('mods.audit.running')}
            </Button>
          );
        }

        if (updatingAll) {
          return (
            <Button variant="primary" size="sm" disabled>
              <RefreshCw size={14} className="animate-spin" />
              {t('mods.updatingCount', { count: projection.downloadableCount })}
            </Button>
          );
        }

        if (auditResults === null) {
          return (
            <Button variant="secondary" size="sm" onClick={handleCheckUpdates} title={t('mods.checkForUpdates')}>
              <ClipboardCheck size={14} />
              {t('mods.audit.run')}
            </Button>
          );
        }

        if (!hasPending) {
          return (
            <>
              <span className="gf-pill gf-pill-ok gf-pill-toolbar" title={t('mods.allUpToDate')}>
                {t('mods.audit.upToDate')}
              </span>
              <Button variant="ghost" size="sm" onClick={handleCheckUpdates} title={t('mods.reaudit')}>
                <RefreshCw size={14} /> {t('mods.reaudit')}
              </Button>
            </>
          );
        }

        // Steam-managed plans remain available as row/review-sheet evidence,
        // but they are not actionable downloads and must never become a
        // misleading "Review 0 updates" toolbar action.
        if (projection.actionableCount === 0) {
          return (
            <>
              {hasSteamAdvisory && (
                <span className="gf-pill gf-pill-update gf-pill-toolbar" title={t('mods.steamUpdateTitle')}>
                  {t('mods.steamUpdateAvailable')}
                </span>
              )}
              <Button variant="ghost" size="sm" onClick={handleCheckUpdates} title={t('mods.reaudit')}>
                <RefreshCw size={14} /> {t('mods.reaudit')}
              </Button>
            </>
          );
        }

        return (
          <>
            <Button variant="primary" size="sm" onClick={() => setShowPlan(true)} title={t('mods.reviewUpdatesTitle')}>
              <ListChecks size={14} />
              {t('mods.reviewUpdatesLabel', { count: projection.actionableCount })}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCheckUpdates} title={t('mods.reaudit')}>
              <RefreshCw size={14} /> {t('mods.reaudit')}
            </Button>
          </>
        );
      })()}
      {/* Refresh steps down to a quiet secondary now that Add mods is the
          page's primary (yellow) action. */}
      <Button variant="secondary" size="sm" onClick={handleRefresh} disabled={refreshing}>
        <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        {refreshing ? t('common.refreshing') : t('common.refresh')}
      </Button>
      {showPlan && <UpdatePlanSheet plans={projectProviderUpdates(auditResults ?? []).pendingPlans} applying={updatingAll} onApply={updateAllGithub} onClose={() => setShowPlan(false)} onOpenSource={lib.openUpdatePlanSource} onUnfreeze={lib.unfreezeUpdatePlan} />}
    </div>
  );
}
