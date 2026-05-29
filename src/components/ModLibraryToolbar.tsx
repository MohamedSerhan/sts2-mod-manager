/**
 * ModLibraryToolbar — the shared action-button cluster for mod management:
 * Open folder · Import mod · Quick add URL · Auto-detect sources · Audit /
 * Update-all · Refresh.
 *
 * Rendered identically by the All Mods view and the per-modpack view so the
 * two surfaces offer the exact same add/maintain affordances. All behavior
 * comes from the `useModLibrary` hook; this component is pure presentation.
 *
 * It renders ONLY the button cluster (the caller places it — e.g. inside a
 * page header's `.gf-page-actions`). The Quick-add form and Auto-detect
 * modal are separate render helpers on the hook (`renderQuickAddForm` /
 * `renderAutoDetectModal`) so each view can position them in its own body.
 */
import { useTranslation } from 'react-i18next';
import {
  ClipboardCheck,
  Download,
  FolderOpen,
  Link,
  RefreshCw,
  Search,
  Upload,
} from 'lucide-react';

import { Badge } from './Badge';
import { Button } from './Button';
import { countGithubUpdates } from '../lib/auditState';
import type { ModLibrary } from '../hooks/useModLibrary';

export function ModLibraryToolbar({ lib }: { lib: ModLibrary }) {
  const { t } = useTranslation();
  const {
    gameRunning,
    auditResults,
    auditing,
    updatingAll,
    updateAllGithub,
    showQuickAdd,
    setShowQuickAdd,
    setShowAutoDetect,
    refreshing,
    handleOpenFolder,
    handleImportFile,
    handleRefresh,
    handleCheckUpdates,
  } = lib;

  return (
    <div className="gf-page-actions">
      <Button variant="secondary" size="sm" onClick={handleOpenFolder}>
        <FolderOpen size={14} />
        {t('mods.openFolder')}
      </Button>
      <Button variant="secondary" size="sm" onClick={handleImportFile} disabled={gameRunning}>
        <Upload size={14} />
        {t('mods.importMod')}
      </Button>
      <Button variant="secondary" size="sm" onClick={() => setShowQuickAdd(!showQuickAdd)} disabled={gameRunning}>
        <Link size={14} />
        {t('mods.quickAddUrl')}
      </Button>
      <Button variant="secondary" size="sm" onClick={() => setShowAutoDetect(true)}>
        <Search size={14} />
        {t('mods.autoDetectSources')}
      </Button>
      {(() => {
        const ghUpdateCount = auditResults ? countGithubUpdates(auditResults) : 0;
        const ghUpdateNames = auditResults
          ? auditResults
              .filter((r) => r.needs_update && !r.snoozed && r.github_repo && r.latest_release_with_assets_tag)
              .map((r) => r.mod_name)
          : [];

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
              {t('mods.updatingCount', { count: ghUpdateCount })}
            </Button>
          );
        }

        if (auditResults === null) {
          return (
            <Button variant="secondary" size="sm" onClick={handleCheckUpdates} title={t('mods.checkForUpdates')}>
              <ClipboardCheck size={14} />
              {t('mods.audit.run')}
              <Badge variant="beta" ariaHidden>{t('common.beta')}</Badge>
            </Button>
          );
        }

        if (ghUpdateCount === 0) {
          return (
            <>
              <span className="gf-pill gf-pill-ok gf-pill-toolbar" title={t('mods.allUpToDate')}>
                {t('mods.audit.upToDate')}
              </span>
              <Button variant="ghost" size="sm" onClick={handleCheckUpdates} title={t('mods.reaudit')} aria-label={t('mods.reaudit')}>
                <RefreshCw size={14} />
              </Button>
            </>
          );
        }

        return (
          <>
            <Button variant="primary" size="sm" onClick={() => updateAllGithub(ghUpdateNames)} title={t('mods.updateAllTitle')}>
              <Download size={14} />
              {t('mods.updateAllLabel', { count: ghUpdateCount })}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleCheckUpdates} title={t('mods.reaudit')} aria-label={t('mods.reaudit')}>
              <RefreshCw size={14} />
            </Button>
          </>
        );
      })()}
      <Button size="sm" onClick={handleRefresh} disabled={refreshing}>
        <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
        {refreshing ? t('common.refreshing') : t('common.refresh')}
      </Button>
    </div>
  );
}
