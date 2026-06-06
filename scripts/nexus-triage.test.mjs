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

test('sanitizeTitle decodes entities before stripping tags', () => {
  assert.equal(
    sanitizeTitle('report &lt;script&gt;alert(1)&lt;/script&gt; still broken'),
    'report alert(1) still broken',
  );
});

test('sanitizeTitle preserves encoded comparison operators', () => {
  assert.equal(
    sanitizeTitle('Cannot install with version &lt; 2.0 on Windows'),
    'Cannot install with version < 2.0 on Windows',
  );
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

// kudos word variants (real comments observed on mod 856)
for (const body of [
  'Thank you so much!!! God bless 🙏',
  'thank you for this',
  'thanks!',
  'appreciate the work',
  'you are a legend',
  'works perfectly, kudos',
]) {
  test(`classify: kudos matches gratitude variant "${body}"`, () => {
    assert.equal(classify(body, 'comment').classification, 'kudos',
      `expected kudos for "${body}"`);
  });
}

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
  const retiredMention = '@' + 'cl' + 'aude';
  assert.ok(out.includes('Nexus user report triage'), 'triage heading present');
  assert.ok(!out.includes(retiredMention), 'body does not depend on a retired agent mention');
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
// parseCommentsFromHtml tests
// ---------------------------------------------------------------------------

import {
  parseCommentsFromHtml,
  isCloudflareChallenge,
} from './nexus-triage.mjs';

const FIXTURE_COMMENTS_MIXED = readFileSync('scripts/fixtures/nexus-comments-mixed.html', 'utf-8');
const FIXTURE_COMMENTS_EMPTY = readFileSync('scripts/fixtures/nexus-comments-empty.html', 'utf-8');

test('parseCommentsFromHtml: extracts 5 comments from mixed fixture', () => {
  const comments = parseCommentsFromHtml(FIXTURE_COMMENTS_MIXED);
  assert.equal(comments.length, 5, `expected 5, got ${comments.length}`);
  // All have required fields
  for (const c of comments) {
    assert.ok(c.id, `comment missing id: ${JSON.stringify(c)}`);
    assert.ok(c.author, `comment missing author: ${JSON.stringify(c)}`);
    assert.ok(c.body, `comment missing body: ${JSON.stringify(c)}`);
    assert.ok(c.createdAt, `comment missing createdAt: ${JSON.stringify(c)}`);
  }
});

test('parseCommentsFromHtml: correct ids extracted from mixed fixture', () => {
  const comments = parseCommentsFromHtml(FIXTURE_COMMENTS_MIXED);
  const ids = comments.map((c) => c.id).sort();
  assert.deepEqual(ids, ['100001', '100002', '100003', '100004', '100005']);
});

test('parseCommentsFromHtml: correct authors extracted', () => {
  const comments = parseCommentsFromHtml(FIXTURE_COMMENTS_MIXED);
  const byId = Object.fromEntries(comments.map((c) => [c.id, c]));
  assert.equal(byId['100001'].author, 'KudosUser');
  assert.equal(byId['100002'].author, 'BugReporter');
  assert.equal(byId['100003'].author, 'FeatureWanter');
  assert.equal(byId['100004'].author, 'QuestionAsker');
  assert.equal(byId['100005'].author, 'TriageUser');
});

test('parseCommentsFromHtml: createdAt is ISO 8601 UTC with Z suffix', () => {
  const comments = parseCommentsFromHtml(FIXTURE_COMMENTS_MIXED);
  for (const c of comments) {
    assert.match(c.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
      `createdAt not ISO 8601: ${c.createdAt} for id ${c.id}`);
  }
});

test('parseCommentsFromHtml: empty page returns empty array', () => {
  const comments = parseCommentsFromHtml(FIXTURE_COMMENTS_EMPTY);
  assert.equal(comments.length, 0);
});

test('parseCommentsFromHtml: Cloudflare challenge HTML throws', () => {
  const cfHtml = '<html><head><title>Just a moment...</title></head><body>cf-challenge</body></html>';
  assert.throws(
    () => parseCommentsFromHtml(cfHtml),
    /Cloudflare blocked/,
    'should throw on Cloudflare challenge'
  );
});

test('parseCommentsFromHtml: comment missing body div is skipped, others extracted', () => {
  // Malformed: comment 999 has no comment-content div; 100001 is fine
  const malformed = `
    <ul>
      <li id="comment-999" class="comment">
        <span class="comment-name">BadUser</span>
        <time data-date="1748217600"></time>
      </li>
      <li id="comment-100001" class="comment">
        <span class="comment-name">GoodUser</span>
        <div id="comment-content-100001">This is a valid comment body.</div>
        <time data-date="1748217600"></time>
      </li>
    </ul>
  `;
  const comments = parseCommentsFromHtml(malformed);
  assert.equal(comments.length, 1, `expected 1 comment, got ${comments.length}`);
  assert.equal(comments[0].id, '100001');
  assert.equal(comments[0].author, 'GoodUser');
});

test('parseCommentsFromHtml: encoded tags are decoded before tag stripping', () => {
  const html = `
    <li id="comment-100010" class="comment">
      <span class="comment-name">EncodedUser</span>
      <div id="comment-content-100010">hi &lt;script&gt;alert(1)&lt;/script&gt; bye</div>
      <time data-date="1748217600"></time>
    </li>
  `;
  const comments = parseCommentsFromHtml(html);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, 'hi alert(1) bye');
});

test('parseCommentsFromHtml: encoded comparison operators survive tag stripping', () => {
  const html = `
    <li id="comment-100012" class="comment">
      <span class="comment-name">ComparisonUser</span>
      <div id="comment-content-100012">Cannot install with version &lt; 2.0 on Windows</div>
      <time data-date="1748217600"></time>
    </li>
  `;
  const comments = parseCommentsFromHtml(html);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, 'Cannot install with version < 2.0 on Windows');
});

