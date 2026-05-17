# Chinese Localization With Auto Detection Design

## Goal

Add respectful Simplified Chinese support while keeping the contributor's PR #45 credited and leaving the contributor branch untouched.

## Product Behavior

- The app supports `Auto`, `English`, and `简体中文`.
- `Auto` is the default for new users.
- In `Auto`, any Chinese system locale uses the available Simplified Chinese translation for now.
- Unsupported non-Chinese locales use English.
- The UI labels the translation as `简体中文`; it does not call it generic "Chinese".
- Users can override detection in onboarding and Settings.
- The app stores the override in an app-owned key, `sts2mm-language`, instead of relying on i18next's cache key.
- Future Traditional Chinese support should add `繁體中文` and route `zh-Hant`, `zh-TW`, `zh-HK`, and `zh-MO` there.

## Architecture

- Add a small i18n module that owns locale resources, language preference storage, and locale detection.
- Use `i18next` plus `react-i18next`, but keep browser detection logic in app code so we can make culturally explicit routing choices.
- Rework PR #45's extracted strings and translations onto current `main`, keeping `tsc && vite build`.
- Add tests for language resolution, preference persistence, key parity, and visible selectors.

## UI

- Onboarding gets a compact language selector in its header so first-run users can immediately override `Auto`.
- Settings > General gets a language selector for current users.
- The selector options are `Auto`, `English`, and `简体中文`.

## Quality Gates

- `npm run build` must keep TypeScript checking.
- `npm run qa:unit` must pass.
- Locale key parity must fail when `zh-Hans` is missing an English key.
- PR #45 should be credited in commit/PR text, but not force-mutated.
