import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPaths, unreleasedBulletCount } from './ci-changes.mjs';

test('classifyPaths buckets app/scripts/workflows', () => {
  assert.deepEqual(classifyPaths(['src/App.tsx']), { app: true, scripts: false, workflows: false });
  assert.deepEqual(classifyPaths(['src-tauri/src/lib.rs']), { app: true, scripts: false, workflows: false });
  assert.deepEqual(classifyPaths(['src-tauri/Cargo.toml']), { app: true, scripts: false, workflows: false });
  assert.deepEqual(classifyPaths(['package-lock.json']), { app: true, scripts: false, workflows: false });
  assert.deepEqual(classifyPaths(['scripts/foo.mjs']), { app: false, scripts: true, workflows: false });
  assert.deepEqual(classifyPaths(['.github/workflows/ci.yml']), { app: false, scripts: false, workflows: true });
  assert.deepEqual(classifyPaths(['README.md', 'docs/x.md', '.claude/y']), { app: false, scripts: false, workflows: false });
});

test('classifyPaths ignores src-tauri/target, handles mixed + empty/null', () => {
  assert.deepEqual(classifyPaths(['src-tauri/target/release/x']), { app: false, scripts: false, workflows: false });
  assert.deepEqual(classifyPaths(['src/a.ts', 'scripts/b.mjs']), { app: true, scripts: true, workflows: false });
  assert.deepEqual(classifyPaths([]), { app: false, scripts: false, workflows: false });
  assert.deepEqual(classifyPaths(null), { app: false, scripts: false, workflows: false });
  assert.deepEqual(classifyPaths([null, 42, 'src/a.ts']), { app: true, scripts: false, workflows: false });
});

test('classifyPaths flags root build/test config + public as app, not qa/registry', () => {
  for (const p of ['index.html', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts', 'public/icon.png']) {
    assert.equal(classifyPaths([p]).app, true, `${p} should be app`);
  }
  for (const p of ['qa/runner/x.mjs', 'registry/registry.json', 'AGENTS.md', 'README.md']) {
    assert.equal(classifyPaths([p]).app, false, `${p} should NOT be app`);
  }
});

test('unreleasedBulletCount counts bullets under [Unreleased] only', () => {
  const cl = `# Changelog

## [Unreleased]
### Added
- A new thing
- Another thing
### Fixed
- A fix

## [1.2.0] - 2026-01-01
### Added
- Old thing
`;
  assert.equal(unreleasedBulletCount(cl), 3);
});

test('unreleasedBulletCount = 0 for empty/no-section/no-bullets', () => {
  assert.equal(unreleasedBulletCount(''), 0);
  assert.equal(unreleasedBulletCount('# Changelog\n## [1.0.0]\n- x\n'), 0);
  assert.equal(unreleasedBulletCount('## [Unreleased]\n### Added\n'), 0);
});

test('unreleasedBulletCount handles * bullets and CRLF', () => {
  assert.equal(unreleasedBulletCount('## [Unreleased]\n* A thing\n'), 1);
  assert.equal(unreleasedBulletCount('## [Unreleased]\r\n- thing\r\n'), 1);
});
