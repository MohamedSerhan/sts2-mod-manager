import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseLatestReleasedEntry, sectionBodyFor, run, LOCALES } from './translate-changelog.mjs';

const SAMPLE = `# Changelog

## [Unreleased]

### Added
- WIP, not released.

## [1.7.1] - 2026-06-03

### Added
- A player-facing thing.

## [1.7.0] - 2026-06-02

### Fixed
- Older fix.
`;

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'tc-test-'));
  mkdirSync(join(dir, 'src', 'i18n', 'changelog'), { recursive: true });
  writeFileSync(join(dir, 'CHANGELOG.md'), SAMPLE, 'utf8');
  for (const { key } of LOCALES) {
    writeFileSync(join(dir, 'src', 'i18n', 'changelog', `${key}.json`), '{}\n', 'utf8');
  }
  return dir;
}

const silent = { warn() {}, log() {}, error() {} };

test('parseLatestReleasedEntry picks the newest non-Unreleased entry', () => {
  const e = parseLatestReleasedEntry(SAMPLE);
  assert.equal(e.version, '1.7.1');
  assert.match(e.body, /A player-facing thing/);
  assert.doesNotMatch(e.body, /WIP, not released/);
});

test('sectionBodyFor returns a specific version body', () => {
  assert.match(sectionBodyFor(SAMPLE, '1.7.0'), /Older fix/);
});

test('run writes a translated body for every locale and merges, not overwrites', async () => {
  const dir = makeRepo();
  // Pre-seed an older version to prove it survives the merge.
  writeFileSync(join(dir, 'src/i18n/changelog/ru.json'), JSON.stringify({ '1.7.0': 'старое' }) + '\n');
  const translateFn = async (body, name) => `[${name}] ${body}`;
  const res = await run({ translateFn, rootDir: dir, log: silent });
  assert.equal(res.version, '1.7.1');
  assert.deepEqual(res.written.sort(), ['ar', 'ru', 'zh-Hans']);
  const ru = JSON.parse(readFileSync(join(dir, 'src/i18n/changelog/ru.json'), 'utf8'));
  assert.match(ru['1.7.1'], /\[Russian\] /);
  assert.equal(ru['1.7.0'], 'старое'); // merge preserved the old version
});

test('run is idempotent — skips a version already present unless force', async () => {
  const dir = makeRepo();
  const translateFn = async (body, name) => `[${name}] ${body}`;
  await run({ translateFn, rootDir: dir, log: silent });
  const second = await run({ translateFn, rootDir: dir, log: silent });
  assert.deepEqual(second.skipped.sort(), ['ar', 'ru', 'zh-Hans']);
  assert.deepEqual(second.written, []);
  const forced = await run({ translateFn, rootDir: dir, force: true, log: silent });
  assert.deepEqual(forced.written.sort(), ['ar', 'ru', 'zh-Hans']);
});

test('run is non-blocking when ANTHROPIC_API_KEY is absent (default translator)', async () => {
  const dir = makeRepo();
  const prev = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const res = await run({ rootDir: dir, log: silent }); // default real translator
    assert.deepEqual(res, { version: null, written: [], skipped: [] });
    // No file was modified.
    assert.equal(readFileSync(join(dir, 'src/i18n/changelog/ru.json'), 'utf8').trim(), '{}');
  } finally {
    if (prev !== undefined) process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('run continues past a single locale failure', async () => {
  const dir = makeRepo();
  const translateFn = async (body, name) => {
    if (name === 'Arabic') throw new Error('boom');
    return `[${name}] ${body}`;
  };
  const res = await run({ translateFn, rootDir: dir, log: silent });
  assert.deepEqual(res.written.sort(), ['ru', 'zh-Hans']);
  assert.equal(existsSync(join(dir, 'src/i18n/changelog/ar.json')), true);
  const ar = JSON.parse(readFileSync(join(dir, 'src/i18n/changelog/ar.json'), 'utf8'));
  assert.equal(ar['1.7.1'], undefined); // failed locale left without the new version
});
