export interface NexusModRef {
  gameDomain: string;
  modId: string;
}

const NEXUS_HOST = 'nexusmods.com';
const NEXUS_WWW_HOST = 'www.nexusmods.com';
const GAME_DOMAIN_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MOD_ID_RE = /^\d+$/;

export function isNexusModsHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  return host === NEXUS_HOST || host === NEXUS_WWW_HOST;
}

function normalizeUrlInput(input: string): string | null {
  if (/^https?:\/\//i.test(input)) return input;
  if (/^(?:www\.)?nexusmods\.com\//i.test(input)) return `https://${input}`;
  return null;
}

function validRef(gameDomain: string, modId: string): NexusModRef | null {
  if (!GAME_DOMAIN_RE.test(gameDomain) || !MOD_ID_RE.test(modId)) return null;
  return { gameDomain, modId };
}

export function parseNexusModInput(input: string): NexusModRef | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  const shorthand = trimmed.match(/^nexus:([^/]+)\/mods\/(\d+)$/i);
  if (shorthand) return validRef(shorthand[1], shorthand[2]);

  const normalized = normalizeUrlInput(trimmed);
  if (!normalized) return null;

  try {
    const url = new URL(normalized);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (!isNexusModsHost(url.hostname)) return null;

    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 3 || parts[1].toLowerCase() !== 'mods') return null;
    return validRef(parts[0], parts[2]);
  } catch {
    return null;
  }
}

export function nexusFilesUrl(input: string): string | null {
  const ref = parseNexusModInput(input);
  if (!ref) return null;
  return `https://www.nexusmods.com/${ref.gameDomain}/mods/${ref.modId}?tab=files`;
}
