# Nexus Mods upload automation

Eliminate the manual step of uploading the Windows installer to the Nexus Mods page on every release. Today the GitHub Release publishes automatically on `vX.Y.Z` tags; Nexus is the only target still touched by hand.

## Scope

- Upload `STS2.Mod.Manager_<version>_x64-setup.exe` to the existing Nexus mod page (mod 856, game: slaythespire2) on every tag push.
- Set the file's **version** field on Nexus to match the git tag.
- Archive the previous main file on Nexus so the page stays clean.

Out of scope:
- **Mod page description / "About this mod"** — not exposed by the Nexus public API. Stays manual.
- **Posts tab announcements** — not exposed by the API. Stays manual.
- **macOS / Linux builds** — current Nexus page hosts Windows only; not changing that.
- **Vortex/MO2 integration flags** — STS2 isn't a Vortex-supported game and the uploaded artifact *is* a mod manager. `allow_mod_manager_download: false`.

## Architecture

A new job `publish-nexus` is added to `.github/workflows/build.yml`, parallel to the existing `publish-updater` and `format-release` jobs:

```
build (per-platform) ──┬─► publish-updater   (assembles latest.json)
                       ├─► format-release    (rewrites release notes)
                       └─► publish-nexus     (uploads Windows .exe to Nexus)  ← NEW
```

All three gate on `startsWith(github.ref, 'refs/tags/v')` and `needs: build`. Running in parallel — not serial — means a Nexus outage cannot block the GitHub Release or the in-app updater manifest. A failed `publish-nexus` shows up as a single red job that can be re-run on its own.

The version flows from one source of truth: the git tag. `TAG=${GITHUB_REF_NAME}` → `VERSION=${TAG#v}` → both the asset filename and the Nexus version field.

## The job

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
        echo "filename=STS2.Mod.Manager_${VERSION}_x64-setup.exe" >> "$GITHUB_OUTPUT"

    - name: Download Windows installer from GitHub Release
      env:
        GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      run: gh release download "${GITHUB_REF_NAME}" -R "${GITHUB_REPOSITORY}" -p "${{ steps.meta.outputs.filename }}"

    - name: Upload to Nexus Mods
      uses: Nexus-Mods/upload-action@v1   # pin to a concrete release tag at impl time
      with:
        api_key:                      ${{ secrets.NEXUS_API_KEY }}
        file_group_id:                ${{ secrets.NEXUS_FILE_GROUP_ID }}
        filename:                     ${{ steps.meta.outputs.filename }}
        version:                      ${{ steps.meta.outputs.version }}
        file_category:                main
        archive_existing_file:        true
        primary_mod_manager_download: false
        allow_mod_manager_download:   false
        display_name:                 STS2 Mod Manager ${{ steps.meta.outputs.version }} (Windows)
```

Notes on the choices:
- The installer is **downloaded from the GitHub Release** that `tauri-action` just published in the `build` job — not rebuilt. This guarantees the bytes on Nexus match the bytes on GitHub.
- **`archive_existing_file: true`** keeps the Files tab from accumulating clutter. The user can flip this off later if they prefer to archive manually.
- **`allow_mod_manager_download: false`** disables Vortex/MO2's "download with manager" button. STS2 is not a Vortex-supported game and the artifact *is* a manager, so this is the right default.
- **`file_category: main`** — Nexus categories are: main / update / optional / old. `main` matches the current page's existing file.

## Secrets & one-time setup

Before this works, three things must be configured once:

1. **Generate a Nexus v1 API key** at <https://www.nexusmods.com/users/myaccount?tab=api>. Either reuse the existing "Personal API Key" at the top of that page or generate a new one. This is the key the upload-action accepts (v3 upload API authenticates via v1 keys per Nexus's current docs).
2. **Find the mod's `file_group_id`** by visiting the mod page → Files tab → "API Info" — copy the integer.
3. **Add two repository secrets** at `MohamedSerhan/sts2-mod-manager` → Settings → Secrets and variables → Actions:
   - `NEXUS_API_KEY`
   - `NEXUS_FILE_GROUP_ID`

A short note about these secrets and where to obtain them is added to a new `RELEASING.md` at the repo root (maintainer-only docs — release flow doesn't belong in `README.md`, which is user-facing, and there's no `CONTRIBUTING.md`).

## Error handling & re-runs

- **Failure isolation.** `publish-nexus` runs in parallel with `publish-updater` and `format-release`. If Nexus is down at release time, GitHub Release + in-app updater still ship; only the Nexus job goes red.
- **Single-job re-run.** Use the Actions UI's "Re-run failed jobs" on the workflow run. The download step is idempotent (asset is already on the GitHub Release).
- **Missing secrets.** The job fails loudly. Silent skip would let the workflow appear green while Nexus stays stale — the worse failure mode.
- **Duplicate uploads on re-run.** Nexus's upload API has no native "if-not-exists" guard. Re-running after a successful upload would attempt to archive the (now main) file we just uploaded and upload a duplicate. Mitigation: don't re-run after success; if it happens, manually delete the duplicate on the mod page (rare, low cost).

## Testing

No Nexus staging environment exists, and the action is mature (used in production by other mods). Validation is:
- **Local `actionlint`** (or `gh workflow view`) before merging — catches YAML syntax mistakes.
- **First real tag push** is the live test. Worst case is a duplicate file that takes 30 seconds to clean up.

A throwaway `vX.Y.Z-nexus-test` dry run was considered and rejected — the cleanup cost on Nexus exceeds the value.

## Files touched

- `.github/workflows/build.yml` — add `publish-nexus` job (~25 lines).
- `RELEASING.md` (new file) — short maintainer note documenting the two new secrets, how to obtain them, and the existing tag-based release flow.

No application code changes.
