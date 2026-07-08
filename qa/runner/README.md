# WebDriver test runner

End-to-end UI tests for the Mod Manager. Drives a real Tauri window
via the platform WebDriver. **Not shipped** — same as the rest of
`qa/`, this lives outside `src/` and `src-tauri/`.

## The driver stack

```
   smoke.mjs (selenium-webdriver client)
              │ HTTP, port 4444
              ▼
        tauri-driver                ← acts as a proxy + launches the app
              │ HTTP, port 4445
              ▼
        native WebDriver            ← msedgedriver on Windows, WebKitWebDriver on Linux
              │
              ▼
   built Tauri app
```

`tauri-driver` is a small Rust binary you `cargo install` once. It
launches the Tauri app under test, then forwards WebDriver commands
from your test client to the platform-native driver. Windows uses
`msedgedriver`, which must match your WebView2 runtime version. Linux
uses `WebKitWebDriver` from the WebKitGTK driver package.

## One-time setup

1. **`tauri-driver`** — installed via `cargo install tauri-driver`.
   This repo's CI does that; locally run:

   ```bash
   cargo install tauri-driver
   ```

2. **Native WebDriver**

   On Windows, `msedgedriver` must match your WebView2 runtime EXACTLY.

   Check the version that's on this machine:

   ```powershell
   Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*' \
     | Where-Object { $_.name -eq 'Microsoft Edge WebView2 Runtime' } \
     | Select-Object pv
   ```

   On this machine right now: **148.0.3967.54** (bumps every few
   weeks as WebView2 auto-updates).

   Easiest: run the auto-fetcher, which reads the version out of the
   registry and pulls the matching driver from Microsoft's CDN:

   ```bash
   node qa/runner/scripts/download-msedgedriver.mjs
   ```

   Idempotent — re-running with the right version already installed
   prints "already at X — nothing to do." and exits.

   Manual fallback: download the driver from
   <https://developer.microsoft.com/en-us/microsoft-edge/tools/webdriver/>
   and extract `msedgedriver.exe` to `qa/runner/msedgedriver.exe`. The
   runner expects it at exactly that path.

   On Ubuntu/Linux, install WebKitGTK's driver:

   ```bash
   sudo apt-get install webkit2gtk-driver
   ```

3. **App build** — the runner drives the **release build** of the
   manager (not the dev server — webdriver against `tauri dev`
   doesn't work reliably because Vite HMR fights with the headless
   driver). Build once:

   ```bash
   npm run tauri build
   ```

   The runner picks up
   `src-tauri/target/release/sts2-mod-manager.exe` on Windows or
   `src-tauri/target/release/sts2-mod-manager` on Linux.

## Running

```bash
node qa/runner/smoke.mjs
```

Local smoke runs default to **low-disruption mode**: Windows child
processes are launched with hidden consoles, and the Tauri test window is
moved off-screen as soon as the WebDriver session starts so it does not
steal focus from the developer's current desktop work. To watch the app
window while debugging, opt into visible mode:

```bash
STS2_SMOKE_VISIBLE=1 node qa/runner/smoke.mjs
```

Exits 0 on success, non-zero with a stack trace on failure.

### Cassette mode (CASSETTE=1)

When `CASSETTE=1` is set, the runner exports
`STS2_CASSETTE_DIR=<repo>/qa/fixtures` to the launched app and appends
the cassette-only specs to the suite. The app binary MUST have been
built with the `qa-cassette` Cargo feature, otherwise the env var is a
no-op (the cfg gate in `qa_cassette::intercept_get` is compile-time):

```bash
npm run tauri build -- --no-bundle --features qa-cassette
CASSETTE=1 node qa/runner/smoke.mjs
```

Confirm the cassette took effect by grepping the app log for
`QA cassette playback ENABLED`. With it on, `audit_mod_versions` and
`check_all_updates` will read responses from `qa/fixtures/github/` and
`qa/fixtures/nexus/` instead of hitting the wire. See
`qa/fixtures/README.md` for the URL→file mapping and how to capture
new cassettes.

The integration-test side of the same plumbing lives at
`src-tauri/tests/qa_cassette.rs` (`cargo test --features qa-cassette
--test qa_cassette`) — it doesn't need WebView2 and is the fastest way
to verify the intercept didn't regress.

## What the smoke test does

`smoke.mjs` covers the end-to-end "does the app launch and respond
to clicks" check that no Rust unit test can ever catch:

1. Spawns `tauri-driver` with `--native-driver qa/runner/msedgedriver.exe` on Windows or `--native-driver WebKitWebDriver` on Linux.
2. Connects via `selenium-webdriver` over HTTP.
3. Waits for the manager's main window to render.
4. Finds the sidebar's "Mods" nav button and clicks it.
5. Finds the "Check for updates" button on the Mods toolbar (the new
   audit surface — Mods view, not Settings).
6. Verifies the button is clickable, not disabled by the
   `gameRunning` state.
7. Tears down cleanly.

The first run prints every WebDriver step so you can see what's
happening. Subsequent specs (under `specs/`) can use the
`launchManager()` helper exported from `smoke.mjs` for setup.

## Why not WebdriverIO

Tauri's own docs recommend either `selenium-webdriver` (npm package,
~3MB) OR WebdriverIO (`@wdio/*` family, 30+ MB). WebdriverIO is
nicer for large test suites; for the handful of UI scenarios this
project needs, the raw Selenium client keeps dependencies + setup
small and aligns with the upstream Tauri example at
<https://tauri.app/develop/tests/webdriver/example/selenium/>.

If the suite grows past ~20 specs, switch to WebdriverIO.

## CI integration

`.github/workflows/ci.yml` runs the cassette smoke on both Windows
(WebView2/msedgedriver) and Ubuntu (WebKitGTK/WebKitWebDriver). The
Windows job downloads the matching `msedgedriver`; the Linux job
installs `webkit2gtk-driver` and runs the smoke under `xvfb-run`.

## When tests fail

The runner saves a screenshot to `qa/runner/last-failure.png` and
the full WebDriver log to `qa/runner/last-failure.log`. Both are
git-ignored.