test('parseCommentsFromHtml: ampersand entities are decoded last', () => {
  const html = `
    <li id="comment-100011" class="comment">
      <span class="comment-name">AmpUser</span>
      <div id="comment-content-100011">literal &amp;lt;script&amp;gt; text</div>
      <time data-date="1748217600"></time>
    </li>
  `;
  const comments = parseCommentsFromHtml(html);
  assert.equal(comments.length, 1);
  assert.equal(comments[0].body, 'literal &lt;script&gt; text');
});

test('isCloudflareChallenge: detects cf-chl marker', () => {
  assert.equal(isCloudflareChallenge('<html>some cf-chl content</html>'), true);
});

test('isCloudflareChallenge: detects "Just a moment" title', () => {
  assert.equal(isCloudflareChallenge('<title>Just a moment...</title>'), true);
});

test('isCloudflareChallenge: returns false for normal HTML', () => {
  assert.equal(isCloudflareChallenge('<html><title>Nexus Mods</title></html>'), false);
});

// ---------------------------------------------------------------------------
// fetchAllComments pagination tests
// ---------------------------------------------------------------------------

import {
  fetchAllComments,
  setHtmlFetcher,
  PAGE_SIZE,
  MAX_PAGES,
} from './nexus-triage.mjs';

// Helper: make n-comment HTML with the given ids
function makePageHtml(ids) {
  return ids.map((id, i) => `
    <li id="comment-${id}" class="comment">
      <span class="comment-name">User${id}</span>
      <div id="comment-content-${id}">Comment body for ${id}</div>
      <time data-date="${1748217600 + i}"></time>
    </li>
  `).join('');
}

