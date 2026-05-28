// scripts/nexus-triage.mjs
// Nexus -> GitHub triage orchestrator. Hourly cron in CI fetches new Nexus
// comments on mod 856 via GraphQL, classifies each, files GitHub issues with
// an @claude investigation prompt for non-kudos items.
//
// Spec: docs/superpowers/specs/2026-05-26-nexus-github-triage-design.md
// Addendum 2026-05-27: pivoted from HTML widget scraping to GraphQL
//   commentThread(commentThreadId) query on api.nexusmods.com/v2/graphql.

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

// GraphQL config
export const NEXUS_GRAPHQL_URL = 'https://api.nexusmods.com/v2/graphql';
export const POSTS_THREAD_ID = process.env.NEXUSMODS_POSTS_THREAD_ID || '16866026';
export const MOD_ID_STR = process.env.NEXUSMODS_MOD_ID || '856';
export const POSTS_URL = process.env.NEXUSMODS_POSTS_URL ||
  `https://www.nexusmods.com/${GAME_DOMAIN}/mods/${MOD_ID_STR}?tab=posts`;
export const MAX_PAGES = 20;

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
// HTTP fetch indirection — tests stub via setHttpFetch
// ---------------------------------------------------------------------------

let httpFetch = globalThis.fetch;
export function setHttpFetch(fn) { httpFetch = fn; }

// ---------------------------------------------------------------------------
// gh CLI indirection
// ---------------------------------------------------------------------------

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
// GraphQL helpers
// ---------------------------------------------------------------------------

const MOD_COMMENTS_QUERY = `
query ModComments($threadId: ID!, $first: Int!, $after: String) {
  commentThread(commentThreadId: $threadId) {
    id
    comments(first: $first, after: $after, sortBy: "createdAt", sortDirection: "DESC") {
      nodes {
        id
        body
        createdAt
        discardedAt
        hiddenAt
        creator { name memberId }
      }
      pageInfo { hasNextPage endCursor }
      totalCount
    }
  }
}
`.trim();

export async function graphqlPost({ apiKey, query, variables }) {
  const res = await httpFetch(NEXUS_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    console.error(`nexus-triage: GraphQL HTTP error ${res.status} ${res.statusText}`);
    process.exit(1);
  }

  const json = await res.json();
  if (json.errors && json.errors.length > 0) {
    console.error(`nexus-triage: GraphQL errors: ${JSON.stringify(json.errors)}`);
    process.exit(1);
  }

  return json;
}

export async function fetchComments({ apiKey, threadId, first = 100, after }) {
  const variables = { threadId, first, ...(after ? { after } : {}) };
  const json = await graphqlPost({ apiKey, query: MOD_COMMENTS_QUERY, variables });
  const comments = json.data?.commentThread?.comments;
  if (!comments) {
    console.error('nexus-triage: unexpected GraphQL response shape — commentThread.comments missing');
    process.exit(1);
  }
  return comments; // { nodes, pageInfo, totalCount }
}

export async function fetchAllComments({ apiKey, threadId = POSTS_THREAD_ID }) {
  const allNodes = [];
  let after = undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const connection = await fetchComments({ apiKey, threadId, first: 100, after });
    const { nodes, pageInfo } = connection;
    allNodes.push(...(nodes || []));

    if (!pageInfo.hasNextPage) break;
    after = pageInfo.endCursor;
  }

  return allNodes;
}

// ---------------------------------------------------------------------------
// Nexus post URL builder
// ---------------------------------------------------------------------------

export function buildNexusCommentUrl(postsUrl, commentId) {
  const u = new URL(postsUrl);
  u.searchParams.set('tab', u.searchParams.get('tab') || 'posts');
  u.searchParams.set('commentid', String(commentId));
  return u.toString();
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
    author: c.creator?.name ?? '<unknown>',
    authorId: String(c.creator?.memberId ?? ''),
    nexus_url: buildNexusCommentUrl(POSTS_URL, c.id),
  };
}

// ---------------------------------------------------------------------------
// main orchestrator
// ---------------------------------------------------------------------------

export async function main({ dryRun, apiKey, ghToken, state, templatePath = TEMPLATE_PATH }) {
  const result = {
    maintainerSkipped: 0,
    alreadySeen: 0,
    kudosSkipped: 0,
    filed: [],
    pendingNextRun: 0,
  };

  const rawNodes = await fetchAllComments({ apiKey });

  // Filter out deleted/hidden comments
  const visibleNodes = rawNodes.filter((c) => !c.discardedAt && !c.hiddenAt);
  const comments = visibleNodes.map(commentToItem);

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
  const opts = { dryRun: false, bootstrap: false, help: false };
  for (const a of argv) {
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--bootstrap') opts.bootstrap = true;
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
  node scripts/nexus-triage.mjs                    # normal run (requires GITHUB_TOKEN + NEXUS_API_KEY)
  node scripts/nexus-triage.mjs --dry-run          # print what would file, no gh calls, no state write
  node scripts/nexus-triage.mjs --bootstrap        # mark all current Nexus comments as seen, do not file
  node scripts/nexus-triage.mjs --help             # this message

Environment (set as secrets/vars in CI, or locally in your shell):
  NEXUS_API_KEY               Required. Nexus personal API key (generate at nexusmods.com/users/myaccount).
  NEXUSMODS_POSTS_THREAD_ID   Thread ID for the mod posts tab (default: 16866026 for mod 856).
  NEXUSMODS_MOD_ID            Defaults to 856
  NEXUSMODS_POSTS_URL         Defaults to https://www.nexusmods.com/slaythespire2/mods/856?tab=posts
  GITHUB_TOKEN                GitHub PAT or Actions-provided token

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

  const apiKey = process.env.NEXUS_API_KEY;
  if (!apiKey) {
    console.error('nexus-triage: NEXUS_API_KEY is not set.');
    process.exit(2);
  }

  if (opts.bootstrap) {
    const fresh = { schema_version: STATE_SCHEMA_VERSION, last_run_at: new Date().toISOString(),
                    comments: {}, bugs: {}, kudos_seen: [] };
    const rawNodes = await fetchAllComments({ apiKey });
    for (const c of rawNodes) {
      fresh.kudos_seen.push(String(c.id));
    }
    saveState(STATE_PATH, fresh);
    console.log(`nexus-triage: bootstrap complete. Marked ${rawNodes.length} comments as seen.`);
    return 0;
  }

  const state = loadState(STATE_PATH);
  const result = await main({ dryRun: opts.dryRun, apiKey, ghToken, state });

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
