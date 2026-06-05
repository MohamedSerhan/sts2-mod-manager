# Non-GitHub Feedback Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-GitHub feedback path that points users (especially in China, where GitHub is unreliable) to the mod's Nexus **Posts** tab, which the existing triage automation already polls, translates, and files.

**Architecture:** Frontend-only. One Nexus-URL constant (single source of truth) + one shared `useOpenFeedback` hook (open + error-toast in one place) + three call sites (About footer button, bug-report modal row, logs viewer button) + localized strings in all four locales. No Rust/Tauri changes — the existing `openExternalUrl` (`invoke('open_external_url')`) opens the URL.

**Tech Stack:** React + TypeScript, react-i18next, Vitest + Testing Library, Tauri `invoke` (mocked in tests via `src/__test__/setup.ts`).

**Spec:** `docs/superpowers/specs/2026-06-04-non-github-feedback-channel-design.md`

**Deviation from spec (intentional):** the spec proposed a new `src/lib/nexusLinks.ts`. During planning I found `src/lib/nexusUrl.ts` already exists (a parser for arbitrary user-supplied Nexus refs). To avoid two confusingly-named `nexus*.ts` modules, the feedback URL constant is added to the existing `nexusUrl.ts` instead. Same "single source of truth," one fewer file. The spec also inlined `openExternalUrl(...)`; this plan factors the open + error-toast into a shared `useOpenFeedback` hook because there are three identical call sites (DRY).

---

## File Structure

| File | Responsibility | Change |
|------|----------------|--------|
| `src/lib/nexusUrl.ts` | Nexus URL helpers; now also the app's own feedback page constant | Modify (append constant) |
| `src/lib/nexusUrl.test.ts` | Unit tests for the above | Modify (append test) |
| `src/hooks/useOpenFeedback.ts` | Shared "open the Nexus Posts page + toast on failure" callback | Create |
| `src/hooks/useOpenFeedback.test.tsx` | Tests for the hook (success + error paths) | Create |
| `src/i18n/locales/{en,zh-Hans,ru,ar}.json` | `feedback.*` strings (+ button label) | Modify (add block) |
| `src/components/AboutCard.tsx` | "Send feedback" footer button | Modify |
| `src/components/AboutCard.test.tsx` | Test the button opens the Posts page | Modify |
| `src/components/DiagnosticBundle.tsx` | In-flow "No GitHub?" feedback row | Modify |
| `src/components/DiagnosticBundle.test.tsx` | Test the row opens the Posts page | Modify |
| `src/components/LogsViewer.tsx` | "Send feedback" button next to "Send to support" | Modify |
| `src/components/LogsViewer.test.tsx` | Test the button opens the Posts page | Modify |

---

### Task 1: Feedback mechanism — URL constant, shared hook, and localized strings

**Goal:** A tested, single source of truth for the Nexus feedback URL, a shared `useOpenFeedback` hook that opens it (toasting on failure), and the `feedback.*` strings in all four locales.

**Files:**
- Modify: `src/lib/nexusUrl.ts` (append the constant)
- Modify: `src/lib/nexusUrl.test.ts` (append a test)
- Create: `src/hooks/useOpenFeedback.ts`
- Create: `src/hooks/useOpenFeedback.test.tsx`
- Modify: `src/i18n/locales/en.json`, `zh-Hans.json`, `ru.json`, `ar.json`

**Acceptance Criteria:**
- [ ] `FEEDBACK_NEXUS_POSTS_URL` resolves to `https://www.nexusmods.com/slaythespire2/mods/856?tab=posts`.
- [ ] `useOpenFeedback()` returns a callback that calls `invoke('open_external_url', { url: FEEDBACK_NEXUS_POSTS_URL })`.
- [ ] On open failure, the hook surfaces a `feedback.couldntOpen` toast.
- [ ] All four locales contain the `feedback.*` keys with real (non-copied-English) translations; `parity.test.ts` passes.

