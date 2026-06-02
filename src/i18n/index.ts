import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import zhHans from "./locales/zh-Hans.json";
import ru from "./locales/ru.json";
import ar from "./locales/ar.json";
import {
  getBrowserLocales,
  isRtlLanguage,
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

// Keep the document's text direction + lang attribute in sync with the active
// locale so Arabic (and any future RTL language) lays out right-to-left. No-op
// outside a DOM, e.g. node/unit-test contexts that import i18n only for strings.
export function applyDocumentDirection(lng: string): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.setAttribute("lang", lng);
  root.setAttribute("dir", isRtlLanguage(lng) ? "rtl" : "ltr");
}

const initialLanguage = resolveLanguagePreference(loadLanguagePreference());

// Register before init so the `languageChanged` event i18next emits during
// initialization also flips the direction, and on every later switch from the
// language selector.
i18n.on("languageChanged", applyDocumentDirection);

i18n
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      "zh-Hans": { translation: zhHans },
      ru: { translation: ru },
      ar: { translation: ar },
    },
    lng: initialLanguage,
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED_LANGUAGE_CODES],
    nonExplicitSupportedLngs: false,
    debug: false,
    interpolation: {
      escapeValue: false,
    },
  });

// Apply the initial direction explicitly in case the languageChanged event
// fired before the listener attached (or init resolved synchronously).
applyDocumentDirection(i18n.language || initialLanguage);

export default i18n;
