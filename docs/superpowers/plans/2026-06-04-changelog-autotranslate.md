# Auto-Translate Changelogs for Non-English Locales — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show non-English users a machine (AI) translation of the in-app "What's new" changelog body, with the literal #137 disclaimer ("The developer doesn't speak this language — view the original English changelog here") linking to that version's GitHub release notes; English locale is unchanged.

**Architecture:** Translations are bundled JSON (`src/i18n/changelog/<locale>.json`, version-keyed), produced at release time by a non-blocking AI script (`scripts/translate-changelog.mjs`) and committed into the same release commit. `src/lib/changelog.ts` gains a pure `getTranslatedBody()` lookup; `WhatsNewCard` renders the translated body + disclaimer when a translation exists, else falls back to the existing English-only notice. Runtime is fully offline.

**Tech Stack:** TypeScript + React (Vite), `react-i18next`, Vitest (jsdom) for `src/**`, `node:test` for `scripts/*.mjs`, `@anthropic-ai/sdk` (new devDependency, generator only), Tauri opener plugin.

**Spec:** [docs/superpowers/specs/2026-06-04-changelog-autotranslate-design.md](docs/superpowers/specs/2026-06-04-changelog-autotranslate-design.md)

**Reference facts (verified during planning):**
- Vitest `include` = `src/**/*.test.{ts,tsx}` only — script tests use `node:test` and are enumerated in `.github/workflows/ci.yml` (lines 205–210).
- Coverage thresholds are enforced on `src/**` (`npm run qa:coverage`); `scripts/**` is excluded from coverage.
- `openExternalUrl(url)` → `invoke('open_external_url', {url})` → test mock calls `openUrl(url)` (assert via `@tauri-apps/plugin-opener`'s `openUrl`).
- `parseChangelog(raw = changelogRaw)` already uses the injectable-default-arg pattern — mirror it for `getTranslatedBody`.
- i18n supported codes are exactly `en`, `zh-Hans`, `ru`, `ar` (`src/i18n/index.ts`).
- `parity.test.ts` enforces (a) key-for-key sync with `en.json` and (b) no copied-English leaf values — so new keys MUST be translated in every non-English locale.

---

### Task 1: `getTranslatedBody` lookup + bundled translation files

**Goal:** Add a pure, never-throwing `getTranslatedBody(version, locale)` to the changelog lib, backed by three (initially empty) bundled per-locale JSON maps.

**Files:**
- Create: `src/i18n/changelog/ru.json`, `src/i18n/changelog/ar.json`, `src/i18n/changelog/zh-Hans.json` (each `{}` for now)
- Modify: `src/lib/changelog.ts` (add import block + `getTranslatedBody`)
- Test: `src/lib/changelog.test.ts` (append a `getTranslatedBody` describe block)

**Acceptance Criteria:**
- [ ] `getTranslatedBody(version, locale, maps?)` returns the translated body string when present.
- [ ] Returns `null` for: English locale, unknown locale, missing version, and never throws.
- [ ] Locale is normalized to the file key (`ru-RU` → `ru`, any `zh*` → `zh-Hans`).
- [ ] The three JSON files exist so the static imports resolve and `tsc && vite build` passes.

**Verify:** `npx vitest run src/lib/changelog.test.ts` → all pass; `npm run build` → no TS errors.

**Steps:**

- [ ] **Step 1: Create the three bundled translation files.** Each is exactly:

```json
{}
```

Paths: `src/i18n/changelog/ru.json`, `src/i18n/changelog/ar.json`, `src/i18n/changelog/zh-Hans.json`.

- [ ] **Step 2: Write the failing tests.** Append to `src/lib/changelog.test.ts`:

```ts
import { getTranslatedBody } from './changelog';

describe('getTranslatedBody', () => {
  const MAPS = {
    ru: { '9.9.9': '### Добавлено\n- Переведено' },
    ar: { '9.9.9': '### تمت الإضافة\n- مترجم' },
    'zh-Hans': { '9.9.9': '### 新增\n- 已翻译' },
  };

  it('returns the translated body for a present version + locale', () => {
    expect(getTranslatedBody('9.9.9', 'ru', MAPS)).toBe('### Добавлено\n- Переведено');
    expect(getTranslatedBody('9.9.9', 'zh-Hans', MAPS)).toContain('已翻译');
  });

  it('normalizes region subtags and zh variants to the file key', () => {
    expect(getTranslatedBody('9.9.9', 'ru-RU', MAPS)).toContain('Переведено');
    expect(getTranslatedBody('9.9.9', 'zh-Hant', MAPS)).toContain('已翻译'); // any zh* → zh-Hans
  });

  it('returns null for English, unknown locale, or missing version', () => {
    expect(getTranslatedBody('9.9.9', 'en', MAPS)).toBeNull();
    expect(getTranslatedBody('9.9.9', 'en-US', MAPS)).toBeNull();
    expect(getTranslatedBody('9.9.9', 'de', MAPS)).toBeNull();
    expect(getTranslatedBody('0.0.0-absent', 'ru', MAPS)).toBeNull();
  });

  it('never throws against the real bundled maps (default arg)', () => {
    expect(() => getTranslatedBody('0.0.0-absent', 'ru')).not.toThrow();
    expect(getTranslatedBody('0.0.0-absent', 'ru')).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail.** Run: `npx vitest run src/lib/changelog.test.ts` → FAIL ("getTranslatedBody is not a function").

- [ ] **Step 4: Implement.** Add to the top of `src/lib/changelog.ts` (after the existing `changelogRaw` import):

```ts
import ruChangelog from '../i18n/changelog/ru.json';
import arChangelog from '../i18n/changelog/ar.json';
import zhHansChangelog from '../i18n/changelog/zh-Hans.json';

/** Bundled per-locale translation maps: version string → translated markdown
 *  body. Generated at release time by scripts/translate-changelog.mjs. */
type ChangelogTranslations = Record<string, Record<string, string>>;
const BUNDLED_TRANSLATIONS: ChangelogTranslations = {
  ru: ruChangelog as Record<string, string>,
  ar: arChangelog as Record<string, string>,
  'zh-Hans': zhHansChangelog as Record<string, string>,
};

/** Map an i18n language code to a translation-file key, or null if there is no
 *  bundled translation for it (English, or an unsupported locale). */
function translationKeyForLocale(locale: string): 'ru' | 'ar' | 'zh-Hans' | null {
  if (locale.startsWith('en')) return null;
  if (locale.startsWith('zh')) return 'zh-Hans';
  const base = locale.split('-')[0];
  if (base === 'ru') return 'ru';
  if (base === 'ar') return 'ar';
  return null;
}
```

Then add the exported function (place it after `getEntryForVersion`):

```ts
/** Machine-translated markdown body for a changelog version in a given locale,
 *  or null when there is no translation (English locale, unsupported locale,
 *  version not translated, or a malformed map). Never throws — callers fall
 *  back to the English body. The `maps` arg is injectable for tests; the
 *  default is the bundled per-locale data. */
export function getTranslatedBody(
  version: string,
  locale: string,
  maps: ChangelogTranslations = BUNDLED_TRANSLATIONS,
): string | null {
  try {
    const key = translationKeyForLocale(locale);
    if (!key) return null;
    const body = maps[key]?.[version];
    return typeof body === 'string' && body.length > 0 ? body : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run tests to confirm pass.** Run: `npx vitest run src/lib/changelog.test.ts` → PASS. Then `npm run build` → no TS errors.

- [ ] **Step 6: Commit.**

```bash
git add src/i18n/changelog/ru.json src/i18n/changelog/ar.json src/i18n/changelog/zh-Hans.json src/lib/changelog.ts src/lib/changelog.test.ts
git commit -m "feat(changelog): add getTranslatedBody lookup + bundled locale maps (#137)"
```

---

### Task 2: Render translated changelog body + disclaimer in `WhatsNewCard`

**Goal:** When the locale is non-English and a translation exists for the displayed entry, render the translated body and the literal #137 disclaimer linking to the version's GitHub release page; otherwise keep today's behavior (English body + existing "English-only" notice, or English with no notice).

**Files:**
- Modify: `src/components/WhatsNewCard.tsx` (translation lookup + disclaimer branch)
- Modify: `src/i18n/locales/en.json`, `ru.json`, `ar.json`, `zh-Hans.json` (two new `whatsNew.*` keys)
- Test: `src/components/WhatsNewCard.translated.test.tsx` (new file — keeps the existing suite pristine)

**Acceptance Criteria:**
- [ ] Locale `ru` + translation present → translated body text renders AND the disclaimer renders; clicking the disclaimer link opens `https://github.com/MohamedSerhan/sts2-mod-manager/releases/tag/v<entry.version>`.
- [ ] Locale `ru` + no translation → English body + existing `localeNotice`/`localeNoticeReport` notice (unchanged).
- [ ] Locale `en` → English body, no notice.
- [ ] The translated disclaimer is NOT shown in the no-translation path; the "Report a translation mistake" link only appears in the no-translation path.
- [ ] `parity.test.ts` passes with the two new translated keys in every locale.

**Verify:** `npx vitest run src/components/WhatsNewCard.translated.test.tsx src/components/WhatsNewCard.component.test.tsx src/i18n/locales/parity.test.ts` → all pass.

**Steps:**

- [ ] **Step 1: Add the two i18n keys to all four locales.** In each file's `whatsNew` object, add after `localeNoticeReport`:

`src/i18n/locales/en.json`:
```json
    "translatedNotice": "The developer doesn't speak this language —",
    "translatedNoticeViewOriginal": "view the original English changelog here"
```
`src/i18n/locales/ru.json`:
```json
    "translatedNotice": "Разработчик не владеет этим языком —",
    "translatedNoticeViewOriginal": "посмотреть оригинальный список изменений на английском"
```
`src/i18n/locales/ar.json`:
```json
    "translatedNotice": "المطوّر لا يتحدّث هذه اللغة —",
    "translatedNoticeViewOriginal": "اعرض سجل التغييرات الأصلي بالإنجليزية"
```
`src/i18n/locales/zh-Hans.json`:
```json
    "translatedNotice": "开发者不会说这种语言 —",
    "translatedNoticeViewOriginal": "查看英文原始更新日志"
```
(Remember to add a comma after the previous `localeNoticeReport` value in each file.)

- [ ] **Step 2: Write the failing component tests.** Create `src/components/WhatsNewCard.translated.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { setMockAppVersion } from '../__test__/setup';
import i18n from '../i18n';

// Mock the changelog lib so the displayed entry and its translation are fully
// deterministic (decoupled from the real bundled CHANGELOG.md + seed data).
const FIXED_ENTRY = { version: '9.9.9', date: '2026-01-01', body: '### English\n- Original line' };
vi.mock('../lib/changelog', async (orig) => {
  const actual = await orig<typeof import('../lib/changelog')>();
  return {
    ...actual,
    getEntryForVersion: vi.fn(() => FIXED_ENTRY),
    getLatestReleasedEntry: vi.fn(() => FIXED_ENTRY),
    getTranslatedBody: vi.fn(),
  };
});

import { WhatsNewCard } from './WhatsNewCard';
import { getTranslatedBody } from '../lib/changelog';

afterEach(async () => {
  vi.mocked(getTranslatedBody).mockReset();
  await i18n.changeLanguage('en');
});

describe('<WhatsNewCard> translated body', () => {
  it('renders the translated body + disclaimer and links to the release page', async () => {
    setMockAppVersion('9.9.9');
    vi.mocked(getTranslatedBody).mockReturnValue('### Переведено\n- Переведённая строка');
    await i18n.changeLanguage('ru');
    const opener = await import('@tauri-apps/plugin-opener');
    vi.mocked(opener.openUrl).mockClear();
    const user = userEvent.setup();
    render(<WhatsNewCard />);

    // Translated body text appears; the English original does not.
    const translated = await screen.findByText('Переведённая строка');
    expect(translated).toBeInTheDocument();
    expect(screen.queryByText('Original line')).toBeNull();

    // Disclaimer + view-original link → release page for the entry version.
    const link = screen.getByRole('button', { name: /оригинальный список изменений/i });
    await user.click(link);
    await waitFor(() => {
      expect(opener.openUrl).toHaveBeenCalledWith(
        'https://github.com/MohamedSerhan/sts2-mod-manager/releases/tag/v9.9.9',
      );
    });
  });

  it('falls back to the English body + English-only notice when no translation exists', async () => {
    setMockAppVersion('9.9.9');
    vi.mocked(getTranslatedBody).mockReturnValue(null);
    await i18n.changeLanguage('ru');
    render(<WhatsNewCard />);

    expect(await screen.findByText('Original line')).toBeInTheDocument();
    // The no-translation path shows the existing report-a-mistake affordance.
    expect(
      screen.getByRole('button', { name: /Сообщить об ошибке перевода|Report a translation mistake/i }),
    ).toBeInTheDocument();
    // The translated-path "view original" link is NOT shown here.
    expect(screen.queryByRole('button', { name: /оригинальный список изменений/i })).toBeNull();
  });

  it('shows no locale notice in English', async () => {
    setMockAppVersion('9.9.9');
    vi.mocked(getTranslatedBody).mockReturnValue(null);
    render(<WhatsNewCard />);
    expect(await screen.findByText('Original line')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Report a translation mistake/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /view the original English/i })).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to confirm they fail.** Run: `npx vitest run src/components/WhatsNewCard.translated.test.tsx` → FAIL (no translated body/disclaimer rendered yet; `getTranslatedBody` not yet consulted by the component).

- [ ] **Step 4: Implement the component changes.** In `src/components/WhatsNewCard.tsx`:

(a) Add `getTranslatedBody` to the existing import from `../lib/changelog`:
```tsx
import { getEntryForVersion, getLatestReleasedEntry, getTranslatedBody, type ChangelogEntry } from '../lib/changelog';
```

(b) Delete the early `showLocaleNotice` line (currently line 29):
```tsx
  const showLocaleNotice = i18n.language && !i18n.language.startsWith('en');
```

(c) Replace the body-derivation block (currently `const blocks = parseSimpleMarkdown(entry.body);` near line 79) with translation-aware derivation:
```tsx
  // Non-English locales get a bundled machine translation of this version's
  // notes when one exists; otherwise we show the English body with the
  // existing "English-only" notice. English always uses the source body.
  const locale = i18n.language || 'en';
  const translatedBody = getTranslatedBody(entry.version, locale); // null for en / no translation
  const showTranslated = translatedBody != null;
  const showLocaleNotice = !locale.startsWith('en') && !showTranslated;
  const blocks = parseSimpleMarkdown(translatedBody ?? entry.body);
```

(d) Replace the existing `{showLocaleNotice && (…)}` notice block (currently lines 109–127) with BOTH branches — the new translated disclaimer first, then the unchanged English-only notice:
```tsx
        {showTranslated && (
          <div className="gf-whatsnew-locale-note">
            <Info size={12} />
            <span>
              {t('whatsNew.translatedNotice')}{' '}
              <button
                type="button"
                className="gf-whatsnew-locale-link"
                onClick={() =>
                  openExternalUrl(
                    `https://github.com/MohamedSerhan/sts2-mod-manager/releases/tag/v${entry.version}`,
                  ).catch(() => {})
                }
              >
                {t('whatsNew.translatedNoticeViewOriginal')}
              </button>
            </span>
          </div>
        )}
        {showLocaleNotice && (
          <div className="gf-whatsnew-locale-note">
            <Info size={12} />
            <span>
              {t('whatsNew.localeNotice')}{' '}
              <button
                type="button"
                className="gf-whatsnew-locale-link"
                onClick={() =>
                  openExternalUrl(
                    'https://github.com/MohamedSerhan/sts2-mod-manager/issues/new?labels=translation',
                  ).catch(() => {})
                }
              >
                {t('whatsNew.localeNoticeReport')}
              </button>
            </span>
          </div>
        )}
```

- [ ] **Step 5: Run tests to confirm pass.** Run: `npx vitest run src/components/WhatsNewCard.translated.test.tsx src/components/WhatsNewCard.component.test.tsx src/i18n/locales/parity.test.ts` → all PASS. (The existing component suite must stay green — the no-translation `ru`/`zh-Hans` path is unchanged.)

- [ ] **Step 6: Commit.**

```bash
git add src/components/WhatsNewCard.tsx src/components/WhatsNewCard.translated.test.tsx src/i18n/locales/en.json src/i18n/locales/ru.json src/i18n/locales/ar.json src/i18n/locales/zh-Hans.json
git commit -m "feat(whatsnew): render translated changelog body + view-original disclaimer (#137)"
```

---

### Task 3: Release-time translation generator + tests + CI wiring

**Goal:** Add `scripts/translate-changelog.mjs` that translates the latest released CHANGELOG entry into ru/ar/zh-Hans via the Anthropic API, writing/merging the bundled JSON maps. Idempotent, non-blocking, dependency-injectable for tests.

**Files:**
- Modify: `package.json` (add `@anthropic-ai/sdk` devDependency + `translate:changelog` script)
- Create: `scripts/translate-changelog.mjs`
- Create: `scripts/translate-changelog.test.mjs` (`node:test`, injected translator — no real API)
- Modify: `.github/workflows/ci.yml` (add the new `node --test` line)

**Acceptance Criteria:**
- [ ] `parseLatestReleasedEntry(text)` returns `{ version, body }` for the newest non-Unreleased `## [x]` section.
- [ ] `run({ translateFn, rootDir, version?, force? })` writes `src/i18n/changelog/<locale>.json` merging the new version without dropping existing versions, and is idempotent (skips a version already present unless `force`).
- [ ] With no `ANTHROPIC_API_KEY` and no injected `translateFn`, `run` prints a warning and resolves without writing (exit 0).
- [ ] Tests pass via `node --test scripts/translate-changelog.test.mjs` (no network, SDK never imported).

**Verify:** `node --test scripts/translate-changelog.test.mjs` → all pass; `node scripts/translate-changelog.mjs --help` prints usage and exits 0.

**Steps:**

- [ ] **Step 0: Invoke the `claude-api` skill** before writing the SDK call — it ensures correct `@anthropic-ai/sdk` usage + prompt caching for the static system prompt.

- [ ] **Step 1: Add the dependency + script.** Run:

```bash
npm install --save-dev @anthropic-ai/sdk
```

Then add to `package.json` `"scripts"`:
```json
    "translate:changelog": "node scripts/translate-changelog.mjs",
```

- [ ] **Step 2: Write the generator.** Create `scripts/translate-changelog.mjs`:

```js
/**
 * Release-time changelog translator.
 *
 * Translates the latest RELEASED CHANGELOG.md entry into each non-English
 * locale and merges it into src/i18n/changelog/<locale>.json (version-keyed
 * markdown bodies). Bundled at build time and read by getTranslatedBody().
 *
 * Design goals:
 *   - Idempotent: skips a version already translated (unless --force).
 *   - Non-blocking: missing ANTHROPIC_API_KEY or an API error warns and exits 0
 *     so a release is never blocked; the app falls back to English.
 *   - Testable: run() accepts an injected translateFn so node:test never needs
 *     the SDK or a network.
 *
 * Usage:
 *   node scripts/translate-changelog.mjs            # latest released entry
 *   node scripts/translate-changelog.mjs --version 1.7.1
 *   node scripts/translate-changelog.mjs --force    # re-translate even if present
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

export const LOCALES = [
  { key: 'ru', name: 'Russian' },
  { key: 'ar', name: 'Arabic' },
  { key: 'zh-Hans', name: 'Simplified Chinese' },
];

const HEADING_RE = /^##\s+\[([^\]]+)\](?:\s*-\s*([0-9]{4}-[0-9]{2}-[0-9]{2}))?/;

/** Parse the newest non-Unreleased entry from CHANGELOG.md text. */
export function parseLatestReleasedEntry(raw) {
  const lines = raw.split(/\r?\n/);
  let current = null;
  let buf = [];
  const entries = [];
  const flush = () => {
    if (current) {
      entries.push({ version: current.version, body: buf.join('\n').trim() });
      current = null;
      buf = [];
    }
  };
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      current = { version: m[1] };
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return (
    entries.find(
      (e) => e.body.length > 0 && e.version.toLowerCase() !== 'unreleased',
    ) ?? null
  );
}

const SYSTEM_PROMPT = [
  'You are a precise software-changelog translator.',
  'Translate the given Markdown changelog body into the target language.',
  'Rules:',
  '- Preserve Markdown structure EXACTLY: `### ` subheadings, `-` bullets, blank lines.',
  '- Do NOT translate code spans (`like_this`), URLs, version numbers, or proper',
  '  nouns / product names (Nexus, GitHub, Steam, Proton, Slay the Spire 2, mod',
  '  names, UI labels shown in quotes that are English in the app).',
  '- Translate prose only. Keep the tone player-facing and concise.',
  '- Output ONLY the translated Markdown body — no preamble, no code fence.',
].join('\n');

/** Default translator: one Anthropic API call per locale (prompt-cached system). */
async function anthropicTranslate(body, languageName) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const model = process.env.CHANGELOG_TRANSLATE_MODEL || 'claude-sonnet-4-6';
  const resp = await client.messages.create({
    model,
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: `Target language: ${languageName}\n\n<changelog>\n${body}\n</changelog>` },
    ],
  });
  return resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function localePath(rootDir, key) {
  return join(rootDir, 'src', 'i18n', 'changelog', `${key}.json`);
}

