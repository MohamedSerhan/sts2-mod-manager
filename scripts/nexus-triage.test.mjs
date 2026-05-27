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

import { main, setGhInvoker, ensureSchemaGapIssue } from './nexus-triage.mjs';

const MAINTAINER_FIXTURE_COMMENTS = [
  // From maintainer — must be skipped
  { id: '500001', body: 'reply from maintainer about something', createdAt: '2026-05-25T08:00:00Z', creator: { name: 'xxskullmikexx', memberId: '1' }},
  { id: '500002', body: 'co-maintainer note', createdAt: '2026-05-25T09:00:00Z', creator: { name: 'Sky2Fly', memberId: '2' }},
  // Maintainer with different casing — must still be skipped
  { id: '500003', body: 'another maintainer comment', createdAt: '2026-05-25T09:30:00Z', creator: { name: 'XXSkullMikeXX', memberId: '1' }},
];

test('main: maintainer comments are skipped before classification', async (t) => {
  const fixture = { data: { mod: { comments: { nodes: MAINTAINER_FIXTURE_COMMENTS }, bugReports: { nodes: [] }}}};
  setHttpFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.query.includes('__type')) {
      return { ok: true, status: 200, json: async () => ({ data: { __type: { name: 'Mod', fields: [
        { name: 'comments', type: { name: 'CommentConnection' }},
        { name: 'bugReports', type: { name: 'BugReportConnection' }},
      ]}}})};
    }
    return { ok: true, status: 200, json: async () => fixture };
  });
  const ghCalls = [];
  setGhInvoker(async (args) => { ghCalls.push(args); return { number: ghCalls.length + 100, url: `https://github.com/x/y/issues/${ghCalls.length + 100}`, stdout: '' }; });
  try {
    const result = await main({ dryRun: true, apiKey: 'k', ghToken: 't', state: { schema_version: 1, last_run_at: '', comments: {}, bugs: {}, kudos_seen: [] }});
    assert.equal(ghCalls.length, 0, 'no issues filed in dry-run');
    assert.equal(result.filed.length, 0, 'no filed in result');
    assert.equal(result.maintainerSkipped, 3, 'all three maintainer comments skipped');
  } finally {
    setHttpFetch(globalThis.fetch);
    setGhInvoker(async () => { throw new Error('gh not stubbed; tests must call setGhInvoker'); });
  }
});

test('main: per-run cap caps non-kudos at 5, kudos do not count', async () => {
  const items = Array.from({ length: 10 }, (_, i) => ({
    id: String(600000 + i),
    body: `crash issue number ${i}`,
    createdAt: `2026-05-25T0${i}:00:00Z`,
    creator: { name: `User${i}`, memberId: String(700000 + i) },
  }));
  const kudosItems = Array.from({ length: 3 }, (_, i) => ({
    id: String(800000 + i),
    body: 'thanks great mod love it',
    createdAt: `2026-05-25T1${i}:00:00Z`,
    creator: { name: `KudosUser${i}`, memberId: String(900000 + i) },
  }));
  const fixture = { data: { mod: { comments: { nodes: [...items, ...kudosItems] }, bugReports: { nodes: [] }}}};
  setHttpFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.query.includes('__type')) {
      return { ok: true, status: 200, json: async () => ({ data: { __type: { name: 'Mod', fields: [
        { name: 'comments', type: { name: 'CommentConnection' }},
        { name: 'bugReports', type: { name: 'BugReportConnection' }},
      ]}}})};
    }
    return { ok: true, status: 200, json: async () => fixture };
  });
  const ghCalls = [];
  setGhInvoker(async (args) => { ghCalls.push(args); return { number: ghCalls.length + 100, url: `https://github.com/x/y/issues/${ghCalls.length + 100}`, stdout: '' }; });
  try {
    const result = await main({ dryRun: false, apiKey: 'k', ghToken: 't', state: { schema_version: 1, last_run_at: '', comments: {}, bugs: {}, kudos_seen: [] }});
    assert.equal(ghCalls.length, 5, `cap should be 5, got ${ghCalls.length}`);
    assert.equal(result.kudosSkipped, 3, 'all 3 kudos accounted');
    // Oldest 5 (i=0..4) should file
    const filedIds = result.filed.map((f) => f.nexus_id).sort();
    assert.deepEqual(filedIds, ['600000', '600001', '600002', '600003', '600004']);
  } finally {
    setHttpFetch(globalThis.fetch);
    setGhInvoker(async () => { throw new Error('gh not stubbed; tests must call setGhInvoker'); });
  }
});

