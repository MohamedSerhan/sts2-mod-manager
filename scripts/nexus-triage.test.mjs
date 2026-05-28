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

// ---------------------------------------------------------------------------
// graphqlPost tests
// ---------------------------------------------------------------------------

import {
  graphqlPost,
  fetchComments,
  fetchAllComments,
  setHttpFetch,
  NEXUS_GRAPHQL_URL,
  MAX_PAGES,
} from './nexus-triage.mjs';

function makeGraphqlResponse(nodes, hasNextPage = false, endCursor = null, totalCount = null) {
  return {
    data: {
      commentThread: {
        id: '16866026',
        comments: {
          nodes,
          pageInfo: { hasNextPage, endCursor },
          totalCount: totalCount ?? nodes.length,
        },
      },
    },
  };
}

function makeFakeNode(id, opts = {}) {
  return {
    id: String(id),
    body: opts.body ?? `Comment body ${id}`,
    createdAt: opts.createdAt ?? '2026-05-25T10:00:00Z',
    discardedAt: opts.discardedAt ?? null,
    hiddenAt: opts.hiddenAt ?? null,
    creator: { name: opts.name ?? `User${id}`, memberId: opts.memberId ?? id },
  };
}

test('graphqlPost: sends POST with correct headers and body shape', async (t) => {
  const requests = [];
  setHttpFetch(async (url, opts) => {
    requests.push({ url, opts });
    return {
      ok: true,
      json: async () => ({ data: { commentThread: { id: '1', comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null }, totalCount: 0 } } } }),
    };
  });
  try {
    await graphqlPost({ apiKey: 'test-key', query: 'query { foo }', variables: { x: 1 } });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, NEXUS_GRAPHQL_URL);
    assert.equal(requests[0].opts.method, 'POST');
    assert.equal(requests[0].opts.headers['Content-Type'], 'application/json');
    assert.equal(requests[0].opts.headers['apikey'], 'test-key');
    const body = JSON.parse(requests[0].opts.body);
    assert.equal(body.query, 'query { foo }');
    assert.deepEqual(body.variables, { x: 1 });
  } finally {
    setHttpFetch(null);
  }
});

test('graphqlPost: exits 1 on HTTP error status', async (t) => {
  setHttpFetch(async () => ({ ok: false, status: 403, statusText: 'Forbidden' }));
  const exitCalls = [];
  t.mock.method(process, 'exit', (code) => { exitCalls.push(code); throw new Error('exit'); });
  t.mock.method(console, 'error', () => {});
  try {
    await assert.rejects(
      () => graphqlPost({ apiKey: 'k', query: 'q', variables: {} }),
      /exit/
    );
    assert.deepEqual(exitCalls, [1]);
  } finally {
    setHttpFetch(null);
  }
});

test('graphqlPost: exits 1 when response contains errors array', async (t) => {
  setHttpFetch(async () => ({
    ok: true,
    json: async () => ({ errors: [{ message: 'Unauthorized' }] }),
  }));
  const exitCalls = [];
  t.mock.method(process, 'exit', (code) => { exitCalls.push(code); throw new Error('exit'); });
  t.mock.method(console, 'error', () => {});
  try {
    await assert.rejects(
      () => graphqlPost({ apiKey: 'k', query: 'q', variables: {} }),
      /exit/
    );
    assert.deepEqual(exitCalls, [1]);
  } finally {
    setHttpFetch(null);
  }
});

// ---------------------------------------------------------------------------
// fetchComments tests
// ---------------------------------------------------------------------------

test('fetchComments: returns nodes + pageInfo from single response', async () => {
  const nodes = [makeFakeNode(1), makeFakeNode(2)];
  setHttpFetch(async () => ({
    ok: true,
    json: async () => makeGraphqlResponse(nodes, false, null, 2),
  }));
  try {
    const result = await fetchComments({ apiKey: 'k', threadId: '123' });
    assert.equal(result.nodes.length, 2);
    assert.equal(result.pageInfo.hasNextPage, false);
  } finally {
    setHttpFetch(null);
  }
});

