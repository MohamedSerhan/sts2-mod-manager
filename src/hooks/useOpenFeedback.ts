import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useToast } from '../contexts/ToastContext';
import { openExternalUrl } from './useTauri';
import { FEEDBACK_NEXUS_POSTS_URL } from '../lib/nexusUrl';

/**
 * Opens the mod's Nexus Posts tab in the system browser — the non-GitHub
 * feedback path (#116). Shared by the About footer, the bug-report modal, and
 * the logs viewer so the open + error-toast behaviour lives in one place.
 */
export function useOpenFeedback(): () => Promise<void> {
  const { t } = useTranslation();
  const toast = useToast();
  return useCallback(async () => {
    try {
      await openExternalUrl(FEEDBACK_NEXUS_POSTS_URL);
    } catch (e) {
      toast.error(
        t('feedback.couldntOpen', {
          error: e instanceof Error ? e.message : String(e),
        }),
      );
    }
  }, [t, toast]);
}
