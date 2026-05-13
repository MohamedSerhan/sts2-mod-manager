#!/usr/bin/env node
/**
 * End-to-end smoke test: launch the built Tauri app via tauri-driver,
 * connect with selenium-webdriver, click around, verify the new audit
 * surface on the Mods view renders + is interactive.
 *
 * See qa/runner/README.md for setup.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

import { Builder, By, until } from 'selenium-webdriver';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');

const MSEDGEDRIVER = resolve(__dirname, 'msedgedriver.exe');
const APP_BINARY = resolve(
  REPO_ROOT,
  'src-tauri',
  'target',
  'release',
  'sts2-mod-manager.exe',
);
// tauri-driver intermediary port (the WebDriver client connects here).
const DRIVER_PORT = 4444;
// msedgedriver port (tauri-driver forwards to here).
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

function makeFixtureGameTree() {
  const root = mkdtempSync(join(tmpdir(), 'sts2mm-fixture-'));
  const game = join(root, 'game');
  const config = join(root, 'config');
  const cache = join(root, 'cache');
  seedFixtureGameTree({ game, config, cache });
  return { root, game, config, cache };
}

/**
 * Populates the three fixture directories with a deterministic
 * release_info.json + the two cassette-paired mods. Split out from
 * `makeFixtureGameTree` so `rebuildFixtureTree` can re-seed in place
 * without churning the tempdir paths the running app has captured via
 * env vars (STS2_FIXTURE_GAME_PATH / STS2_CONFIG_DIR / STS2_CACHE_DIR).
 */
function seedFixtureGameTree({ game, config, cache }) {
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
}

/**
 * Tears down everything inside the fixture dirs and re-seeds the
 * tree. Reuses the same paths the running app captured at startup,
 * so STS2_FIXTURE_GAME_PATH / STS2_CONFIG_DIR / STS2_CACHE_DIR remain
 * valid. Called before each STATE_SPECS entry so a stateful spec
 * always sees the pristine fixture state regardless of which mutating
 * specs ran before it.
 *
 * NOTE: the running app holds an in-memory snapshot of mods/profiles
 * that this disk-level reset doesn't reach. Specs that need the app
 * to re-scan should navigate to Mods (or trigger whatever refresh the
 * surface they're testing already uses) — the same way the existing
 * specs naturally pick up post-toggle disk state.
 */
