import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { isSupportedThemePreference, type ThemePreference } from '../theme/theme';
import { Select } from './Select';

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
      <Select
        id={id}
        value={preference}
        onChange={handleChange}
        options={OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
      />
    </div>
  );
}
