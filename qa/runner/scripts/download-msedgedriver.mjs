#!/usr/bin/env node
/**
 * Auto-fetch the msedgedriver binary that matches this machine's
 * Microsoft Edge WebView2 runtime. Idempotent: re-running with the
 * matching driver already in place is a no-op.
 *
 * The smoke harness needs an exact runtime/driver version match,
 * otherwise Selenium fails at `Builder().build()` with
 * "SessionNotCreatedError: Chrome instance exited". WebView2
 * auto-updates on user machines (it's a Windows component), so the
 * driver pinned in the repo goes stale every few weeks. This script
 * makes the recovery one command instead of "grep the README and
 * remember Microsoft's CDN URL".
 *
 * Usage:
 *   node qa/runner/scripts/download-msedgedriver.mjs
 *   node qa/runner/scripts/download-msedgedriver.mjs --version 148.0.3967.54
 *
 * Falls back to the `--version` flag (or `WEBVIEW2_VERSION` env var)
 * when registry detection fails — useful for CI runners where the
 * version is known up-front but a registry probe doesn't apply.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_DIR = resolve(__dirname, '..');
const DRIVER_PATH = join(RUNNER_DIR, 'msedgedriver.exe');

const args = parseArgs(process.argv.slice(2));

main().catch((e) => {
  console.error(e.stack ?? e);
  process.exit(1);
});

async function main() {
  const wanted = args.version ?? process.env.WEBVIEW2_VERSION ?? detectWebView2Version();
  if (!wanted) {
    console.error(
      'Could not detect WebView2 runtime version. Pass --version <X.Y.Z.W> ' +
        'or set WEBVIEW2_VERSION. To inspect manually:\n' +
        '  Get-ItemProperty \'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\*\' ' +
        '| Where-Object { $_.name -like \'*WebView*\' } | Select-Object pv',
    );
    process.exit(2);
  }

  const installed = currentDriverVersion();
  if (installed === wanted) {
    console.log(`msedgedriver already at ${installed} — nothing to do.`);
    return;
  }
  console.log(
    `WebView2 runtime: ${wanted}; current driver: ${installed ?? '(missing)'} — fetching match…`,
  );

  const url = `https://msedgedriver.microsoft.com/${wanted}/edgedriver_win64.zip`;
  const tmpDir = mkdtempSync(join(tmpdir(), 'msedgedriver-'));
  const zipPath = join(tmpDir, 'driver.zip');

  try {
    await download(url, zipPath);
    extractZip(zipPath, tmpDir);
    const exe = readdirSync(tmpDir)
      .map((n) => join(tmpDir, n))
      .find((p) => p.toLowerCase().endsWith('msedgedriver.exe'));
    if (!exe) {
      throw new Error(`No msedgedriver.exe in the downloaded zip from ${url}`);
    }
    if (existsSync(DRIVER_PATH)) {
      rmSync(DRIVER_PATH);
    }
    mkdirSync(RUNNER_DIR, { recursive: true });
    // copy, not rename: on Windows CI the temp dir (C:) and the checkout (D:) are
    // different drives, so renameSync fails with EXDEV. The temp dir is cleaned below.
    copyFileSync(exe, DRIVER_PATH);
    console.log(`Installed ${DRIVER_PATH}`);
    console.log(`Verifying: ${currentDriverVersion()}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--version' && argv[i + 1]) {
      out.version = argv[++i];
    } else if (argv[i].startsWith('--version=')) {
      out.version = argv[i].slice('--version='.length);
    }
  }
  return out;
}

/** Read WebView2's `pv` (product version) field out of the Windows registry.
 *  Returns null on any failure — caller decides whether to fall back. */
function detectWebView2Version() {
  if (process.platform !== 'win32') return null;
  // Two parallel registry views: WOW6432Node (32-bit on 64-bit Windows)
  // and the native one. WebView2's installer lands in WOW6432Node on
  // most machines; we check both to be safe.
  const ps = [
    "$paths=@('HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients','HKLM:\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients');",
    "foreach($p in $paths){",
    "  Get-ItemProperty \"$p\\*\" -ErrorAction SilentlyContinue ",
    "  | Where-Object { $_.name -like '*WebView2*' } ",
    "  | ForEach-Object { Write-Output $_.pv }",
    "}",
  ].join(' ');
  const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    encoding: 'utf8',
  });
  // We don't gate on `out.status` because pipeline cmdlets sometimes
  // exit non-zero even when stdout has the expected version line (the
  // empty native EdgeUpdate registry path on a WOW6432-only machine is
  // a common trigger). The shape of stdout is the authority: a single
  // dotted-quad version somewhere in there means we succeeded.
  const stdout = (out.stdout ?? '') + '\n' + (out.stderr ?? '');
  const first = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => /^\d+\.\d+\.\d+\.\d+$/.test(l));
  return first ?? null;
}

function currentDriverVersion() {
  if (!existsSync(DRIVER_PATH)) return null;
  try {
    const stdout = execFileSync(DRIVER_PATH, ['--version'], { encoding: 'utf8' });
    // "Microsoft Edge WebDriver 148.0.3967.54 (hash)"
    const m = stdout.match(/(\d+\.\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function download(url, dest) {
  // Node 18+ has global fetch. Use it instead of pulling in another
  // dependency just for an HTTP GET.
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${res.statusText}`);
  }
  await pipeline(res.body, createWriteStream(dest));
}

function extractZip(zipPath, destDir) {
  // tar.exe ships in Windows 10+ and handles zip files. Avoids pulling
  // in adm-zip / unzipper just for one extraction. Falls back to a
  // helpful error if tar isn't available (older Windows or Linux).
  //
  // On Windows we must invoke the System32 bsdtar by absolute path: when
  // this script runs from Git Bash / MSYS (e.g. release.sh), a bare
  // "tar" resolves to GNU tar, which parses "C:\..." as host:path and
  // dies with `tar: Cannot connect to C: resolve failed`. System32
  // bsdtar has no such ambiguity.
  let tarBin = 'tar';
  if (process.platform === 'win32') {
    const sys32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
    if (existsSync(sys32)) tarBin = sys32;
  }
  const r = spawnSync(tarBin, ['-xf', zipPath, '-C', destDir], { stdio: 'pipe' });
  if (r.status !== 0) {
    throw new Error(
      `Failed to extract ${zipPath}: tar exited ${r.status}\n` +
        `stderr: ${r.stderr?.toString() ?? '(empty)'}\n` +
        `On older systems install tar (or 7zip) and re-run.`,
    );
  }
}