test('main: already-seen items are skipped silently', async () => {
  const items = [
    { id: '700001', body: 'crash issue old', createdAt: '2026-05-25T08:00:00Z', creator: { name: 'OldUser', memberId: '10' }},
    { id: '700002', body: 'crash issue new', createdAt: '2026-05-25T09:00:00Z', creator: { name: 'NewUser', memberId: '11' }},
  ];
  setHttpFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.query.includes('__type')) {
      return { ok: true, status: 200, json: async () => ({ data: { __type: { name: 'Mod', fields: [
        { name: 'comments', type: { name: 'CommentConnection' }},
        { name: 'bugReports', type: { name: 'BugReportConnection' }},
      ]}}})};
    }
    return { ok: true, status: 200, json: async () => ({ data: { mod: { comments: { nodes: items }, bugReports: { nodes: [] }}}})};
  });
  const ghCalls = [];
  setGhInvoker(async (args) => { ghCalls.push(args); return { number: 999, url: 'https://github.com/x/y/issues/999', stdout: '' }; });
  try {
    const state = {
      schema_version: 1, last_run_at: '',
      comments: { '700001': { gh_issue_url: 'https://github.com/x/y/issues/45', classification: 'bug', filed_at: '2026-05-24T00:00:00Z' }},
      bugs: {}, kudos_seen: [],
    };
    const result = await main({ dryRun: false, apiKey: 'k', ghToken: 't', state });
    assert.equal(ghCalls.length, 1, `only the new item files, got ${ghCalls.length}`);
    assert.equal(result.filed[0].nexus_id, '700002');
  } finally {
    setHttpFetch(globalThis.fetch);
    setGhInvoker(async () => { throw new Error('gh not stubbed; tests must call setGhInvoker'); });
  }
});

test('main: Nexus bug with status=closed is skipped silently on first sight', async () => {
  const bugs = [
    { id: '900001', title: 'open bug', description: 'open', status: 'open', priority: 'high', createdAt: '2026-05-25T08:00:00Z', gameVersion: '1.0.5', reporter: { name: 'BugUser', memberId: '20' }},
    { id: '900002', title: 'closed bug', description: 'closed', status: 'closed', priority: 'low', createdAt: '2026-05-25T09:00:00Z', gameVersion: '1.0.5', reporter: { name: 'BugUser2', memberId: '21' }},
  ];
  setHttpFetch(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.query.includes('__type')) {
      return { ok: true, status: 200, json: async () => ({ data: { __type: { name: 'Mod', fields: [
        { name: 'comments', type: { name: 'CommentConnection' }},
        { name: 'bugReports', type: { name: 'BugReportConnection' }},
      ]}}})};
    }
    if (body.query.includes('ModBugReports')) {
      return { ok: true, status: 200, json: async () => ({ data: { mod: { bugReports: { nodes: bugs }}}})};
    }
    return { ok: true, status: 200, json: async () => ({ data: { mod: { comments: { nodes: [] }}}})};
  });
  const ghCalls = [];
  setGhInvoker(async (args) => { ghCalls.push(args); return { number: 999, url: 'https://github.com/x/y/issues/999', stdout: '' }; });
  try {
    const result = await main({ dryRun: false, apiKey: 'k', ghToken: 't', state: { schema_version: 1, last_run_at: '', comments: {}, kudos_seen: [], bugs: {} }});
    assert.equal(ghCalls.length, 1, 'only the open bug files');
    assert.equal(result.filed[0].nexus_id, '900001');
  } finally {
    setHttpFetch(globalThis.fetch);
    setGhInvoker(async () => { throw new Error('gh not stubbed; tests must call setGhInvoker'); });
  }
});

