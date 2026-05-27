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

import { classify } from './nexus-triage.mjs';

// bug_high
for (const phrase of [
  'app crashes on launch',
  'it crashed yesterday',
  'crashing every time I open it',
  'I got an error popup',
  'unhandled exception in profile import',
  'profile is broken',
  'launch fails immediately',
  "won't start at all",
  "won't launch from steam",
  "won't open the share modal",
  "won't install the deb",
]) {
  test(`classify: bug_high matches "${phrase}"`, () => {
    const r = classify(phrase, 'comment');
    assert.equal(r.classification, 'bug', `expected bug, got ${r.classification} for "${phrase}"`);
    assert.equal(r.confidence, 'high');
  });
}

// bug_med
for (const phrase of [
  'this looks like a bug',
  "the share button doesn't work",
  'profile switcher not working',
  'visual glitch on the home view',
]) {
  test(`classify: bug_med matches "${phrase}"`, () => {
    const r = classify(phrase, 'comment');
    assert.equal(r.classification, 'bug', `expected bug, got ${r.classification} for "${phrase}"`);
    assert.equal(r.confidence, 'medium');
  });
}

// feat_high
for (const phrase of [
  'this is a feature request',
  'would be nice to have dark mode',
  'please add a search box',
  'can you add a sort option',
  'suggestion: keyboard shortcuts',
]) {
  test(`classify: feat_high matches "${phrase}"`, () => {
    const r = classify(phrase, 'comment');
    assert.equal(r.classification, 'feature-request', `expected feature-request, got ${r.classification} for "${phrase}"`);
    assert.equal(r.confidence, 'high');
  });
}

// question
for (const phrase of [
  'how do I install this?',
  'where is the settings menu?',
  'can someone explain the share flow?',
  'is this compatible with vortex?',
  '这怎么用？',  // zh-Hans full-width
]) {
  test(`classify: question matches "${phrase}"`, () => {
    const r = classify(phrase, 'comment');
    assert.equal(r.classification, 'question', `expected question, got ${r.classification} for "${phrase}"`);
  });
}

// kudos boundary
test('classify: kudos matches positive short comment at 79 chars', () => {
  const body = 'thanks for this, great mod, works perfectly with my setup, love the polish!';
  assert.ok(body.length <= 80, `body length ${body.length} should be <= 80`);
  assert.equal(classify(body, 'comment').classification, 'kudos');
});

test('classify: kudos rejects positive comment at 81 chars', () => {
  const body = 'thanks for this great mod, it works really well with my setup, love the polish!!!';
  assert.ok(body.length > 80, `body length ${body.length} should be > 80`);
  assert.equal(classify(body, 'comment').classification, 'needs-triage');
});

test('classify: positive + bug keyword goes to bug (priority order)', () => {
  const body = 'thanks, but it crashed when I clicked share';
  assert.equal(classify(body, 'comment').classification, 'bug');
});

// non-English
test('classify: non-English non-keyword body defaults to needs-triage', () => {
  assert.equal(classify('这是一条测试评论', 'comment').classification, 'needs-triage');
});

// edge cases
test('classify: empty / whitespace / backticks → needs-triage', () => {
  assert.equal(classify('', 'comment').classification, 'needs-triage');
  assert.equal(classify('   ', 'comment').classification, 'needs-triage');
  assert.equal(classify('```', 'comment').classification, 'needs-triage');
});

import { renderIssueBody } from './nexus-triage.mjs';

// readFileSync is already imported above
const TEMPLATE = readFileSync('scripts/nexus-triage-prompt.md', 'utf-8');

const COMMENT_ITEM = {
  kind: 'comment',
  id: '12345',
  body: 'the share button does nothing on click',
  createdAt: '2026-05-25T10:00:00Z',
  author: 'TestUser',
  authorId: '999',
  nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/856?tab=posts',
};

const BUG_ITEM = {
  kind: 'bug',
  id: '67',
  title: 'Crash on launch with mods enabled',
  body: 'Stack trace attached. Profile is broken.',
  status: 'open',
  gameVersion: '1.0.5',
  createdAt: '2026-05-25T11:00:00Z',
  author: 'BugReporter',
  authorId: '888',
  nexus_url: 'https://www.nexusmods.com/slaythespire2/mods/856?tab=bugs',
};

test('renderIssueBody: comment item omits Title/GameVersion/Status lines', () => {
  const out = renderIssueBody(COMMENT_ITEM, TEMPLATE, { classification: 'bug', confidence: 'medium' });
  assert.ok(out.includes('@claude'), 'must start with @claude block');
  assert.ok(out.includes('untrusted third-party content'), 'untrusted warning present');
  assert.ok(out.includes('> the share button does nothing on click'), 'body quoted');
  assert.ok(!out.includes('**Title:**'), 'no orphan Title line');
  assert.ok(!out.includes('**Game version:**'), 'no orphan game version line');
  assert.ok(!out.includes('**Nexus bug status:**'), 'no orphan bug status line');
  assert.ok(out.includes('triage-bot:do-not-edit'), 'machine-readable footer present');
  assert.ok(out.includes('"nexus_id": "12345"'), 'footer includes correct id');
});

test('renderIssueBody: bug item includes Title + GameVersion + Status lines', () => {
  const out = renderIssueBody(BUG_ITEM, TEMPLATE, { classification: 'bug', confidence: 'high' });
  assert.ok(out.includes('**Title:** Crash on launch with mods enabled'), 'Title line present');
  assert.ok(out.includes('**Game version:** 1.0.5'), 'Game version line present');
  assert.ok(out.includes('**Nexus bug status:** open'), 'Status line present');
});