test('fetchAllComments: stops when no new IDs appear on next page', async () => {
  // Page 1: 10 comments; Page 2: same 10 comments (no new) → stop
  const page1Html = makePageHtml(Array.from({ length: 10 }, (_, i) => 200000 + i));
  const page2Html = makePageHtml(Array.from({ length: 10 }, (_, i) => 200000 + i)); // same ids

  let callCount = 0;
  setHtmlFetcher(async (_url) => {
    callCount++;
    if (callCount === 1) return page1Html;
    return page2Html; // same ids — should terminate
  });

  try {
    const comments = await fetchAllComments({ threadId: 'test-thread' });
    assert.equal(callCount, 2, `expected 2 fetches (page1 + page2 with no-new), got ${callCount}`);
    assert.equal(comments.length, 10, `expected 10 unique comments, got ${comments.length}`);
  } finally {
    setHtmlFetcher(null); // reset
  }
});

test('fetchAllComments: stops at MAX_PAGES even if new IDs keep appearing', async () => {
  let callCount = 0;
  setHtmlFetcher(async (_url) => {
    callCount++;
    // Each page has fresh IDs so pagination would continue forever without the cap
    return makePageHtml(Array.from({ length: PAGE_SIZE }, (_, i) => 300000 + (callCount - 1) * PAGE_SIZE + i));
  });

  try {
    const comments = await fetchAllComments({ threadId: 'test-thread' });
    assert.equal(callCount, MAX_PAGES, `expected ${MAX_PAGES} fetches (cap), got ${callCount}`);
    assert.equal(comments.length, PAGE_SIZE * MAX_PAGES);
  } finally {
    setHtmlFetcher(null);
  }
});

test('fetchAllComments: concatenates comments from multiple pages correctly', async () => {
  // PAGE_SIZE is 10. Page 1 has 10 items (full page → continue), page 2 has 5 (< PAGE_SIZE → stop).
  const page1Ids = Array.from({ length: PAGE_SIZE }, (_, i) => 400000 + i); // 400000..400009
  const page2Ids = [400010, 400011, 400012, 400013, 400014];                // 400010..400014

  const page1Html = makePageHtml(page1Ids);
  const page2Html = makePageHtml(page2Ids);

  let callCount = 0;
  setHtmlFetcher(async (_url) => {
    callCount++;
    if (callCount === 1) return page1Html;
    return page2Html;
  });

  try {
    const comments = await fetchAllComments({ threadId: 'test-thread' });
    // page2 has only 5 comments < PAGE_SIZE, so terminates after page2
    assert.equal(callCount, 2, `expected 2 fetch calls, got ${callCount}`);
    assert.equal(comments.length, 15, `expected 15 comments, got ${comments.length}`);
    const expectedIds = [...page1Ids, ...page2Ids].map(String).sort();
    const actualIds = comments.map((c) => c.id).sort();
    assert.deepEqual(actualIds, expectedIds);
  } finally {
    setHtmlFetcher(null);
  }
});

// ---------------------------------------------------------------------------
// Bug parser tests (ModBugsTab widget table)
// ---------------------------------------------------------------------------

import { parseBugsFromHtml, fetchAllBugs, parseBugReport, fetchBugBody } from './nexus-triage.mjs';

const BUGS_HTML = readFileSync('scripts/fixtures/nexus-bugs-mixed.html', 'utf-8');

test('parseBugsFromHtml: extracts id, title, status, version from table rows', () => {
  const bugs = parseBugsFromHtml(BUGS_HTML);
  assert.equal(bugs.length, 3, `expected 3 bug rows, got ${bugs.length}`);
  const first = bugs.find((b) => b.id === '1084178');
  assert.ok(first, 'bug 1084178 present');
  assert.equal(first.title, 'import does not sync mod source on UI');
  assert.equal(first.status, 'Being looked at');
  assert.match(first.gameVersion, /1\.6\.1/);
});

