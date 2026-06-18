import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DEFAULT_LANGUAGE_PREFERENCE,
  loadLanguagePreference,
  saveLanguagePreference,
  isSupportedLanguagePreference,
  SUPPORTED_LANGUAGES,
  type LanguagePreference,
} from '../i18n/language';
import { resolveLanguagePreference } from '../i18n';
import { Select } from './Select';

interface LanguageSelectProps {
  compact?: boolean;
}

const OPTIONS: Array<{ value: LanguagePreference; labelKey: string }> = [
  { value: DEFAULT_LANGUAGE_PREFERENCE, labelKey: 'settings.language.auto' },
  ...SUPPORTED_LANGUAGES.map((language) => ({ value: language.code, labelKey: language.labelKey })),
];

export function LanguageSelect({ compact = false }: LanguageSelectProps) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [preference, setPreference] = useState<LanguagePreference>(() => loadLanguagePreference());

  async function handleChange(value: string) {
    if (!isSupportedLanguagePreference(value)) return;
    setPreference(value);
    saveLanguagePreference(value);
    await i18n.changeLanguage(resolveLanguagePreference(value));
  }

  return (
    <div className={compact ? 'gf-language-select compact' : 'gf-language-select'}>
      <label htmlFor={id} className="gf-field-label">
        {t('settings.language.label')}
      </label>
      <Select
        id={id}
        value={preference}
        onChange={(v) => void handleChange(v)}
        options={OPTIONS.map((option) => ({ value: option.value, label: t(option.labelKey) }))}
      />
    </div>
  );
}
