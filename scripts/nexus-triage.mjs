// scripts/nexus-triage.mjs
// Nexus -> GitHub triage orchestrator. Hourly cron in CI fetches new Nexus
// comments + open bugs on mod 856, classifies each, files GitHub issues with
// an @claude investigation prompt for non-kudos items.
//
// Spec: docs/superpowers/specs/2026-05-26-nexus-github-triage-design.md

export const NEXUS_GRAPHQL_URL = 'https://api.nexusmods.com/v2/graphql';
export const GAME_DOMAIN = 'slaythespire2';
export const MOD_ID = 856;
export const MAINTAINER_HANDLES = ['xxskullmikexx', 'Sky2Fly'];
export const PER_RUN_CAP = 5;
export const KUDOS_MAX_CHARS = 80;
export const STATE_PATH = 'scripts/nexus-triage-state.json';
export const TEMPLATE_PATH = 'scripts/nexus-triage-prompt.md';
export const SENTINEL_PATH = 'scripts/nexus-triage.disabled';
export const STATE_SCHEMA_VERSION = 1;

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileP = promisify(execFile);

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
// GraphQL client
// ---------------------------------------------------------------------------

// Single indirection point for HTTP calls so tests can stub without
// monkey-patching globalThis.fetch (which leaks across tests).
let httpFetch = globalThis.fetch;
export function setHttpFetch(fn) { httpFetch = fn; }

const COMMENTS_QUERY = `
  query ModComments($gameDomain: String!, $modId: Int!, $first: Int!) {
    mod(domain: $gameDomain, modId: $modId) {
      comments(first: $first, sortBy: createdAt, direction: DESC) {
        nodes {
          id
          body
          createdAt
          creator { name memberId }
        }
      }
    }
  }
`.trim();

const BUGS_QUERY = `
  query ModBugReports($gameDomain: String!, $modId: Int!, $first: Int!, $statusIn: [BugReportStatus!]) {
    mod(domain: $gameDomain, modId: $modId) {
      bugReports(first: $first, sortBy: createdAt, direction: DESC, statusIn: $statusIn) {
        nodes {
          id
          title
          description
          status
          priority
          createdAt
          gameVersion
          reporter { name memberId }
        }
      }
    }
  }
`.trim();

const INTROSPECT_QUERY = `
  query IntrospectMod {
    __type(name: "Mod") { name fields { name type { name } } }
  }
`.trim();

async function graphqlPost({ apiKey, query, variables }) {
  const res = await httpFetch(NEXUS_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    console.error(`nexus-triage: GraphQL POST failed with status ${res.status}`);
    process.exit(1);
  }
  const json = await res.json();
  if (json.errors?.length) {
    console.error(`nexus-triage: GraphQL returned errors: ${JSON.stringify(json.errors)}`);
    process.exit(1);
  }
  return json.data;
}

export async function fetchModComments({ apiKey, first = 100 }) {
  const data = await graphqlPost({
    apiKey,
    query: COMMENTS_QUERY,
    variables: { gameDomain: GAME_DOMAIN, modId: MOD_ID, first },
  });
  return data?.mod?.comments?.nodes ?? [];
}

export async function fetchModBugReports({ apiKey, first = 100 }) {
  const data = await graphqlPost({
    apiKey,
    query: BUGS_QUERY,
    variables: { gameDomain: GAME_DOMAIN, modId: MOD_ID, first, statusIn: ['open'] },
  });
  return data?.mod?.bugReports?.nodes ?? [];
}

export async function introspectSchema({ apiKey }) {
  const data = await graphqlPost({ apiKey, query: INTROSPECT_QUERY, variables: {} });
  const fields = data?.__type?.fields ?? [];
  const fieldNames = new Set(fields.map((f) => f.name));
  const hasComments = fieldNames.has('comments');
  const hasBugReports = fieldNames.has('bugReports');
  if (!hasComments) {
    console.error(
      `nexus-triage: introspection shows Mod.comments is missing. ` +
      `This is a hard schema drift. Update the query in scripts/nexus-triage.mjs.`
    );
    process.exit(2);
  }
  return { hasComments, hasBugReports };
}

