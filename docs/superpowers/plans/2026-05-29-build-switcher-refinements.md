# Build switcher refinements (sub-project E, round 2) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Dev Builds switcher production-quality from the round-1 gate findings: a clean, searchable, scalable list; a true one-click switch (silent updater swap + relaunch, no installer UI); and a visually distinct dev app (DEV title-bar badge + DEV-badged Windows icon).

**Architecture:** Replace the interactive-installer switch with `tauri-plugin-updater` driven at a per-build `latest.json` manifest (the same silent path the release "Install & Restart" uses). The dev-build CI gains the manifest (reusing `publish-updater.sh`); a new Rust `switch_dev_build` command installs from it with a permissive version-comparator (so switching to a lower PR works). The frontend card is reworked (rows + search + Downloads disclosure). A build-time script badges the Windows icon; the titlebar shows DEV on dev builds.

**Tech Stack:** React + TypeScript (vitest), Rust (Tauri 2, `tauri-plugin-updater` v2), GitHub Actions YAML + `gh` + bash, Node 22, `jimp` + `png-to-ico` (pure-JS, for icon badging).

**Spec:** [`docs/superpowers/specs/2026-05-29-build-switcher-refinements-design.md`](../specs/2026-05-29-build-switcher-refinements-design.md)
**Round-1 spec:** [`docs/superpowers/specs/2026-05-28-build-switcher-design.md`](../specs/2026-05-28-build-switcher-design.md)

---

## File Map

**Create:**
- `scripts/make-dev-icon.mjs` (+ `scripts/make-dev-icon.test.mjs`) — badge the Windows runtime icons at build time

**Modify:**
- `src-tauri/src/dev_builds.rs` — add `DevBuild.manifest_url`; surface it in `parse_dev_builds`; add `switch_dev_build`; remove `install_dev_build`
- `src-tauri/src/lib.rs` — register `switch_dev_build`, unregister `install_dev_build`
- `scripts/publish-updater.sh` — optional `version_override` 3rd arg
- `.github/workflows/build.yml` — artifact-upload: add `*.sig`; publish-dev: collect `*.sig` + assemble dev `latest.json`; dev stamp step: run the icon badger; check job: run the icon-script test
- `src/components/DevBuildsCard.tsx` (+ `.test.tsx`) — row redesign, search, Downloads disclosure, Switch → `switch_dev_build`
- `src/styles.css` — row/badge/list/disclosure + titlebar DEV styling
- `src/App.tsx` (+ `.test.tsx`) — DEV title-bar badge on dev builds
- `src/i18n/locales/en.json` + `src/i18n/locales/zh-Hans.json` — new strings (search, downloads, DEV badge), zh-Hans translated

**Untouched:** release/tag CI path, data isolation, `list_dev_builds` discovery, cleanup workflow, the release app.

---

### Task 1: Rust — `switch_dev_build` + `DevBuild.manifest_url`, remove `install_dev_build`

**Goal:** Replace the interactive installer command with an updater-driven `switch_dev_build` that installs a chosen build from its `latest.json` manifest, and surface each build's manifest URL.

**Files:**
- Modify: `src-tauri/src/dev_builds.rs`
- Modify: `src-tauri/src/lib.rs` (register `switch_dev_build`; remove the `install_dev_build` registration)

**Acceptance Criteria:**
- [ ] `DevBuild` has a `manifest_url: Option<String>` set from the release's `latest.json` asset (None when absent)
- [ ] `parse_dev_builds` populates `manifest_url`; the existing parse test asserts it
- [ ] `install_dev_build` (both cfg arms) is removed from `dev_builds.rs` and unregistered in `lib.rs`
- [ ] `switch_dev_build(app, manifest_url)` builds an updater at that endpoint with an always-true version-comparator, installs, and triggers relaunch
- [ ] `cargo test --manifest-path=src-tauri/Cargo.toml dev_builds` passes; `cargo check` clean

**Verify:** `cargo test --manifest-path=src-tauri/Cargo.toml dev_builds` → passes; `cargo check --manifest-path=src-tauri/Cargo.toml` → no errors

**Steps:**

- [ ] **Step 1: Add `manifest_url` to the struct + parsing.** In `src-tauri/src/dev_builds.rs`, add the field to `DevBuild` (after `windows_installer_url`):

```rust
    pub windows_installer_url: Option<String>,
    /// URL of the `latest.json` updater manifest attached to this build's
    /// release, if present. Drives the one-click updater-based switch.
    pub manifest_url: Option<String>,
    pub assets: Vec<DevBuildAsset>,
```

In `parse_dev_builds`, compute it next to `windows_installer_url`:

```rust
            let manifest_url = r
                .assets
                .iter()
                .find(|a| a.name.eq_ignore_ascii_case("latest.json"))
                .map(|a| a.browser_download_url.clone());
```

and add `manifest_url,` to the `DevBuild { … }` constructor.

- [ ] **Step 2: Extend the parse test.** In the `filters_sorts_and_shapes` test, add a `latest.json` asset to the dev-pr59 release and assert it surfaces. Change the pr59 asset vec to include it:

```rust
                vec![
                    asset("STS2 Mod Manager (Dev)_1.6.1-dev.pr59.g837f5ba_x64-setup.exe"),
                    asset("STS2 Mod Manager (Dev)_1.6.1-dev.pr59.g837f5ba_universal.dmg"),
                    asset("latest.json"),
                ],
```

and after the existing pr59 assertions add:

```rust
        assert_eq!(
            builds[1].manifest_url.as_deref(),
            Some("https://example/latest.json"),
            "manifest_url surfaced from latest.json asset"
        );
        assert!(builds[0].manifest_url.is_none(), "PR60 has no manifest");
```

