import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyPaths, unreleasedBulletCount, suggestedBump } from './ci-changes.mjs';

test('classifyPaths buckets app/scripts/workflows', () => {
  assert.deepEqual(classifyPaths(['src/App.tsx']), { app: true, scripts: false, workflows: false, qa: false });
  assert.deepEqual(classifyPaths(['src-tauri/src/lib.rs']), { app: true, scripts: false, workflows: false, qa: false });
  assert.deepEqual(classifyPaths(['src-tauri/Cargo.toml']), { app: true, scripts: false, workflows: false, qa: false });
  assert.deepEqual(classifyPaths(['package-lock.json']), { app: true, scripts: false, workflows: false, qa: false });
  assert.deepEqual(classifyPaths(['scripts/foo.mjs']), { app: false, scripts: true, workflows: false, qa: false });
  assert.deepEqual(classifyPaths(['.github/workflows/ci.yml']), { app: false, scripts: false, workflows: true, qa: false });
  assert.deepEqual(classifyPaths(['README.md', 'docs/x.md', '.claude/y']), { app: false, scripts: false, workflows: false, qa: false });
});

test('classifyPaths ignores src-tauri/target, handles mixed + empty/null', () => {
  assert.deepEqual(classifyPaths(['src-tauri/target/release/x']), { app: false, scripts: false, workflows: false, qa: false });
  assert.deepEqual(classifyPaths(['src/a.ts', 'scripts/b.mjs']), { app: true, scripts: true, workflows: false, qa: false });
  assert.deepEqual(classifyPaths([]), { app: false, scripts: false, workflows: false, qa: false });
  assert.deepEqual(classifyPaths(null), { app: false, scripts: false, workflows: false, qa: false });
  assert.deepEqual(classifyPaths([null, 42, 'src/a.ts']), { app: true, scripts: false, workflows: false, qa: false });
});

test('classifyPaths flags root build/test config + public as app, not qa/registry', () => {
  for (const p of ['index.html', 'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', 'vitest.config.ts', 'public/icon.png']) {
    assert.equal(classifyPaths([p]).app, true, `${p} should be app`);
  }
  for (const p of ['qa/runner/x.mjs', 'registry/registry.json', 'AGENTS.md', 'README.md']) {
    assert.equal(classifyPaths([p]).app, false, `${p} should NOT be app`);
  }
});

test('classifyPaths flags qa/ as the qa bucket (triggers smoke), not app/scripts', () => {
  const r = classifyPaths(['qa/runner/smoke.mjs']);
  assert.equal(r.qa, true, 'qa/ is the qa bucket');
  assert.equal(r.app, false, 'qa/ is not app');
  assert.equal(r.scripts, false, 'qa/ is not scripts (that is top-level scripts/)');
  assert.equal(classifyPaths(['scripts/x.mjs']).qa, false);
  assert.equal(classifyPaths(['src/a.ts']).qa, false);
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

test('suggestedBump: Added -> minor', () => {
  assert.equal(suggestedBump('## [Unreleased]\n### Added\n- A thing\n'), 'minor');
});
test('suggestedBump: only Fixed -> patch', () => {
  assert.equal(suggestedBump('## [Unreleased]\n### Fixed\n- A fix\n'), 'patch');
});
test('suggestedBump: Removed -> major', () => {
  assert.equal(suggestedBump('## [Unreleased]\n### Removed\n- Dropped X\n'), 'major');
});
test('suggestedBump: BREAKING marker -> major', () => {
  assert.equal(suggestedBump('## [Unreleased]\n### Changed\n- BREAKING: changed Y\n'), 'major');
});
test('suggestedBump: Added + Fixed -> minor', () => {
  assert.equal(suggestedBump('## [Unreleased]\n### Added\n- A\n### Fixed\n- B\n'), 'minor');
});
test('suggestedBump: Security only -> patch', () => {
  assert.equal(suggestedBump('## [Unreleased]\n### Security\n- Patched Z\n'), 'patch');
});
test('suggestedBump: empty/no bullets -> null', () => {
  assert.equal(suggestedBump('## [Unreleased]\n### Added\n'), null);
  assert.equal(suggestedBump(''), null);
});
