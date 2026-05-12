# What's left — QA backlog

Snapshot of unfinished QA work at the time of the v1.3.4 cut. Each
item lists what it costs to do and why we deferred it. Pick from
here when there's a slow week or after a user reports something
related.

## Tier 2 WebDriver scenarios (UI specs, beyond the 6 smoke)

The smoke suite proves the app launches and the new surfaces render.
The next round drives the actual interactions:

- **Toggle a mod off → verify it's in `mods_disabled/`** — needs a
  test mod set up in the fake game install before launch. Maybe 1
  hour to wire up a fixture-game-path env var so the smoke harness
  can point the manager at a tempdir.
- **Pin a mod → click "Check for updates" → verify the row is
  excluded from the pending count** — depends on audit running
  against a cassette (see below).
- **Drag-drop a .zip onto the window** — Selenium can dispatch the
  Drop event but tauri's drag-drop intercept is at the OS level.
  Might require computer-use MCP for this one.
- **Click "Update available" pill → verify spinner appears, then
  the row refreshes** — needs cassette playback so the GitHub fetch
  is deterministic.

## Cassette playback (deterministic network for WebDriver)

The audit + update + subscription flows all hit GitHub and Nexus.
Real network calls in tests are flaky, rate-limited, and bind the
test outcome to upstream state. Plan:

1. Capture real responses once via `gh api` and `curl` against
   Nexus (with redacted API keys), save to `qa/fixtures/github/`
   and `qa/fixtures/nexus/`.
2. Add an HTTP intercept layer to the Rust backend gated behind
   a build cfg (`#[cfg(feature = "qa-cassette")]`). When enabled,
   the layer routes requests to the local cassette dir instead of
   the wire.
3. Build the QA target with `cargo tauri build --features qa-cassette`
   and have the smoke harness use that binary.

Half a day of work. Unlocks every test that touches the network.

## Tier 2 scenarios for historical bugs

These are tracked in `walkthrough-findings.md` as ⚠️ "fix shipped
but no test guards it". They need Tauri state + AppHandle, which
the Rust integration tests can't easily produce. WebDriver against
the running app can.

- **#20 — Profile Repair deletes orphan disabled files.** Set up a
  mod in `mods_disabled/` that isn't in the profile manifest. Click
  Repair. Assert the file is gone.
- **#21 — Game-version-skipped mods don't pollute the saved
  snapshot.** Install a mod whose `min_game_version` exceeds the
  fake game version. Apply a profile. Re-snapshot. Assert the
  skipped mod isn't in the new snapshot.
- **#22 — Profile state is sticky after toggle.** Toggle a mod off.
  Switch to a different profile and back. Assert the toggle stuck.

Each is ~30 min once the fixture-game-path env var exists.

## Frontend parser unit tests

The TypeScript-only parsers have no tests:
- `src/lib/changelog.ts::parseChangelog` — handles `[Unreleased]`,
  versioned headings with dates, rollup headings without dates,
  HR separators, link-reference footnotes.
- `src/components/WhatsNewCard.tsx::parseSimpleMarkdown` — subheads,
  bullets, paragraphs, inline `code`, HR drop.

Both are pure functions. The blocker is no JS test framework in the
project. Cheapest path: `npm install --save-dev vitest` (~10 min),
then write `*.test.ts` siblings to each file. Probably 1-2 hours
end-to-end including CI wire-up.

## Linux + macOS support

The WebDriver harness is Windows-only today because it uses
`msedgedriver` directly. To run in CI on Linux:

- Use `tauri-driver` on Linux, which forwards to `WebKitWebDriver`.
- The capability shape is identical (`browserName: 'wry'` +
  `tauri:options.application`) — `smoke.mjs` doesn't need changes.
- CI must install WebKitGTK + WebKitWebDriver in the runner image.

macOS isn't supported by `tauri-driver` at all; skip.

## Profile sharing / subscription flows

Curator + subscriber flows hit GitHub heavily:
- Create + push `sts2mm-profiles` repo
- Upload + diff modpack bundles
- Apply share codes

WebDriver can drive these against a **mocked GitHub** (a small HTTP
server in the harness that imitates the GitHub API for the test
duration). Same shape as cassette playback but stateful — the
server has to remember what the client uploaded so subsequent
fetches see it.

Significant work (~1 day). Defer until a curator-side bug actually
reports.

## "Stale duplicate detected" follow-up

When the manager finds two mods sharing both `manifest.name` AND
`manifest.id` (signal: same mod, different folders, probably one is
stale), surface a banner on the Mods view: "We see two
'CardArtEditor' folders — the older one (v1.0.0) looks stale.
Remove?" with a one-click cleanup.

This would have made the JadeDemon scenario auto-resolving. Not a
correctness fix (the v1.3.1 changes already make the two mods
behave correctly) — purely UX. ~2 hours.

## CI integration

The WebDriver smoke is currently local-only. A reasonable CI lane:

```yaml
qa-smoke:
  runs-on: windows-latest
  steps:
    - uses: actions/checkout@v4
    - run: cargo install tauri-driver --version "^2"
    - run: npm install
    - run: npm run tauri build -- --no-bundle
    - run: node qa/runner/scripts/download-msedgedriver.mjs
    - run: node qa/runner/smoke.mjs
```

The `download-msedgedriver.mjs` script doesn't exist yet — write it
to call `edgedriver`'s `download(WEBVIEW2_VERSION)` and place the
binary at `qa/runner/msedgedriver.exe`. ~30 min.

## Notes for the agent who picks this up

- Start with **cassette playback**. It's blocking three other items.
- The smoke harness is at `qa/runner/smoke.mjs`. Tests are an array
  of `[label, fn]` pairs near the bottom — add new specs there.
- `screenshot()` + `last-failure.png` is invaluable for debugging.
  Tauri's WebView2 looks normal but small differences (e.g. an
  overlay on top) only show in the screenshot.
- Every WebDriver run uses a fresh WebView2 user-data folder, so
  state doesn't persist between runs. Use that to your advantage —
  no test-isolation bookkeeping needed.
- The onboarding wizard fires every run. `dismissOnboardingIfPresent`
  handles it. If you add a spec that expects a clean Home view, run
  it after the dismiss step.
