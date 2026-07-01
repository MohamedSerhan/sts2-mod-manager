#!/usr/bin/env node
/**
 * End-to-end smoke test: launch the built Tauri app via tauri-driver,
 * connect with selenium-webdriver, click around, verify the new audit
 * surface on the Mods view renders + is interactive.
 *
 * See qa/runner/README.md for setup.
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { Builder, By, until } from 'selenium-webdriver';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const IS_WINDOWS = process.platform === 'win32';
const MSEDGEDRIVER = resolve(__dirname, 'msedgedriver.exe');

function findOnPath(command) {
  const res = spawnSync('sh', ['-lc', `command -v ${command}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return res.status === 0 && res.stdout.trim() ? res.stdout.trim() : command;
}

const NATIVE_DRIVER = IS_WINDOWS ? MSEDGEDRIVER : findOnPath('WebKitWebDriver');
// Resolve cargo's actual target directory so we find the binary even when a
// machine-wide shared target is configured (CARGO_TARGET_DIR or a
// .cargo/config `build.target-dir`). `cargo metadata` honors all of those;
// fall back to the in-tree default if it's unavailable.
function cargoTargetDir() {
  try {
    const res = spawnSync(
      'cargo',
      [
        'metadata',
        '--manifest-path',
        resolve(REPO_ROOT, 'src-tauri', 'Cargo.toml'),
        '--format-version',
        '1',
        '--no-deps',
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (res.status === 0 && res.stdout) {
      const dir = JSON.parse(res.stdout).target_directory;
      if (dir) return dir;
    }
  } catch {
    /* fall through to the in-tree default below */
  }
  return resolve(REPO_ROOT, 'src-tauri', 'target');
}

const APP_BINARY = resolve(
  cargoTargetDir(),
  'release',
  IS_WINDOWS ? 'sts2-mod-manager.exe' : 'sts2-mod-manager',
);
// tauri-driver intermediary port (the WebDriver client connects here).
const DRIVER_PORT = 4444;
// Native driver port (msedgedriver on Windows, WebKitWebDriver on Linux).
const NATIVE_PORT = 4445;

// Cassette mode — set CASSETTE=1 to play GitHub + Nexus HTTP calls back
// from disk fixtures instead of the wire. Requires the binary to have
// been built with `--features qa-cassette`; if it wasn't, the env var is
// a no-op at runtime and the audit will silently fall through to live
// network (the cfg! gate in qa_cassette::intercept_get is compile-time).
const CASSETTE_MODE = process.env.CASSETTE === '1';
const CASSETTE_DIR = resolve(REPO_ROOT, 'qa', 'fixtures');

/* ── Fixture game tree ──────────────────────────────────────────────
 *
 * Builds a tempdir mirroring the shape the manager expects of an STS2
 * install — `release_info.json` at the root, `mods/` next to it, and
 * (in cassette mode) one or two pre-installed mods linked to the
 * `qa-fixture/*` cassettes. Pointed at via $STS2_FIXTURE_GAME_PATH so
 * the manager skips its real auto-detect.
 *
 * We also redirect $STS2_CONFIG_DIR and $STS2_CACHE_DIR to fresh
 * tempdirs so the smoke doesn't read the developer's real
 * mod_sources.json / cached zips (which would leak real pinned-mod
 * state into a supposedly-deterministic test).
 *
 * The whole tree is removed in the runner's `finally` block.
 */
let FIXTURE_DIRS = null; // { root, game, config, cache } — populated at startup

const WORKSHOP_ITEM_ID = '3747602295';
const WORKSHOP_MOD_NAME = 'RitsuLib';

function makeFixtureGameTree() {
  const root = mkdtempSync(join(tmpdir(), 'sts2mm-fixture-'));
  const config = join(root, 'config');
  const cache = join(root, 'cache');
  const steam = join(root, 'steam');
  const game = join(steam, 'steamapps', 'common', 'Slay the Spire 2');
  seedFixtureGameTree({ game, config, cache, steam });
  return { root, game, config, cache, steam };
}

/**
 * Populates the three fixture directories with a deterministic
 * release_info.json + the two cassette-paired mods. Split out from
 * `makeFixtureGameTree` so `rebuildFixtureTree` can re-seed in place
 * without churning the tempdir paths the running app has captured via
 * env vars (STS2_FIXTURE_GAME_PATH / STS2_CONFIG_DIR / STS2_CACHE_DIR).
 */
function seedFixtureGameTree({ game, config, cache, steam }) {
  for (const d of [game, config, cache, join(game, 'mods'), join(game, 'mods_disabled')]) {
    mkdirSync(d, { recursive: true });
  }
  // A plausible release_info.json so the manager logs a detected game
  // version. Value doesn't matter for the cassette specs — the
  // qa-fixture mods don't declare a min_game_version.
  writeFileSync(
    join(game, 'release_info.json'),
    JSON.stringify({ version: '0.105.0', commit: 'qa-fixture', date: '2026-05-12' }),
  );

  // Always seed the two cassette-paired fixture mods, even outside
  // CASSETTE mode — having mods on disk lets the toggle/pin Tier 2
  // specs run without needing cassette playback. (In non-cassette
  // mode the audit would 404 against github.com, but no spec runs
  // audit unless CASSETTE_MODE is set.)
  seedQaTestMod(join(game, 'mods', 'QaTestMod'));
  seedUpToDateMod(join(game, 'mods', 'UpToDateMod'));
  seedStoredRitsuLib(join(game, 'mods_disabled', 'STS2-RitsuLib-v0.2.26'));
  // WalkbackMod is deliberately NOT seeded here — it would be flagged
  // "needs update" by the audit and break specAuditAgainstCassettesShows
  // OnePending's "1 update" count. The repair walk-back spec seeds it
  // on demand via seedWalkbackMod() and triggers a re-scan by nav'ing
  // to Mods after writing.
  if (steam) {
    seedWorkshopFixtureTree(steam);
  }
}

/**
 * Tears down the fixture game tree and re-seeds it. Reuses the same paths the
 * running app captured at startup, so STS2_FIXTURE_GAME_PATH / STS2_CONFIG_DIR
 * / STS2_CACHE_DIR remain valid. Called before each STATE_SPECS entry so a
 * stateful spec always sees the pristine game files regardless of which
 * mutating specs ran before it.
 *
 * NOTE: the running app holds an in-memory snapshot of mods/profiles
 * that this disk-level reset doesn't reach. Specs that need the app
 * to re-scan should navigate to Mods (or trigger whatever refresh the
 * surface they're testing already uses) — the same way the existing
 * specs naturally pick up post-toggle disk state.
 */
function rebuildFixtureTree() {
  if (!FIXTURE_DIRS) return;
  // Keep config/cache alive while the packaged app is running. The app captures
  // these paths at startup and stores runtime state there; wiping them mid-run
  // can leave the next spec in a persistent "STS2 not found" state even though
  // the fixture game directory still exists.
  emptyDir(join(FIXTURE_DIRS.game, 'mods'));
  emptyDir(join(FIXTURE_DIRS.game, 'mods_disabled'));
  seedFixtureGameTree({
    game: FIXTURE_DIRS.game,
    config: FIXTURE_DIRS.config,
    cache: FIXTURE_DIRS.cache,
    steam: FIXTURE_DIRS.steam,
  });
}

function emptyDir(dir) {
  mkdirSync(dir, { recursive: true });
  for (const entry of readdirSync(dir)) {
    rmSync(join(dir, entry), { recursive: true, force: true });
  }
}

function seedQaTestMod(dir) {
  mkdirSync(dir, { recursive: true });
  // Manifest version 1.0.0 + GitHub source link via the legacy
  // `source` field. The cassette at qa/fixtures/github/repos/
  // qa-fixture/test-mod/releases/latest.json reports v2.0.0 → audit
  // flags this mod as needing an update.
  writeFileSync(
    join(dir, 'QaTestMod.json'),
    JSON.stringify(
      {
        id: 'QaTestMod',
        name: 'QaTestMod',
        version: '1.0.0',
        author: 'QA Bot',
        description: 'Smoke fixture: paired with the qa-fixture/test-mod cassette.',
        source: 'github:qa-fixture/test-mod',
        dependencies: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'QaTestMod.dll'), Buffer.from([0])); // placeholder
}

function seedUpToDateMod(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'UpToDateMod.json'),
    JSON.stringify(
      {
        id: 'UpToDateMod',
        name: 'UpToDateMod',
        version: '1.0.0',
        author: 'QA Bot',
        description: 'Smoke fixture: paired with qa-fixture/uptodate-mod cassette (cassette says latest is v1.0.0 too, so no update).',
        source: 'github:qa-fixture/uptodate-mod',
        dependencies: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'UpToDateMod.dll'), Buffer.from([0]));
}

function seedWorkshopFixtureTree(steam) {
  const steamapps = join(steam, 'steamapps');
  const workshopMeta = join(steamapps, 'workshop');
  const workshopRoot = join(workshopMeta, 'content', '2868840');
  const itemDir = join(workshopRoot, WORKSHOP_ITEM_ID);
  mkdirSync(itemDir, { recursive: true });
  mkdirSync(workshopMeta, { recursive: true });
  writeFileSync(
    join(steamapps, 'libraryfolders.vdf'),
    `"libraryfolders"\n{\n  "0"\n  {\n    "path" "${steam.replace(/\\/g, '\\\\')}"\n  }\n}\n`,
  );
  writeFileSync(
    join(workshopMeta, 'appworkshop_2868840.acf'),
    `"AppWorkshop"\n{\n  "appid" "2868840"\n  "NeedsUpdate" "0"\n  "NeedsDownload" "0"\n  "WorkshopItemsInstalled"\n  {\n    "${WORKSHOP_ITEM_ID}"\n    {\n      "size" "2048"\n      "timeupdated" "1782640939"\n      "manifest" "7697508620998582885"\n    }\n  }\n}\n`,
  );
  writeFileSync(
    join(itemDir, 'mod_manifest.json'),
    JSON.stringify(
      {
        id: 'STS2-RitsuLib',
        name: WORKSHOP_MOD_NAME,
        version: '0.4.41',
        min_game_version: '0.105.0',
        author: 'QA Workshop',
        description: 'Smoke fixture: Steam Workshop-owned mod.',
        dependencies: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(itemDir, 'RitsuLib.dll'), Buffer.from([0]));
}

function seedStoredRitsuLib(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'mod_manifest.json'),
    JSON.stringify(
      {
        id: 'STS2-RitsuLib',
        name: WORKSHOP_MOD_NAME,
        version: '0.2.26',
        min_game_version: '0.105.0',
        author: 'QA Local',
        description: 'Smoke fixture: stored local sibling for source-aware Workshop version selection.',
        dependencies: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'RitsuLib.dll'), Buffer.from([0]));
}

function seedAutoDetectedSourceMod(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'AutoDetectedSourceMod.json'),
    JSON.stringify(
      {
        id: 'AutoDetectedSourceMod',
        name: 'AutoDetectedSourceMod',
        version: '1.0.0',
        author: 'QA Bot',
        description: 'Smoke fixture: no author GitHub, source comes from mod_sources.json.',
        dependencies: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'AutoDetectedSourceMod.dll'), Buffer.from([0]));
}

