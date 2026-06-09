# Drift & Sync Consolidation — Single Source of Truth

**Date:** 2026-06-09
**Status:** Draft
**Issue:** Solo_mag Discord reports (2026-06-07/08); GitHub #160

## Problem

The drift/save/out-of-sync system in `Profiles.tsx` has been patched six times
since v1.0.2. Each fix addressed a specific trigger gap, but the underlying
architecture — three independent, competing refresh paths — keeps producing new
variants of the same bug class: stale closures, dropped updates, and race
conditions between concurrent async fetches.

### The three refresh paths today

1. **`installedDriftSignature`** — a `useMemo` over the `mods` array (name +
   version + enabled) feeding a dedicated `useEffect` that calls
   `getProfileDrift`. Fires when on-disk mods change (toggle, delete, install).
   Does NOT fire when only the profile manifest changes (Add/Remove from pack).

2. **`refreshShareAndDrift`** — a `useCallback` closed over `profiles` and
   `activeProfile`, triggered by a `useEffect` on `[profiles, activeProfile,
   refreshShareAndDrift]`. Fetches both share info (for all profiles) and drift
   (for the active profile). Uses a monotonic generation guard
   (`refreshGenRef`) to drop stale results.

3. **`handleLibraryChanged`** — an imperative call from `ModpackDetail` after
   any membership mutation. Calls `loadProfiles({ silent: true })` then
   `refreshShareAndDrift()`. Susceptible to stale-closure issues: the
   `useCallback` captured old state, so calling it immediately after a state
   update can run stale logic.

### Current bug (Solo_mag, 2026-06-08)

After saving drift (clearing the banner), then removing mods from a shared
active pack:

- **Drift banner:** Does not reappear. This is actually correct — Remove
  disables the mod on disk AND removes it from the profile JSON, so manifest
  and disk agree. Disabled mods not in the profile are library items, not drift
  (drift.rs line 133).
- **Out-of-sync banner:** Does not reappear. This IS a bug.
  `refreshAfterMutation` calls `markSharedLocalEdit()` which sets
  `localOutOfSyncMap`, but the concurrent `refreshShareAndDrift` overwrites
  `shareInfoMap` with a result from a stale-closure fetch, and the generation
  guard can drop the newer result. The backend's `out_of_sync` flag (computed
  from `published_signature` in `.share`) is correct, but the frontend never
  sees it because the fetch result is discarded.

### Prior fixes preserved by this design

| Fix | Commit | Layer | Impact |
|-----|--------|-------|--------|
| Live drift update after toggle/delete | `7f798d1` (FB2-C) | Frontend | **Replaced** by the new counter; same observable behavior. |
| Content-aware version drift | `3d6342a` (FB2-B) | Rust backend | Untouched. |
| Save names the mods it added/dropped | `4a17639` (FB-C) | Frontend | Preserved — `handleSaveDrift` logic unchanged. |
| Save applies drift diff, not re-snapshot | `a19976f` | Rust backend | Untouched. |
| Owned packs stay editable | `53d2614` | Rust backend | Untouched. |
| Refuse save on followed packs | `5a0425d` | Frontend + Rust | Preserved — `activeIsFollowed` derivation unchanged. |
| Self-install recovers .share | `7687b12` | Rust backend | Untouched. |

## Design

### Core change: single revision counter

Replace the three refresh paths with one monotonically increasing counter and
one effect.

```
profileRevision: number     // starts at 0
activeProfileRef: Ref        // always-current activeProfile (no stale closure)

useEffect(() => {
  const ap = activeProfileRef.current;
  // 1. Fetch share info for all loaded profiles
  // 2. Fetch drift for the active profile (if any)
  // 3. Fetch subscriptions
  // 4. Write shareInfoMap, driftMap, subscriptions in one setState batch
}, [profileRevision, activeProfile])
```

**What gets removed:**

- `installedDriftSignature` memo
- The `useEffect` keyed on `installedDriftSignature`
- `refreshShareAndDrift` useCallback
- The `useEffect` keyed on `[profiles, activeProfile, refreshShareAndDrift]`
- `refreshGenRef` (generation guard)

**What replaces them:**

