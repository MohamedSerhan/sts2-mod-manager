// Classify changed paths into conservative QA risk areas and verification commands.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = join(__dirname, '..');

const COMMANDS = {
  i18n: 'npm run qa:i18n',
  coverage: 'npm run qa:coverage',
  rust: 'npm run qa:rust',
  rustCassette: 'npm run qa:rust:cassette',
  matrix: 'npm run qa:matrix',
  smokeCheck: 'node --check qa/runner/smoke.mjs',
  smoke: 'npm run qa:smoke',
  smokeCassette: 'npm run qa:smoke:cassette',
  changelogLint: 'node scripts/changelog-fragments.mjs lint',
  changelogTranslations: 'node scripts/changelog-translations.mjs check-fragments',
  qaOwnersTest: 'node --test scripts/qa-owners.test.mjs',
  qaImpactTest: 'node --test scripts/qa-impact.test.mjs',
  qaMatrixTest: 'node --test scripts/qa-coverage-matrix.test.mjs',
};

const HIGH_RISK_UI_RE = /^(?:src\/App\.tsx|src\/views\/(?:Mods|Profiles|Home|Settings|Browse|BrowseModpacks)\.tsx|src\/components\/(?:SourceEditor|QuickAddModal|LibraryRow|LibraryTable|ModpackDetail|CreateModpackWizard|MissingBundlesPanel|PublishModal|ShareSetupPanel|LogsViewer|AboutCard|DiagnosticBundle)|src\/hooks\/useModLibrary)/;
const CASSETTE_RE = /(updater|downloads_watcher|download|nexus|sharing|subscriptions|audit|version|SourceEditor|QuickAdd|LibraryTable|ModpackDetail)/i;

function addArea(areas, id, label, path) {
  if (!areas.has(id)) {
    areas.set(id, { id, label, paths: [] });
  }
  areas.get(id).paths.push(path);
}

function addCommand(commands, command) {
  commands.add(command);
}

function normalizePath(path) {
  return String(path ?? '').trim().replace(/^"|"$/g, '').replace(/\\/g, '/');
}

export function parseChangedPaths(input) {
  return Array.from(new Set(
    String(input ?? '')
      .split(/\r?\n/)
      .map(normalizePath)
      .filter(Boolean),
  ));
}

function isDocsPath(path) {
  return /\.(?:md|txt)$/.test(path) || path.startsWith('docs/');
}

function isPackageOrBuildConfig(path) {
  return /^(?:package(?:-lock)?\.json|tsconfig(?:\.\w+)?\.json|vite\.config\.[cm]?[jt]s|vitest\.config\.[cm]?[jt]s|tailwind\.config\.[cm]?[jt]s|src-tauri\/Cargo\.(?:toml|lock)|src-tauri\/tauri\.conf\.json)$/.test(path);
}

