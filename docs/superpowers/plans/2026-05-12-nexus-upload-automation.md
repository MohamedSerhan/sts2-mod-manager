# Nexus Mods upload automation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On every `vX.Y.Z` tag push, build a portable Windows `.zip` (raw Tauri `.exe` + WebView2 README), upload it as a GitHub Release asset, and upload the same zip to Nexus Mods (mod 856) — eliminating the current manual Nexus upload and avoiding NSIS installer heuristics that some AV vendors flag.

**Architecture:** Two additive changes to `.github/workflows/build.yml`. (1) Inside the existing Windows matrix leg, add a "package portable" step that runs after `tauri-action` and zips `src-tauri/target/release/sts2-mod-manager.exe` + a small README into `STS2.Mod.Manager_<version>_x64_portable.zip`, uploading it to the GitHub Release. (2) A new `publish-nexus` job runs in parallel with `publish-updater` / `format-release` after `build` completes; it downloads the portable zip from the just-published GitHub Release and uploads it to Nexus via `Nexus-Mods/upload-action`. NSIS / MSI installers and the in-app updater path stay untouched — the in-app updater needs them.

**Tech Stack:** GitHub Actions YAML, PowerShell (`Compress-Archive`, `Get-ChildItem`), `gh` CLI, [`Nexus-Mods/upload-action@v1.0.0-beta.5`](https://github.com/Nexus-Mods/upload-action), `rhysd/actionlint` for YAML validation.

**Spec:** [`docs/superpowers/specs/2026-05-12-nexus-upload-automation-design.md`](../specs/2026-05-12-nexus-upload-automation-design.md)

---

## File Map

- **Modify:** `.github/workflows/build.yml` — add portable packaging step inside the Windows leg of the `build` matrix (~30 lines) + add `publish-nexus` job after `format-release` (~30 lines).
- **Create:** `scripts/portable-README.txt` — bundled into the portable zip; tells users about WebView2 + no auto-update.
- **Create:** `RELEASING.md` — maintainer doc.

No application code touched. No `tauri.conf.json` / `Cargo.toml` changes.

---

### Task 1: Add `scripts/portable-README.txt`

**Files:**
- Create: `scripts/portable-README.txt` (UTF-8, LF line endings to match the other shell scripts in `scripts/`).

- [ ] **Step 1: Verify the `scripts/` directory exists and check the line-ending convention used by sibling files**

```bash
ls scripts/
file scripts/publish-updater.sh 2>/dev/null || git ls-files --eol scripts/ | head -5
```

Expected: `scripts/` exists; sibling files use LF endings (consistent with the `*.sh` scripts already in there).

- [ ] **Step 2: Create `scripts/portable-README.txt` with this exact content**

```
STS2 Mod Manager — Portable
============================

This is the portable distribution: no installer, no registry writes,
no Start menu entry. Just run STS2 Mod Manager.exe.

Requirements
------------
- Windows 10 (1809+) or Windows 11
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

End the file with a single trailing newline.

- [ ] **Step 3: Verify**

```bash
cat scripts/portable-README.txt
wc -l scripts/portable-README.txt
```

Expected: file prints back identically; ~25 lines.

- [ ] **Step 4: Commit**

```bash
git add scripts/portable-README.txt
git commit -m "$(cat <<'EOF'
docs: portable build README (bundled into zip)

Ships inside STS2.Mod.Manager_<version>_x64_portable.zip alongside
the Tauri .exe. Documents the WebView2 requirement and points users
at the NSIS installer if they want auto-updates.
EOF
)"
```

---

### Task 2: Add portable packaging step to `build.yml` Windows matrix

**Files:**
- Modify: `.github/workflows/build.yml` — insert one new step inside the existing Windows leg of the `build` matrix job.

- [ ] **Step 1: Find the right insertion point**

Read `.github/workflows/build.yml` lines 134–186. The Windows leg of the matrix runs the same steps as all platforms. The new portable-packaging step must run:
- AFTER the `Build Tauri app` step (`tauri-apps/tauri-action@v0`, around line 134).
- AFTER the `Patch AppImage AppRun` step (which only runs on Linux — fine to insert before or after, but conceptually it should come right after `Build Tauri app` for readability).
- BEFORE the `Upload build artifacts` step (line 170, which only runs on NON-tag pushes).

Insert it **immediately after the `Build Tauri app` step** (after line 150, before the `Patch AppImage AppRun` step at line 152).

- [ ] **Step 2: Insert the new step**

Add this block at 6-space indentation (matching the existing `- name:` entries in `steps:`):

```yaml
      - name: Package portable zip (Windows only)
        if: matrix.platform == 'windows-latest' && startsWith(github.ref, 'refs/tags/v')
        shell: pwsh
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          $version = '${{ github.ref_name }}'.TrimStart('v')

          # Tauri's cargo binary is sts2-mod-manager.exe (from Cargo.toml).
          # Filter out NSIS *-setup.exe and any build-script intermediates.
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

**Do NOT touch any other step.** Specifically: do not edit `Build Tauri app`, do not edit `Patch AppImage AppRun`, do not edit `Upload build artifacts`.

