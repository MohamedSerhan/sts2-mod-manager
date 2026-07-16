import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, CheckCircle2, CircleHelp, Info, LockKeyhole, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type {
  LibraryVersionCleanupCandidate,
  LibraryVersionCleanupItemResult,
  LibraryVersionCleanupPreview,
} from '../types';
import {
  executeLibraryVersionCleanup,
  previewLibraryVersionCleanup,
} from '../hooks/useTauri';
import { useConfirm } from './ConfirmDialog';
import { Button } from './Button';
import { Select } from './Select';

interface VersionCleanupModalProps {
  open: boolean;
  onClose: () => void;
  onComplete: () => void | Promise<void>;
}

const PAGE_SIZE = 20;

function cleanVersion(version: string): string {
  return version.trim().replace(/^v/i, '') || '?';
}

function candidateState(candidate: LibraryVersionCleanupCandidate): 'active' | 'stored' | 'saved' {
  if (candidate.option.installed_enabled) return 'active';
  if (candidate.option.installed) return 'stored';
  return 'saved';
}

export function VersionCleanupModal({
  open,
  onClose,
  onComplete,
}: VersionCleanupModalProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [preview, setPreview] = useState<LibraryVersionCleanupPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [replacements, setReplacements] = useState<Record<string, string>>({});
  const [results, setResults] = useState<LibraryVersionCleanupItemResult[]>([]);

  async function loadPreview() {
    setLoading(true);
    setError(null);
    try {
      const next = await previewLibraryVersionCleanup();
      setPreview(next);
      setSelected(new Set(
        next.families.flatMap((family) =>
          family.candidates
            .filter((candidate) => candidate.recommended)
            .map((candidate) => candidate.option.mod_version_id),
        ),
      ));
      setReplacements({});
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setFilter('');
    setShowAdvanced(false);
    setVisibleLimit(PAGE_SIZE);
    setResults([]);
    void loadPreview();
    // Opening the modal is the only trigger; retries call loadPreview directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setVisibleLimit(PAGE_SIZE);
  }, [filter]);

  const filteredFamilies = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return preview?.families ?? [];
    return (preview?.families ?? []).filter((family) =>
      family.display_name.toLocaleLowerCase().includes(query)
      || family.candidates.some((candidate) =>
        candidate.option.version.toLocaleLowerCase().includes(query)
        || candidate.provider.includes(query),
      ),
    );
  }, [filter, preview]);

  const candidateById = useMemo(() => new Map(
    (preview?.families ?? []).flatMap((family) => family.candidates)
      .map((candidate) => [candidate.option.mod_version_id, candidate]),
  ), [preview]);

  const selectedCandidates = [...selected]
    .map((id) => candidateById.get(id))
    .filter((candidate): candidate is LibraryVersionCleanupCandidate => !!candidate);
  const invalidReplacement = selectedCandidates.some((candidate) => {
    if (!candidate.protected) return false;
    const replacement = replacements[candidate.option.mod_version_id];
    return !replacement || selected.has(replacement);
  });
  const canRun = selected.size > 0 && !invalidReplacement && !running;

  function toggleCandidate(candidate: LibraryVersionCleanupCandidate, checked: boolean) {
    const id = candidate.option.mod_version_id;
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function setAdvanced(enabled: boolean) {
    setShowAdvanced(enabled);
    if (enabled) return;
    const protectedIds = new Set(
      [...candidateById.values()]
        .filter((candidate) => candidate.protected)
        .map((candidate) => candidate.option.mod_version_id),
    );
    setSelected((current) => new Set([...current].filter((id) => !protectedIds.has(id))));
    setReplacements({});
  }

  async function executeCleanup() {
    if (!canRun) return;
    const protectedCount = selectedCandidates.filter((candidate) => candidate.protected).length;
    const installedCount = selectedCandidates.filter((candidate) => candidate.option.installed).length;
    const ok = await confirm({
      title: t('mods.versionCleanup.confirmTitle', { count: selected.size }),
      body: t('mods.versionCleanup.confirmBody', {
        stored: installedCount,
        remapped: protectedCount,
      }),
      warning: t('mods.versionCleanup.confirmWarning'),
      confirmLabel: t('mods.versionCleanup.confirmAction'),
      destructive: true,
    });
    if (!ok) return;
    setRunning(true);
    setError(null);
    setResults([]);
    try {
      const nextResults = await executeLibraryVersionCleanup(selectedCandidates.map((candidate) => ({
        mod_version_id: candidate.option.mod_version_id,
        replacement_mod_version_id: candidate.protected
          ? replacements[candidate.option.mod_version_id]
          : null,
      })));
      setResults(nextResults);
      if (nextResults.some((result) => result.success)) {
        await onComplete();
      }
      await loadPreview();
      setResults(nextResults);
    } catch (cleanupError) {
      setError(cleanupError instanceof Error ? cleanupError.message : String(cleanupError));
    } finally {
      setRunning(false);
    }
  }

  if (!open) return null;

  return (
    <div className="gf-modal-back" onClick={() => !running && onClose()}>
      <div
        className="gf-modal gf-version-cleanup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="version-cleanup-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="gf-modal-head">
          <div>
            <div id="version-cleanup-title" className="gf-modal-title">
              {t('mods.versionCleanup.title')}
            </div>
            <div className="gf-modal-sub">{t('mods.versionCleanup.subtitle')}</div>
          </div>
          <button
            type="button"
            className="gf-btn-3 gf-btn-icon"
            onClick={onClose}
            disabled={running}
            title={t('common.close')}
            aria-label={t('common.close')}
          >
            <X size={14} />
          </button>
        </div>

        <div className="gf-modal-body gf-version-cleanup-body">
          {loading && !preview ? (
            <div className="gf-version-cleanup-empty">{t('common.loading')}</div>
          ) : error ? (
            <div className="gf-version-cleanup-error" role="alert">
              <AlertTriangle size={16} />
              <span>{t('mods.versionCleanup.loadFailed', { error })}</span>
              <Button variant="secondary" size="sm" onClick={() => void loadPreview()}>
                {t('common.retry')}
              </Button>
            </div>
          ) : preview && preview.families.length === 0 ? (
            <div className="gf-version-cleanup-empty">
              <CheckCircle2 size={22} />
              <strong>{t('mods.versionCleanup.emptyTitle')}</strong>
              <span>{t('mods.versionCleanup.emptyBody')}</span>
            </div>
          ) : preview ? (
            <>
              <div className="gf-version-cleanup-summary">
                <span>{t('mods.versionCleanup.recommendedCount', { count: preview.recommended_count })}</span>
                <span>{t('mods.versionCleanup.protectedCount', { count: preview.protected_count })}</span>
              </div>
              <div className="gf-version-cleanup-toolbar">
                <label className="gf-version-cleanup-search">
                  <Search size={14} aria-hidden />
                  <input
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                    placeholder={t('mods.versionCleanup.searchPlaceholder')}
                    aria-label={t('mods.versionCleanup.searchPlaceholder')}
                  />
                </label>
                <label className="gf-version-cleanup-advanced">
                  <input
                    type="checkbox"
                    checked={showAdvanced}
                    onChange={(event) => setAdvanced(event.target.checked)}
                  />
                  <span>{t('mods.versionCleanup.showAdvanced')}</span>
                  <span
                    className="gf-version-cleanup-help"
                    role="img"
                    aria-label={t('mods.versionCleanup.protectedHelpLabel')}
                    title={t('mods.versionCleanup.protectedHelp')}
                  >
                    <CircleHelp size={13} aria-hidden />
                  </span>
                </label>
              </div>
              <div className="gf-version-cleanup-source-note">
                <Info size={14} aria-hidden />
                <span>{t('mods.versionCleanup.sourceRetentionNote')}</span>
              </div>

              <div className="gf-version-cleanup-list">
                {filteredFamilies.slice(0, visibleLimit).map((family) => (
                  <details key={family.family_key} className="gf-version-cleanup-family" open>
                    <summary>
                      <strong>{family.display_name}</strong>
                      <span>{t('mods.versionCleanup.versionCount', { count: family.candidates.length })}</span>
                    </summary>
                    <div className="gf-version-cleanup-candidates">
                      {family.candidates.map((candidate) => {
                        const id = candidate.option.mod_version_id;
                        const canAdvancedRemove = candidate.protected
                          && !candidate.option.pinned
                          && !candidate.reasons.includes('steam_managed')
                          && candidate.replacement_candidates.length > 0;
                        const disabled = candidate.protected && (!showAdvanced || !canAdvancedRemove);
                        const checked = selected.has(id);
                        const reasonText = candidate.reasons
                          .map((reason) => t(`mods.versionCleanup.reason.${reason}`))
                          .join(t('mods.versionCleanup.reasonJoiner'));
                        const protectedTitle = t('mods.versionCleanup.protectedBadgeTitle', {
                          reasons: reasonText,
                        });
                        const replacementOptions = candidate.replacement_candidates
                          .filter((replacement) => !selected.has(replacement.mod_version_id))
                          .map((replacement) => ({
                            value: replacement.mod_version_id,
                            label: t('mods.versionCleanup.replacementOption', {
                              version: cleanVersion(replacement.version),
                              state: t(`mods.versionCleanup.state.${replacement.installed_enabled ? 'active' : replacement.installed ? 'stored' : 'saved'}`),
                            }),
                          }));
                        return (
                          <div key={id} className={`gf-version-cleanup-candidate${checked ? ' is-selected' : ''}${showAdvanced && candidate.protected ? ' is-protected' : ''}`}>
                            <label className="gf-version-cleanup-choice">
                              <input
                                type="checkbox"
                                checked={checked}
                                disabled={disabled}
                                onChange={(event) => toggleCandidate(candidate, event.target.checked)}
                                aria-label={t('mods.versionCleanup.selectVersion', {
                                  mod: family.display_name,
                                  version: cleanVersion(candidate.option.version),
                                })}
                              />
                              <span className="gf-version-cleanup-version">v{cleanVersion(candidate.option.version)}</span>
                              {showAdvanced && candidate.protected && (
                                <span className="gf-version-cleanup-protected" title={protectedTitle}>
                                  <LockKeyhole size={11} aria-hidden />
                                  {t('mods.versionCleanup.protectedBadge')}
                                </span>
                              )}
                            </label>
                            <span className="gf-version-cleanup-provider">
                              {t(`mods.versionCleanup.provider.${candidate.provider}`)}
                            </span>
                            <span className="gf-version-cleanup-state">
                              {t(`mods.versionCleanup.state.${candidateState(candidate)}`)}
                            </span>
                            <span className="gf-version-cleanup-reason">
                              {reasonText}
                            </span>
                            {checked && candidate.protected && (
                              <label className="gf-version-cleanup-replacement">
                                <span>{t('mods.versionCleanup.replacementLabel')}</span>
                                <Select
                                  value={replacements[id] ?? ''}
                                  onChange={(value) => setReplacements((current) => ({ ...current, [id]: value }))}
                                  placeholder={t('mods.versionCleanup.replacementPlaceholder')}
                                  aria-label={t('mods.versionCleanup.replacementFor', {
                                    mod: family.display_name,
                                    version: cleanVersion(candidate.option.version),
                                  })}
                                  options={replacementOptions}
                                />
                              </label>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </details>
                ))}
              </div>
              {filteredFamilies.length > visibleLimit && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setVisibleLimit((current) => current + PAGE_SIZE)}
                >
                  {t('mods.versionCleanup.showMore', {
                    count: Math.min(PAGE_SIZE, filteredFamilies.length - visibleLimit),
                  })}
                </Button>
              )}
              {invalidReplacement && (
                <div className="gf-version-cleanup-warning" role="alert">
                  <AlertTriangle size={14} /> {t('mods.versionCleanup.replacementRequired')}
                </div>
              )}
            </>
          ) : null}
          {results.length > 0 && (
            <div className="gf-version-cleanup-results" role="status">
              <strong>{t('mods.versionCleanup.resultsTitle')}</strong>
              <span>{t('mods.versionCleanup.resultsSummary', {
                removed: results.filter((result) => result.success).length,
                failed: results.filter((result) => !result.success).length,
              })}</span>
              {results.filter((result) => !result.success).map((result) => (
                <span key={result.mod_version_id} className="gf-version-cleanup-result-error">
                  {result.error}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="gf-modal-foot gf-version-cleanup-foot">
          <span>{t('mods.versionCleanup.selectedCount', { count: selected.size })}</span>
          <div className="gf-version-cleanup-actions">
            <Button variant="secondary" onClick={onClose} disabled={running}>
              {t('common.close')}
            </Button>
            <Button variant="danger" onClick={() => void executeCleanup()} disabled={!canRun}>
              {running ? t('mods.versionCleanup.removing') : t('mods.versionCleanup.removeSelected')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
