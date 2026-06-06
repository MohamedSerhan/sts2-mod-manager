# Auto-Translate Changelogs for Non-English Locales

Closes [#137](https://github.com/MohamedSerhan/sts2-mod-manager/issues/137). Related: [#132](https://github.com/MohamedSerhan/sts2-mod-manager/issues/132) (drafted Russian disclaimer wording).

## Goal

The in-app "What's new" card shows the current release's CHANGELOG entry in
English regardless of the active UI locale. Many users don't read English. Show
non-English users a machine (AI) translation of the changelog body, with an
honest disclaimer that the developer can't vouch for it and a link to the
original English. Apply to **all** non-English locales (ru / ar / zh-Hans and any
future locale), not just Russian.

## Product Behavior

- When the active locale is **English**, behavior is unchanged: the English
  CHANGELOG body renders, no disclaimer.
- When the active locale is **non-English and a translation exists** for the
  displayed version, the card renders the **translated** body and shows a
  disclaimer above it:
  > The developer doesn't speak this language — **view the original English changelog here**

  "view the original English changelog here" links to that version's GitHub
  **release page** (`/releases/tag/v{{version}}`), which shows exactly that
  version's English notes.
- When the active locale is **non-English but no translation exists** (an older
  build released before this feature, or a generation failure), behavior is
  unchanged from today: the English body renders with the existing
  "Release notes are English-only…" notice. Non-English users on old builds do
  not regress.
- The disclaimer uses #137's literal wording. It carries a **single** link
  (view-original-English). The existing "Report a translation mistake" link is
  **not** shown in the translated path (it remains only in the no-translation
  fallback notice).

## Architecture

Translations are produced at **release time** by an AI script and committed as
bundled JSON in the **same release commit**, so the translation ships inside the
exact build that introduced the changelog entry. At runtime the app is fully
offline — it only reads bundled data. This matches the app's existing model of
bundling `CHANGELOG.md` at build time via Vite's `?raw` import.

Three pieces:

1. **Storage** — per-locale bundled JSON, version-keyed.
2. **Lookup** — one new function in the changelog lib.
3. **Rendering** — `WhatsNewCard` selects translated vs English body and shows
   the disclaimer.

Plus a **generator script** wired into the release flow.

### 1. Storage format

One file per non-English locale:

```
src/i18n/changelog/ru.json
src/i18n/changelog/ar.json
src/i18n/changelog/zh-Hans.json
```

Each maps a CHANGELOG version string to the translated markdown body:

```json
{
  "1.7.2": "### Добавлено\n- …",
  "1.7.1": "### Добавлено\n- …"
}
```

The version key matches the raw heading token parsed by `parseChangelog`
(e.g. `"1.7.1"`, `"Unreleased"` is never translated). Body is markdown in the
same minimal subset the card already renders (`###` subheads, `-`/`*` bullets,
`` `code` ``, `**bold**`).

*Rationale for JSON-per-locale over `CHANGELOG.<locale>.md` siblings:* exact
keyed lookup, trivial parity testing, and the generator only ever appends a
single new version per release — no whole-file re-translation or re-parsing.

### 2. Lookup — `src/lib/changelog.ts`

Add:

```ts
/** Translated markdown body for a version in a given locale, or null if there
 *  is no translation (missing locale file, missing version, malformed JSON, or
 *  an English locale). Never throws. */
export function getTranslatedBody(version: string, locale: string): string | null
```

- Returns `null` when `locale` starts with `en` (use the English source).
- Statically imports the three locale JSONs (bundled, like the existing
  `CHANGELOG.md?raw` import) and looks up `map[version]`.
- Normalizes the locale to the file key (`ru`, `ar`, `zh-Hans`). Unknown locale
  → `null`.
- Any parse/shape error → `null` (English fallback). Never throws.

### 3. Rendering — `src/components/WhatsNewCard.tsx`

For the displayed `entry`:

```ts
const locale = i18n.language ?? 'en';
const translatedBody = !locale.startsWith('en')
  ? getTranslatedBody(entry.version, locale)
  : null;
const showTranslated = translatedBody != null;
const body = showTranslated ? translatedBody : entry.body;
const blocks = parseSimpleMarkdown(body);
```

Disclaimer logic (replaces the current single `showLocaleNotice` branch):

- `showTranslated` → render the new **translated disclaimer**
  (`whatsNew.translatedNotice` + `whatsNew.translatedNoticeViewOriginal`),
  linking to `https://github.com/MohamedSerhan/sts2-mod-manager/releases/tag/v{{entry.version}}`.
- `!showTranslated && locale≠en` → render the **existing** notice
  (`whatsNew.localeNotice` + `whatsNew.localeNoticeReport`), unchanged.
- English → no notice.

The translated body flows through the unchanged `parseSimpleMarkdown` /
`BlockRender` / `renderInline` path, so styling, RTL, and theming are identical
to the English body — the translated content is just different text.

### 4. Generator — `scripts/translate-changelog.mjs`

A Node ESM script (matches existing `scripts/*.mjs` style, e.g.
`changelog-fragments.mjs`) using `@anthropic-ai/sdk`:

- Parses `CHANGELOG.md` and selects the **latest released entry** (skips
  `[Unreleased]`), reusing the same heading regex as `src/lib/changelog.ts`.
- For each non-English locale (`ru`, `ar`, `zh-Hans`): if
  `src/i18n/changelog/<locale>.json` already contains that version, skip
  (idempotent). Otherwise call the Anthropic API to translate **only that one
  entry's body**.
- Translation prompt constraints: preserve markdown structure exactly; do not
  translate code spans, version numbers, proper nouns, mod/app names, or URLs;
  translate prose only; return body markdown only (no commentary).
- Writes/updates the locale JSON (stable key order, newest-first or sorted),
  ending with a trailing newline.
- **Model:** `claude-sonnet-4-6`, overridable via `CHANGELOG_TRANSLATE_MODEL`.
  Uses prompt caching on the static system/instruction prefix.
- **Non-blocking:** if `ANTHROPIC_API_KEY` is unset or any call fails, print a
  clear warning and exit `0`. A release is never blocked by translation; the app
  degrades to English fallback.
- CLI: `node scripts/translate-changelog.mjs` (default = latest released entry).
  Optional `--version X.Y.Z` to (re)generate a specific version.

### Release wiring — `scripts/release.sh`

After the `[Unreleased] → [vX.Y.Z]` promotion block and before the
`git add … CHANGELOG.md` / commit, invoke the generator and stage its output:

```sh
node scripts/translate-changelog.mjs || echo "(changelog translation skipped — continuing)"
git add src/i18n/changelog/*.json
```

The generated JSON joins the existing release commit, so the translation is
bundled into the build produced for that tag. Because generation is
non-blocking, a missing key or network outage warns but does not abort the
release.

## Error Handling

| Situation | Behavior |
|---|---|
| Locale JSON missing / malformed | `getTranslatedBody` → `null` → English fallback |
| Version not in translation map | `null` → English fallback |
| English locale | `null` (English source) |
| `ANTHROPIC_API_KEY` unset at release | Generator warns, exits 0; no new translation; app shows English + old notice |
| API call fails for one locale | Generator warns for that locale, continues others, exits 0 |
| Release page doesn't exist for a version | Cannot occur in the translated path — the disclaimer only renders when a translation exists, which only happens for a released+translated version |

## Testing

- **`src/lib/changelog.test.ts`** — `getTranslatedBody`: returns body for a
  present version; `null` for missing version; `null` for `en`; `null` (no
  throw) on malformed JSON; locale normalization (`ru-RU` → `ru`).
- **`src/components/WhatsNewCard.component.test.tsx`** — with a seeded
  translation and locale `ru`: translated body text renders, disclaimer renders,
  link points at `/releases/tag/v<version>`; with locale `ru` and **no**
  translation: English body + existing "English-only" notice; with locale `en`:
  English body, no notice. Loud element lookups, always assert visible behavior
  (no `if (el) {…}` silent-skip).
- **`src/i18n/locales/parity.test.ts`** — new keys `whatsNew.translatedNotice`
  and `whatsNew.translatedNoticeViewOriginal` exist in every locale.
- **`scripts/translate-changelog.test.mjs`** — latest-entry selection;
  idempotent skip when version already present; writes expected JSON shape; with
  the Anthropic client mocked. Missing-API-key path warns and exits 0 without
  writing.
- **Manual verification (issue Notes)** — light theme and RTL (Arabic): seed the
  current version's real ru/ar/zh-Hans translations, run the app, and confirm the
  translated body + disclaimer render correctly in light theme and right-to-left.

## i18n Keys

Add to `en.json`, `ru.json`, `ar.json`, `zh-Hans.json` (English shown; #132 has
the drafted Russian):

```jsonc
"whatsNew": {
  // …existing keys…
  "translatedNotice": "The developer doesn't speak this language —",
  "translatedNoticeViewOriginal": "view the original English changelog here"
}
```

(Exact split between the static sentence and the link label finalized during
implementation so the rendered phrase reads naturally per locale, including RTL.)

## Scope / Rollout

- The generator translates **the latest entry per release** going forward;
  translations accumulate across releases. Old versions (released before this
  feature) are **not** back-translated — they keep English, which is the current
  behavior.
- To make the feature visible immediately in this PR, run the generator once to
  **seed the current version (1.7.1)** ru/ar/zh-Hans translations and commit
  them.

## Quality Gates

- `npm run build` keeps TypeScript checking.
- `npm run qa:unit` / coverage gate passes (new lib + component tests).
- `npm run qa:i18n` (parity) passes with the two new keys.
- The generator is idempotent and non-blocking; `scripts/release.sh` continues
  to succeed with or without `ANTHROPIC_API_KEY`.

## Non-Goals

- Runtime / on-device translation (no network dependency at runtime).
- Back-translating historical changelog versions.
- Translating the full `CHANGELOG.md` file or the GitHub release bodies (only the
  in-app card's displayed entry).
- A "Report a translation mistake" affordance in the translated path (dropped per
  #137; it remains in the no-translation fallback notice).
