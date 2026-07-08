import { useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Play, ShieldAlert, X } from 'lucide-react';
import { useModalA11y } from '../hooks/useModalA11y';
import type { LaunchDependencyBlockedMod, LaunchFailureMod, LaunchHealthReport, LaunchIncompatibleMod } from '../types';

interface Props {
  report: LaunchHealthReport;
  storing: boolean;
  onStoreAndLaunch: () => void;
  onLaunchAnyway: () => void;
  onReview: () => void;
  onCancel: () => void;
}

function modLabel(mod: LaunchDependencyBlockedMod | LaunchFailureMod | LaunchIncompatibleMod): string {
  return mod.display_name || mod.name;
}

function previewList<T extends LaunchDependencyBlockedMod | LaunchFailureMod | LaunchIncompatibleMod>(items: T[]) {
  return {
    visible: items.slice(0, 8),
    hidden: Math.max(0, items.length - 8),
  };
}

export function LaunchHealthModal({
  report,
  storing,
  onStoreAndLaunch,
  onLaunchAnyway,
  onReview,
  onCancel,
}: Props) {
  const { t } = useTranslation();
  const modalRef = useRef<HTMLElement>(null);
  useModalA11y(modalRef, onCancel, !storing);

  const failed = report.previous_failed_mods ?? [];
  const dependencyBlocked = report.dependency_blocked_mods ?? [];
  const incompatible = report.known_incompatible_mods ?? [];
  const hardBlockers = failed.length + dependencyBlocked.length + incompatible.length;
  const versionChanged =
    report.game_version_changed_since_last_launch || report.profile_game_version_changed;
  const failedPreview = previewList(failed);
  const dependencyPreview = previewList(dependencyBlocked);
  const incompatiblePreview = previewList(incompatible);

  const title = failed.length > 0
    ? t('launchHealth.failedTitle', { count: failed.length })
    : dependencyBlocked.length > 0
      ? t('launchHealth.dependencyTitle', { count: dependencyBlocked.length })
      : incompatible.length > 0
        ? t('launchHealth.incompatibleTitle', { count: incompatible.length })
        : t('launchHealth.versionChangedTitle');

  const body = failed.length > 0
    ? t('launchHealth.failedBody')
    : dependencyBlocked.length > 0
      ? t('launchHealth.dependencyBody')
      : incompatible.length > 0
        ? t('launchHealth.incompatibleBody')
        : t('launchHealth.versionChangedBody');

  const currentVersion = report.current_game_version || t('unknown');
  const previousVersion =
    report.last_launch_game_version || report.profile_game_version || t('unknown');
  const packName = report.active_profile_name || t('app.launch.noActiveProfile');

  return (
    <div className="gf-modal-back" onClick={storing ? undefined : onCancel}>
      <section
        ref={modalRef as RefObject<HTMLElement>}
        className="gf-modal gf-launch-health"
        role="dialog"
        aria-modal="true"
        aria-labelledby="gf-launch-health-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="gf-modal-head">
          <div className="gf-launch-health-heading">
            <ShieldAlert size={20} aria-hidden />
            <div>
              <div id="gf-launch-health-title" className="gf-modal-title">{title}</div>
              <div className="gf-modal-sub">{body}</div>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="gf-btn-3 gf-btn-icon"
            title={t('common.cancel')}
            aria-label={t('common.cancel')}
            disabled={storing}
          >
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body gf-launch-health-body">
          {versionChanged && (
            <div className="gf-launch-health-band">
              <AlertTriangle size={15} aria-hidden />
              <div>
                <div className="gf-launch-health-band-title">
                  {t('launchHealth.versionChangedLine', { pack: packName })}
                </div>
                <div className="gf-launch-health-meta">
                  {t('launchHealth.versionChangedMeta', {
                    previous: previousVersion,
                    current: currentVersion,
                  })}
                </div>
              </div>
            </div>
          )}

          {failed.length > 0 && (
            <div className="gf-launch-health-section">
              <div className="gf-launch-health-section-title">
                {t('launchHealth.failedSection', { count: failed.length })}
              </div>
              <ul className="gf-launch-health-list">
                {failedPreview.visible.map((mod) => (
                  <li key={`${mod.folder_name || mod.name}:${mod.version}`}>
                    <span>{modLabel(mod)}</span>
                    <span>{t('launchHealth.modVersion', { version: mod.version })}</span>
                  </li>
                ))}
              </ul>
              {failedPreview.hidden > 0 && (
                <div className="gf-launch-health-more">
                  {t('launchHealth.moreMods', { count: failedPreview.hidden })}
                </div>
              )}
            </div>
          )}

          {dependencyBlocked.length > 0 && (
            <div className="gf-launch-health-section">
              <div className="gf-launch-health-section-title">
                {t('launchHealth.dependencySection', { count: dependencyBlocked.length })}
              </div>
              <p className="gf-launch-health-meta">
                {t('launchHealth.dependencySaveChangesNote')}
              </p>
              <ul className="gf-launch-health-list">
                {dependencyPreview.visible.map((mod) => (
                  <li key={`${mod.folder_name || mod.name}:${mod.missing_dependencies.join('|')}`}>
                    <span>{modLabel(mod)}</span>
                    <span>{t('launchHealth.missingDependencies', {
                      count: mod.missing_dependencies.length,
                      list: mod.missing_dependencies.join(', '),
                    })}</span>
                  </li>
                ))}
              </ul>
              {dependencyPreview.hidden > 0 && (
                <div className="gf-launch-health-more">
                  {t('launchHealth.moreMods', { count: dependencyPreview.hidden })}
                </div>
              )}
            </div>
          )}

          {incompatible.length > 0 && (
            <div className="gf-launch-health-section">
              <div className="gf-launch-health-section-title">
                {t('launchHealth.incompatibleSection', { count: incompatible.length })}
              </div>
              <ul className="gf-launch-health-list">
                {incompatiblePreview.visible.map((mod) => (
                  <li key={`${mod.folder_name || mod.name}:${mod.min_game_version}`}>
                    <span>{modLabel(mod)}</span>
                    <span>{t('launchHealth.needsGameVersion', { version: mod.min_game_version })}</span>
                  </li>
                ))}
              </ul>
              {incompatiblePreview.hidden > 0 && (
                <div className="gf-launch-health-more">
                  {t('launchHealth.moreMods', { count: incompatiblePreview.hidden })}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="gf-modal-foot">
          <button className="gf-btn-3" onClick={onCancel} disabled={storing}>
            {t('common.cancel')}
          </button>
          <button className="gf-btn-3" onClick={onReview} disabled={storing}>
            {t('launchHealth.reviewLibrary')}
          </button>
          <button className="gf-btn-3" onClick={onLaunchAnyway} disabled={storing}>
            <Play size={12} /> {t('launchHealth.launchAnyway')}
          </button>
          {hardBlockers > 0 && (
            <button className="gf-btn" onClick={onStoreAndLaunch} disabled={storing}>
              {storing ? t('launchHealth.storing') : t('launchHealth.storeBlockedAndLaunch')}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