import { parseArgs, isDisabled, runFromCli } from './nexus-triage.mjs';
import { unlinkSync } from 'node:fs';

test('parseArgs: defaults', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, bootstrap: false, help: false });
});

test('parseArgs: --dry-run', () => {
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true, bootstrap: false, help: false });
});

test('parseArgs: --bootstrap', () => {
  assert.deepEqual(parseArgs(['--bootstrap']), { dryRun: false, bootstrap: true, help: false });
});

test('parseArgs: --help', () => {
  assert.deepEqual(parseArgs(['--help']), { dryRun: false, bootstrap: false, help: true });
});

test('parseArgs: unknown flag exits 2', (t) => {
  const exitCalls = [];
  t.mock.method(process, 'exit', (code) => { exitCalls.push(code); throw new Error('exit'); });
  t.mock.method(console, 'error', () => {});
  assert.throws(() => parseArgs(['--unknown']), /exit/);
  assert.deepEqual(exitCalls, [2]);
});

test('isDisabled: returns true when sentinel exists', () => {
  const path = 'scripts/nexus-triage.disabled';
  writeFileSync(path, 'disabled', 'utf-8');
  try {
    assert.equal(isDisabled(path), true);
  } finally {
    unlinkSync(path);
  }
});

test('isDisabled: returns false when sentinel absent', () => {
  assert.equal(isDisabled('scripts/does-not-exist.disabled'), false);
});

// ---------------------------------------------------------------------------
// ensureSchemaGapIssue + runFromCli schema-gap integration tests
// ---------------------------------------------------------------------------

import { STATE_PATH, STATE_SCHEMA_VERSION as _SSV } from './nexus-triage.mjs';

// Shared introspection fixture: bugReports field absent (soft drift).
function makeDriftHttpFetch() {
  return async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.query.includes('__type')) {
      // bugReports absent from schema
      return { ok: true, status: 200, json: async () => ({ data: { __type: { name: 'Mod', fields: [
        { name: 'comments', type: { name: 'CommentConnection' }},
      ]}}})};
    }
    // Comments fetch: return empty list
    return { ok: true, status: 200, json: async () => ({ data: { mod: { comments: { nodes: [] }}}})};
  };
}

function makeValidState() {
  return JSON.stringify({
    schema_version: 1,
    last_run_at: '2026-05-26T00:00:00.000Z',
    comments: {}, bugs: {}, kudos_seen: [],
  }) + '\n';
}

test('runFromCli files ops:nexus-schema-gap when bugReports drift detected and no existing issue', async () => {
  writeFileSync(STATE_PATH, makeValidState(), 'utf-8');
  const origApiKey = process.env.NEXUS_API_KEY;
  const origGhToken = process.env.GITHUB_TOKEN;
  process.env.NEXUS_API_KEY = 'test-key';
  process.env.GITHUB_TOKEN = 'test-token';

  setHttpFetch(makeDriftHttpFetch());
  const ghCalls = [];
  // First call: issue list (no existing issue → empty stdout)
  // Second call: issue create
  setGhInvoker(async (args) => {
    ghCalls.push(args);
    if (args.includes('list')) return { number: -1, url: '', stdout: '' };
    return { number: 42, url: 'https://github.com/x/y/issues/42', stdout: 'https://github.com/x/y/issues/42\n' };
  });

  try {
    await runFromCli([]);

    // Should have made exactly 2 gh calls: list + create
    assert.equal(ghCalls.length, 2, `expected 2 gh calls (list + create), got ${ghCalls.length}: ${JSON.stringify(ghCalls)}`);
    assert.ok(ghCalls[0].includes('list'), `first call should be issue list, got: ${ghCalls[0]}`);
    assert.ok(ghCalls[0].includes('ops:nexus-schema-gap'), 'list call uses the correct label');
    assert.ok(ghCalls[1].includes('create'), `second call should be issue create, got: ${ghCalls[1]}`);
    assert.ok(ghCalls[1].includes('[ops] Nexus GraphQL schema gap: mod.bugReports unavailable'),
      'create call uses the correct title');
    assert.ok(ghCalls[1].includes('ops:nexus-schema-gap'), 'create call uses the correct label');
  } finally {
    setHttpFetch(globalThis.fetch);
    setGhInvoker(async () => { throw new Error('gh not stubbed; tests must call setGhInvoker'); });
    process.env.NEXUS_API_KEY = origApiKey;
    process.env.GITHUB_TOKEN = origGhToken;
    try { unlinkSync(STATE_PATH); } catch { /* already gone */ }
  }
});

