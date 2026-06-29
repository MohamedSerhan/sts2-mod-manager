import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../contexts/ToastContext';
import { setModSnooze } from './useTauri';

const REASON_LIMIT = 220;

function cleanFailureReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= REASON_LIMIT) return collapsed;
  return `${collapsed.slice(0, REASON_LIMIT - 3).trimEnd()}...`;
}

interface FailedUpdateRecoveryInput {
  modName: string;
  displayName?: string | null;
  folderName?: string | null;
  skipVersion?: string | null;
  error: unknown;
  onSkipped?: () => Promise<void> | void;
}

export function useFailedUpdateRecovery() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const toast = useToast();

  return useCallback(async ({
    modName,
    displayName,
    folderName,
    skipVersion,
    error,
    onSkipped,
  }: FailedUpdateRecoveryInput): Promise<boolean> => {
    const version = skipVersion?.trim();
    if (!version) return false;

    const name = displayName?.trim() || modName;
    const reason = cleanFailureReason(error) || t('mods.updateFailureRecovery.unknownReason');
    const result = await confirm({
      title: t('mods.updateFailureRecovery.title', { name }),
      body: (
        <span>
          {t('mods.updateFailureRecovery.body')}
          <br />
          {t('mods.updateFailureRecovery.reason', { reason })}
        </span>
      ),
      confirmLabel: t('mods.updateFailureRecovery.skip'),
      cancelLabel: t('mods.updateFailureRecovery.keepShowing'),
      width: 520,
    });
    if (!result) return false;

    try {
      await setModSnooze(modName, version, folderName ?? null);
      try {
        await onSkipped?.();
      } catch {
        // The skip has already been saved; a later audit will refresh the row.
      }
      toast.success(t('mods.toast.updateSkippedAfterFailure', { name }));
      return true;
    } catch (e) {
      toast.error(t('mods.toast.updateSkipFailed', {
        error: e instanceof Error ? e.message : String(e),
      }));
      return false;
    }
  }, [confirm, t, toast]);
}
