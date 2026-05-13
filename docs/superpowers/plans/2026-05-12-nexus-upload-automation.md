# Nexus Mods upload automation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automate uploading the Windows installer to Nexus Mods (mod 856) on every `vX.Y.Z` tag push, eliminating the manual step that's currently done by hand after each release.

**Architecture:** Add a new `publish-nexus` job to the existing `.github/workflows/build.yml`, running in parallel with `publish-updater` and `format-release` after the per-platform `build` matrix completes. The job downloads the already-published Windows `.exe` from the GitHub Release that `tauri-action` just created, then calls `Nexus-Mods/upload-action` with the version derived from the git tag. Two new repo secrets (`NEXUS_API_KEY`, `NEXUS_FILE_GROUP_ID`) configure auth and target.

**Tech Stack:** GitHub Actions YAML, `gh` CLI (preinstalled on `ubuntu-latest`), [`Nexus-Mods/upload-action@v1.0.0-beta.5`](https://github.com/Nexus-Mods/upload-action), [`rhysd/actionlint`](https://github.com/rhysd/actionlint) for local YAML validation.

**Spec:** [`docs/superpowers/specs/2026-05-12-nexus-upload-automation-design.md`](../specs/2026-05-12-nexus-upload-automation-design.md)

---

## File Map

- **Modify:** `.github/workflows/build.yml` — add `publish-nexus` job after the existing `format-release` job (~25 lines of new YAML).
- **Create:** `RELEASING.md` (repo root) — maintainer-only doc describing the tag-based release flow and the two new secrets.

No application code is touched. No unit tests are added — the only meaningful validation for a CI workflow is YAML lint and the first real tag push.

---

### Task 1: Add `publish-nexus` job to `build.yml`

**Files:**
- Modify: `.github/workflows/build.yml` — append a new job at the end of the `jobs:` block.

- [ ] **Step 1: Read the current `build.yml` end of file to confirm the exact indentation and trailing-newline style.**

Run: read `.github/workflows/build.yml` (lines 200–270).

Expected: see the `publish-updater` and `format-release` jobs both ending with shell scripts. Confirm jobs are 2-space indented under `jobs:`, steps are 4-space indented under each job.

- [ ] **Step 2: Append the new job to `.github/workflows/build.yml`**

Add after the existing `format-release` job (after the final line of that job's last step). The new job goes at the same indentation level as `format-release` — 2 spaces under `jobs:`.

```yaml
  # Upload the Windows installer to Nexus Mods (mod 856).
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
          echo "filename=STS2.Mod.Manager_${VERSION}_x64-setup.exe" >> "$GITHUB_OUTPUT"

      - name: Download Windows installer from GitHub Release
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
          display_name:                 STS2 Mod Manager ${{ steps.meta.outputs.version }} (Windows)
```

**Notes on the choices** (mirrors the spec, kept here so a reader of just this file has full context):
- `needs: build` — wait for the Windows job to publish the `.exe` to the GitHub Release before downloading it here.
- `if: startsWith(github.ref, 'refs/tags/v')` — only runs on tag pushes; PRs and `main` pushes skip it.
- `gh release download ... -p "<filename>"` is idempotent (overwrites if file already in cwd) so re-runs don't fail on the download step.
- `archive_existing_file: true` keeps the Files tab tidy.
- `allow_mod_manager_download: false` — Vortex/MO2 are unrelated to STS2 modding; this is *our* mod manager being downloaded.
- The action is pinned to `v1.0.0-beta.5` (latest release as of plan date). It's still labeled beta upstream but it's the version other production workflows use; upgrade when Nexus tags a stable v1.

- [ ] **Step 3: Validate the YAML with `actionlint`**

Run (from worktree root):
```bash
# Use Docker if actionlint isn't installed locally (cross-platform, no install needed):
docker run --rm -v "$(pwd):/repo" -w /repo rhysd/actionlint:latest -color
```

Or, if `actionlint` is installed locally:
```bash
actionlint .github/workflows/build.yml
```

Expected output: no errors. If `actionlint` flags `Nexus-Mods/upload-action@v1.0.0-beta.5` as "unknown action" or similar — that's a warning, not an error, and is fine (actionlint can't resolve every third-party action). Real errors look like `expected scalar but got mapping` or `unknown key 'foo'`.

If errors appear, fix them inline and re-run.

- [ ] **Step 4: Confirm YAML structure with a syntax-only parse**

Run:
```bash
python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/build.yml')); print('ok')"
```

Expected output: `ok`. (PowerShell users: same command works with `python` from any Python install.)

If you get a `yaml.YAMLError`, fix the indentation/quoting and re-run.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "$(cat <<'EOF'
ci: auto-publish Windows installer to Nexus Mods on tag

Adds publish-nexus job (parallel to publish-updater / format-release)
that downloads the Windows .exe from the just-created GitHub Release
and uploads it to Nexus mod 856 via Nexus-Mods/upload-action. Version
flows from the git tag; archive_existing_file keeps the Files tab
clean.

Requires NEXUS_API_KEY and NEXUS_FILE_GROUP_ID repo secrets — see
RELEASING.md (added in the next commit).
EOF
)"
```

---

### Task 2: Create `RELEASING.md`

**Files:**
- Create: `RELEASING.md` at the repo root.

- [ ] **Step 1: Write `RELEASING.md`**

Create the file at the repo root with this exact content:

```markdown
# Releasing