function classifyPath(path, state) {
  let matched = false;

  if (path.startsWith('src/i18n/locales/')) {
    matched = true;
    state.docsOnly = false;
    addArea(state.areas, 'i18n', 'i18n locale files', path);
    addCommand(state.commands, COMMANDS.i18n);
    addCommand(state.commands, COMMANDS.coverage);
  }

  if (path.startsWith('src/') || path === 'src/styles.css') {
    matched = true;
    state.docsOnly = false;
    addArea(state.areas, 'frontend', 'frontend source', path);
    addCommand(state.commands, COMMANDS.coverage);
    if (HIGH_RISK_UI_RE.test(path)) {
      state.highRisk = true;
      state.notes.push(`${path}: high-risk UI boundary; include WebDriver smoke evidence when practical.`);
      addCommand(state.commands, COMMANDS.smoke);
      if (CASSETTE_RE.test(path)) addCommand(state.commands, COMMANDS.smokeCassette);
    }
  }

  if (path.startsWith('src-tauri/')) {
    matched = true;
    state.docsOnly = false;
    addArea(state.areas, 'rust', 'Rust/Tauri source', path);
    addCommand(state.commands, COMMANDS.rust);
    if (CASSETTE_RE.test(path)) addCommand(state.commands, COMMANDS.rustCassette);
  }

  if (path.startsWith('qa/runner/') || path.startsWith('qa/fixtures/') || path.startsWith('qa/harness/')) {
    matched = true;
    state.docsOnly = false;
    state.highRisk = true;
    addArea(state.areas, 'smoke', 'QA smoke harness', path);
    addCommand(state.commands, COMMANDS.smokeCheck);
    addCommand(state.commands, COMMANDS.smoke);
    addCommand(state.commands, COMMANDS.smokeCassette);
  }

  if (/^qa\/(?:coverage-matrix|interaction-inventory|walkthrough-findings|README)\.md$/.test(path) || path.startsWith('qa/scenarios/')) {
    matched = true;
    state.docsOnly = false;
    addArea(state.areas, 'qa-matrix', 'QA matrix or inventory', path);
    addCommand(state.commands, COMMANDS.matrix);
  }

  if (path.startsWith('scripts/')) {
    matched = true;
    state.docsOnly = false;
    addArea(state.areas, 'scripts', 'QA/release scripts', path);
    if (/^scripts\/qa-owners(?:\.test)?\.mjs$/.test(path)) addCommand(state.commands, COMMANDS.qaOwnersTest);
    if (/^scripts\/qa-impact(?:\.test)?\.mjs$/.test(path)) addCommand(state.commands, COMMANDS.qaImpactTest);
    if (/^scripts\/qa-coverage-matrix(?:\.test)?\.mjs$/.test(path)) addCommand(state.commands, COMMANDS.qaMatrixTest);
    if (/^scripts\/(?:qa-|release-windows-installer-policy)/.test(path)) addCommand(state.commands, COMMANDS.matrix);
  }

  if (path.startsWith('.github/workflows/')) {
    matched = true;
    state.docsOnly = false;
    state.highRisk = true;
    addArea(state.areas, 'workflows', 'workflow files', path);
    addCommand(state.commands, COMMANDS.matrix);
    state.notes.push(`${path}: workflow behavior needs CI review in addition to local commands.`);
  }

  if (isPackageOrBuildConfig(path)) {
    matched = true;
    state.docsOnly = false;
    state.highRisk = true;
    addArea(state.areas, 'package-config', 'package/build config', path);
    addCommand(state.commands, COMMANDS.matrix);
    addCommand(state.commands, COMMANDS.coverage);
    addCommand(state.commands, COMMANDS.rust);
  }

  if (path.startsWith('changelog.d/')) {
    matched = true;
    state.docsOnly = false;
    addArea(state.areas, 'changelog', 'changelog fragments', path);
    addCommand(state.commands, COMMANDS.changelogLint);
    addCommand(state.commands, COMMANDS.changelogTranslations);
  }

  if (!matched && isDocsPath(path)) {
    matched = true;
    addArea(state.areas, 'docs-only', 'docs-only', path);
  }

  if (!matched) {
    state.docsOnly = false;
    state.highRisk = true;
    addArea(state.areas, 'unknown', 'unknown or unclassified files', path);
    addCommand(state.commands, COMMANDS.matrix);
    addCommand(state.commands, COMMANDS.coverage);
    addCommand(state.commands, COMMANDS.rust);
    state.notes.push(`${path}: unclassified path; defaulting to broad QA.`);
  }
}

