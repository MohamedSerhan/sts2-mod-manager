# Per-PR dev builds

Produce installable, version-stamped, data-isolated dev builds for any pull request the maintainer opts into — so changes can be tested in the real app (Windows / macOS / Linux) before merge, without touching the release install's settings, modpacks, profiles, or mod library.

Sub-project **D** of the five-part roadmap (A=Nexus triage [shipped], **D=per-PR dev builds**, E=build switcher, C=auto-fix bot, B=Nexus reply drafts). E consumes D's output, so D's delivery mechanism is chosen with E in mind.

## Goals

- **Opt-in dev builds per PR.** Adding a `dev-build` label to a PR builds all three platforms and publishes installable bundles; pushing more commits to a labeled PR rebuilds.
- **Self-isolating dev data.** A dev build never reads or writes the release app's data dir. Its settings, modpacks, profiles, `mod_sources.json`, cache, and logs live under a separate `sts2-mod-manager-dev/` directory — automatically, regardless of how the build is launched.
- **Persistent, easy-to-fetch delivery.** Builds land as a per-PR prerelease with public direct-download URLs (no auth, no unzip, no expiry) so the maintainer can grab them and a future E (build switcher) can list/download them trivially.
- **Distinct identity.** Every dev build carries a version like `1.6.1-dev.pr42.ga1b2c3d` and a distinct install identity (`com.sts2mm.app.dev` / "STS2 Mod Manager (Dev)") so it's never confused with release, installs *alongside* release rather than over it, and E can display/compare versions.
- **Release path untouched.** Tag builds and the existing release flow behave exactly as before; dev builds are purely additive.

## Out of scope

- **Game-directory isolation.** The dev build auto-detects / points at the real Steam game's `mods` + `disabled_mods` folders (the maintainer accepts this — Steam "Verify integrity of game files" is the recovery path). D isolates only the *app's own* bookkeeping, not the game install. No game-copy management.
- **Keyring isolation.** Stored GitHub + Nexus tokens are shared between dev and release (credentials, not "mods/data"; re-entering them per dev build is friction with no real benefit).
- **Windows Authenticode signing.** Dev builds are minisign-signed like release (for updater parity), but SmartScreen "unknown publisher" still appears on first launch — same as release. Click through for personal testing.
- **The build switcher itself** (sub-project E). D only produces + publishes builds; installing/swapping/launching them is E.
- **Auto-merge or auto-release.** Dev builds are for testing; releases stay manual (tag-driven).

## Architecture

All CI changes extend `.github/workflows/build.yml` plus one new cleanup workflow. The data-isolation change is a ~5-line edit to two Rust files.

```
PR labeled `dev-build`  ── or ──  push to a PR that already has the label
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ build.yml — build job (existing matrix: windows / macos / ubuntu)      │
│   gate widened: tags || workflow_dispatch ||                           │
│     (pull_request && contains(labels.*.name, 'dev-build'))             │
│                                                                        │
│   per leg, NEW step BEFORE tauri-action (dev builds only):             │
│     └─ node scripts/dev-build-stamp.mjs --stamp                        │
│        rewrites version → 1.6.1-dev.pr<N>.g<shortsha> in               │
│        src-tauri/tauri.conf.json + src-tauri/Cargo.toml (runner only)  │
│   tauri-action builds signed bundles (unchanged)                       │
│   existing "Upload build artifacts" step captures them (unchanged)     │
└────────────────────────────┬──────────────────────────────────────────┘
                             │ (all 3 legs finish)
                             ▼
┌───────────────────────────────────────────────────────────────────────┐
│ publish-dev job (NEW; runs only for PR dev builds)                     │
│   - download all 3 platforms' artifacts                                │
│   - create-or-update prerelease tag `dev-pr<N>`                        │
│       prerelease: true, title "Dev build — PR #<N> (g<shortsha>)"      │
│       replace assets with the fresh bundles                            │
│   - upsert sticky PR comment (hidden marker) with per-platform         │
│     download links + stamped version + source commit + isolation note  │
└───────────────────────────────────────────────────────────────────────┘

PR closed / merged
        │
        ▼
┌───────────────────────────────────────────────────────────────────────┐
│ dev-build-cleanup.yml (NEW)                                            │
│   on pull_request: closed → delete release `dev-pr<N>` + its tag       │
└───────────────────────────────────────────────────────────────────────┘
```