- [ ] **Step 3: Validate the YAML**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml')); print('ok')"
```

Expected: `ok`. If `yaml.YAMLError`, fix the indentation.

Optional (if Docker available):
```bash
docker run --rm -v "$(pwd):/repo" -w /repo rhysd/actionlint:latest -color
```

Ignore "unknown action" warnings for `Nexus-Mods/upload-action` (actionlint can't resolve third-party actions). Real errors look like `expected scalar but got mapping` or `unknown step key`.

- [ ] **Step 4: Sanity-check the if-condition**

The portable step must run **only** on Windows AND only on tag pushes. The compound condition is:

```yaml
if: matrix.platform == 'windows-latest' && startsWith(github.ref, 'refs/tags/v')
```

Re-read your insertion to confirm both halves are present. A wrong condition could either run on every platform (failing because `pwsh` isn't always available the same way) or run on every push (failing because there's no release to upload to).

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "$(cat <<'EOF'
ci: build + publish portable Windows zip on tag

Adds a Windows-only step after tauri-action that zips the raw
sts2-mod-manager.exe (renamed to "STS2 Mod Manager.exe") plus
scripts/portable-README.txt into STS2.Mod.Manager_<version>_x64_portable.zip
and uploads it to the GitHub Release.

This portable artifact dodges NSIS installer heuristics that some AV
vendors flag — useful for Nexus Mods distribution. The NSIS / MSI
installers continue to ship for the in-app Tauri updater.

Guarded by both matrix.platform == 'windows-latest' and tag-push
condition; non-Windows legs and PR/dispatch runs are unchanged.
EOF
)"
```

---

### Task 3: Add `publish-nexus` job to `build.yml`

**Files:**
- Modify: `.github/workflows/build.yml` — append a new top-level job after `format-release`.

- [ ] **Step 1: Re-read the bottom of `build.yml`**

Confirm `format-release` is the last job (around lines 205–269) and ends with the `gh release edit "$TAG" --notes "$BODY"` line. New job goes at 2-space indentation under `jobs:`, same as `format-release`.

- [ ] **Step 2: Append the new job**

```yaml
  # Upload the portable Windows zip to Nexus Mods (mod 856).
  # Runs in parallel with publish-updater + format-release so a Nexus
  # outage cannot block the GitHub Release or the in-app updater.
  # Re-run via "Re-run failed jobs" on the workflow run if Nexus is flaky.
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
          primary_mod_manager_download: false
          allow_mod_manager_download:   false
          display_name:                 STS2 Mod Manager ${{ steps.meta.outputs.version }} (Windows Portable)
```

- [ ] **Step 3: Validate the YAML**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml')); print('ok')"
```

Expected: `ok`.

Optional `actionlint` (same as Task 2, ignore "unknown action" warnings).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "$(cat <<'EOF'
ci: auto-publish portable zip to Nexus Mods on tag

Adds publish-nexus job (parallel to publish-updater / format-release)
that downloads STS2.Mod.Manager_<version>_x64_portable.zip from the
just-created GitHub Release and uploads it to Nexus mod 856 via
Nexus-Mods/upload-action@v1.0.0-beta.5. Version flows from the git
tag; archive_existing_file keeps the Files tab clean.

Requires NEXUS_API_KEY and NEXUS_FILE_GROUP_ID repo secrets — see
RELEASING.md.
EOF
)"
```

---

### Task 4: Create `RELEASING.md`

**Files:**
- Create: `RELEASING.md` at the repo root.

- [ ] **Step 1: Write `RELEASING.md`**

Exact content:

```markdown
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
```

- [ ] **Step 2: Verify**

```bash
git diff --stat RELEASING.md
```

Expected: shows the new file ~60 lines.

- [ ] **Step 3: Commit**

```bash
git add RELEASING.md
git commit -m "$(cat <<'EOF'
docs: add RELEASING.md with release flow + secret setup

Documents the tag-based release flow (including the portable zip
build step and Nexus upload), the two new repo secrets needed
(NEXUS_API_KEY, NEXUS_FILE_GROUP_ID), and what is NOT automated on
Nexus (page description, Posts tab) so future-me doesn't expect the
workflow to handle those.
EOF
)"
```

---

### Task 5: Operator setup (one-time, manual — outside the worktree)

Manual steps the maintainer must do once before the workflow can actually publish. Surface these in the PR description.

- [ ] **Step 1: Generate / copy the Nexus API key** at <https://www.nexusmods.com/users/myaccount?tab=api>.

- [ ] **Step 2: Look up `file_group_id` for mod 856** at <https://www.nexusmods.com/slaythespire2/mods/856?tab=files> → "API Info".

- [ ] **Step 3: Add the two repo secrets** at <https://github.com/MohamedSerhan/sts2-mod-manager/settings/secrets/actions>:
  - `NEXUS_API_KEY` = value from Step 1
  - `NEXUS_FILE_GROUP_ID` = value from Step 2

- [ ] **Step 4: Verify on next release.** A green `publish-nexus` job + a new portable zip on the Nexus Files tab with the previous file archived. If the job fails, Actions log shows upload-action stderr — most failures are 401 (bad API key) or 404 (wrong file_group_id).

No commit — environment setup.

---

## Self-review

- **Spec coverage:**
  - Portable build → Task 1 + Task 2 ✓
  - Nexus upload of portable → Task 3 ✓
  - Documentation → Task 4 ✓
  - Operator setup → Task 5 ✓
  - All scope items from spec (zip naming, archive_existing_file, version from tag, README contents, fail-fast on multiple exes) are explicitly named in the steps above ✓
- **Placeholders:** None. Action version pinned (`@v1.0.0-beta.5`), filenames concrete, commands and expected outputs spelled out ✓
- **Type consistency:** N/A (YAML / shell). Cross-check of filenames:
  - `STS2.Mod.Manager_<version>_x64_portable.zip` appears in Task 2 (creation), Task 3 (consumption), Task 4 (docs) — all consistent ✓
  - `scripts/portable-README.txt` referenced in Task 2 step matches the file created in Task 1 ✓
  - upload-action input names (`api_key`, `file_group_id`, etc.) cross-checked against the action README ✓
