# Build switcher (sub-project E) — Design

**Status:** Approved (brainstorm 2026-05-28)
**Depends on:** sub-project D (per-PR dev builds) — shipped to `main` (PR #59, merge `085384b`)
**Roadmap:** A (Nexus triage ✅) → D (per-PR dev builds ✅) → **E (build switcher)** → C (auto-fix bot) → B (Nexus reply drafts)

## Goal

Let the maintainer hop between PR dev builds while testing, without hunting through PR comments — an in-app switcher that, **from inside a dev build**, lists the open PRs' `dev-pr<N>` prereleases and one-click installs a chosen one **in place** (replacing the running "(Dev)" app and relaunching into it). The stable release app is never involved and never shows this feature.

## How builds work today (context)

- **App self-update:** `tauri-plugin-updater` (`src-tauri/tauri.conf.json` → `plugins.updater`) points at `https://github.com/MohamedSerhan/sts2-mod-manager/releases/latest/download/latest.json`. `src/App.tsx` runs `check()` on launch and renders a banner (Dismiss / Download / Install & Restart, via `downloadAndInstall` + `relaunch`). It only ever knows the **latest stable release** — there is no notion of choosing a specific build. A "Check for updates" button also exists in Settings / `AboutCard`.
- **Dev builds (sub-project D):** each labeled PR produces a `dev-pr<N>` GitHub **prerelease** containing a Windows NSIS `_x64-setup.exe` + a portable zip, a macOS `.dmg`, and Linux `.deb`/`.rpm`/`.AppImage`. Dev builds install under a **distinct identity** `com.sts2mm.app.dev` ("STS2 Mod Manager (Dev)") and use an **isolated data dir** `sts2-mod-manager-dev` (config, cache, logs), keyed off the version containing `-dev` (`crate::state::app_dir_name()` / `dir_name_for()`). Dev builds are deliberately absent from `latest.json`. A sticky PR comment lists per-platform download links.
- **CSP constraint:** `tauri.conf.json` → `app.security.csp` is `connect-src 'self' ipc: http://ipc.localhost`. The React frontend **cannot** call `github.com`. All GitHub listing + downloads must go through Rust (as `updater.rs` / `download.rs` already do).
- **Gap E fills:** today, testing a PR's build means finding its sticky comment, downloading, installing manually. There is no in-app way to see available dev builds or switch between them.

## The model (decisions)

These were settled during brainstorming:

1. **Core model — swap the dev slot in place.** Keep one "(Dev)" app slot and flip *which PR build* occupies it. The running (Dev) app replaces itself with the chosen build and relaunches. (Not side-by-side; not a full release↔dev flip.)
2. **Release stays untouched.** The stable release (`com.sts2mm.app`) is a separate, always-installed app. E never touches it. Because every dev build shares the `com.sts2mm.app.dev` identity, installing one *replaces the dev slot in place* — no signature/manifest/updater plumbing required.
3. **Data stays isolated.** The swapped-in dev build keeps using `sts2-mod-manager-dev` (D's behavior, version-keyed). A buggy dev build can't corrupt the release's settings/profiles/modpacks. (Consistent with D.)
4. **Dev-build-only, runtime-gated.** The Dev Builds UI renders **only** when the running build's version contains `-dev`. The release app shows nothing; Nexus end users never see it. The code ships *dormant* in the release binary (runtime gate, not a compile-time feature flag).
5. **Bootstrap from the PR comment.** Because the release app has no entry point, the **first** dev build is obtained the way it is today (download from the PR's sticky comment + install). Thereafter the in-(Dev)-app switcher hops between PR builds.
6. **Windows-only one-click install.** `install_dev_build` runs the Windows NSIS installer. macOS/Linux builds are still **listed** with plain download links, but not one-click-installed in-app. (Maintainer tests on Windows.)
7. **Placement:** a **"Dev Builds" section in Settings** (gated to dev builds). No main-sidebar entry.
8. **No CI changes.** E consumes the `dev-pr<N>` prereleases D already publishes.

## Architecture

A purely in-app feature: a Rust module + a frontend section. No workflow/CI changes.

### Rust — `src-tauri/src/dev_builds.rs` (new `pub mod`)

- **`list_dev_builds() -> Result<Vec<DevBuild>, String>`** — `GET /repos/MohamedSerhan/sts2-mod-manager/releases`, keep releases whose `tag_name` matches `dev-pr<N>`, return newest-PR-first. Each `DevBuild`:
  - `pr: u32` (parsed from the tag `dev-pr59` → 59)
  - `version: String`, `sha: String` (parsed from the release title `Dev build — PR #N (g<sha>)`; reconstruct `version` as `<base>-dev.pr<N>.g<sha>` or read from a Windows asset name)
  - `title: String` (the release title; optionally the PR title later)
  - `published_at: String`
  - `windows_installer_url: Option<String>` (the `*_x64-setup.exe` asset; `None` if the Windows leg failed)
  - `assets: Vec<DevBuildAsset>` (`{ name, url, platform }` for the per-platform download links)
  - Auth: unauthenticated works (public repo, 60 req/hr). Reuse the stored GitHub token (`keyring` `"sts2-mod-manager"` / `"github-token"`) if present for a higher limit. Follow `updater.rs`'s GitHub-fetch pattern (User-Agent, JSON parse, error mapping).
- **`install_dev_build(installer_url: String) -> Result<(), String>`** (Windows) — download the `_x64-setup.exe` to a cache/temp dir (reuse `download.rs` patterns; emit progress if cheap), then run the NSIS installer so it replaces the running (Dev) app in place and relaunches into the new build.
  - **Running-instance handling:** Tauri's NSIS installer is designed to close a running instance, install, and relaunch (this is what `tauri-plugin-updater` drives on Windows). The exact invocation (silent `/S`, the relaunch flag, whether we close the current app first) will be pinned down by a short **spike** at the start of implementation. If the raw-installer path proves unreliable, the **fallback** is `tauri-plugin-updater` targeting a per-build manifest — which would require a small D/CI addition (publish `.sig` + a `latest.json`-style manifest per `dev-pr<N>`). Lead with the installer path; expect no CI changes.

Register both commands in `src-tauri/src/lib.rs` (`invoke_handler` + `pub mod dev_builds;`), and add the `dev_builds` capability if a new permission is needed.

### Frontend — "Dev Builds" section (gated)

- A new component (e.g. `src/components/DevBuildsCard.tsx`) rendered inside `src/views/Settings.tsx` **only when `isDevBuild`** (a small helper: `getVersion()` from `@tauri-apps/api/app` includes `-dev`).
- Lists builds from `list_dev_builds()`, newest PR first. Each row: PR #, `g<sha>`, published date, and either **Switch to this build** (Windows, when `windows_installer_url` is present) or a disabled state + per-platform **download links**.
- The row whose `g<sha>` matches the running `getVersion()` is marked **"Current — you're running this."**
- A line noting "To return to the stable app, just launch your release STS2 Mod Manager — it's untouched."
- Switch flow states: idle → Downloading… → Installing… (then the app is replaced/relaunched). Errors surface inline (see below).

### App-update nag suppression

In `src/App.tsx`, when `isDevBuild`, skip the on-launch `check()` banner (the "release available" nag is counterproductive on a deliberate dev build). One guard around the existing check/banner; the release app is unchanged.

## Data flow

1. (Dev) app → Settings → **Dev Builds** → `list_dev_builds()` → Rust → GitHub API → list.
2. UI renders list; marks current via `getVersion()` match.
3. **Switch to PR #X** → `install_dev_build(X.windows_installer_url)` → Rust downloads `_x64-setup.exe` → runs it → it closes the running (Dev) app, installs X, relaunches into X.
4. On relaunch, the list shows X as current. The dev slot's build == the running version — **no persisted slot-state**.

Optional: briefly cache the releases list in memory to avoid re-hitting the rate limit on repeated opens.

## Error handling

Every failure is surfaced, never silent:
- **GitHub fetch fails** (offline / 403 rate-limited): error message + Retry; if 403 and no token stored, suggest adding the GitHub token the app already supports.
- **No open dev builds:** clear empty state ("No open dev builds — open a PR and label it `dev-build`").
- **Build with no Windows installer** (its Windows leg failed): "Switch" disabled for that row + a note; other-platform download links still shown.
- **Download failure:** error + Retry; current build stays.
- **Installer non-zero exit / user cancels:** surfaced; the current (Dev) build is unchanged.

## Testing strategy

- **Rust unit tests** (`dev_builds.rs`): `list_dev_builds` parsing against mocked GitHub releases JSON — tag filtering (`dev-pr*`), PR#/version/sha extraction, Windows-installer selection, the no-installer case. (Mirrors `updater.rs` testing.)
- **Frontend view tests** (vitest, `DevBuildsCard.test.tsx`): mock the Tauri commands; assert the list renders, the running build is marked current, **Switch** invokes `install_dev_build`, and the empty / error / no-Windows-asset states render. Loud lookups + always assert visible behavior; **no `if (btn) { click(btn) }` silent-skip patterns**.
- **Gating test:** the Dev Builds section does **not** render on a release version (`1.6.1`), **does** on a `-dev` version.
- **App-update suppression test:** the update banner does not auto-show on a `-dev` version.
- **Manual Windows verification (user-gate, like D's Task 6):** from a dev build, switch to another PR's dev build end-to-end on Windows; confirm it replaces in place, relaunches into the chosen build, and stays on isolated `sts2-mod-manager-dev` data.

## Non-goals / out of scope

- No CI/workflow changes (consumes D's existing prereleases). The per-build `.sig`/manifest is only the *fallback* if the installer-run path fails the spike.
- No compile-time exclusion from the release binary (runtime gate only).
- No macOS/Linux one-click install (download links only).
- No persisted "current slot" state (the running version is the source of truth).
- No release↔dev in-place flip of the *main* app, and no side-by-side build management (D's portable `.exe` already covers running builds side by side).
- No change to how the first dev build is obtained (PR sticky comment).

## Implementation risk / spike

The one unknown is the exact mechanics of running the Tauri NSIS installer to replace a *running* same-identity app and relaunch. The plan's first task is a short spike to confirm the invocation (silent flag, relaunch, whether the current app must be closed first). If it can't be made reliable, fall back to `tauri-plugin-updater` + a per-build manifest (small D/CI addition). Everything else in this design is independent of that outcome.

## File map (for the plan)

**Create:**
- `src-tauri/src/dev_builds.rs` — `list_dev_builds`, `install_dev_build`, `DevBuild`/`DevBuildAsset` types + unit tests
- `src/components/DevBuildsCard.tsx` — the gated Dev Builds section
- `src/components/DevBuildsCard.test.tsx` — view tests
- `src/lib/isDevBuild.ts` (or similar) — version-based dev-build detection helper (+ test)

**Modify:**
- `src-tauri/src/lib.rs` — `pub mod dev_builds;` + register the two commands
- `src-tauri/capabilities/default.json` — add any new permission needed (e.g. for spawning the installer / `http` if not already granted)
- `src/views/Settings.tsx` — render `<DevBuildsCard />` when `isDevBuild`
- `src/App.tsx` — suppress the self-update banner when `isDevBuild`
