// v5 batch 4 — full-screen launching overlay shown while we kick off the
// game. Uses the gf-launch-* classes from styles.css.
import { useTranslation } from 'react-i18next';

interface Props {
  vanilla?: boolean;
  onCancel: () => void;
}

export function LaunchSpinner({ vanilla = false, onCancel }: Props) {
  const { t } = useTranslation();
  return (
    <div className="gf-launch-back">
      <div className="gf-launch-card">
        <div className="gf-launch-spinner" />
        <div className="gf-launch-t">
          {vanilla ? t('launch.titleVanilla') : t('launch.title')}
        </div>
        <div className="gf-launch-s">
          {vanilla ? t('launch.subtitleVanilla') : t('launch.subtitle')}
        </div>
        <button className="gf-btn-3" style={{ marginTop: 4 }} onClick={onCancel}>
          {t('launch.hide')}
        </button>
      </div>
    </div>
  );
}