function readMap(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  } catch {
    return {};
  }
}

/**
 * Translate one version into every locale and merge into the JSON maps.
 * Returns { version, written: [keys], skipped: [keys] }. Non-blocking.
 */
export async function run({
  translateFn = anthropicTranslate,
  rootDir = REPO_ROOT,
  version,
  force = false,
  log = console,
} = {}) {
  const usingRealApi = translateFn === anthropicTranslate;
  if (usingRealApi && !process.env.ANTHROPIC_API_KEY) {
    log.warn('translate-changelog: ANTHROPIC_API_KEY not set — skipping (app falls back to English).');
    return { version: null, written: [], skipped: [] };
  }

  const changelog = readFileSync(join(rootDir, 'CHANGELOG.md'), 'utf8');
  const latest = parseLatestReleasedEntry(changelog);
  const entry = version
    ? { version, body: sectionBodyFor(changelog, version) }
    : latest;
  if (!entry || !entry.body) {
    log.warn(`translate-changelog: no changelog entry found${version ? ` for ${version}` : ''} — nothing to do.`);
    return { version: null, written: [], skipped: [] };
  }

  const written = [];
  const skipped = [];
  for (const { key, name } of LOCALES) {
    const path = localePath(rootDir, key);
    const map = readMap(path);
    if (map[entry.version] && !force) {
      skipped.push(key);
      continue;
    }
    try {
      const translated = await translateFn(entry.body, name);
      if (!translated || !translated.trim()) throw new Error('empty translation');
      map[entry.version] = translated.trim();
      const ordered = Object.fromEntries(
        Object.keys(map).sort().reverse().map((k) => [k, map[k]]),
      );
      writeFileSync(path, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
      written.push(key);
    } catch (err) {
      // Non-blocking: warn for this locale, keep going.
      log.warn(`translate-changelog: ${key} failed (${err.message}) — leaving English fallback.`);
    }
  }
  return { version: entry.version, written, skipped };
}

/** Body of a specific `## [version]` section (for --version). */
export function sectionBodyFor(raw, version) {
  const lines = raw.split(/\r?\n/);
  let inBlock = false;
  const buf = [];
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      if (m[1] === version) { inBlock = true; continue; }
      if (inBlock) break;
    }
    if (inBlock) buf.push(line);
  }
  return buf.join('\n').trim();
}