test('fetchComments: includes after cursor in variables when provided', async () => {
  const bodies = [];
  setHttpFetch(async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return {
      ok: true,
      json: async () => makeGraphqlResponse([], false, null),
    };
  });
  try {
    await fetchComments({ apiKey: 'k', threadId: '123', after: 'cursor42' });
    assert.equal(bodies[0].variables.after, 'cursor42');
  } finally {
    setHttpFetch(null);
  }
});

test('fetchComments: does not include after when undefined', async () => {
  const bodies = [];
  setHttpFetch(async (_url, opts) => {
    bodies.push(JSON.parse(opts.body));
    return {
      ok: true,
      json: async () => makeGraphqlResponse([], false, null),
    };
  });
  try {
    await fetchComments({ apiKey: 'k', threadId: '123' });
    assert.ok(!('after' in bodies[0].variables), 'after should be absent when not provided');
  } finally {
    setHttpFetch(null);
  }
});

// ---------------------------------------------------------------------------
// fetchAllComments pagination tests
// ---------------------------------------------------------------------------

test('fetchAllComments: single page (hasNextPage false) returns all nodes', async () => {
  const nodes = [makeFakeNode(10), makeFakeNode(11)];
  setHttpFetch(async () => ({
    ok: true,
    json: async () => makeGraphqlResponse(nodes, false),
  }));
  try {
    const result = await fetchAllComments({ apiKey: 'k', threadId: '123' });
    assert.equal(result.length, 2);
  } finally {
    setHttpFetch(null);
  }
});

test('fetchAllComments: paginates until hasNextPage false', async () => {
  let callCount = 0;
  setHttpFetch(async (_url, opts) => {
    callCount++;
    const body = JSON.parse(opts.body);
    const isFirstPage = !body.variables.after;
    if (isFirstPage) {
      return { ok: true, json: async () => makeGraphqlResponse([makeFakeNode(1), makeFakeNode(2)], true, 'cur2') };
    } else {
      return { ok: true, json: async () => makeGraphqlResponse([makeFakeNode(3)], false) };
    }
  });
  try {
    const result = await fetchAllComments({ apiKey: 'k', threadId: '123' });
    assert.equal(callCount, 2, `expected 2 fetches, got ${callCount}`);
    assert.equal(result.length, 3);
    const ids = result.map((n) => n.id).sort();
    assert.deepEqual(ids, ['1', '2', '3']);
  } finally {
    setHttpFetch(null);
  }
});

test('fetchAllComments: stops at MAX_PAGES even if hasNextPage stays true', async () => {
  let callCount = 0;
  setHttpFetch(async () => {
    callCount++;
    return {
      ok: true,
      json: async () => makeGraphqlResponse([makeFakeNode(callCount)], true, `cur${callCount}`),
    };
  });
  try {
    const result = await fetchAllComments({ apiKey: 'k', threadId: '123' });
    assert.equal(callCount, MAX_PAGES, `expected ${MAX_PAGES} fetches (cap), got ${callCount}`);
    assert.equal(result.length, MAX_PAGES);
  } finally {
    setHttpFetch(null);
  }
});

// ---------------------------------------------------------------------------
// commentToItem (via GraphQL-shaped orchestrator integration tests)
// ---------------------------------------------------------------------------

import { buildNexusCommentUrl, POSTS_URL } from './nexus-triage.mjs';

test('buildNexusCommentUrl: appends commentid param', () => {
  const url = buildNexusCommentUrl('https://www.nexusmods.com/slaythespire2/mods/856?tab=posts', '12345');
  assert.ok(url.includes('commentid=12345'), `expected commentid param, got: ${url}`);
  assert.ok(url.includes('tab=posts'), `expected tab=posts, got: ${url}`);
});

// ---------------------------------------------------------------------------
// Orchestrator integration tests (stub setHttpFetch for Nexus, setGhInvoker for GitHub)
// ---------------------------------------------------------------------------

import { main, setGhInvoker } from './nexus-triage.mjs';

function resetFetchers() {
  setHttpFetch(null);
  setGhInvoker(async () => { throw new Error('gh not stubbed; tests must call setGhInvoker'); });
}

function makeGraphqlFetcher(nodes, hasNextPage = false) {
  return async () => ({
    ok: true,
    json: async () => makeGraphqlResponse(nodes, hasNextPage),
  });
}

