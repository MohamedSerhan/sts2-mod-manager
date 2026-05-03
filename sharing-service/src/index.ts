import { Hono } from 'hono';
import { cors } from 'hono/cors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProfileManifest {
  name: string;
  game_version: string;
  created_by: string;
  mods: {
    name: string;
    version: string;
    source: string;
    hash: string | null;
    files: string[];
  }[];
}

interface StoredProfile {
  profile: ProfileManifest;
  created_at: string;
  updated_at: string;
  access_count: number;
  last_accessed: string;
  secret_hash: string;
}

interface Env {
  PROFILES: KVNamespace;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(6)))
    .map((b) => chars[b % chars.length])
    .join('');
}

function generateSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function hashSecret(secret: string): Promise<string> {
  const encoded = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function getClientIp(c: any): string {
  return (
    c.req.header('cf-connecting-ip') ||
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    '0.0.0.0'
  );
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function validateProfile(profile: any): profile is ProfileManifest {
  if (!profile || typeof profile !== 'object') return false;
  if (typeof profile.name !== 'string' || profile.name.length === 0 || profile.name.length > 100) return false;
  if (typeof profile.game_version !== 'string' || profile.game_version.length === 0) return false;
  if (typeof profile.created_by !== 'string') return false;
  if (!Array.isArray(profile.mods)) return false;
  for (const mod of profile.mods) {
    if (typeof mod.name !== 'string') return false;
    if (typeof mod.version !== 'string') return false;
    if (typeof mod.source !== 'string') return false;
    if (!Array.isArray(mod.files)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Rate limiting (simple KV counter per IP per hour)
// ---------------------------------------------------------------------------

async function checkRateLimit(kv: KVNamespace, ip: string): Promise<boolean> {
  const key = `ratelimit:${ip}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  return count < 10;
}

async function incrementRateLimit(kv: KVNamespace, ip: string): Promise<void> {
  const key = `ratelimit:${ip}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  // Expire after 1 hour
  await kv.put(key, String(count + 1), { expirationTtl: 3600 });
}

// ---------------------------------------------------------------------------
// HTML Templates
// ---------------------------------------------------------------------------

function landingPageHtml(baseUrl: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>STS2 Mod Manager - Profile Sharing</title>
  <meta name="description" content="Share your Slay the Spire 2 mod profiles with friends. One click to install entire mod collections.">
  <meta name="theme-color" content="#6366f1">
  <meta property="og:title" content="STS2 Mod Manager - Profile Sharing">
  <meta property="og:description" content="Share your Slay the Spire 2 mod profiles with friends. One click to install entire mod collections.">
  <meta property="og:type" content="website">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
      background: #0f0f17;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .hero {
      text-align: center;
      padding: 5rem 1.5rem 3rem;
      max-width: 700px;
    }
    .hero h1 {
      font-size: 2.5rem;
      font-weight: 800;
      background: linear-gradient(135deg, #818cf8, #6366f1, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 1rem;
    }
    .hero .subtitle {
      font-size: 1.15rem;
      color: #94a3b8;
      line-height: 1.7;
      margin-bottom: 2.5rem;
    }
    .features {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1.5rem;
      max-width: 700px;
      padding: 0 1.5rem 3rem;
      width: 100%;
    }
    .feature-card {
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 12px;
      padding: 1.5rem;
    }
    .feature-card h3 {
      color: #818cf8;
      font-size: 1rem;
      margin-bottom: 0.5rem;
    }
    .feature-card p {
      color: #94a3b8;
      font-size: 0.9rem;
      line-height: 1.5;
    }
    .cta-section {
      text-align: center;
      padding: 2rem 1.5rem 4rem;
    }
    .btn {
      display: inline-block;
      padding: 0.85rem 2rem;
      border-radius: 10px;
      font-weight: 600;
      font-size: 1rem;
      text-decoration: none;
      transition: all 0.2s;
    }
    .btn-primary {
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
    }
    .btn-primary:hover { opacity: 0.9; transform: translateY(-1px); }
    .btn-secondary {
      background: #1a1a2e;
      color: #818cf8;
      border: 1px solid #6366f1;
      margin-left: 1rem;
    }
    .btn-secondary:hover { background: #22224a; }
    .api-note {
      max-width: 700px;
      padding: 2rem 1.5rem 4rem;
      text-align: center;
    }
    .api-note code {
      background: #1a1a2e;
      padding: 0.2em 0.5em;
      border-radius: 4px;
      font-size: 0.85rem;
      color: #818cf8;
    }
    .api-note p {
      color: #64748b;
      font-size: 0.85rem;
      margin-top: 1rem;
    }
    footer {
      text-align: center;
      padding: 2rem;
      color: #475569;
      font-size: 0.8rem;
      border-top: 1px solid #1e1e36;
      width: 100%;
      margin-top: auto;
    }
  </style>
</head>
<body>
  <div class="hero">
    <h1>STS2 Mod Manager</h1>
    <p class="subtitle">
      Share your Slay the Spire 2 mod loadouts with friends.<br>
      Create a profile, share the link, and they can install your
      entire mod collection with a single click.
    </p>
    <a href="https://github.com/" class="btn btn-primary">Download Mod Manager</a>
    <a href="${baseUrl}/api/profiles" class="btn btn-secondary">API Docs</a>
  </div>

  <div class="features">
    <div class="feature-card">
      <h3>One-Click Sharing</h3>
      <p>Export your mod profile and get a shareable link. Friends click it and everything installs automatically.</p>
    </div>
    <div class="feature-card">
      <h3>Version Matched</h3>
      <p>Profiles track exact mod versions and game compatibility so everyone runs the same setup.</p>
    </div>
    <div class="feature-card">
      <h3>Discord Friendly</h3>
      <p>Shared links show a rich preview in Discord with mod counts, game version, and profile info.</p>
    </div>
  </div>

  <div class="api-note">
    <p>Profiles are created programmatically through the STS2 Mod Manager desktop app.</p>
    <p>API: <code>POST ${baseUrl}/api/profiles</code></p>
  </div>

  <footer>STS2 Mod Manager &mdash; Not affiliated with Mega Crit Games</footer>
</body>
</html>`;
}

function profilePageHtml(id: string, profile: ProfileManifest, baseUrl: string): string {
  const modCount = profile.mods.length;
  const modWord = modCount === 1 ? 'mod' : 'mods';
  const deepLink = `sts2mm://install/${id}`;
  const title = escapeHtml(profile.name);
  const description = `${modCount} ${modWord} for Slay the Spire 2 ${escapeHtml(profile.game_version)} \u2014 shared by ${escapeHtml(profile.created_by)}`;

  const modListHtml = profile.mods
    .map((mod) => {
      const sourceLink = mod.source.startsWith('http')
        ? `<a href="${escapeHtml(mod.source)}" target="_blank" rel="noopener" class="mod-source">Source</a>`
        : `<span class="mod-source-text">${escapeHtml(mod.source)}</span>`;
      return `
      <div class="mod-card">
        <div class="mod-info">
          <span class="mod-name">${escapeHtml(mod.name)}</span>
          <span class="mod-version">v${escapeHtml(mod.version)}</span>
        </div>
        <div class="mod-actions">${sourceLink}</div>
      </div>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} - STS2 Mod Profile</title>
  <meta name="description" content="${escapeHtml(description)}">

  <!-- Open Graph / Discord embeds -->
  <meta property="og:type" content="website">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${baseUrl}/p/${id}">
  <meta name="theme-color" content="#6366f1">

  <!-- Twitter card -->
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${title}">
  <meta name="twitter:description" content="${escapeHtml(description)}">

  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, sans-serif;
      background: #0f0f17;
      color: #e2e8f0;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .container {
      max-width: 620px;
      width: 100%;
      padding: 2.5rem 1.5rem 3rem;
    }
    .back-link {
      color: #64748b;
      text-decoration: none;
      font-size: 0.85rem;
      display: inline-block;
      margin-bottom: 2rem;
    }
    .back-link:hover { color: #818cf8; }
    .profile-header {
      background: linear-gradient(135deg, #1a1a2e 0%, #16162a 100%);
      border: 1px solid #2a2a4a;
      border-radius: 16px;
      padding: 2rem;
      margin-bottom: 1.5rem;
    }
    .profile-header h1 {
      font-size: 1.8rem;
      font-weight: 700;
      background: linear-gradient(135deg, #818cf8, #a78bfa);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      margin-bottom: 0.75rem;
    }
    .profile-meta {
      display: flex;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 1.5rem;
    }
    .meta-badge {
      background: #0f0f17;
      border: 1px solid #2a2a4a;
      border-radius: 8px;
      padding: 0.4rem 0.85rem;
      font-size: 0.8rem;
      color: #94a3b8;
    }
    .meta-badge strong { color: #e2e8f0; }
    .install-btn {
      display: block;
      width: 100%;
      text-align: center;
      padding: 1rem;
      border-radius: 12px;
      font-weight: 700;
      font-size: 1.05rem;
      text-decoration: none;
      background: linear-gradient(135deg, #6366f1, #8b5cf6);
      color: #fff;
      border: none;
      cursor: pointer;
      transition: all 0.2s;
    }
    .install-btn:hover { opacity: 0.9; transform: translateY(-1px); }
    .install-hint {
      text-align: center;
      margin-top: 0.5rem;
      font-size: 0.78rem;
      color: #64748b;
    }
    .install-hint a { color: #818cf8; text-decoration: none; }
    .install-hint a:hover { text-decoration: underline; }
    .section-title {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #64748b;
      margin-bottom: 0.75rem;
      font-weight: 600;
    }
    .mod-list {
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
    }
    .mod-card {
      background: #1a1a2e;
      border: 1px solid #2a2a4a;
      border-radius: 10px;
      padding: 0.85rem 1.1rem;
      display: flex;
      justify-content: space-between;
      align-items: center;
      transition: border-color 0.15s;
    }
    .mod-card:hover { border-color: #6366f1; }
    .mod-info {
      display: flex;
      align-items: baseline;
      gap: 0.5rem;
      min-width: 0;
    }
    .mod-name {
      font-weight: 600;
      font-size: 0.95rem;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .mod-version {
      font-size: 0.78rem;
      color: #64748b;
      flex-shrink: 0;
    }
    .mod-actions { flex-shrink: 0; margin-left: 0.75rem; }
    .mod-source {
      color: #818cf8;
      text-decoration: none;
      font-size: 0.82rem;
      font-weight: 500;
      padding: 0.3rem 0.65rem;
      border-radius: 6px;
      border: 1px solid #3730a3;
      transition: all 0.15s;
    }
    .mod-source:hover { background: #3730a3; color: #fff; }
    .mod-source-text {
      color: #64748b;
      font-size: 0.82rem;
    }
    .shared-by {
      margin-top: 2rem;
      text-align: center;
      font-size: 0.8rem;
      color: #475569;
    }
    footer {
      text-align: center;
      padding: 2rem;
      color: #475569;
      font-size: 0.78rem;
      border-top: 1px solid #1e1e36;
      width: 100%;
      margin-top: auto;
    }
    footer a { color: #6366f1; text-decoration: none; }
    footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <a href="/" class="back-link">&larr; STS2 Mod Manager</a>

    <div class="profile-header">
      <h1>${title}</h1>
      <div class="profile-meta">
        <span class="meta-badge"><strong>${modCount}</strong> ${modWord}</span>
        <span class="meta-badge">Game <strong>${escapeHtml(profile.game_version)}</strong></span>
        <span class="meta-badge">by <strong>${escapeHtml(profile.created_by)}</strong></span>
      </div>
      <a href="${deepLink}" class="install-btn">Open in STS2 Mod Manager</a>
      <p class="install-hint">
        Don't have it? <a href="/">Download STS2 Mod Manager</a> first.
      </p>
    </div>

    <p class="section-title">Included Mods</p>
    <div class="mod-list">
${modListHtml}
    </div>

    <p class="shared-by">Profile ID: ${id}</p>
  </div>

  <footer>
    <a href="/">STS2 Mod Manager</a> &mdash; Not affiliated with Mega Crit Games
  </footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

// CORS for desktop app
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
}));

// ---- POST /api/profiles ----
app.post('/api/profiles', async (c) => {
  const ip = getClientIp(c);

  // Rate limit check
  const allowed = await checkRateLimit(c.env.PROFILES, ip);
  if (!allowed) {
    return c.json({ error: 'Rate limit exceeded. Max 10 profiles per hour.' }, 429);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { profile } = body;
  if (!validateProfile(profile)) {
    return c.json({ error: 'Invalid profile manifest' }, 400);
  }

  // Generate ID (retry on collision, unlikely)
  let id = generateId();
  let existing = await c.env.PROFILES.get(`profile:${id}`);
  let attempts = 0;
  while (existing && attempts < 5) {
    id = generateId();
    existing = await c.env.PROFILES.get(`profile:${id}`);
    attempts++;
  }
  if (existing) {
    return c.json({ error: 'Failed to generate unique ID. Try again.' }, 500);
  }

  const secretToken = generateSecret();
  const secretHash = await hashSecret(secretToken);
  const now = new Date().toISOString();

  const stored: StoredProfile = {
    profile,
    created_at: now,
    updated_at: now,
    access_count: 0,
    last_accessed: now,
    secret_hash: secretHash,
  };

  // Store with 90-day expiration
  await c.env.PROFILES.put(`profile:${id}`, JSON.stringify(stored), {
    expirationTtl: 60 * 60 * 24 * 90,
  });

  await incrementRateLimit(c.env.PROFILES, ip);

  const baseUrl = new URL(c.req.url).origin;
  return c.json({
    id,
    url: `${baseUrl}/p/${id}`,
    secret_token: secretToken,
  }, 201);
});

// ---- PUT /api/profiles/:id ----
app.put('/api/profiles/:id', async (c) => {
  const id = c.req.param('id');
  const auth = c.req.header('Authorization');

  if (!auth || !auth.startsWith('Bearer ')) {
    return c.json({ error: 'Missing or invalid Authorization header' }, 401);
  }

  const token = auth.slice(7);
  const raw = await c.env.PROFILES.get(`profile:${id}`);
  if (!raw) {
    return c.json({ error: 'Profile not found' }, 404);
  }

  const stored: StoredProfile = JSON.parse(raw);
  const tokenHash = await hashSecret(token);

  if (tokenHash !== stored.secret_hash) {
    return c.json({ error: 'Invalid secret token' }, 403);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const { profile } = body;
  if (!validateProfile(profile)) {
    return c.json({ error: 'Invalid profile manifest' }, 400);
  }

  stored.profile = profile;
  stored.updated_at = new Date().toISOString();

  await c.env.PROFILES.put(`profile:${id}`, JSON.stringify(stored), {
    expirationTtl: 60 * 60 * 24 * 90,
  });

  const baseUrl = new URL(c.req.url).origin;
  return c.json({ id, url: `${baseUrl}/p/${id}` });
});

// ---- GET /api/profiles/:id ----
app.get('/api/profiles/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.env.PROFILES.get(`profile:${id}`);

  if (!raw) {
    return c.json({ error: 'Profile not found' }, 404);
  }

  const stored: StoredProfile = JSON.parse(raw);

  // Bump access stats (fire and forget)
  stored.access_count++;
  stored.last_accessed = new Date().toISOString();
  c.executionCtx.waitUntil(
    c.env.PROFILES.put(`profile:${id}`, JSON.stringify(stored), {
      expirationTtl: 60 * 60 * 24 * 90,
    })
  );

  return c.json(stored.profile);
});

// ---- GET /p/:id ---- (profile landing page)
app.get('/p/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.env.PROFILES.get(`profile:${id}`);

  if (!raw) {
    return c.html(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>Not Found</title>
<style>body{font-family:sans-serif;background:#0f0f17;color:#e2e8f0;display:flex;justify-content:center;align-items:center;min-height:100vh;flex-direction:column}
h1{color:#6366f1}a{color:#818cf8}</style></head>
<body><h1>Profile Not Found</h1><p>This profile may have expired or the link is incorrect.</p>
<p style="margin-top:1rem"><a href="/">Go Home</a></p></body></html>`, 404);
  }

  const stored: StoredProfile = JSON.parse(raw);

  // Bump access stats
  stored.access_count++;
  stored.last_accessed = new Date().toISOString();
  c.executionCtx.waitUntil(
    c.env.PROFILES.put(`profile:${id}`, JSON.stringify(stored), {
      expirationTtl: 60 * 60 * 24 * 90,
    })
  );

  const baseUrl = new URL(c.req.url).origin;
  return c.html(profilePageHtml(id, stored.profile, baseUrl));
});

// ---- GET / ---- (landing page)
app.get('/', (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.html(landingPageHtml(baseUrl));
});

export default app;
