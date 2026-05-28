// scripts/nexus-triage.mjs
// Nexus -> GitHub triage orchestrator. Hourly cron in CI fetches new Nexus
// comments on mod 856, classifies each, files GitHub issues with an @claude
// investigation prompt for non-kudos items.
//
// Spec: docs/superpowers/specs/2026-05-26-nexus-github-triage-design.md
// Addendum 2026-05-27: pivoted from GraphQL to HTML widget scraping.
//
// Credit: HTML scraping approach adapted from jadistanbelly/sts2-multiplayer-save-slots
// (MIT-licensed). Our Node port is independent code but adopts their endpoint
// URL pattern, query params, HTML selectors, and curl-impersonate insight.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GAME_DOMAIN = 'slaythespire2';
export const MOD_ID = 856; // numeric, for URL helpers
export const MAINTAINER_HANDLES = ['xxskullmikexx', 'Sky2Fly'];
export const PER_RUN_CAP = 5;
export const KUDOS_MAX_CHARS = 80;
export const STATE_PATH = 'scripts/nexus-triage-state.json';
export const TEMPLATE_PATH = 'scripts/nexus-triage-prompt.md';
export const SENTINEL_PATH = 'scripts/nexus-triage.disabled';
export const STATE_SCHEMA_VERSION = 1;

// HTML widget scraping config — populated from repo vars at CI time.
// All have sensible defaults so local testing works without env setup.
export const WIDGET_BASE_URL = process.env.NEXUSMODS_ORIGIN || 'https://www.nexusmods.com';
export const GAME_ID = process.env.NEXUSMODS_GAME_ID || '8916';       // STS2 internal game id
export const MOD_ID_STR = process.env.NEXUSMODS_MOD_ID || '856';      // string form for query params
export const OBJECT_TYPE = process.env.NEXUSMODS_OBJECT_TYPE || '1';
export const POSTS_THREAD_ID = process.env.NEXUSMODS_POSTS_THREAD_ID || ''; // '' = must be discovered
export const POSTS_URL = process.env.NEXUSMODS_POSTS_URL ||
  `https://www.nexusmods.com/${GAME_DOMAIN}/mods/${MOD_ID_STR}?tab=posts`;
export const PAGE_SIZE = 10;
export const MAX_PAGES = 20;
// Python shim impersonate versions — tried in order on Cloudflare retries.
// The env var NEXUSMODS_CURL_IMPERSONATE overrides the default per-attempt value.
export const CURL_IMPERSONATES = ['chrome136', 'chrome120', 'chrome131', 'chrome116', 'chrome110'];

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

export function loadState(path) {
  if (!existsSync(path)) {
    console.error(
      `nexus-triage: state file not found at ${path}. ` +
      `Run \`node scripts/nexus-triage.mjs --bootstrap\` first to seed it.`
    );
    process.exit(2);
  }
  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    console.error(`nexus-triage: cannot read state file ${path}: ${err.message}`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`nexus-triage: state file ${path} is not valid JSON: ${err.message}`);
    process.exit(2);
  }
  if (parsed.schema_version !== STATE_SCHEMA_VERSION) {
    console.error(
      `nexus-triage: state file ${path} has schema_version ${parsed.schema_version}, ` +
      `expected ${STATE_SCHEMA_VERSION}. Manual migration required.`
    );
    process.exit(2);
  }
  return parsed;
}

export function saveState(path, state) {
  const out = JSON.stringify(state, null, 2) + '\n';
  writeFileSync(path, out, 'utf-8');
}

// ---------------------------------------------------------------------------
// Title sanitizer
// ---------------------------------------------------------------------------

const MAX_TITLE_CHARS = 60;