Maintainer-only notes for cutting a release of STS2 Mod Manager.

## Release flow

1. Bump the version in `package.json` and `src-tauri/tauri.conf.json` (they must match).
2. Commit on `main`.
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
4. The `Build & Release` workflow (`.github/workflows/build.yml`) takes over:
   - Builds installers for Windows / macOS / Linux via `tauri-action`.
   - Publishes a GitHub Release with all bundles attached.
   - `publish-updater` assembles `latest.json` for the in-app Tauri updater.
   - `format-release` rewrites the release notes with download links.
   - `publish-nexus` uploads the Windows installer to Nexus Mods (mod 856).

A failed `publish-nexus` does not block the GitHub Release or the in-app updater (the jobs run in parallel). Re-run just that job from the Actions UI if Nexus is flaky.

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
- A full re-build for an existing tag: Actions UI → workflow_dispatch (Run workflow). Note this will re-trigger every job including `publish-nexus`, which would upload a duplicate to Nexus (the upload API has no "if not exists" guard). If you only need to re-run Nexus, use "Re-run failed jobs" instead.
```

- [ ] **Step 2: Verify the file renders correctly**

Run:
```bash
git diff --stat RELEASING.md
```

Expected: shows the new file with ~50 lines. Open it locally and scan for typos / broken markdown tables.

- [ ] **Step 3: Commit**

```bash
git add RELEASING.md
git commit -m "$(cat <<'EOF'
docs: add RELEASING.md with release flow + secret setup

Documents the tag-based release flow and the two new repo secrets
(NEXUS_API_KEY, NEXUS_FILE_GROUP_ID) consumed by the publish-nexus
job. Also enumerates what is NOT automated on Nexus (page
description, Posts tab) so future-me doesn't expect the workflow
to handle those.
EOF
)"
```

---

### Task 3: Operator setup (one-time, manual — outside the worktree)

This task is **not code** — it's the manual steps the maintainer must do once before the workflow can actually publish. Document these in the PR description so they're not forgotten before merging.

- [ ] **Step 1: Generate / copy the Nexus API key**

Visit <https://www.nexusmods.com/users/myaccount?tab=api>. Either reuse the existing **Personal API Key** at the top of the page or generate a new one. Copy the value.

- [ ] **Step 2: Look up the `file_group_id` for mod 856**

Visit <https://www.nexusmods.com/slaythespire2/mods/856?tab=files>, click "API Info" on the existing file, copy the integer.

- [ ] **Step 3: Add the two repo secrets**

Visit <https://github.com/MohamedSerhan/sts2-mod-manager/settings/secrets/actions>. Click "New repository secret" twice:
- `NEXUS_API_KEY` = value from Step 1
- `NEXUS_FILE_GROUP_ID` = value from Step 2

- [ ] **Step 4: Verify in the next release**

The next `vX.Y.Z` tag push should produce a green `publish-nexus` job and a new file on the Nexus Files tab with the previous file archived. If the job fails, the Actions log will show the upload-action's stderr — most failures are 401 (bad API key) or 404 (wrong file_group_id).

No commit for this task — it's environment setup.

---

## Self-review

- **Spec coverage:** Architecture, job YAML, secrets, error handling, testing, files touched — all sections have a corresponding task. ✓
- **Placeholders:** None. Action version, commit messages, command output expectations, and file paths are all concrete. ✓
- **Type consistency:** N/A — no types, just YAML keys. Cross-checked the input names against the spec: `api_key`, `file_group_id`, `filename`, `version`, `file_category`, `archive_existing_file`, `primary_mod_manager_download`, `allow_mod_manager_download`, `display_name` — all match the `Nexus-Mods/upload-action` README. ✓