**Verify:** `npx vitest run src/lib/nexusUrl.test.ts src/hooks/useOpenFeedback.test.tsx src/i18n/locales/parity.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Write the failing constant test** — append to `src/lib/nexusUrl.test.ts`:

```ts
import { FEEDBACK_NEXUS_POSTS_URL } from './nexusUrl';

describe('FEEDBACK_NEXUS_POSTS_URL', () => {
  it('points at the mod-manager Nexus Posts tab the triage polls', () => {
    expect(FEEDBACK_NEXUS_POSTS_URL).toBe(
      'https://www.nexusmods.com/slaythespire2/mods/856?tab=posts',
    );
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

Run: `npx vitest run src/lib/nexusUrl.test.ts`
Expected: FAIL — `FEEDBACK_NEXUS_POSTS_URL` is not exported.

- [ ] **Step 3: Add the constant** — append to `src/lib/nexusUrl.ts`:

```ts
// The mod manager's OWN Nexus mod page (Slay the Spire 2, mod 856). Used by the
// non-GitHub feedback path (#116): the Posts tab is polled, translated, and
// filed by the Nexus->GitHub triage automation, so users without a GitHub
// account can leave feedback there. Kept in sync with scripts/nexus-triage.mjs
// (GAME_DOMAIN='slaythespire2', MOD_ID=856). Distinct from the parser helpers
// above, which handle arbitrary user-supplied Nexus references.
export const FEEDBACK_NEXUS_POSTS_URL =
  'https://www.nexusmods.com/slaythespire2/mods/856?tab=posts';
```

- [ ] **Step 4: Run it, watch it pass**

Run: `npx vitest run src/lib/nexusUrl.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the `feedback.*` strings to all four locales.** Insert a top-level `"feedback"` block immediately after the `"about": { ... },` block in each file. The `couldntOpen` interpolates `{{error}}`.

`src/i18n/locales/en.json`:
```json
  "feedback": {
    "sendFeedback": "Send feedback",
    "noGitHubPrompt": "No GitHub account?",
    "nexusCta": "Post feedback on the Nexus page",
    "translatedNote": "Write in your own language — we read every comment (translated to English automatically).",
    "couldntOpen": "Couldn't open the Nexus page: {{error}}"
  },
```

`src/i18n/locales/zh-Hans.json`:
```json
  "feedback": {
    "sendFeedback": "发送反馈",
    "noGitHubPrompt": "没有 GitHub 账号？",
    "nexusCta": "在 Nexus 页面留言反馈",
    "translatedNote": "用你的母语留言即可——我们会阅读每一条评论（自动翻译成英文）。",
    "couldntOpen": "无法打开 Nexus 页面：{{error}}"
  },
```

`src/i18n/locales/ru.json`:
```json
  "feedback": {
    "sendFeedback": "Отправить отзыв",
    "noGitHubPrompt": "Нет аккаунта GitHub?",
    "nexusCta": "Оставьте отзыв на странице Nexus",
    "translatedNote": "Пишите на своём языке — мы читаем каждый комментарий (он автоматически переводится на английский).",
    "couldntOpen": "Не удалось открыть страницу Nexus: {{error}}"
  },
```

`src/i18n/locales/ar.json`:
```json
  "feedback": {
    "sendFeedback": "إرسال ملاحظات",
    "noGitHubPrompt": "ليس لديك حساب GitHub؟",
    "nexusCta": "انشر ملاحظاتك على صفحة Nexus",
    "translatedNote": "اكتب بلغتك — نقرأ كل تعليق (يُترجَم تلقائيًا إلى الإنجليزية).",
    "couldntOpen": "تعذّر فتح صفحة Nexus: {{error}}"
  },
```

- [ ] **Step 6: Confirm locale parity**

Run: `npx vitest run src/i18n/locales/parity.test.ts`
Expected: PASS (keys in sync across locales; no copied-English values — the brand tokens "Nexus"/"GitHub" inside otherwise-translated sentences are fine).

- [ ] **Step 7: Write the failing hook test** — create `src/hooks/useOpenFeedback.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { useOpenFeedback } from './useOpenFeedback';
import { AllProviders } from '../__test__/providers';
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import { FEEDBACK_NEXUS_POSTS_URL } from '../lib/nexusUrl';

function Harness() {
  const openFeedback = useOpenFeedback();
  return <button onClick={openFeedback}>open</button>;
}

function renderHarness() {
  return render(
    <AllProviders>
      <Harness />
    </AllProviders>,
  );
}

describe('useOpenFeedback', () => {
  it('opens the Nexus Posts URL via open_external_url', async () => {
    const user = userEvent.setup();
    renderHarness();
    await user.click(screen.getByRole('button', { name: 'open' }));
    const opened = getInvokeCalls().filter((c) => c.cmd === 'open_external_url');
    expect(opened).toHaveLength(1);
    expect(opened[0].args).toEqual({ url: FEEDBACK_NEXUS_POSTS_URL });
  });

  it('toasts when opening the page fails', async () => {
    registerInvokeHandler('open_external_url', () => {
      throw new Error('no browser');
    });
    const user = userEvent.setup();
    renderHarness();
    await user.click(screen.getByRole('button', { name: 'open' }));
    await waitFor(() => {
      expect(
        screen.getByText(/Couldn't open the Nexus page: no browser/),
      ).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 8: Run it, watch it fail**

Run: `npx vitest run src/hooks/useOpenFeedback.test.tsx`
Expected: FAIL — `useOpenFeedback` module does not exist.

- [ ] **Step 9: Implement the hook** — create `src/hooks/useOpenFeedback.ts`:

```ts
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
```

- [ ] **Step 10: Run it, watch it pass**

Run: `npx vitest run src/hooks/useOpenFeedback.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 11: Commit**

```bash
git add src/lib/nexusUrl.ts src/lib/nexusUrl.test.ts src/hooks/useOpenFeedback.ts src/hooks/useOpenFeedback.test.tsx src/i18n/locales/en.json src/i18n/locales/zh-Hans.json src/i18n/locales/ru.json src/i18n/locales/ar.json
git commit -m "feat(feedback): Nexus feedback URL + useOpenFeedback hook + i18n (#116)"
```

---

### Task 2: "Send feedback" button in the About footer

**Goal:** A discoverable, top-level "Send feedback" action in the About footer that opens the Nexus Posts page.

**Files:**
- Modify: `src/components/AboutCard.tsx`
- Modify: `src/components/AboutCard.test.tsx`

**Acceptance Criteria:**
- [ ] The footer renders a "Send feedback" button.
- [ ] Clicking it calls `invoke('open_external_url', { url: FEEDBACK_NEXUS_POSTS_URL })`.
- [ ] Existing AboutCard tests still pass.

**Verify:** `npx vitest run src/components/AboutCard.test.tsx` → pass.

**Steps:**

- [ ] **Step 1: Write the failing test** — append inside the `describe('<AboutCard>', ...)` block in `src/components/AboutCard.test.tsx`:

```tsx
it('"Send feedback" opens the Nexus Posts page (no GitHub needed)', async () => {
  const user = userEvent.setup();
  render(<Wrapped />);
  await user.click(screen.getByRole('button', { name: 'Send feedback' }));
  const opened = getInvokeCalls().filter((c) => c.cmd === 'open_external_url');
  expect(opened).toHaveLength(1);
  expect(opened[0].args).toEqual({ url: FEEDBACK_NEXUS_POSTS_URL });
});
```

Add these imports at the top of the file (extend the existing setup import; add the constant import):

```tsx
import { getInvokeCalls, setMockAppVersion } from '../__test__/setup';
import { FEEDBACK_NEXUS_POSTS_URL } from '../lib/nexusUrl';
```

- [ ] **Step 2: Run it, watch it fail**

Run: `npx vitest run src/components/AboutCard.test.tsx`
Expected: FAIL — no button named "Send feedback".

- [ ] **Step 3: Add the button.** In `src/components/AboutCard.tsx`, add the import and hook, and a third `Button` in the actions span.

Import + hook (top of component):
```tsx
import { useOpenFeedback } from '../hooks/useOpenFeedback';
```
```tsx
  const openFeedback = useOpenFeedback();
```

Add the button inside `<span className="gf-about-footer-actions">`, after the "Report a bug" button:
```tsx
            <Button variant="ghost" size="sm" onClick={openFeedback}>
              {t('feedback.sendFeedback')}
            </Button>
```

- [ ] **Step 4: Run it, watch it pass**

Run: `npx vitest run src/components/AboutCard.test.tsx`
Expected: PASS (new test + all existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/AboutCard.tsx src/components/AboutCard.test.tsx
git commit -m "feat(feedback): Send feedback button in About footer (#116)"
```

---

### Task 3: In-flow "No GitHub?" feedback row in the bug-report modal

**Goal:** Inside the "Report a bug" modal, offer the Nexus feedback alternative right where the GitHub barrier is hit — without changing the existing GitHub/diagnostic flow.

**Files:**
- Modify: `src/components/DiagnosticBundle.tsx`
- Modify: `src/components/DiagnosticBundle.test.tsx`

**Acceptance Criteria:**
- [ ] The modal renders the prompt + translated-note text and a "Post feedback on the Nexus page" button.
- [ ] Clicking the button calls `invoke('open_external_url', { url: FEEDBACK_NEXUS_POSTS_URL })`.
- [ ] The existing report/upload/copy flow is unchanged; existing tests still pass.

**Verify:** `npx vitest run src/components/DiagnosticBundle.test.tsx` → pass.

**Steps:**

- [ ] **Step 1: Write the failing test** — append inside the `describe('<DiagnosticBundle> (Report a bug)', ...)` block in `src/components/DiagnosticBundle.test.tsx`:

```tsx
it('offers a no-GitHub Nexus feedback link that opens the Posts page', async () => {
  const user = userEvent.setup();
  render(<Wrap />);
  await user.click(
    screen.getByRole('button', { name: 'Post feedback on the Nexus page' }),
  );
  const opened = getInvokeCalls().filter((c) => c.cmd === 'open_external_url');
  expect(opened).toHaveLength(1);
  expect(opened[0].args).toEqual({ url: FEEDBACK_NEXUS_POSTS_URL });
});
```

Update the setup import to add `getInvokeCalls`, and add the constant import:
```tsx
import { getInvokeCalls, registerInvokeHandler } from '../__test__/setup';
import { FEEDBACK_NEXUS_POSTS_URL } from '../lib/nexusUrl';
```

- [ ] **Step 2: Run it, watch it fail**

Run: `npx vitest run src/components/DiagnosticBundle.test.tsx`
Expected: FAIL — no "Post feedback on the Nexus page" button.

- [ ] **Step 3: Add the row.** In `src/components/DiagnosticBundle.tsx`:

Import + hook:
```tsx
import { useOpenFeedback } from '../hooks/useOpenFeedback';
```
```tsx
  const openFeedback = useOpenFeedback();
```

Insert this block at the end of the `gf-modal-body` div, immediately after the `{awaitingConsent && ( ... )}` banner block:
```tsx
          <div
            style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: '1px dashed var(--indigo-line)',
            }}
          >
            <div style={{ fontSize: 12, color: 'var(--ink-mute)', marginBottom: 6 }}>
              <b style={{ color: 'var(--ink)' }}>{t('feedback.noGitHubPrompt')}</b>{' '}
              {t('feedback.translatedNote')}
            </div>
            <button type="button" className="gf-btn-3 gf-btn-2-sm" onClick={openFeedback}>
              {t('feedback.nexusCta')}
            </button>
          </div>
```

- [ ] **Step 4: Run it, watch it pass**

Run: `npx vitest run src/components/DiagnosticBundle.test.tsx`
Expected: PASS (new test + all existing tests — the new button text does not collide with the existing `Open bug report|Working` / `Copy report` / `Close` lookups).

- [ ] **Step 5: Commit**

```bash
git add src/components/DiagnosticBundle.tsx src/components/DiagnosticBundle.test.tsx
git commit -m "feat(feedback): no-GitHub Nexus row in bug-report modal (#116)"
```

---

### Task 4: "Send feedback" button in the logs viewer

**Goal:** Offer the same Nexus feedback alternative next to "Send to support" in the logs viewer (Settings → Advanced), the other `buildGitHubIssueUrl` site named in #116.

**Files:**
- Modify: `src/components/LogsViewer.tsx`
- Modify: `src/components/LogsViewer.test.tsx`

**Acceptance Criteria:**
- [ ] The logs bar renders a "Send feedback" button.
- [ ] Clicking it calls `invoke('open_external_url', { url: FEEDBACK_NEXUS_POSTS_URL })`.
- [ ] Existing LogsViewer tests still pass.

**Verify:** `npx vitest run src/components/LogsViewer.test.tsx` → pass.

**Steps:**

- [ ] **Step 1: Write the failing test** — append inside the `describe('<LogsViewer>', ...)` block in `src/components/LogsViewer.test.tsx`:

```tsx
it('"Send feedback" opens the Nexus Posts page (no GitHub needed)', async () => {
  registerInvokeHandler('read_log_tail', () => SAMPLE_LOG);
  const user = userEvent.setup();
  render(<Wrap />);
  await waitFor(() => {
    expect(screen.getByRole('button', { name: 'Send feedback' })).toBeInTheDocument();
  });
  await user.click(screen.getByRole('button', { name: 'Send feedback' }));
  const opened = getInvokeCalls().filter((c) => c.cmd === 'open_external_url');
  expect(opened).toHaveLength(1);
  expect(opened[0].args).toEqual({ url: FEEDBACK_NEXUS_POSTS_URL });
});
```

Add the constant import (the file already imports `getInvokeCalls, registerInvokeHandler`, and defines `SAMPLE_LOG` at module scope):
```tsx
import { FEEDBACK_NEXUS_POSTS_URL } from '../lib/nexusUrl';
```

- [ ] **Step 2: Run it, watch it fail**

Run: `npx vitest run src/components/LogsViewer.test.tsx`
Expected: FAIL — no "Send feedback" button.

- [ ] **Step 3: Add the button.** In `src/components/LogsViewer.tsx`:

Import + hook:
```tsx
import { useOpenFeedback } from '../hooks/useOpenFeedback';
```
```tsx
  const openFeedback = useOpenFeedback();
```

Add the button in the `gf-logs-bar`, immediately after the existing "Send to support" button:
```tsx
        <button className="gf-btn-3 gf-btn-2-sm" onClick={openFeedback} title={t('feedback.nexusCta')}>
          {t('feedback.sendFeedback')}
        </button>
```

- [ ] **Step 4: Run it, watch it pass**

Run: `npx vitest run src/components/LogsViewer.test.tsx`
Expected: PASS (new test + all existing tests).

- [ ] **Step 5: Commit**

```bash
git add src/components/LogsViewer.tsx src/components/LogsViewer.test.tsx
git commit -m "feat(feedback): Send feedback button in logs viewer (#116)"
```

---

## Final verification (after all tasks)

- [ ] **Full unit suite:** `npx vitest run` → all green.
- [ ] **Locale parity:** `npm run qa:i18n` → green.
- [ ] **Typecheck:** `npx tsc --noEmit` → no errors.
- [ ] **Manual smoke (optional):** `npm run dev`, open the Home footer → "Send feedback" opens the Nexus Posts tab in the system browser; open "Report a bug" → the "No GitHub account?" row's button does the same; Settings → Advanced → logs → "Send feedback" likewise.

## Spec coverage check

- Non-GitHub feedback path → Tasks 2, 3, 4 (three entry points).
- Reaches maintainer in English → unchanged; the existing triage + `@claude` translate the Nexus Posts content (no code here).
- Abandonable / not tied to one person → the channel is UI + a URL constant (`FEEDBACK_NEXUS_POSTS_URL`); delete the call sites or retarget the constant.
- Localized, first-class zh-Hans → Task 1 (all four locales, parity-gated).
- Destination = Posts tab → `FEEDBACK_NEXUS_POSTS_URL` (`?tab=posts`).