- `profileRevision` state (number, starts at 0)
- `bumpRevision` callback: `useCallback(() => setProfileRevision(r => r + 1), [])`
- `activeProfileRef` ref kept in sync via a small effect
- One consolidated effect keyed on `[profileRevision, activeProfile]`
- A `mods`-watching effect that bumps revision when the installed-set signature
  changes (preserves FB2-C's live-update behavior without duplicating logic)

### Who bumps the counter

Every mutation path that changes a profile manifest or on-disk state calls
`bumpRevision()` after completing its work:

| Mutation | Current refresh path | New path |
|----------|---------------------|----------|
| `handleSaveDrift` | `loadProfiles` + `refreshShareAndDrift` | `loadProfiles` + `bumpRevision()` |
| `handleRepairDrift` | `refreshAll` + `loadProfiles` | `refreshAll` + `loadProfiles` + `bumpRevision()` |
| `handleSwitch` | `refreshAll` + `loadProfiles` | `refreshAll` + `loadProfiles` + `bumpRevision()` |
| `handleLibraryChanged` | `loadProfiles` + `refreshShareAndDrift` | `loadProfiles` + `bumpRevision()` |
| `handleApplySub` | `refreshAll` + `refreshSubUpdates` | `refreshAll` + `refreshSubUpdates` + `bumpRevision()` |
| Installed mods change | `installedDriftSignature` effect | mods-signature effect calls `bumpRevision()` |

### Consolidated recompute effect

```typescript
const profileRevisionRef = useRef(profileRevision);
profileRevisionRef.current = profileRevision;

useEffect(() => {
  const rev = profileRevision;
  let cancelled = false;

  (async () => {
    // 1. Share info for all profiles
    const shareMap: Record<string, ShareResult> = {};
    for (const p of profiles) {
      try {
        const info = await getShareInfo(p.name);
        if (info) shareMap[p.name] = info;
      } catch { /* no share info */ }
    }

    // 2. Subscriptions
    const subs = await getSubscriptions().catch(() => []);

    // 3. Drift for active profile only
    const driftEntries: Record<string, ProfileDrift> = {};
    const ap = activeProfileRef.current;
    if (ap) {
      try {
        const drift = await getProfileDrift(ap);
        if (drift?.has_drift) driftEntries[ap] = drift;
      } catch { /* ignore */ }
    }

    // Stale guard: if a newer revision fired while we were awaiting,
    // discard this result — the newer one will land.
    if (cancelled || profileRevisionRef.current !== rev) return;

    setShareInfoMap(shareMap);
    setSubscriptions(subs);
    setDriftMap(driftEntries);
  })();

  return () => { cancelled = true; };
}, [profileRevision, activeProfile]);
```

The stale guard uses a ref (`profileRevisionRef`) instead of a mutable closure
counter. This is race-safe: if two effects overlap, only the one matching the
current revision writes state.

### Out-of-sync handling

**`localOutOfSyncMap` becomes an optimistic hint only.** It is set immediately
by `markSharedLocalEdit()` for instant UI feedback. The consolidated effect
re-fetches `getShareInfo` which returns the backend's authoritative
`out_of_sync` flag (based on `published_signature` comparison). The backend
always wins — `localOutOfSyncMap` just bridges the gap until the effect
completes.

This eliminates the current bug: the Remove path calls `markSharedLocalEdit()`
→ banner appears instantly → `bumpRevision()` → effect fetches backend
`out_of_sync: true` → banner stays. No more dropped results.

### Mods-watching bridge (FB2-C preservation)

To preserve the live-update behavior from FB2-C (drift updates when you
toggle/delete mods from a different surface), a small bridge effect watches the
installed mods signature and bumps the revision:

```typescript
const modsSignature = useMemo(
  () => mods.map(m => `${m.folder_name ?? m.name}|${m.version}|${m.enabled ? 1 : 0}`)
    .sort().join('\n'),
  [mods],
);
const prevModsSigRef = useRef(modsSignature);
useEffect(() => {
  if (prevModsSigRef.current !== modsSignature) {
    prevModsSigRef.current = modsSignature;
    bumpRevision();
  }
}, [modsSignature, bumpRevision]);
```

This replaces the old `installedDriftSignature` effect that duplicated the
drift-fetch logic. Now it just bumps the counter and the consolidated effect
handles the rest.

## Files changed

| File | Change |
|------|--------|
| `src/views/Profiles.tsx` | Replace three refresh paths with counter + one effect |
| `src/views/Profiles.test.tsx` | Update existing tests; add regression tests |

## Files NOT changed

All Rust backend files — `drift.rs`, `crud.rs`, `sharing/mod.rs`,
`sharing/install.rs`, `membership.rs` — are untouched. The backend drift
computation, edit-lock guards, ownership recovery, and out-of-sync detection
are correct and unmodified.

`src/components/ModpackDetail.tsx` and `src/components/LibraryTable.tsx` are
unchanged — they keep calling `onLibraryChanged` / `onMembershipChanged` which
flow to `handleLibraryChanged` in Profiles.tsx, which now just bumps the
counter.

## Test plan

### Existing tests (must still pass)

All existing drift/share tests in `Profiles.test.tsx` test observable behavior
(banner appears, toast fires, API called) not internal mechanism. They should
pass without changes to test logic — only the mock handler wiring may need
adjustment if the call pattern changes.

### New regression tests

1. **Remove from shared active pack → out-of-sync banner appears.** Setup: a
   shared active profile with `out_of_sync: false`. Remove a mod. Assert: the
   out-of-sync banner appears (either via `localOutOfSyncMap` optimistic hint
   or via re-fetched `shareInfo.out_of_sync`).

2. **Remove from active pack → drift correct.** Setup: an active profile with
   no drift. Remove a mod (which also disables it). Assert: drift banner does
   NOT appear (disabled mod not in profile = library item, not drift). This
   confirms the current correct behavior is preserved.

3. **Rapid mutations don't race.** Setup: an active profile. Fire two
   mutations in quick succession (e.g., toggle then remove). Assert: final
   drift state reflects both mutations, not just the first.

4. **Followed pack hides Save button.** Setup: subscribed-but-not-owned pack
   with drift. Assert: drift banner shows Repair but not Save. (Existing test
   preserved.)

## Risks and mitigations

| Risk | Mitigation |
|------|-----------|
| Over-fetching: every bump re-fetches share info for ALL profiles | Same as current `refreshShareAndDrift`. Could optimize later to only fetch active profile's share info when the bump source is a drift-only change. Not in scope — current behavior is acceptable. |
| Initial-load double-fetch (mount + first mods load) | The stale guard drops the first result if a second arrives. Same behavior as today's generation guard. |
| `loadProfiles` + `bumpRevision` in the same handler could cause two renders | React batches state updates within the same event handler, so only one render fires. Verified by existing test patterns. |
