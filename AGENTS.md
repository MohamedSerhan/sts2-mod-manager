# Notes for AI coding agents

This file is read by Claude Code, Codex, and other AI assistants. Humans
should follow the same conventions — see the `Contributing` section in
[README.md](README.md) for the human-targeted version.

## Localization is non-optional

The app ships in English and Simplified Chinese, with more locales
planned. **Every user-visible string must go through `react-i18next`.**

When you add or modify a string, do all of this in the same change:

1. Add the key + value to `src/i18n/locales/en.json`.
2. Add the same key + a translation to `src/i18n/locales/zh-Hans.json`.
   If you can't translate confidently, copy the English value verbatim
   and call it out in your summary so a human translator can fill it
   in. **Do not invent Chinese.**
3. Reference the key in the component:
   - `t('your.key', { var })` for plain strings, toasts, `title=`,
     `aria-label=`, `placeholder=`, confirm dialogs.
   - `<Trans i18nKey="your.key" components={{ 0: <strong /> }} />` for
     rich markup. The `<n>` placeholders in the JSON must match the
     `components={…}` indices exactly — duplicate indices will render
     blank.
4. Run `npx vitest run src/i18n/locales/parity.test.ts`. It fails the
   build if `en.json` and `zh-Hans.json` aren't key-for-key in sync.

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
