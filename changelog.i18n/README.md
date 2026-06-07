# Localized Changelog Fragments

Each player-facing `changelog.d/<category>-slug.md` fragment must have a
same-named translated fragment in every locale folder here:

- `ar/`
- `ru/`
- `zh-Hans/`

Fragments contain only translated bullet text. Do not include `###` category
headings; `scripts/changelog-translations.mjs` adds localized headings during
release.

Use Codex Cloud or a human reviewer to prepare these translations before a PR
is merged. CI runs `node scripts/changelog-translations.mjs check-fragments`
and fails when any translated fragment is missing, empty, stale, or misnamed.
