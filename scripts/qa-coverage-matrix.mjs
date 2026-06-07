// Validate and report the QA release-confidence inventory.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_REPO_ROOT = join(__dirname, '..');

export const MATRIX_PATH = join(DEFAULT_REPO_ROOT, 'qa', 'coverage-matrix.md');
export const INTERACTION_INVENTORY_PATH = join(DEFAULT_REPO_ROOT, 'qa', 'interaction-inventory.md');
export const REQUIRED_INTERACTION_TAGS = [
  'global-shell',
  'menu',
  'dialog',
  'profile-flow',
  'mod-library',
  'settings',
  'error-state',
  'empty-state',
  'large-list',
];

function pathFor(repoRoot, relativePath) {
  return join(repoRoot, ...relativePath.split('/'));
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
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

function inlineCodeValues(text) {
  return Array.from(String(text ?? '').matchAll(/`([^`]+)`/g), (match) => match[1]);
}

function ownerPathExists(repoRoot, owner) {
  return inlineCodeValues(owner).some((value) => {
    const [rawPath] = value.split('::');
    if (!rawPath || rawPath.startsWith('npm ') || rawPath.startsWith('node ') || rawPath.startsWith('cargo ')) {
      return false;
    }
    return existsSync(pathFor(repoRoot, rawPath));
  });
}

function matrixRows(matrixText, heading, idPattern) {
  return tableRows(section(matrixText, heading))
    .filter((cells) => idPattern.test(cells[0] ?? ''))
    .map((cells) => ({
      id: cells[0],
      owner: cells[4] ?? cells[2] ?? '',
      command: cells[5] ?? '',
      status: cells[6] ?? cells[3] ?? '',
    }));
}

export function parseInteractionInventory(inventoryText) {
  return tableRows(section(inventoryText, 'Interaction Inventory'))
    .filter((cells) => /^I\d{3}$|^M\d{3}$/.test(cells[0] ?? ''))
    .map((cells) => ({
      id: cells[0],
      surface: cells[1] ?? '',
      interaction: cells[2] ?? '',
      tags: (cells[3] ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      owner: cells[4] ?? '',
      command: cells[5] ?? '',
      status: cells[6] ?? '',
      assertions: cells[7] ?? '',
      manualReason: cells[8] ?? '',
      reviewDate: cells[9] ?? '',
    }));
}

export function readGateInputs(repoRoot = DEFAULT_REPO_ROOT) {
  return {
    repoRoot,
    matrixText: readIfExists(pathFor(repoRoot, 'qa/coverage-matrix.md')),
    inventoryText: readIfExists(pathFor(repoRoot, 'qa/interaction-inventory.md')),
  };
}

export function validateGate(inputs) {
  const repoRoot = inputs.repoRoot ?? DEFAULT_REPO_ROOT;
  const scenarioRows = matrixRows(inputs.matrixText, 'Scenario Owners', /^\d{3}$/);
  const majorRows = matrixRows(inputs.matrixText, 'Major Flow Owners', /^(?:\d+|A\d+)$/);
  const historicalRows = matrixRows(inputs.matrixText, 'Historical Bug Owners', /^#\d+$/);
  const interactions = parseInteractionInventory(inputs.inventoryText);
  const interactionTags = new Set(interactions.flatMap((row) => row.tags));
  const allowedStatuses = new Set(['Automated', 'Manual']);

  const unownedInteractions = interactions
    .filter((row) => !allowedStatuses.has(row.status) || !row.owner || !row.command)
    .map((row) => `${row.id}: ${row.status || 'missing status'}`);

  const automatedInteractionsWithoutExistingOwner = interactions
    .filter((row) => row.status === 'Automated')
    .filter((row) => !ownerPathExists(repoRoot, row.owner) || inlineCodeValues(row.command).length === 0)
    .map((row) => row.id);

  const manualInteractionsWithoutReason = interactions
    .filter((row) => row.status === 'Manual')
    .filter((row) => !row.manualReason || /^[-–—]$/.test(row.manualReason))
    .map((row) => row.id);

  const manualInteractionsWithoutReviewDate = interactions
    .filter((row) => row.status === 'Manual')
    .filter((row) => !/^\d{4}-\d{2}-\d{2}$/.test(row.reviewDate))
    .map((row) => row.id);

  const matrixRowsAll = [...scenarioRows, ...majorRows, ...historicalRows];
  const plannedMatrixRows = matrixRowsAll
    .filter((row) => row.status === 'Planned')
    .map((row) => row.id);

  return {
    scenarioRows,
    majorRows,
    historicalRows,
    interactions,
    automatedInteractions: interactions.filter((row) => row.status === 'Automated'),
    manualInteractions: interactions.filter((row) => row.status === 'Manual'),
    missingRequiredTags: REQUIRED_INTERACTION_TAGS.filter((tag) => !interactionTags.has(tag)),
    unownedInteractions,
    automatedInteractionsWithoutExistingOwner,
    manualInteractionsWithoutReason,
    manualInteractionsWithoutReviewDate,
    plannedMatrixRows,
  };
}

export function formatGateReport(result) {
  const automated = result.automatedInteractions.length;
  const manual = result.manualInteractions.length;
  const unowned = result.unownedInteractions.length;
  return [
    `QA coverage matrix: scenarios=${result.scenarioRows.length}, major_flows=${result.majorRows.length}, historical_bugs=${result.historicalRows.length}, planned=${result.plannedMatrixRows.length}`,
    `Interaction inventory: automated=${automated}, manual=${manual}, unowned=${unowned}, required_tags_missing=${result.missingRequiredTags.length}`,
  ].join('\n');
}

function errorsFor(result) {
  const errors = [];
  if (result.plannedMatrixRows.length) {
    errors.push(`planned matrix rows: ${result.plannedMatrixRows.join(', ')}`);
  }
  if (result.missingRequiredTags.length) {
    errors.push(`missing interaction tags: ${result.missingRequiredTags.join(', ')}`);
  }
  if (result.unownedInteractions.length) {
    errors.push(`unowned interactions: ${result.unownedInteractions.join(', ')}`);
  }
  if (result.automatedInteractionsWithoutExistingOwner.length) {
    errors.push(`automated interactions without an existing owner path: ${result.automatedInteractionsWithoutExistingOwner.join(', ')}`);
  }
  if (result.manualInteractionsWithoutReason.length) {
    errors.push(`manual interactions without reasons: ${result.manualInteractionsWithoutReason.join(', ')}`);
  }
  if (result.manualInteractionsWithoutReviewDate.length) {
    errors.push(`manual interactions without review dates: ${result.manualInteractionsWithoutReviewDate.join(', ')}`);
  }
  return errors;
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const result = validateGate(readGateInputs(DEFAULT_REPO_ROOT));
  console.log(formatGateReport(result));
  const errors = errorsFor(result);
  if (errors.length) {
    for (const error of errors) {
      console.error(`::error::${error}`);
    }
    process.exit(1);
  }
}
