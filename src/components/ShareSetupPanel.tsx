import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { setGithubToken, openExternalUrl } from '../hooks/useTauri';
import { HelpHint } from './HelpHint';

/**
 * Inline GitHub setup explained in plain language at the moment the
 * curator clicks Share. The hard "Go to Settings" wall used to send
 * first-time curators away from the share flow without explaining
 * WHY GitHub is needed; this panel keeps them in the flow and lets
 * them paste a token + Save without leaving the modal.
 *
 * On successful save the parent re-checks the token status and the
 * modal naturally transitions into its pre-flight render — the panel
 * itself does NOT close the modal.
 */
interface Props {
  /** Re-check the token status and update local state. Called only
   *  after `set_github_token` resolves successfully. */
  onSaved: () => void | Promise<void>;
  /** Escape hatch — used when the curator would rather configure
   *  the token from Settings. Parent is responsible for routing. */
  onConfigureLater: () => void;
}

/** Scoped token creation URL — pre-fills the `public_repo` scope and
 *  a description so the curator only has to click "Generate" on
 *  GitHub instead of navigating GitHub's scope picker. */
const SCOPED_TOKEN_URL =
  'https://github.com/settings/tokens/new?scopes=public_repo&description=sts2-mod-manager';

export function ShareSetupPanel({ onSaved, onConfigureLater }: Props) {
  const { t } = useTranslation();
  const [token, setToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmed = token.trim();
  const canSave = trimmed.length > 0 && !saving;

  async function handleSave() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await setGithubToken(trimmed);
      await onSaved();
    } catch {
      setError(t('shareSetup.saveError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="gf-share-setup" aria-labelledby="share-setup-title">
      <h2 id="share-setup-title" className="gf-share-setup-title">
        {t('shareSetup.title')}
        <HelpHint helpKey="githubWhy" />
      </h2>
      <p>{t('shareSetup.explainLine1')}</p>
      <p>{t('shareSetup.explainLine2')}</p>
      <p>{t('shareSetup.explainLine3')}</p>
      <button
        type="button"
        className="gf-btn-3"
        onClick={() => {
          // Fire-and-forget: failure to open the browser is recoverable —
          // the curator can paste the URL manually. We don't want a flaky
          // browser launch to disrupt the inline flow.
          openExternalUrl(SCOPED_TOKEN_URL).catch(() => {});
        }}
      >
        {t('shareSetup.createTokenLink')}
      </button>
      <div className="gf-share-setup-field">
        <label htmlFor="share-setup-token">{t('shareSetup.tokenLabel')}</label>
        <input
          id="share-setup-token"
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          placeholder={t('shareSetup.tokenPlaceholder')}
          aria-label={t('shareSetup.tokenLabel')}
          className="gf-set-input"
        />
      </div>
      {error && (
        <div role="alert" className="gf-share-setup-error">
          {error}
        </div>
      )}
      <div className="gf-share-setup-actions">
        <button
          type="button"
          className="gf-btn"
          disabled={!canSave}
          onClick={handleSave}
        >
          {saving ? t('shareSetup.saving') : t('shareSetup.saveBtn')}
        </button>
        <button
          type="button"
          className="gf-link-button"
          onClick={onConfigureLater}
        >
          {t('shareSetup.settingsEscape')}
        </button>
      </div>
    </section>
  );
}
