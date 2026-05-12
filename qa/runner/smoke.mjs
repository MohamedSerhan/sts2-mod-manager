#!/usr/bin/env node
/**
 * End-to-end smoke test: launch the built Tauri app via tauri-driver,
 * connect with selenium-webdriver, click around, verify the new audit
 * surface on the Mods view renders + is interactive.
 *
 * See qa/runner/README.md for setup.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
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

/* ── Pre-flight ─────────────────────────────────────────────────── */

function preflight() {
  const problems = [];
  if (!existsSync(MSEDGEDRIVER)) {
    problems.push(
      `msedgedriver not found at ${MSEDGEDRIVER}. \n  Run: node -e "import('edgedriver').then(m=>m.download('147.0.3912.98').then(p=>console.log(p)))" (after npm i --no-save --prefix qa/runner edgedriver) and copy the printed path here.`,
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
}

/* ── Driver lifecycle ───────────────────────────────────────────── */

function startTauriDriver() {
  // tauri-driver 2.0.6 is the intermediary: it launches the app, spawns
  // msedgedriver, and rewrites capabilities to match what the current
  // msedgedriver expects (the schema changed in WebView2 147, which
  // broke older tauri-driver 0.1.x).
  const child = spawn(
    'tauri-driver',
    [
      '--port', String(DRIVER_PORT),
      '--native-port', String(NATIVE_PORT),
      '--native-driver', MSEDGEDRIVER,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
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

/* ── Helpers ────────────────────────────────────────────────────── */

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

const SPECS = [
  ['main window renders', specMainWindowRenders],
  ['onboarding overlay dismisses cleanly', dismissOnboardingIfPresent],
  ['Mods nav reachable + audit button present', specModsNavReachable],
  ['audit button is clickable at rest', specAuditButtonClickable],
  ["WhatsNewCard renders or is dismissed", specWhatsNewCardRenders],
  ['Settings Audit tab loads after refactor', specSettingsAuditTabLoads],
];

async function main() {
  preflight();
  mkdirSync(__dirname, { recursive: true });

  const driverProc = startTauriDriver();
  await delay(1500);

  let driver;
  let failed = false;
  try {
    driver = await buildDriver();
    for (const [name, fn] of SPECS) {
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
  }

  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e.stack ?? e);
  process.exit(1);
});