## Files

| Path | Action | Purpose |
|---|---|---|
| `.github/workflows/build.yml` | modify | Widen `build` gate to labeled PRs; add version-stamp step to each matrix leg; add `publish-dev` job |
| `.github/workflows/dev-build-cleanup.yml` | create | Delete the dev prerelease + tag when the PR closes |
| `scripts/dev-build-stamp.mjs` | create | `computeDevVersion`, `stampFiles`, `renderDevComment` — pure logic + file rewrite, called by the workflow |
| `scripts/dev-build-stamp.test.mjs` | create | `node --test` coverage for the pure functions |
| `src-tauri/src/state.rs` | modify | Add `app_dir_name()` helper; use it for `config_path` + `cache_path` |
| `src-tauri/src/lib.rs` | modify | Use `app_dir_name()` for the logging/config dir |

**Redesign-branch note:** D touches `src-tauri/src/lib.rs` + `state.rs`, which the in-flight 1.7.0 redesign (`happy-lovelace-2ad8bc`) may also touch. The change is a one-helper + three-call-site swap, so any merge conflict is trivial — but D is no longer perfectly zero-overlap with the redesign (it was for sub-project A). Accepted by the maintainer.

## Data isolation

The app currently hardcodes its data-dir name as the literal `"sts2-mod-manager"` in two places:
- `lib.rs:82` — `dirs::config_dir().join("sts2-mod-manager")` (logging + startup banner)
- `state.rs:142` / `state.rs:151` — `config_path` (settings, `mod_sources.json`, profiles/modpacks) and `cache_path`

It already honors `STS2_CONFIG_DIR` / `STS2_CACHE_DIR` env overrides (QA-harness escape hatch) which take precedence and are unchanged.

**The change** — a version-driven helper in `state.rs`:

```rust
/// Data-dir name. Dev builds (version contains "-dev") use a separate dir so
/// testing never touches the release app's settings / modpacks / profiles /
/// mod_sources / cache / logs. Release builds are unaffected.
pub fn app_dir_name() -> &'static str {
    if env!("CARGO_PKG_VERSION").contains("-dev") {
        "sts2-mod-manager-dev"
    } else {
        "sts2-mod-manager"
    }
}
```

Then replace the three `.join("sts2-mod-manager")` sites with `.join(app_dir_name())` (`lib.rs` calls `crate::state::app_dir_name()`).

**Why this works:** the version stamp (which dev builds already get) sets `CARGO_PKG_VERSION` to `…-dev.…`, so `app_dir_name()` returns the `-dev` dir at compile time. No launcher wrapper, no env-var dependency, no runtime config — isolation holds however the build is launched, including before E exists.

**Scope of protection:**
- **Isolated:** the app's own data — settings, configured game path, `mod_sources.json`, profiles/modpacks, mod-library bookkeeping, cache, logs.
- **Not isolated (intentional):** the game's `mods` / `disabled_mods` folders. A dev build starts with blank settings, auto-detects the same Steam game, and operates on the real mod folders. The maintainer accepts this (Steam file verification is the recovery path). The isolation guarantees the dev build won't *corrupt the release app's library/modpack records* — only the live game folders are shared.
- **Shared (intentional):** keyring (GitHub + Nexus tokens).

