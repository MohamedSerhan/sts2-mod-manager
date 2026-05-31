/**
 * STS2 Mod Manager — bug-report ingest Worker.
 *
 * A tiny Cloudflare Worker that lets the app upload a (already-redacted)
 * diagnostic report and get back a short view URL to drop into a GitHub
 * issue — so the reporter needs NO token and nothing is truncated.
 *
 *   POST /            { "report": "<text>" }   ->  { "url": "<base>/r/<id>" }
 *   GET  /r/<id>                                ->  the stored report (text/plain)
 *
 * Storage is a KV namespace (binding REPORTS) with a TTL. An optional
 * shared key (secret APP_KEY) gates uploads: when set, the app must send a
 * matching `x-app-key` header. Reports are stored verbatim — the app
 * redacts paths/tokens/username before uploading.
 *
 * Deploy: see README.md in this folder.
 */

const MAX_BYTES = 512 * 1024; // 512 KB per report — plenty for logs.
const TTL_SECONDS = 60 * 60 * 24 * 90; // keep reports 90 days.
const ID_LENGTH = 16;

// The upload comes from the desktop app (not a browser), but allow CORS so a
// future in-browser caller works too.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-app-key',
};

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

function newId() {
  // 16 hex chars from a random UUID — unguessable enough for a non-listed
  // report link (the report is already redacted regardless).
  return crypto.randomUUID().replace(/-/g, '').slice(0, ID_LENGTH);
}

// Constant-time compare so a wrong `x-app-key` can't be recovered byte-by-byte
// from response timing. The key length is fixed and not itself a secret, so
// folding the length difference into the result is fine. Runs over the longer
// of the two so a short guess can't short-circuit either.
function constantTimeEqual(a, b) {
  const enc = new TextEncoder();
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  const n = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < n; i++) diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      // 204 responses MUST have a null body — the Workers runtime throws
      // "Invalid response status code 204" on a body, which 500s the CORS
      // preflight. A preflight only needs the headers.
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ── Retrieve a stored report ──────────────────────────────────
    if (request.method === 'GET' && url.pathname.startsWith('/r/')) {
      const id = url.pathname.slice('/r/'.length);
      if (!id || !env.REPORTS) return new Response('Not found', { status: 404 });
      const report = await env.REPORTS.get(`report:${id}`);
      if (report === null) return new Response('Not found', { status: 404 });
      return new Response(report, {
        status: 200,
        headers: {
          'content-type': 'text/plain; charset=utf-8',
          // Reports are attacker-supplied text served from the worker's own
          // origin — stop browsers MIME-sniffing one into HTML/JS.
          'x-content-type-options': 'nosniff',
          // Render inline rather than download.
          'content-disposition': 'inline; filename="sts2-bug-report.txt"',
        },
      });
    }

    // ── Ingest a new report ───────────────────────────────────────
    if (request.method === 'POST') {
      if (!env.REPORTS) {
        return jsonResponse({ error: 'storage not configured' }, 500);
      }
      // Optional shared-key gate (constant-time compare).
      if (env.APP_KEY && !constantTimeEqual(request.headers.get('x-app-key') ?? '', env.APP_KEY)) {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'invalid JSON' }, 400);
      }
      const report = typeof body?.report === 'string' ? body.report : '';
      if (!report.trim()) {
        return jsonResponse({ error: 'empty report' }, 400);
      }
      if (report.length > MAX_BYTES) {
        return jsonResponse({ error: 'report too large' }, 413);
      }

      const id = newId();
      await env.REPORTS.put(`report:${id}`, report, { expirationTtl: TTL_SECONDS });
      return jsonResponse({ url: `${url.origin}/r/${id}` });
    }

    return jsonResponse({ error: 'method not allowed' }, 405);
  },
};