function seedStaleManifestSourceVersionMod(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'StaleManifestSourceMod.json'),
    JSON.stringify(
      {
        id: 'StaleManifestSourceMod',
        name: 'StaleManifestSourceMod',
        version: '1.0.0',
        author: 'QA Bot',
        description: 'Smoke fixture: source-installed tag is newer than the manifest version.',
        dependencies: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'StaleManifestSourceMod.dll'), Buffer.from([0]));
}

/**
 * Repair walk-back fixture mod. Seeded on disk at v2.0.0 — an "in-between"
 * state with no matching GitHub release. The cassette at
 * qa/fixtures/github/repos/qa-fixture/walkback-mod/ publishes:
 *   - v3.0.0 (latest, min_game_version 999.0.0 — incompatible)
 *   - v1.0.0 (older, min_game_version 0.100.0 — compatible with the
 *     fixture game's v0.105.0)
 * specRepairWalkback clicks Repair on this row and asserts the walk-back
 * lands on v1.0.0 (both via the success toast text and the on-disk
 * manifest's version field after install).
 */
function seedWalkbackMod(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'WalkbackMod.json'),
    JSON.stringify(
      {
        id: 'WalkbackMod',
        name: 'WalkbackMod',
        version: '2.0.0',
        author: 'QA Bot',
        description: 'Smoke fixture: broken between-state — declares v2.0.0 (no matching release). Repair walks back to v1.0.0.',
        min_game_version: '0.100.0',
        source: 'github:qa-fixture/walkback-mod',
        dependencies: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'WalkbackMod.dll'), Buffer.from([0]));
}

/**
 * Bug #21 fixture: a mod whose manifest declares a `min_game_version` HIGHER
 * than the fixture game's `release_info.json` reports (0.105.0). The mod's
 * files live on disk so `scan_mods` picks them up, but the mod is incompatible
 * with the running game — `install_is_incompatible` returns true. Seeded inline
 * by specIncompatibleModAbsentFromCreatedModpack (NOT from seedFixtureGameTree) so other
 * specs' audit counts don't change.
 */
function seedSkippedMod(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SkippedMod.json'),
    JSON.stringify(
      {
        id: 'SkippedMod',
        name: 'SkippedMod',
        version: '1.0.0',
        author: 'QA Bot',
        description: 'Smoke fixture: declares min_game_version 999.0.0 — incompatible with fixture game v0.105.0.',
        min_game_version: '999.0.0',
        dependencies: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(dir, 'SkippedMod.dll'), Buffer.from([0]));
}

/* ── Pre-flight ─────────────────────────────────────────────────── */

function preflight() {
  const problems = [];
  if (IS_WINDOWS && !existsSync(MSEDGEDRIVER)) {
    problems.push(
      `msedgedriver not found at ${MSEDGEDRIVER}.\n  Run: node qa/runner/scripts/download-msedgedriver.mjs`,
    );
  }
  if (!IS_WINDOWS) {
    if (!existsSync(NATIVE_DRIVER)) {
      problems.push(
        `${NATIVE_DRIVER} not found or not runnable.\n  Install WebKitGTK's WebDriver package (Ubuntu: sudo apt-get install webkit2gtk-driver).`,
      );
    }
  }
  if (!existsSync(APP_BINARY)) {
    problems.push(
      `Release build not found at ${APP_BINARY}. Run \`cargo build --release --manifest-path=src-tauri/Cargo.toml\` (full bundle: \`npm run tauri build\`).`,
    );
  }
  if (problems.length > 0) {
    console.error('Pre-flight failed:\n  ' + problems.join('\n  '));
    process.exit(2);
  }
  // Sweep zombies left behind by a previous run that died before its
  // `finally` block could land. Without this, the next run gets a
  // "Chrome instance exited" at session start as the new app fights
  // the old one over ports 4444/4445 + the WebView2 user-data dir.
  reapZombieProcesses();
}

/**
 * Best-effort kill of any child process we spawned (or might have
 * spawned) in a prior run. Targets are matched by name; we never kill
 * by PID. On Windows, `taskkill /T` walks the process tree which
 * covers msedgewebview2 children of the manager.
 *
 * Safe to call when there are no zombies — taskkill exits non-zero
 * (which we ignore) and prints nothing.
 */
function reapZombieProcesses() {
  if (process.platform !== 'win32') return;
  const names = [
    'tauri-driver.exe',
    'msedgedriver.exe',
    basename(APP_BINARY), // sts2-mod-manager.exe
  ];
  for (const name of names) {
    spawnSync('taskkill', ['/F', '/IM', name, '/T'], { stdio: 'ignore' });
  }
}

/* ── Driver lifecycle ───────────────────────────────────────────── */

// Poll a TCP port until something is listening (or timeout). Replaces a
// fixed sleep that became flaky when tauri-driver took longer than 1.5s
// to bind on cold starts — the WebDriver client would then ECONNREFUSED
// before tauri-driver was ready.
async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await new Promise((res) => {
      const sock = createConnection({ host: '127.0.0.1', port });
      sock.once('connect', () => { sock.end(); res(true); });
      sock.once('error', () => { res(false); });
    });
    if (ok) return;
    await delay(200);
  }
  throw new Error(`tauri-driver never started listening on port ${port} within ${timeoutMs}ms`);
}

function startTauriDriver() {
  // tauri-driver 2.0.6 is the intermediary: it launches the app, spawns
  // the platform-native WebDriver, and rewrites capabilities to match what
  // that driver expects. On Windows, the WebView2 schema changed in 147,
  // which broke older tauri-driver 0.1.x.
  //
  // Env propagation: tauri-driver inherits this process's env, then
  // spawns the app binary which inherits tauri-driver's env. So setting
  // STS2_CASSETTE_DIR here lands on the Rust qa_cassette module via
  // std::env::var inside the running app. Verified with the cassette
  // banner log in lib.rs::run.
  const env = { ...process.env };
  if (FIXTURE_DIRS) {
    env.STS2_FIXTURE_GAME_PATH = FIXTURE_DIRS.game;
    env.STS2_CONFIG_DIR = FIXTURE_DIRS.config;
    env.STS2_CACHE_DIR = FIXTURE_DIRS.cache;
    env.STS2_FIXTURE_STEAM_PATH = FIXTURE_DIRS.steam;
    console.error(`[smoke] fixture game tree: ${FIXTURE_DIRS.game}`);
    console.error(`[smoke] fixture Steam tree: ${FIXTURE_DIRS.steam}`);
  }
  if (CASSETTE_MODE) {
    env.STS2_CASSETTE_DIR = CASSETTE_DIR;
    console.error(`[smoke] CASSETTE=1 — STS2_CASSETTE_DIR=${CASSETTE_DIR}`);
  }
  const child = spawn(
    'tauri-driver',
    [
      '--port', String(DRIVER_PORT),
      '--native-port', String(NATIVE_PORT),
      '--native-driver', NATIVE_DRIVER,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], env },
  );
  child.stdout.on('data', (b) => process.stderr.write(`[tauri-driver] ${b}`));
  child.stderr.on('data', (b) => process.stderr.write(`[tauri-driver] ${b}`));
  child.on('exit', (code) => {
    if (code !== null && code !== 0) {
      console.error(`tauri-driver exited with code ${code}`);
    }
  });
  return child;
}

async function buildDriver() {
  // Canonical Tauri WebDriver capabilities. tauri-driver consumes
  // `tauri:options.application`, launches the binary, and rewrites
  // the request into the native driver's expected shape (Edge
  // WebView2 on Windows, WebKitGTK on Linux). Do NOT add raw Edge
  // capability shapes here — tauri-driver pre-mangles them.
  const caps = {
    browserName: 'wry',
    'tauri:options': {
      application: APP_BINARY,
    },
  };
  const driver = await new Builder()
    .usingServer(`http://localhost:${DRIVER_PORT}`)
    .withCapabilities(caps)
    .build();
  return driver;
}

/* ── Specs ──────────────────────────────────────────────────────── */

async function specMainWindowRenders(driver) {
  await driver.wait(
    until.elementLocated(By.css('.gf-titlebar-title')),
    15_000,
    'Main titlebar never appeared — Tauri window is not rendering.',
  );
  const title = await driver.findElement(By.css('.gf-titlebar-title')).getText();
  assertEqual(title, 'STS2 Mod Manager', 'titlebar text');
}

/**
 * Every WebDriver session spawns a fresh WebView2 user-data folder, so
 * localStorage is empty and the OnboardingOverlay fires. Real users
 * only see it once. Dismiss it via the "Skip setup" button before
 * running any other spec; if it's not present, this is a no-op.
 */
async function dismissOnboardingIfPresent(driver) {
  // Onboarding shows on first launch and can render a beat after the window
  // does (it waits on the async game probe), so wait briefly for it rather
  // than snapshotting once. The dismiss button reads "Skip setup" when a game
  // is detected, but "Set up later" when none is (1.7.0 makes that case
  // non-persisting) — the smoke fixture isn't Steam-registered, so it's the
  // latter. Handle both. It's a centered modal: it only intercepts clicks on
  // the content area, which is why a stuck overlay surfaces later, not here.
  let appeared = true;
  try {
    await driver.wait(until.elementLocated(By.css('.gf-wiz-back')), 8_000);
  } catch {
    appeared = false;
  }
  if (!appeared) return;
  const skip = await driver.findElement(
    By.xpath("//button[normalize-space(.)='Skip setup' or normalize-space(.)='Set up later']"),
  );
  await skip.click();
  // Wait for the overlay to detach.
  await driver.wait(
    async () => (await driver.findElements(By.css('.gf-wiz-back'))).length === 0,
    5_000,
    'Onboarding overlay did not dismiss after Skip/Set-up-later click',
  );
}

async function specModsNavReachable(driver) {
  const mods = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Mod Library']"),
    'Sidebar Mods nav button',
  );
  await mods.click();
  await waitForElement(
    driver,
    By.xpath(
      "//button[contains(., 'Audit mods') or contains(., 'Download ') or contains(., 'Update ') or contains(., 'Up to date')]",
    ),
    'Mods toolbar audit button',
  );
}