function parseArgs(argv) {
  const args = { force: false, version: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--version') { args.version = argv[i + 1]; i += 1; }
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

// CLI entry — only when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('translate-changelog.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/translate-changelog.mjs [--version X.Y.Z] [--force]');
    process.exit(0);
  }
  run({ version: args.version, force: args.force })
    .then((r) => {
      if (r.version) console.log(`translate-changelog: ${r.version} — wrote [${r.written.join(', ')}], skipped [${r.skipped.join(', ')}]`);
      process.exit(0); // always non-blocking
    })
    .catch((err) => {
      console.warn(`translate-changelog: unexpected error (${err.message}) — continuing.`);
      process.exit(0);
    });
}
```

- [ ] **Step 3: Write the tests.** Create `scripts/translate-changelog.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseLatestReleasedEntry, sectionBodyFor, run, LOCALES } from './translate-changelog.mjs';

const SAMPLE = `# Changelog

## [Unreleased]

### Added
- WIP, not released.

## [1.7.1] - 2026-06-03

### Added
- A player-facing thing.

## [1.7.0] - 2026-06-02

### Fixed
- Older fix.
`;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tc-test-'));
  mkdirSync(join(dir, 'src', 'i18n', 'changelog'), { recursive: true });
  writeFileSync(join(dir, 'CHANGELOG.md'), SAMPLE, 'utf8');
  for (const { key } of LOCALES) {
    writeFileSync(join(dir, 'src', 'i18n', 'changelog', `${key}.json`), '{}\n', 'utf8');
  }
  return dir;
}

