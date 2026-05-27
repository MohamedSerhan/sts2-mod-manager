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
