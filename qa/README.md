# STS2 Mod Manager — QA harness

This directory is the internal QA workspace. **Nothing under `qa/` ships with the manager binary** — it lives outside both `src/` (Vite bundle) and `src-tauri/` (Rust crate), so neither build pipeline touches it. The harness exists so an AI agent (or a human pretending to be one) can walk through the same flows real users hit, with realistic inputs, before a release lands.

## Why this exists

The recurring failure mode in this project: a bug ships, gets reported, gets fixed, and the fix is locked in with a unit test that exercises a *synthetic* version of the failure. Then a similar real-world input shows up later — same root cause, slightly different shape — and the unit test passes while users see broken behavior.

Examples:
- **BaseLib `vunknown`** — 1.3.1 shipped a "lenient parse" with a test for malformed `dependencies`. Real BaseLib failed for a different reason (UTF-8 BOM). Test passed; bug shipped.
- **Two CardArtEditors collapse** — identity logic was unit-tested; the *toggle UX with two folders on disk* wasn't.

The harness exists to fix that. Scenarios use **real fixtures** — actual manifests captured from popular mods, actual Nexus / GitHub API responses cached as JSON — and drive **real code paths**, not synthetic stubs.

## Directory layout

```
qa/
├── README.md                  ← you are here
├── coverage-matrix.md         ← current automated owner for each scenario/bug
├── walkthrough-findings.md    ← coverage audit + historical-bug tracker
├── scenarios/                 ← one .md per user flow
│   ├── _template.md           ← shape every scenario follows
│   └── 0NN-<slug>.md          ← scenarios, numbered for review order
├── fixtures/                  ← realistic inputs, never synthesized
│   ├── manifests/             ← hand-captured manifest.json files
│   ├── zips/                  ← built lazily by `harness/build-fixtures.sh`
│   ├── nexus/                 ← cassette files (one per API call)
│   ├── github/                ← cassette files (one per API call)
│   └── game/                  ← fake Slay the Spire 2 install tree
└── harness/                   ← instructions for the AI agent
    ├── README.md              ← what an agent should do start-to-finish
    └── run-scenario.md        ← the per-scenario protocol
```

## How a run looks

Conceptually:

1. Agent reads `harness/README.md` to understand the role.
2. Agent picks a scenario from `scenarios/` (round-robin or by tier).
3. For each scenario:
   - Reads the `## Setup` block and creates a fresh temp dir mirroring the structure in `fixtures/game/`.
   - Reads the `## Action` block and either calls Tauri commands directly (fast path) or drives the running app via the computer-use MCP (slow path, catches UI bugs).
   - Reads the `## Assert` block and verifies on-disk state, command return values, and (where applicable) screenshot diffs.
4. Reports pass/fail with reproduction notes.

## Local QA entry points

| What | How | Time |
|---|---|---|
| Rust unit + integration | `npm run qa:rust` (or `cargo test --manifest-path=src-tauri/Cargo.toml`) | ~10s |
| Rust cassette integration | `npm run qa:rust:cassette` | ~15s |
| Coverage matrix guard | `npm run qa:matrix` | <1s |
| Backend coverage report | `cargo llvm-cov --manifest-path src-tauri/Cargo.toml --summary-only` | ~30s |
| Frontend unit tests | `npm run qa:unit` | ~5s |
| Frontend coverage + gate | `npm run qa:coverage` (enforces vitest.config.ts thresholds) | ~10s |
| WebDriver smoke (no cassette) | `npm run qa:smoke` | ~30s |
| WebDriver smoke (cassette) | `npm run qa:smoke:cassette` | ~30s |
| Fast feedback loop | `npm test` (Rust + Vitest only) | ~15s |
| Full QA suite | `npm run qa` (all of the above) | ~3-5 min |

`scripts/release.sh` runs all five before any version bump. Set
`SKIP_QA=1` to bypass for emergency hotfixes (and accept the risk).

## Harness env vars

The WebDriver smoke uses these to keep its state isolated. Each
defaults to "use real OS detection / config dir / cache dir" when
unset, so a production build behaves identically without them:

- `STS2_FIXTURE_GAME_PATH` — point the manager at a fake STS2
  install (tempdir tree with `release_info.json` + `mods/` + the
  Godot `.pck` marker file). Overrides `game::detect_game`.
- `STS2_CONFIG_DIR` — relocate `mod_sources.json`, profiles,
  active-profile state, and the log file. Defaults to
  `<dirs::config_dir>/sts2-mod-manager`.
- `STS2_CACHE_DIR` — relocate downloaded release zips. Defaults to
  `<dirs::cache_dir>/sts2-mod-manager`.
- `STS2_CASSETTE_DIR` — when the binary is built with `--features
  qa-cassette`, route outbound GitHub + Nexus GETs to this dir
  instead of the wire. Production builds ignore this entirely.

## Driving the app — three tiers

Pick the right tier for the scenario:

| Tier | Tool | What it covers | What it misses |
|---|---|---|---|
| **1. IPC harness** | A thin Rust binary that calls Tauri commands directly | Fast (<1s per scenario), catches backend regressions, runs in CI | UI bugs, drag/drop, dropdown state |
| **2. Headless WebView** | `tauri-driver` (WebDriver) — opens a real Tauri window in a hidden frame | Catches frontend bugs (button missing, state desync) | Native OS dialogs, deep-link routing |
| **3. Computer-use** | `mcp__computer-use__*` driving the user's actual desktop | Catches everything | Slow (seconds per click), nondeterministic |

Tier 1 should cover ~70% of scenarios. Tier 2 is what proves the UI doesn't lie. Tier 3 is reserved for deep-link / drag-drop / Steam-launch cases that touch the OS.

## Fixtures policy

Three rules:

1. **No synthetic happy-path fixtures.** If a manifest works fine, it's not a useful fixture — we have tons of those in the wild. Useful fixtures are the *odd* ones: BOM-prefixed, mixed dependency formats, doubly-nested zip, manifest name ≠ folder name, etc.
2. **Capture once, replay forever.** Nexus and GitHub API responses go into `fixtures/nexus/` and `fixtures/github/` as JSON dumps. The harness MUST replay them offline so test runs are deterministic and don't burn rate limits.
3. **Provenance comments.** Every fixture file has a header comment naming the mod, the version, and the date captured. Example:

```jsonc
// Captured: BaseLib v3.1.2 from Nexus mods/103 on 2026-05-11.
// Quirk: UTF-8 BOM at byte 0 (EF BB BF) — written by author's Windows tooling.
// This is the file the user reported as showing "vunknown".
```

## Adding a new scenario

When a user reports a bug:

1. Reproduce it locally.
2. Capture the real input that broke things into `fixtures/`.
3. Copy `scenarios/_template.md` to `scenarios/0NN-<slug>.md` and fill it in.
4. Mark the corresponding row in `walkthrough-findings.md`'s historical-bug table as ✅.
5. Run the harness to confirm the scenario fails on the broken code and passes after the fix.

## Why we don't write this as more Rust unit tests

We already have 26. They keep being green while users keep reporting bugs. The problem is *not* test count, it's that unit tests exercise functions in isolation while real failures live in the seams between them — install → scan → display → action → re-scan. Markdown scenarios force us to describe what a USER does, not what a FUNCTION does, and the agent that executes them sees the system as a user does. That asymmetry is the point.
