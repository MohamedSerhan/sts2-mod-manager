# Per-PR dev builds — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adding a `dev-build` label to a PR produces version-stamped, data-isolated, installable dev builds (Win/Mac/Linux) published as a rolling per-PR prerelease + a sticky PR comment, with cleanup on PR close.

**Architecture:** Extend `.github/workflows/build.yml` (widen the `build` gate to labeled PRs; stamp version + dev identity before `tauri-action`; add a `publish-dev` job that creates/updates the `dev-pr<N>` prerelease + sticky comment). A small `scripts/dev-build-stamp.mjs` holds the testable pure logic (version compute, file stamping, comment rendering). A ~5-line `src-tauri` change isolates dev app-data via a version-driven dir name. A new `dev-build-cleanup.yml` deletes the prerelease when the PR closes.

**Tech Stack:** GitHub Actions YAML, Node 22 (native `fetch`/`node:test`/`node:fs`), `gh` CLI, `tauri-apps/tauri-action@v0`, Rust (Tauri 2 backend).

**Spec:** [`docs/superpowers/specs/2026-05-28-per-pr-dev-builds-design.md`](../specs/2026-05-28-per-pr-dev-builds-design.md)

---

## File Map

**Create:**
- `scripts/dev-build-stamp.mjs` — `computeDevVersion`, `stampFiles`, `renderDevComment`, `--stamp` CLI entrypoint
- `scripts/dev-build-stamp.test.mjs` — `node --test` suite
- `.github/workflows/dev-build-cleanup.yml` — delete `dev-pr<N>` prerelease on PR close

**Modify:**
- `src-tauri/src/state.rs` — add `dir_name_for()` (pure) + `app_dir_name()`; use at `config_path` + `cache_path`; add `#[test]`s
- `src-tauri/src/lib.rs` — use `crate::state::app_dir_name()` for the logging/config dir
- `.github/workflows/build.yml` — widen `build` gate; add stamp step; add dev-portable-zip step; add portable zip to artifact paths; add `publish-dev` job

**Untouched:** `src/` frontend (the updater-nag is left as documented), release/tag flow, the existing `check`/`publish-updater`/`publish-nexus`/Nexus-triage jobs.

---

### Task 1: Dev data isolation — version-driven `app_dir_name()`

**Goal:** Dev builds (version contains `-dev`) read/write a separate `sts2-mod-manager-dev` data dir so testing never touches the release app's settings/modpacks/profiles/cache/logs.

**Files:**
- Modify: `src-tauri/src/state.rs` (add helpers + use them at lines ~142 and ~151)
- Modify: `src-tauri/src/lib.rs` (use the helper at line ~82)

**Acceptance Criteria:**
- [ ] `dir_name_for("1.6.1")` returns `"sts2-mod-manager"`
- [ ] `dir_name_for("1.6.1-dev.pr42.ga1b2c3d")` returns `"sts2-mod-manager-dev"`
- [ ] `config_path` and `cache_path` in `state.rs` use `app_dir_name()` (not the literal)
- [ ] `lib.rs` logging dir uses `crate::state::app_dir_name()`
- [ ] `STS2_CONFIG_DIR` / `STS2_CACHE_DIR` env overrides still take precedence (unchanged)
- [ ] `cargo test` passes including the two new tests

**Verify:** `cargo test --manifest-path=src-tauri/Cargo.toml dir_name_for` → 2 passing tests

**Steps:**

- [ ] **Step 1: Add the helpers + tests to `src-tauri/src/state.rs`**

Insert this block immediately before `pub type AppState = Arc<Mutex<AppStateInner>>;` (around line 125):

```rust
/// On-disk directory name for app data. Dev builds (version contains "-dev")
/// use a separate dir so testing never touches the release app's settings,
/// mod_sources.json, profiles/modpacks, cache, or logs. Release builds are
/// byte-for-byte unaffected. The QA env overrides (STS2_CONFIG_DIR /
/// STS2_CACHE_DIR) still take precedence at the call sites below.
pub fn app_dir_name() -> &'static str {
    dir_name_for(env!("CARGO_PKG_VERSION"))
}

/// Pure mapping from a version string to the data-dir name. Testable without a
/// build. Any version containing "-dev" (e.g. "1.6.1-dev.pr42.ga1b2c3d") maps
/// to the dev dir.
pub fn dir_name_for(version: &str) -> &'static str {
    if version.contains("-dev") {
        "sts2-mod-manager-dev"
    } else {
        "sts2-mod-manager"
    }
}

#[cfg(test)]
mod app_dir_name_tests {
    use super::dir_name_for;

    #[test]
    fn release_version_uses_base_dir() {
        assert_eq!(dir_name_for("1.6.1"), "sts2-mod-manager");
    }

    #[test]
    fn dev_version_uses_dev_dir() {
        assert_eq!(dir_name_for("1.6.1-dev.pr42.ga1b2c3d"), "sts2-mod-manager-dev");
    }
}
```

