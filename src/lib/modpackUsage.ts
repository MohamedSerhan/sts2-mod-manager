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

/** Record that `name` was just launched (switched to / activated). */
export function recordModpackLaunch(name: string): void {
  const map = getModpackUsage();
  map[name] = Date.now();
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
export function forgetModpackUsage(name: string): void {
  const map = getModpackUsage();
  if (map[name] === undefined) return;
  delete map[name];
  write(map);
}

/**
 * Names of the most recently launched packs, newest first, filtered to
 * `existing` (stale entries for packs deleted outside the app are skipped).
 */
export function recentModpacks(existing: readonly string[], limit: number): string[] {
  const map = getModpackUsage();
  const known = new Set(existing);
  return Object.entries(map)
    .filter(([name]) => known.has(name))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name]) => name);
}