async function specAuditButtonClickable(driver) {
  const auditBtn = await waitForElement(
    driver,
    By.xpath(
      "//button[contains(., 'Audit mods') or contains(., 'Update ') or contains(., 'Up to date')]",
    ),
    'audit button',
  );
  const disabled = await auditBtn.getAttribute('disabled');
  if (disabled === 'true' || disabled === '') {
    const titleAttr = (await auditBtn.getAttribute('title')) ?? '';
    if (titleAttr.toLowerCase().includes('close sts2')) {
      console.log('  (audit button disabled because STS2 is running — that is correct behavior)');
      return;
    }
    throw new Error(`audit button is disabled at rest. title="${titleAttr}"`);
  }
}

/**
 * Source editor display-name override: edit the manager-only name from the
 * row editor and verify the visible row title updates immediately.
 */
async function specDisplayNameOverrideUpdatesRow(driver) {
  await navToMods(driver);
  await waitForElement(
    driver,
    By.xpath("//h3[contains(@class,'gf-profile-library-title') and normalize-space(.)='QaTestMod']"),
    'QaTestMod row title before display-name edit',
  );
  const row = await waitForElement(
    driver,
    By.xpath("//*[normalize-space(text())='QaTestMod']/ancestor::*[@data-testid='library-row'][1]"),
    'QaTestMod row before display-name edit',
  );
  await row.click();

  const input = await waitForElement(
    driver,
    By.xpath(
      "//*[contains(@class,'gf-src-edit-field')][.//*[normalize-space(.)='Display name']]//input",
    ),
    'Source editor display-name input',
  );
  const displayName = `QA Friendly ${Date.now().toString(36)}`;
  await input.sendKeys(displayName);
  await driver.wait(
    async () => (await input.getAttribute('value')) === displayName,
    5_000,
    'Source editor display-name input did not receive the smoke value',
  );

  await clickLocatedByScript(
    driver,
    By.xpath("//*[contains(@class,'gf-src-edit')]//button[contains(., 'Save sources')]"),
    'Source editor Save sources button',
  );
  await driver.wait(
    async () => (await driver.findElements(By.css('.gf-src-edit'))).length === 0,
    20_000,
    'Source editor did not close after saving display-name override',
  );

  await waitForElement(
    driver,
    By.xpath(`//h3[contains(@class,'gf-profile-library-title') and normalize-space(.)='${displayName}']`),
    'row title after display-name edit',
    20_000,
  );
}

/**
 * Auto-detected GitHub links shown in Source Editor must become manual when
 * the user clicks Save, even if they did not edit the field. This owns the
 * "looks linked but Update says no GitHub source" regression.
 */
async function specAutoDetectedGitHubSavePromotesSource(driver) {
  seedAutoDetectedSourceMod(join(FIXTURE_DIRS.game, 'mods', 'AutoDetectedSourceMod'));
  const sourcesPath = join(FIXTURE_DIRS.config, 'mod_sources.json');
  writeFileSync(
    sourcesPath,
    JSON.stringify(
      {
        mods: {
          AutoDetectedSourceMod: {
            github_repo: 'qa-fixture/test-mod',
            github_auto_detected: true,
            nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/99999',
            nexus_game_domain: 'slaythespire2',
            nexus_mod_id: 99999,
          },
        },
      },
      null,
      2,
    ),
  );

  await navToMods(driver);
  const refreshBtn = await waitForElement(
    driver,
    By.xpath("//button[normalize-space(.)='Refresh' or contains(., 'Refresh')]"),
    'Mods toolbar Refresh button',
  );
  await refreshBtn.click();
  await waitForElement(
    driver,
    By.xpath("//h3[contains(@class,'gf-profile-library-title') and normalize-space(.)='AutoDetectedSourceMod']"),
    'AutoDetectedSourceMod row after source fixture refresh',
    10_000,
  );

  const row = await waitForElement(
    driver,
    By.xpath("//*[normalize-space(text())='AutoDetectedSourceMod']/ancestor::*[@data-testid='library-row'][1]"),
    'AutoDetectedSourceMod row before Source Editor save',
  );
  await row.click();

  const githubInput = await waitForElement(
    driver,
    By.xpath(
      "//*[contains(@class,'gf-src-edit-field')][.//*[contains(., 'GitHub repo')]]//input",
    ),
    'Source editor GitHub input',
  );
  const githubValue = await githubInput.getAttribute('value');
  assertEqual(githubValue, 'qa-fixture/test-mod', 'auto-detected GitHub value shown in Source Editor');

  await clickLocated(
    driver,
    By.xpath("//*[contains(@class,'gf-src-edit')]//button[contains(., 'Save sources')]"),
    'Source editor Save sources button',
  );

  await driver.wait(
    () => {
      try {
        const parsed = JSON.parse(readFileSync(sourcesPath, 'utf8').replace(/^\uFEFF/, ''));
        return parsed.mods?.AutoDetectedSourceMod?.github_auto_detected !== true
          && parsed.mods?.AutoDetectedSourceMod?.github_repo === 'qa-fixture/test-mod';
      } catch {
        return false;
      }
    },
    10_000,
    'AutoDetectedSourceMod GitHub source was not promoted to manual after Save',
  );
}

/**
 * Cassette-mode regression spec: a post-update source tag can be newer than
 * the manifest version inside the archive. The row must headline the trusted
 * source-installed version and keep the manifest version as secondary context.
 */
async function specStaleManifestSourceVersionDisplaysInstalledTag(driver) {
  seedStaleManifestSourceVersionMod(join(FIXTURE_DIRS.game, 'mods', 'StaleManifestSourceMod'));
  const sourcesPath = join(FIXTURE_DIRS.config, 'mod_sources.json');
  writeFileSync(
    sourcesPath,
    JSON.stringify(
      {
        mods: {
          StaleManifestSourceMod: {
            github_repo: 'qa-fixture/uptodate-mod',
            github_auto_detected: false,
            installed_version: 'v1.1.3',
          },
        },
      },
      null,
      2,
    ),
  );

  await navToMods(driver);
  const refreshBtn = await waitForElement(
    driver,
    By.xpath("//button[normalize-space(.)='Refresh' or contains(., 'Refresh')]"),
    'Mods toolbar Refresh button',
  );
  await refreshBtn.click();
  await waitForElement(
    driver,
    By.xpath("//h3[contains(@class,'gf-profile-library-title') and normalize-space(.)='StaleManifestSourceMod']"),
    'StaleManifestSourceMod row after fixture refresh',
    10_000,
  );

  const reauditButtons = await driver.findElements(By.css("button[title='Re-audit']"));
  if (reauditButtons.length > 0) {
    await reauditButtons[0].click();
  } else {
    const auditBtn = await waitForElement(
      driver,
      By.xpath(
        "//button[contains(., 'Audit mods') or contains(., 'Update ') or contains(., 'Up to date')]",
      ),
      'audit button',
    );
    await auditBtn.click();
  }

  await waitForElement(
    driver,
    By.xpath("//*[contains(@class,'gf-meta-version') and normalize-space(.)='GitHub v1.1.3']"),
    'source-installed version label for stale manifest mod',
    30_000,
  );
  await waitForElement(
    driver,
    By.xpath("//*[contains(@class,'gf-meta-version') and normalize-space(.)='manifest v1.0.0']"),
    'secondary manifest version label for stale manifest mod',
    5_000,
  );
}

async function specWhatsNewCardRenders(driver) {
  const home = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Home']"),
    'Sidebar Home nav button',
  );
  await home.click();
  await delay(400);
  const cards = await driver.findElements(By.css('.gf-whatsnew'));
  if (cards.length === 0) {
    console.log('  (WhatsNewCard not visible — likely dismissed for this version)');
    return;
  }
  const title = await cards[0].findElement(By.css('.gf-whatsnew-title')).getText();
  if (!title.startsWith("What's new in v")) {
    throw new Error(`WhatsNewCard title looks wrong: "${title}"`);
  }
}

/**
 * Toggle the QaTestMod fixture off via the UI and verify it physically
 * moved from `mods/QaTestMod/` to `mods_disabled/QaTestMod/` on disk.
 * Catches regressions in the file-move side of `toggle_mod` that a
 * unit test on isolated path math would miss — e.g. an empty parent
 * dir being left behind, the move failing silently because the source
 * was locked, or the disabled folder being created at the wrong level.
 */
async function specToggleMovesQaTestModToDisabled(driver) {
  const mods = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Mod Library']"),
    'Sidebar Mods nav button',
  );
  await mods.click();

  // Find the toggle on the QaTestMod row.
  // Row class is `gf-mod-row` (per Mods.tsx line 564 - 'gf-mod-pinned'
  // is applied conditionally, parent class is hover:bg-surface-hover
  // which doesn't help). The toggle is a `[role=switch]` from the
  // Toggle component. We scope by climbing from the QaTestMod label.
  const toggleLocator = By.xpath(
    "//*[normalize-space(text())='QaTestMod']/ancestor::*[.//button[@role='switch']][1]//button[@role='switch']",
  );
  const toggle = await waitForElement(driver, toggleLocator, 'QaTestMod toggle switch');
  // It should be checked at start (the fixture seeded an enabled mod).
  const before = await toggle.getAttribute('aria-checked');
  if (before !== 'true') {
    throw new Error(`expected QaTestMod toggle to start aria-checked=true, got ${before}`);
  }
  await toggle.click();

  // Wait for the on-disk move. The toggle's UI state changes after
  // the backend command resolves; poll the filesystem so we don't
  // race a stale React state update.
  const enabledDir = join(FIXTURE_DIRS.game, 'mods', 'QaTestMod');
  const disabledDir = join(FIXTURE_DIRS.game, 'mods_disabled', 'QaTestMod');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(disabledDir) && !existsSync(enabledDir)) break;
    await delay(150);
  }
  if (!existsSync(disabledDir)) {
    throw new Error(`mods_disabled/QaTestMod did not appear within 10s`);
  }
  if (existsSync(enabledDir)) {
    throw new Error(`mods/QaTestMod still exists after toggle-off — move was a copy?`);
  }

  // And the UI matches the disk state. Re-query because React may replace the
  // switch while the async backend move is settling.
  await driver.wait(async () => {
    try {
      const current = await driver.findElement(toggleLocator);
      return (await current.getAttribute('aria-checked')) === 'false';
    } catch (error) {
      if (error?.name === 'StaleElementReferenceError') return false;
      throw error;
    }
  }, 10_000, 'QaTestMod toggle did not settle to aria-checked=false after disk move');
}

/**
 * Cassette-mode spec: freeze QaTestMod (the only mod with a pending
 * update via cassette), re-run the audit, and assert the count
 * collapses to "Up to date". The freeze should suppress the row from
 * the pending count even though the cassette would otherwise return
 * a newer version. Locks the contract on the
 * `!a.pinned` filter in `auditPendingCount` (Mods.tsx:122).
 */
