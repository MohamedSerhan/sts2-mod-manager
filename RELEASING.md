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
   - `publish-nexus` uploads the Windows portable zip, the macOS `.dmg`, and the Linux `.AppImage` to Nexus Mods (mod 856) — one matrix leg per file, each into its own Nexus file group. A leg whose group-id secret is unset is skipped, so mac/Linux stay inert until the one-time setup below is done.

A failed `publish-nexus` does not block the GitHub Release or the in-app updater (the jobs run in parallel). Re-run just that job from the Actions UI if Nexus is flaky.

The portable zip ships to Nexus specifically because the NSIS self-extracting installer triggers AV/SmartScreen heuristics that a bare `.exe` does not. NSIS / MSI continue to ship on the GitHub Release because the in-app updater depends on them.

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
| `NEXUS_API_KEY` | `publish-nexus` | Generate or copy the **Personal API Key** at <https://www.nexusmods.com/users/myaccount?tab=api>. Treat like a password. |
| `NEXUS_FILE_GROUP_ID` | `publish-nexus` (Windows) | On the mod page, Files tab → "API Info" → copy the integer. Tied to mod 856's Windows portable zip. |
| `NEXUS_FILE_GROUP_ID_MACOS` | `publish-nexus` (macOS) | The macOS `.dmg` file's group id — see "One-time setup: macOS + Linux Nexus files" below. Leave unset to skip macOS uploads. |
| `NEXUS_FILE_GROUP_ID_LINUX` | `publish-nexus` (Linux) | The Linux `.AppImage` file's group id — see "One-time setup: macOS + Linux Nexus files" below. Leave unset to skip Linux uploads. |

If `NEXUS_API_KEY` or `NEXUS_FILE_GROUP_ID` is missing, the Windows leg of `publish-nexus` fails loudly. That's intentional — a silent skip would let Nexus drift out of sync without anyone noticing. The macOS/Linux group secrets behave differently: if `NEXUS_FILE_GROUP_ID_MACOS` / `NEXUS_FILE_GROUP_ID_LINUX` are unset, those legs **skip** (with a workflow notice) instead of failing — they are opt-in until you create the files (next section).

### One-time setup: macOS + Linux Nexus files

`publish-nexus` rolls a new version into one Nexus *file group* per platform. A
file group is a single file's version chain — the upload action can only
**update** an existing group, not create one. So the macOS `.dmg` and Linux
`.AppImage` must exist on the mod page once before CI can keep them current:

1. From any release, download the `…_universal.dmg` and `…_amd64.AppImage` off the GitHub Release.
2. On the Nexus mod page (856) → **Files** → **Manage files**, upload each as a **Main file** with a clear name (e.g. "STS2 Mod Manager (macOS Universal)" and "(Linux AppImage)").
3. For each new file, open **Files tab → "API Info"** and copy its integer group id.
4. Store them as repo secrets:

       gh secret set NEXUS_FILE_GROUP_ID_MACOS --repo MohamedSerhan/sts2-mod-manager
       gh secret set NEXUS_FILE_GROUP_ID_LINUX --repo MohamedSerhan/sts2-mod-manager

From the next tagged release on, each leg uploads a new version into its own
group and archives the prior one (`archive_existing_file: true`). Until the
secrets are set, the mac/Linux legs skip with a notice and only Windows uploads —
no red CI.

## What is not automated

- The **mod page description / "About this mod"** on Nexus — the public API doesn't expose it. Update manually if the copy needs to change.
- The **Posts tab** announcements on Nexus — also not API-accessible.

## Re-running a release

- A failed individual job: Actions UI → workflow run → "Re-run failed jobs".
- A full re-build for an existing tag: Actions UI → workflow_dispatch (Run workflow). Note this re-triggers every job including `publish-nexus`, which would roll a fresh version into each configured Nexus file group (the upload API has no "if not exists" guard; the prior version is archived via `archive_existing_file`). If you only need to re-run Nexus, use "Re-run failed jobs" instead.

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

## Operator runbook - Nexus triage

This section covers the Nexus -> GitHub triage automation introduced in `2026-05-26`. The automation now files normal maintainer/Codex-ready issues; it does **not** depend on a reactive Claude agent.

### Day 0 setup

1. **Confirm GitHub CLI auth** so the local runner can create issues and push the updated state file:

       gh auth status

2. **Create the dedicated Python venv** used by the Nexus fetch shim:

       python -m venv .nexus-triage-venv
       .nexus-triage-venv\Scripts\python -m pip install curl_cffi

   The runner prepends `.nexus-triage-venv\Scripts` to `PATH`; `.nexus-triage-venv/` is gitignored.

3. **Bootstrap the state file** locally so the first triage run does not refile old Nexus comments:

       node scripts/nexus-triage.mjs --bootstrap
       git add scripts/nexus-triage-state.json
       git commit -m "chore(triage): bootstrap Nexus triage state"
       git push

4. **Run a dry-run** and inspect what would be filed:

       node scripts/nexus-triage.mjs --dry-run

5. **Enable the local scheduled runner** if you want unattended triage:

   - Task Scheduler -> Create Task
   - Name: `Nexus Triage`
   - Trigger: daily, or whatever cadence you want
   - Action: `C:\Users\xxsku\repos\sts2-mod-manager\scripts\run-nexus-triage-local.bat`
   - Start in: `C:\Users\xxsku\repos\sts2-mod-manager`

### Local runtime via Task Scheduler

`scripts/run-nexus-triage-local.bat` is the Windows runner:

1. Prepends the `.nexus-triage-venv\Scripts` venv to `PATH`
2. Sets the `NEXUSMODS_*` env vars for mod 856
3. Pulls `gh auth token` for `GITHUB_TOKEN`
4. Honors the `scripts/nexus-triage.disabled` killswitch
5. Updates the repo to `main` and pulls latest
6. Preflights `python -c "import curl_cffi"`
7. Runs `node scripts/nexus-triage.mjs`
8. Commits and pushes the updated state file
9. Logs each run to `.nexus-triage-runs/YYYY-MM-DD.log` (gitignored)

The per-run cap is 5 issues. With a daily trigger, a backlog drains at 5/day; steady-state mod traffic is well under that. Bump `PER_RUN_CAP` in `scripts/nexus-triage.mjs` if you want faster catch-up.

### What still runs in CI

- `nexus-triage.yml` is kept for `workflow_dispatch` diagnostics only.
- Its `schedule:` block stays commented out because GitHub-hosted runners are Cloudflare-blocked by Nexus.
- The Claude watchdog and reactive Claude workflows were removed.

### Killswitches

- Create `scripts/nexus-triage.disabled` with any content; the next run exits 0 with no work.
- Disable the Task Scheduler entry from the Task Scheduler UI.
- Both leave the state file frozen at the last successful run.

### Retired Claude automation

The previous reactive `@claude`, auto-fix, QA-Claude, watchdog, and conflict-watcher workflows were removed. Nexus triage issues are now ordinary GitHub issues with a checklist that a maintainer or Codex session can pick up manually.

The old labels (`auto-fix`, `qa`, `qa-passed`, `qa-needs-human`, `watchdog-ping`, `ops:token-renewal`) can remain for historical issues, but they no longer trigger automation in this repository.

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