test('parseBugsFromHtml: malformed row without title is skipped', () => {
  const html = '<table><tbody>' +
    '<tr data-issue-id="1" class="mod-issue-row"><td class="table-bug-title"></td></tr>' +
    '<tr data-issue-id="2" class="mod-issue-row"><td class="table-bug-title">' +
    '<a class="issue-title" href="#">real bug</a></td></tr>' +
    '</tbody></table>';
  const bugs = parseBugsFromHtml(html);
  assert.equal(bugs.length, 1);
  assert.equal(bugs[0].id, '2');
});

test('parseBugsFromHtml: Cloudflare challenge throws CLOUDFLARE_BLOCKED', () => {
  const cf = '<html><head><title>Just a moment...</title></head><body>cf-chl</body></html>';
  assert.throws(() => parseBugsFromHtml(cf), (e) => e.code === 'CLOUDFLARE_BLOCKED');
});

test('fetchAllBugs: stubbed fetcher returns parsed bugs', async () => {
  setHtmlFetcher(async () => BUGS_HTML);
  try {
    const bugs = await fetchAllBugs();
    assert.equal(bugs.length, 3);
  } finally {
    setHtmlFetcher(null); // reset (matches the pattern used by comment-fetch tests)
  }
});

const BUG_REPLY_HTML = readFileSync('scripts/fixtures/nexus-bug-reply.html', 'utf-8');

test('parseBugReport: extracts reporter + full report body + link + timestamp', () => {
  const r = parseBugReport(BUG_REPLY_HTML);
  assert.equal(r.reporter, 'Lch5423', 'first comment-name is the reporter');
  assert.match(r.body, /reproduce: snapshot json from mac 1\.6\.1/, 'report body present');
  assert.match(r.body, /\(https:\/\/imgur\.com\/a\/r1NZYpt\)/, 'screenshot link preserved as (url)');
  assert.ok(!/Thanks for the bug report/.test(r.body), 'only the FIRST post (report), not the maintainer reply');
  assert.equal(r.createdAt, '2026-05-25T08:43Z');
});

test('parseBugReport: Cloudflare challenge throws CLOUDFLARE_BLOCKED', () => {
  const cf = '<html><head><title>Just a moment...</title></head><body>cf-chl</body></html>';
  assert.throws(() => parseBugReport(cf), (e) => e.code === 'CLOUDFLARE_BLOCKED');
});

test('fetchBugBody: POSTs issue_id and returns parsed report', async () => {
  let captured;
  setHtmlFetcher(async (url, opts) => { captured = { url, opts }; return BUG_REPLY_HTML; });
  try {
    const r = await fetchBugBody('1084178');
    assert.match(captured.url, /ModBugReplyList$/);
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.data, 'issue_id=1084178');
    assert.equal(r.reporter, 'Lch5423');
  } finally {
    setHtmlFetcher(null);
  }
});

// ---------------------------------------------------------------------------
// discoverThreadId tests
// ---------------------------------------------------------------------------

import { discoverThreadId } from './nexus-triage.mjs';

test('discoverThreadId: extracts thread_id from JSON-like embedded script', async () => {
  const html = `
    <html><body>
    <script>var config = {"thread_id":"16873160","mod_id":"856"};</script>
    </body></html>
  `;
  setHtmlFetcher(async () => html);
  try {
    const threadId = await discoverThreadId();
    assert.equal(threadId, '16873160');
  } finally {
    setHtmlFetcher(null);
  }
});

test('discoverThreadId: extracts thread_id from numeric JSON form', async () => {
  const html = `<script>nexus.config = {"thread_id":99887766,"game_id":8916};</script>`;
  setHtmlFetcher(async () => html);
  try {
    const threadId = await discoverThreadId();
    assert.equal(threadId, '99887766');
  } finally {
    setHtmlFetcher(null);
  }
});

test('discoverThreadId: throws if no thread_id found', async () => {
  const html = `<html><body><p>No thread id here</p></body></html>`;
  setHtmlFetcher(async () => html);
  try {
    await assert.rejects(
      () => discoverThreadId(),
      /could not find thread_id/,
      'should throw when thread_id not present'
    );
  } finally {
    setHtmlFetcher(null);
  }
});

