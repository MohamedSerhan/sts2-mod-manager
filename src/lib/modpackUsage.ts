/**
 * Local launch-history for modpacks (FR: sort by last launched + Home
 * "recent modpacks"). Lives in localStorage on purpose: the profile
 * manifest is published to GitHub on share, so persisting usage there
 * would churn the shared file (and the publish pipeline) every time the
 * user plays. Launch history is per-machine UX state, not pack content.
 *
 * Storage shape: one JSON map under a single key — { [packName]: epochMs }.
 * All helpers are best-effort: storage failures (private mode, quota)
 * degrade to "no history", never throw into UI code.
 */

const STORAGE_KEY = 'sts2mm-modpack-launches';

export type ModpackUsageMap = Record<string, number>;
export type ModpackUsageSubject = string | {
  id?: string | null;
  name: string;
};

export function getModpackUsage(): ModpackUsageMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: ModpackUsageMap = {};
    for (const [name, ts] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof ts === 'number' && Number.isFinite(ts)) out[name] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

function write(map: ModpackUsageMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable — history is best-effort */
  }
}

function subjectKeys(subject: ModpackUsageSubject): string[] {
  if (typeof subject === 'string') return subject ? [subject] : [];
  const keys = [subject.id ?? '', subject.name].filter(Boolean);
  return Array.from(new Set(keys));
}

function preferredSubjectKey(subject: ModpackUsageSubject): string | null {
  if (typeof subject === 'string') return subject || null;
  return subject.id || subject.name || null;
}

/** Timestamp for a pack, resolving stable IDs and legacy display-name keys. */
export function getModpackLastLaunch(
  subject: ModpackUsageSubject,
  map: ModpackUsageMap = getModpackUsage(),
): number {
  return subjectKeys(subject).reduce((latest, key) => Math.max(latest, map[key] ?? 0), 0);
}

/** Record that `name` was just launched (switched to / activated). */
export function recordModpackLaunch(subject: ModpackUsageSubject): void {
  const key = preferredSubjectKey(subject);
  if (!key) return;
  const map = getModpackUsage();
  map[key] = Date.now();
  for (const staleKey of subjectKeys(subject)) {
    if (staleKey !== key) delete map[staleKey];
  }
  write(map);
}

/** Carry launch history across a pack rename. */
export function renameModpackUsage(oldName: string, newName: string): void {
  const map = getModpackUsage();
  if (map[oldName] === undefined) return;
  map[newName] = map[oldName];
  delete map[oldName];
  write(map);
}

/** Drop a deleted pack's history so it never resurfaces in "recent". */
export function forgetModpackUsage(subject: ModpackUsageSubject): void {
  const map = getModpackUsage();
  let changed = false;
  for (const key of subjectKeys(subject)) {
    if (map[key] === undefined) continue;
    delete map[key];
    changed = true;
  }
  if (!changed) return;
  write(map);
}

/**
 * Names of the most recently launched packs, newest first, filtered to
 * `existing` (stale entries for packs deleted outside the app are skipped).
 */
export function recentModpacks(existing: readonly ModpackUsageSubject[], limit: number): string[] {
  const map = getModpackUsage();
  return existing
    .map((subject) => ({
      name: typeof subject === 'string' ? subject : subject.name,
      lastPlayed: getModpackLastLaunch(subject, map),
    }))
    .filter((item) => item.lastPlayed > 0)
    .sort((a, b) => b.lastPlayed - a.lastPlayed)
    .slice(0, limit)
    .map((item) => item.name);
}
