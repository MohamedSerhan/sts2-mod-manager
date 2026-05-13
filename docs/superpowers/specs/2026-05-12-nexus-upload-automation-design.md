# Nexus Mods upload automation

Eliminate the manual step of uploading the Windows build to the Nexus Mods page on every release. Today the GitHub Release publishes automatically on `vX.Y.Z` tags; Nexus is the only target still touched by hand.

A secondary goal: ship a **portable .zip** to Nexus (raw Tauri `.exe` + WebView2 note) instead of the NSIS installer. NSIS self-extracting installers trigger AV/SmartScreen heuristics that a bare executable doesn't, and Nexus users in particular are accustomed to portable distributions. The NSIS and MSI installers continue to ship on the GitHub Release because the in-app Tauri updater depends on them.

## Scope

- Build a **portable zip** (`STS2.Mod.Manager_<version>_x64_portable.zip`) on every tag push, containing the Tauri `.exe` and a short README about the WebView2 runtime.
- Upload the portable zip as a GitHub Release asset (alongside NSIS / MSI / DMG / etc.).
- Upload the same portable zip to the existing Nexus mod page (mod 856, game: slaythespire2).
- Set the Nexus file's **version** field to match the git tag and archive the previous main file.

Out of scope:
- **Disabling NSIS / MSI.** The in-app Tauri updater (`tauri-plugin-updater`) consumes the signed installer bundles via `latest.json`. Removing them would break auto-update for every existing Windows user.
- **Code signing.** SmartScreen "unknown publisher" still appears on first launch of the portable; only an EV cert would suppress it.
- **macOS / Linux portable variants.** The current Nexus page is Windows-only.
- **Mod page description / Posts tab.** Not exposed by the Nexus public API.
- **Vortex/MO2 "download with manager" flag.** STS2 isn't a Vortex-supported game anyway, and the upload-action doesn't expose this knob (`primary_mod_manager_download` / `allow_mod_manager_download` are in the action's README but not in its `action.yml`). The flag is set per-mod-page in the Nexus UI if it ever becomes relevant.

## Architecture

Two additive changes to `.github/workflows/build.yml`:

```
build (per-platform matrix)
  ├── windows-latest:
  │     tauri-action → NSIS/MSI bundles published to GitHub Release  (existing)
  │     package-portable → zip raw exe + README, upload to Release   ← NEW STEP
  ├── macos-latest:    (unchanged)
  └── ubuntu-22.04:    (unchanged)

after build:
  ├── publish-updater   (assembles latest.json — unchanged, NSIS-based)
  ├── format-release    (rewrites release notes — unchanged)
  └── publish-nexus     (downloads portable zip, uploads to Nexus)   ← NEW JOB
```

All new logic gates on `startsWith(github.ref, 'refs/tags/v')` — PR runs and non-tag dispatches are unchanged. The portable step lives **inside** the Windows matrix leg (not as a separate job) because it operates on the just-built `target/release/` artifacts that don't survive across jobs without explicit upload. The Nexus job runs in parallel with `publish-updater` / `format-release` so a Nexus outage cannot block the GitHub Release or the in-app updater.

Single source of truth for the version: the git tag. `TAG=${GITHUB_REF_NAME}` → `VERSION=${TAG#v}` → both the zip filename and the Nexus version field.

## The portable packaging step

Inside the existing Windows leg of the `build` matrix, after `tauri-action` runs:

```yaml
- name: Package portable zip (Windows only)
  if: matrix.platform == 'windows-latest' && startsWith(github.ref, 'refs/tags/v')
  shell: pwsh
  env:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  run: |
    $version = '${{ github.ref_name }}'.TrimStart('v')

    # Tauri's cargo binary name is sts2-mod-manager.exe (from Cargo.toml).
    # Exclude any *-setup.exe / build-script intermediates.
    $candidates = Get-ChildItem 'src-tauri/target/release/*.exe' |
                  Where-Object {
                    $_.Name -notlike '*-setup.exe' -and
                    $_.Name -notlike '*build-script*' -and
                    $_.Name -notlike '*.tmp.exe'
                  }
    if ($candidates.Count -ne 1) {
      Write-Error "Expected exactly one app exe in target/release, found $($candidates.Count): $($candidates.Name -join ', ')"
      exit 1
    }
    $exe = $candidates[0]

    $staging = 'portable-staging'
    New-Item -ItemType Directory -Path $staging -Force | Out-Null
    Copy-Item $exe.FullName (Join-Path $staging 'STS2 Mod Manager.exe')
    Copy-Item scripts/portable-README.txt (Join-Path $staging 'README.txt')

    $zip = "STS2.Mod.Manager_${version}_x64_portable.zip"
    Compress-Archive -Path "$staging/*" -DestinationPath $zip -Force

    gh release upload "${{ github.ref_name }}" $zip --clobber
```

Notes:
- The Cargo binary is named `sts2-mod-manager.exe` (matches `[package].name` in `src-tauri/Cargo.toml`). The step renames it to `STS2 Mod Manager.exe` inside the zip so users see a polished name when they extract.
- Fail-fast `if ($candidates.Count -ne 1)` catches the case where Tauri renames the binary in a future version — we'd rather hard-fail the release than ship a silently empty zip.
- The Nexus zip and the GitHub Release zip are the **same bytes** — uploaded once here, downloaded for re-upload by `publish-nexus`.

A new file `scripts/portable-README.txt` ships in the zip:

```
STS2 Mod Manager — Portable
============================

This is the portable distribution: no installer, no registry writes,
no Start menu entry. Just run STS2 Mod Manager.exe.

Requirements
------------
- Windows 10 (1809+) or Windows 11 — preinstalled
- WebView2 Runtime — preinstalled on Win10 1809+ / Win11

If the app fails to launch with a WebView2 error, install the
Evergreen Bootstrapper (small, ~2 MB):

    https://go.microsoft.com/fwlink/p/?LinkId=2124703

Updates
-------
The portable build does not auto-update. Re-download from Nexus or
GitHub when a new version is released.

For auto-updates, use the NSIS installer from the GitHub Releases page:
https://github.com/MohamedSerhan/sts2-mod-manager/releases/latest
```

## The publish-nexus job

```yaml
publish-nexus:
  if: startsWith(github.ref, 'refs/tags/v')
  needs: build
  runs-on: ubuntu-latest
  steps:
    - name: Resolve version + asset name
      id: meta
      run: |
        TAG="${GITHUB_REF_NAME}"
        VERSION="${TAG#v}"
        echo "version=$VERSION" >> "$GITHUB_OUTPUT"
        echo "filename=STS2.Mod.Manager_${VERSION}_x64_portable.zip" >> "$GITHUB_OUTPUT"

    - name: Download portable zip from GitHub Release
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      run: gh release download "${GITHUB_REF_NAME}" -R "${GITHUB_REPOSITORY}" -p "${{ steps.meta.outputs.filename }}"

    - name: Upload to Nexus Mods
      uses: Nexus-Mods/upload-action@v1.0.0-beta.5
      with:
        api_key:                      ${{ secrets.NEXUS_API_KEY }}
        file_group_id:                ${{ secrets.NEXUS_FILE_GROUP_ID }}
        filename:                     ${{ steps.meta.outputs.filename }}
        version:                      ${{ steps.meta.outputs.version }}
        file_category:                main
        archive_existing_file:        true
        display_name:                 STS2 Mod Manager ${{ steps.meta.outputs.version }} (Windows Portable)
```

Choices:
- **`archive_existing_file: true`** keeps the Files tab tidy.
- **`file_category: main`** — replaces the existing main file with the portable.
- Vortex/MO2 "download with manager" flag is not passed because the action's `action.yml` doesn't accept it (the action README is misleading on this). Set per-mod in the Nexus UI if ever relevant.

## Secrets & one-time setup

Before this works, three things must be configured once:

1. **Generate a Nexus v1 API key** at <https://www.nexusmods.com/users/myaccount?tab=api>. Either reuse the existing "Personal API Key" or generate a new one.
2. **Find the mod's `file_group_id`** at the Nexus mod page → Files tab → "API Info" → copy the integer.
3. **Add two repository secrets** at `MohamedSerhan/sts2-mod-manager` → Settings → Secrets and variables → Actions:
   - `NEXUS_API_KEY`
   - `NEXUS_FILE_GROUP_ID`

A new `RELEASING.md` documents this (maintainer-only — release flow doesn't belong in user-facing `README.md`, and there's no `CONTRIBUTING.md`).

## Error handling & re-runs

- **Failure isolation.** `publish-nexus` is parallel to `publish-updater` / `format-release`. If Nexus is down, the GitHub Release + in-app updater still ship; only the Nexus job goes red.
- **Portable packaging failure** would fail the Windows build leg and block the GitHub Release. That's intentional — if we can't produce the portable, we shouldn't tag a partial release.
- **Single-job re-run.** Use Actions UI → "Re-run failed jobs". The Nexus download step is idempotent (the asset is on the GitHub Release).
- **Missing secrets.** `publish-nexus` fails loudly — silent skip would let Nexus drift out of sync invisibly.
- **Duplicate uploads on re-run.** Nexus's upload API has no native "if-not-exists" guard. Re-running after a successful upload would archive the file just uploaded and add a duplicate. Mitigation: don't re-run after success; if it happens, manually delete the duplicate on the mod page.

## Testing

No Nexus staging environment exists; the upload-action is mature and used in production by other mods. Validation:
- **Local `actionlint` or `python -c 'yaml.safe_load(...)'`** before merging — catches YAML syntax mistakes.
- **First real tag push** is the live test. Worst-case is a duplicate file on Nexus (30 seconds to delete) or a misbuilt portable zip (re-run the workflow after fixing).
- **Manual smoke test of the portable** after the first release: download the zip, extract, run `STS2 Mod Manager.exe`, verify it launches and the manager UI loads.

## Files touched

- **Modify** `.github/workflows/build.yml`:
  - Add portable packaging step inside Windows matrix leg (~30 lines).
  - Add `publish-nexus` job after `format-release` (~30 lines).
- **Create** `scripts/portable-README.txt` — bundled README for the portable zip.
- **Create** `RELEASING.md` — maintainer doc covering release flow + secret setup.

No application code, no `tauri.conf.json`, no `Cargo.toml` changes. The portable artifact is derived from the binary `tauri-action` already builds; no additional cargo invocation needed.
