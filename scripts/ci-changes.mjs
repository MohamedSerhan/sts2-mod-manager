// scripts/ci-changes.mjs
// Pure helpers + thin CLI for the change-aware CI gate (.github/workflows/ci.yml).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Anything that affects the built app: frontend + Rust source, bundled assets,
// and the root build/test config (Vite/TS/Tauri/manifests). NOT qa/ (test
// harness) or registry/ (standalone data) — neither is imported by src/ or
// bundled as a Tauri resource.
const APP_PATTERNS = [
  /^src\//,
  /^src-tauri\/(?!target\/)/,
  /^public\//,
  /^index\.html$/,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^tsconfig(\.\w+)?\.json$/,
  /^vite\.config\.[cm]?[jt]s$/,
  /^vitest\.config\.[cm]?[jt]s$/,
  /^src-tauri\/Cargo\.toml$/,
  /^src-tauri\/Cargo\.lock$/,
  /^src-tauri\/tauri\.conf\.json$/,
];

/** Bucket a list of changed file paths into the gate's categories. */
export function classifyPaths(paths) {
  const list = (Array.isArray(paths) ? paths : []).filter((p) => typeof p === 'string' && p.length);
  return {
    app: list.some((p) => APP_PATTERNS.some((re) => re.test(p))),
    scripts: list.some((p) => /^scripts\//.test(p)),
    workflows: list.some((p) => /^\.github\/workflows\//.test(p)),
    qa: list.some((p) => /^qa\//.test(p)),
  };
}

/** Count bullet lines ("- ..."/"* ...") under the `## [Unreleased]` heading.
 *  Indented sub-bullets count too — any unreleased content satisfies the gate. */
export function unreleasedBulletCount(changelogText) {
  const lines = (typeof changelogText === 'string' ? changelogText : '').split(/\r?\n/);
  let inSection = false;
  let count = 0;
  for (const line of lines) {
    if (/^##\s+\[/.test(line)) { inSection = /^##\s+\[Unreleased\]/i.test(line); continue; }
    if (inSection && /^\s*[-*]\s+\S/.test(line)) count += 1;
  }
  return count;
}

/** Suggest a semver bump from the CHANGELOG `[Unreleased]` section.
 *  `Removed` or a `BREAKING` marker -> 'major'; `Added`/`Changed`/`Deprecated`
 *  -> 'minor'; only `Fixed`/`Security` -> 'patch'. Returns null when the
 *  `[Unreleased]` section has no bullet content. */
export function suggestedBump(changelogText) {
  const lines = (typeof changelogText === 'string' ? changelogText : '').split(/\r?\n/);
  let inSection = false;
  let heading = null;
  const filled = new Set();
  let breaking = false;
  for (const line of lines) {
    if (/^##\s+\[/.test(line)) { inSection = /^##\s+\[Unreleased\]/i.test(line); heading = null; continue; }
    if (!inSection) continue;
    if (/^###\s+/.test(line)) { heading = line.replace(/^###\s+/, '').trim().toLowerCase(); continue; }
    if (/\bBREAKING\b/i.test(line)) breaking = true;
    if (heading && /^\s*[-*]\s+\S/.test(line)) filled.add(heading);
  }
  if (filled.size === 0 && !breaking) return null;
  if (breaking || filled.has('removed')) return 'major';
  if (filled.has('added') || filled.has('changed') || filled.has('deprecated')) return 'minor';
  return 'patch';
}

function readStdin() { try { return readFileSync(0, 'utf-8'); } catch { return ''; } }

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === 'classify') {
    const paths = readStdin().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const { app, scripts, workflows, qa } = classifyPaths(paths);
    console.log(`app=${app}`);
    console.log(`scripts=${scripts}`);
    console.log(`workflows=${workflows}`);
    console.log(`qa=${qa}`);
  } else if (cmd === 'unreleased-count') {
    console.log(unreleasedBulletCount(readStdin()));
  } else if (cmd === 'suggested-bump') {
    const b = suggestedBump(readStdin());
    if (b) console.log(b);
  } else {
    console.error('usage: ci-changes.mjs classify|unreleased-count|suggested-bump');
    process.exit(2);
  }
}
