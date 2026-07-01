import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeChangedPaths,
  formatImpactReport,
  parseArgs,
  parseChangedPaths,
} from './qa-impact.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, 'qa-impact.mjs');

test('parseChangedPaths normalizes stdin path lists', () => {
  assert.deepEqual(parseChangedPaths('src/App.tsx\r\nsrc\\App.tsx\n\n"qa/runner/smoke.mjs"\n'), [
    'src/App.tsx',
    'qa/runner/smoke.mjs',
  ]);
});

test('frontend and i18n changes require coverage and locale verification', () => {
  const result = analyzeChangedPaths([
    'src/App.tsx',
    'src/i18n/locales/en.json',
  ]);

  assert.deepEqual(result.impactedAreas.map((area) => area.id), ['frontend', 'i18n']);
  assert.equal(result.highRisk, true);
  assert.ok(result.requiredCommands.includes('npm run qa:coverage'));
  assert.ok(result.requiredCommands.includes('npm run qa:i18n'));
  assert.ok(result.requiredCommands.includes('npm run qa:smoke'));
});

test('Rust and smoke harness changes require Rust plus smoke commands', () => {
  const result = analyzeChangedPaths([
    'src-tauri/src/updater.rs',
    'qa/runner/smoke.mjs',
  ]);

  assert.ok(result.requiredCommands.includes('npm run qa:rust'));
  assert.ok(result.requiredCommands.includes('npm run qa:rust:cassette'));
  assert.ok(result.requiredCommands.includes('node --check qa/runner/smoke.mjs'));
  assert.ok(result.requiredCommands.includes('npm run qa:smoke'));
  assert.ok(result.requiredCommands.includes('npm run qa:smoke:cassette'));
});

test('QA matrix, scripts, workflows, package config, and changelog paths map to conservative commands', () => {
  const result = analyzeChangedPaths([
    'qa/coverage-matrix.md',
    'scripts/qa-owners.mjs',
    '.github/workflows/ci.yml',
    'package.json',
    'changelog.d/fixed-example.md',
  ]);

  assert.ok(result.requiredCommands.includes('npm run qa:matrix'));
  assert.ok(result.requiredCommands.includes('node --test scripts/qa-owners.test.mjs'));
  assert.ok(result.requiredCommands.includes('npm run qa:coverage'));
  assert.ok(result.requiredCommands.includes('npm run qa:rust'));
  assert.ok(result.requiredCommands.includes('node scripts/changelog-fragments.mjs lint'));
  assert.ok(result.requiredCommands.includes('node scripts/changelog-translations.mjs check-fragments'));
  assert.equal(result.highRisk, true);
});

test('docs-only paths do not invent automated QA commands', () => {
  const result = analyzeChangedPaths(['README.md', 'docs/notes.md']);

  assert.equal(result.docsOnly, true);
  assert.equal(result.highRisk, false);
  assert.deepEqual(result.requiredCommands, []);
  assert.match(formatImpactReport(result), /docs-only/);
});

test('unknown paths default to broad QA instead of under-testing', () => {
  const result = analyzeChangedPaths(['tools/custom.bin']);

  assert.equal(result.highRisk, true);
  assert.deepEqual(result.requiredCommands, [
    'npm run qa:matrix',
    'npm run qa:coverage',
    'npm run qa:rust',
  ]);
  assert.match(result.notes.join('\n'), /unclassified path/);
});

test('parseArgs supports JSON and base flags', () => {
  assert.deepEqual(parseArgs(['--json', '--base', 'origin/main']), {
    json: true,
    base: 'origin/main',
  });
  assert.deepEqual(parseArgs(['--base=HEAD']), {
    json: false,
    base: 'HEAD',
  });
});

test('CLI accepts changed paths from stdin and emits JSON', () => {
  const child = spawnSync(process.execPath, [SCRIPT_PATH, '--json', '--base', 'HEAD'], {
    input: 'src/App.tsx\n',
    encoding: 'utf8',
  });

  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.deepEqual(result.paths, ['src/App.tsx']);
  assert.ok(result.requiredCommands.includes('npm run qa:coverage'));
});

test('CLI rejects unsafe base refs before invoking git', () => {
  const child = spawnSync(process.execPath, [SCRIPT_PATH, '--json', '--base', '--output=/tmp/pwned'], {
    input: 'src/App.tsx\n',
    encoding: 'utf8',
  });

  assert.equal(child.status, 2);
  assert.match(child.stderr, /invalid git base ref/);
});