test('runFromCli does NOT file duplicate ops:nexus-schema-gap when one already exists', async () => {
  writeFileSync(STATE_PATH, makeValidState(), 'utf-8');
  const origApiKey = process.env.NEXUS_API_KEY;
  const origGhToken = process.env.GITHUB_TOKEN;
  process.env.NEXUS_API_KEY = 'test-key';
  process.env.GITHUB_TOKEN = 'test-token';

  setHttpFetch(makeDriftHttpFetch());
  const ghCalls = [];
  // Issue list returns existing open issue #99 → no create should follow
  setGhInvoker(async (args) => {
    ghCalls.push(args);
    if (args.includes('list')) return { number: 99, url: 'https://github.com/x/y/issues/99', stdout: '99\n' };
    return { number: -1, url: '', stdout: '' };
  });

  try {
    await runFromCli([]);

    // Only the list call — no create
    assert.equal(ghCalls.length, 1, `expected 1 gh call (list only), got ${ghCalls.length}: ${JSON.stringify(ghCalls)}`);
    assert.ok(ghCalls[0].includes('list'), `only call should be issue list, got: ${ghCalls[0]}`);
  } finally {
    setHttpFetch(globalThis.fetch);
    setGhInvoker(async () => { throw new Error('gh not stubbed; tests must call setGhInvoker'); });
    process.env.NEXUS_API_KEY = origApiKey;
    process.env.GITHUB_TOKEN = origGhToken;
    try { unlinkSync(STATE_PATH); } catch { /* already gone */ }
  }
});

test('runFromCli does NOT call gh for schema-gap when dry-run (even if bugReportsUnavailable)', async () => {
  writeFileSync(STATE_PATH, makeValidState(), 'utf-8');
  const origApiKey = process.env.NEXUS_API_KEY;
  const origGhToken = process.env.GITHUB_TOKEN;
  process.env.NEXUS_API_KEY = 'test-key';
  process.env.GITHUB_TOKEN = 'test-token';

  setHttpFetch(makeDriftHttpFetch());
  const ghCalls = [];
  // Should never be called in dry-run mode
  setGhInvoker(async (args) => {
    ghCalls.push(args);
    return { number: -1, url: '', stdout: '' };
  });

  const consoleLogCalls = [];
  const origLog = console.log;
  console.log = (msg) => { consoleLogCalls.push(String(msg)); };

  try {
    await runFromCli(['--dry-run']);

    // Zero gh calls — not even the list call
    assert.equal(ghCalls.length, 0, `expected 0 gh calls in dry-run, got ${ghCalls.length}: ${JSON.stringify(ghCalls)}`);

    // Should have logged the dry-run message
    assert.ok(
      consoleLogCalls.some((msg) => msg.includes('Would file ops:nexus-schema-gap')),
      `expected dry-run message about schema-gap, got: ${consoleLogCalls.join(' | ')}`
    );
  } finally {
    setHttpFetch(globalThis.fetch);
    setGhInvoker(async () => { throw new Error('gh not stubbed; tests must call setGhInvoker'); });
    console.log = origLog;
    process.env.NEXUS_API_KEY = origApiKey;
    process.env.GITHUB_TOKEN = origGhToken;
    try { unlinkSync(STATE_PATH); } catch { /* already gone */ }
  }
});
