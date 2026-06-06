# Notes for AI coding agents

This file is read by Codex and other AI assistants. Humans
should follow the same conventions — see the `Contributing` section in
[README.md](README.md) for the human-targeted version.

## Localization is non-optional

The app ships in English and Simplified Chinese, with more locales
planned. **Every user-visible string must go through `react-i18next`.**

When you add or modify a string, do all of this in the same change:

1. Add the key + value to `src/i18n/locales/en.json`.
2. Add the same key + a translation to `src/i18n/locales/zh-Hans.json`.
   **Do not copy English prose as a placeholder.** If you can't translate
   confidently, stop and flag it for a human translator. Brand names,
   file paths, placeholders, and other values that intentionally stay the
   same must be listed in `src/i18n/locales/parity.test.ts`.
   **Do not invent Chinese.**
3. Reference the key in the component:
   - `t('your.key', { var })` for plain strings, toasts, `title=`,
     `aria-label=`, `placeholder=`, confirm dialogs.
   - `<Trans i18nKey="your.key" components={{ 0: <strong /> }} />` for
     rich markup. The `<n>` placeholders in the JSON must match the
     `components={…}` indices exactly — duplicate indices will render
     blank.
4. Run `npm run qa:i18n`. It fails the build if `en.json` and
   `zh-Hans.json` aren't key-for-key in sync or if Simplified Chinese
   contains copied English prose outside the explicit exception list.

## Release translation gate

Supported languages must be translated before a release can go out. The
release script runs `npm run qa:i18n` outside `SKIP_QA`, so missing keys or
English fallback prose block release even during emergency hotfixes.

## Changelog fragments are required

Every change a player would notice needs a changelog entry, and CI enforces
it: the `changelog` gate fails any PR that touches app code without a new one.

For each user-facing change, in the same PR:

1. Add a fragment `changelog.d/<category>-<slug>.md`, where `<category>` is one
   of `added`, `changed`, `fixed`, `security` (e.g.
   `fixed-142-nexus-version.md`). Do **not** hand-edit `CHANGELOG.md` —
   `scripts/release.sh` assembles the fragments into the version section at
   release (one `### Added` / `### Changed` / `### Fixed` / `### Security`
   heading each) and deletes the consumed fragments.
2. The body is **one player-facing sentence** — describe what the player sees
   or does, not how the code works. No file paths, no developer jargon
   (`refactor`, `IPC`, `.tsx`, `cargo`, …), no internal type/function names.
   See `changelog.d/README.md` for the full rules; the same dev-speak lint runs
   at release via `node scripts/changelog-fragments.mjs lint`.

An internal-only change with nothing a player would notice gets no fragment —
put the detail in the commit message and label the PR `no-changelog` so the
gate passes.

## Scalability is a feature requirement

Design mod-management flows for large local libraries and many profiles, not
just the maintainer's current test set. Users may have hundreds of installed
mods, several versions of the same mod, and many saved profiles.

When adding or changing a feature that lists, sorts, toggles, publishes, or
syncs mods:

1. Treat the local Mod Library as the durable container of installed files.
   Profiles should reference the mods they need; publishing a profile must not
   silently re-add every mod found on disk.
2. Keep render work bounded. Prefer search, sorting, pagination, windowing, or
   other incremental rendering over dumping every mod/profile cross-product
   into the DOM.
3. Preserve scroll/focus state when toggling membership or checkboxes in long
   lists. Do not refresh the whole view unless the data truly changed outside
   the current interaction.
4. Add tests with large counts (at least 100 mods when practical) for new list
   or matrix UI so performance and layout assumptions are visible to future
   agents.
5. Name UI states precisely. Distinguish disk storage state (active in
   `mods/` vs stored in `mods_disabled/`) from profile membership state (in
   profile, not in profile, disabled in profile).

### Anti-patterns to reject

- Hardcoded English in JSX (`<button>Save</button>`).
- English literals passed as interpolation values
  (`t('foo.bar', { error: 'No GitHub source linked' })`) — the variable
  itself needs to be a `t()` call too.
- Conditional ternaries on `count === 1 ? 'X' : 'Y'` for plurals. Use
  i18next's `_one` / `_other` suffix pairs instead.
- Concatenating prose with `+` or template literals
  (`` `${count} mods updated` ``). Pass `count` as an interpolation var.
- Toasts that bypass the translation layer (`toast.error("Failed: ...")`).

### Adding a new language

See `### Translations` in README.md. The routing helpers in
`src/i18n/language.ts` already handle locale-detection fallbacks — most
new languages need only a JSON file + a `SUPPORTED_LANGUAGES` entry.

## Other conventions

- All Tauri commands are registered in `src-tauri/src/lib.rs` and bound
  to TS via `src/hooks/useTauri.ts`. Don't bypass `useTauri.ts` from
  components.
- CSS is in `src/styles.css` only — utility-class style (`gf-*`
  namespaces). No CSS-in-JS, no styled-components, no per-component CSS
  modules.
- All test files live next to their source (`Foo.tsx` ↔ `Foo.test.tsx`).
  Run `npx vitest run` for the full frontend suite and
  `cargo test --manifest-path=src-tauri/Cargo.toml` for the Rust side.
- The maintainer prefers single-PR landings for cohesive features even
  if the diff is large. Don't split mechanical changes (renames, i18n
  conversions) into a separate PR from the feature that needs them.

## When you're unsure

Ask before:
- Force-pushing, deleting branches, or otherwise rewriting shared git
  state.
- Closing or commenting on issues / PRs from other contributors.
- Changing translations in languages you don't speak — flag for a human
  reviewer instead.