export function analyzeChangedPaths(paths, options = {}) {
  const normalizedPaths = Array.from(new Set(paths.map(normalizePath).filter(Boolean)));
  const state = {
    base: options.base ?? null,
    paths: normalizedPaths,
    areas: new Map(),
    commands: new Set(),
    docsOnly: normalizedPaths.length > 0,
    highRisk: false,
    notes: [],
  };

  for (const path of normalizedPaths) {
    classifyPath(path, state);
  }

  if (normalizedPaths.length === 0) {
    state.docsOnly = false;
    state.notes.push('No changed paths were detected.');
  }

  return {
    base: state.base,
    paths: state.paths,
    docsOnly: state.docsOnly,
    highRisk: state.highRisk,
    impactedAreas: Array.from(state.areas.values()),
    requiredCommands: Array.from(state.commands),
    notes: Array.from(new Set(state.notes)),
  };
}

function safeBaseRef(base) {
  const value = String(base ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*(?:~\d+)?$/.test(value) || value.includes('..')) {
    throw new Error(`invalid git base ref: ${base}`);
  }
  return value;
}

function runGit(repoRoot, args) {
  return execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

export function defaultBase(repoRoot = DEFAULT_REPO_ROOT) {
  try {
    runGit(repoRoot, ['rev-parse', '--verify', 'origin/main']);
    return 'origin/main';
  } catch {
    return 'HEAD';
  }
}

function changedPathsFromGit(repoRoot, base) {
  const safeBase = safeBaseRef(base);
  const outputs = [];
  try {
    outputs.push(runGit(repoRoot, ['diff', '--name-only', '--diff-filter=ACMR', `${safeBase}...HEAD`]));
  } catch {
    outputs.push(runGit(repoRoot, ['diff', '--name-only', '--diff-filter=ACMR', safeBase]));
  }

  for (const args of [
    ['diff', '--name-only', '--diff-filter=ACMR'],
    ['diff', '--cached', '--name-only', '--diff-filter=ACMR'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    try {
      outputs.push(runGit(repoRoot, args));
    } catch {
      // Keep the report usable in partial checkouts.
    }
  }

  return parseChangedPaths(outputs.join('\n'));
}

export function parseArgs(argv) {
  const args = { json: false, base: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
    } else if (arg === '--base') {
      args.base = argv[index + 1] ?? null;
      index += 1;
    } else if (arg.startsWith('--base=')) {
      args.base = arg.slice('--base='.length);
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    }
  }
  return args;
}

function readStdinIfAvailable() {
  if (process.stdin.isTTY) return '';
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

export function formatImpactReport(result) {
  const lines = [
    'QA impact analysis',
    `Changed paths: ${result.paths.length}`,
    `Risk: ${result.highRisk ? 'high' : result.docsOnly ? 'docs-only' : 'standard'}`,
  ];

  if (result.base) lines.push(`Base: ${result.base}`);

  if (result.impactedAreas.length) {
    lines.push('', 'Impacted areas:');
    for (const area of result.impactedAreas) {
      lines.push(`- ${area.label}: ${area.paths.join(', ')}`);
    }
  }

  lines.push('', 'Required verification:');
  if (result.requiredCommands.length) {
    for (const command of result.requiredCommands) {
      lines.push(`- ${command}`);
    }
  } else {
    lines.push('- No automated QA command required by this classifier; review the diff manually.');
  }

  if (result.notes.length) {
    lines.push('', 'Notes:');
    for (const note of result.notes) {
      lines.push(`- ${note}`);
    }
  }

  return lines.join('\n');
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node scripts/qa-impact.mjs [--json] [--base <ref>]\nPass changed paths on stdin for deterministic analysis. With no stdin, the script compares against origin/main when available, otherwise HEAD, and includes local working-tree changes.');
    process.exit(0);
  }

  const stdinPaths = parseChangedPaths(readStdinIfAvailable());
  let base;
  try {
    base = safeBaseRef(args.base ?? defaultBase(DEFAULT_REPO_ROOT));
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(2);
  }
  const paths = stdinPaths.length ? stdinPaths : changedPathsFromGit(DEFAULT_REPO_ROOT, base);
  const result = analyzeChangedPaths(paths, { base });

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatImpactReport(result));
  }
}