- [ ] **Step 2: Use `app_dir_name()` at the two `state.rs` path sites**

In `AppStateInner::new()`, replace the two `.join("sts2-mod-manager")` calls:

```rust
        let config_path = std::env::var("STS2_CONFIG_DIR")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::config_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(app_dir_name())
            });

        let cache_path = std::env::var("STS2_CACHE_DIR")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::cache_dir()
                    .unwrap_or_else(|| PathBuf::from(".cache"))
                    .join(app_dir_name())
            });
```

- [ ] **Step 3: Use the helper in `src-tauri/src/lib.rs`**

Replace lines 80–82:

```rust
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join(crate::state::app_dir_name());
```

(If `app_dir_name` isn't already reachable as `crate::state::app_dir_name`, confirm `state` is a `pub mod` in lib.rs — it is, per the existing `updater`/`mods` pub-mod pattern. No other change needed.)

- [ ] **Step 4: Run the tests**

Run: `cargo test --manifest-path=src-tauri/Cargo.toml dir_name_for`
Expected: `test result: ok. 2 passed` (the two `app_dir_name_tests`).

Then a fuller check: `cargo check --manifest-path=src-tauri/Cargo.toml` → no errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/lib.rs
git commit -m "$(cat <<'EOF'
feat(dev-builds): isolate dev app-data via version-driven app_dir_name()

Dev builds (version contains -dev) use sts2-mod-manager-dev for config +
cache so testing never touches the release app's settings, mod_sources,
profiles/modpacks, cache, or logs. Pure dir_name_for() is unit-tested;
app_dir_name() wraps it with CARGO_PKG_VERSION. STS2_CONFIG_DIR/
STS2_CACHE_DIR overrides still take precedence. Release builds unaffected.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `dev-build-stamp.mjs` — version compute, file stamp, comment render

**Goal:** A Node script exposing pure, tested functions to compute the dev version, rewrite version+identity in the build manifests, and render the sticky PR comment — plus a `--stamp` CLI the workflow calls.

**Files:**
- Create: `scripts/dev-build-stamp.mjs`
- Create: `scripts/dev-build-stamp.test.mjs`

**Acceptance Criteria:**
- [ ] `computeDevVersion("1.6.1", "42", "a1b2c3d")` → `"1.6.1-dev.pr42.ga1b2c3d"`
- [ ] All-digit short sha (`"0123456"`) yields `"1.6.1-dev.pr42.g0123456"` (g-prefix keeps it valid SemVer)
- [ ] `stampFiles(version, {confPath, cargoPath})` rewrites `version` + `identifier`→`com.sts2mm.app.dev` + `productName`→`STS2 Mod Manager (Dev)` in tauri.conf.json, and the `[package]` version in Cargo.toml; every other key byte-intact
- [ ] `renderDevComment(...)` includes the hidden marker, version, sha, run URL, every asset link, and the isolation reminder; empty assets → a "no artifacts" line
- [ ] `--stamp` reads base version from tauri.conf.json, requires `DEV_PR_NUMBER`+`DEV_SHORT_SHA` env, writes both files, prints the stamped version to stdout
- [ ] Module importable without running `main` (tests import functions)
- [ ] No silent-skip patterns; every test asserts

**Verify:** `node --test scripts/dev-build-stamp.test.mjs` → all tests pass

**Steps:**

- [ ] **Step 1: Write failing tests `scripts/dev-build-stamp.test.mjs`**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeDevVersion,
  stampFiles,
  renderDevComment,
} from './dev-build-stamp.mjs';

test('computeDevVersion builds the g-prefixed pre-release string', () => {
  assert.equal(computeDevVersion('1.6.1', '42', 'a1b2c3d'), '1.6.1-dev.pr42.ga1b2c3d');
});

test('computeDevVersion keeps valid SemVer for all-digit shas', () => {
  // A bare numeric pre-release identifier with a leading zero is INVALID
  // SemVer; the g-prefix makes it alphanumeric and therefore valid.
  assert.equal(computeDevVersion('1.6.1', '42', '0123456'), '1.6.1-dev.pr42.g0123456');
});

