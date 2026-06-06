# Harness — how to execute QA scenarios

Read this first if you're an agent (Codex or otherwise) about to run scenarios from `qa/scenarios/`. It's the operating manual for the QA role.

## Your job

For every scenario in `qa/scenarios/` whose `status` is `active`, run the **Setup → Action → Assert** sequence exactly as written and produce a pass/fail report. You are not optimizing, you are not improving — you are exercising the manager the way a real user would. If a scenario seems "obviously fine," run it anyway. The whole point is that obvious tests were green when BaseLib broke.

## What you have to work with

| Capability | When to use it |
|---|---|
| Bash / Rust toolchain | Tier 1 scenarios: invoke a small harness binary in `qa/harness/runner/` (TODO — see below) that calls Tauri commands directly. |
| `tauri-driver` + WebDriver | Tier 2 scenarios: drive a real Tauri window with a hidden display. Catches frontend bugs. Setup is fragile on Windows; document failures and skip. |
| `mcp__computer-use__*` | Tier 3 scenarios: drive the real desktop. Use sparingly — slow and nondeterministic. Reserved for drag-drop / Steam launch / deep-link / `sts2mm://` cases. |
| Browser / Chrome automation | Currently unused. Could replace WebDriver if the Tauri WebView is unreachable on a given host. |

The runner binary doesn't exist yet — building it is the next concrete step (TODO #1 in `qa/harness/build-runner.md` once that's written). Until then, scenarios are exercised manually: an agent reads the markdown, performs the steps with available tools, and writes a report.

## Per-scenario protocol

1. **Read** the scenario's frontmatter. Note `tier`, `flow`, `historical_bug`.
2. **Verify pre-conditions**. If anything in the Pre-conditions block isn't actually true on this machine, **STOP** and write a Skip report explaining why. Don't muscle through — pre-condition violations make the test prove nothing.
3. **Build a fresh tempdir** for state. Never operate on the user's real game install, real `mod_sources.json`, real profiles. Every scenario gets its own world.
4. **Run Setup steps verbatim**, in order. If a step references a fixture file, hash-check it before use (provenance matters).
5. **Run Action steps verbatim**. One step at a time. Don't combine; if a scenario says two `toggle_mod` calls, do two.
6. **Check Assertions one by one**. For each, write down what you observed alongside what was expected. A passing scenario is one where EVERY assertion held.
7. **Tear down** the tempdir.
8. **Report** in the format below.

## Report format

For each scenario, produce a block like:

```
## 001 — BaseLib's BOM-prefixed manifest must yield the real version
Tier: 1
Outcome: PASS

Setup: clean
Action: get_installed_mods returned 1 entry in 12ms.
Assertions:
  ✓ exactly one entry named "BaseLib"
  ✓ version == "v3.1.2"
  ✓ author == "Alchyr"
  ✓ mod_id == "BaseLib"
  ✓ folder_name == "BaseLib"
  ✓ BaseLib.json on disk unchanged (sha256 match)
```

Failure example:
```
## 004 — Downloads-watcher respects pin
Tier: 1
Outcome: FAIL

Setup: clean
Action: watcher fired, installed BaseLib-9.9.9.zip
Assertions:
  ✗ expected watcher to emit "mod-auto-install-failed" naming BaseLib — instead emitted "mod-auto-installed"
  ✗ BaseLib.dll sha256 changed from <original> to <new>
  ✗ get_installed_mods reports BaseLib at v9.9.9 (expected v3.1.2)
  ✓ mod_sources.json BaseLib.pinned is true

Reproduction:
  1. Apply this scenario's setup.
  2. Run `cargo run --bin watcher-step` with the fake Downloads pointing at the test zip.
  3. Observe `mod-auto-installed` event.

Probable cause:
  Pin lookup in downloads_watcher.rs reverted to db.mods.get(&existing.name) at line N. The folder-first lookup_entry helper was bypassed.
```

## Things to never do

- **Never modify scenarios to make them pass.** If a scenario is wrong, mark it `status: quarantined` and write a comment in the Notes block. Don't silently soften assertions.
- **Never skip pre-condition checks.** If the fixture doesn't have a BOM at byte 0, the test is meaningless even if it passes.
- **Never run against the user's real game install.** Tempdirs only.
- **Never make network calls** to GitHub or Nexus during a run. If a scenario seems to need one, the fixture cassette is missing — fail and request a capture.

## Why a markdown harness instead of `cargo test`

Two reasons.

1. **Unit tests pass while users see bugs.** That's the recurring failure mode this project has. Markdown scenarios force us to describe the test in a user's vocabulary, which catches gaps that `#[test] fn upsert_mod_dedup_works()` doesn't.
2. **An AI agent can read markdown and act**, especially with the tool inventory above. Treating the harness as "instructions for an agent" rather than "code that calls assertions" lets us add Tier 2 (WebDriver) and Tier 3 (computer-use) scenarios that touch the parts of the system Rust unit tests can't reach.

## What's not built yet

- The Tier 1 runner binary. The plan: a small Rust executable (`qa/harness/runner/`) that imports `sts2_mod_manager_lib`, exposes a CLI for the scenario format, and exits 0/1 on pass/fail. Until that exists, Tier 1 scenarios are executed by hand or by spawning a fresh Rust integration test per scenario.
- Tier 2 WebDriver wiring. Tauri provides `tauri-driver` but the setup is host-dependent; a `.cargo/config.toml` snippet + a small Node script would set it up. Estimated: half a day.
- Cassette playback. A simple HTTP intercept layer that replays `qa/fixtures/nexus/*.json` and `qa/fixtures/github/*.json` based on the request URL. Estimated: half a day.

These are tracked as separate work items. The scenarios themselves are useful even without the automation — they're already a structured punch list.
