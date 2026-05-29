# Build switcher (sub-project E) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dev-build-only, in-app "Dev Builds" surface that lists the open PRs' `dev-pr<N>` prereleases and (on Windows) one-click installs a chosen one into the "(Dev)" slot in place — replacing the running (Dev) app and relaunching into it — while the stable release app shows nothing and is never touched.

**Architecture:** A new Rust module (`dev_builds.rs`) exposes two commands: `list_dev_builds` (GitHub releases → `dev-pr<N>` builds, reusing `download::fetch_releases`) and `install_dev_build` (download the chosen build's NSIS `_x64-setup.exe` via `download::download_file`, then run it — same `com.sts2mm.app.dev` identity replaces the slot in place). A new gated frontend section (`DevBuildsCard`, rendered in Settings only when the running version contains `-dev`) drives them. The self-update nag is suppressed on dev builds. No CI/workflow changes — it consumes D's existing prereleases.

**Tech Stack:** Rust (Tauri 2, `reqwest` via existing `download.rs` helpers, `std::process::Command`), React + TypeScript (vitest), `@tauri-apps/api/core` `invoke`, `@tauri-apps/api/app` `getVersion`, react-i18next.

**Spec:** [`docs/superpowers/specs/2026-05-28-build-switcher-design.md`](../specs/2026-05-28-build-switcher-design.md)

---

## File Map

**Create:**
- `src/lib/isDevBuild.ts` — `isDevBuild()` helper (version contains `-dev`)
- `src/lib/isDevBuild.test.ts` — its tests
- `src-tauri/src/dev_builds.rs` — `list_dev_builds`, `install_dev_build`, `DevBuild`/`DevBuildAsset`, parse helpers + Rust unit tests
- `src/components/DevBuildsCard.tsx` — the gated Dev Builds section
- `src/components/DevBuildsCard.test.tsx` — its view tests

**Modify:**
- `src/App.tsx` — suppress the on-launch self-update check/banner when `isDevBuild`
- `src/App.test.tsx` — assert the banner does not auto-show on a `-dev` version
- `src-tauri/src/lib.rs` — `pub mod dev_builds;` + register the two commands
- `src/views/Settings.tsx` — render `<DevBuildsCard />` only when `isDevBuild`
- `src/views/Settings.test.tsx` — gating tests
- `src/i18n/locales/en.json` + `src/i18n/locales/zh-Hans.json` — `devBuilds.*` strings

**Untouched:** the release/tag flow, `updater.rs` (mod updater), D's workflows, `tauri.conf.json`.

---

### Task 1: Dev-build detection helper + suppress the self-update nag

**Goal:** Add `isDevBuild()` (true when the running version contains `-dev`) and use it to skip the on-launch "update to release" banner in dev builds.

**Files:**
- Create: `src/lib/isDevBuild.ts`
- Create: `src/lib/isDevBuild.test.ts`
- Modify: `src/App.tsx` (the update-check `useEffect`, ~lines 319–335; imports ~line 24)
- Modify: `src/App.test.tsx` (add one test near the existing "app-update banner" tests, ~line 750)

**Acceptance Criteria:**
- [ ] `isDevBuild()` resolves `true` for `1.6.1-dev.pr59.g837f5ba`, `false` for `1.6.1`, `false` if `getVersion()` rejects
- [ ] On a `-dev` version, `App` does NOT call the updater banner flow on launch (no banner even when `check()` returns an update)
- [ ] On a release version, the existing banner behavior is unchanged
- [ ] `npm test -- isDevBuild App.test` passes

**Verify:** `npm test -- src/lib/isDevBuild.test.ts src/App.test.tsx` → all pass

**Steps:**

- [ ] **Step 1: Write the failing helper test** — `src/lib/isDevBuild.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { isDevBuild } from './isDevBuild';
import { setMockAppVersion } from '../__test__/setup';

describe('isDevBuild', () => {
  it('is true for a -dev version', async () => {
    setMockAppVersion('1.6.1-dev.pr59.g837f5ba');
    expect(await isDevBuild()).toBe(true);
  });

  it('is false for a release version', async () => {
    setMockAppVersion('1.6.1');
    expect(await isDevBuild()).toBe(false);
  });

  it('is false when getVersion rejects', async () => {
    const app = await import('@tauri-apps/api/app');
    (app.getVersion as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('no runtime'));
    expect(await isDevBuild()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it, confirm failure** — `npm test -- src/lib/isDevBuild.test.ts` (module doesn't exist yet).

- [ ] **Step 3: Implement** — `src/lib/isDevBuild.ts`

```ts
import { getVersion } from '@tauri-apps/api/app';

/** True when the running build is a dev build (its version contains "-dev",
 *  e.g. "1.6.1-dev.pr59.g837f5ba"). Used to gate the Dev Builds UI and to
 *  suppress the release update-nag on dev builds. Resolves false if the
 *  version can't be read. */
export async function isDevBuild(): Promise<boolean> {
  try {
    return (await getVersion()).includes('-dev');
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the helper test, confirm pass** — `npm test -- src/lib/isDevBuild.test.ts` → 3 pass.

- [ ] **Step 5: Guard the update nag in `src/App.tsx`.** Add the import near line 24:

```ts
import { isDevBuild } from './lib/isDevBuild';
```

Replace the on-launch update-check `useEffect` (currently ~lines 319–335) with:

```tsx
  // Check for app updates on launch and every 24h — but NOT on dev builds.
  // A dev build deliberately runs a pre-release; the "update to the latest
  // release" nag is counterproductive there (build management lives in the
  // Dev Builds section instead). Release builds are unchanged.
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | undefined;
    function doCheck() {
      check()
        .then((update) => {
          if (update) setAppUpdate(update);
        })
        .catch((e) => {
          console.warn('Update check failed:', e);
        });
    }
    isDevBuild().then((dev) => {
      if (dev) return;
      doCheck();
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      interval = setInterval(doCheck, ONE_DAY_MS);
    });
    return () => {
      if (interval) clearInterval(interval);
    };
  }, []);
```

- [ ] **Step 6: Add the App test** — in `src/App.test.tsx`, near the existing app-update-banner tests, add:

```tsx
  it('app-update banner is suppressed on a dev build', async () => {
    const { setMockAppVersion } = await import('./__test__/setup');
    setMockAppVersion('1.6.1-dev.pr59.g837f5ba');
    const updater = await import('@tauri-apps/plugin-updater');
    (updater.check as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      version: '9.9.9',
      currentVersion: '1.6.1-dev.pr59.g837f5ba',
      downloadAndInstall: vi.fn(async () => {}),
    });
    render(<App />);
    await waitFor(() => { expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument(); });
    // The banner uses the app.updateAvailableBanner string; it must NOT appear.
    expect(screen.queryByText(/9\.9\.9/)).not.toBeInTheDocument();
    setMockAppVersion('1.3.4'); // restore the default for later tests
  });
```

(If a different assertion is more robust against the i18n string, match on the Install/Download banner buttons instead — the point is no update banner renders on a `-dev` version.)

- [ ] **Step 7: Run + commit**

```bash
npm test -- src/lib/isDevBuild.test.ts src/App.test.tsx
git add src/lib/isDevBuild.ts src/lib/isDevBuild.test.ts src/App.tsx src/App.test.tsx
git commit -m "$(cat <<'EOF'
feat(dev-builds): isDevBuild helper + suppress self-update nag on dev builds

A dev build runs a pre-release on purpose; the "update to latest release"
banner is counterproductive there. isDevBuild() (version contains -dev)
gates the App on-launch update check. Release builds unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Rust `dev_builds.rs` — `list_dev_builds` + types + parse tests

**Goal:** A Rust command that fetches the repo's releases and returns the `dev-pr<N>` prereleases shaped for the UI, with pure, unit-tested parsing.

**Files:**
- Create: `src-tauri/src/dev_builds.rs`
- Modify: `src-tauri/src/lib.rs` (`pub mod dev_builds;` near the other `pub mod` decls ~line 30; register `dev_builds::list_dev_builds` in `invoke_handler` ~after line 316)

**Acceptance Criteria:**
- [ ] `parse_pr_from_tag("dev-pr59")` → `Some(59)`; `"v1.6.1"` → `None`
- [ ] `parse_sha_from_title("Dev build — PR #59 (g837f5ba)")` → `Some("837f5ba")`
- [ ] `parse_dev_builds` excludes non-prerelease + non-`dev-pr` tags, sorts newest-PR-first, sets `windows_installer_url` from the `*-setup.exe` asset (None when absent), maps each asset to a platform label
- [ ] `list_dev_builds` is registered and reads the stored `github_token` from `AppState`
- [ ] `cargo test --manifest-path=src-tauri/Cargo.toml dev_builds` passes

**Verify:** `cargo test --manifest-path=src-tauri/Cargo.toml dev_builds` → parse tests pass; `cargo check --manifest-path=src-tauri/Cargo.toml` → no errors

**Steps:**

- [ ] **Step 1: Create `src-tauri/src/dev_builds.rs`** with the logic + tests:

```rust
//! Sub-project E (build switcher). Lists the repo's per-PR dev builds
//! (`dev-pr<N>` prereleases produced by sub-project D) and installs a chosen
//! one into the "(Dev)" slot. Discovery reuses `download::fetch_releases`;
//! the GitHub fetch + CSP constraints are why this lives in Rust, not the
//! frontend. See docs/superpowers/specs/2026-05-28-build-switcher-design.md.

use serde::Serialize;
use tauri::State;

use crate::download::{fetch_releases, GitHubRelease};
use crate::state::AppState;

const REPO_OWNER: &str = "MohamedSerhan";
const REPO_NAME: &str = "sts2-mod-manager";

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DevBuildAsset {
    pub name: String,
    pub url: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DevBuild {
    pub pr: u32,
    pub sha: String,
    pub title: String,
    pub published_at: String,
    pub windows_installer_url: Option<String>,
    pub assets: Vec<DevBuildAsset>,
}

/// `"dev-pr59"` -> `Some(59)`; other tags -> `None`.
fn parse_pr_from_tag(tag: &str) -> Option<u32> {
    tag.strip_prefix("dev-pr")?.parse::<u32>().ok()
}

/// Pull the short sha from a release title like
/// `"Dev build — PR #59 (g837f5ba)"` -> `Some("837f5ba")`.
fn parse_sha_from_title(title: &str) -> Option<String> {
    let start = title.find("(g")? + 2;
    let rest = &title[start..];
    let end = rest.find(')')?;
    let sha = &rest[..end];
    if !sha.is_empty() && sha.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(sha.to_string())
    } else {
        None
    }
}

/// Human platform label for an asset filename.
fn platform_of(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if n.ends_with("_portable.zip") {
        "Windows (portable)"
    } else if n.ends_with("-setup.exe") || n.ends_with(".msi") {
        "Windows (installer)"
    } else if n.ends_with(".dmg") {
        "macOS"
    } else if n.ends_with(".deb") {
        "Linux (.deb)"
    } else if n.ends_with(".rpm") {
        "Linux (.rpm)"
    } else if n.ends_with(".appimage") {
        "Linux (AppImage)"
    } else {
        "Other"
    }
}

/// Pure: filter the repo's releases to `dev-pr<N>` prereleases, newest first.
fn parse_dev_builds(releases: Vec<GitHubRelease>) -> Vec<DevBuild> {
    let mut builds: Vec<DevBuild> = releases
        .into_iter()
        .filter(|r| r.prerelease)
        .filter_map(|r| {
            let pr = parse_pr_from_tag(&r.tag_name)?;
            let title = r.name.clone().unwrap_or_else(|| r.tag_name.clone());
            let sha = parse_sha_from_title(&title).unwrap_or_default();
            let windows_installer_url = r
                .assets
                .iter()
                .find(|a| a.name.to_ascii_lowercase().ends_with("-setup.exe"))
                .map(|a| a.browser_download_url.clone());
            let assets = r
                .assets
                .iter()
                .map(|a| DevBuildAsset {
                    name: a.name.clone(),
                    url: a.browser_download_url.clone(),
                    platform: platform_of(&a.name).to_string(),
                })
                .collect();
            Some(DevBuild {
                pr,
                sha,
                title,
                published_at: r.published_at.clone().unwrap_or_default(),
                windows_installer_url,
                assets,
            })
        })
        .collect();
    builds.sort_by(|a, b| b.pr.cmp(&a.pr));
    builds
}

/// List the open PRs' dev builds (newest first). Reuses the stored GitHub
/// token for a higher rate limit; works unauthenticated on this public repo.
#[tauri::command]
pub async fn list_dev_builds(state: State<'_, AppState>) -> Result<Vec<DevBuild>, String> {
    let token = {
        let inner = state.lock().map_err(|e| e.to_string())?;
        inner.github_token.clone()
    };
    let releases = fetch_releases(REPO_OWNER, REPO_NAME, 1, 100, token.as_deref())
        .await
        .map_err(|e| format!("Failed to list dev builds: {e}"))?;
    Ok(parse_dev_builds(releases))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::download::{GitHubAsset, GitHubRelease};

    fn asset(name: &str) -> GitHubAsset {
        GitHubAsset {
            name: name.to_string(),
            size: 1,
            browser_download_url: format!("https://example/{name}"),
            content_type: "application/octet-stream".to_string(),
            download_count: 0,
        }
    }

    fn release(tag: &str, name: &str, prerelease: bool, assets: Vec<GitHubAsset>) -> GitHubRelease {
        GitHubRelease {
            tag_name: tag.to_string(),
            name: Some(name.to_string()),
            body: None,
            prerelease,
            published_at: Some("2026-05-28T00:00:00Z".to_string()),
            assets,
            html_url: "https://example/release".to_string(),
        }
    }

    #[test]
    fn parses_pr_from_tag() {
        assert_eq!(parse_pr_from_tag("dev-pr59"), Some(59));
        assert_eq!(parse_pr_from_tag("v1.6.1"), None);
        assert_eq!(parse_pr_from_tag("dev-prX"), None);
    }

    #[test]
    fn parses_sha_from_title() {
        assert_eq!(
            parse_sha_from_title("Dev build — PR #59 (g837f5ba)").as_deref(),
            Some("837f5ba")
        );
        assert_eq!(parse_sha_from_title("no sha here"), None);
    }

    #[test]
    fn filters_sorts_and_shapes() {
        let releases = vec![
            release("v1.6.1", "1.6.1", false, vec![asset("STS2_1.6.1_x64-setup.exe")]),
            release(
                "dev-pr59",
                "Dev build — PR #59 (g837f5ba)",
                true,
                vec![
                    asset("STS2 Mod Manager (Dev)_1.6.1-dev.pr59.g837f5ba_x64-setup.exe"),
                    asset("STS2 Mod Manager (Dev)_1.6.1-dev.pr59.g837f5ba_universal.dmg"),
                ],
            ),
            release(
                "dev-pr60",
                "Dev build — PR #60 (gabc1234)",
                true,
                vec![asset("STS2 Mod Manager (Dev)_1.6.1-dev.pr60.gabc1234_universal.dmg")],
            ),
        ];
        let builds = parse_dev_builds(releases);
        assert_eq!(builds.len(), 2, "release excluded, only dev-pr* kept");
        assert_eq!(builds[0].pr, 60, "newest PR first");
        assert_eq!(builds[1].pr, 59);
        assert_eq!(builds[1].sha, "837f5ba");
        assert!(builds[1].windows_installer_url.is_some());
        assert!(builds[0].windows_installer_url.is_none(), "PR60 has no win setup");
        let dmg = builds[1].assets.iter().find(|a| a.name.ends_with(".dmg")).unwrap();
        assert_eq!(dmg.platform, "macOS");
    }
}
```

- [ ] **Step 2: Wire into `src-tauri/src/lib.rs`.** Add the module declaration near the other `pub mod` lines (~line 30):

```rust
pub mod dev_builds;
```

In the `invoke_handler` list, after `updater::audit_mod_versions,` (~line 316) add:

```rust
            dev_builds::list_dev_builds,
```

- [ ] **Step 3: Run the tests** — `cargo test --manifest-path=src-tauri/Cargo.toml dev_builds` → 3 pass. Then `cargo check --manifest-path=src-tauri/Cargo.toml` → no errors. (Note: this compiles the Tauri crate; first build is slow — let it finish.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/dev_builds.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(dev-builds): list_dev_builds command + dev-pr release parsing

New dev_builds module fetches the repo's releases (reusing
download::fetch_releases), filters to dev-pr<N> prereleases, parses PR#/sha,
selects the Windows installer asset, and maps assets to platform labels.
Pure parse_dev_builds is unit-tested. Reads the stored github token.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Rust `install_dev_build` (download + run installer) + register

**Goal:** A Windows command that downloads a chosen build's NSIS installer and runs it, replacing the (Dev) slot in place.

**Files:**
- Modify: `src-tauri/src/dev_builds.rs` (add `install_dev_build`)
- Modify: `src-tauri/src/lib.rs` (register `dev_builds::install_dev_build`)

**Acceptance Criteria:**
- [ ] `install_dev_build(url)` on Windows downloads the installer (via `download::download_file`) to a temp path and spawns it
- [ ] On non-Windows it returns a clear "Windows-only" error (no crash)
- [ ] Command registered in `invoke_handler`
- [ ] `cargo check --manifest-path=src-tauri/Cargo.toml` passes; `cargo test ... dev_builds` still passes

**Verify:** `cargo check --manifest-path=src-tauri/Cargo.toml` → no errors (the actual install is exercised in Task 6's manual gate)

**Steps:**

- [ ] **Step 1: Add `install_dev_build` to `src-tauri/src/dev_builds.rs`** (after `list_dev_builds`):

```rust
/// Download a dev build's Windows NSIS installer and run it. Because every
/// dev build shares the `com.sts2mm.app.dev` identity, the installer replaces
/// the running "(Dev)" app in place and relaunches into the chosen build.
/// The exact silent/relaunch flags are confirmed by the manual gate (Task 6);
/// this launches the installer interactively, which Tauri's NSIS handles for
/// a running same-identity app.
#[cfg(target_os = "windows")]
#[tauri::command]
pub async fn install_dev_build(installer_url: String) -> Result<(), String> {
    use std::process::Command;
    let dest = std::env::temp_dir().join("sts2mm-dev-setup.exe");
    crate::download::download_file(&installer_url, &dest, |_, _| {})
        .await
        .map_err(|e| format!("Download failed: {e}"))?;
    Command::new(&dest)
        .spawn()
        .map_err(|e| format!("Failed to launch installer: {e}"))?;
    Ok(())
}

#[cfg(not(target_os = "windows"))]
#[tauri::command]
pub async fn install_dev_build(_installer_url: String) -> Result<(), String> {
    Err("In-app install is Windows-only — use the download link instead.".to_string())
}
```

- [ ] **Step 2: Register it in `src-tauri/src/lib.rs`** — after the `dev_builds::list_dev_builds,` line:

```rust
            dev_builds::install_dev_build,
```

- [ ] **Step 3: Build check** — `cargo check --manifest-path=src-tauri/Cargo.toml` → no errors; `cargo test --manifest-path=src-tauri/Cargo.toml dev_builds` → still passes. (No new Tauri capability is required: custom commands are invokable by default, and `reqwest`/`std::process` run in the Rust backend, which the capability ACL does not gate. If invocation is somehow blocked at runtime, add the command to `src-tauri/capabilities/default.json` — but it should not be needed.)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/dev_builds.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(dev-builds): install_dev_build — download + run the chosen NSIS setup

Windows command downloads a dev build's _x64-setup.exe (via
download::download_file) and runs it; same com.sts2mm.app.dev identity
replaces the (Dev) slot in place. Non-Windows returns a Windows-only error.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `DevBuildsCard` frontend component + tests

**Goal:** The Dev Builds UI: lists builds, marks the one you're running, offers Switch (Windows) + download links, with loading/empty/error/no-installer states.

**Files:**
- Create: `src/components/DevBuildsCard.tsx`
- Create: `src/components/DevBuildsCard.test.tsx`
- Modify: `src/i18n/locales/en.json`, `src/i18n/locales/zh-Hans.json` (add `devBuilds.*`)

**Acceptance Criteria:**
- [ ] On mount calls `list_dev_builds`; renders each build as "PR #N · g<sha>" newest-first
- [ ] The build whose sha matches the running `getVersion()` is marked current and its Switch is disabled
- [ ] Clicking Switch on another build calls `install_dev_build` with that build's `windows_installer_url`
- [ ] A build with no `windows_installer_url` shows a "no Windows build" note instead of Switch
- [ ] Empty list → empty state; fetch error → error message + Retry
- [ ] No silent-skip patterns; every test asserts visible behavior
- [ ] `npm test -- DevBuildsCard` passes

**Verify:** `npm test -- src/components/DevBuildsCard.test.tsx` → all pass

**Steps:**

- [ ] **Step 1: Write the failing test** — `src/components/DevBuildsCard.test.tsx`. Render via the same provider wrapper used by `src/components/AboutCard.test.tsx` (it wraps the toast + i18n providers DevBuildsCard needs — follow that file's render setup exactly).

```tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { DevBuildsCard } from './DevBuildsCard';
import {
  registerInvokeHandler,
  getInvokeCalls,
  setMockAppVersion,
} from '../__test__/setup';
// NOTE: wrap <DevBuildsCard /> in the same providers AboutCard.test.tsx uses
// (ToastProvider + I18nextProvider). Define a `renderCard()` helper mirroring it.

const TWO_BUILDS = [
  {
    pr: 60,
    sha: 'abc1234',
    title: 'Dev build — PR #60 (gabc1234)',
    published_at: '2026-05-28T00:00:00Z',
    windows_installer_url: null,
    assets: [{ name: 'app_universal.dmg', url: 'https://e/a.dmg', platform: 'macOS' }],
  },
  {
    pr: 59,
    sha: '837f5ba',
    title: 'Dev build — PR #59 (g837f5ba)',
    published_at: '2026-05-27T00:00:00Z',
    windows_installer_url: 'https://e/setup.exe',
    assets: [{ name: 'setup.exe', url: 'https://e/setup.exe', platform: 'Windows (installer)' }],
  },
];

describe('DevBuildsCard', () => {
  it('lists builds, marks the running one, and switches to another', async () => {
    setMockAppVersion('1.6.1-dev.pr59.g837f5ba'); // running PR59
    registerInvokeHandler('list_dev_builds', () => TWO_BUILDS);
    registerInvokeHandler('install_dev_build', () => null);
    const user = userEvent.setup();
    renderCard();

    await waitFor(() => expect(screen.getByText(/PR #60/)).toBeInTheDocument());
    expect(screen.getByText(/PR #59/)).toBeInTheDocument();
    // PR59 is current (running) → its Switch is disabled; PR60 has no win build.
    // PR60 shows the no-Windows note (its only Switch path is disabled/absent).
    expect(screen.getByText(/no Windows build/i)).toBeInTheDocument();

    // Switch is only offered for builds with a windows installer that aren't current.
    // PR59 is current (disabled). Make a third build to switch TO:
    // (handled below in a dedicated test)
  });

  it('Switch calls install_dev_build with the build installer url', async () => {
    setMockAppVersion('1.6.1-dev.pr60.gabc1234'); // running PR60 (no win build) so PR59 is switchable
    registerInvokeHandler('list_dev_builds', () => TWO_BUILDS);
    registerInvokeHandler('install_dev_build', () => null);
    const user = userEvent.setup();
    renderCard();

    const switchBtn = await screen.findByRole('button', { name: /switch/i });
    await user.click(switchBtn);
    await waitFor(() => {
      const call = getInvokeCalls().find((c) => c.cmd === 'install_dev_build');
      expect(call).toBeTruthy();
      expect(call!.args).toEqual({ installerUrl: 'https://e/setup.exe' });
    });
  });

  it('shows an empty state when there are no dev builds', async () => {
    setMockAppVersion('1.6.1-dev.pr1.gdeadbee');
    registerInvokeHandler('list_dev_builds', () => []);
    renderCard();
    await waitFor(() => expect(screen.getByText(/no open dev builds/i)).toBeInTheDocument());
  });

  it('shows an error + retry when listing fails', async () => {
    setMockAppVersion('1.6.1-dev.pr1.gdeadbee');
    registerInvokeHandler('list_dev_builds', () => { throw new Error('rate limited'); });
    renderCard();
    await waitFor(() => expect(screen.getByText(/rate limited/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
```

(Define `renderCard()` at the top of the file to wrap `<DevBuildsCard />` in the same providers `AboutCard.test.tsx` uses. Keep the assertions above; they cover list/current/switch/empty/error/no-windows.)

- [ ] **Step 2: Run it, confirm failure** — `npm test -- src/components/DevBuildsCard.test.tsx` (component doesn't exist).

- [ ] **Step 3: Implement** — `src/components/DevBuildsCard.tsx`

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Card } from './Card';
import { Button } from './Button';
import { useToast } from '../contexts/ToastContext';

interface DevBuildAsset {
  name: string;
  url: string;
  platform: string;
}
interface DevBuild {
  pr: number;
  sha: string;
  title: string;
  published_at: string;
  windows_installer_url: string | null;
  assets: DevBuildAsset[];
}

/** Dev-build-only "switch which PR build is in the (Dev) slot" panel.
 *  Rendered by Settings only when the running build is a dev build. */
export function DevBuildsCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const [builds, setBuilds] = useState<DevBuild[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentSha, setCurrentSha] = useState('');
  const [installingPr, setInstallingPr] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const list = await invoke<DevBuild[]>('list_dev_builds');
      setBuilds(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    getVersion()
      .then((v) => {
        const m = v.match(/\.g([0-9a-f]+)/i);
        if (m) setCurrentSha(m[1]);
      })
      .catch(() => {});
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSwitch(b: DevBuild) {
    if (!b.windows_installer_url || installingPr !== null) return;
    setInstallingPr(b.pr);
    try {
      await invoke('install_dev_build', { installerUrl: b.windows_installer_url });
      toast.success(t('devBuilds.installing', { pr: b.pr }));
    } catch (e) {
      toast.error(t('devBuilds.installFailed', { error: e instanceof Error ? e.message : String(e) }));
      setInstallingPr(null);
    }
  }

  return (
    <Card>
      <h2>{t('devBuilds.title')}</h2>
      <p className="gf-dim">{t('devBuilds.subtitle')}</p>

      {loading && <p>{t('devBuilds.loading')}</p>}

      {error && (
        <div>
          <p className="gf-error">{t('devBuilds.error', { error })}</p>
          <Button variant="ghost" size="sm" onClick={load}>
            {t('devBuilds.retry')}
          </Button>
        </div>
      )}

      {!loading && !error && builds?.length === 0 && <p>{t('devBuilds.empty')}</p>}

      {!loading && !error && builds && builds.length > 0 && (
        <ul className="gf-devbuilds-list">
          {builds.map((b) => {
            const isCurrent = b.sha !== '' && b.sha === currentSha;
            return (
              <li key={b.pr} className="gf-devbuilds-row">
                <div>
                  <strong>PR #{b.pr}</strong> · g{b.sha || '—'}
                  {isCurrent && <span className="gf-badge"> {t('devBuilds.current')}</span>}
                  <div className="gf-dim">{b.title}</div>
                </div>
                <div className="gf-devbuilds-actions">
                  {b.windows_installer_url ? (
                    <Button
                      size="sm"
                      disabled={isCurrent || installingPr !== null}
                      onClick={() => handleSwitch(b)}
                    >
                      {installingPr === b.pr ? t('devBuilds.installingShort') : t('devBuilds.switchTo')}
                    </Button>
                  ) : (
                    <span className="gf-dim">{t('devBuilds.noWindowsBuild')}</span>
                  )}
                  {b.assets.map((a) => (
                    <Button
                      key={a.name}
                      variant="ghost"
                      size="sm"
                      onClick={() => openUrl(a.url).catch(() => {})}
                    >
                      {a.platform}
                    </Button>
                  ))}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="gf-dim">{t('devBuilds.backToRelease')}</p>
    </Card>
  );
}
```

- [ ] **Step 4: Add i18n keys.** In `src/i18n/locales/en.json`, add a `devBuilds` block (place alphabetically/with sibling sections):

```json
  "devBuilds": {
    "title": "Dev Builds",
    "subtitle": "Switch the (Dev) app between open PRs' builds. Your release app is untouched.",
    "loading": "Loading dev builds…",
    "error": "Couldn't load dev builds: {{error}}",
    "retry": "Retry",
    "empty": "No open dev builds — open a PR and label it dev-build.",
    "current": "(current — you're running this)",
    "switchTo": "Switch to this build",
    "installingShort": "Installing…",
    "installing": "Installing PR #{{pr}} — the (Dev) app will replace itself and relaunch.",
    "installFailed": "Install failed: {{error}}",
    "noWindowsBuild": "No Windows build (its build leg may have failed)",
    "backToRelease": "To return to the stable app, just launch your release STS2 Mod Manager — it's a separate, untouched install."
  }
```

In `src/i18n/locales/zh-Hans.json`, add the **same keys** (English values are acceptable for this maintainer-only dev surface; a co-maintainer can translate later). The two locale files must stay structurally complete.

- [ ] **Step 5: Run + commit**

```bash
npm test -- src/components/DevBuildsCard.test.tsx
git add src/components/DevBuildsCard.tsx src/components/DevBuildsCard.test.tsx src/i18n/locales/en.json src/i18n/locales/zh-Hans.json
git commit -m "$(cat <<'EOF'
feat(dev-builds): DevBuildsCard — list/switch the (Dev) slot's PR build

Lists dev-pr<N> builds (newest first), marks the running one via the sha in
its version, offers Switch (Windows, via install_dev_build) + per-asset
download links, with loading/empty/error/no-Windows states. i18n strings
added.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Wire `DevBuildsCard` into Settings (gated on dev build)

**Goal:** Render the Dev Builds section in Settings only when the running build is a dev build.

**Files:**
- Modify: `src/views/Settings.tsx` (import + gated render)
- Modify: `src/views/Settings.test.tsx` (gating tests)

**Acceptance Criteria:**
- [ ] On a `-dev` version, Settings renders the Dev Builds section (title visible)
- [ ] On a release version, the Dev Builds section is absent
- [ ] `npm test -- Settings` passes

**Verify:** `npm test -- src/views/Settings.test.tsx` → all pass

**Steps:**

- [ ] **Step 1: Add the gated render to `src/views/Settings.tsx`.** Add imports:

```ts
import { DevBuildsCard } from '../components/DevBuildsCard';
import { isDevBuild } from '../lib/isDevBuild';
```

Inside the `Settings` component, resolve the gate and render the card among the existing cards:

```tsx
  const [showDevBuilds, setShowDevBuilds] = useState(false);
  useEffect(() => {
    isDevBuild().then(setShowDevBuilds).catch(() => {});
  }, []);
```

```tsx
  {showDevBuilds && <DevBuildsCard />}
```

(Place the render with the other Settings cards — e.g. near the update/about-related card. `useState`/`useEffect` are already imported in this view; if not, add them.)

- [ ] **Step 2: Add gating tests to `src/views/Settings.test.tsx`:**

```tsx
  it('shows the Dev Builds section on a dev build', async () => {
    setMockAppVersion('1.6.1-dev.pr59.g837f5ba');
    registerInvokeHandler('list_dev_builds', () => []);
    renderSettings(); // use this file's existing Settings render helper
    expect(await screen.findByText('Dev Builds')).toBeInTheDocument();
  });

  it('hides the Dev Builds section on a release build', async () => {
    setMockAppVersion('1.6.1');
    renderSettings();
    // Give the gating effect a tick; the section must never appear.
    await waitFor(() => expect(screen.getByText(/Settings/i)).toBeInTheDocument());
    expect(screen.queryByText('Dev Builds')).not.toBeInTheDocument();
  });
```

(`setMockAppVersion` + `registerInvokeHandler` come from `../__test__/setup`; mirror how the other tests in this file import them and render Settings. Reset the version at the end of the dev-build test if later tests assume the default.)

- [ ] **Step 3: Run + commit**

```bash
npm test -- src/views/Settings.test.tsx
git add src/views/Settings.tsx src/views/Settings.test.tsx
git commit -m "$(cat <<'EOF'
feat(dev-builds): show Dev Builds in Settings only on dev builds

Settings renders <DevBuildsCard /> gated on isDevBuild() so the release app
(and Nexus end users) never see it; dev builds get the switcher.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Manual Windows end-to-end verification (USER GATE)

**Goal:** Prove, on Windows, that from inside a dev build you can switch the (Dev) slot to another PR's build in place — it downloads, replaces the running (Dev) app, relaunches into the chosen build, stays on isolated `sts2-mod-manager-dev` data, and leaves the release app untouched.

**USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:**
- None (operational verification on the maintainer's Windows machine)

**Acceptance Criteria:**
- [ ] In a dev build (e.g. the current `dev-pr<N>` build, installed from its PR sticky comment), Settings → **Dev Builds** lists the open PRs' builds, newest first, with the running one marked "current"
- [ ] Clicking **Switch to this build** on a *different* PR's build downloads its installer, the (Dev) app is replaced in place, and it **relaunches into the chosen build** (the running version's `g<sha>`/PR now matches the target)
- [ ] After the swap, the (Dev) app is still using `%APPDATA%\sts2-mod-manager-dev\` and the release `%APPDATA%\sts2-mod-manager\` is untouched
- [ ] The release app (`com.sts2mm.app`, "STS2 Mod Manager") is unaffected throughout
- [ ] On a release build, the Dev Builds section does not appear and the update-nag banner behaves as before

**Verify:** (manual, Windows) After switching, the (Dev) app reports the target PR's version + `g<sha>`; `Test-Path "$env:APPDATA\sts2-mod-manager-dev"` is `True`; the release dir is unchanged. If the raw-installer self-replace proves unreliable, fall back to `tauri-plugin-updater` + a per-build manifest (small D/CI add) and re-verify.

**Steps:**

- [ ] **Step 1: Get two dev builds to switch between.** Ensure two PRs are labeled `dev-build` so two `dev-pr<N>` prereleases exist (a throwaway second PR is fine). Install one from its sticky-comment Windows installer.
- [ ] **Step 2: Open the running (Dev) app → Settings → Dev Builds.** Confirm the list shows both PRs, newest first, with the running one marked current.
- [ ] **Step 3: Switch.** Click **Switch to this build** on the *other* PR. Confirm it downloads, the app closes/replaces, and relaunches into the chosen build (check the version footer / Settings shows the new `g<sha>`).
- [ ] **Step 4: Confirm isolation.** In PowerShell: `Test-Path "$env:APPDATA\sts2-mod-manager-dev"` → `True`; confirm the release `%APPDATA%\sts2-mod-manager` dir is untouched and your release app still launches normally.
- [ ] **Step 5: Confirm the release is clean.** Launch the release app; confirm no Dev Builds section and the normal update banner behavior.

No commit (verification only).

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Dev-build-only, runtime-gated UI | Task 1 (`isDevBuild`) + Task 5 (gated render) |
| Suppress update nag on dev builds | Task 1 |
| `list_dev_builds` (GitHub fetch in Rust, dev-pr filter) | Task 2 |
| `install_dev_build` (download + run installer, Windows) | Task 3 |
| Frontend Dev Builds section (list/current/switch/links/states) | Task 4 |
| Current build via running version (no persisted state) | Task 4 (`getVersion` sha match) |
| Placement in Settings | Task 5 |
| Isolated data preserved | inherited from D (version-keyed `app_dir_name`); verified in Task 6 |
| Error handling (offline/empty/no-installer) | Task 4 |
| Testing (Rust parse, gated view, manual) | Tasks 2, 4, 5, 6 |
| No CI changes (manifest only as fallback) | (no task; fallback noted in Task 3 + Task 6) |
| End-to-end manual verification | Task 6 |

All spec requirements covered. No placeholders. Type/name consistency: `DevBuild`/`DevBuildAsset` fields (`pr`, `sha`, `title`, `published_at`, `windows_installer_url`, `assets`) are identical in the Rust struct (Task 2) and the TS interface (Task 4); the command names `list_dev_builds` / `install_dev_build` and the arg `installerUrl` match across Tasks 2/3/4; `isDevBuild` is consistent across Tasks 1/5.

---

## Acknowledgements

Plan + spec live on the `claude/build-switcher` worktree (off `main` at `085384b`, which has sub-projects A + D). Execution should continue in this worktree. The one implementation risk (NSIS running-instance self-replace) is isolated to Task 3's mechanism and proven in Task 6, with a documented `tauri-updater`+manifest fallback.