test('stampFiles rewrites version + identity in conf, version in cargo, nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devstamp-'));
  try {
    const confPath = join(dir, 'tauri.conf.json');
    const cargoPath = join(dir, 'Cargo.toml');
    writeFileSync(confPath, JSON.stringify({
      productName: 'STS2 Mod Manager',
      version: '1.6.1',
      identifier: 'com.sts2mm.app',
      app: { windows: [{ title: 'STS2 Mod Manager' }] },
    }, null, 2) + '\n', 'utf-8');
    writeFileSync(cargoPath,
      '[package]\nname = "sts2-mod-manager"\nversion = "1.6.1"\nedition = "2021"\n\n' +
      '[dependencies]\nserde = { version = "1.0" }\n', 'utf-8');

    stampFiles('1.6.1-dev.pr42.ga1b2c3d', { confPath, cargoPath });

    const conf = JSON.parse(readFileSync(confPath, 'utf-8'));
    assert.equal(conf.version, '1.6.1-dev.pr42.ga1b2c3d');
    assert.equal(conf.identifier, 'com.sts2mm.app.dev');
    assert.equal(conf.productName, 'STS2 Mod Manager (Dev)');
    // Untouched nested key stays intact
    assert.equal(conf.app.windows[0].title, 'STS2 Mod Manager');

    const cargo = readFileSync(cargoPath, 'utf-8');
    assert.match(cargo, /^version = "1\.6\.1-dev\.pr42\.ga1b2c3d"$/m, 'package version stamped');
    assert.match(cargo, /serde = \{ version = "1\.0" \}/, 'dependency version untouched');
    assert.match(cargo, /name = "sts2-mod-manager"/, 'other package keys intact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderDevComment includes marker, metadata, every asset, isolation note', () => {
  const out = renderDevComment({
    pr: '42',
    version: '1.6.1-dev.pr42.ga1b2c3d',
    sha: 'a1b2c3d',
    runUrl: 'https://github.com/x/y/actions/runs/123',
    assets: [
      { platform: 'Windows (portable)', name: 'STS2.Mod.Manager_dev_portable.zip', url: 'https://e/p.zip' },
      { platform: 'macOS', name: 'app.dmg', url: 'https://e/a.dmg' },
    ],
  });
  assert.match(out, /<!-- dev-build-comment -->/);
  assert.match(out, /1\.6\.1-dev\.pr42\.ga1b2c3d/);
  assert.match(out, /a1b2c3d/);
  assert.match(out, /actions\/runs\/123/);
  assert.match(out, /STS2\.Mod\.Manager_dev_portable\.zip/);
  assert.match(out, /app\.dmg/);
  assert.match(out, /sts2-mod-manager-dev/);
  assert.match(out, /portable/i);
});

test('renderDevComment with no assets shows a no-artifacts line', () => {
  const out = renderDevComment({ pr: '7', version: 'x', sha: 'y', runUrl: 'z', assets: [] });
  assert.match(out, /<!-- dev-build-comment -->/);
  assert.match(out, /no build artifacts/i);
});
```

- [ ] **Step 2: Run tests, confirm failure** — `node --test scripts/dev-build-stamp.test.mjs` (functions not exported yet).

- [ ] **Step 3: Implement `scripts/dev-build-stamp.mjs`**

```js
// scripts/dev-build-stamp.mjs
// Pure helpers + CLI for per-PR dev builds (sub-project D).
// Spec: docs/superpowers/specs/2026-05-28-per-pr-dev-builds-design.md
//
// --stamp mode (called by build.yml on labeled-PR builds): reads the base
// version from src-tauri/tauri.conf.json, computes a dev version from
// DEV_PR_NUMBER + DEV_SHORT_SHA env vars, rewrites version + dev identity into
// tauri.conf.json + Cargo.toml (runner-only, never committed), prints the
// stamped version to stdout.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEV_COMMENT_MARKER = '<!-- dev-build-comment -->';
const RELEASE_IDENTIFIER = 'com.sts2mm.app';
const DEV_IDENTIFIER = 'com.sts2mm.app.dev';
const RELEASE_PRODUCT = 'STS2 Mod Manager';
const DEV_PRODUCT = 'STS2 Mod Manager (Dev)';

/** base="1.6.1", pr="42", sha="a1b2c3d" -> "1.6.1-dev.pr42.ga1b2c3d".
 *  The g-prefix on the sha guarantees a valid SemVer pre-release identifier
 *  even when the short sha is all digits with a leading zero. */
export function computeDevVersion(base, prNumber, shortSha) {
  return `${base}-dev.pr${prNumber}.g${shortSha}`;
}

/** Rewrite version + dev identity in tauri.conf.json, package version in
 *  Cargo.toml. Regex-based to preserve file formatting; only the targeted
 *  keys change. */
export function stampFiles(version, {
  confPath = 'src-tauri/tauri.conf.json',
  cargoPath = 'src-tauri/Cargo.toml',
} = {}) {
  let conf = readFileSync(confPath, 'utf-8');
  conf = conf.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  conf = conf.replace(
    new RegExp(`("identifier"\\s*:\\s*")${RELEASE_IDENTIFIER.replace(/\./g, '\\.')}(")`),
    `$1${DEV_IDENTIFIER}$2`,
  );
  conf = conf.replace(
    new RegExp(`("productName"\\s*:\\s*")${RELEASE_PRODUCT}(")`),
    `$1${DEV_PRODUCT}$2`,
  );
  writeFileSync(confPath, conf, 'utf-8');

  // Scope the version rewrite to the [package] block so a dependency's
  // `version = "..."` is never touched.
  let cargo = readFileSync(cargoPath, 'utf-8');
  cargo = cargo.replace(
    /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]*(")/,
    `$1${version}$2`,
  );
  writeFileSync(cargoPath, cargo, 'utf-8');
}

/** Render the sticky PR comment body. assets: [{platform, name, url}]. */
export function renderDevComment({ pr, version, sha, runUrl, assets }) {
  const lines = [
    DEV_COMMENT_MARKER,
    `### Dev build for PR #${pr}`,
    '',
    `**Version:** \`${version}\``,
    `**Commit:** \`${sha}\``,
    `**Build run:** ${runUrl}`,
    '',
    '**Downloads:**',
  ];
  if (!assets || assets.length === 0) {
    lines.push('- _No build artifacts found for this run (a platform leg may have failed — see the run)._');
  } else {
    for (const a of assets) lines.push(`- **${a.platform}:** [${a.name}](${a.url})`);
  }
  lines.push('');
  lines.push(
    '> Installs as **STS2 Mod Manager (Dev)** alongside your release app and uses an ' +
    'isolated `sts2-mod-manager-dev` data dir — your release settings/modpacks/profiles ' +
    'are untouched. For multiple dev builds at once, use the portable `.exe` (no install).',
  );
  return lines.join('\n');
}

function runStamp() {
  const pr = process.env.DEV_PR_NUMBER;
  const sha = process.env.DEV_SHORT_SHA;
  if (!pr || !sha) {
    console.error('dev-build-stamp: DEV_PR_NUMBER and DEV_SHORT_SHA env vars are required for --stamp');
    process.exit(2);
  }
  const conf = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf-8'));
  const version = computeDevVersion(conf.version, pr, sha);
  stampFiles(version);
  // Workflow captures stdout as the stamped version.
  console.log(version);
}

const isMainModule = fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  const argv = process.argv.slice(2);
  if (argv.includes('--stamp')) {
    runStamp();
  } else {
    console.error('usage: node scripts/dev-build-stamp.mjs --stamp');
    process.exit(2);
  }
}
```

- [ ] **Step 4: Run tests, verify pass** — `node --test scripts/dev-build-stamp.test.mjs` → all 5 pass.

- [ ] **Step 5: Wire into CI's check job** (so the tests run on every PR). In `.github/workflows/build.yml`, after the existing `- name: Test nexus-triage script` step in the `check` job, add:

```yaml
      - name: Test dev-build-stamp script
        run: node --test scripts/dev-build-stamp.test.mjs
