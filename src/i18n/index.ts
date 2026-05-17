import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zhHans from "./locales/zh-Hans.json";
import {
  getBrowserLocales,
  loadLanguagePreference,
  resolveDetectedLanguage,
  SUPPORTED_LANGUAGE_CODES,
  type LanguagePreference,
  type SupportedLanguageCode,
} from "./language";

export function resolveLanguagePreference(preference: LanguagePreference): SupportedLanguageCode {
  return preference === "auto"
    ? resolveDetectedLanguage(getBrowserLocales())
    : preference;
}

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      "zh-Hans": { translation: zhHans },
    },
    lng: resolveLanguagePreference(loadLanguagePreference()),
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED_LANGUAGE_CODES],
    nonExplicitSupportedLngs: false,
    debug: false,
    interpolation: {
      escapeValue: false,
    },
  });

export default i18n;
