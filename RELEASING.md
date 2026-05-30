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

3. **Confirm `NEXUS_API_KEY` is set** (required for both triage and the `publish-nexus` upload job):

       gh secret list --repo MohamedSerhan/sts2-mod-manager | grep NEXUS_API_KEY

   Triage fetches mod comments via `POST api.nexusmods.com/v2/graphql` using the `apikey:` header.
   The same key already stored for `publish-nexus` is reused — no new secret needed.

4. **Optionally override `NEXUSMODS_POSTS_THREAD_ID`** (defaults to `16866026` in code; set as repo
   var only if the thread ID ever changes):

       gh variable set NEXUSMODS_POSTS_THREAD_ID --body "16866026" --repo MohamedSerhan/sts2-mod-manager

5. **Bootstrap the state file** locally so the first triage run doesn't refile months-old comments:

       NEXUS_API_KEY=<your-key> node scripts/nexus-triage.mjs --bootstrap
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

### When triage fails for a different reason

- Open the failed workflow run in Actions UI
- The script exits with specific codes:
  - exit 1: transient (network, GitHub API). Re-run the failed workflow.
  - exit 2: configuration drift (missing secret, missing state file, malformed state, hard schema drift). Read the error message — it names the missing piece.

### Reliability note: GraphQL is reliable from CI

The triage script fetches Nexus mod-page comments via the documented GraphQL API
(`POST api.nexusmods.com/v2/graphql`) using `NEXUS_API_KEY`. This is a JSON API
call — not a webpage — so Cloudflare's bot protection does not apply. Expect
near-100% success rate from GitHub Actions runners, unlike the prior HTML scraping
approach which was 100% Cloudflare-blocked from CI IP ranges.

**Update 2026-05-27 — runtime moved to local Task Scheduler.** The "GraphQL is reliable" claim above was wrong: GraphQL's `commentThread` query covers collection comments only, not mod-page comments. Mod-page comments live behind the legacy `Core/Libs/Common/Widgets/CommentContainer` HTML widget endpoint, which Cloudflare challenges 100% of the time from GitHub Actions IPs. The triage script now runs from your residential IP via `scripts/run-nexus-triage-local.bat` + Windows Task Scheduler. See section below.

### Local runtime via Task Scheduler

`scripts/run-nexus-triage-local.bat` is the Windows runner:
1. Sets the `NEXUSMODS_*` env vars (hard-coded for mod 856)
2. Pulls `gh auth token` for `GITHUB_TOKEN`
3. Honors the `scripts/nexus-triage.disabled` killswitch
4. Updates the repo to `main` + pulls latest
5. Runs `node scripts/nexus-triage.mjs`
6. Commits and pushes the updated state file
7. Logs each run to `.nexus-triage-runs/YYYY-MM-DD.log` (gitignored)

#### One-time setup

1. `python -m pip install --user curl_cffi` (the Python TLS-impersonate shim)
2. `gh auth status` — make sure you're logged in
3. **Task Scheduler → Create Task…** (already created as "Nexus Triage" on
   2026-05-27 — these are the settings if you ever need to recreate it):
   - Name: `Nexus Triage`
   - **Triggers:** Daily at 10:00
   - **Actions:** Start a program → `C:\Users\xxsku\repos\sts2-mod-manager\scripts\run-nexus-triage-local.bat`
   - Start in: `C:\Users\xxsku\repos\sts2-mod-manager`
4. Double-click the .bat once to test. Check `.nexus-triage-runs\<today>.log`.

The per-run cap is 5 issues. With a daily trigger, a backlog drains at 5/day;
steady-state mod traffic is well under that. Bump `PER_RUN_CAP` in
`scripts/nexus-triage.mjs` if you want faster catch-up.

> **`@claude` investigation requires the Claude GitHub App.** Filing issues
> works without it, but the reactive investigation comments need the app
> installed at <https://github.com/apps/claude> on this repo (one-time, separate
> from the `CLAUDE_CODE_OAUTH_TOKEN` secret). Until then, `claude.yml` runs fail
> with "Claude Code is not installed on this repository".

#### What still runs in CI

- `claude.yml` — reactive `@claude` mention handler
- `nexus-watchdog.yml` + `nexus-watchdog-check.yml` — weekly token-health probe
- `nexus-triage.yml` — kept for `workflow_dispatch` diagnostics only; `schedule:` is commented out because CI runs always Cloudflare-block

#### Killswitches

- Create `scripts/nexus-triage.disabled` (any content) — the .bat exits 0 immediately
- Disable the Task Scheduler entry from the Task Scheduler UI
- Both leave the state file frozen at the last successful run

