import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  INTERACTION_INVENTORY_PATH,
  formatGateReport,
  readGateInputs,
  validateGate,
} from './qa-coverage-matrix.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const MATRIX_PATH = join(REPO_ROOT, 'qa', 'coverage-matrix.md');
const SCENARIO_INDEX_PATH = join(REPO_ROOT, 'qa', 'scenarios', 'INDEX.md');
const WALKTHROUGH_PATH = join(REPO_ROOT, 'qa', 'walkthrough-findings.md');
const PACKAGE_PATH = join(REPO_ROOT, 'package.json');
const CI_PATH = join(REPO_ROOT, '.github', 'workflows', 'ci.yml');
const RELEASE_PATH = join(REPO_ROOT, 'scripts', 'release.sh');

function read(path) {
  return readFileSync(path, 'utf8');
}

function section(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingMatch = text.match(new RegExp(`^## ${escaped}\\s*$`, 'm'));
  if (!headingMatch || headingMatch.index === undefined) return '';
  const rest = text.slice(headingMatch.index + headingMatch[0].length).replace(/^\r?\n/, '');
  const nextHeading = rest.search(/^## /m);
  return nextHeading === -1 ? rest : rest.slice(0, nextHeading);
}

function tableRows(markdown) {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|\s*-+/.test(line))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

function activeScenarioIds() {
  return tableRows(read(SCENARIO_INDEX_PATH))
    .filter((cells) => /^\[\d{3}\]/.test(cells[0] ?? '') && (cells[6] ?? '') === 'active')
    .map((cells) => cells[0].match(/\[(\d{3})\]/)[1]);
}

function historicalBugIds() {
  return tableRows(read(WALKTHROUGH_PATH))
    .filter((cells) => /^\d+$/.test(cells[0] ?? ''))
    .map((cells) => `#${cells[0]}`);
}

function matrixScenarioRows() {
  return tableRows(section(read(MATRIX_PATH), 'Scenario Owners'))
    .filter((cells) => /^\d{3}$/.test(cells[0] ?? ''))
    .map((cells) => ({
      id: cells[0],
      owner: cells[4],
      command: cells[5],
      status: cells[6],
    }));
}

function matrixHistoricalRows() {
  return tableRows(section(read(MATRIX_PATH), 'Historical Bug Owners'))
    .filter((cells) => /^#\d+$/.test(cells[0] ?? ''))
    .map((cells) => ({
      id: cells[0],
      owner: cells[4],
      status: cells[6],
    }));
}

function matrixMajorRows() {
  return tableRows(section(read(MATRIX_PATH), 'Major Flow Owners'))
    .filter((cells) => /^(?:\d+|A\d+)$/.test(cells[0] ?? ''))
    .map((cells) => ({
      id: cells[0],
      owner: cells[2],
      status: cells[3],
      reason: cells[4],
    }));
}

function inlineCodeValues(text) {
  return Array.from(text.matchAll(/`([^`]+)`/g), (match) => match[1]);
}

function ownerPathExists(owner) {
  return inlineCodeValues(owner).some((value) => {
    const [path] = value.split('::');
    if (!path || path.startsWith('npm ') || path.startsWith('node ') || path.startsWith('cargo ')) {
      return false;
    }
    return existsSync(join(REPO_ROOT, path));
  });
}

test('coverage matrix exists', () => {
  assert.equal(existsSync(MATRIX_PATH), true, 'qa/coverage-matrix.md must exist');
});

test('interaction inventory exists for issue #157 coverage ownership', () => {
  assert.equal(existsSync(INTERACTION_INVENTORY_PATH), true, 'qa/interaction-inventory.md must exist');
});

test('coverage matrix tracks every active scenario from qa/scenarios/INDEX.md', () => {
  const documented = new Set(matrixScenarioRows().map((row) => row.id));
  const missing = activeScenarioIds().filter((id) => !documented.has(id));
  assert.deepEqual(missing, []);
});

test('automated scenario owners point at real files and include a command', () => {
  const badRows = matrixScenarioRows()
    .filter((row) => row.status === 'Automated')
    .filter((row) => !ownerPathExists(row.owner) || inlineCodeValues(row.command).length === 0)
    .map((row) => row.id);
  assert.deepEqual(badRows, []);
});

test('automated major flow owners point at real files', () => {
  const badRows = matrixMajorRows()
    .filter((row) => row.status === 'Automated')
    .filter((row) => !ownerPathExists(row.owner))
    .map((row) => row.id);
  assert.deepEqual(badRows, []);
});

test('coverage matrix accounts for every historical user-reported bug', () => {
  const documented = new Set(matrixHistoricalRows().map((row) => row.id));
  const missing = historicalBugIds().filter((id) => !documented.has(id));
  assert.deepEqual(missing, []);
});

test('major flow and historical bug rows use final release-regression statuses', () => {
  const allowed = new Set(['Automated', 'Manual', 'Out of scope']);
  const invalid = [...matrixMajorRows(), ...matrixHistoricalRows()]
    .filter((row) => !allowed.has(row.status))
    .map((row) => `${row.id}: ${row.status}`);
  assert.deepEqual(invalid, []);
});

test('routine release-regression rows do not leave planned gaps', () => {
  const planned = [...matrixMajorRows(), ...matrixHistoricalRows()]
    .filter((row) => row.status === 'Planned')
    .map((row) => row.id);
  assert.deepEqual(planned, []);
});

test('interaction inventory covers the required issue #157 surface classes', () => {
  const inputs = readGateInputs(REPO_ROOT);
  const result = validateGate(inputs);
  assert.deepEqual(result.missingRequiredTags, []);
});

test('interaction inventory rows have final owner status and actionable evidence', () => {
  const inputs = readGateInputs(REPO_ROOT);
  const result = validateGate(inputs);
  assert.deepEqual(result.unownedInteractions, []);
  assert.deepEqual(result.automatedInteractionsWithoutExistingOwner, []);
  assert.deepEqual(result.manualInteractionsWithoutReason, []);
  assert.deepEqual(result.manualInteractionsWithoutReviewDate, []);
});

test('matrix report prints inventory completeness counts for CI logs', () => {
  const inputs = readGateInputs(REPO_ROOT);
  const result = validateGate(inputs);
  const report = formatGateReport(result);
  assert.match(report, /QA coverage matrix:/);
  assert.match(report, /Interaction inventory:/);
  assert.match(report, /unowned=0/);
});

test('package, CI, and release gates run qa:matrix before merge or release', () => {
  const pkg = JSON.parse(read(PACKAGE_PATH));
  assert.match(pkg.scripts['qa:matrix'], /qa-coverage-matrix\.mjs/);

  const ci = read(CI_PATH);
  assert.match(ci, /qa-matrix:/, 'CI needs a dedicated qa-matrix job');
  assert.match(ci, /npm run qa:matrix/, 'CI qa-matrix job must print the inventory report');
  assert.match(ci, /needs: \[changes, qa-matrix, compile/, 'CI Gate must depend on qa-matrix');

  const release = read(RELEASE_PATH);
  assert.match(release, /npm run --silent qa:matrix/, 'release preflight must run qa:matrix');
});