function makeMaintainerNodes() {
  return [
    makeFakeNode(500001, { name: 'xxskullmikexx', body: 'reply from maintainer about something' }),
    makeFakeNode(500002, { name: 'Sky2Fly', body: 'co-maintainer note' }),
    makeFakeNode(500003, { name: 'XXSkullMikeXX', body: 'another maintainer comment' }),
  ];
}

test('main: maintainer comments are skipped before classification', async () => {
  setHttpFetch(makeGraphqlFetcher(makeMaintainerNodes()));
  const ghCalls = [];
  setGhInvoker(async (args) => { ghCalls.push(args); return { number: ghCalls.length + 100, url: `https://github.com/x/y/issues/${ghCalls.length + 100}`, stdout: '' }; });
  try {
    const result = await main({ dryRun: true, apiKey: 'k', ghToken: 't', state: { schema_version: 1, last_run_at: '', comments: {}, bugs: {}, kudos_seen: [] }});
    assert.equal(ghCalls.length, 0, 'no issues filed in dry-run');
    assert.equal(result.filed.length, 0, 'no filed in result');
    assert.equal(result.maintainerSkipped, 3, 'all three maintainer comments skipped');
  } finally {
    resetFetchers();
  }
});

test('main: discarded/hidden comments are filtered out before classification', async () => {
  const nodes = [
    makeFakeNode(600001, { body: 'crash bug here', discardedAt: '2026-05-25T10:00:00Z' }),
    makeFakeNode(600002, { body: 'crash bug here too', hiddenAt: '2026-05-25T10:00:00Z' }),
    makeFakeNode(600003, { body: 'visible bug crash', discardedAt: null, hiddenAt: null }),
  ];
  setHttpFetch(makeGraphqlFetcher(nodes));
  const ghCalls = [];
  setGhInvoker(async (args) => { ghCalls.push(args); return { number: 1, url: 'https://github.com/x/y/issues/1', stdout: '' }; });
  try {
    const result = await main({ dryRun: true, apiKey: 'k', ghToken: 't', state: { schema_version: 1, last_run_at: '', comments: {}, bugs: {}, kudos_seen: [] }});
    // Only id 600003 should be considered
    assert.equal(result.filed.length, 1, `expected 1 item in dry-run filed list, got ${result.filed.length}`);
    assert.equal(result.filed[0].nexus_id, '600003');
  } finally {
    resetFetchers();
  }
});

test('main: per-run cap caps non-kudos at 5, kudos do not count', async () => {
  const bugNodes = Array.from({ length: 10 }, (_, i) =>
    makeFakeNode(700000 + i, { body: `crash issue number ${i}`, createdAt: `2026-05-25T${String(i).padStart(2, '0')}:00:00Z` })
  );
  const kudosNodes = Array.from({ length: 3 }, (_, i) =>
    makeFakeNode(800000 + i, { body: 'thanks great mod love it', createdAt: `2026-05-25T1${i}:00:00Z` })
  );
  setHttpFetch(makeGraphqlFetcher([...bugNodes, ...kudosNodes]));
  const ghCalls = [];
  setGhInvoker(async (args) => { ghCalls.push(args); return { number: ghCalls.length + 100, url: `https://github.com/x/y/issues/${ghCalls.length + 100}`, stdout: '' }; });
  try {
    const result = await main({ dryRun: false, apiKey: 'k', ghToken: 't', state: { schema_version: 1, last_run_at: '', comments: {}, bugs: {}, kudos_seen: [] }});
    assert.equal(ghCalls.length, 5, `cap should be 5, got ${ghCalls.length}`);
    assert.equal(result.kudosSkipped, 3, 'all 3 kudos accounted');
    // Oldest 5 (700000..700004) should file
    const filedIds = result.filed.map((f) => f.nexus_id).sort();
    assert.deepEqual(filedIds, ['700000', '700001', '700002', '700003', '700004']);
  } finally {
    resetFetchers();
  }
});