test('renderIssueBody: body content rendered verbatim inside blockquote', () => {
  const item = { ...COMMENT_ITEM, body: 'has `backticks` and <b>html</b> and @everyone mention' };
  const out = renderIssueBody(item, TEMPLATE, { classification: 'needs-triage', confidence: 'low' });
  assert.ok(out.includes('`backticks`'), 'backticks preserved in body');
  assert.ok(out.includes('<b>html</b>'), 'HTML preserved in body');
  assert.ok(out.includes('@everyone'), 'mention preserved in body (inside blockquote, safe)');
});

test('renderIssueBody: non-ASCII author preserved', () => {
  const item = { ...COMMENT_ITEM, author: '测试用户', authorId: '777' };
  const out = renderIssueBody(item, TEMPLATE, { classification: 'question', confidence: 'medium' });
  assert.ok(out.includes('[@测试用户]'), 'non-ASCII author rendered');
});

test('renderIssueBody: snapshot timestamp is ISO 8601 UTC with Z suffix', () => {
  const out = renderIssueBody(COMMENT_ITEM, TEMPLATE, { classification: 'bug', confidence: 'high' });
  const match = out.match(/\*\*Snapshot taken:\*\* (\S+)/);
  assert.ok(match, 'snapshot line present');
  assert.match(match[1], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, `ISO 8601 format: got ${match[1]}`);
  assert.ok(match[1].endsWith('Z'), `UTC Z suffix: got ${match[1]}`);
});

import {
  fetchModComments,
  fetchModBugReports,
  introspectSchema,
  setHttpFetch,
} from './nexus-triage.mjs';

const FIXTURE_COMMENTS = JSON.parse(readFileSync('scripts/fixtures/graphql-comments-mixed.json', 'utf-8'));
const FIXTURE_BUGS = JSON.parse(readFileSync('scripts/fixtures/graphql-bugs-mixed.json', 'utf-8'));
const FIXTURE_DRIFT_BUGREPORTS = JSON.parse(readFileSync('scripts/fixtures/graphql-schema-drift-bugreports.json', 'utf-8'));
const FIXTURE_DRIFT_COMMENTS = JSON.parse(readFileSync('scripts/fixtures/graphql-schema-drift-comments.json', 'utf-8'));

test('fetchModComments POSTs with apikey header and returns nodes', async () => {
  let captured;
  setHttpFetch(async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, json: async () => FIXTURE_COMMENTS };
  });
  try {
    const nodes = await fetchModComments({ apiKey: 'test-key' });
    assert.equal(captured.url, 'https://api.nexusmods.com/v2/graphql');
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.headers.apikey, 'test-key');
    assert.equal(captured.opts.headers['Content-Type'], 'application/json');
    assert.equal(nodes.length, 5);
    assert.equal(nodes[0].id, '300001');
  } finally {
    setHttpFetch(globalThis.fetch);
  }
});

test('fetchModBugReports filters by status [open]', async () => {
  let body;
  setHttpFetch(async (_url, opts) => {
    body = JSON.parse(opts.body);
    return { ok: true, status: 200, json: async () => FIXTURE_BUGS };
  });
  try {
    await fetchModBugReports({ apiKey: 'test-key' });
    assert.deepEqual(body.variables.statusIn, ['open']);
  } finally {
    setHttpFetch(globalThis.fetch);
  }
});

test('introspectSchema: both fields present returns hasComments + hasBugReports true', async () => {
  setHttpFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({ data: { __type: { name: 'Mod', fields: [
      { name: 'comments', type: { name: 'CommentConnection' }},
      { name: 'bugReports', type: { name: 'BugReportConnection' }},
    ]}}}),
  }));
  try {
    const result = await introspectSchema({ apiKey: 'test-key' });
    assert.deepEqual(result, { hasComments: true, hasBugReports: true });
  } finally {
    setHttpFetch(globalThis.fetch);
  }
});

test('introspectSchema: bugReports missing soft-fails (returns hasBugReports: false)', async (t) => {
  setHttpFetch(async () => ({ ok: true, status: 200, json: async () => FIXTURE_DRIFT_BUGREPORTS }));
  const exitCalls = [];
  t.mock.method(process, 'exit', (code) => { exitCalls.push(code); throw new Error('exit'); });
  try {
    const result = await introspectSchema({ apiKey: 'test-key' });
    assert.deepEqual(result, { hasComments: true, hasBugReports: false });
    assert.deepEqual(exitCalls, [], 'should NOT exit on bugReports drift');
  } finally {
    setHttpFetch(globalThis.fetch);
  }
});

test('introspectSchema: comments missing hard-fails (exit 2)', async (t) => {
  setHttpFetch(async () => ({ ok: true, status: 200, json: async () => FIXTURE_DRIFT_COMMENTS }));
  const exitCalls = [];
  const errs = [];
  t.mock.method(process, 'exit', (code) => { exitCalls.push(code); throw new Error('exit'); });
  t.mock.method(console, 'error', (m) => { errs.push(String(m)); });
  try {
    await assert.rejects(() => introspectSchema({ apiKey: 'test-key' }), /exit/);
    assert.deepEqual(exitCalls, [2]);
    assert.ok(errs.some((m) => m.includes('comments')), 'error must name the missing field');
  } finally {
    setHttpFetch(globalThis.fetch);
  }
});