**Install isolation — distinct dev identity.** Dev builds are stamped with a distinct bundle identifier (`com.sts2mm.app.dev`) and product name (`STS2 Mod Manager (Dev)`). This makes the `.msi`/NSIS dev installers install as a **separate app alongside** the release install — own Start-menu entry, own install dir — so installing a dev build never touches the release app. All dev builds share the *one* `.dev` identity (not per-PR), so installing dev-pr43 upgrades the dev-pr42 install in place: you get **release + one installed dev build** coexisting, and switching installed dev builds is a reinstall. For multiple dev builds available simultaneously, the portable `.exe` still works (run any number from folders). E can drive either path. Data isolation is independent of this — `app_dir_name()` (version-driven) gives every dev build the `sts2-mod-manager-dev` data dir regardless of identifier.

**`nxm://` handler tradeoff.** Because the dev build is now a distinct installed app, while it's installed it may register as the system `nxm://` "Download with Manager" handler, taking it from the release install. This is non-destructive and self-correcting — relaunching (or reinstalling) the release app reclaims the handler. Accepted by the maintainer.

**Self-updater nag (known, harmless).** The app runs `@tauri-apps/plugin-updater`'s `check()` on launch (frontend). A dev build's version (`1.6.1-dev.pr42.g…`) is a *pre-release* of `1.6.1`, so SemVer ranks it **below** the published `1.6.1` release — the updater will show an "update available" banner offering to "upgrade" the dev build to release. This is harmless: the offered artifact has the *release* identifier (`com.sts2mm.app`), so accepting it (re)installs release as its own separate app — it does not replace the dev build or touch the `sts2-mod-manager-dev` data. We document this as expected behavior. **Not** suppressing it in D, to avoid touching `src/App.tsx` (the redesign branch's most-edited file). If the banner proves annoying, a 2-line follow-up guard (skip `check()` when the running version contains `-dev`) is the fix — deferred.

## Version + identity stamping

`scripts/dev-build-stamp.mjs --stamp` (run per build leg, dev builds only):

1. Read base version from `src-tauri/tauri.conf.json` (`"version"`).
2. Compute `computeDevVersion(base, prNumber, shortSha)` → `${base}-dev.pr${pr}.g${sha}`.
   - The `g` prefix on the sha guarantees a valid SemVer pre-release identifier even when a short sha is all-digits with a leading zero (git-describe convention). Cargo + Tauri both reject invalid SemVer, so this matters.
3. `stampFiles(version)` rewrites, runner-only (never committed — the runner's checkout is throwaway and the build job doesn't push):
   - `src-tauri/tauri.conf.json`: `"version"` → stamped version; `"identifier"` `com.sts2mm.app` → `com.sts2mm.app.dev`; `"productName"` `STS2 Mod Manager` → `STS2 Mod Manager (Dev)`.
   - `src-tauri/Cargo.toml`: `version = "…"` under `[package]` → stamped version (drives `CARGO_PKG_VERSION`, which `app_dir_name()` reads for data isolation).

Inputs come from the workflow: `${{ github.event.pull_request.number }}` and the short SHA of the PR head.

The version stamp drives four things at once: the in-app version display, the artifact/installer filenames, the `-dev` data isolation (`app_dir_name()`), and the distinct install identity (`.dev` identifier + "(Dev)" name).

## Delivery

**`publish-dev` job** (after the build matrix, gated to PR dev builds):

1. `actions/download-artifact` for all three `binaries-*` artifacts.
2. Create-or-update the prerelease:
   - Tag `dev-pr<N>` (stable per PR; reused across pushes so there's one rolling dev release per open PR).
   - `prerelease: true` — keeps it out of "Latest", so the in-app updater + users never see dev builds.
   - Title `Dev build — PR #<N> (g<shortsha>)`, body noting the source commit + that data is isolated.
   - Replace assets each run (delete old, upload fresh) so the tag always holds the newest build.
3. Upsert a **sticky PR comment** keyed by a hidden HTML marker (`<!-- dev-build-comment -->`), same pattern as the Nexus triage issues:
   - Per-platform download links (Windows `.exe`/`.msi`/portable, macOS `.dmg`, Linux `.deb`/`.AppImage`/`.rpm`).
   - Stamped version, source commit SHA, build run link.
   - One-line reminder: "Dev build — uses isolated `sts2-mod-manager-dev` data; safe to install alongside your release install."

`renderDevComment({ pr, version, sha, assets, runUrl })` produces the comment body (pure function, tested).

## Cleanup

**`dev-build-cleanup.yml`** — `on: pull_request: types: [closed]`:
- `gh release delete dev-pr<N> --cleanup-tag --yes` (deletes release + tag). Idempotent: a no-op if the PR never had a dev build. Keeps the Releases page bounded to "one prerelease per *open* labeled PR."

## Error handling

| Failure | Behavior |
|---|---|
| One platform leg fails | `fail-fast: false` (already set) — other legs still produce builds; `publish-dev` uploads whatever artifacts exist and the comment notes any missing platform |
| Version-stamp step fails (bad SemVer, missing field) | Build leg fails loud (don't ship a mis-stamped build) |
| `publish-dev` can't create the release | Job fails red; the artifacts still exist on the run for manual download |
| Cleanup runs for a PR with no dev release | `gh release delete` is a no-op / ignored error |
| Label added then removed mid-build | Concurrency `cancel-in-progress: true` (already set) cancels the superseded run on the next push; a stale dev release is cleaned on PR close regardless |

## Testing

Non-negotiable (matches the project's test-everything culture):

1. **`scripts/dev-build-stamp.test.mjs`** (`node --test`):
   - `computeDevVersion('1.6.1', 42, 'a1b2c3d')` → `1.6.1-dev.pr42.ga1b2c3d`
   - All-digit short sha (`0123456`) still yields valid SemVer (`g0123456`)
   - `renderDevComment` includes every provided asset link, the version, the commit, the run URL, the hidden marker, and the isolation reminder; omits platforms with no asset
   - `stampFiles` round-trip: rewrites both files' version AND the tauri.conf.json `identifier` (→ `com.sts2mm.app.dev`) + `productName` (→ `STS2 Mod Manager (Dev)`), leaving every other JSON/TOML key byte-intact (use temp copies of the real files; assert untouched keys are unchanged)
2. **Rust `#[test]` for `app_dir_name()`** — confirm a `-dev` version maps to `sts2-mod-manager-dev` and a clean version to `sts2-mod-manager`. (Testing the `env!` branch may require a small refactor to a pure `dir_name_for(version: &str)` that `app_dir_name()` calls — test the pure function with both inputs.)
3. **YAML validity** — both `build.yml` and `dev-build-cleanup.yml` parse (Python `yaml.safe_load`).
4. **`cargo check`** passes with the `state.rs` / `lib.rs` change (the existing `check` job covers this on the D PR itself).
5. **No silent-skip patterns** in tests; every test ends with an assertion.
6. **First end-to-end test:** open a throwaway PR, add `dev-build`, confirm (a) a `dev-pr<N>` prerelease appears with all three platforms, (b) the sticky comment lists the links + stamped version, (c) the downloaded Windows build writes to `…/sts2-mod-manager-dev/` not the release dir, (d) closing the PR deletes the prerelease.

## Rollout

1. Merge the D PR (note: the build.yml change means the D PR itself, once labeled, would dev-build — useful as the first live test).
2. Create the `dev-build` label: `gh label create dev-build --color FBCA04 --description "Build installable dev artifacts for this PR"`.
3. Verify on a throwaway PR per the end-to-end test above.
4. No secrets needed beyond the existing `TAURI_SIGNING_PRIVATE_KEY` / `GITHUB_TOKEN`.

## References

- Sub-project A spec: [`2026-05-26-nexus-github-triage-design.md`](2026-05-26-nexus-github-triage-design.md) — the sticky-comment + workflow patterns reused here.
- Existing build pipeline: `.github/workflows/build.yml` (the `build` matrix + `Upload build artifacts` step D extends).
