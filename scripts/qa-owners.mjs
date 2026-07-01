// Validate that QA matrix owner references point at real files and named tests.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = join(__dirname, '..');

const MATRIX_RELATIVE_PATH = 'qa/coverage-matrix.md';
const INVENTORY_RELATIVE_PATH = 'qa/interaction-inventory.md';

function normalizedRepoRelativePath(relativePath) {
  const normalizedPath = String(relativePath ?? '').trim().replace(/\\/g, '/');
  if (
    !normalizedPath
    || normalizedPath.startsWith('/')
    || /^[A-Za-z]:/.test(normalizedPath)
    || normalizedPath.includes('\0')
  ) {
    return null;
  }

  const parts = normalizedPath.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) return null;
  return normalizedPath;
}

function pathFor(repoRoot, relativePath) {
  const normalizedPath = normalizedRepoRelativePath(relativePath);
  if (!normalizedPath) {
    throw new Error(`invalid repo-relative owner path: ${relativePath}`);
  }
  return join(repoRoot, ...normalizedPath.split('/'));
}

function readIfExists(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function section(text, heading) {
  const escaped = escapeRegExp(heading);
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
  return Array.from(String(text ?? '').matchAll(/`([^`]+)`/g), (match) => match[1].trim()).filter(Boolean);
}

function looksLikePath(value) {
  return /[/.]/.test(value) && !/\s/.test(value);
}

function isShellCommand(value) {
  return /^(?:npm|npx|node|cargo|cross-env|bash|sh|git|vitest)\b/.test(value.trim());
}

export function parseOwnerReference(value) {
  const raw = String(value ?? '').trim();
  if (!raw || isShellCommand(raw)) return null;

  const [rawPath, ...targetParts] = raw.split('::');
  const relativePath = rawPath.trim();
  if (!looksLikePath(relativePath)) return null;

  return {
    raw,
    relativePath,
    target: targetParts.join('::').trim() || null,
  };
}

function ownerRowsFromMatrix(matrixText) {
  const scenarioRows = tableRows(section(matrixText, 'Scenario Owners'))
    .filter((cells) => /^\d{3}$/.test(cells[0] ?? ''))
    .map((cells) => ({
      source: MATRIX_RELATIVE_PATH,
      section: 'Scenario Owners',
      id: cells[0],
      owner: cells[4] ?? '',
      status: cells[6] ?? '',
    }));

  const majorRows = tableRows(section(matrixText, 'Major Flow Owners'))
    .filter((cells) => /^(?:\d+|A\d+)$/.test(cells[0] ?? ''))
    .map((cells) => ({
      source: MATRIX_RELATIVE_PATH,
      section: 'Major Flow Owners',
      id: cells[0],
      owner: cells[2] ?? '',
      status: cells[3] ?? '',
    }));

  const historicalRows = tableRows(section(matrixText, 'Historical Bug Owners'))
    .filter((cells) => /^#\d+(?:\/#\d+)?$/.test(cells[0] ?? ''))
    .map((cells) => ({
      source: MATRIX_RELATIVE_PATH,
      section: 'Historical Bug Owners',
      id: cells[0],
      owner: cells[4] ?? '',
      status: cells[6] ?? '',
    }));

  return [...scenarioRows, ...majorRows, ...historicalRows];
}

function ownerRowsFromInventory(inventoryText) {
  return tableRows(section(inventoryText, 'Interaction Inventory'))
    .filter((cells) => /^I\d{3}$|^M\d{3}$/.test(cells[0] ?? ''))
    .map((cells) => ({
      source: INVENTORY_RELATIVE_PATH,
      section: 'Interaction Inventory',
      id: cells[0],
      owner: cells[4] ?? '',
      status: cells[6] ?? '',
    }));
}

export function collectOwnerRows({ matrixText = '', inventoryText = '' }) {
  return [...ownerRowsFromMatrix(matrixText), ...ownerRowsFromInventory(inventoryText)];
}

function normalized(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function finalTargetSegment(target) {
  return target.split('::').map((part) => part.trim()).filter(Boolean).at(-1) ?? target.trim();
}

function extractCallTitles(text) {
  const titles = [];
  const titlePattern = /\b(?:test|it)(?:\.\w+)?\s*\(\s*(['"`])([\s\S]*?)\1/g;
  for (const match of text.matchAll(titlePattern)) {
    titles.push(match[2].replace(/\\(['"`])/g, '$1'));
  }
  return titles;
}

function extractStringLiterals(text) {
  const strings = [];
  const stringPattern = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  for (const match of text.matchAll(stringPattern)) {
    strings.push(match[2].replace(/\\(['"`])/g, '$1'));
  }
  return strings;
}

function hasQuotedLiteral(text, target) {
  return [`'${target}'`, `"${target}"`, `\`${target}\``].some((quoted) => text.includes(quoted));
}

function hasSymbol(text, symbol) {
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) return false;
  return new RegExp(`\\b(?:async\\s+)?(?:function|fn|mod|const|let|var|class)\\s+${escapeRegExp(symbol)}\\b`).test(text);
}

function hasRustTarget(text, target) {
  const symbol = finalTargetSegment(target);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(symbol)) return false;
  return new RegExp(`\\b(?:fn|mod)\\s+${escapeRegExp(symbol)}\\b`).test(text);
}

export function targetExistsInFile(fileText, relativePath, target) {
  if (!target) return true;

  if (relativePath.endsWith('.rs')) {
    return hasRustTarget(fileText, target);
  }

  const targetText = normalized(target);
  const symbol = finalTargetSegment(target);
  if (hasSymbol(fileText, symbol)) return true;
  if (hasQuotedLiteral(fileText, target)) return true;

  return extractCallTitles(fileText).some((title) => normalized(title).includes(targetText))
    || extractStringLiterals(fileText).some((literal) => normalized(literal).includes(targetText));
}

export function readOwnerInputs(repoRoot = DEFAULT_REPO_ROOT) {
  return {
    repoRoot,
    matrixText: readIfExists(pathFor(repoRoot, MATRIX_RELATIVE_PATH)),
    inventoryText: readIfExists(pathFor(repoRoot, INVENTORY_RELATIVE_PATH)),
  };
}

export function validateOwnerReferences(inputs) {
  const repoRoot = inputs.repoRoot ?? DEFAULT_REPO_ROOT;
  const rows = collectOwnerRows(inputs);
  const references = [];
  const errors = [];

  for (const row of rows) {
    const refs = inlineCodeValues(row.owner)
      .map((value) => parseOwnerReference(value))
      .filter(Boolean);

    if (row.status === 'Automated' && refs.length === 0) {
      errors.push({
        kind: 'missing-owner-reference',
        source: row.source,
        section: row.section,
        rowId: row.id,
        message: `${row.id} has no file owner reference in its Automated owner cell`,
      });
    }

    for (const ref of refs) {
      const reference = { ...ref, rowId: row.id, source: row.source, section: row.section };
      references.push(reference);

      let absolutePath;
      try {
        absolutePath = pathFor(repoRoot, ref.relativePath);
      } catch {
        errors.push({
          kind: 'invalid-path',
          source: row.source,
          section: row.section,
          rowId: row.id,
          reference: ref.raw,
          message: `${row.id} references invalid repo-relative path ${ref.relativePath}`,
        });
        continue;
      }

      if (!existsSync(absolutePath)) {
        errors.push({
          kind: 'missing-file',
          source: row.source,
          section: row.section,
          rowId: row.id,
          reference: ref.raw,
          message: `${row.id} references missing file ${ref.relativePath}`,
        });
        continue;
      }

      if (ref.target) {
        const fileText = readFileSync(absolutePath, 'utf8');
        if (!targetExistsInFile(fileText, ref.relativePath, ref.target)) {
          errors.push({
            kind: 'missing-target',
            source: row.source,
            section: row.section,
            rowId: row.id,
            reference: ref.raw,
            message: `${row.id} references missing test/function "${ref.target}" in ${ref.relativePath}`,
          });
        }
      }
    }
  }

  return {
    rows,
    references,
    errors,
    missingFiles: errors.filter((error) => error.kind === 'missing-file'),
    missingTargets: errors.filter((error) => error.kind === 'missing-target'),
    invalidPaths: errors.filter((error) => error.kind === 'invalid-path'),
    missingOwnerReferences: errors.filter((error) => error.kind === 'missing-owner-reference'),
  };
}

export function formatOwnerReport(result) {
  return [
    `QA owner references: rows=${result.rows.length}, references=${result.references.length}, errors=${result.errors.length}`,
    `Owner reference failures: invalid_paths=${result.invalidPaths.length}, missing_files=${result.missingFiles.length}, missing_targets=${result.missingTargets.length}, automated_rows_without_file_refs=${result.missingOwnerReferences.length}`,
  ].join('\n');
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const result = validateOwnerReferences(readOwnerInputs(DEFAULT_REPO_ROOT));
  console.log(formatOwnerReport(result));
  if (result.errors.length) {
    for (const error of result.errors) {
      console.error(`::error::${error.source} ${error.section} ${error.message}`);
    }
    process.exit(1);
  }
}