function rebuildFixtureTree() {
  if (!FIXTURE_DIRS) return;
  for (const d of [FIXTURE_DIRS.game, FIXTURE_DIRS.config, FIXTURE_DIRS.cache]) {
    if (existsSync(d)) {
      rmSync(d, { recursive: true, force: true });
    }
  }
  seedFixtureGameTree({
    game: FIXTURE_DIRS.game,
    config: FIXTURE_DIRS.config,
    cache: FIXTURE_DIRS.cache,
  });
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

/* ── Pre-flight ─────────────────────────────────────────────────── */

function preflight() {
  const problems = [];
  if (!existsSync(MSEDGEDRIVER)) {
    problems.push(
      `msedgedriver not found at ${MSEDGEDRIVER}.\n  Run: node qa/runner/scripts/download-msedgedriver.mjs`,
    );
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

function startTauriDriver() {
  // tauri-driver 2.0.6 is the intermediary: it launches the app, spawns
  // msedgedriver, and rewrites capabilities to match what the current
  // msedgedriver expects (the schema changed in WebView2 147, which
  // broke older tauri-driver 0.1.x).
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
    console.error(`[smoke] fixture game tree: ${FIXTURE_DIRS.game}`);
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
      '--native-driver', MSEDGEDRIVER,
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
  const rails = await driver.findElements(By.css('.gf-wiz-rail'));
  if (rails.length === 0) return;
  // "Skip setup" is the bottom-left button on every step of the wizard.
  const skip = await driver.findElement(
    By.xpath("//button[normalize-space(.)='Skip setup']"),
  );
  await skip.click();
  // Wait for the overlay to detach.
  await driver.wait(
    async () => (await driver.findElements(By.css('.gf-wiz-rail'))).length === 0,
    5_000,
    'Onboarding overlay did not dismiss after Skip setup click',
  );
}

async function specModsNavReachable(driver) {
  const mods = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Mods']"),
    'Sidebar Mods nav button',
  );
  await mods.click();
  await waitForElement(
    driver,
    By.xpath(
      "//button[contains(., 'Check for updates') or contains(., 'updates pending') or contains(., 'Up to date') or contains(., 'updates')]",
    ),
    'Mods toolbar audit button',
  );
}

async function specAuditButtonClickable(driver) {
  const auditBtn = await waitForElement(
    driver,
    By.xpath(
      "//button[contains(., 'Check for updates') or contains(., 'updates pending') or contains(., 'Up to date') or contains(., 'updates')]",
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
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Mods']"),
    'Sidebar Mods nav button',
  );
  await mods.click();

  // Find the toggle on the QaTestMod row.
  // Row class is `gf-mod-row` (per Mods.tsx line 564 - 'gf-mod-pinned'
  // is applied conditionally, parent class is hover:bg-surface-hover
  // which doesn't help). The toggle is a `[role=switch]` from the
  // Toggle component. We scope by climbing from the QaTestMod label.
  const toggle = await waitForElement(
    driver,
    By.xpath(
      "//*[normalize-space(text())='QaTestMod']/ancestor::*[.//button[@role='switch']][1]//button[@role='switch']",
    ),
    'QaTestMod toggle switch',
  );
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

  // And the UI matches the disk state.
  const after = await toggle.getAttribute('aria-checked');
  if (after !== 'false') {
    throw new Error(`expected QaTestMod toggle aria-checked=false after click, got ${after}`);
  }
}

/**
 * Cassette-mode spec: pin QaTestMod (the only mod with a pending
 * update via cassette), re-run the audit, and assert the count
 * collapses to "Up to date". The pin should suppress the row from
 * the pending count even though the cassette would otherwise return
 * a newer version. Locks the contract on the
 * `!a.pinned` filter in `auditPendingCount` (Mods.tsx:122).
 */
async function specPinSuppressesPendingUpdate(driver) {
  const mods = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Mods']"),
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

  const pinItem = await waitForElement(
    driver,
    By.xpath("//button[@role='menuitem'][contains(., 'Pin this mod')]"),
    'Pin this mod menu item',
  );
  await pinItem.click();
  // Backend write + refresh roundtrip.
  await delay(800);

  // Now re-run the audit; QaTestMod is pinned so its pending update
  // shouldn't count. The toolbar should read "Up to date".
  const auditBtn = await waitForElement(
    driver,
    By.xpath(
      "//button[contains(., 'Check for updates') or contains(., ' update') or contains(., 'Up to date')]",
    ),
    'audit button',
  );
  await auditBtn.click();
  await driver.wait(
    async () => {
      const txt = (await auditBtn.getText().catch(() => '')).trim();
      return /^up to date$/i.test(txt);
    },
    30_000,
    'audit did not settle to "Up to date" after pinning QaTestMod',
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
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Mods']"),
    'Sidebar Mods nav button',
  );
  await mods.click();
  await waitForElement(
    driver,
    By.xpath("//*[normalize-space(text())='UpToDateMod']"),
    'UpToDateMod row',
  );

  const kebab = await waitForElement(
    driver,
    By.xpath(
      "//*[normalize-space(text())='UpToDateMod']/ancestor::*[.//button[@title='Mod actions']][1]//button[@title='Mod actions']",
    ),
    'UpToDateMod kebab button',
  );
  await kebab.click();

  const removeItem = await waitForElement(
    driver,
    By.xpath("//button[@role='menuitem'][contains(., 'Remove mod')]"),
    '"Remove mod…" menu item',
  );
  await removeItem.click();

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
 * Profile creation flow: click Profiles → New profile → type name →
 * Create. Verify the profile card appears in the list. Profiles are
 * one of the highest-risk surfaces (the apply / snapshot / switch
 * chain has multiple historical bugs), so we want at minimum a happy-
 * path spec proving the create handler doesn't blow up.
 */
async function specCreateProfile(driver) {
  const nav = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Profiles']"),
    'Sidebar Profiles nav button',
  );
  await nav.click();

  const newBtn = await waitForElement(
    driver,
    By.xpath("//button[contains(., 'New profile')]"),
    '"New profile" button',
  );
  await newBtn.click();

  // Form input — labeled "Profile Name" via a sibling <label>. Find by
  // placeholder which is stable.
  const input = await waitForElement(
    driver,
    By.css("input[placeholder='My Profile']"),
    'Profile-name input',
  );
  // The smoke harness uses a unique name so re-runs against the same
  // STS2_CONFIG_DIR (e.g. when a dev sticks a static one in) don't
  // collide. The fixture config dir is fresh per run, but the unique
  // suffix also rules out caching weirdness.
  const profileName = `QA Smoke ${Date.now().toString(36)}`;
  await input.sendKeys(profileName);

  const createBtn = await waitForElement(
    driver,
    By.xpath("//button[normalize-space(.)='Create']"),
    'Create-profile submit button',
  );
  await createBtn.click();

  // Card appears in the list. We don't depend on it becoming ACTIVE —
  // handleCreate doesn't auto-switch. (Switching is a separate spec.)
  await waitForElement(
    driver,
    By.xpath(`//*[contains(@class, 'gf-card') or self::h3][normalize-space(text())='${profileName}']`),
    `Profile card for "${profileName}"`,
    8_000,
  );
}

/**
 * v1.3.1 contract: a mod pinned while one profile is active still
 * shows the "Pinned" pill after the user round-trips through another
 * profile and back. Pin state lives in mod_sources.json (config dir),
 * not the profile manifest, so any future refactor that accidentally
 * folds pins into the per-profile snapshot — or has switch_profile
 * stomp on mod_sources during apply — would break this assertion.
 *
 * Flow:
 *   1. Profiles → create + activate "Orig" profile (becomes active).
 *   2. Mods → pin QaTestMod via kebab. Verify "Pinned" pill rendered.
 *   3. Profiles → create + activate "Other" profile.
 *   4. Profiles → switch back to "Orig".
 *   5. Mods → assert QaTestMod still shows the "Pinned" pill.
 */
async function specProfileSwitchPreservesPins(driver) {
  const suffix = Date.now().toString(36);
  const origName = `QA Orig ${suffix}`;
  const otherName = `QA Switch ${suffix}`;

  await navToProfiles(driver);
  await createProfileNamed(driver, origName);
  await waitForToastsToClear(driver);
  await activateProfile(driver, origName);
  await waitForToastsToClear(driver);

  // Pin QaTestMod from the Mods view.
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
  const pinItem = await waitForElement(
    driver,
    By.xpath("//button[@role='menuitem'][contains(., 'Pin this mod')]"),
    'Pin this mod menu item',
  );
  await pinItem.click();
  // Wait for the durable indicator (Pinned pill) to render — proves the
  // backend write landed and React picked up the source-list change.
  await waitForElement(
    driver,
    By.xpath(
      "//*[normalize-space(text())='QaTestMod']/ancestor::*[contains(@class,'gf-mod-pinned')][1]//*[normalize-space(text())='Pinned']",
    ),
    '"Pinned" pill on QaTestMod row after pin',
    8_000,
  );

  // Now round-trip through a second profile and back.
  await waitForToastsToClear(driver);
  await navToProfiles(driver);
  await createProfileNamed(driver, otherName);
  await waitForToastsToClear(driver);
  await activateProfile(driver, otherName);
  await waitForToastsToClear(driver);
  await activateProfile(driver, origName);
  await waitForToastsToClear(driver);

  // Verify the pin survived the switch round trip.
  await navToMods(driver);
  await waitForElement(
    driver,
    By.xpath(
      "//*[normalize-space(text())='QaTestMod']/ancestor::*[contains(@class,'gf-mod-pinned')][1]//*[normalize-space(text())='Pinned']",
    ),
    '"Pinned" pill on QaTestMod row after profile-switch round trip',
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
 *   2. Profiles → create "Other", activate it, then switch back to the
 *      starting profile via the Default profile card.
 *   3. Mods → assert QaTestMod toggle still reads aria-checked=false
 *      AND the folder is still in `mods_disabled/`, not resurrected
 *      into `mods/`.
 */
async function specToggleStickyAcrossProfileSwitch(driver) {
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
  const afterToggle = await toggle.getAttribute('aria-checked');
  if (afterToggle !== 'false') {
    throw new Error(`expected QaTestMod toggle aria-checked=false after click, got ${afterToggle}`);
  }

  // Step 2: round-trip through a second profile. The fixture starts
  // with a "Default" profile active (Profiles.tsx auto-creates one);
  // we create "Other", activate it, then activate "Default" again.
  const suffix = Date.now().toString(36);
  const otherName = `QA Other ${suffix}`;
  const origName = `QA Orig ${suffix}`;

  await waitForToastsToClear(driver);
  await navToProfiles(driver);
  // Create the starting profile we'll return to. We don't activate it
  // first because whatever profile is currently active works as the
  // "origin"; what matters is that we explicitly switch away and back.
  await createProfileNamed(driver, origName);
  await waitForToastsToClear(driver);
  await activateProfile(driver, origName);
  await waitForToastsToClear(driver);
  await createProfileNamed(driver, otherName);
  await waitForToastsToClear(driver);
  await activateProfile(driver, otherName);
  await waitForToastsToClear(driver);
  await activateProfile(driver, origName);
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
      `bug #22 regression: QaTestMod toggle resurrected to aria-checked=${finalChecked} after profile switch round trip (expected false)`,
    );
  }
  if (!existsSync(disabledDir)) {
    throw new Error(
      `bug #22 regression: mods_disabled/QaTestMod vanished after profile switch round trip`,
    );
  }
  if (existsSync(enabledDir)) {
    throw new Error(
      `bug #22 regression: mods/QaTestMod reappeared on disk after profile switch round trip`,
    );
  }
}

/* ── Helpers ────────────────────────────────────────────────────── */

async function navToProfiles(driver) {
  const nav = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Profiles']"),
    'Sidebar Profiles nav button',
  );
  await nav.click();
}

async function navToMods(driver) {
  const nav = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Mods']"),
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

/**
 * Click "New profile" → type name → Create. Assumes we're already on
 * the Profiles view. Waits for the resulting card to render.
 */
async function createProfileNamed(driver, profileName) {
  const newBtn = await waitForElement(
    driver,
    By.xpath("//button[contains(., 'New profile')]"),
    '"New profile" button',
  );
  await newBtn.click();
  const input = await waitForElement(
    driver,
    By.css("input[placeholder='My Profile']"),
    'Profile-name input',
  );
  await input.sendKeys(profileName);
  const createBtn = await waitForElement(
    driver,
    By.xpath("//button[normalize-space(.)='Create']"),
    'Create-profile submit button',
  );
  await createBtn.click();
  await waitForElement(
    driver,
    By.xpath(`//h3[contains(normalize-space(.), '${profileName}')]`),
    `Profile card for "${profileName}"`,
    8_000,
  );
}

/**
 * Activate the named profile by clicking its "Switch to" button, then
 * wait for the ACTIVE badge to appear on that same card. The badge is
 * rendered inside the profile's <h3> next to the name (Profiles.tsx
 * line ~663), and only one card has it at a time — so waiting on
 * "ACTIVE badge on this row" disambiguates from any pre-existing
 * active profile elsewhere in the list.
 *
 * Also waits for the switching overlay (`gf-loading-card`) to
 * disappear before returning so the next interaction doesn't race a
 * still-disabled button.
 */
async function activateProfile(driver, profileName) {
  // Scope: row is a `gf-card` (Card component) whose h3 contains the
  // profile name. From there, find the "Switch to" button.
  const switchBtnXpath =
    `//*[contains(@class,'gf-card')][.//h3[contains(normalize-space(.), '${profileName}')]]` +
    `//button[normalize-space(.)='Switch to' or contains(., 'Switch to')]`;
  const switchBtn = await waitForElement(
    driver,
    By.xpath(switchBtnXpath),
    `"Switch to" button for profile "${profileName}"`,
  );
  await switchBtn.click();

  // Switching overlay (gf-loading-card) appears while the backend
  // applies the manifest. Wait for it to detach before checking the
  // active badge — its presence also disables all profile buttons.
  await driver.wait(
    async () => (await driver.findElements(By.css('.gf-loading-card'))).length === 0,
    30_000,
    `Profile switch to "${profileName}" never settled (loading overlay stuck)`,
  );

  // ACTIVE badge must be on THIS profile's card, not just somewhere on
  // the page. Scope under the row whose h3 has the name.
  await waitForElement(
    driver,
    By.xpath(
      `//*[contains(@class,'gf-card')][.//h3[contains(normalize-space(.), '${profileName}')]]` +
        `//*[normalize-space(text())='ACTIVE']`,
    ),
    `ACTIVE badge on profile "${profileName}"`,
    10_000,
  );
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected "${expected}", got "${actual}"`);
  }
}

async function waitForElement(driver, locator, label, timeoutMs = 10_000) {
  await driver.wait(until.elementLocated(locator), timeoutMs, `Timed out waiting for ${label}`);
  return driver.findElement(locator);
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

async function specSettingsAuditTabLoads(driver) {
  // The audit-state lift to AppContext means Settings + Mods consume
  // the same data. Navigate to Settings and verify the Audit tab is
  // clickable + the table area renders. This proves the refactor
  // didn't break Settings — if AppContext destructure or unused-import
  // cleanup left a hole, the tab strip would crash on render.
  const settings = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Settings']"),
    'Sidebar Settings nav button',
  );
  await settings.click();
  // Tab strip is in a `gf-tabs` container with buttons for each tab.
  // Audit tab has text "Audit".
  const auditTab = await waitForElement(
    driver,
    By.xpath("//button[contains(@class, 'gf-tab') and contains(., 'Audit')]"),
    'Settings → Audit tab button',
  );
  await auditTab.click();
  // After clicking, the audit empty-state OR table must render. Both
  // share the `gf-empty-pad` (empty state when no audit yet) or
  // an audit row container.
  await driver.wait(
    async () => {
      const empty = await driver.findElements(By.css('.gf-empty-pad'));
      const rows = await driver.findElements(By.css('.gf-audit-led'));
      const runBtn = await driver.findElements(
        By.xpath("//button[contains(., 'Run audit') or contains(., 'Re-audit')]"),
      );
      return empty.length > 0 || rows.length > 0 || runBtn.length > 0;
    },
    8_000,
    'Settings → Audit tab body never rendered (run button, rows, or empty state)',
  );
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
    By.xpath("//button[contains(@class, 'gf-nav') and normalize-space(.)='Mods']"),
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
      "//button[contains(., 'Check for updates') or contains(., ' update') or contains(., 'Up to date')]",
    ),
    'audit button',
  );
  await auditBtn.click();

  // After audit completes the toolbar button reads "1 update".
  // We wait on the literal because "1 update" disambiguates from the
  // 0-pending ("Up to date") and the pre-audit ("Check for updates")
  // copy. If the cassette didn't load we'd either time out here OR
  // see a much larger count from the real network's response — both
  // are diagnostic.
  await driver.wait(
    async () => {
      const txt = await auditBtn.getText().catch(() => '');
      return /^1 update$/i.test(txt.trim());
    },
    30_000,
    'audit button never settled to "1 update" — cassette/fixture wiring is off',
  );

  // Also assert the green "Update available" pill rendered on the
  // QaTestMod row. Catches the case where the audit count comes back
  // right but the per-row UI didn't update.
  await waitForElement(
    driver,
    By.xpath("//*[contains(text(),'QaTestMod')]/ancestor::*[contains(@class,'gf-mod-row') or contains(@class,'gf-card')][1]//*[contains(text(),'Update available')]"),
    'Update-available pill on QaTestMod row',
    5_000,
  );
}

const BASE_SPECS = [
  ['main window renders', specMainWindowRenders],
  ['onboarding overlay dismisses cleanly', dismissOnboardingIfPresent],
  ['Mods nav reachable + audit button present', specModsNavReachable],
  ['audit button is clickable at rest', specAuditButtonClickable],
  ["WhatsNewCard renders or is dismissed", specWhatsNewCardRenders],
  ['Settings Audit tab loads after refactor', specSettingsAuditTabLoads],
];

const CASSETTE_SPECS = [
  ['audit shows "1 update" with cassette + fixture mods', specAuditAgainstCassettesShowsOnePending],
  ['pin on QaTestMod suppresses its pending update', specPinSuppressesPendingUpdate],
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
  ['delete UpToDateMod via kebab → Remove mod…', specDeleteUpToDateMod],
  ['create profile via Profiles → New profile', specCreateProfile],
  ['profile switch preserves pins (v1.3.1 contract)', specProfileSwitchPreservesPins],
  ['#22: toggle state sticky across profile switch', specToggleStickyAcrossProfileSwitch],
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
  await delay(1500);

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