// ---------------------------------------------------------------------------
// gh CLI indirection
// ---------------------------------------------------------------------------

// Like setHttpFetch — lets tests stub without spawning a real gh process.
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
// Schema-gap operator notification
// ---------------------------------------------------------------------------

// Files a one-time ops:nexus-schema-gap issue when mod.bugReports is absent.
// Idempotent: checks for an existing open issue first to avoid duplicates.
// Both the list and create calls route through ghInvoker so tests can stub them.
export async function ensureSchemaGapIssue() {
  // 1. Check for an existing open issue with the label.
  const listResult = await ghInvoker([
    'issue', 'list',
    '--label', 'ops:nexus-schema-gap',
    '--state', 'open',
    '--limit', '1',
    '--json', 'number',
    '--jq', '.[0].number // empty',
  ]);
  const existingNumber = (listResult.stdout ?? '').trim();
  if (existingNumber) {
    console.warn(`nexus-triage: ops:nexus-schema-gap issue #${existingNumber} already open — skipping duplicate.`);
    return;
  }

  // 2. No existing issue — file one.
  const body = [
    '## Nexus GraphQL schema gap: `mod.bugReports` field unavailable',
    '',
    'During schema introspection, `mod.bugReports` was not found in the Nexus GraphQL `Mod` type.',
    'Triage is continuing with **comments-only** processing until the field returns.',
    '',
    '### References',
    '- Spec: `docs/superpowers/specs/2026-05-26-nexus-github-triage-design.md`',
    '- Schema-gap runbook: see `RELEASING.md` → *Nexus schema-gap runbook* section',
    '',
    '> This issue was filed automatically by the nexus-triage bot and will not re-file',
    '> while an open issue with the `ops:nexus-schema-gap` label exists.',
  ].join('\n');

  console.warn('nexus-triage: mod.bugReports unavailable — filing ops:nexus-schema-gap issue.');
  await ghInvoker([
    'issue', 'create',
    '--title', '[ops] Nexus GraphQL schema gap: mod.bugReports unavailable',
    '--label', 'ops:nexus-schema-gap',
    '--body', body,
  ]);
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const NEXUS_COMMENT_URL = (id) =>
  `https://www.nexusmods.com/${GAME_DOMAIN}/mods/${MOD_ID}?tab=posts&postid=${id}`;
const NEXUS_BUG_URL = (id) =>
  `https://www.nexusmods.com/${GAME_DOMAIN}/mods/${MOD_ID}?tab=bugs&bugid=${id}`;

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
    author: c.creator?.name ?? '<unknown>',
    authorId: c.creator?.memberId ?? '',
    nexus_url: NEXUS_COMMENT_URL(c.id),
  };
}

function bugToItem(b) {
  return {
    kind: 'bug',
    id: String(b.id),
    title: b.title,
    body: b.description ?? '',
    status: b.status,
    gameVersion: b.gameVersion,
    createdAt: b.createdAt,
    author: b.reporter?.name ?? '<unknown>',
    authorId: b.reporter?.memberId ?? '',
    nexus_url: NEXUS_BUG_URL(b.id),
  };
}

// ---------------------------------------------------------------------------
// main orchestrator
// ---------------------------------------------------------------------------

