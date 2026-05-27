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

---

## Operator runbook — Nexus triage

This section covers the hourly Nexus → GitHub triage automation introduced in `2026-05-26`. See [`docs/superpowers/specs/2026-05-26-nexus-github-triage-design.md`](docs/superpowers/specs/2026-05-26-nexus-github-triage-design.md) for the full design rationale.

### Day 0 setup (one-time, after merging the triage PR)

1. **Generate a Claude Code OAuth token** (1-year validity, designed for CI):

       claude setup-token

   Follow the browser prompt. The CLI prints a token to stdout.

2. **Store the token as a repo secret:**

       gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo MohamedSerhan/sts2-mod-manager

   Paste the token when prompted.

3. **Confirm `NEXUS_API_KEY` is still set** (only needed for the `publish-nexus` upload job — NOT for triage):

       gh secret list --repo MohamedSerhan/sts2-mod-manager | grep NEXUS_API_KEY

   Triage no longer uses `NEXUS_API_KEY`. It reads from the Nexus HTML widget endpoint using curl-impersonate.

4. **Discover and set the Nexus posts thread ID** (one-time, needed before any triage run):

   Install curl-impersonate locally (or run in a temporary workflow job) and run:

       node scripts/nexus-triage.mjs --discover-thread-id

   This prints the `thread_id` for mod 856's posts tab. Store it as a repo variable:

       gh variable set NEXUSMODS_POSTS_THREAD_ID --body <value> --repo MohamedSerhan/sts2-mod-manager

5. **Set the remaining NEXUSMODS_* repo variables** (defaults are fine if you haven't changed them, but
   setting them explicitly makes the CI configuration self-documenting):

       gh variable set NEXUSMODS_GAME_ID     --body "8916"    --repo MohamedSerhan/sts2-mod-manager
       gh variable set NEXUSMODS_MOD_ID      --body "856"     --repo MohamedSerhan/sts2-mod-manager
       gh variable set NEXUSMODS_OBJECT_TYPE --body "1"       --repo MohamedSerhan/sts2-mod-manager
       gh variable set NEXUSMODS_POSTS_URL   --body "https://www.nexusmods.com/slaythespire2/mods/856?tab=posts" \
         --repo MohamedSerhan/sts2-mod-manager

6. **Bootstrap the state file** locally so the first triage run doesn't refile months-old comments:

       NEXUSMODS_POSTS_THREAD_ID=<thread_id> node scripts/nexus-triage.mjs --bootstrap
       git add scripts/nexus-triage-state.json
       git commit -m "chore(triage): bootstrap Nexus triage state"
       git push

7. **Run a dry-run from Actions UI** to verify the live classifier output:

   - Actions → `Nexus triage` → "Run workflow" with `dry_run: true`
   - Read the run logs. If the classifications look right on real comments, proceed.
   - If something looks wrong, open a follow-up PR with classifier tweaks and re-test before enabling cron.

8. **Enable the hourly cron** by uncommenting the `schedule:` block in `.github/workflows/nexus-triage.yml`:

       schedule:
         - cron: "0 * * * *"

9. **Trigger the watchdog ping** manually once to confirm `@claude` is online:

   - Actions → `Nexus watchdog — ping` → "Run workflow"
   - Wait a few minutes for @claude to reply with PING-OK
   - If no reply within 30 min, the OAuth token is bad — return to step 1

### Annual token renewal

`CLAUDE_CODE_OAUTH_TOKEN` is valid for ~1 year. Either the watchdog catches expiry (files an `ops:token-renewal` issue automatically) or you renew on your own schedule.

To renew:

1. `claude setup-token` (~30 seconds, browser auth)
2. `gh secret set CLAUDE_CODE_OAUTH_TOKEN --repo MohamedSerhan/sts2-mod-manager` and paste the new token
3. Actions → `Nexus watchdog — ping` → "Run workflow" — confirms the new token
4. If a renewal issue was open, close it with `gh issue close <num>`

### Killswitches

**To pause triage cleanly:**

- Actions → `Nexus triage` → menu → "Disable workflow". State file frozen at last successful run. Re-enable when ready.

**To pause from a phone (no terminal):**

- GitHub web UI → `scripts/` → "Add file" → name it `nexus-triage.disabled` (any content). The next cron run will exit 0 with no work. Delete the file to resume.

### When the watchdog files an `ops:token-renewal` issue

The token expired. Follow the "Annual token renewal" steps above. The renewal issue includes the procedure inline.

### When triage fails with "Cloudflare blocked the request"

The triage script bypasses Cloudflare TLS fingerprinting using `curl-impersonate-chrome`. Nexus
periodically updates its Cloudflare configuration, which can break the impersonation.

To fix:

1. Check if a newer `curl-impersonate` release is available at
   <https://github.com/lwthiker/curl-impersonate/releases>
2. Update the version in `.github/workflows/nexus-triage.yml` under "Install curl-impersonate-chrome"
3. If the release uses a different binary name (e.g., `curl_chrome137` for a newer Chrome version),
   also update `CURL_IMPERSONATE_BIN` in the workflow env and the default in `scripts/nexus-triage.mjs`
4. Test with `--dry-run` before re-enabling the cron

### When triage fails with "could not find thread_id"

Nexus changed the HTML structure of the posts tab. Re-discover the thread ID:

1. Install `curl-impersonate` locally (or run a temporary workflow)
2. `node scripts/nexus-triage.mjs --discover-thread-id`
3. If that also fails, inspect the live page source manually:
   `curl_chrome136 https://www.nexusmods.com/slaythespire2/mods/856?tab=posts | grep -i thread_id`
4. Update `NEXUSMODS_POSTS_THREAD_ID` repo variable with the new value, or update the
   `discoverThreadId` regex patterns in `scripts/nexus-triage.mjs` if the embedded JS format changed

### When triage fails for a different reason

- Open the failed workflow run in Actions UI
- The script exits with specific codes:
  - exit 1: transient (network, GitHub API). Re-run the failed workflow.
  - exit 2: configuration drift (missing secret, missing state file, malformed state, hard schema drift). Read the error message — it names the missing piece.