async function specFreezeSuppressesPendingUpdate(driver) {
  const mods = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Mod Library']"),
    'Sidebar Mods nav button',
  );
  await mods.click();
  await waitForElement(
    driver,
    By.xpath("//*[normalize-space(text())='QaTestMod']"),
    'QaTestMod row',
  );

  // Find the kebab in the QaTestMod row.
  const kebab = await waitForElement(
    driver,
    By.xpath(
      "//*[normalize-space(text())='QaTestMod']/ancestor::*[.//button[@title='Mod actions']][1]//button[@title='Mod actions']",
    ),
    'QaTestMod kebab button',
  );
  await kebab.click();

  const freezeItem = await waitForElement(
    driver,
    By.xpath("//button[@role='menuitem'][contains(., 'Freeze this mod')]"),
    'Freeze this mod menu item',
  );
  await freezeItem.click();
  // Backend write + refresh roundtrip.
  await delay(800);

  // Now re-run the audit; QaTestMod is frozen so its pending update
  // shouldn't count. The toolbar should read "Up to date".
  //
  // Target the ghost ↻ re-audit button by aria-label, NOT the generic
  // "audit button" xpath. After specAuditShows1Update the toolbar is in
  // the "Download 1 update" state, which renders TWO buttons: the primary
  // "Download 1 update" action button AND a separate ghost re-audit icon.
  // Picking the first by text content used to hit the action button
  // and open the "Download 1 update?" confirm modal — the test would then
  // wait 30s for "Up to date" while the dialog blocked everything.
  const auditBtn = await waitForElement(
    driver,
    By.css("button[title='Re-audit']"),
    're-audit (ghost ↻) button',
  );
  await auditBtn.click();
  // Same stale-element story as the cassette-flow audit: re-query the
  // button each tick because React replaces it across state changes.
  await driver.wait(
    async () => {
      const btns = await driver.findElements(
        By.xpath(
          "//button[contains(., 'Audit mods') or contains(., 'Download ') or contains(., 'Update ') or contains(., 'Up to date')]",
        ),
      );
      for (const b of btns) {
        const txt = (await b.getText().catch(() => '')).trim();
        if (/^up to date$/i.test(txt)) return true;
      }
      // The "Up to date" state actually renders the text in a <span>,
      // not a button. Also accept that.
      const spans = await driver.findElements(
        By.xpath("//*[contains(@class,'gf-pill') and normalize-space(.)='Up to date']"),
      );
      return spans.length > 0;
    },
    30_000,
    'audit did not settle to "Up to date" after freezing QaTestMod',
  );
}

/**
 * Destructive flow: kebab → "Remove mod…" on UpToDateMod, confirm in
 * the modal, verify the row vanishes AND the folder is gone from
 * disk. We pick UpToDateMod (not QaTestMod) so this spec composes
 * with the toggle spec that runs before it without depending on
 * order — both target distinct mods.
 */
async function specDeleteUpToDateMod(driver) {
  const mods = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Mod Library']"),
    'Sidebar Mods nav button',
  );
  await mods.click();
  await waitForElement(
    driver,
    By.xpath("//*[normalize-space(text())='UpToDateMod']"),
    'UpToDateMod row',
  );

  // 1.7.0: delete is a dedicated trash button on each Mod Library row (the
  // kebab holds Freeze/Edit/etc.). Its aria-label is "Remove <mod>".
  await clickLocated(
    driver,
    By.xpath("//button[@aria-label='Remove UpToDateMod']"),
    'UpToDateMod delete (trash) button',
  );

  // Confirm modal: title contains "Delete", primary action button
  // text is "Delete". Click it.
  await waitForElement(
    driver,
    By.xpath("//*[contains(@class, 'gf-modal-title') and contains(., 'UpToDateMod')]"),
    'Delete-mod confirm modal',
  );
  const confirmBtn = await waitForElement(
    driver,
    By.xpath("//*[contains(@class, 'gf-modal-foot')]//button[normalize-space(.)='Delete']"),
    'Confirm "Delete" button in modal',
  );
  await confirmBtn.click();

  // Wait for the row to disappear from the UI...
  await driver.wait(
    async () => {
      const rows = await driver.findElements(By.xpath("//*[normalize-space(text())='UpToDateMod']"));
      return rows.length === 0;
    },
    10_000,
    'UpToDateMod row never disappeared from the Mods list',
  );

  // ...and from the filesystem.
  const modDir = join(FIXTURE_DIRS.game, 'mods', 'UpToDateMod');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!existsSync(modDir)) break;
    await delay(150);
  }
  if (existsSync(modDir)) {
    throw new Error(`mods/UpToDateMod still exists on disk after Delete`);
  }
}

/**
 * Modpack creation flow: click Modpacks -> Create modpack, walk through the
 * guided wizard, then verify the new modpack appears. Modpacks are one of
 * the highest-risk surfaces (apply / snapshot / switch has multiple
 * historical bugs), so the smoke keeps a happy-path owner for the current UI.
 */
async function specCreateModpack(driver) {
  // 1.7.0: creation is the guided Create-modpack wizard (Modpacks tab ->
  // Create modpack -> Start from active mods -> Next -> Continue anyway ->
  // name -> Create).
  // A unique name keeps re-runs against a sticky STS2_CONFIG_DIR from
  // colliding.
  const modpackName = `QA Smoke ${Date.now().toString(36)}`;
  await createModpackNamed(driver, modpackName);
}

/**
 * v1.3.1 contract: a mod frozen while one modpack is active still
 * shows the "Frozen" pill after the user round-trips through another
 * modpack and back. Freeze state lives in mod_sources.json (config dir),
 * not the modpack manifest, so any future refactor that accidentally
 * folds freeze state into the per-modpack snapshot — or has switch_profile
 * stomp on mod_sources during apply — would break this assertion.
 *
 * Flow:
 *   1. Modpacks -> create + activate "Orig" modpack.
 *   2. Mod Library -> freeze QaTestMod via kebab. Verify "Frozen" pill rendered.
 *   3. Modpacks -> create + activate "Other" modpack.
 *   4. Modpacks -> switch back to "Orig".
 *   5. Mod Library -> assert QaTestMod still shows the "Frozen" pill.
 */
async function specModpackSwitchPreservesFreeze(driver) {
  const suffix = Date.now().toString(36);
  const origName = `QA Orig ${suffix}`;
  const otherName = `QA Switch ${suffix}`;

  await navToModpacks(driver);
  await createModpackNamed(driver, origName);
  await waitForToastsToClear(driver);
  await activateModpack(driver, origName);
  await waitForToastsToClear(driver);

  // Freeze QaTestMod from the Mods view.
  await navToMods(driver);
  await waitForElement(
    driver,
    By.xpath("//*[normalize-space(text())='QaTestMod']"),
    'QaTestMod row before pin',
  );
  const kebab = await waitForElement(
    driver,
    By.xpath(
      "//*[normalize-space(text())='QaTestMod']/ancestor::*[.//button[@title='Mod actions']][1]//button[@title='Mod actions']",
    ),
    'QaTestMod kebab button',
  );
  await kebab.click();
  const freezeItem = await waitForElement(
    driver,
    By.xpath("//button[@role='menuitem'][contains(., 'Freeze this mod')]"),
    'Freeze this mod menu item',
  );
  await freezeItem.click();
  // Wait for the durable indicator (Frozen pill) to render — proves the
  // backend write landed and React picked up the source-list change.
  //
  // We match the pill via `normalize-space(.)='Frozen'`, not `text()`,
  // because the JSX renders the icon and label as siblings:
  //     <span><Snowflake/> {t('mods.pinned')}</span>
  // which React emits as two adjacent text nodes (" " + "Frozen"). XPath
  // 1.0's `string(text())` converts the node-set to a string by taking
  // only the FIRST text node, so `normalize-space(text())` collapses to
  // "" and never matches. `.` flattens the whole subtree, which is what
  // we actually want.
  await waitForElement(
    driver,
    By.xpath(
      "//*[normalize-space(text())='QaTestMod']/ancestor::*[contains(@class,'gf-mod-pinned')][1]//*[normalize-space(.)='Frozen']",
    ),
    '"Frozen" pill on QaTestMod row after freeze',
    8_000,
  );

  // Now round-trip through a second profile and back.
  await waitForToastsToClear(driver);
  await navToModpacks(driver);
  await createModpackNamed(driver, otherName);
  await waitForToastsToClear(driver);
  await activateModpack(driver, otherName);
  await waitForToastsToClear(driver);
  await activateModpack(driver, origName);
  await waitForToastsToClear(driver);

  // Verify the freeze survived the switch round trip.
  await navToMods(driver);
  await waitForElement(
    driver,
    By.xpath(
      "//*[normalize-space(text())='QaTestMod']/ancestor::*[contains(@class,'gf-mod-pinned')][1]//*[normalize-space(.)='Frozen']",
    ),
    '"Frozen" pill on QaTestMod row after profile-switch round trip',
    10_000,
  );
}

/**
 * Regression spec for issue #22: toggling a mod off must survive a
 * profile-switch round trip. The bug had `switch_profile` re-apply the
 * source list in a way that resurrected toggled-off mods back into
 * `mods/` because the profile snapshot didn't carry the disabled state.
 *
 * Flow:
 *   1. Mods → toggle QaTestMod off; assert UI (aria-checked=false) and
 *      disk (folder moved to `mods_disabled/`).
 *   2. Modpacks -> create "Other", activate it, then switch back to the
 *      starting modpack.
 *   3. Mod Library -> assert QaTestMod toggle still reads aria-checked=false
 *      AND the folder is still in `mods_disabled/`, not resurrected
 *      into `mods/`.
 */
