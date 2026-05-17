# Chinese Localization With Auto Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add auto-detected Simplified Chinese localization with explicit override controls and merge-ready tests.

**Architecture:** Rework PR #45 on a maintainer branch based on current `main`. Keep detection and persistence in app-owned helpers, use `i18next`/`react-i18next` for rendering, and preserve English as the fallback for unsupported locales.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, i18next, react-i18next.

---

### Task 1: Language Resolution Core

**Files:**
- Create: `src/i18n/language.ts`
- Create: `src/i18n/language.test.ts`
- Create: `src/i18n/index.ts`
- Modify: `src/main.tsx`
- Modify: `src/__test__/setup.ts`

- [ ] Write failing tests for `resolveDetectedLanguage`, storage load/save, and invalid preference fallback.
- [ ] Implement language registry with `auto`, `en`, and `zh-Hans`.
- [ ] Implement Chinese locale routing: all `zh-*` routes to `zh-Hans` while it is the only Chinese resource.
- [ ] Initialize i18next from `sts2mm-language`; do not use `i18nextLng`.
- [ ] Import i18n in app and test setup.

### Task 2: Locale Resources and Key Parity

**Files:**
- Create: `src/i18n/locales/en.json`
- Create: `src/i18n/locales/zh-Hans.json`
- Create: `src/i18n/locales/parity.test.ts`

- [ ] Pull useful English and Simplified Chinese strings from PR #45.
- [ ] Add any current-main strings missing from PR #45.
- [ ] Add a parity test that flattens both JSON files and fails if either side is missing keys.
- [ ] Fix PR #45's missing `mods.toast.snoozed` Chinese key.

### Task 3: UI Conversion and Selectors

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/contexts/AppContext.tsx`
- Modify: `src/contexts/ToastContext.tsx`
- Modify: `src/components/*.tsx` touched by PR #45
- Modify: `src/views/*.tsx` touched by PR #45
- Create: `src/components/LanguageSelect.tsx`
- Create: `src/components/LanguageSelect.test.tsx`

- [ ] Merge PR #45's `t()` conversions onto current `main`.
- [ ] Resolve conflicts against v1.4.5 without dropping current fixes.
- [ ] Replace hardcoded language dropdowns with `LanguageSelect`.
- [ ] Add `LanguageSelect` to onboarding header and Settings > General.
- [ ] Fix `<Trans>` component mappings so `tsc` passes.

### Task 4: Tests and CI Repair

**Files:**
- Modify tests that assert user-visible strings only when the English text changed.
- Avoid broad snapshot rewrites.

- [ ] Run focused i18n tests and make them pass.
- [ ] Run component tests affected by onboarding/settings/language selector and make them pass.
- [ ] Run `npm run build` and keep `tsc && vite build`.
- [ ] Run `npm run qa:unit`.

### Task 5: Maintainer PR Readiness

**Files:**
- Modify: `CHANGELOG.md` if appropriate for unreleased notes.

- [ ] Check `git diff` for accidental contributor-branch artifacts.
- [ ] Ensure the branch is based on `origin/main`.
- [ ] Prepare final notes crediting PR #45 and explaining that this is a maintainer-side rework.