```

- [ ] **Step 6: Commit**

```bash
git add scripts/dev-build-stamp.mjs scripts/dev-build-stamp.test.mjs .github/workflows/build.yml
git commit -m "$(cat <<'EOF'
feat(dev-builds): dev-build-stamp.mjs (version compute, file stamp, comment)

Pure tested helpers: computeDevVersion (g-prefixed SemVer-safe pre-release),
stampFiles (version + com.sts2mm.app.dev identifier + "(Dev)" productName in
tauri.conf.json; [package] version in Cargo.toml, dependency versions
untouched), renderDevComment (sticky PR comment w/ marker + per-platform
links + isolation note). --stamp CLI reads base from tauri.conf.json. Wired
into the check job.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: build.yml — labeled-PR gate + stamp step + dev portable + artifact paths

**Goal:** A `dev-build`-labeled PR runs the `build` matrix, stamps the dev version+identity before `tauri-action`, builds the Windows portable zip for dev, and uploads all bundles (incl. portable) as artifacts.

**Files:**
- Modify: `.github/workflows/build.yml` (build job `if:`, new stamp step, new dev-portable step, artifact paths)

**Acceptance Criteria:**
- [ ] `build` job `if:` also fires for `pull_request` events carrying the `dev-build` label; tag + workflow_dispatch behavior unchanged
- [ ] A "Stamp dev version" step runs before "Build Tauri app", only for labeled-PR builds, and stamps via `node scripts/dev-build-stamp.mjs --stamp`
- [ ] A dev-only Windows portable-zip step produces `STS2.Mod.Manager_<devversion>_x64_portable.zip` at repo root (no `gh release upload` — publish-dev handles it)
- [ ] The "Upload build artifacts" step's paths include the root `*_x64_portable.zip`
- [ ] `build.yml` parses as valid YAML
- [ ] Release/tag path is byte-unchanged (existing tag portable step + uploads still tag-gated)