- [ ] **Step 3: Remove `install_dev_build`.** Delete both `#[cfg(target_os = "windows")]` and `#[cfg(not(target_os = "windows"))]` `install_dev_build` functions from `dev_builds.rs`.

- [ ] **Step 4: Add `switch_dev_build`.** Add this in their place. It uses the updater plugin's Rust API (`UpdaterExt`) pointed at the build's manifest, with a permissive comparator so an explicit switch installs regardless of version ordering:

```rust
/// One-click switch: install a chosen dev build from its `latest.json`
/// updater manifest using tauri-plugin-updater — the same silent
/// download + signature-verify + install + relaunch path the release
/// "Install & Restart" uses. A permissive version_comparator lets the user
/// switch to a LOWER pr (semver ranks pr61 > pr60), which a default
/// updater would refuse. No installer UI (NSIS runs passively on Windows).
#[tauri::command]
pub async fn switch_dev_build(
    app: tauri::AppHandle,
    manifest_url: String,
) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let url = manifest_url
        .parse()
        .map_err(|e| format!("Bad manifest URL: {e}"))?;
    let updater = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| format!("Updater endpoint error: {e}"))?
        .version_comparator(|_current, _update| true)
        .build()
        .map_err(|e| format!("Updater build error: {e}"))?;
    let maybe_update = updater
        .check()
        .await
        .map_err(|e| {
            log::warn!("switch_dev_build: update check failed: {e}");
            format!("Switch check failed: {e}")
        })?;
    let update = maybe_update.ok_or_else(|| {
        "No installable build found in the dev manifest.".to_string()
    })?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| {
            log::warn!("switch_dev_build: install failed: {e}");
            format!("Switch install failed: {e}")
        })?;
    // Mirror the release "Install & Restart": exit so the (NSIS) installer can
    // finish replacing the running app, then relaunch into the new build.
    app.restart();
}
```

NOTE for the implementer: `app.restart()` diverges (`-> !`), so the function body ends there (no trailing `Ok(())` needed; if the compiler wants the arm typed, `app.restart()` returns `!` which coerces). Confirm the exact `tauri-plugin-updater` v2 signatures (`updater_builder()` via `UpdaterExt`, `endpoints(Vec<Url>)`, `version_comparator`, `check() -> Result<Option<Update>>`, `download_and_install(on_chunk, on_finish)`) against the installed crate version; adjust closure arity if the crate differs. If `endpoints` doesn't return `Result` in the pinned version, drop the `?`/`map_err`. This is the one runtime-behavior unknown — it is exercised in the manual gate (Task 6), exactly as the round-1 spec planned.

- [ ] **Step 5: Update `lib.rs` registration.** Replace `dev_builds::install_dev_build,` with `dev_builds::switch_dev_build,` in the `invoke_handler` list. (`dev_builds::list_dev_builds,` stays.)

- [ ] **Step 6: Verify** — `cargo test --manifest-path=src-tauri/Cargo.toml dev_builds` (expect 3 passing, incl. the manifest assertions) then `cargo check --manifest-path=src-tauri/Cargo.toml` (no errors; in particular no leftover `install_dev_build` references). cargo is slow here — be patient.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/dev_builds.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(dev-builds): updater-driven switch_dev_build + DevBuild.manifest_url

Replace the interactive install_dev_build with switch_dev_build, which drives
tauri-plugin-updater at the chosen build's latest.json manifest (always-true
version_comparator so switching to a lower PR works) for a silent swap +
relaunch — no installer UI. parse_dev_builds now surfaces manifest_url.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: CI — publish per-build `latest.json` manifest + attach signatures

**Goal:** The dev-build pipeline attaches the updater `.sig` artifacts to the `dev-pr<N>` release and assembles a `latest.json` (carrying the real stamped version) so `switch_dev_build` has something to install.

**Files:**
- Modify: `scripts/publish-updater.sh` (optional 3rd arg = version override)
- Modify: `.github/workflows/build.yml` (artifact-upload paths; publish-dev collection + manifest assembly)

**Acceptance Criteria:**
- [ ] `publish-updater.sh` accepts an optional 3rd arg; when set, the manifest `version` field is that value; when omitted, behavior is byte-identical to before (`${TAG#v}`)
- [ ] The build job's "Upload build artifacts" step also captures `**/*.sig`
- [ ] `publish-dev`'s artifact `find` also copies `*.sig` into `dist/` (so sigs attach to the release)
- [ ] After `gh release create`, `publish-dev` runs `publish-updater.sh "$TAG" "$REPO" "<devVersion>"`, attaching `latest.json` to the `dev-pr<N>` release
- [ ] `build.yml` parses as valid YAML; `publish-updater.sh` passes `bash -n`
- [ ] Release/tag path unchanged (publish-updater job still calls the script with 2 args)

**Verify:** `python -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml')); print('OK')"` → `OK`; `bash -n scripts/publish-updater.sh` → no output (valid)

**Steps:**

- [ ] **Step 1: Add the optional version override to `scripts/publish-updater.sh`.** Replace the args block (lines ~19–31):

```bash
TAG="${1:-}"
REPO="${2:-}"
VERSION_OVERRIDE="${3:-}"

if [ -z "$TAG" ]; then
  echo "usage: $0 <tag> [repo] [version_override]" >&2
  exit 2
fi

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
fi

# Release tags (vX.Y.Z) derive the version from the tag. Dev builds pass an
# explicit override because their tag (dev-pr<N>) is not the SemVer version
# the updater needs.
if [ -n "$VERSION_OVERRIDE" ]; then
  VERSION="$VERSION_OVERRIDE"
else
  VERSION="${TAG#v}"
fi
```