async function specToggleStickyAcrossModpackSwitch(driver) {
  // Step 1: toggle QaTestMod off from the Mods view.
  await navToMods(driver);
  const toggle = await waitForElement(
    driver,
    By.xpath(
      "//*[normalize-space(text())='QaTestMod']/ancestor::*[.//button[@role='switch']][1]//button[@role='switch']",
    ),
    'QaTestMod toggle switch',
  );
  const before = await toggle.getAttribute('aria-checked');
  if (before !== 'true') {
    throw new Error(`expected QaTestMod toggle to start aria-checked=true, got ${before}`);
  }
  await toggle.click();

  // Wait for the disk move + UI state change.
  const enabledDir = join(FIXTURE_DIRS.game, 'mods', 'QaTestMod');
  const disabledDir = join(FIXTURE_DIRS.game, 'mods_disabled', 'QaTestMod');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(disabledDir) && !existsSync(enabledDir)) break;
    await delay(150);
  }
  if (!existsSync(disabledDir)) {
    throw new Error(`mods_disabled/QaTestMod did not appear within 10s after toggle-off`);
  }
  if (existsSync(enabledDir)) {
    throw new Error(`mods/QaTestMod still exists after toggle-off — move was a copy?`);
  }
  const toggleAfterClick = await waitForElement(
    driver,
    By.xpath(
      "//*[normalize-space(text())='QaTestMod']/ancestor::*[.//button[@role='switch']][1]//button[@role='switch']",
    ),
    'QaTestMod toggle switch after click',
  );
  const afterToggle = await toggleAfterClick.getAttribute('aria-checked');
  if (afterToggle !== 'false') {
    throw new Error(`expected QaTestMod toggle aria-checked=false after click, got ${afterToggle}`);
  }

  // Step 2: round-trip through a second modpack. The fixture starts
  // with a "Default" modpack active (Profiles.tsx auto-creates one);
  // we create "Other", activate it, then activate "Default" again.
  const suffix = Date.now().toString(36);
  const otherName = `QA Other ${suffix}`;
  const origName = `QA Orig ${suffix}`;

  await waitForToastsToClear(driver);
  await navToModpacks(driver);
  // Create the starting modpack we'll return to. We don't activate it
  // first because whatever modpack is currently active works as the
  // "origin"; what matters is that we explicitly switch away and back.
  await createModpackNamed(driver, origName);
  await waitForToastsToClear(driver);
  await activateModpack(driver, origName);
  await waitForToastsToClear(driver);
  await createModpackNamed(driver, otherName);
  await waitForToastsToClear(driver);
  await activateModpack(driver, otherName);
  await waitForToastsToClear(driver);
  await activateModpack(driver, origName);
  await waitForToastsToClear(driver);

  // Step 3: back on Mods, the toggle must still read off AND the
  // folder must still be in mods_disabled/ (not resurrected into mods/).
  await navToMods(driver);
  const toggleAfter = await waitForElement(
    driver,
    By.xpath(
      "//*[normalize-space(text())='QaTestMod']/ancestor::*[.//button[@role='switch']][1]//button[@role='switch']",
    ),
    'QaTestMod toggle switch after profile round trip',
  );
  const finalChecked = await toggleAfter.getAttribute('aria-checked');
  if (finalChecked !== 'false') {
    throw new Error(
      `bug #22 regression: QaTestMod toggle resurrected to aria-checked=${finalChecked} after modpack switch round trip (expected false)`,
    );
  }
  if (!existsSync(disabledDir)) {
    throw new Error(
      `bug #22 regression: mods_disabled/QaTestMod vanished after modpack switch round trip`,
    );
  }
  if (existsSync(enabledDir)) {
    throw new Error(
      `bug #22 regression: mods/QaTestMod reappeared on disk after modpack switch round trip`,
    );
  }
}

/**
 * Regression spec for the safe modpack repair/switch contract: disabled
 * library mods that are not part of the active modpack must stay on disk and
 * must not surface as modpack drift. Repair/switch makes active `mods/`
 * match the selected modpack by disabling extras, not by deleting the
 * user's library from `mods_disabled/`.
 *
 * Flow:
 *   1. Modpacks -> create + activate a fresh modpack.
 *   2. Nav away from Modpacks, then seed `mods_disabled/OrphanMod/` on disk
 *      post-snapshot so the manifest does not list it.
 *   3. Nav back to Modpacks and wait for the drift effect to settle.
 *   4. Assert no Repair drift banner appears and the disabled orphan folder
 *      still exists.
 */
async function specDisabledLibraryExtrasArePreserved(driver) {
  const suffix = Date.now().toString(36);
  const modpackName = `QA Repair ${suffix}`;

  // Step 1: after the runner rebuilds the fixture tree, force the app to
  // rescan the fresh mods before creating a pack from the current loadout.
  await navToMods(driver);
  const refreshBtn = await waitForElement(
    driver,
    By.xpath("//button[normalize-space(.)='Refresh' or contains(., 'Refresh')]"),
    'Mods toolbar Refresh button',
  );
  await refreshBtn.click();
  await waitForElement(
    driver,
    By.xpath("//*[normalize-space(text())='QaTestMod']"),
    'QaTestMod row after fixture refresh',
    10_000,
  );
  await waitForElement(
    driver,
    By.xpath("//*[normalize-space(text())='UpToDateMod']"),
    'UpToDateMod row after fixture refresh',
    10_000,
  );

  // Step 2: create + activate a fresh modpack.
  await navToModpacks(driver);
  await createModpackNamed(driver, modpackName, { minSelected: 2 });
  await waitForToastsToClear(driver);
  await activateModpack(driver, modpackName);
  await waitForToastsToClear(driver);

  // Step 3: leave Modpacks so the next visit remounts the view.
  await navToMods(driver);

  // Step 4: seed an orphan folder under mods_disabled/. A proper-ish
  // manifest so `scan_disabled_mods` picks it up via PASS 2 (subdir
  // walk → try_load_mod_from finds the json). A bare `{}` would also
  // parse via the file-stem fallback, but giving it explicit fields
  // makes the failure mode louder if the manifest schema ever moves.
  const orphanDir = join(FIXTURE_DIRS.game, 'mods_disabled', 'OrphanMod');
  mkdirSync(orphanDir, { recursive: true });
  writeFileSync(
    join(orphanDir, 'OrphanMod.json'),
    JSON.stringify(
      {
        id: 'OrphanMod',
        name: 'OrphanMod',
        version: '1.0.0',
        author: 'QA Bot',
        description: 'Smoke fixture: orphan in mods_disabled/ that no profile manifest references.',
        dependencies: [],
      },
      null,
      2,
    ),
  );
  writeFileSync(join(orphanDir, 'OrphanMod.dll'), Buffer.from([0]));
  if (!existsSync(orphanDir)) {
    throw new Error(`orphan seed failed: ${orphanDir} does not exist after mkdir/writeFile`);
  }

  // Step 5: nav back to Modpacks and ask the live backend for drift.
  // Disabled library extras may coexist with unrelated stateful smoke drift,
  // but OrphanMod itself must not appear in any drift bucket.
  await navToModpacks(driver);
  await delay(500);
  const drift = await invokeTauri(driver, 'get_profile_drift', { name: modpackName });
  const driftNames = [
    ...(drift?.added ?? []),
    ...(drift?.removed ?? []),
    ...(drift?.toggled ?? []),
    ...((drift?.version_changed ?? []).map((entry) => entry.name)),
  ];
  if (driftNames.includes('OrphanMod')) {
    throw new Error(
      `disabled library regression: ${orphanDir} surfaced as profile drift; ` +
        `disabled mods outside the selected profile should be preserved and ignored. Drift: ${JSON.stringify(drift)}`,
    );
  }

  if (!existsSync(orphanDir)) {
    throw new Error(
      `disabled library regression: ${orphanDir} was deleted; Repair/switch ` +
        'must not remove mods from the user library in mods_disabled/',
    );
  }
}

/* ── Helpers ────────────────────────────────────────────────────── */

async function navToModpacks(driver) {
  const nav = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Modpacks']"),
    'Sidebar Modpacks nav button',
  );
  await nav.click();
  // The nav keeps any open modpack detail mounted; back out to the card list
  // so the cards + the "Create modpack" entry are reachable.
  const back = await driver.findElements(
    By.xpath("//button[normalize-space(.)='Back to modpacks']"),
  );
  if (back.length > 0) {
    await back[0].click();
    await delay(200);
  }
}

async function navToMods(driver) {
  const nav = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Mod Library']"),
    'Sidebar Mods nav button',
  );
  await nav.click();
}

/**
 * Wait for any open `gf-toast` notification pills to detach. Success/
 * info toasts live 4s + 250ms fade (ToastContext.tsx FADE_MS), and the
 * bottom-right stack absolutely-positions over the page body, so a
 * lingering toast can intercept clicks on buttons in the lower half of
 * the viewport. The profile flow fires toasts on every Create / Switch,
 * so any spec that performs multiple consecutive profile actions needs
 * this between them.
 */
async function waitForToastsToClear(driver) {
  await driver.wait(
    async () => (await driver.findElements(By.css('.gf-toast'))).length === 0,
    8_000,
    'Toast notification never dismissed',
  );
}