test('main: already-seen items are skipped silently', async () => {
  const nodes = [
    makeFakeNode(900001, { body: 'crash issue old' }),
    makeFakeNode(900002, { body: 'crash issue new' }),
  ];
  setHttpFetch(makeGraphqlFetcher(nodes));
  const ghCalls = [];
  setGhInvoker(async (args) => { ghCalls.push(args); return { number: 999, url: 'https://github.com/x/y/issues/999', stdout: '' }; });
  try {
    const state = {
      schema_version: 1, last_run_at: '',
      comments: { '900001': { gh_issue_url: 'https://github.com/x/y/issues/45', classification: 'bug', filed_at: '2026-05-24T00:00:00Z' }},
      bugs: {}, kudos_seen: [],
    };
    const result = await main({ dryRun: false, apiKey: 'k', ghToken: 't', state });
    assert.equal(ghCalls.length, 1, `only the new item files, got ${ghCalls.length}`);
    assert.equal(result.filed[0].nexus_id, '900002');
  } finally {
    resetFetchers();
  }
});

test('main: commentToItem maps creator.name and creator.memberId correctly', async () => {
  const nodes = [
    makeFakeNode(1001, { body: 'crash on open', name: 'SpecificUser', memberId: 42 }),
  ];
  setHttpFetch(makeGraphqlFetcher(nodes));
  const filedItems = [];
  setGhInvoker(async (args) => {
    filedItems.push(args);
    return { number: 1, url: 'https://github.com/x/y/issues/1', stdout: '' };
  });
  try {
    const result = await main({ dryRun: false, apiKey: 'k', ghToken: 't', state: { schema_version: 1, last_run_at: '', comments: {}, bugs: {}, kudos_seen: [] }});
    assert.equal(result.filed.length, 1);
    // The gh issue body should contain SpecificUser and memberId 42
    const bodyArg = filedItems[0][filedItems[0].indexOf('--body') + 1];
    assert.ok(bodyArg.includes('SpecificUser'), `author name not found in issue body`);
    assert.ok(bodyArg.includes('42'), `memberId not found in issue body`);
  } finally {
    resetFetchers();
  }
});

// ---------------------------------------------------------------------------
// parseArgs / isDisabled / runFromCli tests
// ---------------------------------------------------------------------------

import { parseArgs, isDisabled, runFromCli } from './nexus-triage.mjs';
import { unlinkSync } from 'node:fs';
import { STATE_PATH } from './nexus-triage.mjs';

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

// runFromCli: missing GITHUB_TOKEN exits 2
test('runFromCli: missing GITHUB_TOKEN exits 2 with message', async (t) => {
  const origGhToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const exitCalls = [];
  const consoleErrs = [];
  t.mock.method(process, 'exit', (code) => { exitCalls.push(code); throw new Error('exit'); });
  t.mock.method(console, 'error', (m) => { consoleErrs.push(String(m)); });
  try {
    await assert.rejects(() => runFromCli([]), /exit/);
    assert.deepEqual(exitCalls, [2]);
    assert.ok(consoleErrs.some((m) => /GITHUB_TOKEN/i.test(m)), 'should mention GITHUB_TOKEN');
  } finally {
    if (origGhToken !== undefined) process.env.GITHUB_TOKEN = origGhToken;
    else delete process.env.GITHUB_TOKEN;
  }
});

// runFromCli: missing NEXUS_API_KEY exits 2
test('runFromCli: missing NEXUS_API_KEY exits 2 with message', async (t) => {
  const origGhToken = process.env.GITHUB_TOKEN;
  const origApiKey = process.env.NEXUS_API_KEY;
  process.env.GITHUB_TOKEN = 'test-token';
  delete process.env.NEXUS_API_KEY;
  const exitCalls = [];
  const consoleErrs = [];
  t.mock.method(process, 'exit', (code) => { exitCalls.push(code); throw new Error('exit'); });
  t.mock.method(console, 'error', (m) => { consoleErrs.push(String(m)); });
  try {
    await assert.rejects(() => runFromCli([]), /exit/);
    assert.deepEqual(exitCalls, [2]);
    assert.ok(consoleErrs.some((m) => /NEXUS_API_KEY/i.test(m)), `should mention NEXUS_API_KEY, got: ${consoleErrs.join(' | ')}`);
  } finally {
    if (origGhToken !== undefined) process.env.GITHUB_TOKEN = origGhToken;
    else delete process.env.GITHUB_TOKEN;
    if (origApiKey !== undefined) process.env.NEXUS_API_KEY = origApiKey;
    else delete process.env.NEXUS_API_KEY;
  }
});