(Everything else in the script is unchanged.)

- [ ] **Step 2: Capture `.sig` in the build artifacts.** In `.github/workflows/build.yml`, the "Upload build artifacts" step's `path:` list — add a `.sig` glob as the final bundle path (before the root portable-zip line):

```yaml
            src-tauri/target/universal-apple-darwin/release/bundle/**/*.dmg
            src-tauri/target/release/bundle/**/*.sig
            src-tauri/target/universal-apple-darwin/release/bundle/**/*.sig
            STS2.Mod.Manager_*_x64_portable.zip
```

(Match the existing 12-space indentation of the path entries.)

- [ ] **Step 3: Collect `.sig` in publish-dev.** In the `publish-dev` job's flatten step, add `*.sig` to the `find` extension list:

```bash
          find dev-artifacts -type f \
            \( -name '*.exe' -o -name '*.msi' -o -name '*.dmg' -o -name '*.deb' \
               -o -name '*.rpm' -o -name '*.AppImage' -o -name '*_portable.zip' \
               -o -name '*.sig' \) \
            -exec cp -f {} dist/ \;
```

- [ ] **Step 4: Assemble the dev manifest after release creation.** In `publish-dev`, inside the `if [ ${#files[@]} -gt 0 ]; then` block, immediately AFTER the `gh release create "$TAG" …` command (and before the closing `else`), add:

```bash
            # Assemble + attach latest.json so the in-app switcher can install
            # this build via tauri-plugin-updater (the silent one-click path).
            DEV_VERSION=$(node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync("src-tauri/tauri.conf.json","utf-8"));process.stdout.write(`${c.version}-dev.pr${process.env.PR}.g${process.env.HEAD_SHA.slice(0,7)}`)')
            bash scripts/publish-updater.sh "$TAG" "$REPO" "$DEV_VERSION" || echo "Manifest assembly failed (switch will be unavailable for this build)."
```

(`PR` and `HEAD_SHA` are already in the step's env. `conf.version` here is the committed base — this reconstructs the same stamped version the build legs used, matching `computeDevVersion`. The `|| echo` keeps a manifest hiccup from failing the whole publish.)

- [ ] **Step 5: Validate** — `python -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml')); print('OK')"` → `OK`; `bash -n scripts/publish-updater.sh` → clean. Sanity-read the diff: release/tag path untouched (the `publish-updater` job still invokes the script with two args).

- [ ] **Step 6: Commit**

```bash
git add scripts/publish-updater.sh .github/workflows/build.yml
git commit -m "$(cat <<'EOF'
ci(dev-builds): publish per-build latest.json manifest + attach signatures

publish-dev now collects the updater .sig artifacts and assembles a
latest.json (via publish-updater.sh, given a new optional version-override
arg carrying the real stamped dev version) so the in-app switcher can install
a build silently via tauri-plugin-updater. Release/tag path unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Frontend — DevBuildsCard redesign (rows + search + Downloads disclosure + updater switch)

**Goal:** A clean, searchable, scalable Dev Builds panel whose Switch button triggers the one-click updater swap.

**Files:**
- Modify: `src/components/DevBuildsCard.tsx`
- Modify: `src/components/DevBuildsCard.test.tsx`
- Modify: `src/styles.css`
- Modify: `src/i18n/locales/en.json`, `src/i18n/locales/zh-Hans.json`

**Acceptance Criteria:**
- [ ] A search input filters the list case-insensitively by PR number, sha, or title
- [ ] Rows are a clean two-column layout; the CURRENT tag is short and never wraps; per-platform links live behind a Downloads disclosure (not 5 always-visible buttons)
- [ ] Switch is shown only when `manifest_url` is present and the row isn't current; clicking it calls `invoke('switch_dev_build', { manifestUrl })`
- [ ] Newest-PR-first order preserved; list scrolls within a max height
- [ ] Empty/error/retry states preserved; no silent-skip patterns; every test asserts
- [ ] `npm test -- src/components/DevBuildsCard.test.tsx` passes

**Verify:** `npm test -- src/components/DevBuildsCard.test.tsx` → all pass

**Steps:**

- [ ] **Step 1: Rewrite the tests** `src/components/DevBuildsCard.test.tsx` to the new contract (define `renderCard()` mirroring `AboutCard.test.tsx`'s provider wrapper, as the current file already does):

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { DevBuildsCard } from './DevBuildsCard';
import { registerInvokeHandler, getInvokeCalls, setMockAppVersion } from '../__test__/setup';
// renderCard(): wrap <DevBuildsCard /> in the same providers AboutCard.test.tsx uses.

const BUILDS = [
  { pr: 61, sha: '60c5c35', title: 'Dev build — PR #61 (g60c5c35)', published_at: '2026-05-29T00:00:00Z',
    windows_installer_url: 'https://e/pr61-setup.exe', manifest_url: 'https://e/pr61/latest.json',
    assets: [
      { name: 'pr61-setup.exe', url: 'https://e/pr61-setup.exe', platform: 'Windows (installer)' },
      { name: 'pr61.dmg', url: 'https://e/pr61.dmg', platform: 'macOS' },
    ] },
  { pr: 60, sha: '150366e', title: 'Dev build — PR #60 (g150366e)', published_at: '2026-05-28T00:00:00Z',
    windows_installer_url: 'https://e/pr60-setup.exe', manifest_url: 'https://e/pr60/latest.json',
    assets: [{ name: 'pr60-setup.exe', url: 'https://e/pr60-setup.exe', platform: 'Windows (installer)' }] },
];

describe('DevBuildsCard', () => {
  it('lists newest-first, marks current, switches via switch_dev_build', async () => {
    setMockAppVersion('1.6.1-dev.pr60.g150366e'); // running PR60
    registerInvokeHandler('list_dev_builds', () => BUILDS);
    registerInvokeHandler('switch_dev_build', () => null);
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText(/PR #61/)).toBeInTheDocument());
    expect(screen.getByText(/PR #60/)).toBeInTheDocument();
    expect(screen.getByText(/current/i)).toBeInTheDocument(); // PR60 marked current
    // Switch the non-current PR61:
    const switchBtn = await screen.findByRole('button', { name: /switch/i });
    await user.click(switchBtn);
    await waitFor(() => {
      const call = getInvokeCalls().find((c) => c.cmd === 'switch_dev_build');
      expect(call).toBeTruthy();
      expect(call!.args).toEqual({ manifestUrl: 'https://e/pr61/latest.json' });
    });
  });

  it('search filters the list by PR number', async () => {
    setMockAppVersion('1.6.1-dev.pr1.gdeadbee');
    registerInvokeHandler('list_dev_builds', () => BUILDS);
    const user = userEvent.setup();
    renderCard();
    await waitFor(() => expect(screen.getByText(/PR #61/)).toBeInTheDocument());
    await user.type(screen.getByRole('textbox', { name: /search/i }), '60');
    expect(screen.queryByText(/PR #61/)).not.toBeInTheDocument();
    expect(screen.getByText(/PR #60/)).toBeInTheDocument();
  });

  it('Downloads disclosure reveals per-platform links', async () => {
    setMockAppVersion('1.6.1-dev.pr1.gdeadbee');
    registerInvokeHandler('list_dev_builds', () => BUILDS);
    const user = userEvent.setup();
    renderCard();
    const rows = await screen.findAllByRole('listitem');
    const pr61row = rows.find((r) => within(r).queryByText(/PR #61/));
    if (!pr61row) throw new Error('PR #61 row not found');
    // Links are not visible until the disclosure is opened.
    expect(within(pr61row).queryByText('macOS')).not.toBeInTheDocument();
    await user.click(within(pr61row).getByText(/downloads/i));
    expect(within(pr61row).getByText('macOS')).toBeInTheDocument();
  });

  it('shows empty + error(+retry) states', async () => {
    setMockAppVersion('1.6.1-dev.pr1.gdeadbee');
    registerInvokeHandler('list_dev_builds', () => { throw new Error('rate limited'); });
    renderCard();
    await waitFor(() => expect(screen.getByText(/rate limited/i)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, confirm failures** — `npm test -- src/components/DevBuildsCard.test.tsx` (new contract not implemented).

- [ ] **Step 3: Rewrite `src/components/DevBuildsCard.tsx`:**

```tsx
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Search } from 'lucide-react';
import { Card } from './Card';
import { Button } from './Button';
import { useToast } from '../contexts/ToastContext';

