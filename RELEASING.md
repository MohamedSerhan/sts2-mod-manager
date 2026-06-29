# Releasing

Maintainer-only notes for cutting a release of STS2 Mod Manager.

## What's release-worthy

A change is **release-worthy** iff it is **user-facing** — i.e. it adds a
changelog entry: a `changelog.d/<category>-<slug>.md` fragment (category =
added / changed / fixed / security), or a legacy `CHANGELOG.md` `[Unreleased]`
bullet. Internal-only changes (CI, build, tests, refactors, docs, chore) are
**not** release-worthy and don't, on their own, warrant a release.

The release-suggester bot applies exactly this rule: it comments on a PR only
when the PR adds a new changelog entry (fragment or bullet), and the "Run the
Release workflow" link it posts is how you ship — when you're ready,
`scripts/release.sh` assembles all queued fragments into one version section and
releases them at once.

## Release flow

1. Bump the version in `package.json` and `src-tauri/tauri.conf.json` (they must match).
2. Commit on `main`.
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The `Build & Release` workflow (`.github/workflows/build.yml`) takes over:
   - Builds installers for Windows / macOS / Linux via `tauri-action`.
   - On Windows: also packages the raw `.exe` + a README into `STS2.Mod.Manager_<version>_x64_portable.zip`.
   - Publishes a GitHub Release with all bundles attached (NSIS, MSI, DMG, deb, rpm, AppImage, portable zip).
   - `publish-updater` assembles `latest.json` for the in-app Tauri updater (NSIS / MSI based).
   - `format-release` rewrites the release notes with download links.

## Hard gates

- `npm run qa:matrix` must pass before release. It reports the coverage matrix
  and interaction inventory completeness, and it fails if a user-facing
  interaction has no automated owner or an intentional manual-only reason.
- `npm run qa:i18n` must pass before release. Supported locales cannot ship
  missing keys or copied-English fallback prose. This gate runs even when
  `SKIP_QA=1` is used for an emergency hotfix.

Rows marked `Automated` in `qa/coverage-matrix.md` and
`qa/interaction-inventory.md` do not need routine manual regression once the
matrix, Rust, frontend coverage, and supported WebDriver smoke gates are green.
Manual regression is reserved for rows marked `Manual` in
`qa/interaction-inventory.md`.

## Required GitHub Actions secrets

Set these once at <https://github.com/MohamedSerhan/sts2-mod-manager/settings/secrets/actions>:

| Secret | Used by | How to obtain |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `build` | Tauri minisign key (already configured). |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `build` | Password for the above (already configured). |

## Re-running a release

- A failed individual job: Actions UI → workflow run → "Re-run failed jobs".
- A full re-build for an existing tag: Actions UI -> workflow_dispatch (Run workflow).

## Smoke-testing the portable build

After the first release that ships the portable zip:
1. Download `STS2.Mod.Manager_<version>_x64_portable.zip` from the GitHub Release.
2. Extract it.
3. Run `STS2 Mod Manager.exe` and confirm the UI loads.
4. If WebView2 is missing, the README in the zip points at the Evergreen Bootstrapper.

## Smoke-testing the macOS build

macOS has no automated UI smoke: Apple ships no WebDriver for the embedded
WKWebView, so `tauri-driver` cannot drive a macOS build (Windows uses WebView2 +
msedgedriver; Linux uses WebKitGTK + WebKitWebDriver). Run this manual pass on a
Mac when a release changes OS-divergent surface — file moves, archive
extraction, path handling, the downloads watcher. Requires a Mac (Intel or
Apple Silicon; the build is a universal binary).

This is the M004 manual row in `qa/interaction-inventory.md`; keep its review
date current when the harness boundary changes.

1. Download `STS2.Mod.Manager_<version>_universal.dmg` from the GitHub Release.
2. Open the `.dmg`, drag the app to Applications. First launch: right-click →
   Open to clear Gatekeeper (the build is ad-hoc signed).
3. **Game-path detection** — the app auto-detects the STS2 install, or accepts a
   manually picked path without error.
