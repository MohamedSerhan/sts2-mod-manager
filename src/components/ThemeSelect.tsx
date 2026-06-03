import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { isSupportedThemePreference, type ThemePreference } from '../theme/theme';

const OPTIONS: Array<{ value: ThemePreference; labelKey: string }> = [
  { value: 'auto', labelKey: 'settings.theme.auto' },
  { value: 'dark', labelKey: 'settings.theme.dark' },
  { value: 'light', labelKey: 'settings.theme.light' },
];

export function ThemeSelect() {
  const { t } = useTranslation();
  const { preference, setPreference } = useTheme();
  const id = useId();

  function handleChange(value: string) {
    if (!isSupportedThemePreference(value)) return;
    setPreference(value);
  }

  return (
    <div className="gf-theme-select">
      <label htmlFor={id} className="gf-field-label">
        {t('settings.theme.label')}
      </label>
      <select
        id={id}
        className="gf-set-input"
        value={preference}
        onChange={(event) => handleChange(event.target.value)}
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {t(option.labelKey)}
          </option>
        ))}
      </select>
    </div>
  );
}
