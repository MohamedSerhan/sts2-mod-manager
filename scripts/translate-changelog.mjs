/**
 * Release-time changelog translator.
 *
 * Translates the latest RELEASED CHANGELOG.md entry into each non-English
 * locale and merges it into src/i18n/changelog/<locale>.json (version-keyed
 * markdown bodies). Bundled at build time and read by getTranslatedBody().
 *
 * Design goals:
 *   - Idempotent: skips a version already translated (unless --force).
 *   - Non-blocking: missing ANTHROPIC_API_KEY or an API error warns and exits 0
 *     so a release is never blocked; the app falls back to English.
 *   - Testable: run() accepts an injected translateFn so node:test never needs
 *     the SDK or a network.
 *
 * Usage:
 *   node scripts/translate-changelog.mjs            # latest released entry
 *   node scripts/translate-changelog.mjs --version 1.7.1
 *   node scripts/translate-changelog.mjs --force    # re-translate even if present
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

export const LOCALES = [
  { key: 'ru', name: 'Russian' },
  { key: 'ar', name: 'Arabic' },
  { key: 'zh-Hans', name: 'Simplified Chinese' },
];

const HEADING_RE = /^##\s+\[([^\]]+)\](?:\s*-\s*([0-9]{4}-[0-9]{2}-[0-9]{2}))?/;

/** Parse the newest non-Unreleased entry from CHANGELOG.md text. */
export function parseLatestReleasedEntry(raw) {
  const lines = raw.split(/\r?\n/);
  let current = null;
  let buf = [];
  const entries = [];
  const flush = () => {
    if (current) {
      entries.push({ version: current.version, body: buf.join('\n').trim() });
      current = null;
      buf = [];
    }
  };
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      flush();
      current = { version: m[1] };
      continue;
    }
    if (current) buf.push(line);
  }
  flush();
  return (
    entries.find(
      (e) => e.body.length > 0 && e.version.toLowerCase() !== 'unreleased',
    ) ?? null
  );
}

const SYSTEM_PROMPT = [
  'You are a precise software-changelog translator.',
  'Translate the given Markdown changelog body into the target language.',
  'Rules:',
  '- Preserve Markdown structure EXACTLY: `### ` subheadings, `-` bullets, blank lines.',
  '- Do NOT translate code spans (`like_this`), URLs, version numbers, or proper',
  '  nouns / product names (Nexus, GitHub, Steam, Proton, Slay the Spire 2, mod',
  '  names, UI labels shown in quotes that are English in the app).',
  '- Translate prose only. Keep the tone player-facing and concise.',
  '- Output ONLY the translated Markdown body — no preamble, no code fence.',
].join('\n');

/** Default translator: one Anthropic API call per locale (prompt-cached system). */
async function anthropicTranslate(body, languageName) {
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY
  const model = process.env.CHANGELOG_TRANSLATE_MODEL || 'claude-sonnet-4-6';
  const resp = await client.messages.create({
    model,
    max_tokens: 4096,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [
      { role: 'user', content: `Target language: ${languageName}\n\n<changelog>\n${body}\n</changelog>` },
    ],
  });
  return resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function localePath(rootDir, key) {
  return join(rootDir, 'src', 'i18n', 'changelog', `${key}.json`);
}

function readMap(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  } catch {
    return {};
  }
}

/**
 * Translate one version into every locale and merge into the JSON maps.
 * Returns { version, written: [keys], skipped: [keys] }. Non-blocking.
 */
export async function run({
  translateFn = anthropicTranslate,
  rootDir = REPO_ROOT,
  version,
  force = false,
  log = console,
} = {}) {
  const usingRealApi = translateFn === anthropicTranslate;
  if (usingRealApi && !process.env.ANTHROPIC_API_KEY) {
    log.warn('translate-changelog: ANTHROPIC_API_KEY not set — skipping (app falls back to English).');
    return { version: null, written: [], skipped: [] };
  }

  const changelogPath = join(rootDir, 'CHANGELOG.md');
  if (!existsSync(changelogPath)) {
    log.warn(`translate-changelog: ${changelogPath} not found — nothing to do.`);
    return { version: null, written: [], skipped: [] };
  }
  const changelog = readFileSync(changelogPath, 'utf8');
  const latest = parseLatestReleasedEntry(changelog);
  const entry = version
    ? { version, body: sectionBodyFor(changelog, version) }
    : latest;
  if (!entry || !entry.body) {
    log.warn(`translate-changelog: no changelog entry found${version ? ` for ${version}` : ''} — nothing to do.`);
    return { version: null, written: [], skipped: [] };
  }

  const written = [];
  const skipped = [];
  for (const { key, name } of LOCALES) {
    const path = localePath(rootDir, key);
    const map = readMap(path);
    if (map[entry.version] && !force) {
      skipped.push(key);
      continue;
    }
    try {
      const translated = await translateFn(entry.body, name);
      if (!translated || !translated.trim()) throw new Error('empty translation');
      map[entry.version] = translated.trim();
      // Cosmetic key order only — the app looks up by exact version and never
      // iterates this map, so lexical-desc is "good enough" (not semver-aware).
      const ordered = Object.fromEntries(
        Object.keys(map).sort().reverse().map((k) => [k, map[k]]),
      );
      writeFileSync(path, JSON.stringify(ordered, null, 2) + '\n', 'utf8');
      written.push(key);
    } catch (err) {
      // Non-blocking: warn for this locale, keep going.
      log.warn(`translate-changelog: ${key} failed (${err.message}) — leaving English fallback.`);
    }
  }
  return { version: entry.version, written, skipped };
}

/** Body of a specific `## [version]` section (for --version). */
export function sectionBodyFor(raw, version) {
  const lines = raw.split(/\r?\n/);
  let inBlock = false;
  const buf = [];
  for (const line of lines) {
    const m = HEADING_RE.exec(line);
    if (m) {
      if (m[1] === version) { inBlock = true; continue; }
      if (inBlock) break;
    }
    if (inBlock) buf.push(line);
  }
  return buf.join('\n').trim();
}

function parseArgs(argv) {
  const args = { force: false, version: undefined, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--version') { args.version = argv[i + 1]; i += 1; }
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true;
  }
  return args;
}

// CLI entry — only when run directly (not when imported by tests). Use the
// canonical fileURLToPath comparison (matches scripts/changelog-fragments.mjs)
// so it's correct on Windows, where release.sh runs.
if (fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/translate-changelog.mjs [--version X.Y.Z] [--force]');
    process.exit(0);
  }
  run({ version: args.version, force: args.force })
    .then((r) => {
      if (r.version) console.log(`translate-changelog: ${r.version} — wrote [${r.written.join(', ')}], skipped [${r.skipped.join(', ')}]`);
      process.exit(0); // always non-blocking
    })
    .catch((err) => {
      console.warn(`translate-changelog: unexpected error (${err.message}) — continuing.`);
      process.exit(0);
    });
}