**Verify:** `python -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml')); print('OK')"` → `OK`

**Steps:**

- [ ] **Step 1: Add a reusable label condition + widen the `build` gate.** Replace the `build` job's `if:` (line ~76):

```yaml
  build:
    if: >-
      ${{ startsWith(github.ref, 'refs/tags/v')
          || github.event_name == 'workflow_dispatch'
          || (github.event_name == 'pull_request'
              && contains(github.event.pull_request.labels.*.name, 'dev-build')) }}
```

- [ ] **Step 2: Add the stamp step before "Build Tauri app".** Immediately before the `- name: Build Tauri app` step (line ~137), insert:

```yaml
      - name: Stamp dev version + identity (labeled-PR dev builds only)
        if: ${{ github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'dev-build') }}
        shell: bash
        env:
          DEV_PR_NUMBER: ${{ github.event.pull_request.number }}
          DEV_HEAD_SHA: ${{ github.event.pull_request.head.sha }}
        run: |
          SHORT=$(printf '%s' "$DEV_HEAD_SHA" | cut -c1-7)
          DEV_PR_NUMBER="$DEV_PR_NUMBER" DEV_SHORT_SHA="$SHORT" \
            node scripts/dev-build-stamp.mjs --stamp
```

(Node is already installed by the earlier "Install Node.js" step; the script uses only `node:` builtins so it runs before/without `npm ci`.)

- [ ] **Step 3: Add a dev-only Windows portable step.** After the existing `- name: Package portable zip (Windows only)` step (the tag-gated one ending ~line 186), add a sibling for dev builds:

```yaml
      - name: Package portable zip (dev builds, Windows only)
        if: matrix.platform == 'windows-latest' && github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'dev-build')
        shell: pwsh
        run: |
          # Read the (already dev-stamped) version from tauri.conf.json.
          $conf = Get-Content 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json
          $version = $conf.version

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
          Copy-Item $exe.FullName (Join-Path $staging 'STS2 Mod Manager (Dev).exe')
          Copy-Item scripts/portable-README.txt (Join-Path $staging 'README.txt')

          # Repo-root zip; the artifact-upload step captures it. No gh release
          # upload here — publish-dev attaches it to the dev-pr<N> prerelease.
          $zip = "STS2.Mod.Manager_${version}_x64_portable.zip"
          Compress-Archive -Path "$staging/*" -DestinationPath $zip -Force
```

- [ ] **Step 4: Add the portable zip to the artifact paths.** In the `- name: Upload build artifacts` step (path list ~line 209), add the repo-root portable zip as the final path entry:

```yaml
            src-tauri/target/universal-apple-darwin/release/bundle/**/*.dmg
            STS2.Mod.Manager_*_x64_portable.zip
```