const silent = { warn() {}, log() {}, error() {} };

test('parseLatestReleasedEntry picks the newest non-Unreleased entry', () => {
  const e = parseLatestReleasedEntry(SAMPLE);
  assert.equal(e.version, '1.7.1');
  assert.match(e.body, /A player-facing thing/);
  assert.doesNotMatch(e.body, /WIP, not released/);
});

test('sectionBodyFor returns a specific version body', () => {
  assert.match(sectionBodyFor(SAMPLE, '1.7.0'), /Older fix/);
});

test('run writes a translated body for every locale and merges, not overwrites', async () => {
  const dir = makeRepo();
  // Pre-seed an older version to prove it survives the merge.
  writeFileSync(join(dir, 'src/i18n/changelog/ru.json'), JSON.stringify({ '1.7.0': 'старое' }) + '\n');
  const translateFn = async (body, name) => `[${name}] ${body}`;
  const res = await run({ translateFn, rootDir: dir, log: silent });
  assert.equal(res.version, '1.7.1');
  assert.deepEqual(res.written.sort(), ['ar', 'ru', 'zh-Hans']);
  const ru = JSON.parse(readFileSync(join(dir, 'src/i18n/changelog/ru.json'), 'utf8'));
  assert.match(ru['1.7.1'], /\[Russian\] /);
  assert.equal(ru['1.7.0'], 'старое'); // merge preserved the old version
});

