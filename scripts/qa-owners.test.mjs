import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectOwnerRows,
  formatOwnerReport,
  parseOwnerReference,
  targetExistsInFile,
  validateOwnerReferences,
} from './qa-owners.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const PACKAGE_PATH = join(REPO_ROOT, 'package.json');

function tempRepo() {
  const root = mkdtempSync(join(tmpdir(), 'sts2-qa-owners-'));
  mkdirSync(join(root, 'qa'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'src-tauri', 'src'), { recursive: true });
  return root;
}

function write(path, body) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
}

function cleanup(path) {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}

function matrixWithOwner(owner, status = 'Automated') {
  return `# QA Coverage Matrix

## Scenario Owners

| Scenario | Flow | Tier | Scope | Automated owner | Release command | Status | Notes |
|---|---|---:|---|---|---|---|---|
| 999 | Fixture | 1 | Test row | ${owner} | \`npm run qa:coverage\` | ${status} | Fixture. |
`;
}

function inventoryWithOwner(owner, status = 'Automated') {
  return `# Interaction Inventory

## Interaction Inventory

| ID | Surface | Interaction | Tags | Automated owner | Release command | Status | Assertions trusted | Manual reason | Review date |
|---|---|---|---|---|---|---|---|---|---|
| I999 | Fixture | Fixture interaction | global-shell | ${owner} | \`npm run qa:coverage\` | ${status} | Fixture. |  |  |
`;
}

test('parseOwnerReference accepts files and named refs while ignoring shell commands', () => {
  assert.deepEqual(parseOwnerReference('src/App.test.tsx::shows the app'), {
    raw: 'src/App.test.tsx::shows the app',
    relativePath: 'src/App.test.tsx',
    target: 'shows the app',
  });
  assert.deepEqual(parseOwnerReference('src-tauri/src/mod.rs'), {
    raw: 'src-tauri/src/mod.rs',
    relativePath: 'src-tauri/src/mod.rs',
    target: null,
  });
  assert.equal(parseOwnerReference('npm run qa:coverage'), null);
  assert.equal(parseOwnerReference('cargo test --manifest-path=src-tauri/Cargo.toml smoke'), null);
});

test('collectOwnerRows reads matrix and interaction owner cells', () => {
  const rows = collectOwnerRows({
    matrixText: matrixWithOwner('`src/App.test.tsx`'),
    inventoryText: inventoryWithOwner('`src/views/Mods.test.tsx`'),
  });

  assert.deepEqual(rows.map((row) => row.id), ['999', 'I999']);
});

test('targetExistsInFile accepts Vitest title substrings, JS symbols, JS title strings, and Rust symbols', () => {
  assert.equal(
    targetExistsInFile("it('dialog saves value on click', () => {});", 'src/Dialog.test.tsx', 'saves value'),
    true,
  );
  assert.equal(
    targetExistsInFile('async function specRepairWalkback(driver) {}', 'qa/runner/smoke.mjs', 'specRepairWalkback'),
    true,
  );
  assert.equal(
    targetExistsInFile("['repair walk-back installs older compatible tag', specRepairWalkback]", 'qa/runner/smoke.mjs', 'repair walk-back installs older compatible tag'),
    true,
  );
  assert.equal(
    targetExistsInFile('#[cfg(test)] mod tests { #[test] fn keeps_identity() {} }', 'src-tauri/src/foo.rs', 'tests::keeps_identity'),
    true,
  );
  assert.equal(
    targetExistsInFile('#[cfg(test)] mod tests { #[test] fn keeps_identity() {} }', 'src-tauri/src/foo.rs', 'tests::missing_identity'),
    false,
  );
});

test('validateOwnerReferences reports row ids for missing files and missing test names', () => {
  const root = tempRepo();
  try {
    write(join(root, 'src', 'Existing.test.tsx'), "it('existing test title', () => {});");

    const result = validateOwnerReferences({
      repoRoot: root,
      matrixText: matrixWithOwner('`src/Missing.test.tsx::missing test`'),
      inventoryText: inventoryWithOwner('`src/Existing.test.tsx::not the title`'),
    });

    assert.deepEqual(result.errors.map((error) => `${error.rowId}:${error.kind}`), [
      '999:missing-file',
      'I999:missing-target',
    ]);
    assert.match(result.errors[0].message, /999 references missing file/);
    assert.match(result.errors[1].message, /I999 references missing test\/function/);
  } finally {
    cleanup(root);
  }
});

test('validateOwnerReferences does not treat command owner rows as file references', () => {
  const result = validateOwnerReferences({
    repoRoot: tempRepo(),
    matrixText: matrixWithOwner('`npm run qa:coverage`'),
    inventoryText: '',
  });

  assert.deepEqual(result.errors.map((error) => error.kind), ['missing-owner-reference']);
});

test('validateOwnerReferences rejects traversal and absolute owner paths before reading files', () => {
  const result = validateOwnerReferences({
    repoRoot: tempRepo(),
    matrixText: matrixWithOwner('`../outside.test.ts::sneaky`; `/tmp/absolute.test.ts`; `C:/tmp/absolute.test.ts`'),
    inventoryText: '',
  });

  assert.deepEqual(result.errors.map((error) => error.kind), [
    'invalid-path',
    'invalid-path',
    'invalid-path',
  ]);
  assert.match(formatOwnerReport(result), /invalid_paths=3/);
});

test('formatOwnerReport summarizes failures for CI logs', () => {
  const result = validateOwnerReferences({
    repoRoot: tempRepo(),
    matrixText: matrixWithOwner('`src/Missing.test.tsx::missing test`'),
    inventoryText: '',
  });

  assert.match(formatOwnerReport(result), /QA owner references:/);
  assert.match(formatOwnerReport(result), /missing_files=1/);
});

test('package qa:matrix runs the stricter owner gate', () => {
  const pkg = JSON.parse(readFileSync(PACKAGE_PATH, 'utf8'));
  assert.match(pkg.scripts['qa:owners'], /qa-owners\.mjs/);
  assert.match(pkg.scripts['qa:matrix'], /qa:owners|qa-owners\.mjs/);
});