(The step's `if: ${{ !startsWith(github.ref, 'refs/tags/v') }}` already fires for PR builds. `if-no-files-found: warn` means tag builds — where the root zip lives but this step is skipped anyway — are unaffected.)

- [ ] **Step 5: Validate YAML**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml')); print('OK')"`
Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "$(cat <<'EOF'
ci(dev-builds): build labeled PRs — stamp dev version/identity + portable

Widen the build gate to fire on pull_request events carrying the dev-build
label (tag + dispatch unchanged). Before tauri-action, stamp the dev
version + com.sts2mm.app.dev identity via dev-build-stamp.mjs. Add a
dev-only Windows portable-zip step (no gh upload — publish-dev handles it)
and include the root portable zip in the uploaded artifacts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: build.yml — `publish-dev` job (rolling prerelease + sticky comment)

**Goal:** After the matrix builds, gather all platform artifacts into a rolling `dev-pr<N>` prerelease (assets replaced each run) and upsert a sticky PR comment with download links.

**Files:**
- Modify: `.github/workflows/build.yml` (new `publish-dev` job)

**Acceptance Criteria:**
- [ ] New `publish-dev` job, `needs: build`, runs only for labeled-PR dev builds
- [ ] Downloads all `binaries-*` artifacts
- [ ] Creates-or-updates prerelease tag `dev-pr<N>` (`--prerelease`), title `Dev build — PR #<N> (g<shortsha>)`, replacing assets
- [ ] Upserts a sticky PR comment (found by `<!-- dev-build-comment -->`) via `renderDevComment` output, listing per-platform asset links
- [ ] `permissions: contents: write, pull-requests: write` on the job
- [ ] `build.yml` parses as valid YAML

**Verify:** `python -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml')); print('OK')"` → `OK`

**Steps:**

- [ ] **Step 1: Append the `publish-dev` job** at the end of `build.yml` (sibling to `publish-updater` / `publish-nexus`):

```yaml
  publish-dev:
    if: ${{ github.event_name == 'pull_request' && contains(github.event.pull_request.labels.*.name, 'dev-build') }}
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
    steps:
      - name: Checkout repository
        uses: actions/checkout@v5

      - name: Setup Node
        uses: actions/setup-node@v5
        with:
          node-version: "22"

      - name: Download all build artifacts
        uses: actions/download-artifact@v5
        with:
          path: dev-artifacts

      - name: Publish rolling dev prerelease + sticky PR comment
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REPO: ${{ github.repository }}
          PR: ${{ github.event.pull_request.number }}
          HEAD_SHA: ${{ github.event.pull_request.head.sha }}
          RUN_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
        run: |
          set -euo pipefail
          SHORT=$(printf '%s' "$HEAD_SHA" | cut -c1-7)
          TAG="dev-pr${PR}"

          # Flatten downloaded artifacts into one dir of release-able files.
          mkdir -p dist
          find dev-artifacts -type f \
            \( -name '*.exe' -o -name '*.msi' -o -name '*.dmg' -o -name '*.deb' \
               -o -name '*.rpm' -o -name '*.AppImage' -o -name '*_portable.zip' \) \
            -exec cp -f {} dist/ \;
          echo "Collected assets:"; ls -1 dist || true

          # Recreate the rolling prerelease so its assets are exactly this run's.
          if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
            gh release delete "$TAG" --repo "$REPO" --yes
          fi
          # Delete any leftover tag so create starts clean.
          git push origin ":refs/tags/$TAG" 2>/dev/null || true

          gh release create "$TAG" dist/* \
            --repo "$REPO" \
            --prerelease \
            --target "$HEAD_SHA" \
            --title "Dev build — PR #${PR} (g${SHORT})" \
            --notes "Automated dev build for PR #${PR}. Prerelease — not for end users."

          # Build the sticky comment body via the tested renderer.
          node -e '
            import("./scripts/dev-build-stamp.mjs").then(async (m) => {
              const { execSync } = await import("node:child_process");
              const repo = process.env.REPO, tag = "dev-pr" + process.env.PR;
              const raw = execSync(`gh release view ${tag} --repo ${repo} --json assets,tagName`, {encoding:"utf-8"});
              const rel = JSON.parse(raw);
              const platformOf = (n) => /portable\.zip$/i.test(n) ? "Windows (portable)"
                : /-setup\.exe$|\.msi$/i.test(n) ? "Windows (installer)"
                : /\.dmg$/i.test(n) ? "macOS"
                : /\.deb$/i.test(n) ? "Linux (.deb)"
                : /\.rpm$/i.test(n) ? "Linux (.rpm)"
                : /\.AppImage$/i.test(n) ? "Linux (AppImage)" : "Other";
              const base = `https://github.com/${repo}/releases/download/${tag}`;
              const assets = (rel.assets||[]).map(a => ({ platform: platformOf(a.name), name: a.name, url: `${base}/${encodeURIComponent(a.name)}` }))
                .sort((a,b)=>a.platform.localeCompare(b.platform));
              // version = the stamped one we just built (read from a portable asset name or tauri.conf base + suffix)
              const conf = JSON.parse((await import("node:fs")).readFileSync("src-tauri/tauri.conf.json","utf-8"));
              const version = `${conf.version}-dev.pr${process.env.PR}.g${process.env.HEAD_SHA.slice(0,7)}`;
              const body = m.renderDevComment({ pr: process.env.PR, version, sha: process.env.HEAD_SHA.slice(0,7), runUrl: process.env.RUN_URL, assets });
              (await import("node:fs")).writeFileSync("dev-comment.md", body);
            });
          '

          # Upsert: find an existing sticky comment by marker, edit or create.
          MARKER="<!-- dev-build-comment -->"
          CID=$(gh api "repos/${REPO}/issues/${PR}/comments" --jq \
            "[.[] | select(.body | contains(\"${MARKER}\"))][0].id // empty")
          if [ -n "$CID" ]; then
            gh api -X PATCH "repos/${REPO}/issues/comments/${CID}" -F body=@dev-comment.md >/dev/null
            echo "Updated sticky comment $CID"
          else
            gh pr comment "$PR" --repo "$REPO" --body-file dev-comment.md
            echo "Created sticky comment"
          fi