test('run is idempotent — skips a version already present unless force', async () => {
  const dir = makeRepo();
  const translateFn = async (body, name) => `[${name}] ${body}`;
  await run({ translateFn, rootDir: dir, log: silent });
  const second = await run({ translateFn, rootDir: dir, log: silent });
  assert.deepEqual(second.skipped.sort(), ['ar', 'ru', 'zh-Hans']);
  assert.deepEqual(second.written, []);
  const forced = await run({ translateFn, rootDir: dir, force: true, log: silent });
  assert.deepEqual(forced.written.sort(), ['ar', 'ru', 'zh-Hans']);
});

test('run is non-blocking when ANTHROPIC_API_KEY is absent (default translator)', async () => {
  const dir = makeRepo();
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const res = await run({ rootDir: dir, log: silent }); // default real translator
    assert.deepEqual(res, { version: null, written: [], skipped: [] });
    // No file was modified.
    assert.equal(readFileSync(join(dir, 'src/i18n/changelog/ru.json'), 'utf8').trim(), '{}');
  } finally {
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('run continues past a single locale failure', async () => {
  const dir = makeRepo();
  const translateFn = async (body, name) => {
    if (name === 'Arabic') throw new Error('boom');
    return `[${name}] ${body}`;
  };
  const res = await run({ translateFn, rootDir: dir, log: silent });
  assert.deepEqual(res.written.sort(), ['ru', 'zh-Hans']);
  assert.equal(existsSync(join(dir, 'src/i18n/changelog/ar.json')), true);
  const ar = JSON.parse(readFileSync(join(dir, 'src/i18n/changelog/ar.json'), 'utf8'));
  assert.equal(ar['1.7.1'], undefined); // failed locale left without the new version
});
```

- [ ] **Step 4: Run tests to confirm pass.** Run: `node --test scripts/translate-changelog.test.mjs` → all pass. Also `node scripts/translate-changelog.mjs --help` → prints usage, exit 0.

- [ ] **Step 5: Wire the script test into CI.** In `.github/workflows/ci.yml`, after line 210 (`node --test scripts/changelog-fragments.test.mjs`), add:
```yaml
          node --test scripts/translate-changelog.test.mjs
```

- [ ] **Step 6: Commit.**

```bash
git add package.json package-lock.json scripts/translate-changelog.mjs scripts/translate-changelog.test.mjs .github/workflows/ci.yml
git commit -m "feat(scripts): release-time changelog translation generator (#137)"
```

---

### Task 4: Seed v1.7.1 translations, wire the generator into release.sh, and verify RTL/light

**Goal:** Backfill the current released version (1.7.1) translations so the feature is live now, hook the generator into the release flow for future versions, and confirm the translated card renders correctly in light theme and RTL (Arabic).

**Files:**
- Modify: `src/i18n/changelog/ru.json`, `ar.json`, `zh-Hans.json` (add the real `"1.7.1"` translated body)
- Modify: `scripts/release.sh` (invoke generator + stage output before the release commit)

**Acceptance Criteria:**
- [ ] Each of the three `src/i18n/changelog/*.json` contains a `"1.7.1"` key whose value is a non-empty translated markdown body preserving the `### Added/Fixed/Security` structure and leaving product names/quoted UI labels intact.
- [ ] `release.sh` runs `node scripts/translate-changelog.mjs` after the `[Unreleased] → [vX.Y.Z]` promotion and `git add src/i18n/changelog/*.json`, non-blocking on failure.
- [ ] Full suite green: `npx vitest run` and `npm run build`.
- [ ] Manual: with locale = Arabic and a light theme, the v1.7.1 card shows the Arabic body laid out right-to-left with the disclaimer + working "view original English" link; repeat sanity check in light theme for Russian/Chinese.

**Verify:** `npx vitest run && npm run build` → green; plus manual screenshots (see Step 4).

**Steps:**

- [ ] **Step 1: Produce the v1.7.1 translations.** Read the `## [1.7.1]` section body from `CHANGELOG.md` (lines 42–82: the `### Added`, `### Fixed`, `### Security` bullets). Translate that body into Russian, Arabic, and Simplified Chinese following the generator's rules (preserve `###` heads + `-` bullets; do NOT translate product names like Nexus/GitHub/Steam/"Slay the Spire 2", version numbers, or quoted English UI labels such as "Enable all"/"Disable all"/"Mod Manager Download"). Write each into its file under the `"1.7.1"` key. Shape (example — match the heading structure for all three sections):

```json
{
  "1.7.1": "### Добавлено\n- Добавлены русский и арабский языки в «Настройки → Язык», а при выборе арабского интерфейс располагается справа налево.\n- …\n\n### Исправлено\n- …\n\n### Безопасность\n- …"
}
```

The implementing agent (Claude) authors these directly — this is the same AI translation the release-time script will produce for future versions. Quality bar: natural, player-facing prose; structure identical to the English source.

- [ ] **Step 2: Verify the seeded data loads.** Run: `npx vitest run src/lib/changelog.test.ts src/components/WhatsNewCard.translated.test.tsx src/i18n/locales/parity.test.ts` → green. (parity covers only `src/i18n/locales/*`; the changelog JSONs are not parity-checked but must be valid JSON — `npm run build` confirms.)

- [ ] **Step 3: Wire the generator into `release.sh`.** In `scripts/release.sh`, immediately AFTER the node block that promotes `[Unreleased] → [vX.Y.Z]` (ends at the line `\"` closing that inline node script, before the "Delete consumed fragment files" comment) and BEFORE the `git add package.json …` line, insert:

```sh
# --- Translate the new changelog entry for non-English locales ---
#
# Non-blocking: a missing ANTHROPIC_API_KEY or API hiccup warns and continues,
# and the app falls back to the English body. The generated JSON joins THIS
# release commit so the translation ships in the exact build for this tag.
node scripts/translate-changelog.mjs || echo "(changelog translation skipped — continuing)"
git add src/i18n/changelog/ru.json src/i18n/changelog/ar.json src/i18n/changelog/zh-Hans.json
```

Then confirm the existing `git add package.json package-lock.json … CHANGELOG.md` line still runs (the translation files are additionally staged above).

- [ ] **Step 4: Manual RTL + light-theme verification (issue Notes).** Use the `run` skill (or `npm run tauri dev`) to launch the app. In Settings → Language choose **العربية (Arabic)** and Settings → General choose **Light**. Confirm on Home: the "What's new in v1.7.1" card shows the **Arabic** body, laid out **right-to-left**, with the disclaimer line and a "view the original English changelog here" link that opens `…/releases/tag/v1.7.1`. Repeat the light-theme check for Russian and Simplified Chinese. Capture screenshots for the PR. (If the running dev build's version isn't 1.7.1, the card uses the latest released entry — temporarily set the app version or rely on the fallback-to-latest path.)

- [ ] **Step 5: Commit.**

```bash
git add src/i18n/changelog/ru.json src/i18n/changelog/ar.json src/i18n/changelog/zh-Hans.json scripts/release.sh
git commit -m "feat(changelog): seed v1.7.1 translations + wire generator into release (#137)"
```

---

## Self-Review

**Spec coverage:**
- Storage format (per-locale version-keyed JSON) → Task 1 (files) + Task 3/4 (population). ✓
- Lookup `getTranslatedBody` → Task 1. ✓
- Rendering translated body + literal #137 disclaimer + release-page link → Task 2. ✓
- No-translation fallback keeps English + existing notice → Task 2 (tests assert it). ✓
- Generator script (model, idempotent, non-blocking, prompt cache) → Task 3. ✓
- Release wiring (same commit) → Task 4 Step 3. ✓
- New i18n keys in all locales + parity → Task 2 Step 1 + Verify. ✓
- Tests (lib, component, parity, generator) → Tasks 1–3. ✓
- Seed current version → Task 4. ✓
- Manual RTL + light verification → Task 4 Step 4. ✓
- Non-goals (runtime translation, back-translation, report link in translated path) respected. ✓

**Placeholder scan:** No "TBD"/"add error handling" — the only generated content (the v1.7.1 translations in Task 4) has an explicit procedure, source location, rules, and shape example; it is a content-authoring step, not a code placeholder.

**Type/name consistency:** `getTranslatedBody(version, locale, maps?)` signature identical in Task 1 (def), Task 2 (call, 2-arg), Task 3/4 (data it reads). `run({translateFn, rootDir, version, force, log})`, `parseLatestReleasedEntry`, `sectionBodyFor`, `LOCALES` consistent between script (Task 3) and its tests. i18n keys `whatsNew.translatedNotice` / `whatsNew.translatedNoticeViewOriginal` identical in locale files (Task 2 Step 1) and component (Task 2 Step 4). CSS classes `gf-whatsnew-locale-note` / `gf-whatsnew-locale-link` reused (no CSS task needed — they already style the existing notice, so RTL/light are inherited).

## Dependencies

- Task 2 blockedBy Task 1 (needs `getTranslatedBody`).
- Task 3 blockedBy Task 1 (shares the JSON map shape the lib reads).
- Task 4 blockedBy Tasks 1, 2, 3 (seeds data the lib+UI consume and wires the generator from Task 3).
