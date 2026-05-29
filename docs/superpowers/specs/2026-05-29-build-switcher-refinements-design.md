# Build switcher refinements (sub-project E, round 2) — Design

**Status:** Approved (brainstorm 2026-05-29)
**Refines:** [`2026-05-28-build-switcher-design.md`](./2026-05-28-build-switcher-design.md) — E round 1 (list + switch + isolation + gating), implemented on `claude/build-switcher` (PR #60).
**Depends on:** sub-project D (per-PR dev builds, shipped) + E round 1.

## Why

The E round-1 manual gate (running the dev build on Windows) surfaced real UX problems that automated checks couldn't:

1. **The Dev Builds panel is misaligned and won't scale.** The info column is crushed against 6 always-visible buttons (Switch + 5 platform links); the "current" badge is a wide pill that wraps into a tall box. With many open PRs it would be unusable.
2. **Switching forces the NSIS installer UI every time.** Round 1's `install_dev_build` downloads the `-setup.exe` and runs it interactively — the user must click through the installer on every switch. The requirement is a **one-click switch**: click → silent swap → relaunch, no installer UI.
3. **The dev app isn't visually distinct from the release app.** Same window-title text and same icon; easy to confuse the two while testing.

## Decisions (from brainstorm)

- **Switch mechanism: updater-driven.** Reuse `tauri-plugin-updater` — the same silent download → verify-signature → install → relaunch path the release app's "Install & Restart" already uses. Requires a small CI addition to sub-project D (publish a per-build update manifest). Chosen over silently running the NSIS `.exe` (`/S`), which the round-1 spec flagged as an unverified relaunch risk.
- **DEV icon scope: Windows only.** Generate a DEV-badged Windows icon (`.ico` + runtime PNG sizes) at build time; macOS/Linux dev icons stay un-badged (the maintainer only runs dev builds on Windows).
- **DEV title-bar badge:** always added on dev builds (cheap, unambiguous).
- **List: search + newest-first + scroll**, no "show more" pagination (YAGNI for a maintainer's handful of open PRs).

---

## A. Dev Builds list — redesign + search + scale

**File:** `src/components/DevBuildsCard.tsx` (+ `src/styles.css`, + i18n).

- **Row layout (two-column flex, no width pressure):**
  - **Left:** `PR #<N>` (bold) · `g<sha>` · localized date; a short inline **CURRENT** tag (not the long wrapping pill) when `b.sha === currentSha`.
  - **Right:** a single primary **Switch** button (replaced by a muted "Running" label when current), plus a compact **Downloads ▾** disclosure (a `<details>`/toggle) that reveals the per-platform links *on demand* — instead of 5 always-visible buttons. This is what fixes the alignment/scale.
- **Search:** a filter input at the top of the card (reuse the Mods view's established pattern — `const [filter, setFilter] = useState('')` + a `useMemo` filtered list). Match case-insensitively on PR number, sha, and title.
- **Newest-first:** the Rust side already returns builds sorted newest-PR-first; the card preserves that order. A small "newest first" hint label.
- **Scale:** the list renders inside a fixed-`max-height` scroll container (`overflow-y: auto`). Search + scroll handle arbitrarily many open PRs.
- **States** (unchanged from round 1, restyled): loading, empty, error+retry, no-Windows-build note.

**CSS:** rework `.gf-devbuilds-row` to a clean `align-items: center` two-column grid/flex; make `.gf-badge` (the CURRENT tag) `white-space: nowrap` and small so it never wraps; add `.gf-devbuilds-list` `max-height` + `overflow-y: auto`; style the Downloads disclosure.

**Tests:** update `DevBuildsCard.test.tsx` — search filters the list (type a PR# → only matching rows), the Downloads disclosure reveals platform links, CURRENT tag renders for the running build, Switch invokes the new switch command (see B). Keep loud assertions, no silent-skip.

---

## B. One-click switch — updater-driven

Replace round 1's "download setup.exe + run installer" with the proven silent updater path.

### B1. CI: publish a per-build update manifest (sub-project D change)

`tauri.conf.json` already has `createUpdaterArtifacts: true`, so every build (incl. dev) produces the updater `.sig` files. Two changes in `.github/workflows/build.yml`'s dev path:

1. **Attach the `.sig` artifacts to the `dev-pr<N>` prerelease.** The `publish-dev` job's artifact-collection `find` currently gathers `*.exe *.msi *.dmg *.deb *.rpm *.AppImage *_portable.zip` — add `*.sig` so the signatures reach the release (the updater needs them).
2. **Assemble a `latest.json` for the dev release.** Reuse the existing `scripts/publish-updater.sh` (which builds `latest.json` from the `.sig` files on a release) — extend it with an **optional 3rd arg `version_override`** so the dev manifest carries the real stamped version (e.g. `1.6.1-dev.pr60.g150366e`) rather than the tag-derived `dev-pr60` (which is not valid SemVer and would break the updater). After `gh release create`, `publish-dev` calls:
   ```
   bash scripts/publish-updater.sh "dev-pr<N>" "$REPO" "<stampedDevVersion>"
   ```
   This uploads `latest.json` onto the `dev-pr<N>` release alongside the assets.

`publish-updater.sh` change (surgical): accept `VERSION_OVERRIDE="${3:-}"` and use it for the `version` field when set, else keep `VERSION="${TAG#v}"`. Release behavior unchanged (it never passes the 3rd arg).

### B2. Rust: a `switch_dev_build` command

A new `#[tauri::command] switch_dev_build(manifest_url: String)` in `dev_builds.rs`:

- Build an updater pointed at that build's manifest and install it, reusing the app's configured pubkey:
  ```rust
  let update = app
      .updater_builder()
      .endpoints(vec![Url::parse(&manifest_url).map_err(…)?])?
      .version_comparator(|_current, _update| true) // explicit switch: always install (allows "downgrade" to a lower PR)
      .build()
      .map_err(…)?
      .check()
      .await
      .map_err(…)?;
  match update {
      Some(u) => { u.download_and_install(|_,_| {}, || {}).await.map_err(…)?; Ok(()) }
      None => Err("No installable update found in the dev build manifest".into()),
  }
  ```
  (Exact API per `tauri-plugin-updater` v2; the implementer confirms signatures during the task. The `app: tauri::AppHandle` comes in as a command arg.)
- **Why `version_comparator` always-true:** SemVer ranks `…pr61… > …pr60…`, so a default updater refuses switching to a *lower* PR ("not newer"). An explicit user-chosen switch must install regardless of ordering — both directions.
- After `download_and_install`, relaunch via `tauri_plugin_process` (mirror the release flow: the JS side calls `relaunch()`), or rely on the NSIS updater's own relaunch — the implementer verifies which, matching how the release "Install & Restart" relaunches today.
- **On Windows NSIS this runs the installer in passive/silent mode** (the same behavior the release self-update already gives) — no installer UI, which is the whole point.

### B3. Frontend wiring

- `DevBuildsCard`'s **Switch** calls `invoke('switch_dev_build', { manifestUrl })`. The manifest URL is derived from the build's release: `https://github.com/MohamedSerhan/sts2-mod-manager/releases/download/dev-pr<N>/latest.json`. To supply it, extend the Rust `DevBuild` with a `manifest_url: Option<String>` (set when a `latest.json` asset is present on the release), so the frontend doesn't hardcode URL construction. Switch is disabled when `manifest_url` is absent (older build, or manifest not yet attached).
- Round 1's `install_dev_build` (interactive) is **removed** along with its registration. The portable `.zip` remains available via the Downloads disclosure as a manual no-install fallback.

**Tests (Rust):** `parse_dev_builds` now also surfaces `manifest_url` from a `latest.json` asset — add an assertion. (`switch_dev_build` itself drives the OS installer, so it's covered by the manual gate, not a unit test — same boundary as round 1's `install_dev_build`.)

---

## C. DEV title-bar badge

**File:** `src/App.tsx` (the `gf-titlebar` block), `src/styles.css`, i18n.

- Resolve `isDevBuild()` into state on mount (App already imports `isDevBuild`). When true, render a small amber **DEV** badge (`.gf-titlebar-dev`) next to `gf-titlebar-title`. Release builds: nothing rendered (byte-unchanged).
- **Test:** App renders the DEV badge on a `-dev` version, not on a release version.

---

## D. DEV Windows icon (build-time generated)

**Files:** a new `scripts/make-dev-icon.mjs`; the dev stamp step in `.github/workflows/build.yml`.

- At build time, during the dev stamp step (which already rewrites `tauri.conf.json` for dev), generate DEV-badged copies of the **Windows runtime icons** — `src-tauri/icons/icon.ico` and the PNG sizes Windows uses (`32x32.png`, `128x128.png`, `128x128@2x.png`) — by compositing a "DEV" ribbon/text onto the existing icon, overwriting them in place on the runner (never committed). macOS `.icns` / Linux PNGs are left untouched (Windows-only scope).
- **Generation mechanism:** a small Node script using an image lib. Prefer `sharp` if available in the toolchain; otherwise compose via an SVG overlay rasterized with `sharp`. The script is invoked only on the dev-stamp path (labeled-PR builds), so release icons are never altered. **Implementation note / risk:** if no image lib is reasonably available on the CI runner without heavy setup, fall back to committing a pre-made `src-tauri/icons/dev/` set and having the dev stamp point `tauri.conf.json`'s `icon` array at them. The plan's task will pick the concrete path after checking what's installable; the *outcome* (dev Windows icon visibly badged) is fixed.
- **Test:** `make-dev-icon.mjs` has a unit test for its pure parts (e.g. it writes the expected output files given an input dir); the visual result is confirmed in the manual gate.

---

## What stays the same (from round 1)

- Dev-build-only gating via `isDevBuild()` (Settings card + update-nag suppression).
- Data isolation (`sts2-mod-manager-dev`), the `list_dev_builds` discovery command, the `dev-pr<N>` rolling prerelease + sticky comment, cleanup on PR close.
- Release app and the release/tag CI path: untouched.

## Non-goals

- No macOS/Linux dev icon badging.
- No "show more" pagination (search + scroll suffices).
- No auto-switching / dev auto-update channel (switching stays explicit + user-initiated).
- No change to how the first dev build is bootstrapped (PR sticky comment).

## Testing strategy (overall)

- **Rust:** `parse_dev_builds` surfaces `manifest_url`; existing parse tests stay green. `make-dev-icon`/manifest logic unit-tested where pure.
- **Frontend (vitest):** DevBuildsCard search-filters, Downloads disclosure, CURRENT tag, Switch → `switch_dev_build`; titlebar DEV badge gated on `-dev`. Loud assertions, no silent-skip.
- **CI:** `build.yml` + `dev-build-cleanup.yml` still parse; `publish-updater.sh` release behavior unchanged with the new optional arg.
- **Manual Windows gate (user-ordered, carries from round 1):** from a dev build, Settings → Dev Builds → one-click **Switch** to another PR → it silently swaps + relaunches into the chosen build (no installer UI), still on isolated `sts2-mod-manager-dev` data; the dev app shows the DEV title-bar badge and a DEV-badged taskbar/desktop icon; the release app is untouched.

## File map (for the plan)

**Create:**
- `scripts/make-dev-icon.mjs` (+ test) — DEV-badge the Windows icons at build time

**Modify:**
- `src/components/DevBuildsCard.tsx` (+ `.test.tsx`) — row redesign, search, Downloads disclosure, Switch → `switch_dev_build`
- `src/styles.css` — row/badge/list/disclosure styling
- `src/App.tsx` (+ `.test.tsx`) — DEV title-bar badge on dev builds
- `src-tauri/src/dev_builds.rs` — add `switch_dev_build`; `DevBuild.manifest_url`; surface it in `parse_dev_builds`; remove `install_dev_build`
- `src-tauri/src/lib.rs` — register `switch_dev_build`, unregister `install_dev_build`
- `.github/workflows/build.yml` — publish-dev: attach `*.sig`, assemble dev `latest.json`; dev stamp step: generate DEV Windows icon
- `scripts/publish-updater.sh` — optional `version_override` 3rd arg
- `src/i18n/locales/{en,zh-Hans}.json` — new strings (search placeholder, Downloads, DEV badge), translated zh-Hans