```

Note: `conf.version` read here is the **committed** base (e.g. `1.6.1`) because this job checks out the PR fresh (it does not run the stamp step), so the version is reconstructed as `${base}-dev.pr${PR}.g${short}` — matching what the build legs stamped.

- [ ] **Step 2: Validate YAML**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/build.yml')); print('OK')"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/build.yml
git commit -m "$(cat <<'EOF'
ci(dev-builds): publish-dev job — rolling prerelease + sticky PR comment

After the matrix builds, gather all platform artifacts, (re)create the
rolling dev-pr<N> prerelease (assets = this run's), and upsert a sticky
PR comment (keyed by <!-- dev-build-comment -->) with per-platform
download links rendered by dev-build-stamp.mjs renderDevComment.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `dev-build-cleanup.yml` — delete dev prerelease on PR close

**Goal:** When a PR closes (merged or not), delete its `dev-pr<N>` prerelease + tag so the Releases page stays bounded to open labeled PRs.

**Files:**
- Create: `.github/workflows/dev-build-cleanup.yml`

**Acceptance Criteria:**
- [ ] Triggers on `pull_request: types: [closed]`
- [ ] Deletes release `dev-pr<N>` + its tag, idempotent (no-op if none exists)
- [ ] `permissions: contents: write`
- [ ] YAML parses

**Verify:** `python -c "import yaml; yaml.safe_load(open('.github/workflows/dev-build-cleanup.yml')); print('OK')"` → `OK`

**Steps:**

- [ ] **Step 1: Create `.github/workflows/dev-build-cleanup.yml`**

```yaml
name: Dev build cleanup

on:
  pull_request:
    types: [closed]

permissions:
  contents: write

jobs:
  cleanup:
    runs-on: ubuntu-latest
    steps:
      - name: Delete the PR's dev prerelease + tag (if any)
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          REPO: ${{ github.repository }}
          PR: ${{ github.event.pull_request.number }}
        run: |
          TAG="dev-pr${PR}"
          if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
            gh release delete "$TAG" --repo "$REPO" --cleanup-tag --yes
            echo "Deleted dev prerelease $TAG"
          else
            echo "No dev prerelease $TAG — nothing to clean up."
          fi
```

- [ ] **Step 2: Validate YAML**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/dev-build-cleanup.yml')); print('OK')"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/dev-build-cleanup.yml
git commit -m "$(cat <<'EOF'
ci(dev-builds): delete dev-pr<N> prerelease + tag when the PR closes

Keeps the Releases page bounded to open labeled PRs. Idempotent — a no-op
when the PR never had a dev build.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Create the `dev-build` label + end-to-end verification

**Goal:** Prove the full pipeline end-to-end on a real throwaway PR: label → 3-platform build → `dev-pr<N>` prerelease + sticky comment → the Windows build writes to `sts2-mod-manager-dev/` → PR close deletes the prerelease.

**USER-ORDERED GATE — NON-SKIPPABLE.** This task was requested by the user in the current conversation. It MUST NOT be closed by walking around it, by declaring it "verified inline", or by substituting a cheaper check. Close only after every item in `acceptanceCriteria` has been re-validated independently, with output captured.

**Files:**
- None (operational verification; uses `gh` + a throwaway branch/PR)

**Acceptance Criteria:**
- [ ] `dev-build` label exists in the repo (`gh label list` shows it)
- [ ] A throwaway PR labeled `dev-build` produces a `dev-pr<N>` prerelease with Windows + macOS + Linux assets (`gh release view dev-pr<N>` lists them)
- [ ] The PR has a sticky comment containing `<!-- dev-build-comment -->` + per-platform download links
- [ ] The downloaded Windows portable build, when run, creates/writes `…/sts2-mod-manager-dev/` (NOT the release `sts2-mod-manager/` dir) — confirmed by the maintainer on their machine
- [ ] Closing the throwaway PR deletes the `dev-pr<N>` prerelease (`gh release view dev-pr<N>` → not found)

**Verify:** `gh release view dev-pr<N> --repo MohamedSerhan/sts2-mod-manager --json assets --jq '.assets[].name'` lists 3 platforms while the PR is open; returns "release not found" after close.

**Steps:**

- [ ] **Step 1: Create the label**

```bash
gh label create dev-build \
  --color FBCA04 \
  --description "Build installable dev artifacts for this PR" \
  --repo MohamedSerhan/sts2-mod-manager