// ---------------------------------------------------------------------------
// Orchestrator integration tests (use setHtmlFetcher for Nexus, setGhInvoker for GitHub)
// ---------------------------------------------------------------------------

import { main, setGhInvoker } from './nexus-triage.mjs';

// Helper: reset fetchers after each test
function resetFetchers() {
  setHtmlFetcher(null);
  setGhInvoker(async () => { throw new Error('gh not stubbed; tests must call setGhInvoker'); });
}

// Build HTML with specific authors for the maintainer test
function makeMaintainerHtml() {
  return `
    <li id="comment-500001" class="comment">
      <span class="comment-name">xxskullmikexx</span>
      <div id="comment-content-500001">reply from maintainer about something</div>
      <time data-date="1748217600"></time>
    </li>
    <li id="comment-500002" class="comment">
      <span class="comment-name">Sky2Fly</span>
      <div id="comment-content-500002">co-maintainer note</div>
      <time data-date="1748217601"></time>
    </li>
    <li id="comment-500003" class="comment">
      <span class="comment-name">XXSkullMikeXX</span>
      <div id="comment-content-500003">another maintainer comment</div>
      <time data-date="1748217602"></time>
    </li>
  `;
}

test('main: maintainer comments are skipped before classification', async () => {
  setHtmlFetcher(async () => makeMaintainerHtml());
  const ghCalls = [];
  setGhInvoker(async (args) => { ghCalls.push(args); return { number: ghCalls.length + 100, url: `https://github.com/x/y/issues/${ghCalls.length + 100}`, stdout: '' }; });
  try {
    const result = await main({ dryRun: true, ghToken: 't', state: { schema_version: 1, last_run_at: '', comments: {}, bugs: {}, kudos_seen: [] }});
    assert.equal(ghCalls.length, 0, 'no issues filed in dry-run');
    assert.equal(result.filed.length, 0, 'no filed in result');
    assert.equal(result.maintainerSkipped, 3, 'all three maintainer comments skipped');
  } finally {
    resetFetchers();
  }
});

test('main: per-run cap caps non-kudos at 5, kudos do not count', async () => {
  const bugHtml = Array.from({ length: 10 }, (_, i) => `
    <li id="comment-${600000 + i}" class="comment">
      <span class="comment-name">User${i}</span>
      <div id="comment-content-${600000 + i}">crash issue number ${i}</div>
      <time data-date="${1748217600 + i}"></time>
    </li>
  `).join('') + Array.from({ length: 3 }, (_, i) => `
    <li id="comment-${800000 + i}" class="comment">
      <span class="comment-name">KudosUser${i}</span>
      <div id="comment-content-${800000 + i}">thanks great mod love it</div>
      <time data-date="${1748221200 + i}"></time>
    </li>
  `).join('');

  setHtmlFetcher(async () => bugHtml);
  const ghCalls = [];
  setGhInvoker(async (args) => { ghCalls.push(args); return { number: ghCalls.length + 100, url: `https://github.com/x/y/issues/${ghCalls.length + 100}`, stdout: '' }; });
  try {
    const result = await main({ dryRun: false, ghToken: 't', state: { schema_version: 1, last_run_at: '', comments: {}, bugs: {}, kudos_seen: [] }});
    assert.equal(ghCalls.length, 5, `cap should be 5, got ${ghCalls.length}`);
    assert.equal(result.kudosSkipped, 3, 'all 3 kudos accounted');
    // Oldest 5 (600000..600004) should file
    const filedIds = result.filed.map((f) => f.nexus_id).sort();
    assert.deepEqual(filedIds, ['600000', '600001', '600002', '600003', '600004']);
  } finally {
    resetFetchers();
  }
});

