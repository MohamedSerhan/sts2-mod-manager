// scripts/nexus-triage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAINTAINER_HANDLES,
  MOD_ID,
  STATE_SCHEMA_VERSION,
} from './nexus-triage.mjs';

test('module constants are exported and have expected values', () => {
  assert.equal(MOD_ID, 856);
  assert.equal(STATE_SCHEMA_VERSION, 1);
  assert.deepEqual(MAINTAINER_HANDLES, ['xxskullmikexx', 'Sky2Fly']);
});

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadState,
  saveState,
} from './nexus-triage.mjs';

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'nexus-triage-test-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadState: missing file exits 2 with bootstrap message', (t) => {
  withTempDir((dir) => {
    const path = join(dir, 'missing.json');
    const exitCalls = [];
    const consoleErr = [];
    t.mock.method(process, 'exit', (code) => { exitCalls.push(code); throw new Error('exit'); });
    t.mock.method(console, 'error', (msg) => { consoleErr.push(msg); });

    assert.throws(() => loadState(path), /exit/);
    assert.deepEqual(exitCalls, [2]);
    assert.ok(consoleErr.some((m) => /bootstrap/i.test(String(m))),
              'error message should mention bootstrap procedure');
  });
});

test('loadState: malformed JSON exits 2 with file path', (t) => {
  withTempDir((dir) => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ not valid json', 'utf-8');
    const exitCalls = [];
    const consoleErr = [];
    t.mock.method(process, 'exit', (code) => { exitCalls.push(code); throw new Error('exit'); });
    t.mock.method(console, 'error', (msg) => { consoleErr.push(String(msg)); });

    assert.throws(() => loadState(path), /exit/);
    assert.deepEqual(exitCalls, [2]);
    assert.ok(consoleErr.some((m) => m.includes(path)),
              `error should mention path '${path}' but got: ${consoleErr.join(' | ')}`);
  });
});

test('loadState: schema_version mismatch exits 2', (t) => {
  withTempDir((dir) => {
    const path = join(dir, 'old.json');
    writeFileSync(path, JSON.stringify({ schema_version: 99, comments: {}, bugs: {}, kudos_seen: [] }), 'utf-8');
    const exitCalls = [];
    t.mock.method(process, 'exit', (code) => { exitCalls.push(code); throw new Error('exit'); });
    t.mock.method(console, 'error', () => {});

    assert.throws(() => loadState(path), /exit/);
    assert.deepEqual(exitCalls, [2]);
  });
});

test('saveState then loadState round-trips a populated state', () => {
  withTempDir((dir) => {
    const path = join(dir, 'state.json');
    const original = {
      schema_version: STATE_SCHEMA_VERSION,
      last_run_at: '2026-05-26T14:00:00.000Z',
      comments: { '12345': { gh_issue_url: 'https://github.com/x/y/issues/1', classification: 'bug', filed_at: '2026-05-26T14:00:00.000Z' } },
      bugs: { '67': { gh_issue_url: 'https://github.com/x/y/issues/2', classification: 'bug', filed_at: '2026-05-26T14:00:00.000Z' } },
      kudos_seen: ['11111', '11112'],
    };
    saveState(path, original);
    const loaded = loadState(path);
    assert.deepEqual(loaded, original);
  });
});

test('saveState handles 50 comments + 30 bugs + 100 kudos', () => {
  withTempDir((dir) => {
    const path = join(dir, 'big-state.json');
    const big = {
      schema_version: STATE_SCHEMA_VERSION,
      last_run_at: '2026-05-26T14:00:00.000Z',
      comments: Object.fromEntries(Array.from({ length: 50 }, (_, i) =>
        [String(1000 + i), { gh_issue_url: `https://github.com/x/y/issues/${i}`, classification: 'bug', filed_at: '2026-05-26T14:00:00.000Z' }])),
      bugs: Object.fromEntries(Array.from({ length: 30 }, (_, i) =>
        [String(2000 + i), { gh_issue_url: `https://github.com/x/y/issues/${50 + i}`, classification: 'bug', filed_at: '2026-05-26T14:00:00.000Z' }])),
      kudos_seen: Array.from({ length: 100 }, (_, i) => String(3000 + i)),
    };
    saveState(path, big);
    const loaded = loadState(path);
    assert.equal(Object.keys(loaded.comments).length, 50);
    assert.equal(Object.keys(loaded.bugs).length, 30);
    assert.equal(loaded.kudos_seen.length, 100);
  });
});

import { sanitizeTitle } from './nexus-triage.mjs';

test('sanitizeTitle strips backticks', () => {
  assert.equal(sanitizeTitle('use `foo` not `bar`'), 'use foo not bar');
});

test('sanitizeTitle strips HTML tags but keeps content', () => {
  assert.equal(sanitizeTitle('<script>alert("x")</script>hello'), 'alert("x")hello');
  assert.equal(sanitizeTitle('<b>bold</b> text'), 'bold text');
});

test('sanitizeTitle strips @mentions', () => {
  assert.equal(sanitizeTitle('@everyone please check this'), 'please check this');
  assert.equal(sanitizeTitle('hey @MohamedSerhan and @ghost'), 'hey and');
});

test('sanitizeTitle collapses whitespace', () => {
  assert.equal(sanitizeTitle('a   b\n\nc\td'), 'a b c d');
});

test('sanitizeTitle truncates at word boundary at 60 chars', () => {
  const long = 'word '.repeat(30); // 150 chars
  const result = sanitizeTitle(long);
  assert.ok(result.length <= 60, `result length ${result.length} > 60: ${result}`);
  assert.ok(!result.endsWith(' '), `result ends with space: '${result}'`);
  assert.ok(/^(\w+(\s\w+)*)?$/.test(result), `result should be clean word boundary: '${result}'`);
});

test('sanitizeTitle of empty input returns empty string', () => {
  assert.equal(sanitizeTitle(''), '');
  assert.equal(sanitizeTitle('   '), '');
});

test('sanitizeTitle of all-punctuation returns input unchanged', () => {
  assert.equal(sanitizeTitle('!!!???...'), '!!!???...');  // punctuation preserved
  assert.equal(sanitizeTitle('@@@@'), '');  // all mentions stripped → empty
});

test('sanitizeTitle preserves non-ASCII content', () => {
  assert.equal(sanitizeTitle('崩溃 crash 启动'), '崩溃 crash 启动');
});