```

- [ ] **Step 2: Open a throwaway PR**

```bash
git switch -c dev-build-smoke
git commit --allow-empty -m "test: dev-build pipeline smoke"
git push -u origin dev-build-smoke
gh pr create --repo MohamedSerhan/sts2-mod-manager --title "Dev build smoke test" \
  --body "Throwaway PR to verify the per-PR dev build pipeline. Safe to close." --base main
```

- [ ] **Step 3: Label it + watch the build**

```bash
PR=$(gh pr view dev-build-smoke --repo MohamedSerhan/sts2-mod-manager --json number --jq .number)
gh pr edit "$PR" --repo MohamedSerhan/sts2-mod-manager --add-label dev-build
# Wait for the build + publish-dev to finish:
gh run watch "$(gh run list --repo MohamedSerhan/sts2-mod-manager --workflow='Build & Release' --limit 1 --json databaseId --jq '.[0].databaseId')" --repo MohamedSerhan/sts2-mod-manager
```

- [ ] **Step 4: Verify prerelease + comment**

```bash
gh release view "dev-pr${PR}" --repo MohamedSerhan/sts2-mod-manager --json assets --jq '.assets[].name'   # expect win + mac + linux
gh pr view "$PR" --repo MohamedSerhan/sts2-mod-manager --json comments --jq '.comments[-1].body' | grep -c 'dev-build-comment'   # expect 1
```

- [ ] **Step 5: Maintainer manual check (data isolation)**

Download the portable zip from the prerelease, extract, run `STS2 Mod Manager (Dev).exe`, then confirm a `sts2-mod-manager-dev` directory appeared under `%APPDATA%` (Windows) and the release `sts2-mod-manager` dir was untouched:

```powershell
dir "$env:APPDATA\sts2-mod-manager-dev"   # should exist after launching the dev build
```

- [ ] **Step 6: Close the PR + verify cleanup**

```bash
gh pr close "$PR" --repo MohamedSerhan/sts2-mod-manager --delete-branch
sleep 20
gh release view "dev-pr${PR}" --repo MohamedSerhan/sts2-mod-manager 2>&1 | grep -qi 'not found' && echo "CLEANUP OK"
```

No commit (verification only).

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Label-gated trigger | Task 3 (gate) |
| All 3 platforms, fail-fast:false | Task 3 (existing matrix unchanged) |
| Version stamp `…-dev.pr<N>.g<sha>` | Task 2 (compute) + Task 3 (step) |
| Distinct dev identity (identifier + productName) | Task 2 (stampFiles) |
| Data isolation `app_dir_name()` | Task 1 |
| Rolling per-PR prerelease | Task 4 |
| Sticky PR comment | Task 2 (render) + Task 4 (upsert) |
| Portable build for side-by-side | Task 3 (dev-portable step) |
| Cleanup on PR close | Task 5 |
| Updater nag left documented (no App.tsx touch) | (intentionally no task) |
| Keyring shared (no change) | (intentionally no task) |
| Tests: stamp logic, app_dir_name, YAML | Tasks 1, 2, 3, 4, 5 |
| End-to-end verification | Task 6 |

All spec requirements covered. No placeholders. Type/name consistency: `app_dir_name`/`dir_name_for` (Task 1) consistent; `computeDevVersion`/`stampFiles`/`renderDevComment` + `DEV_COMMENT_MARKER` consistent across Tasks 2/4; tag `dev-pr<N>` consistent across Tasks 4/5/6.

---

## Acknowledgements

Plan + spec live on `main` (the spec was committed at `69295b2` / `0db85ef`; sub-project A is already merged here). The stale `optimistic-thompson-a5dc4c` worktree (33+ commits behind `main`) is **not** to be reused — execution should happen in a **fresh worktree branched off current `main`**, per the maintainer's worktree-first preference.

This plan touches `src-tauri/src/{state,lib}.rs` — small, surgical, but no longer zero-overlap with the 1.7.0 redesign branch (`happy-lovelace-2ad8bc`), as accepted in the spec.
