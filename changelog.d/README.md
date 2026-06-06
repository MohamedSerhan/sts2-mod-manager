# changelog.d — Changelog Fragments

Each in-progress change lives here as a small Markdown file. At release, the
assembler merges them into `CHANGELOG.md` and deletes the fragment files.

## File naming

```
<category>-<slug>.md
```

- **`category`** must be one of: `added`, `changed`, `fixed`, `security`
- **`slug`** is a short kebab-case label, often prefixed with the issue number,
  e.g. `57-mod-source-sync`

Examples:

```
added-42-collection-export.md
changed-88-filter-sort-order.md
fixed-57-mod-source-sync.md
security-99-token-rotation.md
```

## File body

The body must be **one player-facing sentence**. A leading `- ` is optional —
the assembler adds one if it's absent, so write it either way. Write for
players — describe what they see or do, not how the code works.

```
Fixed an issue where mods with duplicate display names could disappear from
the library after a sync.
```

## Player-language rules (same as CHANGELOG.md)

- **No file paths** — `src/`, `src-tauri/`, `scripts/`, etc.
- **No developer jargon** — `refactor`, `integration test`, `IPC`,
  `Tauri command`, `cargo`, `serde`, `reqwest`, `.rs`, `.tsx`, etc.
- **No internal type or function names** — `parse_manifest`, `RawManifest`,
  `ModInfo`, `auditByKey`, etc.
- If a change has nothing a player would notice, put it in the commit message
  instead.

## Release workflow

`scripts/release.sh` calls `node scripts/changelog-fragments.mjs assemble`
to collect the bullets, assembles them into the new version section in
`CHANGELOG.md`, resets `[Unreleased]` to a thin placeholder, and then
`git rm`s the consumed fragment files.

`.gitkeep` and `README.md` are **never** consumed — only `added-*.md`,
`changed-*.md`, `fixed-*.md`, and `security-*.md` files are deleted.