---

## Operator runbook — auto-fix bot (sub-project C)

The auto-fix bot lets the maintainer ask Claude to implement a fix for a
GitHub issue and open a PR — all from the GitHub UI, without touching a
terminal.  The underlying workflows live in `.github/workflows/claude-autofix.yml`.

### How to use it

**Start a fix** — label any issue `auto-fix` from the issue sidebar.
Claude opens a branch named EXACTLY `auto-fix/<issue-number>` (no suffix or
slug), implements a fix, and opens a PR with title/body referencing the issue
(`Fixes #N`).  A workflow step then applies the `dev-build` + `auto-fix` labels
via `DEV_BUILD_LABEL_TOKEN` so the dev-build trigger fires deterministically.

The `dev-build` label triggers sub-project D to build a `dev-pr<N>` prerelease
so you can install and test the fix immediately via Settings → Dev Builds (sub-project E).

**Revise the PR** — post a comment on the PR:

```
@claude <your feedback here>
```

Claude updates the branch in-place.  Repeat as many times as needed.

**Review and merge** — PRs are **never auto-merged**.  Inspect the diff,
check that the `check` job passed (it runs automatically on every push to the
PR branch), then merge when satisfied.

### One-time setup

Run these once after merging this PR:

**1. Create the `auto-fix` label**

```bash
gh label create auto-fix \
  --color 5319e7 \
  --description "Ask the Claude bot to implement a fix for this issue" \
  --repo MohamedSerhan/sts2-mod-manager
```

**2. Enable Dependabot security updates**

Go to **Settings → Code security** and turn on "Dependabot security updates".
Dependabot PRs are automatically labeled `dev-build` by `.github/workflows/dependabot-label.yml`,
so they flow through the same dev-build pipeline.

**3. Create and store the `DEV_BUILD_LABEL_TOKEN` secret**

After Claude opens the PR, a dedicated workflow step applies `dev-build` +
`auto-fix` using this PAT.  The default `GITHUB_TOKEN` cannot trigger downstream
workflows (GitHub prevents workflow-to-workflow triggers with the default token
for security reasons), so the PAT is what makes sub-project D's dev build fire.

Minimum PAT scopes — when creating the PAT at
<https://github.com/settings/tokens?type=beta>:
- Repository access: `MohamedSerhan/sts2-mod-manager` only
- Permissions: **Contents: Read** + **Pull requests: Write**

Store it:

```bash
gh secret set DEV_BUILD_LABEL_TOKEN \
  --repo MohamedSerhan/sts2-mod-manager
# paste the PAT when prompted
```

Without this secret the `dev-build` label is not applied and the dev-build
pipeline does not trigger.  The PR itself is still opened — only the automatic
test build is skipped.

**4. Install the Claude GitHub App** (if not already done for `claude.yml`)

<https://github.com/apps/claude> → Install on `MohamedSerhan/sts2-mod-manager`.
Both the investigate flow (`claude.yml`) and the auto-fix flow
(`claude-autofix.yml`) require the app.

### Safety posture

| Property | Detail |
|---|---|
| **Opt-in only** | The bot acts only when a maintainer explicitly labels an issue `auto-fix` or posts `@claude` on a PR. No automatic triggering on code push or PR open. |
| **Actor gate** | Both the label-to-fix and the `@claude`-revise jobs check that the actor has `write`, `admin`, or `maintain` permission on the repo before doing any work. External contributors cannot trigger the bot. |
| **CI gate** | Every push to an auto-fix PR branch runs the `check` job (lint + tests). The PR cannot be merged without it passing. |
| **No auto-merge** | The bot opens PRs; you merge them. There is no auto-merge, no squash-on-approve, no bypass of branch-protection rules. |
| **Read-only investigate flow unchanged** | `claude.yml` (the `@claude` mention handler on regular issues and PRs) is separate and read-only. It was not modified by sub-project C. |
| **Write access scope** | The bot's write access is confined to creating branches and opening/updating PRs via the Claude GitHub App. It cannot modify secrets, settings, or workflows.

### QA review + approval-merge (the `qa` label)

#### How it works

Add the `qa` label to any PR — including your own hand-written PRs — to enable
the QA-review loop and approval-gated auto-merge.  When the auto-fix bot opens
a fix PR it applies `qa` automatically, so the loop runs without any extra
action on your part.

Once labeled, a second adversarial QA-Claude reads the PR diff, the CI results,
and the codebase context, then either approves or posts revision feedback.  If
there is feedback the bot revises the branch in-place and QA re-checks —
**including your own PRs**: the bot will commit revisions to whichever branch
carries the `qa` label.  That is the point — it minimises back-and-forth before
the PR ever reaches your desk.

