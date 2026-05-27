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
export const CURL_IMPERSONATE_BIN = process.env.CURL_IMPERSONATE_BIN || 'curl_chrome116';

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
const KUDOS_WORD_RE = /\b(thanks|great|love|awesome|amazing|nice work|good job)\b/i;

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

let htmlFetcher = async (url, opts = {}) => {
  const bin = CURL_IMPERSONATE_BIN;
  const args = ['-sS', '--fail-with-body', url];
  for (const [k, v] of Object.entries(opts.headers || {})) {
    args.push('-H', `${k}: ${v}`);
  }
  const { stdout } = await execFileP(bin, args);
  return stdout;
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

// Matches a single comment <li> block.
// Captured groups: [1] id, [2] everything inside the <li>
const LI_COMMENT_RE = /<li\s[^>]*\bid="comment-(\d+)"[^>]*\bclass="[^"]*\bcomment\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;

// Alternatively id before class order
const LI_COMMENT_RE2 = /<li\s[^>]*\bclass="[^"]*\bcomment\b[^"]*"[^>]*\bid="comment-(\d+)"[^>]*>([\s\S]*?)<\/li>/gi;

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
    throw new Error('Cloudflare blocked the request — curl-impersonate may need updating');
  }

  const comments = [];

  // Try both attribute orderings (id-first or class-first)
  function runRe(re) {
    let m;
    while ((m = re.exec(html)) !== null) {
      const id = m[1];
      const liBody = m[2];

      // Extract author
      const authorM = AUTHOR_RE.exec(liBody);
      const author = authorM ? stripTags(authorM[1]).trim() : '<unknown>';

      // Extract body
      const bodyM = buildBodyRe(id).exec(liBody);
      if (!bodyM) {
        // Body div missing — skip this comment per spec (malformed)
        continue;
      }
      const body = stripTags(bodyM[1]).replace(/\s+/g, ' ').trim();
      if (!body) continue; // skip empty bodies

      // Extract timestamp
      const timeM = TIME_RE.exec(liBody);
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
  }

  runRe(LI_COMMENT_RE);
  // If the class comes before id in the HTML, we need the second pattern.
  // Collect ids already found to avoid duplicates.
  const foundIds = new Set(comments.map((c) => c.id));

  let m2;
  while ((m2 = LI_COMMENT_RE2.exec(html)) !== null) {
    if (foundIds.has(m2[1])) continue;
    const id = m2[1];
    const liBody = m2[2];

    const authorM = AUTHOR_RE.exec(liBody);
    const author = authorM ? stripTags(authorM[1]).trim() : '<unknown>';

    const bodyM = buildBodyRe(id).exec(liBody);
    if (!bodyM) continue;
    const body = stripTags(bodyM[1]).replace(/\s+/g, ' ').trim();
    if (!body) continue;

    const timeM = TIME_RE.exec(liBody);
    const createdAt = timeM ? unixToIso(timeM[1]) : '';

    comments.push({ id, author, body, createdAt, parentId: null,
      nexus_url: buildNexusPostUrl(postsUrl, id) });
    foundIds.add(id);
  }

  return comments;
}

// ---------------------------------------------------------------------------
// fetchCommentsHtml — single page fetch via htmlFetcher
// ---------------------------------------------------------------------------

export async function fetchCommentsHtml({ page = 1, pageSize = PAGE_SIZE, threadId = POSTS_THREAD_ID } = {}) {
  const url = buildWidgetUrl({ page, pageSize, threadId });
  const html = await htmlFetcher(url, {
    headers: {
      'Referer': POSTS_URL,
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'sts2-mod-manager nexus-triage automation',
    },
  });
  if (isCloudflareChallenge(html)) {
    throw new Error('Cloudflare blocked the request — curl-impersonate may need updating');
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
  const html = await htmlFetcher(postsUrl, {
    headers: {
      'User-Agent': 'sts2-mod-manager nexus-triage automation',
    },
  });
  if (isCloudflareChallenge(html)) {
    throw new Error('Cloudflare blocked thread_id discovery — curl-impersonate may need updating');
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

const SKIP_BUG_STATUSES = new Set(['closed', 'duplicate', 'not-a-bug']);

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

  const commentNodes = await fetchAllComments();
  const comments = commentNodes.map(commentToItem);

  // 1. Maintainer filter — case-insensitive — FIRST
  const nonMaintainerComments = comments.filter((c) => {
    if (isMaintainer(c.author)) { result.maintainerSkipped++; return false; }
    return true;
  });

  // 2. Dedup against state
  const unseenComments = nonMaintainerComments.filter((c) => {
    if (state.comments[c.id]) { result.alreadySeen++; return false; }
    if (state.kudos_seen.includes(c.id)) { result.alreadySeen++; return false; }
    return true;
  });

  // 3. Classify all unseen items, sorted oldest-first by createdAt
  const items = unseenComments.slice().sort(
    (a, b) => new Date(a.createdAt) - new Date(b.createdAt)
  );

  let filedThisRun = 0;
  const newKudos = [];
  const template = readFileSync(templatePath, 'utf-8');
  for (const item of items) {
    const cls = classify(item.body, item.kind);
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
    const title = `[Nexus] ${sanitizeTitle(item.body || item.title || '')}`;
    const label = `nexus-triage,${cls.classification}`;
    let filedIssue = { number: -1, url: '<dry-run>' };
    if (!dryRun) {
      filedIssue = await ghInvoker(['issue', 'create', '--title', title, '--label', label, '--body', body]);
    } else {
      console.log(`[dry-run] Would file: ${title}`);
      console.log(`[dry-run] Labels:    ${label}`);
      console.log(`[dry-run] Body excerpt: ${body.slice(0, 200)}...`);
    }
    result.filed.push({
      kind: item.kind, nexus_id: item.id,
      gh_issue_url: filedIssue.url,
      classification: cls.classification,
    });
    filedThisRun++;
  }

  // 4. Update state (in memory; caller persists)
  if (!dryRun) {
    for (const f of result.filed) {
      state.comments[f.nexus_id] = {
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
  CURL_IMPERSONATE_BIN        Defaults to curl_chrome116
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
    const fresh = { schema_version: STATE_SCHEMA_VERSION, last_run_at: new Date().toISOString(),
                    comments: {}, bugs: {}, kudos_seen: [] };
    const commentNodes = await fetchAllComments();
    for (const c of commentNodes) {
      fresh.kudos_seen.push(String(c.id));
    }
    saveState(STATE_PATH, fresh);
    console.log(`nexus-triage: bootstrap complete. Marked ${commentNodes.length} comments as seen.`);
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
    console.error(`nexus-triage: fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}