export function sanitizeTitle(body) {
  if (!body) return '';
  let s = String(body);
  // Strip HTML tags but keep their text content
  s = s.replace(/<[^>]*>/g, '');
  // Strip backticks
  s = s.replace(/`/g, '');
  // Strip @mentions (@ followed by word chars, including multiple @ symbols)
  s = s.replace(/@+\w+|@+/g, '');
  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length <= MAX_TITLE_CHARS) return s;
  // Truncate at last word boundary at or before MAX_TITLE_CHARS
  const cutoff = s.lastIndexOf(' ', MAX_TITLE_CHARS);
  if (cutoff < 0) return s.slice(0, MAX_TITLE_CHARS); // no space found, hard-cut
  return s.slice(0, cutoff);
}

// ---------------------------------------------------------------------------
// Classifier
// ---------------------------------------------------------------------------

const BUG_HIGH_RE = /\b(crash(es|ed|ing)?|error|exception|broken|fails?|won['']?t (start|launch|open|install))\b/i;
const BUG_MED_RE = /\b(bug|doesn['']?t work|not working|glitch)\b/i;
const FEAT_HIGH_RE = /\b(feature request|would be nice|please add|can you add|suggestion)\b/i;
const QUESTION_PREFIX_RE = /\b(how do i|where is|can someone)\b/i;
const QUESTION_MARK_RE = /[?？]/;
const KUDOS_WORD_RE = /\b(thank you|thank u|thankyou|thanks|thx|ty|great|love(d| it| this)?|awesome|amazing|nice work|good job|god bless|appreciate[d]?|legend|kudos|works (great|perfectly|well))\b/i;

export function classify(text, _kind) {
  const body = (text || '').trim();
  if (!body) return { classification: 'needs-triage', confidence: 'low' };

  if (BUG_HIGH_RE.test(body)) return { classification: 'bug', confidence: 'high' };
  if (BUG_MED_RE.test(body)) return { classification: 'bug', confidence: 'medium' };
  if (FEAT_HIGH_RE.test(body)) return { classification: 'feature-request', confidence: 'high' };

  if (QUESTION_PREFIX_RE.test(body)) return { classification: 'question', confidence: 'medium' };
  if (QUESTION_MARK_RE.test(body) && body.length < 200) {
    return { classification: 'question', confidence: 'medium' };
  }

  if (body.length <= KUDOS_MAX_CHARS && KUDOS_WORD_RE.test(body)) {
    return { classification: 'kudos', confidence: 'high' };
  }

  return { classification: 'needs-triage', confidence: 'low' };
}

// ---------------------------------------------------------------------------
// Issue body renderer
// ---------------------------------------------------------------------------

export function renderIssueBody(item, template, { classification, confidence }) {
  const titleLine = item.title ? `**Title:** ${item.title}\n` : '';
  const gameVersionLine = item.gameVersion ? `**Game version:** ${item.gameVersion}\n` : '';
  const statusLine = item.status ? `**Nexus bug status:** ${item.status}\n` : '';

  const subs = {
    '{TITLE_LINE}': titleLine,
    '{GAMEVERSION_LINE}': gameVersionLine,
    '{STATUS_LINE}': statusLine,
    '{kind}': item.kind,
    '{author}': item.author,
    '{authorId}': item.authorId,
    '{createdAt}': item.createdAt,
    '{body}': item.body,
    '{classification}': classification,
    '{confidence}': confidence,
    '{nexus_url}': item.nexus_url,
    '{id}': item.id,
    '{timestamp_iso8601_utc}': new Date().toISOString(),
  };
  let out = template;
  for (const [k, v] of Object.entries(subs)) {
    out = out.split(k).join(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// HTML fetcher indirection (replaces httpFetch for the Nexus side)
// ---------------------------------------------------------------------------
// Tests stub htmlFetcher to return canned HTML strings.
// Production default spawns curl-impersonate via execFile.
// The function signature is: (url: string, opts: { headers: Record<string,string> })
//   => Promise<string>  (the raw HTML body)

// Default htmlFetcher: spawns the Python curl_cffi shim (scripts/_nexus_fetch.py).
// Tests stub this via setHtmlFetcher — the fetch path is the only thing that changes.
async function singleFetch(impersonate, url, headers) {
  const headerArgs = [];
  for (const [k, v] of Object.entries(headers || {})) {
    headerArgs.push('--header', `${k}: ${v}`);
  }
  const { stdout, stderr } = await execFileP(
    'python',
    ['scripts/_nexus_fetch.py', url, '--impersonate', impersonate, ...headerArgs],
  );
  // stderr last line: HTTP_STATUS=NNN
  const statusMatch = stderr.match(/HTTP_STATUS=(\d{3})/);
  const httpCode = statusMatch ? statusMatch[1] : '';
  return { httpCode, body: stdout };
}

let htmlFetcher = async (url, opts = {}) => {
  const headers = opts.headers || {};
  // Retry across impersonate versions on Cloudflare challenge.
  for (let attempt = 0; attempt < CURL_IMPERSONATES.length; attempt++) {
    const impersonate = CURL_IMPERSONATES[attempt];
    const { body } = await singleFetch(impersonate, url, headers);
    if (!isCloudflareChallenge(body)) return body;
    // CF challenge — try next impersonate version (or give up on last attempt)
    if (attempt < CURL_IMPERSONATES.length - 1) {
      console.error(`nexus-triage: Cloudflare challenge with ${impersonate}, retrying...`);
    }
  }
  // Return the last body regardless (caller's isCloudflareChallenge will handle it)
  const { body } = await singleFetch(CURL_IMPERSONATES[CURL_IMPERSONATES.length - 1], url, headers);
  return body;
};

export function setHtmlFetcher(fn) { htmlFetcher = fn; }

// ---------------------------------------------------------------------------
// HTTP fetch indirection (retained for generic use / test compat)
// ---------------------------------------------------------------------------

let httpFetch = globalThis.fetch;
export function setHttpFetch(fn) { httpFetch = fn; }

// ---------------------------------------------------------------------------
// gh CLI indirection
// ---------------------------------------------------------------------------

// Like setHtmlFetcher — lets tests stub without spawning a real gh process.
let ghInvoker = async (args) => {
  const { stdout } = await execFileP('gh', args);
  // gh issue create outputs the URL of the created issue on stdout.
  const urlMatch = stdout.match(/https:\/\/[^\s]+\/issues\/(\d+)/);
  if (urlMatch) return { number: parseInt(urlMatch[1], 10), url: urlMatch[0], stdout };
  // Fallback: return raw stdout if it doesn't look like a URL
  return { number: -1, url: stdout.trim(), stdout };
};
export function setGhInvoker(fn) { ghInvoker = fn; }

// ---------------------------------------------------------------------------
// Cloudflare challenge detection
// ---------------------------------------------------------------------------

export function isCloudflareChallenge(html) {
  return html.includes('<title>Just a moment...</title>') || html.includes('cf-chl');
}

// ---------------------------------------------------------------------------
// HTML widget URL builder
// ---------------------------------------------------------------------------

export function buildWidgetUrl({ page = 1, pageSize = PAGE_SIZE, threadId = POSTS_THREAD_ID } = {}) {
  const params = new URLSearchParams({
    tabbed: '1',
    object_id: MOD_ID_STR,
    game_id: GAME_ID,
    object_type: OBJECT_TYPE,
    thread_id: threadId,
    skip_opening_post: '0',
    user_is_blocked: '',
    searchable: 'true',
    page_size: String(pageSize),
    page: String(page),
  });
  return `${WIDGET_BASE_URL}/Core/Libs/Common/Widgets/CommentContainer?${params}`;
}

// ---------------------------------------------------------------------------
// Nexus post URL builder
// ---------------------------------------------------------------------------

export function buildNexusPostUrl(postsUrl, commentId) {
  // E.g. https://www.nexusmods.com/slaythespire2/mods/856?tab=posts&comment_id=12345
  // Strip any existing comment_id param and add our own.
  const u = new URL(postsUrl);
  u.searchParams.set('tab', u.searchParams.get('tab') || 'posts');
  u.searchParams.set('comment_id', String(commentId));
  return u.toString();
}

// ---------------------------------------------------------------------------
// parseCommentsFromHtml — regex-based parser (no extra deps)
// ---------------------------------------------------------------------------
// Regex patterns targeting Nexus CommentContainer widget HTML structure.
// Markup version observed 2026-05-27. Update patterns here if Nexus changes.
//
// Key patterns:
//   Comment root:  <li id="comment-{id}" class="... comment ...">
//   Author:        <span class="comment-name">{author}</span>
//   Body:          <div id="comment-content-{id}">{body}</div>
//   Timestamp:     <time data-date="{unix-seconds}">
//
// We parse the full HTML string, not line by line, because HTML attributes
// may span multiple lines. The s (dotAll) flag is used where needed.

// Matches the OPENING tag of a comment <li>. We don't try to capture the body
// via `[\s\S]*?<\/li>` because each comment contains nested <li> elements (for
// member-status / kudos bullets), and non-greedy matching stops at the first
// nested </li> — which truncates before the comment-content div we want.
// Instead, we find each comment's opening position + id, then bound a per-
// comment slice by the NEXT comment's opening position (or end of HTML).
const LI_COMMENT_OPEN_ID_FIRST = /<li\s[^>]*\bid="comment-(\d+)"[^>]*\bclass="[^"]*\bcomment\b[^"]*"[^>]*>/gi;
const LI_COMMENT_OPEN_CLASS_FIRST = /<li\s[^>]*\bclass="[^"]*\bcomment\b[^"]*"[^>]*\bid="comment-(\d+)"[^>]*>/gi;

// Author: <span class="comment-name">...</span>  (first match in the li body)
const AUTHOR_RE = /<span\s[^>]*\bclass="[^"]*\bcomment-name\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i;

// Body: <div id="comment-content-{id}">...</div>
// We build this per-comment using the known id.
function buildBodyRe(id) {
  return new RegExp(`<div[^>]*\\bid="comment-content-${id}"[^>]*>([\\s\\S]*?)</div>`, 'i');
}

// Timestamp: <time data-date="{unix-seconds}"> (first match in the li body)
const TIME_RE = /<time\s[^>]*\bdata-date="(\d+)"[^>]*>/i;

// Strip HTML tags for text extraction
function stripTags(s) {
  return s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function unixToIso(unixStr) {
  return new Date(parseInt(unixStr, 10) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function parseCommentsFromHtml(html, { postsUrl = POSTS_URL } = {}) {
  if (isCloudflareChallenge(html)) {
    const err = new Error('Cloudflare blocked the request — curl-impersonate may need updating');
    err.code = 'CLOUDFLARE_BLOCKED';
    throw err;
  }

  // Step 1: find every comment opening tag — record {id, startIndex} for each.
  // We try both attribute orderings (id-first, class-first) and dedupe by id.
  const opens = []; // [{ id, startIndex }, ...]
  const seenIds = new Set();
  function scan(re) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const id = m[1];
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      opens.push({ id, startIndex: m.index });
    }
  }
  scan(LI_COMMENT_OPEN_ID_FIRST);
  scan(LI_COMMENT_OPEN_CLASS_FIRST);

  // Order opens by position in the document.
  opens.sort((a, b) => a.startIndex - b.startIndex);

  // Step 2: for each open, slice from its start to the NEXT open's start
  // (or end of html). That slice is guaranteed to contain this comment's
  // body div, author span, and timestamp — without straying into the next
  // comment, and without being truncated by nested <li> tags.
  const comments = [];
  for (let i = 0; i < opens.length; i++) {
    const { id, startIndex } = opens[i];
    const endIndex = i + 1 < opens.length ? opens[i + 1].startIndex : html.length;
    const slice = html.slice(startIndex, endIndex);

    const authorM = AUTHOR_RE.exec(slice);
    const author = authorM ? stripTags(authorM[1]).trim() : '<unknown>';

    const bodyM = buildBodyRe(id).exec(slice);
    if (!bodyM) continue; // body div missing — skip per spec (malformed)
    const body = stripTags(bodyM[1]).replace(/\s+/g, ' ').trim();
    if (!body) continue; // skip empty bodies

    const timeM = TIME_RE.exec(slice);
    const createdAt = timeM ? unixToIso(timeM[1]) : '';

    comments.push({
      id,
      author,
      body,
      createdAt,
      parentId: null, // parent tracking not critical for first pass
      nexus_url: buildNexusPostUrl(postsUrl, id),
    });
  }

  return comments;
}

// ---------------------------------------------------------------------------
// fetchCommentsHtml — single page fetch via htmlFetcher
// ---------------------------------------------------------------------------

export async function fetchCommentsHtml({ page = 1, pageSize = PAGE_SIZE, threadId = POSTS_THREAD_ID } = {}) {
  const url = buildWidgetUrl({ page, pageSize, threadId });
  // Do NOT send User-Agent — curl_cffi's impersonate=chrome136 sets a
  // native Chrome User-Agent that matches the TLS fingerprint. Overriding
  // it with an "automation" UA causes Cloudflare to flag the mismatch.
  const html = await htmlFetcher(url, {
    headers: {
      'Referer': POSTS_URL,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  if (isCloudflareChallenge(html)) {
    const err = new Error('Cloudflare blocked the request — curl-impersonate may need updating');
    err.code = 'CLOUDFLARE_BLOCKED';
    throw err;
  }
  return html;
}

// ---------------------------------------------------------------------------
// fetchAllComments — pagination loop
// ---------------------------------------------------------------------------

export async function fetchAllComments({ threadId = POSTS_THREAD_ID } = {}) {
  const seenIds = new Set();
  const allComments = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const html = await fetchCommentsHtml({ page, pageSize: PAGE_SIZE, threadId });
    const pageComments = parseCommentsFromHtml(html);
    const newComments = pageComments.filter((c) => !seenIds.has(c.id));

    if (newComments.length === 0) break; // no new IDs — stop pagination

    for (const c of newComments) {
      seenIds.add(c.id);
      allComments.push(c);
    }

    // If this page had fewer results than page size, we're on the last page
    if (pageComments.length < PAGE_SIZE) break;
  }

  return allComments;
}

// ---------------------------------------------------------------------------
// discoverThreadId — extracts thread_id from mod posts page HTML
// ---------------------------------------------------------------------------

export async function discoverThreadId({ postsUrl = POSTS_URL } = {}) {
  // Pass an empty headers map so curl_cffi sends its native Chrome UA +
  // header set. Overriding User-Agent breaks the TLS impersonation.
  const html = await htmlFetcher(postsUrl, { headers: {} });
  if (isCloudflareChallenge(html)) {
    const err = new Error('Cloudflare blocked thread_id discovery — curl-impersonate may need updating');
    err.code = 'CLOUDFLARE_BLOCKED';
    throw err;
  }
  // Look for patterns like: "thread_id":"16873160" or thread_id=16873160 in embedded JS
  const patterns = [
    /"thread_id"\s*:\s*"(\d+)"/,
    /"thread_id"\s*:\s*(\d+)/,
    /thread_id=(\d+)/,
    /\bthread_id\b['":\s]+(\d+)/,
  ];
  for (const re of patterns) {
    const m = re.exec(html);
    if (m) return m[1];
  }
  throw new Error(
    `nexus-triage: could not find thread_id in posts page HTML (${postsUrl}). ` +
    `Check the page source manually and update NEXUSMODS_POSTS_THREAD_ID.`
  );
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const NEXUS_COMMENT_URL = (id) =>
  buildNexusPostUrl(POSTS_URL, id);

const NEXUS_BUG_URL = (id) =>
  `${WIDGET_BASE_URL}/${GAME_DOMAIN}/mods/${MOD_ID_STR}?tab=bugs&issue_id=${id}`;

// Nexus bug statuses that mean "already handled" — skip on first sight.
// Matched case-insensitively as substrings against the row's status text.
const SKIP_BUG_STATUS_SUBSTRINGS = ['not a bug', 'duplicate', 'fixed', 'closed', 'wont fix', "won't fix", 'wontfix'];

// ---------------------------------------------------------------------------
// Bugs tab — ModBugsTab widget (table layout, distinct from the comments widget)
// ---------------------------------------------------------------------------

export function buildBugsWidgetUrl() {
  const params = new URLSearchParams({ id: MOD_ID_STR, game_id: GAME_ID }).toString();
  return `${WIDGET_BASE_URL}/Core/Libs/Common/Widgets/ModBugsTab?${params}`;
}

// Each bug is a <tr ... data-issue-id="N" class="mod-issue-row"> ... </tr>.
// Bug rows do NOT nest <tr>, so a non-greedy [\s\S]*?</tr> capture is safe.
const BUG_ROW_RE = /<tr\s[^>]*\bdata-issue-id="(\d+)"[^>]*\bclass="[^"]*\bmod-issue-row\b[^"]*"[^>]*>([\s\S]*?)<\/tr>/gi;
const BUG_TITLE_RE = /<a\s[^>]*\bclass="[^"]*\bissue-title\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i;
const BUG_STATUS_RE = /<span\s[^>]*\bclass="[^"]*\binline-status\b[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<\/span>/i;
const BUG_VERSION_RE = /Version:\s*<i>([\s\S]*?)<\/i>/i;

export function parseBugsFromHtml(html) {
  if (isCloudflareChallenge(html)) {
    const err = new Error('Cloudflare blocked the bugs request — curl-impersonate may need updating');
    err.code = 'CLOUDFLARE_BLOCKED';
    throw err;
  }
  const bugs = [];
  let m;
  BUG_ROW_RE.lastIndex = 0;
  while ((m = BUG_ROW_RE.exec(html)) !== null) {
    const id = m[1];
    const row = m[2];

    const titleM = BUG_TITLE_RE.exec(row);
    const title = titleM ? stripTags(titleM[1]).replace(/\s+/g, ' ').trim() : '';
    if (!title) continue; // malformed row — skip

    const statusM = BUG_STATUS_RE.exec(row);
    const status = statusM ? stripTags(statusM[1]).replace(/\s+/g, ' ').trim() : '';

    const versionM = BUG_VERSION_RE.exec(row);
    const gameVersion = versionM ? stripTags(versionM[1]).replace(/\s+/g, ' ').trim() : '';

    bugs.push({ id, title, status, gameVersion });
  }
  return bugs;
}

export async function fetchAllBugs() {
  const url = buildBugsWidgetUrl();
  const html = await htmlFetcher(url, {
    headers: {
      'Referer': `${WIDGET_BASE_URL}/${GAME_DOMAIN}/mods/${MOD_ID_STR}?tab=bugs`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });
  return parseBugsFromHtml(html);
}

function bugToItem(b) {
  return {
    kind: 'bug',
    id: String(b.id),
    title: b.title,
    // The bug table doesn't expose the full description (it loads lazily via
    // loadIssueReplies). The title is descriptive enough for triage; @claude
    // investigates the codebase + the maintainer opens the Nexus link for detail.
    body: b.title,
    status: b.status,
    gameVersion: b.gameVersion,
    createdAt: '', // not reliably parseable from the row; bugs sort after comments
    author: '<nexus-bug-reporter>',
    authorId: '',
    nexus_url: NEXUS_BUG_URL(b.id),
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isMaintainer(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return MAINTAINER_HANDLES.some((h) => h.toLowerCase() === lower);
}

function commentToItem(c) {
  return {
    kind: 'comment',
    id: String(c.id),
    body: c.body ?? '',
    createdAt: c.createdAt,
    author: c.author ?? '<unknown>',
    authorId: '', // Nexus widget HTML does not expose memberId in a stable way
    nexus_url: c.nexus_url || NEXUS_COMMENT_URL(c.id),
  };
}

// ---------------------------------------------------------------------------
// main orchestrator
// ---------------------------------------------------------------------------

export async function main({ dryRun, ghToken, state, templatePath = TEMPLATE_PATH }) {
  const result = {
    maintainerSkipped: 0,
    alreadySeen: 0,
    kudosSkipped: 0,
    filed: [],
    pendingNextRun: 0,
  };

  result.bugStatusSkipped = 0;

  // ── Comments ──────────────────────────────────────────────────────────
  const comments = (await fetchAllComments()).map(commentToItem);

  // Maintainer filter — case-insensitive — FIRST (comments only; bug-tracker
  // reports are inherently external so we don't maintainer-filter them).
  const nonMaintainerComments = comments.filter((c) => {
    if (isMaintainer(c.author)) { result.maintainerSkipped++; return false; }
    return true;
  });

  // Dedup against state
  const unseenComments = nonMaintainerComments.filter((c) => {
    if (state.comments[c.id]) { result.alreadySeen++; return false; }
    if (state.kudos_seen.includes(c.id)) { result.alreadySeen++; return false; }
    return true;
  });

  // ── Bugs ──────────────────────────────────────────────────────────────
  let bugs = [];
  try {
    bugs = (await fetchAllBugs()).map(bugToItem);
  } catch (err) {
    if (err.code === 'CLOUDFLARE_BLOCKED') throw err;
    // A bugs-tab parse failure shouldn't sink the whole run — comments still
    // triage. Log + continue with zero bugs.
    console.error(`nexus-triage: bug fetch/parse failed (continuing with comments only): ${err.message}`);
  }

  const unseenBugs = bugs.filter((b) => {
    if (state.bugs[b.id]) { result.alreadySeen++; return false; }
    const statusLower = (b.status || '').toLowerCase();
    if (SKIP_BUG_STATUS_SUBSTRINGS.some((s) => statusLower.includes(s))) {
      result.bugStatusSkipped++;
      return false;
    }
    return true;
  });

  // ── Unified filing pipeline ─────────────────────────────────────────────
  // Comments sort oldest-first by createdAt; bugs (no reliable createdAt)
  // append after. Each item carries its own classification: comments run the
  // heuristic classifier; bugs are bugs by definition.
  const commentItems = unseenComments.slice().sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );
  const items = [...commentItems, ...unseenBugs];

  let filedThisRun = 0;
  const newKudos = [];
  const template = readFileSync(templatePath, 'utf-8');
  for (const item of items) {
    const cls = item.kind === 'bug'
      ? { classification: 'bug', confidence: 'high' }
      : classify(item.body, item.kind);
    if (cls.classification === 'kudos') {
      result.kudosSkipped++;
      newKudos.push(item.id);
      continue;
    }
    if (filedThisRun >= PER_RUN_CAP) {
      result.pendingNextRun++;
      continue;
    }
    const body = renderIssueBody(item, template, cls);
    const title = `[Nexus] ${sanitizeTitle(item.title || item.body || '')}`;
    const label = `nexus-triage,${cls.classification}`;
    let filedIssue = { number: -1, url: '<dry-run>' };
    if (!dryRun) {
      filedIssue = await ghInvoker(['issue', 'create', '--title', title, '--label', label, '--body', body]);
    } else {
      console.log(`[dry-run] Would file (${item.kind}): ${title}`);
      console.log(`[dry-run] Labels:    ${label}`);
    }
    result.filed.push({
      kind: item.kind, nexus_id: item.id,
      gh_issue_url: filedIssue.url,
      classification: cls.classification,
    });
    filedThisRun++;
  }

  // ── Persist state (in memory; caller writes to disk) ────────────────────
  if (!dryRun) {
    for (const f of result.filed) {
      const bucket = f.kind === 'bug' ? state.bugs : state.comments;
      bucket[f.nexus_id] = {
        gh_issue_url: f.gh_issue_url,
        classification: f.classification,
        filed_at: new Date().toISOString(),
      };
    }
    for (const id of newKudos) state.kudos_seen.push(id);
    state.last_run_at = new Date().toISOString();
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url';

export function parseArgs(argv) {
  const opts = { dryRun: false, bootstrap: false, discoverThreadId: false, help: false };
  for (const a of argv) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--bootstrap') opts.bootstrap = true;
    else if (a === '--discover-thread-id') opts.discoverThreadId = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else {
      console.error(`nexus-triage: unknown argument '${a}'. Use --help for usage.`);
      process.exit(2);
    }
  }
  return opts;
}

export function isDisabled(path = SENTINEL_PATH) {
  return existsSync(path);
}

const HELP_TEXT = `
nexus-triage — Nexus -> GitHub issue triage

Usage:
  node scripts/nexus-triage.mjs                    # normal run (requires GITHUB_TOKEN + NEXUSMODS_* vars)
  node scripts/nexus-triage.mjs --dry-run          # print what would file, no gh calls, no state write
  node scripts/nexus-triage.mjs --bootstrap        # mark all current Nexus comments as seen, do not file
  node scripts/nexus-triage.mjs --discover-thread-id  # print the posts thread_id and exit
  node scripts/nexus-triage.mjs --help             # this message

Environment (set as repo vars in CI, or locally in your shell):
  NEXUSMODS_POSTS_THREAD_ID   Required for normal runs. Discover with --discover-thread-id.
  NEXUSMODS_GAME_ID           Defaults to 8916 (STS2)
  NEXUSMODS_MOD_ID            Defaults to 856
  NEXUSMODS_OBJECT_TYPE       Defaults to 1
  NEXUSMODS_POSTS_URL         Defaults to https://www.nexusmods.com/slaythespire2/mods/856?tab=posts
  NEXUSMODS_ORIGIN            Defaults to https://www.nexusmods.com
  NEXUSMODS_CURL_IMPERSONATE  curl_cffi impersonate target for the Python shim (default: chrome136)
  GITHUB_TOKEN                GitHub PAT or Actions-provided token

Note: NEXUS_API_KEY is NOT required for triage (it's only needed for publish-nexus upload).

Killswitch:
  touch scripts/nexus-triage.disabled             # next run exits 0 with no work
`.trim();

export async function runFromCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(HELP_TEXT);
    return 0;
  }
  if (isDisabled()) {
    console.log('nexus-triage: scripts/nexus-triage.disabled sentinel present; exiting 0.');
    return 0;
  }

  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) {
    console.error('nexus-triage: GITHUB_TOKEN is not set.');
    process.exit(2);
  }

  // --discover-thread-id mode: fetch the posts page, print the thread_id, exit.
  if (opts.discoverThreadId) {
    const threadId = await discoverThreadId();
    console.log(threadId);
    console.log(`\nTo store it:\n  gh variable set NEXUSMODS_POSTS_THREAD_ID --body ${threadId}`);
    return 0;
  }

  // For normal runs, POSTS_THREAD_ID must be set.
  if (!POSTS_THREAD_ID) {
    console.error(
      'nexus-triage: NEXUSMODS_POSTS_THREAD_ID is not set.\n' +
      'Run `node scripts/nexus-triage.mjs --discover-thread-id` locally to find it, ' +
      'then set it as a repo var:\n' +
      '  gh variable set NEXUSMODS_POSTS_THREAD_ID --body <value>'
    );
    process.exit(2);
  }

  if (opts.bootstrap) {
    const now = new Date().toISOString();
    const fresh = { schema_version: STATE_SCHEMA_VERSION, last_run_at: now,
                    comments: {}, bugs: {}, kudos_seen: [] };
    const commentNodes = await fetchAllComments();
    for (const c of commentNodes) {
      fresh.kudos_seen.push(String(c.id));
    }
    let bugNodes = [];
    try {
      bugNodes = await fetchAllBugs();
    } catch (err) {
      console.error(`nexus-triage: bug fetch during bootstrap failed (seeding comments only): ${err.message}`);
    }
    for (const b of bugNodes) {
      fresh.bugs[String(b.id)] = { gh_issue_url: '<bootstrap-seed>', classification: 'bootstrap-seed', filed_at: now };
    }
    saveState(STATE_PATH, fresh);
    console.log(`nexus-triage: bootstrap complete. Marked ${commentNodes.length} comments + ${bugNodes.length} bugs as seen.`);
    return 0;
  }

  const state = loadState(STATE_PATH);
  const result = await main({ dryRun: opts.dryRun, ghToken, state });

  if (!opts.dryRun) saveState(STATE_PATH, state);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

// Only run main when invoked as `node scripts/nexus-triage.mjs ...`
// (not when imported from tests).
const isMainModule = fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  runFromCli().catch((err) => {
    if (err.code === 'CLOUDFLARE_BLOCKED') {
      console.error(`nexus-triage: Cloudflare blocked all retries this run. Will try again on next cron.`);
      console.error(`Details: ${err.message}`);
      process.exit(0);
    }
    console.error(`nexus-triage: fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
