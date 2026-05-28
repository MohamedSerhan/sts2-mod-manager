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