The loop continues for up to **5 rounds**.

- **QA satisfied** → the PR receives the `qa-passed` label and a ping to you.
  Do a single final read of the diff, then **approve** the PR.  Your approval
  (`MohamedSerhan`) — and only yours — combined with a green CI run triggers
  the auto-merge.
- **Round cap reached without QA sign-off** → the PR is labeled `qa-needs-human`
  and the loop stops.  Review it manually; merge (or close) at your discretion.

A PR that does **not** carry the `qa` label is unaffected — it stays on the
normal merge-manually path.

#### One-time label setup

Run these once after merging the QA-merge PR:

```bash
gh label create qa \
  --color 1d76db \
  --description "Run the QA-review loop + enable approval-merge" \
  --repo MohamedSerhan/sts2-mod-manager

gh label create qa-passed \
  --color 0e8a16 \
  --description "QA satisfied — ready for the maintainer's final check" \
  --repo MohamedSerhan/sts2-mod-manager

gh label create qa-needs-human \
  --color b60205 \
  --description "QA hit the round cap — needs the maintainer" \
  --repo MohamedSerhan/sts2-mod-manager
```

#### Safety posture

| Property | Detail |
|---|---|
| **Approval gate** | Only `MohamedSerhan`'s approval triggers the auto-merge. Another reviewer's approval has no effect. |
| **Dual condition** | Auto-merge requires both `qa-passed` **and** a green CI run. Either condition alone is not enough. |
| **5-round cap** | The loop escalates to `qa-needs-human` rather than running forever. You always get the final word. |
| **Releases stay manual** | The bot updates the `[Unreleased]` CHANGELOG section as part of its fix work, but it never cuts or publishes a release. `scripts/release.sh` remains your manual step. |
| **No-`qa` PRs unaffected** | Removing the `qa` label (or never adding it) leaves the PR on the normal manual-merge path with no QA loop and no auto-merge. |

### CI Gate (required checks)

#### What it is

`CI Gate` is a single required status check on `main`.  It is change-aware: the
checks it runs depend on what files a PR touches.

- **App PRs** (changes under `src/`, `src-tauri/`, `public/`, `index.html`, the
  build/test config — `vite.config.ts`, `vitest.config.ts`, `tsconfig*.json` — or
  the manifests `package.json` / `src-tauri/Cargo.toml`) run the full suite:
  - Vitest unit tests (`npm run test`)
  - Rust tests (`cargo test`)
  - A 3-platform build (Windows, macOS, Linux)
  - A CHANGELOG check — the PR must add a bullet under `[Unreleased]`
- **Scripts / workflows / docs PRs** (changes limited to `.github/`, `scripts/`,
  `docs/`, `*.md`) run lighter checks or none, so they stay fast and do not
  require a full build.

Because `CI Gate` is required on `main`, **nothing merges — the auto-fix bot's
auto-merge or your own manual merge — until the check is green.**  This is the
deterministic floor under QA-Claude's judgment: a broken change cannot ship to
users autonomously, regardless of how the review loop resolves.

#### The `no-changelog` opt-out

App PRs must contain a `[Unreleased]` CHANGELOG bullet.  The auto-fix bot adds
this automatically for user-facing fixes.

For genuinely internal app changes — refactors, test-only work, build tooling
that users will never notice — label the PR `no-changelog` to skip just the
changelog check while leaving all other gates (tests, build) intact.

#### One-time setup

```bash
# 1. Create the no-changelog opt-out label
gh label create no-changelog \
  --color ededed \
  --description "App change with no user-facing CHANGELOG entry (skips the changelog gate)" \
  --repo MohamedSerhan/sts2-mod-manager

# 2. Require the CI Gate check on main + disallow direct pushes.
# UI path (most reliable): Settings -> Branches -> Branch protection rules -> main:
#   - "Require status checks to pass" -> add "CI Gate"
#   - "Require a pull request before merging" (so direct pushes can't bypass the gate)
# Or via API (shape varies by gh/API version; verify in the UI afterward):
gh api -X PATCH repos/MohamedSerhan/sts2-mod-manager/branches/main/protection/required_status_checks \
  -f 'strict=true' -f 'checks[][context]=CI Gate'
```

#### Safety note

Requiring a pull request before merging (disallowing direct pushes to `main`) is
what makes the gate non-bypassable in normal operation.  Without it, a direct
push lands on `main` without ever touching `CI Gate`.  An admin can still force-
push in a genuine emergency — that is the intentional escape hatch — but it
should be a last resort, not routine practice.