export async function main({ dryRun, apiKey, ghToken, state, templatePath = TEMPLATE_PATH }) {
  const result = {
    maintainerSkipped: 0,
    alreadySeen: 0,
    closedBugSkipped: 0,
    kudosSkipped: 0,
    filed: [],
    pendingNextRun: 0,
  };

  const schema = await introspectSchema({ apiKey });

  const commentNodes = schema.hasComments ? await fetchModComments({ apiKey }) : [];
  const bugNodes = schema.hasBugReports ? await fetchModBugReports({ apiKey }) : [];

  if (!schema.hasBugReports) {
    // Caller is responsible for filing the one-time ops:nexus-schema-gap issue.
    result.bugReportsUnavailable = true;
  }

  const comments = commentNodes.map(commentToItem);
  const bugs = bugNodes.map(bugToItem);

  // 1. Maintainer filter — case-insensitive — FIRST
  const nonMaintainerComments = comments.filter((c) => {
    if (isMaintainer(c.author)) { result.maintainerSkipped++; return false; }
    return true;
  });
  const nonMaintainerBugs = bugs.filter((b) => {
    if (isMaintainer(b.author)) { result.maintainerSkipped++; return false; }
    return true;
  });

  // 2. Closed-bug filter (only on first sight; if it's in state already, dedup catches it)
  const openBugs = nonMaintainerBugs.filter((b) => {
    if (state.bugs[b.id]) return true; // already filed; let dedup handle
    if (SKIP_BUG_STATUSES.has(b.status)) { result.closedBugSkipped++; return false; }
    return true;
  });

  // 3. Dedup against state
  const unseenComments = nonMaintainerComments.filter((c) => {
    if (state.comments[c.id]) { result.alreadySeen++; return false; }
    if (state.kudos_seen.includes(c.id)) { result.alreadySeen++; return false; }
    return true;
  });
  const unseenBugs = openBugs.filter((b) => {
    if (state.bugs[b.id]) { result.alreadySeen++; return false; }
    return true;
  });

  // 4. Classify all unseen items, sorted oldest-first by createdAt
  const items = [...unseenComments, ...unseenBugs].sort(
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

  // 5. Update state (in memory; caller persists)
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
  node scripts/nexus-triage.mjs              # normal run (requires NEXUS_API_KEY + GITHUB_TOKEN)
  node scripts/nexus-triage.mjs --dry-run    # print what would file, no gh calls, no state write
  node scripts/nexus-triage.mjs --bootstrap  # mark all current Nexus items as seen, do not file
  node scripts/nexus-triage.mjs --help       # this message

Environment:
  NEXUS_API_KEY    Nexus v1 API key (for v2 GraphQL too)
  GITHUB_TOKEN     GitHub PAT or Actions-provided token

Killswitch:
  touch scripts/nexus-triage.disabled        # next run exits 0 with no work
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
  const apiKey = process.env.NEXUS_API_KEY;
  if (!apiKey) {
    console.error('nexus-triage: NEXUS_API_KEY is not set.');
    process.exit(2);
  }
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) {
    console.error('nexus-triage: GITHUB_TOKEN is not set.');
    process.exit(2);
  }
  if (opts.bootstrap) {
    const fresh = { schema_version: STATE_SCHEMA_VERSION, last_run_at: new Date().toISOString(),
                    comments: {}, bugs: {}, kudos_seen: [] };
    const schema = await introspectSchema({ apiKey });
    const commentNodes = schema.hasComments ? await fetchModComments({ apiKey }) : [];
    const bugNodes = schema.hasBugReports ? await fetchModBugReports({ apiKey }) : [];
    for (const c of commentNodes) {
      fresh.kudos_seen.push(String(c.id));
    }
    // Bug nodes get seeded as bugs with a bootstrap-seed marker so we don't refile them.
    for (const b of bugNodes) {
      fresh.bugs[String(b.id)] = {
        gh_issue_url: '<bootstrap-seed>',
        classification: 'bootstrap-seed',
        filed_at: new Date().toISOString(),
      };
    }
    saveState(STATE_PATH, fresh);
    console.log(`nexus-triage: bootstrap complete. Marked ${commentNodes.length} comments + ${bugNodes.length} bugs as seen.`);
    return 0;
  }

  const state = loadState(STATE_PATH);
  const result = await main({ dryRun: opts.dryRun, apiKey, ghToken, state });

  // Schema soft-degradation: file ops:nexus-schema-gap issue once (idempotent).
  if (result.bugReportsUnavailable) {
    await ensureSchemaGapIssue();
  }

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