interface DevBuildAsset { name: string; url: string; platform: string; }
interface DevBuild {
  pr: number;
  sha: string;
  title: string;
  published_at: string;
  windows_installer_url: string | null;
  manifest_url: string | null;
  assets: DevBuildAsset[];
}

/** Dev-build-only panel: list open PRs' dev builds and one-click switch the
 *  (Dev) slot between them. Rendered by Settings only on dev builds. */
export function DevBuildsCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const [builds, setBuilds] = useState<DevBuild[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentSha, setCurrentSha] = useState('');
  const [switchingPr, setSwitchingPr] = useState<number | null>(null);
  const [filter, setFilter] = useState('');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setBuilds(await invoke<DevBuild[]>('list_dev_builds'));
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
        if (m) setCurrentSha(m[1].toLowerCase());
      })
      .catch(() => {});
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filtered = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term || !builds) return builds ?? [];
    return builds.filter(
      (b) =>
        String(b.pr).includes(term) ||
        b.sha.toLowerCase().includes(term) ||
        b.title.toLowerCase().includes(term),
    );
  }, [builds, filter]);

  async function handleSwitch(b: DevBuild) {
    if (!b.manifest_url || switchingPr !== null) return;
    setSwitchingPr(b.pr);
    try {
      await invoke('switch_dev_build', { manifestUrl: b.manifest_url });
      toast.success(t('devBuilds.switching', { pr: b.pr }));
    } catch (e) {
      toast.error(t('devBuilds.switchFailed', { error: e instanceof Error ? e.message : String(e) }));
      setSwitchingPr(null);
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
          <Button variant="ghost" size="sm" onClick={load}>{t('devBuilds.retry')}</Button>
        </div>
      )}

      {!loading && !error && builds && builds.length > 0 && (
        <div className="gf-devbuilds-search">
          <Search size={14} style={{ color: 'var(--ink-dim)' }} />
          <input
            type="text"
            aria-label={t('devBuilds.search')}
            placeholder={t('devBuilds.search')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      )}

      {!loading && !error && builds?.length === 0 && <p>{t('devBuilds.empty')}</p>}
      {!loading && !error && builds && builds.length > 0 && filtered.length === 0 && (
        <p className="gf-dim">{t('devBuilds.noMatch')}</p>
      )}

      {!loading && !error && filtered.length > 0 && (
        <ul className="gf-devbuilds-list">
          {filtered.map((b) => {
            const isCurrent = b.sha !== '' && b.sha === currentSha;
            return (
              <li key={b.pr} className="gf-devbuilds-row">
                <div className="gf-devbuilds-meta">
                  <div className="gf-devbuilds-pr">
                    <strong>PR #{b.pr}</strong>
                    <span className="gf-dim"> · g{b.sha || '—'}</span>
                    {isCurrent && <span className="gf-badge gf-badge-current">{t('devBuilds.current')}</span>}
                  </div>
                  <div className="gf-dim gf-devbuilds-date" title={b.title}>
                    {new Date(b.published_at).toLocaleDateString()}
                  </div>
                </div>
                <div className="gf-devbuilds-actions">
                  {isCurrent ? (
                    <span className="gf-dim">{t('devBuilds.running')}</span>
                  ) : b.manifest_url ? (
                    <Button size="sm" disabled={switchingPr !== null} onClick={() => handleSwitch(b)}>
                      {switchingPr === b.pr ? t('devBuilds.switchingShort') : t('devBuilds.switchTo')}
                    </Button>
                  ) : (
                    <span className="gf-dim">{t('devBuilds.noWindowsBuild')}</span>
                  )}
                  <details className="gf-devbuilds-downloads">
                    <summary>{t('devBuilds.downloads')}</summary>
                    <div className="gf-devbuilds-dl-list">
                      {b.assets.map((a) => (
                        <button
                          key={a.name}
                          type="button"
                          className="gf-link-btn"
                          onClick={() => openUrl(a.url).catch(() => {})}
                        >
                          {a.platform}
                        </button>
                      ))}
                    </div>
                  </details>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && !error && (
        <p className="gf-dim gf-devbuilds-foot">{t('devBuilds.backToRelease')}</p>
      )}
    </Card>
  );
}
```

- [ ] **Step 4: Add CSS** to `src/styles.css` (replace the round-1 `.gf-devbuilds-*` block from the "Dev Builds panel" comment, and extend):

```css
/* Dev Builds panel (sub-project E). */
.gf-error { color: var(--danger); }
.gf-badge {
  display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 4px;
  background: var(--indigo-line); color: var(--ink-dim); margin-left: 6px; white-space: nowrap;
}
.gf-badge-current { background: var(--amber, #fbca04); color: #1a1a1a; }
.gf-devbuilds-search {
  display: flex; align-items: center; gap: 6px; margin: 8px 0;
  border: 1px solid var(--indigo-line); border-radius: 6px; padding: 4px 8px;
}
.gf-devbuilds-search input { flex: 1; background: transparent; border: 0; color: inherit; outline: none; }
.gf-devbuilds-list {
  list-style: none; padding: 0; margin: 8px 0;
  display: flex; flex-direction: column; gap: 6px;
  max-height: 320px; overflow-y: auto;
}
.gf-devbuilds-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 6px 8px; border: 1px solid var(--indigo-line); border-radius: 6px;
}
.gf-devbuilds-meta { min-width: 0; }
.gf-devbuilds-pr { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; }
.gf-devbuilds-date { font-size: 12px; }
.gf-devbuilds-actions { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.gf-devbuilds-downloads summary { cursor: pointer; color: var(--ink-dim); font-size: 12px; list-style: none; }
.gf-devbuilds-downloads summary::-webkit-details-marker { display: none; }
.gf-devbuilds-dl-list { display: flex; flex-direction: column; gap: 2px; padding: 4px 0; }
.gf-link-btn { background: transparent; border: 0; color: var(--indigo, #8ab4f8); cursor: pointer; text-align: left; padding: 2px 0; font-size: 12px; }
.gf-devbuilds-foot { margin-top: 10px; }
```

(If `--amber`/`--indigo` aren't defined custom properties, use the literal fallbacks shown or the nearest existing palette var — grep `styles.css` `:root` first.)

- [ ] **Step 5: Update i18n.** In `src/i18n/locales/en.json`'s `devBuilds` block, replace the `installing*`/`installFailed` keys with switch wording and add the new keys:

```json
  "devBuilds": {
    "title": "Dev Builds",
    "subtitle": "Switch the (Dev) app between open PRs' builds. Your release app is untouched.",
    "loading": "Loading dev builds…",
    "error": "Couldn't load dev builds: {{error}}",
    "retry": "Retry",
    "search": "Search by PR #, sha, or title",
    "empty": "No open dev builds — open a PR and label it dev-build.",
    "noMatch": "No dev builds match your search.",
    "current": "current",
    "running": "Running",
    "switchTo": "Switch to this build",
    "switchingShort": "Switching…",
    "switching": "Switching to PR #{{pr}} — the (Dev) app will swap and relaunch.",
    "switchFailed": "Switch failed: {{error}}",
    "downloads": "Downloads",
    "noWindowsBuild": "No Windows build (its build leg may have failed)",
    "backToRelease": "To return to the stable app, just launch your release STS2 Mod Manager — it's a separate, untouched install."
  }
```

In `src/i18n/locales/zh-Hans.json`, mirror the SAME keys with Simplified Chinese values (preserve `{{pr}}`/`{{error}}` tokens), replacing the old `devBuilds` block:

```json
  "devBuilds": {
    "title": "开发版本",
    "subtitle": "在各开放 PR 的版本之间切换（Dev）应用。你的正式版应用不受影响。",
    "loading": "正在加载开发版本…",
    "error": "无法加载开发版本：{{error}}",
    "retry": "重试",
    "search": "按 PR 编号、sha 或标题搜索",
    "empty": "暂无开放的开发版本——请新建 PR 并打上 dev-build 标签。",
    "noMatch": "没有匹配搜索的开发版本。",
    "current": "当前",
    "running": "运行中",
    "switchTo": "切换到此版本",
    "switchingShort": "正在切换…",
    "switching": "正在切换到 PR #{{pr}}——（Dev）应用将替换并重新启动。",
    "switchFailed": "切换失败：{{error}}",
    "downloads": "下载",
    "noWindowsBuild": "无 Windows 版本（其构建可能已失败）",
    "backToRelease": "要回到稳定版应用，只需启动你的正式版 STS2 Mod Manager——它是独立安装、不受影响的。"
  }
```

- [ ] **Step 6: Verify** — `npm test -- src/components/DevBuildsCard.test.tsx` (all pass) and `npm test -- src/i18n/locales/parity.test.ts` (no copied-English). If the i18n parity test flags any key, translate it.

- [ ] **Step 7: Commit**

```bash
git add src/components/DevBuildsCard.tsx src/components/DevBuildsCard.test.tsx src/styles.css src/i18n/locales/en.json src/i18n/locales/zh-Hans.json
git commit -m "$(cat <<'EOF'
feat(dev-builds): redesign DevBuildsCard — search, clean rows, one-click switch

Two-column rows with a non-wrapping CURRENT tag; per-platform links behind a
Downloads disclosure (was 5 always-on buttons); a search filter (PR#/sha/
title); scrollable list. Switch now calls the updater-driven switch_dev_build
with the build's manifest_url. i18n updated (en + zh-Hans).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: DEV title-bar badge

**Goal:** The dev app shows a small "DEV" badge in its custom title bar; the release app is unchanged.

**Files:**
- Modify: `src/App.tsx` (the `gf-titlebar` block + a state/effect for the gate)
- Modify: `src/App.test.tsx`
- Modify: `src/styles.css`
- Modify: `src/i18n/locales/en.json`, `src/i18n/locales/zh-Hans.json`

**Acceptance Criteria:**
- [ ] On a `-dev` version, a "DEV" badge renders in the title bar next to the title
- [ ] On a release version, no badge renders
- [ ] `npm test -- src/App.test.tsx` passes

**Verify:** `npm test -- src/App.test.tsx` → all pass

**Steps:**

- [ ] **Step 1: Add gate state in `src/App.tsx`.** `isDevBuild` is already imported (Task from round 1). Near the other `useState` declarations in the component, add:

```tsx
  const [isDev, setIsDev] = useState(false);
  useEffect(() => {
    isDevBuild().then(setIsDev).catch(() => {});
  }, []);
```

- [ ] **Step 2: Render the badge.** In the `gf-titlebar` block, change the title line to append the badge when `isDev`:

```tsx
          <span className="gf-titlebar-title" data-tauri-drag-region>{t('app.windowTitle')}</span>
          {isDev && <span className="gf-titlebar-dev" title="Development build">{t('app.devBadge')}</span>}
```

- [ ] **Step 3: CSS** in `src/styles.css`:

```css
.gf-titlebar-dev {
  margin-left: 8px; font-size: 10px; font-weight: 700; letter-spacing: 0.5px;
  padding: 1px 5px; border-radius: 3px; background: var(--amber, #fbca04); color: #1a1a1a;
}
```

- [ ] **Step 4: i18n.** Add `"devBadge": "DEV"` under the `app` section of BOTH `en.json` and `zh-Hans.json`. (`DEV` is a proper noun/acronym — identical in both locales is correct; if the parity test flags it, add `app.devBadge` to that test's `SAME_AS_ENGLISH_ALLOWED` set with a comment, since "DEV" is intentionally not translated.)

- [ ] **Step 5: Test** in `src/App.test.tsx`:

```tsx
  it('shows a DEV titlebar badge on a dev build', async () => {
    const { setMockAppVersion } = await import('./__test__/setup');
    setMockAppVersion('1.6.1-dev.pr60.g150366e');
    render(<App />);
    await waitFor(() => expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument());
    expect(screen.getByText('DEV')).toBeInTheDocument();
  });

  it('shows no DEV titlebar badge on a release build', async () => {
    const { setMockAppVersion } = await import('./__test__/setup');
    setMockAppVersion('1.6.1');
    render(<App />);
    await waitFor(() => expect(screen.getByText('STS2 Mod Manager')).toBeInTheDocument());
    expect(screen.queryByText('DEV')).not.toBeInTheDocument();
  });
```

(`resetTauriMocks` resets the mock version between tests.)

- [ ] **Step 6: Verify + commit** — `npm test -- src/App.test.tsx` (pass):

```bash
git add src/App.tsx src/App.test.tsx src/styles.css src/i18n/locales/en.json src/i18n/locales/zh-Hans.json
git commit -m "$(cat <<'EOF'
feat(dev-builds): DEV badge in the title bar on dev builds

When the running version contains -dev, the custom titlebar shows a small
amber DEV badge so the dev app is visually distinct from the release app.
Release builds are unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: DEV-badged Windows icon (build-time)

**Goal:** Dev builds get a DEV-badged Windows icon (`.ico` + the runtime PNG sizes) so the taskbar/desktop icon is visibly different; generated on the runner during the dev stamp step, never committed.

**Files:**
- Create: `scripts/make-dev-icon.mjs`, `scripts/make-dev-icon.test.mjs`
- Modify: `package.json` (add `jimp` + `png-to-ico` devDependencies)
- Modify: `.github/workflows/build.yml` (run the badger in the dev stamp step; run its test in the check job)

**Acceptance Criteria:**
- [ ] `badgeIcons(iconDir)` reads `32x32.png`, `128x128.png`, `128x128@2x.png`, composites a "DEV" badge, overwrites those PNGs, and rebuilds `icon.ico` from them
- [ ] Running it twice is idempotent (re-badging an already-badged icon doesn't error)
- [ ] A missing source PNG is skipped with a warning, not a crash
- [ ] The dev stamp step runs it only for labeled-PR dev builds (after `--stamp`)
- [ ] `node --test scripts/make-dev-icon.test.mjs` passes; `build.yml` parses

**Verify:** `node --test scripts/make-dev-icon.test.mjs` → pass; `python -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml')); print('OK')"` → `OK`

**Steps:**

- [ ] **Step 1: Add deps** — `npm install --save-dev jimp png-to-ico` (both pure-JS, no native build; safe on windows-latest). Confirm they land in `package.json` devDependencies and `package-lock.json` updates.

- [ ] **Step 2: Write the failing test** `scripts/make-dev-icon.test.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { badgeIcons } from './make-dev-icon.mjs';

async function writePng(path, size) {
  const img = new Jimp({ width: size, height: size, color: 0x3366ffff });
  await img.write(path);
}

test('badgeIcons rewrites the windows PNGs and (re)builds icon.ico', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devicon-'));
  try {
    await writePng(join(dir, '32x32.png'), 32);
    await writePng(join(dir, '128x128.png'), 128);
    await writePng(join(dir, '128x128@2x.png'), 256);
    const before = statSync(join(dir, '128x128.png')).size;

    await badgeIcons(dir);

    // icon.ico produced; PNGs still present and changed (badge composited).
    assert.ok(existsSync(join(dir, 'icon.ico')), 'icon.ico written');
    assert.ok(readFileSync(join(dir, 'icon.ico')).length > 0, 'icon.ico non-empty');
    assert.notEqual(statSync(join(dir, '128x128.png')).size, before, '128 png changed by badge');

    // Idempotent: a second run does not throw.
    await badgeIcons(dir);
    assert.ok(existsSync(join(dir, 'icon.ico')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('badgeIcons skips a missing source png without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devicon-'));
  try {
    await writePng(join(dir, '32x32.png'), 32); // only one present
    await badgeIcons(dir); // must not throw
    assert.ok(existsSync(join(dir, 'icon.ico')), 'ico built from whatever pngs exist');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run, confirm failure** — `node --test scripts/make-dev-icon.test.mjs`.

- [ ] **Step 4: Implement `scripts/make-dev-icon.mjs`:**

```js
// scripts/make-dev-icon.mjs
// Composite a "DEV" badge onto the Windows runtime icons so dev builds are
// visually distinct. Run on the CI runner during the dev stamp step; never
// committed. Pure-JS (jimp + png-to-ico) — no native build, runs on
// windows-latest. Windows-only scope: macOS .icns is left untouched.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jimp, loadFont } from 'jimp';
import { SANS_32_WHITE } from 'jimp/fonts';
import pngToIco from 'png-to-ico';

const WIN_PNGS = ['32x32.png', '128x128.png', '128x128@2x.png'];

/** Composite a red "DEV" ribbon across the bottom of one image. */
async function badgeOne(path, font) {
  const img = await Jimp.read(path);
  const w = img.bitmap.width, h = img.bitmap.height;
  const band = Math.max(8, Math.round(h * 0.34));
  // Solid red band across the bottom.
  const red = new Jimp({ width: w, height: band, color: 0xd33232ff });
  img.composite(red, 0, h - band);
  // "DEV" text centered in the band (only legible at >=128; harmless at 32).
  if (w >= 64) {
    img.print({ font, x: 0, y: h - band, text: { text: 'DEV', alignmentX: 'center', alignmentY: 'middle' }, maxWidth: w, maxHeight: band });
  }
  await img.write(path);
}

/** Badge the Windows PNGs in `iconDir` and (re)build icon.ico from them. */
export async function badgeIcons(iconDir) {
  const font = await loadFont(SANS_32_WHITE);
  const present = [];
  for (const name of WIN_PNGS) {
    const p = join(iconDir, name);
    if (!existsSync(p)) { console.warn(`make-dev-icon: ${name} missing, skipping`); continue; }
    await badgeOne(p, font);
    present.push(p);
  }
  if (present.length === 0) { console.warn('make-dev-icon: no source PNGs found'); return; }
  // Build a multi-resolution .ico from the badged PNGs.
  const ico = await pngToIco(present);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(iconDir, 'icon.ico'), ico);
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  badgeIcons(process.argv[2] || 'src-tauri/icons').catch((e) => {
    console.error('make-dev-icon failed:', e);
    process.exit(1);
  });
}
```

NOTE for the implementer: confirm the exact jimp v1 API (`Jimp.read`, `new Jimp({width,height,color})`, `img.composite`, `img.print({...})`, `loadFont`/`SANS_32_WHITE` import path from `jimp/fonts`). jimp's major versions differ (v0 used `Jimp.read` + `Jimp.FONT_SANS_*` constants + `img.print(font,x,y,text)`); match whatever `npm install jimp` pulled. The TEST and the implementation must use the same API — adjust both together so the test genuinely drives the code. Keep `png-to-ico`'s call (`pngToIco(arrayOfPaths) -> Buffer`).

- [ ] **Step 5: Wire into the dev stamp step.** In `.github/workflows/build.yml`, the dev stamp step currently ends with `DEV_SHORT_SHA="$SHORT" node scripts/dev-build-stamp.mjs --stamp`. Append the icon badger (Windows leg only, so it doesn't run on mac/linux legs):

```yaml
        run: |
          SHORT=$(printf '%s' "$DEV_HEAD_SHA" | cut -c1-7)
          DEV_SHORT_SHA="$SHORT" node scripts/dev-build-stamp.mjs --stamp
          if [ "$RUNNER_OS" = "Windows" ]; then
            node scripts/make-dev-icon.mjs src-tauri/icons || echo "DEV icon badge failed (non-fatal)."
          fi
```

(`make-dev-icon.mjs` needs `jimp`/`png-to-ico`, which are installed by the `npm ci` step that runs before this. The stamp step runs after `npm ci`, so the deps are present.)

- [ ] **Step 6: Run the icon test in CI's check job.** After the `Test dev-build-stamp script` step in the `check` job, add:

```yaml
      - name: Test make-dev-icon script
        run: node --test scripts/make-dev-icon.test.mjs
```

- [ ] **Step 7: Verify** — `node --test scripts/make-dev-icon.test.mjs` (pass); `python -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml')); print('OK')"` (`OK`).

- [ ] **Step 8: Commit**

```bash
git add scripts/make-dev-icon.mjs scripts/make-dev-icon.test.mjs package.json package-lock.json .github/workflows/build.yml
git commit -m "$(cat <<'EOF'
feat(dev-builds): DEV-badge the Windows icon at build time

make-dev-icon.mjs composites a red DEV band onto the Windows runtime PNGs and
rebuilds icon.ico (pure-JS jimp + png-to-ico). The dev stamp step runs it on
the Windows leg so the dev app's taskbar/desktop icon is visibly different;
never committed, release icons untouched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Manual Windows end-to-end verification (USER GATE)

**Goal:** Prove on Windows that the refined switcher works: a clean, searchable Dev Builds list; a true one-click **Switch** that silently swaps + relaunches into the chosen build (no installer UI); the dev app shows a DEV title-bar badge and a DEV-badged taskbar/desktop icon; data stays isolated; the release app is untouched.

**USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:** None (operational verification on the maintainer's Windows machine).

**Acceptance Criteria:**
- [ ] Settings → Advanced → Dev Builds shows a clean, aligned list (no wrapped/cramped rows), newest PR first, with a working search filter and per-platform links behind a Downloads disclosure
- [ ] Clicking **Switch** on a non-current PR performs a one-click switch — no installer UI — that silently downloads, swaps, and relaunches into the chosen build (running version's PR/`g<sha>` changes to the target)
- [ ] After the switch the (Dev) app still uses `%APPDATA%\sts2-mod-manager-dev\`; the release `%APPDATA%\sts2-mod-manager\` is untouched
- [ ] The dev app shows a **DEV** badge in its title bar and a DEV-badged taskbar/desktop icon (distinct from the release app)
- [ ] On a release build: no Dev Builds section, no DEV badge, normal update behavior

**Verify:** (manual, Windows) From a dev build, switch PR↔PR with one click and observe the silent swap + relaunch (version changes); `Test-Path "$env:APPDATA\sts2-mod-manager-dev"` → `True`, release dir unchanged; the DEV title-bar badge + DEV taskbar icon are visible. If the updater-driven switch can't be made seamless, fall back to the round-1 silent-NSIS path and re-verify.

**Steps:**
- [ ] **Step 1:** Ensure two `dev-pr<N>` prereleases exist that contain these refinements (the coordinator pushes the branch + labels PRs; their builds must include this round's commits + the `latest.json` manifest).
- [ ] **Step 2:** Install one dev build; open Settings → Advanced → Dev Builds. Confirm clean layout, search works, Downloads discloses links, running build marked current.
- [ ] **Step 3:** Click **Switch** on the other PR. Confirm: no installer window, a brief "Switching…", then the app relaunches into the target build (version footer changes).
- [ ] **Step 4:** Confirm isolation (`Test-Path "$env:APPDATA\sts2-mod-manager-dev"` → True; release dir untouched) and the DEV title-bar badge + DEV taskbar icon.
- [ ] **Step 5:** Launch the release app; confirm no Dev Builds section, no DEV badge, normal behavior.

No commit (verification only).

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| List redesign (clean rows, non-wrapping CURRENT tag) | Task 3 |
| Search + newest-first + scroll | Task 3 |
| Downloads disclosure (vs 5 buttons) | Task 3 |
| One-click switch: updater-driven `switch_dev_build` + permissive comparator | Task 1 |
| `DevBuild.manifest_url` surfaced | Task 1 |
| Remove `install_dev_build` | Task 1 |
| CI: attach `.sig` + assemble dev `latest.json` (reuse publish-updater.sh w/ version override) | Task 2 |
| DEV title-bar badge | Task 4 |
| DEV Windows icon (build-time) | Task 5 |
| zh-Hans translations / parity | Tasks 3, 4 |
| Manual Windows gate (one-click switch, DEV badge+icon, isolation) | Task 6 |
| Release app + tag path untouched | Tasks 1,2,5 (scoped) |

All spec requirements covered. No placeholders (the two flagged unknowns — the exact `tauri-plugin-updater` v2 API in Task 1 and the exact `jimp` v1 API in Task 5 — carry concrete known-good shapes + an instruction to reconcile test↔impl against the installed version, mirroring how round-1 handled the NSIS unknown; both are verified by tests/the gate).

**Type/name consistency:** `manifest_url` (Rust snake_case) ↔ `manifest_url` (TS interface) ↔ `manifestUrl` (JS invoke arg → Tauri maps to Rust `manifest_url` param) — consistent across Tasks 1 & 3. `switch_dev_build` command name consistent (Task 1 register, Task 3 invoke). `badgeIcons(iconDir)` consistent across Task 5 impl + test. i18n keys (`devBuilds.switching`, `.switchTo`, `.downloads`, `.search`, `.running`, `.noMatch`, `app.devBadge`) consistent across Task 3/4 usage + locale files.

---

## Acknowledgements

Plan + specs live on `claude/build-switcher` (PR #60). Round-1 (E) is implemented + reviewed on this branch; this round-2 plan layers on top. The two runtime unknowns (updater install/relaunch behavior; jimp API) are isolated to one task each and proven in the manual gate (Task 6), with documented fallbacks.
