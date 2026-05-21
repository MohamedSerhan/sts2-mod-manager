# Releasing

Maintainer-only notes for cutting a release of STS2 Mod Manager.

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
   - `publish-nexus` uploads the portable zip to Nexus Mods (mod 856).

A failed `publish-nexus` does not block the GitHub Release or the in-app updater (the jobs run in parallel). Re-run just that job from the Actions UI if Nexus is flaky.

The portable zip ships to Nexus specifically because the NSIS self-extracting installer triggers AV/SmartScreen heuristics that a bare `.exe` does not. NSIS / MSI continue to ship on the GitHub Release because the in-app updater depends on them.

## Hard gates

- `npm run qa:i18n` must pass before release. Supported locales cannot ship
  missing keys or copied-English fallback prose. This gate runs even when
  `SKIP_QA=1` is used for an emergency hotfix.

## Required GitHub Actions secrets

Set these once at <https://github.com/MohamedSerhan/sts2-mod-manager/settings/secrets/actions>:

| Secret | Used by | How to obtain |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `build` | Tauri minisign key (already configured). |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | `build` | Password for the above (already configured). |
| `NEXUS_API_KEY` | `publish-nexus` | Generate or copy the **Personal API Key** at <https://www.nexusmods.com/users/myaccount?tab=api>. Treat like a password. |
| `NEXUS_FILE_GROUP_ID` | `publish-nexus` | On the mod page, Files tab → "API Info" → copy the integer. Tied to mod 856. |

If `NEXUS_API_KEY` or `NEXUS_FILE_GROUP_ID` is missing, `publish-nexus` will fail loudly. That's intentional — a silent skip would let Nexus drift out of sync without anyone noticing.

## What is not automated

- The **mod page description / "About this mod"** on Nexus — the public API doesn't expose it. Update manually if the copy needs to change.
- The **Posts tab** announcements on Nexus — also not API-accessible.
- **macOS / Linux** uploads to Nexus — the Nexus page currently hosts Windows only.

## Re-running a release

- A failed individual job: Actions UI → workflow run → "Re-run failed jobs".
- A full re-build for an existing tag: Actions UI → workflow_dispatch (Run workflow). Note this re-triggers every job including `publish-nexus`, which would upload a duplicate to Nexus (the upload API has no "if not exists" guard). If you only need to re-run Nexus, use "Re-run failed jobs" instead.

## Smoke-testing the portable build

After the first release that ships the portable zip:
1. Download `STS2.Mod.Manager_<version>_x64_portable.zip` from the GitHub Release.
2. Extract it.
3. Run `STS2 Mod Manager.exe` and confirm the UI loads.
4. If WebView2 is missing, the README in the zip points at the Evergreen Bootstrapper.