4. **Switch a modpack** — pick one and Switch; the active set applies cleanly.
5. **Drag-drop install** — drag a mod `.zip` onto the window; it extracts and the
   mod appears in the Library.
6. **Toggle a mod off** — confirm the folder leaves `mods/` and appears in
   `mods_disabled/` with no leftover duplicate (exercises the on-disk move:
   a fast `rename`, or copy-then-delete as the cross-volume fallback).
7. **Report a bug** — trigger Report a bug from the UI and confirm it produces a
   report (clipboard text or an issue link).

---

### CI Gate (required checks)

#### What it is

`CI Gate` is a single required status check on `main`.  It is change-aware: the
checks it runs depend on what files a PR touches.

- **App PRs** (changes under `src/`, `src-tauri/`, `public/`, `index.html`, the
  build/test config — `vite.config.ts`, `vitest.config.ts`, `tsconfig*.json` — or
  the manifests `package.json` / `src-tauri/Cargo.toml`) run the full suite:
  - QA matrix + interaction inventory report — `npm run qa:matrix`
  - Frontend unit tests — `npm run qa:unit` (vitest)
  - Rust unit + integration tests — `cargo test` (`qa:rust`)
  - A 3-platform build (Windows / macOS / Linux) — confirms it bundles everywhere
  - A WebDriver UI smoke test — Windows, deterministic cassette (`qa:smoke:cassette`)
  - A changelog check — the PR must add a `changelog.d/` fragment (or a legacy `[Unreleased]` bullet)
- **Scripts / workflows / docs PRs** (changes limited to `.github/`, `scripts/`,
  `docs/`, `*.md`) run lighter checks or none, so they stay fast and do not
  require a full build.

Because `CI Gate` is required on `main`, **nothing should merge until the check
is green.** This is the deterministic floor under manual review: a broken change
cannot ship through the normal PR path.

#### The `no-changelog` opt-out

App PRs must add a changelog entry — a `changelog.d/<category>-<slug>.md` fragment
(or a legacy `[Unreleased]` bullet). Codex or the maintainer should add the
fragment in the same PR as the user-facing change.

For genuinely internal app changes — refactors, test-only work, build tooling
that users will never notice — label the PR `no-changelog` to skip just the
changelog check while leaving all other gates (tests, build) intact.

#### One-time setup

```bash
# 1. Create the no-changelog opt-out label
gh label create no-changelog \
  --color ededed \
  --description "App change with no user-facing CHANGELOG entry (skips the changelog gate)" \
  --repo MohamedSerhan/sts2-mod-manager

# 2. Require the CI Gate check on main + disallow direct pushes.
# UI path (most reliable): Settings -> Branches -> Branch protection rules -> main:
#   - "Require status checks to pass" -> add "CI Gate"
#   - "Require a pull request before merging" (so direct pushes can't bypass the gate)
# Or via API (shape varies by gh/API version; verify in the UI afterward):
gh api -X PATCH repos/MohamedSerhan/sts2-mod-manager/branches/main/protection/required_status_checks \
  -f 'strict=true' -f 'checks[][context]=CI Gate'
```

#### Safety note

Requiring a pull request before merging (disallowing direct pushes to `main`) is
what makes the gate non-bypassable in normal operation.  Without it, a direct
push lands on `main` without ever touching `CI Gate`.  An admin can still force-
push in a genuine emergency — that is the intentional escape hatch — but it
should be a last resort, not routine practice.

#### Edge cases

- **Fork PRs:** `app-build` and `smoke` need repo secrets (the Tauri signing key); a
  fork PR runs without secrets, so those jobs fail and `CI Gate` goes red. That's by
  design — this project merges only maintainer/bot-authored (same-repo) PRs; a fork
  contribution is reviewed and re-landed by you manually, not auto-merged.
- **Release-cut PRs:** a PR that drains `## [Unreleased]` into a new versioned section
  AND touches app code will trip the changelog check (head bullet count drops). Label
  such a PR `no-changelog` — cutting a release isn't a user-facing app change.