function loadProfileByName(profileName) {
  const profilesDir = join(FIXTURE_DIRS.config, 'profiles');
  const profilePath = readdirSync(profilesDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(profilesDir, name))
    .find((candidatePath) => {
      try {
        const raw = readFileSync(candidatePath, 'utf8');
        const candidateProfile = JSON.parse(raw.replace(/^\uFEFF/, ''));
        return candidateProfile.name === profileName;
      } catch {
        return false;
      }
    });
  if (!profilePath) {
    throw new Error(`Failed to find created modpack named "${profileName}" under ${profilesDir}`);
  }
  try {
    return {
      path: profilePath,
      profile: JSON.parse(readFileSync(profilePath, 'utf8').replace(/^\uFEFF/, '')),
    };
  } catch (e) {
    throw new Error(
      `Failed to read/parse created modpack at ${profilePath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Create a modpack through the 1.7.0 guided wizard: Modpacks tab ->
 * "Create modpack" -> "Start from my active mods" (auto-advances) -> Next ->
 * Continue anyway -> name -> Create modpack. Waits for the new modpack to appear.
 */
async function createModpackNamed(driver, modpackName, { minSelected = 1 } = {}) {
  await navToModpacks(driver);
  const entry = await waitForElement(
    driver,
    By.xpath("//button[contains(., 'Create modpack')]"),
    '"Create modpack" entry button',
  );
  await entry.click();
  // Step 1 - seed from current active mods (clicking a tile advances).
  // "From active" (vs "empty") keeps the new pack matching the on-disk
  // enabled set, so it does not read as drift against the live install.
  const strategy = await waitForElement(
    driver,
    By.xpath("//button[contains(@class,'gf-create-wizard-strategy-option')][contains(., 'Start from my active mods')]"),
    'wizard "Start from my active mods" strategy tile',
  );
  await strategy.click();
  await driver.wait(async () => {
    const selected = await driver.findElements(
      By.css(".gf-create-wizard-list input[type='checkbox']:checked"),
    );
    return selected.length >= minSelected;
  }, 10_000, `wizard did not select ${minSelected} active fixture mod(s) before Next`);
  // Step 2 (choose mods) → Next.
  const next = await waitForElement(
    driver,
    By.xpath("//*[contains(@class,'gf-create-wizard')]//button[normalize-space(.)='Next']"),
    'wizard "Next" button',
  );
  await next.click();
  // Step 3 (health) → Continue anyway.
  const cont = await waitForElement(
    driver,
    By.xpath("//*[contains(@class,'gf-create-wizard')]//button[contains(., 'Continue anyway')]"),
    'wizard "Continue anyway" button',
  );
  await cont.click();
  // Step 4 — name + Create modpack (scoped to the wizard foot so it isn't
  // confused with the entry button still behind the modal).
  const input = await waitForElement(
    driver,
    By.css('#gf-create-wizard-name'),
    'wizard modpack-name input',
  );
  await input.sendKeys(modpackName);
  const createBtn = await waitForElement(
    driver,
    By.xpath(
      "//*[contains(@class,'gf-create-wizard')]//div[contains(@class,'gf-modal-foot')]//button[normalize-space(.)='Create modpack']",
    ),
    'wizard "Create modpack" submit',
  );
  await createBtn.click();
  // The new modpack renders (as a card on the list, or the detail title).
  await waitForElement(
    driver,
    By.xpath(`//*[normalize-space(text())='${modpackName}']`),
    `modpack "${modpackName}" after create`,
    10_000,
  );
}

/**
 * Activate the named modpack. 1.7.0 moved switching into the modpack
 * DETAIL view: open the card, click "Switch to", then wait for the ACTIVE
 * badge in the detail header (only the active modpack shows it).
 */
async function activateModpack(driver, modpackName) {
  await navToModpacks(driver);
  const cardName = await waitForElement(
    driver,
    By.xpath(`//*[contains(@class,'gf-modpack-card-name') and normalize-space(.)='${modpackName}']`),
    `modpack card "${modpackName}"`,
  );
  const card = await cardName.findElement(By.xpath("ancestor::*[contains(@class,'gf-modpack-card')][1]"));
  await driver.executeScript('arguments[0].scrollIntoView({ block: "center", inline: "center" });', card);
  await delay(150);
  try {
    await card.click();
  } catch {
    await driver.executeScript('arguments[0].click();', card);
  }
  const switchBtn = await waitForElement(
    driver,
    By.xpath(
      "//*[contains(@class,'gf-modpack-detail-head-actions')]//button[contains(., 'Switch to')]",
    ),
    `"Switch to" button in detail for "${modpackName}"`,
  );
  await switchBtn.click();
  // Switching away from a modpack that has unsaved on-disk drift pops a
  // "Switch away?" confirm — proceed through it when present.
  try {
    const confirm = await driver.wait(
      until.elementLocated(By.xpath("//button[normalize-space(.)='Switch anyway']")),
      3_000,
    );
    await confirm.click();
  } catch {
    /* clean switch — no confirm dialog */
  }
  // The switch applies mods to the game folder; when it settles the header
  // flips to the ACTIVE badge (and the Switch button disappears).
  await waitForElement(
    driver,
    By.xpath(
      "//*[contains(@class,'gf-modpack-detail-title-row')]//*[normalize-space(.)='ACTIVE']",
    ),
    `ACTIVE badge for "${modpackName}"`,
    30_000,
  );
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected "${expected}", got "${actual}"`);
  }
}

function isStaleElementError(error) {
  return error?.name === 'StaleElementReferenceError';
}

async function findElementsIgnoringStale(driver, locator) {
  try {
    return await driver.findElements(locator);
  } catch (error) {
    if (isStaleElementError(error)) return [];
    throw error;
  }
}

async function waitForElement(driver, locator, label, timeoutMs = 10_000) {
  return driver.wait(async () => {
    const candidates = await findElementsIgnoringStale(driver, locator);
    for (const candidate of candidates) {
      try {
        if (await candidate.isDisplayed()) return candidate;
      } catch (error) {
        if (isStaleElementError(error)) return false;
        throw error;
      }
    }
    return false;
  }, timeoutMs, `Timed out waiting for ${label}`);
}

async function clickLocated(driver, locator, label, timeoutMs = 10_000) {
  await driver.wait(async () => {
    const candidates = await findElementsIgnoringStale(driver, locator);
    for (const candidate of candidates) {
      try {
        if (!(await candidate.isDisplayed()) || !(await candidate.isEnabled())) continue;
        await driver.executeScript(
          'arguments[0].scrollIntoView({ block: "center", inline: "center" });',
          candidate,
        );
        await candidate.click();
        return true;
      } catch (error) {
        if (isStaleElementError(error)) return false;
        if (error?.name === 'ElementClickInterceptedError') {
          await driver.executeScript('arguments[0].click();', candidate);
          return true;
        }
        throw error;
      }
    }
    return false;
  }, timeoutMs, `Timed out clicking ${label}`);
}

async function clickLocatedByScript(driver, locator, label, timeoutMs = 10_000) {
  await driver.wait(async () => {
    const candidates = await findElementsIgnoringStale(driver, locator);
    for (const candidate of candidates) {
      try {
        if (!(await candidate.isDisplayed()) || !(await candidate.isEnabled())) continue;
        await driver.executeScript(
          'arguments[0].scrollIntoView({ block: "center", inline: "center" }); arguments[0].click();',
          candidate,
        );
        return true;
      } catch (error) {
        if (isStaleElementError(error)) return false;
        throw error;
      }
    }
    return false;
  }, timeoutMs, `Timed out clicking ${label}`);
}

async function invokeTauri(driver, cmd, args = {}) {
  const result = await driver.executeAsyncScript(
    `
      const done = arguments[arguments.length - 1];
      const cmd = arguments[0];
      const args = arguments[1];
      const invoke =
        window.__TAURI_INTERNALS__?.invoke ||
        window.__TAURI__?.core?.invoke ||
        window.__TAURI__?.invoke;
      if (typeof invoke !== 'function') {
        done({ ok: false, error: 'Tauri invoke bridge is unavailable in the WebDriver session' });
        return;
      }
      Promise.resolve(invoke(cmd, args)).then(
        (value) => done({ ok: true, value }),
        (error) => done({ ok: false, error: error?.message || String(error) })
      );
    `,
    cmd,
    args,
  );
  if (!result?.ok) {
    throw new Error(`Tauri command ${cmd} failed: ${result?.error || 'unknown error'}`);
  }
  return result.value;
}

async function waitForToastContaining(driver, parts, label, timeoutMs = 10_000) {
  return driver.wait(async () => {
    const toasts = await driver.findElements(By.css('.gf-toast'));
    for (const toast of toasts) {
      const text = await toast.getText();
      if (parts.every((part) => text.includes(part))) return toast;
    }
    return false;
  }, timeoutMs, `Timed out waiting for ${label}`);
}

async function captureFailureArtifacts(driver, error) {
  try {
    const shot = await driver.takeScreenshot();
    const png = Buffer.from(shot, 'base64');
    const out = join(__dirname, 'last-failure.png');
    writeFileSync(out, png);
    console.error(`\nScreenshot saved: ${out}`);
  } catch (e) {
    console.error('Could not capture failure screenshot:', e.message);
  }
  console.error('\n' + (error.stack ?? error));
}

/* ── Main ───────────────────────────────────────────────────────── */

async function specSettingsLoads(driver) {
  // 1.7.0 moved the audit out of Settings — it lives in the Mod Library
  // toolbar now (covered by the audit specs above). Settings keeps
  // general / accounts / backups / advanced. This still proves Settings
  // mounts and its tab strip renders without crashing after the AppContext
  // audit-state lift — a bad destructure would blow up the strip on render.
  const settings = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Settings']"),
    'Sidebar Settings nav button',
  );
  await settings.click();
  // The settings tab strip renders…
  await waitForElement(driver, By.css('.gf-tabs-settings'), 'Settings tab strip');
  // …and switching to another tab doesn't crash the panel.
  const backupsTab = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-tab') and contains(., 'Backups')]"),
    'Settings → Backups tab button',
  );
  await backupsTab.click();
  await delay(300);
}

/**
 * Cassette-mode spec: with the fixture-game-path tree seeded with one
 * stale mod (paired to `qa-fixture/test-mod`, cassette latest = v2.0.0)
 * and one up-to-date mod (paired to `qa-fixture/uptodate-mod`), the
 * Mods toolbar should show "1 update" after the audit completes.
 *
 * This proves the entire stack end-to-end:
 *   - Fixture game tree is being read by the manager (the two
 *     fixture mods appear).
 *   - Cassette playback answers the GitHub API calls offline.
 *   - The version comparison + UI count path agrees.
 *
 * Asserting the exact "1 update" text would have caught a regression
 * I shipped earlier where the regex matched "Check for updates" too
 * eagerly — the count assertion is the actual signal.
 */
async function specAuditAgainstCassettesShowsOnePending(driver) {
  const mods = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Mod Library']"),
    'Sidebar Mods nav button',
  );
  await mods.click();

  // The fixture seeds at startup; verify both rows rendered before
  // clicking audit. (If they didn't, $STS2_FIXTURE_GAME_PATH didn't
  // take effect — much better failure mode than a flaky audit timeout.)
  await waitForElement(
    driver,
    By.xpath("//*[contains(text(),'QaTestMod')]"),
    'QaTestMod row (fixture mod 1)',
  );
  await waitForElement(
    driver,
    By.xpath("//*[contains(text(),'UpToDateMod')]"),
    'UpToDateMod row (fixture mod 2)',
  );

  const auditBtn = await waitForElement(
    driver,
    By.xpath(
      "//button[contains(., 'Audit mods') or contains(., 'Update ') or contains(., 'Up to date')]",
    ),
    'audit button',
  );
  await auditBtn.click();

  // After audit completes the toolbar button reads "Download 1 update".
  // We re-query each tick because React replaces the Button when the
  // toolbar state machine flips variants (secondary → primary). Holding
  // the pre-click element ref returns a stale node after the swap and
  // .getText() throws StaleElementReference. Two variants of the
  // pre-audit copy now: "Audit mods" (initial) or "Update N mod(s)"
  // (after the v1.3.4 toolbar refactor); both are diagnostic — anything
  // OTHER than "Download 1 update" means the cassette / fixture wiring is off.
  await driver.wait(
    async () => {
      const matches = await driver.findElements(
        By.xpath("//*[contains(normalize-space(.), 'Download 1 update')]"),
      );
      return matches.length > 0;
    },
    30_000,
    'audit button never settled to "Download 1 update" — cassette/fixture wiring is off',
  );

  // Also assert the green "Download update" pill rendered on the
  // QaTestMod row. Catches the case where the audit count comes back
  // right but the per-row UI didn't update.
  //
  // Inner predicate uses `contains(.,'Download update')` rather than
  // `contains(text(),...)`: the pill button is `<Download/> {t(...)}`,
  // which React emits as two adjacent text nodes — XPath 1.0's
  // node-set-to-string conversion would only see the first (whitespace)
  // text node. See specModpackSwitchPreservesFreeze for the longer note.
  await waitForElement(
    driver,
    By.xpath("//*[contains(text(),'QaTestMod')]/ancestor::*[contains(@class,'gf-mod-row') or contains(@class,'gf-card')][1]//*[contains(.,'Download update')]"),
    'Download-update pill on QaTestMod row',
    5_000,
  );
}

/**
 * Cassette spec: Repair walk-back installs the older compatible tag
 * when the latest GitHub release requires a newer game build than the
 * user has.
 *
 * Fixture state:
 *   - WalkbackMod seeded on disk with manifest version "2.0.0" — an
 *     in-between state that doesn't match any published release tag.
 *   - GitHub cassette publishes v3.0.0 (latest, min_game_version
 *     999.0.0 → incompatible with fixture game v0.105.0) and v1.0.0
 *     (older, min_game_version 0.100.0 → compatible).
 *
 * Flow:
 *   1. Seed WalkbackMod on disk and force a Refresh so the Mods view
 *      picks it up.
 *   2. Flip the Advanced toggle so the kebab's "Repair this mod" item
 *      surfaces (it lives under the Advanced-only Recovery section in
 *      Mods.tsx).
 *   3. Open the WalkbackMod kebab → click "Repair this mod" → confirm
 *      via the modal's "Repair now" button.
 *   4. Wait for the success toast: handleRepair surfaces
 *      "Repaired 'WalkbackMod' (v1.0.0)" — the v1.0.0 in the literal is
 *      the load-bearing assertion proving the walk-back picked the
 *      older compatible release rather than the blocked latest.
 *   5. Verify on disk: mods/WalkbackMod/WalkbackMod.json has version
 *      "1.0.0" (install_mod_from_zip wrote the v1.0.0 zip's manifest
 *      into the live folder).
 */
async function specRepairWalkback(driver) {
  // Step 1: seed the fixture mod on disk + trigger a re-scan. Clear any
  // lingering toasts from the preceding spec first — they absolute-
  // position over the lower viewport and would intercept clicks on the
  // kebab items further down the page.
  await waitForToastsToClear(driver);
  seedWalkbackMod(join(FIXTURE_DIRS.game, 'mods', 'WalkbackMod'));
  await navToMods(driver);
  const refreshBtn = await waitForElement(
    driver,
    By.xpath("//button[normalize-space(.)='Refresh' or contains(., 'Refresh')]"),
    'Mods toolbar Refresh button',
  );
  await refreshBtn.click();
  await waitForElement(
    driver,
    By.xpath("//*[normalize-space(text())='WalkbackMod']"),
    'WalkbackMod row (post-seed re-scan)',
  );

  // 1.7.0 dropped the Advanced-mode gate — recovery actions (Repair,
  // Rollback) live in the kebab directly now. Open WalkbackMod's kebab →
  // "Repair this mod" → confirm.
  const kebab = await waitForElement(
    driver,
    By.xpath(
      "//*[normalize-space(text())='WalkbackMod']/ancestor::*[.//button[@title='Mod actions']][1]//button[@title='Mod actions']",
    ),
    'WalkbackMod kebab button',
  );
  await kebab.click();

  const repairItem = await waitForElement(
    driver,
    By.xpath("//button[@role='menuitem'][contains(., 'Repair this mod')]"),
    '"Repair this mod" kebab item',
  );
  await repairItem.click();

  // Confirm modal — handleRepair calls confirm({ title: "Repair 'WalkbackMod'?",
  // confirmLabel: 'Repair now' }). Scope the button to the modal foot so we
  // don't accidentally hit a banner/inline "Repair" button elsewhere.
  await waitForElement(
    driver,
    By.xpath("//*[contains(@class, 'gf-modal-title') and contains(., 'WalkbackMod')]"),
    'Repair-mod confirm modal',
  );
  const confirmBtn = await waitForElement(
    driver,
    By.xpath("//*[contains(@class, 'gf-modal-foot')]//button[normalize-space(.)='Repair now']"),
    'Confirm "Repair now" button in modal',
  );
  await confirmBtn.click();

  // Step 4: wait for the success toast. Walk-back installs v1.0.0, so the
  // literal "v1.0.0" in the toast is what disambiguates a working walk-
  // back from a "Repaired … (v3.0.0)" toast (which would mean the compat
  // check silently failed open and installed the blocked latest).
  //
  // We watch for ANY WalkbackMod toast first — repair_mod can fail loudly
  // via toast.error and we want a useful error message, not a 60s timeout.
  let toastText = '';
  await driver.wait(
    async () => {
      const toasts = await driver.findElements(By.css('.gf-toast'));
      for (const t of toasts) {
        const txt = (await t.getText().catch(() => '')).trim();
        if (txt.includes('WalkbackMod')) {
          toastText = txt;
          return true;
        }
      }
      return false;
    },
    60_000,
    'No WalkbackMod-related toast surfaced after Repair (success or error)',
  );
  if (!/Repaired.*WalkbackMod.*v1\.0\.0/i.test(toastText)) {
    throw new Error(
      `Repair walk-back: expected toast "Repaired 'WalkbackMod' (v1.0.0)", got "${toastText}"`,
    );
  }

  // Step 5: disk-state assertion — the freshly-extracted v1.0.0 manifest
  // landed at mods/WalkbackMod/WalkbackMod.json with version "1.0.0".
  const manifestPath = join(FIXTURE_DIRS.game, 'mods', 'WalkbackMod', 'WalkbackMod.json');
  let parsed;
  try {
    const raw = readFileSync(manifestPath, 'utf8');
    parsed = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(
      `Failed to read/parse post-repair manifest at ${manifestPath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  assertEqual(parsed.version, '1.0.0', 'WalkbackMod manifest version after repair walk-back');
}

/**
 * Workshop v1 contract: Workshop-owned mods show in the regular Library and
 * saved modpacks keep a Steam reference instead of copying or moving files
 * into STS2's manager-owned mods folders.
 */
async function specWorkshopModpackReferenceStaysSteamOwned(driver) {
  const modpackName = `QA Workshop ${Date.now().toString(36)}`;
  await waitForToastsToClear(driver);
  await navToMods(driver);

  const refreshBtn = await waitForElement(
    driver,
    By.xpath("//button[normalize-space(.)='Refresh' or contains(., 'Refresh')]"),
    'Mods toolbar Refresh button',
  );
  await refreshBtn.click();

  await waitForElement(
    driver,
    By.xpath(`//*[normalize-space(text())='${WORKSHOP_MOD_NAME}']`),
    'Workshop RitsuLib row',
    30_000,
  );
  await waitForElement(
    driver,
    By.xpath(
      `//*[normalize-space(text())='${WORKSHOP_MOD_NAME}']/ancestor::*[contains(@class,'gf-profile-library-row') or contains(@class,'gf-card')][1]//*[contains(., 'Steam Workshop')]`,
    ),
    'Steam Workshop badge on RitsuLib row',
  );

  await invokeTauri(driver, 'create_profile', { name: modpackName });
  const { path: profilePath, profile } = loadProfileByName(modpackName);
  if (!Array.isArray(profile.mods)) {
    throw new Error(
      `Profile ${profilePath} has no mods array. Keys: ${Object.keys(profile).join(', ')}`,
    );
  }

  const localEntry = profile.mods.find((m) => m.name === 'QaTestMod' || m.folder_name === 'QaTestMod');
  if (!localEntry) {
    throw new Error(`Workshop mixed-profile smoke lost the local QaTestMod entry in ${profilePath}`);
  }

  const expectedUrl = `https://steamcommunity.com/sharedfiles/filedetails/?id=${WORKSHOP_ITEM_ID}`;
  const workshopEntry = profile.mods.find(
    (m) =>
      m.source === expectedUrl ||
      m.folder_name === WORKSHOP_ITEM_ID ||
      m.workshop_item_id === WORKSHOP_ITEM_ID,
  );
  if (!workshopEntry) {
    throw new Error(
      `Workshop mixed-profile smoke did not save the Steam-owned RitsuLib entry in ${profilePath}. ` +
        `Profile mods: ${JSON.stringify(profile.mods)}`,
    );
  }
  if (workshopEntry.source !== expectedUrl) {
    throw new Error(
      `Workshop profile entry should reference ${expectedUrl}, got ${JSON.stringify(workshopEntry)}`,
    );
  }

  const workshopDir = join(
    FIXTURE_DIRS.steam,
    'steamapps',
    'workshop',
    'content',
    '2868840',
    WORKSHOP_ITEM_ID,
  );
  if (!existsSync(join(workshopDir, 'mod_manifest.json'))) {
    throw new Error(`Workshop-owned fixture was removed or moved from ${workshopDir}`);
  }
  for (const candidate of [
    join(FIXTURE_DIRS.game, 'mods', WORKSHOP_ITEM_ID),
    join(FIXTURE_DIRS.game, 'mods', WORKSHOP_MOD_NAME),
    join(FIXTURE_DIRS.game, 'mods_disabled', WORKSHOP_ITEM_ID),
    join(FIXTURE_DIRS.game, 'mods_disabled', WORKSHOP_MOD_NAME),
  ]) {
    if (existsSync(candidate)) {
      throw new Error(`Workshop-owned files were copied or moved into manager storage: ${candidate}`);
    }
  }
}

/**
 * Regression spec for issue #21: when a mod's `min_game_version` is above the
 * current game version, a modpack created from the active install must NOT
 * include it in the saved profile JSON. The bug: automatic snapshot-style
 * creation could treat an on-disk incompatible mod as selected and write it
 * back into the manifest as enabled=true. That's the same footgun commit
 * 37df97f fixed for the subscription path (`build_synced_profile_snapshot`).
 *
 * Flow:
 *   1. Seed SkippedMod on disk in mods/ (manifest declares min_game_version:
 *      '999.0.0', fixture game reports v0.105.0).
 *   2. Nav to Mods → Refresh → assert the "needs game ≥ v999.0.0" pill renders,
 *      proving the manager sees this mod as incompatible at the UI layer.
 *   3. Invoke the same backend create_profile command used by the Create
 *      Modpack wizard. The old page-level Snapshot button was removed in the
 *      1.7 UI, but create_profile still exercises the explicit snapshot path.
 *   4. Read the profile JSON off disk and assert SkippedMod is NOT in the
 *      mods array at all. The filter must drop it entirely (matching
 *      build_synced_profile_snapshot's semantics) — not record it as
 *      enabled=false. enabled=false would still lie about disk state for
 *      a mod that's literally incompatible with the current game.
 */
async function specIncompatibleModAbsentFromCreatedModpack(driver) {
  // Use a unique suffix so re-runs against the same config dir don't collide
  // on the sanitized modpack filename.
  const suffix = Date.now().toString(36);
  const modpackName = `QA Compat ${suffix}`;

  await waitForToastsToClear(driver);

  // Step 1: seed SkippedMod on disk. Inline (not in seedFixtureGameTree)
  // so other specs' audit/profile counts don't shift.
  seedSkippedMod(join(FIXTURE_DIRS.game, 'mods', 'SkippedMod'));

  // Step 2: Mods → Refresh → confirm the incompatibility pill renders.
  // This both rescans the disk (so backend caches see SkippedMod) and
  // proves the manager UI knows the mod is incompatible — the same compat
  // gate (install_is_incompatible) the snapshot filter relies on.
  await navToMods(driver);
  // The post-Refresh disk re-scan + render can be slow under release-machine
  // load (right after a full app build + a real-network audit on GitHub-sourced
  // mods), and occasionally a single Refresh doesn't surface the freshly-seeded
  // row in time. Re-click Refresh and poll with a generous overall budget; on a
  // final miss, dump a diagnostic so a CI failure is actionable, not opaque.
  const skippedRowXpath = "//*[normalize-space(text())='SkippedMod']";
  let skippedRowFound = false;
  for (let attempt = 1; attempt <= 3 && !skippedRowFound; attempt += 1) {
    const refreshBtn = await waitForElement(
      driver,
      By.xpath("//button[normalize-space(.)='Refresh' or contains(., 'Refresh')]"),
      'Mods toolbar Refresh button',
    );
    await refreshBtn.click();
    try {
      await driver.wait(until.elementLocated(By.xpath(skippedRowXpath)), 25_000);
      skippedRowFound = true;
    } catch {
      console.log(`  [#21] SkippedMod not visible after Refresh attempt ${attempt}/3 — retrying…`);
    }
  }
  if (!skippedRowFound) {
    const src = await driver.getPageSource();
    const rowCount = (await driver.findElements(By.css('.gf-mod-row, .gf-card'))).length;
    console.log(`  [#21 diag] 'SkippedMod' in page source: ${src.includes('SkippedMod')}; mod-row/card elements: ${rowCount}`);
    throw new Error('SkippedMod row never appeared after 3 Refresh attempts (post-seed re-scan)');
  }
  await waitForElement(
    driver,
    By.xpath(
      "//*[normalize-space(text())='SkippedMod']/ancestor::*[contains(@class,'gf-mod-row') or contains(@class,'gf-card')][1]" +
        "//*[contains(., 'needs game') and contains(., '999.0.0')]",
    ),
    'SkippedMod incompatibility pill ("needs game ≥ v999.0.0")',
    30_000,
  );

  // Step 3: invoke the backend snapshot path through the live Tauri bridge.
  // The page-level Snapshot button this smoke originally clicked no longer
  // exists in the 1.7 UI; the Create Modpack wizard now uses this same command
  // before applying any optional membership edits.
  await invokeTauri(driver, 'create_profile', { name: modpackName });

  // Step 4: read the saved profile JSON off disk. New profiles are saved under
  // stable IDs, while old app versions saved them under sanitized display names.
  // Support both layouts so this smoke keeps verifying behavior instead of a
  // filename implementation detail.
  const sanitized = modpackName.replace(/[^A-Za-z0-9._-]/g, '_');
  const profilesDir = join(FIXTURE_DIRS.config, 'profiles');
  const legacyProfilePath = join(profilesDir, `${sanitized}.json`);
  const profilePath = existsSync(legacyProfilePath)
    ? legacyProfilePath
    : readdirSync(profilesDir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => join(profilesDir, name))
        .find((candidatePath) => {
          try {
            const raw = readFileSync(candidatePath, 'utf8');
            const candidateProfile = JSON.parse(raw.replace(/^\uFEFF/, ''));
            return candidateProfile.name === modpackName;
          } catch {
            return false;
          }
        });
  if (!profilePath) {
    throw new Error(`Failed to find created modpack named "${modpackName}" under ${profilesDir}`);
  }
  let profile;
  try {
    const raw = readFileSync(profilePath, 'utf8');
    profile = JSON.parse(raw.replace(/^﻿/, ''));
  } catch (e) {
    throw new Error(
      `Failed to read/parse created modpack at ${profilePath}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (!Array.isArray(profile.mods)) {
    throw new Error(
      `Profile ${profilePath} has no \`mods\` array — shape is unexpected. Keys: ${Object.keys(profile).join(', ')}`,
    );
  }

  // The load-bearing assertion: SkippedMod must NOT be in the modpack at
  // all (neither enabled nor disabled). The mod's min_game_version (999.0.0)
  // is above the fixture game v0.105.0, so the automatic create flow must
  // leave it out entirely - matching build_synced_profile_snapshot's
  // semantics on the subscription path.
  // Match on `name` OR `folder_name` since either could carry the label.
  const stillPresent = profile.mods.find(
    (m) => m.name === 'SkippedMod' || m.folder_name === 'SkippedMod',
  );
  if (stillPresent) {
    throw new Error(
      `bug #21 regression: modpack created from active mods at ${profilePath} contains SkippedMod ` +
        `(min_game_version 999.0.0, fixture game v0.105.0). Entry: ` +
        `${JSON.stringify(stillPresent)}. Create-from-active must not re-add ` +
        `mods whose min_game_version exceeds the current game version - see ` +
        `build_synced_profile_snapshot in subscriptions.rs (commit 37df97f) for ` +
        `the matching fix on the subscription path.`,
    );
  }

  // Defensive cleanup: take SkippedMod back off disk so later specs (e.g.,
  // any future appended STATE_SPEC) see a fixture matching the seedFixture
  // baseline. The current spec ordering puts this last so it's belt+braces.
  try {
    rmSync(join(FIXTURE_DIRS.game, 'mods', 'SkippedMod'), { recursive: true, force: true });
    rmSync(join(FIXTURE_DIRS.game, 'mods_disabled', 'SkippedMod'), { recursive: true, force: true });
  } catch {
    // Best-effort — fixture tree gets nuked in the runner's finally anyway.
  }
}

const BASE_SPECS = [
  ['main window renders', specMainWindowRenders],
  ['onboarding overlay dismisses cleanly', dismissOnboardingIfPresent],
  ['Mods nav reachable + audit button present', specModsNavReachable],
  ['audit button is clickable at rest', specAuditButtonClickable],
  ["WhatsNewCard renders or is dismissed", specWhatsNewCardRenders],
  ['Settings mounts + tab strip renders (audit moved to Mod Library)', specSettingsLoads],
];

const CASSETTE_SPECS = [
  ['audit shows "1 update" with cassette + fixture mods', specAuditAgainstCassettesShowsOnePending],
  ['stale manifest row shows source-installed version', specStaleManifestSourceVersionDisplaysInstalledTag],
  ['freeze on QaTestMod suppresses its pending update', specFreezeSuppressesPendingUpdate],
  // TODO scenario-005: drive a friend-install of a profile whose bundle_url
  // points at a github.com release asset (e.g. the qa-fixture
  // TheCursedMod_v0.2.7.zip under qa/fixtures/github-releases/...). Would
  // exercise the share-import IPC end-to-end with cassette playback for
  // the release-asset download path added in v1.4.0. Deferred because no
  // share-import / friend-install WebDriver spec exists yet to clone from
  // — Rust-side coverage at src-tauri/tests/qa_scenarios.rs::
  // scenario_005_install_from_release_url is sufficient for shipping.
  ['repair walk-back installs older compatible tag', specRepairWalkback],
];

// Specs that mutate fixture state (disk + app config dir) and therefore
// need a fresh fixture tree per run. The spec loop calls
// `rebuildFixtureTree()` before each entry here so order-dependence
// between them — toggle-then-delete-then-profile, or any future
// additions — is eliminated at the source. Cassette-mode runs skip
// these because the cassette specs already exercise QaTestMod and
// running both groups would double-mutate the fixture.
const STATE_SPECS = [
  ['toggle off moves QaTestMod to mods_disabled/', specToggleMovesQaTestModToDisabled],
  ['display-name override updates the Mod Library row immediately', specDisplayNameOverrideUpdatesRow],
  ['auto-detected GitHub save promotes the source for updates', specAutoDetectedGitHubSavePromotesSource],
  ['delete UpToDateMod via kebab → Remove mod…', specDeleteUpToDateMod],
  ['create modpack via Modpacks → Create modpack', specCreateModpack],
  ['modpack switch preserves freeze state (v1.3.1 contract)', specModpackSwitchPreservesFreeze],
  ['#22: toggle state sticky across modpack switch', specToggleStickyAcrossModpackSwitch],
  ['#20: disabled library extras are preserved', specDisabledLibraryExtrasArePreserved],
  ['Steam Workshop references stay Steam-owned in mixed modpacks', specWorkshopModpackReferenceStaysSteamOwned],
  ['#21: incompatible mods stay out of created modpack', specIncompatibleModAbsentFromCreatedModpack],
];

const SPECS = CASSETTE_MODE
  ? [...BASE_SPECS, ...CASSETTE_SPECS]
  : [...BASE_SPECS, ...STATE_SPECS];

async function main() {
  preflight();
  mkdirSync(__dirname, { recursive: true });

  // Always set up a fixture game tree — the base specs don't care
  // (they only navigate the UI), but it keeps the smoke from
  // accidentally touching the developer's real STS2 install or
  // config dir. The cassette specs explicitly rely on it.
  FIXTURE_DIRS = makeFixtureGameTree();

  const driverProc = startTauriDriver();
  await waitForPort(DRIVER_PORT, 15_000);

  let driver;
  let failed = false;
  try {
    driver = await buildDriver();
    for (const entry of SPECS) {
      const [name, fn] = entry;
      // STATE_SPECS mutate disk state; give each one a pristine
      // fixture tree so order-of-execution can't hide bugs (or
      // create false failures from leftover state).
      if (STATE_SPECS.includes(entry)) {
        rebuildFixtureTree();
      }
      process.stdout.write(`▸ ${name} ... `);
      try {
        await fn(driver);
        process.stdout.write('PASS\n');
      } catch (e) {
        failed = true;
        process.stdout.write('FAIL\n');
        await captureFailureArtifacts(driver, e);
        break;
      }
    }
  } catch (e) {
    failed = true;
    console.error('Driver setup failed:', e.stack ?? e);
  } finally {
    if (driver) {
      await driver.quit().catch(() => {});
    }
    driverProc.kill();
    // driverProc.kill() only signals the tauri-driver process; on
    // Windows it doesn't propagate to spawned children (msedgedriver,
    // the manager, msedgewebview2). Reap by name so a failed spec
    // doesn't poison the next run.
    reapZombieProcesses();
    if (FIXTURE_DIRS) {
      try {
        rmSync(FIXTURE_DIRS.root, { recursive: true, force: true });
      } catch (e) {
        console.error(`(fixture cleanup failed for ${FIXTURE_DIRS.root}: ${e.message})`);
      }
    }
  }

  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e.stack ?? e);
  process.exit(1);
});