test('main: already-seen items are skipped silently', async () => {
  const html = `
    <li id="comment-700001" class="comment">
      <span class="comment-name">OldUser</span>
      <div id="comment-content-700001">crash issue old</div>
      <time data-date="1748217600"></time>
    </li>
    <li id="comment-700002" class="comment">
      <span class="comment-name">NewUser</span>
      <div id="comment-content-700002">crash issue new</div>
      <time data-date="1748217660"></time>
    </li>
  `;
  setHtmlFetcher(async () => html);
  const ghCalls = [];
  setGhInvoker(async (args) => { ghCalls.push(args); return { number: 999, url: 'https://github.com/x/y/issues/999', stdout: '' }; });
  try {
    const state = {
      schema_version: 1, last_run_at: '',
      comments: { '700001': { gh_issue_url: 'https://github.com/x/y/issues/45', classification: 'bug', filed_at: '2026-05-24T00:00:00Z' }},
      bugs: {}, kudos_seen: [],
    };
    const result = await main({ dryRun: false, ghToken: 't', state });
    assert.equal(ghCalls.length, 1, `only the new item files, got ${ghCalls.length}`);
    assert.equal(result.filed[0].nexus_id, '700002');
  } finally {
    resetFetchers();
  }
});

// ---------------------------------------------------------------------------
// parseArgs / isDisabled / runFromCli tests
// ---------------------------------------------------------------------------

import { parseArgs, isDisabled, runFromCli } from './nexus-triage.mjs';
import { unlinkSync } from 'node:fs';
import { STATE_PATH, POSTS_THREAD_ID } from './nexus-triage.mjs';

test('parseArgs: defaults', () => {
  assert.deepEqual(parseArgs([]), { dryRun: false, bootstrap: false, discoverThreadId: false, help: false });
});

test('parseArgs: --dry-run', () => {
  assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true, bootstrap: false, discoverThreadId: false, help: false });
});

test('parseArgs: --bootstrap', () => {
  assert.deepEqual(parseArgs(['--bootstrap']), { dryRun: false, bootstrap: true, discoverThreadId: false, help: false });
});

test('parseArgs: --discover-thread-id', () => {
  assert.deepEqual(parseArgs(['--discover-thread-id']), { dryRun: false, bootstrap: false, discoverThreadId: true, help: false });
});

test('parseArgs: --help', () => {
  assert.deepEqual(parseArgs(['--help']), { dryRun: false, bootstrap: false, discoverThreadId: false, help: true });
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

// runFromCli: missing POSTS_THREAD_ID exits 2 for normal run (when env not set at module load)
test('runFromCli: missing NEXUSMODS_POSTS_THREAD_ID exits 2 for normal run', async (t) => {
  // POSTS_THREAD_ID is a module-level constant evaluated at import time.
  // This test only verifies the guard when it's '' (no env set at module load).
  if (!POSTS_THREAD_ID) {
    const origGhToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = 'test-token';
    const exitCalls = [];
    const consoleErrs = [];
    t.mock.method(process, 'exit', (code) => { exitCalls.push(code); throw new Error('exit'); });
    t.mock.method(console, 'error', (m) => { consoleErrs.push(String(m)); });
    try {
      await assert.rejects(() => runFromCli([]), /exit/);
      assert.deepEqual(exitCalls, [2]);
      assert.ok(
        consoleErrs.some((m) => /NEXUSMODS_POSTS_THREAD_ID/i.test(m)),
        `expected error mentioning NEXUSMODS_POSTS_THREAD_ID, got: ${consoleErrs.join(' | ')}`
      );
    } finally {
      if (origGhToken !== undefined) process.env.GITHUB_TOKEN = origGhToken;
      else delete process.env.GITHUB_TOKEN;
    }
  } else {
    // POSTS_THREAD_ID was set at module load time — the guard cannot be tested
    // without re-importing the module with a different env. Skip gracefully.
    console.warn('Skipping POSTS_THREAD_ID guard test: NEXUSMODS_POSTS_THREAD_ID was set at module load');
  }
});
