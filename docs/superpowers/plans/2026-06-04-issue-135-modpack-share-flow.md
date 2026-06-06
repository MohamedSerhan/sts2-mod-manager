# Issue #135 — Modpack Detail & Share-Flow Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the six bundled fixes for the modpack detail / share flow: remove Snapshot, add a "Start with all installed mods" wizard option, dedupe auto-detect, fix the non-English share-code layout, add out-of-sync/re-share detection, and add `.sts2pack` local export/import.

**Architecture:** Frontend is React + TypeScript (Vite, Vitest, react-i18next, 4 locales). Backend is Rust (Tauri commands registered in `src-tauri/src/lib.rs`). Out-of-sync detection adds a published-content fingerprint to the per-profile `.share` file. `.sts2pack` is a zip archive (`profile.json` + per-mod zips) built and consumed by reusing the existing share-bundle functions.

**Tech Stack:** Rust (`zip` v4, `serde`, `sha2`, `tempfile`), Tauri (`@tauri-apps/plugin-dialog`), React, react-i18next, Vitest.

**Spec:** `docs/superpowers/specs/2026-06-04-issue-135-modpack-share-flow-design.md`

**Conventions:**
- All user-visible strings go through `react-i18next`. Every new key MUST be added to all four locales (`src/i18n/locales/{en,ru,zh-Hans,ar}.json`) with real translations, and every removed key deleted from all four — `npm run qa:i18n` enforces key parity AND that non-English values differ from English (except the `SAME_AS_ENGLISH_ALLOWED` allowlist in `parity.test.ts`).
- Test style: loud element lookups (`getByRole`/`getByText` that throw when missing); always assert visible behavior; NO `if (btn) { click(btn) }` silent-skip. Reuse `src/test/setup.ts` defaults + `AllProviders`.
- Commit after each task.

**Verification commands (run from repo root unless noted):**
- Frontend tests: `npm test` (or scoped: `npx vitest run src/components/ModpackDetail.test.tsx`)
- i18n parity: `npm run qa:i18n`
- Lint/build: `npm run build`
- Rust tests (from `src-tauri/`): `cargo test`

---

### Task 1: Remove the Snapshot feature

**Goal:** Delete every Snapshot affordance (UI, command, wrapper, i18n keys, tests) while leaving the shared `snapshot_current_*` helpers that `create_profile` depends on.

**Files:**
- Modify: `src-tauri/src/profiles/mod.rs` (delete `snapshot_profile`, ~lines 527-544)
- Modify: `src-tauri/src/lib.rs` (delete `profiles::snapshot_profile,` from the `invoke_handler!` list, ~line 338)
- Modify: `src/hooks/useTauri.ts` (delete `snapshotProfile`, lines 178-180)
- Modify: `src/views/Profiles.tsx` (delete `snapshotProfile` import line 35; `handleSnapshot` lines 567-577; the Snapshot header `<Button>` lines 1072-1075; the `onSnapshot={() => handleSnapshot()}` prop line 1173; remove now-unused `Camera` import line 5)
- Modify: `src/components/ModpackDetail.tsx` (delete `onSnapshot?` prop line 86; its destructure line 143; the `onSnapshot &&` KebabItem lines 631-635; remove now-unused `Camera` import line 36)
- Modify: `src/i18n/locales/{en,ru,zh-Hans,ar}.json` (delete keys `profiles.actions.snapshotCurrent`, `profiles.prompt.snapshotName`, `profiles.kebab.snapshotFromCurrent`, `profiles.toast.snapshotCreated`, `profiles.toast.snapshotFailed`)
- Modify/Test: `src/views/Profiles.test.tsx`, `src/components/ModpackDetail.test.tsx`, `src/hooks/useTauri.test.ts` (remove snapshot tests/refs)
- Modify/Test: `src-tauri/tests/qa_scenarios.rs` (remove `flow_10_profile_snapshot_captures_folder_identity_and_source`, `snapshot_filter_strips_incompatible_when_enabled_preserves_when_none`, `non_publishing_snapshot_preserves_incompatible_mod_already_in_profile`)

**Acceptance Criteria:**
- [ ] No "Snapshot active modpack" button on the Modpacks page; no "Snapshot from current install" kebab item.
- [ ] `snapshot_profile` is gone from backend + invoke_handler; `cargo build` succeeds.
- [ ] `create_profile` and the Create-Modpack wizard still work (existing create tests pass).
- [ ] No `snapshot*` i18n keys remain in any locale; `npm run qa:i18n` passes.
- [ ] `npm test` and `cargo test` pass after test removals.

**Verify:** `cargo test` (from `src-tauri/`) → green; `npm test` → green; `npm run qa:i18n` → green.

**Steps:**

- [ ] **Step 1: Backend — delete the command.** In `src-tauri/src/profiles/mod.rs`, remove the entire `#[tauri::command] pub fn snapshot_profile(...) { ... }` block (~527-544). In `src-tauri/src/lib.rs`, remove the `profiles::snapshot_profile,` line from the `tauri::generate_handler![...]` list. Do NOT touch `snapshot_current_with_sources` / `snapshot_current_with_paths` / `snapshot_current_inner` in `apply.rs`.

- [ ] **Step 2: Backend — drop the snapshot tests.** In `src-tauri/tests/qa_scenarios.rs`, delete the three test fns listed in Files. Run `cargo test` (from `src-tauri/`); expected: compiles, all remaining tests pass (create/drift tests unaffected).

- [ ] **Step 3: Frontend — remove the wrapper + handlers + UI.** Delete `snapshotProfile` from `useTauri.ts`. In `Profiles.tsx`: remove the `snapshotProfile` import, the `handleSnapshot` function, the Snapshot `<Button>` in the page-actions, and the `onSnapshot={() => handleSnapshot()}` line in the `<ModpackDetail>` render. In `ModpackDetail.tsx`: remove the `onSnapshot?` prop, its destructure, and the `{onSnapshot && (<KebabItem ...>{t('profiles.kebab.snapshotFromCurrent')}</KebabItem>)}` block. Remove the now-unused `Camera` lucide import in both files (grep each file for `Camera` first to confirm it has no other use).

- [ ] **Step 4: i18n — delete the 5 keys from all 4 locales.** Remove `profiles.actions.snapshotCurrent`, `profiles.prompt.snapshotName`, `profiles.kebab.snapshotFromCurrent`, `profiles.toast.snapshotCreated`, `profiles.toast.snapshotFailed` from `en.json`, `ru.json`, `zh-Hans.json`, `ar.json`. Keep JSON valid (watch trailing commas).

- [ ] **Step 5: Frontend — remove snapshot tests.** In `Profiles.test.tsx`, `ModpackDetail.test.tsx`, `useTauri.test.ts`, delete the snapshot-specific test blocks / mock refs / imports (grep each for `snapshot`/`Snapshot`). For any test that asserted the Advanced kebab "shows Snapshot/Export/Delete", update the assertion to drop "Snapshot" rather than deleting the whole test.

- [ ] **Step 6: Verify + commit.**

```bash
npm run qa:i18n && npm test
(cd src-tauri && cargo test)
git add -A && git commit -m "feat(modpacks): remove the Snapshot feature (#135)"
```

---

### Task 2: "Start with all installed mods" wizard option

**Goal:** Add a 4th Create-Modpack wizard starting strategy that pre-selects every installed mod (enabled + disabled) — the Snapshot replacement.

**Files:**
- Modify: `src/components/CreateModpackWizard.tsx` (add `'allInstalled'` to `Strategy`; seed selection in `applyStrategyAndAdvance`; render a `StrategyOption` tile)
- Modify: `src/i18n/locales/{en,ru,zh-Hans,ar}.json` (add `createModpack.step1AllInstalled`, `createModpack.step1AllInstalledDesc`)
- Test: `src/components/CreateModpackWizard.test.tsx` (create if absent)

**Acceptance Criteria:**
- [ ] Step 1 shows a tile "Start with all installed mods" between "From my active mods" and "Empty".
- [ ] Clicking it advances to step 2 with EVERY installed mod checked (enabled and disabled).
- [ ] `npm run qa:i18n` passes (new keys present + translated in all locales).

**Verify:** `npx vitest run src/components/CreateModpackWizard.test.tsx` → green; `npm run qa:i18n` → green.

**Steps:**

- [ ] **Step 1: Write the failing test.** In `src/components/CreateModpackWizard.test.tsx`, render the wizard inside `AllProviders` with a mocked `mods` array containing one enabled + one disabled mod (via the AppContext mock used elsewhere — mirror an existing wizard/Profiles test's setup). Assert the new tile renders and that picking it checks both mods on step 2.

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import i18n from '../i18n';
// ...use the same AppContext mock pattern as existing tests; mods: [
//   { name: 'A', folder_name: 'A', enabled: true, ... },
//   { name: 'B', folder_name: 'B', enabled: false, ... } ]

it('all-installed strategy selects enabled AND disabled mods', async () => {
  const user = userEvent.setup();
  render(<CreateModpackWizard onClose={() => {}} onCreated={() => {}} />, { wrapper: AllProviders });
  // Loud lookup — throws if the tile is missing.
  await user.click(screen.getByText(i18n.t('createModpack.step1AllInstalled')));
  // Step 2 shows the multiselect with both rows selected.
  expect(screen.getByText(i18n.t('createModpack.step2SelectedCount', { count: 2 }))).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the test — expect FAIL** (`createModpack.step1AllInstalled` returns the key string / tile missing).

- [ ] **Step 3: Implement.** In `CreateModpackWizard.tsx`:
  - Change `type Strategy = 'fromActive' | 'empty' | 'clone';` → `type Strategy = 'fromActive' | 'allInstalled' | 'empty' | 'clone';`
  - In `applyStrategyAndAdvance`, add a branch BEFORE `empty`:

```tsx
    } else if (chosen === 'allInstalled') {
      // Snapshot replacement: every installed mod, enabled OR disabled.
      setSelectedMods(new Set(mods.map((m) => m.folder_name ?? m.name)));
```

  - In `StepStart`, add a tile after the `fromActive` `StrategyOption` and before `empty`:

```tsx
      <StrategyOption
        active={strategy === 'allInstalled'}
        title={t('createModpack.step1AllInstalled')}
        desc={t('createModpack.step1AllInstalledDesc')}
        onClick={() => onPick('allInstalled')}
      />
```

- [ ] **Step 4: Add i18n keys** to all 4 locales under `createModpack`:
  - en: `"step1AllInstalled": "Start with all installed mods"`, `"step1AllInstalledDesc": "Begin from every mod you have installed, enabled or not."`
  - ru / zh-Hans / ar: translated equivalents (distinct from English so the parity copied-prose check passes).

- [ ] **Step 5: Run the test — expect PASS.** Then `npm run qa:i18n`.

- [ ] **Step 6: Commit.**

```bash
git add -A && git commit -m "feat(wizard): add 'Start with all installed mods' option (#135)"
```

---

### Task 3: Dedupe "Auto-detect sources" in the Mod Library

**Goal:** Auto-detect should appear once in the Mod Library view — keep the standalone bulk-action button, drop the "+ Add mods" menu item, and delete the now-dead `includeAutoDetect` prop.

**Files:**
- Modify: `src/components/ModLibraryToolbar.tsx:37` (remove the `includeAutoDetect` attribute)
- Modify: `src/components/AddModsMenu.tsx` (remove the `includeAutoDetect` prop, its branch, and the now-unused `Search` import)
- Test: `src/views/Mods.test.tsx` (assert auto-detect appears once — as the standalone button, not in the menu)

**Acceptance Criteria:**
- [ ] In the Mod Library, "Auto-detect sources" renders once (the `gf-btn-accent` standalone button), not inside "+ Add mods".
- [ ] `AddModsMenu` no longer has an `includeAutoDetect` prop; no caller references it.
- [ ] `npm test` passes.

**Verify:** `npx vitest run src/views/Mods.test.tsx src/components/AddModsMenu.test.tsx` → green.

**Steps:**

- [ ] **Step 1: Update the test first.** In `Mods.test.tsx`, find the auto-detect assertion (around the `mods.autoDetectSources` label, ~line 94). Make it assert the label appears exactly once and is a standalone button. Example:

```tsx
const label = i18n.t('mods.autoDetectSources');
const matches = screen.getAllByText(label);
expect(matches).toHaveLength(1); // standalone button only — not also in "+ Add mods"
```

Run it; expect FAIL (currently the label can appear in both the standalone button and the open menu — adjust the test to open the "+ Add mods" menu and confirm the item is absent, per existing menu-open helpers).

- [ ] **Step 2: Implement.** In `ModLibraryToolbar.tsx:37` change:

```tsx
<AddModsMenu lib={lib} buttonClassName="gf-btn gf-btn-sm" includeAutoDetect />
```
to
```tsx
<AddModsMenu lib={lib} buttonClassName="gf-btn gf-btn-sm" />
```

In `AddModsMenu.tsx`: remove `includeAutoDetect?: boolean;` from the props interface, the `includeAutoDetect = false,` default, the `{includeAutoDetect && (<KebabItem ...>{t('mods.autoDetectSources')}</KebabItem>)}` block, and the `Search` import (confirm `Search` has no other use in the file first).

- [ ] **Step 3: Run tests — expect PASS.** Check `AddModsMenu.test.tsx` (if present) doesn't assert the auto-detect item; update if it does.

- [ ] **Step 4: Commit.**

```bash
git add -A && git commit -m "fix(mods): dedupe Auto-detect sources in the Mod Library (#135)"
```

---

### Task 4: Fix the share-code layout in non-English locales

**Goal:** Keep the share code readable (no one-char-per-line wrap) regardless of locale by letting the copy buttons wrap to their own row.

**Files:**
- Modify: `src/components/PublishModal.tsx` (~461-491: wrap the three copy `<button>`s in a `.gf-share-code-actions` div)
- Modify: `src/styles.css` (2532-2545: `.gf-share-code` + `.gf-share-code-value`, add `.gf-share-code-actions`)
- Test: `src/components/PublishModal.test.tsx` (assert structure — code value + 3 copy buttons render in the success state)

**Acceptance Criteria:**
- [ ] The share code stays on one line for normal codes; the three copy buttons wrap to a second row when space is tight.
- [ ] No `word-break: break-all` on `.gf-share-code-value`.
- [ ] Verified visually in en + ru + ar and in light + dark themes.
- [ ] `npm test` passes.

**Verify:** `npx vitest run src/components/PublishModal.test.tsx` → green; manual check in Task 9.

**Steps:**

- [ ] **Step 1: JSX — wrap the buttons.** In `PublishModal.tsx`, inside `{shared && (...)}`, wrap the three copy `<button className="gf-btn-2 gf-btn-2-sm">` elements in a container, leaving the `.gf-share-code-text` block as the first child:

```tsx
<div className="gf-share-code">
  <div className="gf-share-code-text">
    <div className="gf-share-code-eyebrow">{t('publish.shareCode')}</div>
    <div className="gf-share-code-value">{shared.owner}/{shared.code}</div>
  </div>
  <div className="gf-share-code-actions">
    {/* the three existing copy buttons, unchanged */}
  </div>
</div>
```

- [ ] **Step 2: CSS.** In `src/styles.css`, replace the `.gf-share-code` / `.gf-share-code-text` / `.gf-share-code-value` rules (2532-2545) with:

```css
.gf-share-code {
  display: flex; align-items: center; gap: 12px;
  flex-wrap: wrap;
  padding: 12px 14px;
  background: var(--indigo-deep); border: 1px solid var(--gf-line);
  border-radius: 8px; margin-bottom: 12px;
}
.gf-share-code-text { display: flex; flex-direction: column; gap: 2px; flex: 1 1 160px; min-width: 0; }
.gf-share-code-eyebrow { font-size: 10.5px; color: var(--ink-dim); text-transform: uppercase; letter-spacing: 0.6px; }
.gf-share-code-value {
  font-family: ui-monospace, "SF Mono", Menlo, monospace;
  font-size: 17px; font-weight: 700; letter-spacing: 0.5px;
  color: var(--gf);
  overflow-wrap: anywhere;
}
.gf-share-code-actions { display: flex; gap: 8px; flex-wrap: wrap; }
```

- [ ] **Step 3: Test the structure.** In `PublishModal.test.tsx`, in (or add to) the success-state test, assert the code value and all three copy buttons render:

```tsx
expect(screen.getByText(`${result.owner}/${result.code}`)).toBeInTheDocument();
expect(screen.getByRole('button', { name: i18n.t('publish.copyCode') })).toBeInTheDocument();
expect(screen.getByRole('button', { name: i18n.t('publish.copyLink') })).toBeInTheDocument();
expect(screen.getByRole('button', { name: i18n.t('publish.copyMessage') })).toBeInTheDocument();
```

Run `npx vitest run src/components/PublishModal.test.tsx`; expected PASS.

- [ ] **Step 4: Commit.**

```bash
git add -A && git commit -m "fix(share): keep share code readable in non-English locales (#135)"
```

---

### Task 5: Out-of-sync detection — backend

**Goal:** Record a published-content fingerprint in `.share` and expose `out_of_sync` so the UI can tell when a shared pack has unpublished changes.

**Files:**
- Modify: `src-tauri/src/sharing/mod.rs` (add `published_signature` to `ShareInfo`; add `profile_publish_signature`; set the signature in `share_profile_impl` + `reshare_profile`; add `out_of_sync` to `ShareResult`; compute it in `get_share_info`)
- Modify: `Cargo.toml` only if `sha2` isn't already a dependency (it almost certainly is — verify with a grep; bundle hashing uses sha256)
- Test: inline `#[cfg(test)]` in `sharing/mod.rs`

**Acceptance Criteria:**
- [ ] `ShareInfo` persists `published_signature: Option<String>` (`#[serde(default)]`); `ShareResult` has `out_of_sync: bool` (`#[serde(default)]`).
- [ ] `profile_publish_signature` is stable across re-serialization and unaffected by `updated_at`/`bundle_url`/`bundle_sha256`, but changes when a mod is added/removed/toggled or its version changes.
- [ ] `get_share_info` returns `out_of_sync = true` after the manifest changes post-publish, `false` right after publish/re-share, and `false` when `published_signature` is absent (legacy `.share`).
- [ ] `cargo test` passes.

**Verify:** `cd src-tauri && cargo test sharing::` → green.

**Steps:**

- [ ] **Step 1: Add the signature struct field.** In `ShareInfo` (sharing/mod.rs ~174), add:

```rust
    /// Fingerprint of the publishable content at last share/re-share.
    /// Lets the UI detect "this owned share has changes not yet pushed".
    /// Absent in `.share` files written before this field existed.
    #[serde(default)]
    published_signature: Option<String>,
```

- [ ] **Step 2: Write the signature function + its test (TDD).** Add a pure function. It hashes the STABLE publishable content only.

```rust
/// A stable fingerprint of the content that actually gets published, so the
/// UI can tell when an owned share has un-pushed local edits. Deliberately
/// excludes volatile / publish-side fields: timestamps and bundle_url/sha
/// (those change on every re-share without the user changing anything).
fn profile_publish_signature(profile: &Profile) -> String {
    use sha2::{Digest, Sha256};
    let mut entries: Vec<String> = profile
        .mods
        .iter()
        .map(|m| {
            format!(
                "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
                m.name,
                m.version,
                m.folder_name.as_deref().unwrap_or(""),
                m.mod_id.as_deref().unwrap_or(""),
                m.enabled,
                m.source.as_deref().unwrap_or(""),
                m.hash.as_deref().unwrap_or(""),
            )
        })
        .collect();
    entries.sort();
    let mut hasher = Sha256::new();
    hasher.update(profile.name.as_bytes());
    hasher.update([0x1e]);
    hasher.update(profile.created_by.as_deref().unwrap_or("").as_bytes());
    hasher.update([0x1e]);
    hasher.update(match profile.public { Some(true) => b"1".as_slice(), _ => b"0".as_slice() });
    for e in entries {
        hasher.update([0x1d]);
        hasher.update(e.as_bytes());
    }
    format!("{:x}", hasher.finalize())
}
```

Add tests in the module's `#[cfg(test)]` block (reuse the existing `make_profile` helper there):

```rust
#[test]
fn signature_ignores_timestamps_and_bundle_fields() {
    let mut a = make_profile("p", None);
    let mut b = make_profile("p", None);
    // Mutate only volatile fields on b.
    b.updated_at = a.updated_at + chrono::Duration::days(1);
    if let Some(m) = b.mods.get_mut(0) { m.bundle_url = Some("https://x/y.zip".into()); }
    assert_eq!(profile_publish_signature(&a), profile_publish_signature(&b));
    // Changing a real field changes the signature.
    if let Some(m) = a.mods.get_mut(0) { m.enabled = !m.enabled; }
    assert_ne!(profile_publish_signature(&a), profile_publish_signature(&b));
}
```

(If `make_profile` produces an empty mod list, add a mod first; mirror the existing reshare tests' fixtures.) Run `cargo test`; expect the new test FAILS to compile until Step 1+2 land, then PASSES.

- [ ] **Step 3: Persist the signature on share + reshare.** In `share_profile_impl` where `ShareInfo { ... }` is built (~690) and in `reshare_profile` where the updated `ShareInfo` is built (~957), add `published_signature: Some(profile_publish_signature(&profile)),`. Use the SAME `profile` that is saved to local JSON (the enriched one) — since the signature excludes bundle fields, enriched vs pre-bundle yields the same value.

- [ ] **Step 4: Add `out_of_sync` to `ShareResult` + compute in `get_share_info`.** Add to the struct (~159):

```rust
    /// True when the local manifest differs from what was last published
    /// (owned shares only). Drives the "Out of sync — Re-share" banner.
    /// Only set by `get_share_info`; fresh share/reshare leaves it false.
    #[serde(default)]
    pub out_of_sync: bool,
```

Set `out_of_sync: false` in the `share_profile_impl` and `reshare_profile` `ShareResult { ... }` returns (they just published). In `get_share_info`, after loading `info`, load the current profile and compute:

```rust
let out_of_sync = match info.published_signature.as_deref() {
    Some(sig) => crate::profiles::load_profile(&name, profiles_path)
        .map(|p| profile_publish_signature(&p) != sig)
        .unwrap_or(false),
    None => false, // legacy .share with no baseline — don't nag until next share
};
```

and include `out_of_sync` in the returned `ShareResult`. (Confirm the exact `load_profile` path/signature; `get_share_info` already has `profiles_path` in scope.)

- [ ] **Step 5: Add a get_share_info round-trip test** (uses temp dirs like the existing `.share` tests in `crud.rs`/`sharing`): write a profile + a `.share` with a matching `published_signature`, assert `out_of_sync == false`; mutate the profile on disk (add a mod), assert `out_of_sync == true`; a `.share` without the field → `false`.

- [ ] **Step 6: Verify + commit.**

```bash
cd src-tauri && cargo test sharing:: && cd ..
git add -A && git commit -m "feat(share): detect unpushed changes via published-content fingerprint (#135)"
```

---

### Task 6: Out-of-sync detection — frontend

**Goal:** Show an "Out of sync — Re-share to push" banner in the modpack detail view whenever the shared pack has unpublished changes.

**Files:**
- Modify: `src/types.ts` (add `out_of_sync?: boolean` to `ShareResult`)
- Modify: `src/components/ModpackDetail.tsx` (render the banner from `shareInfo?.out_of_sync`)
- Modify: `src/i18n/locales/{en,ru,zh-Hans,ar}.json` (add `modpack.detail.outOfSyncTitle`, `modpack.detail.outOfSyncBody`, `modpack.detail.reshareToPush`)
- Test: `src/components/ModpackDetail.test.tsx`

**Acceptance Criteria:**
- [ ] When `shareInfo.out_of_sync` is true, the detail view shows a warn banner with a Re-share button that calls `onShare(profile)`.
- [ ] No banner when `out_of_sync` is false or the pack isn't shared.
- [ ] `npm test` + `npm run qa:i18n` pass.

**Verify:** `npx vitest run src/components/ModpackDetail.test.tsx` → green; `npm run qa:i18n` → green.

**Steps:**

- [ ] **Step 1: Type.** In `src/types.ts`, add to `ShareResult`:

```ts
  /** True when the local manifest has changes not yet pushed to the
   *  published version. Set only by getShareInfo. Drives the detail-view
   *  "Out of sync — Re-share" banner. Optional for older cached results. */
  out_of_sync?: boolean;
```

- [ ] **Step 2: Failing test.** In `ModpackDetail.test.tsx`, render with a `shareInfo` that has `out_of_sync: true` and an `onShare` spy; assert the banner + Re-share button appear and the button calls `onShare`. Add a sibling test asserting NO banner when `out_of_sync` is false. Use the existing render helper / default props in that file.

```tsx
const onShare = vi.fn();
renderDetail({ shareInfo: { ...baseShare, out_of_sync: true }, onShare });
const reshare = screen.getByRole('button', { name: i18n.t('modpack.detail.reshareToPush') });
await userEvent.click(reshare);
expect(onShare).toHaveBeenCalledWith(expect.objectContaining({ name: profile.name }));
```

Run it; expect FAIL.

- [ ] **Step 3: Implement the banner.** In `ModpackDetail.tsx`, derive `const outOfSync = !!shareInfo?.out_of_sync;` near `isShared` (line ~177). Render a banner right under the status line (after the `gf-modpack-detail-status` block, ~717), reusing the existing banner styles:

```tsx
{outOfSync && (
  <div className="gf-banner gf-banner-warn" data-testid="modpack-detail-out-of-sync" style={{ marginBottom: 14 }}>
    <RefreshCw size={16} className="gf-banner-icon" />
    <div style={{ flex: 1 }}>
      <div style={{ fontWeight: 600 }}>{t('modpack.detail.outOfSyncTitle')}</div>
      <div style={{ fontSize: 12, opacity: 0.85 }}>{t('modpack.detail.outOfSyncBody')}</div>
    </div>
    {onShare && (
      <Button variant="secondary" size="sm" onClick={() => onShare(profile)} title={t('profiles.card.reShareTitle')}>
        <Share2 size={14} />
        {t('modpack.detail.reshareToPush')}
      </Button>
    )}
  </div>
)}
```

(`RefreshCw`, `Share2`, `Button` are already imported.)

- [ ] **Step 4: i18n keys** in all 4 locales under `modpack.detail`:
  - en: `"outOfSyncTitle": "Out of sync"`, `"outOfSyncBody": "You've changed this shared modpack since you last published it. Re-share to push the update."`, `"reshareToPush": "Re-share to push"`
  - ru / zh-Hans / ar: translated equivalents.

- [ ] **Step 5: Run tests — expect PASS** (`npx vitest run src/components/ModpackDetail.test.tsx`), then `npm run qa:i18n`.

- [ ] **Step 6: Commit.**

```bash
git add -A && git commit -m "feat(modpacks): out-of-sync banner + re-share on the detail view (#135)"
```

---

### Task 7: `.sts2pack` local export/import — backend

**Goal:** Add Tauri commands that export a modpack to a self-contained `.sts2pack` archive (manifest + bundled mod files) and import one back, reusing the existing bundle/install functions.

**Files:**
- Create: `src-tauri/src/export_import.rs`
- Modify: `src-tauri/src/lib.rs` (`mod export_import;` + register `export_profile_to_sts2pack`, `import_sts2pack`)
- Test: inline `#[cfg(test)]` in `export_import.rs`

**Archive layout:** outer zip (`Stored`) with `profile.json` + `mods/<sanitized key>.zip` (one Deflated per-mod zip).

**Reused functions (verify exact signatures before calling):**
- `crate::sharing::upload::zip_profile_mod_files(pm, mods_path, disabled_path) -> Result<Vec<u8>>` — **note:** `zip_profile_mod_files` is `pub(super)` in `upload.rs`; expose it to the new module either by widening to `pub(crate)` or by adding a thin `pub(crate)` re-export in `sharing/mod.rs`. Do the minimal visibility change.
- `crate::mods::install::install_mod_from_archive(archive_path, mods_path) -> Result<ModInfo>`
- `crate::mods::install::repack_dir_as_zip(src_dir, dest_zip) -> Result<()>` (outer archive; confirm visibility, widen to `pub(crate)` if needed)
- `crate::profiles::{load_profile, save_profile}` and the apply path used by `sharing::install::install_shared_profile` (e.g. `apply_profile_with_pins` / `switch_profile_from_paths`) — mirror how install_shared_profile rebuilds + applies a profile, MINUS auto-subscribe and MINUS marking active.
- Extraction: follow the `zip::ZipArchive` + zip-slip-guarded `zip_entry_outpath` pattern in `sharing/github.rs` `download_bundle`.

**Acceptance Criteria:**
- [ ] `export_profile_to_sts2pack(name, dest_path)` writes a `.sts2pack` containing `profile.json` + a per-mod zip for each pack mod.
- [ ] `import_sts2pack(src_path)` installs every bundled mod and creates a profile matching the manifest (folders, enabled state, membership); auto-suffixes the name on collision (`"Pack (2)"`); preserves `created_by`; does NOT create a `.share`, does NOT auto-subscribe.
- [ ] A round-trip (export then import into a fresh game dir) yields the same mods + pack.
- [ ] `cargo test` passes.

**Verify:** `cd src-tauri && cargo test export_import::` → green.

**Steps:**

- [ ] **Step 1: Scaffold the module + visibility.** Create `src-tauri/src/export_import.rs`; add `mod export_import;` to `lib.rs`. Widen `zip_profile_mod_files` (and `repack_dir_as_zip` if needed) to `pub(crate)`. Confirm `sha2`/`zip`/`tempfile` are available (they are — used by sharing/install).

- [ ] **Step 2: Implement export.** Concrete shape (adjust to real signatures while implementing):

```rust
use std::path::Path;
use crate::profiles::Profile;
use crate::state::AppState;

#[tauri::command]
pub fn export_profile_to_sts2pack(
    name: String,
    dest_path: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<(), String> {
    let (mods_path, disabled_path, profiles_path) = {
        let s = state.lock().map_err(|e| e.to_string())?;
        (s.mods_path.clone(), s.disabled_mods_path.clone(), s.profiles_path.clone())
    };
    let profile = crate::profiles::load_profile(&name, &profiles_path).map_err(|e| e.to_string())?;

    let stage = tempfile::tempdir().map_err(|e| e.to_string())?;
    let mods_dir = stage.path().join("mods");
    std::fs::create_dir_all(&mods_dir).map_err(|e| e.to_string())?;

    let mut used = std::collections::HashSet::new();
    for pm in &profile.mods {
        let bytes = crate::sharing::upload::zip_profile_mod_files(pm, &mods_path, &disabled_path)
            .map_err(|e| format!("Couldn't bundle '{}': {}", pm.name, e))?;
        let mut key = sanitize_file_stem(pm.folder_name.as_deref().unwrap_or(&pm.name));
        // de-dup collisions
        let mut n = 2;
        let base = key.clone();
        while !used.insert(key.clone()) { key = format!("{base}-{n}"); n += 1; }
        std::fs::write(mods_dir.join(format!("{key}.zip")), &bytes).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(&profile).map_err(|e| e.to_string())?;
    std::fs::write(stage.path().join("profile.json"), json).map_err(|e| e.to_string())?;

    crate::mods::install::repack_dir_as_zip(stage.path(), Path::new(&dest_path))
        .map_err(|e| e.to_string())?;
    Ok(())
}
```

Add a private `sanitize_file_stem(&str) -> String` (strip path separators / `..` / control chars; fall back to `"mod"` when empty).

- [ ] **Step 3: Implement import.** Extract to a temp dir (zip-slip-guarded), read `profile.json`, install each `mods/*.zip` via `install_mod_from_archive`, rebuild the profile keyed by the manifest (corrected folder/files from install results — mirror `install_shared_profile`), resolve name collisions, save, apply (no subscribe / no active):

```rust
#[tauri::command]
pub fn import_sts2pack(
    src_path: String,
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Profile, String> {
    // 1. lock → clone mods_path/disabled_path/profiles_path/config_path
    // 2. extract src_path zip → tempdir (reuse the download_bundle extraction
    //    pattern: zip::ZipArchive + zip_entry_outpath guard)
    // 3. read profile.json → Profile (manifest)
    // 4. for each mods/*.zip: install_mod_from_archive(zip, &mods_path)
    // 5. rebuild profile.mods from the manifest, replacing folder_name/files
    //    with the installed ModInfo (mirror sharing::install::install_shared_profile)
    // 6. unique-ify profile.name against existing profiles (load list);
    //    "Name" → "Name (2)" → "Name (3)"
    // 7. save_profile(&profile, &profiles_path)
    // 8. apply onto disk via the same path install_shared_profile uses
    //    (apply_profile_with_pins / switch_profile_from_paths) — but DO NOT
    //    set active_profile and DO NOT create a subscription.
    // 9. return the saved profile (hide_app_created_by if that helper is used elsewhere)
}
```

Keep error messages user-facing (they surface as toasts).

- [ ] **Step 4: Register commands** in `lib.rs` `generate_handler![...]`: `export_import::export_profile_to_sts2pack, export_import::import_sts2pack,`.

- [ ] **Step 5: Round-trip test.** In `export_import.rs` `#[cfg(test)]`, build a temp game dir with two installed mods (one enabled, one disabled — reuse the `write_mod` helper pattern from `drift.rs` tests), a saved profile referencing both, export to a temp `.sts2pack`, then import into a SECOND fresh game/config dir and assert: both mods installed, enabled state preserved, profile mods match, and a name collision produces `"... (2)"`.

- [ ] **Step 6: Verify + commit.**

```bash
cd src-tauri && cargo test export_import:: && cd ..
git add -A && git commit -m "feat(modpacks): .sts2pack local export/import backend (#135)"
```

---

### Task 8: `.sts2pack` local export/import — frontend (takeover)

**Goal:** Replace the clipboard "Export JSON" and paste "Import JSON" flows with file-based `.sts2pack` export (detail Advanced kebab) and import (Modpacks list page).

**Files:**
- Modify: `src/hooks/useTauri.ts` (add `exportProfileToFile`, `importSts2pack`; remove unused `exportProfile`/`importProfile` wrappers)
- Modify: `src/components/ModpackDetail.tsx` (change the Export kebab item to "Export to file…"; update `onExportJson` → `onExportFile` semantics)
- Modify: `src/views/Profiles.tsx` (replace `handleExport` clipboard logic with a save-dialog export; replace the "Import JSON" toggle + paste panel with an "Import from file…" open-dialog; remove `showImport`/`importJson` state, `handleImport`, the import `<Card>` panel; drop unused imports)
- Modify: `src/i18n/locales/{en,ru,zh-Hans,ar}.json` (add export/import-to-file keys; remove obsolete `profiles.actions.importJson`, `profiles.toast.exported`, `profiles.form.jsonLabel/jsonPlaceholder`, `profiles.toast.imported` IF unused after the change — grep first)
- Test: `src/views/Profiles.test.tsx`, `src/components/ModpackDetail.test.tsx`

**Acceptance Criteria:**
- [ ] Detail Advanced kebab shows "Export to file…"; clicking it opens a save dialog and calls `exportProfileToFile(name, path)`.
- [ ] Modpacks list page shows "Import from file…"; clicking it opens an open dialog (`.sts2pack` filter) and calls `importSts2pack(path)` then refreshes.
- [ ] The old clipboard-export and paste-import JSON UIs are gone.
- [ ] `npm test` + `npm run qa:i18n` pass.

**Verify:** `npx vitest run src/views/Profiles.test.tsx src/components/ModpackDetail.test.tsx` → green; `npm run qa:i18n` → green.

**Steps:**

- [ ] **Step 1: Wrappers.** In `useTauri.ts` add:

```ts
export async function exportProfileToFile(name: string, destPath: string): Promise<void> {
  return invoke('export_profile_to_sts2pack', { name, destPath });
}
export async function importSts2pack(srcPath: string): Promise<Profile> {
  return invoke('import_sts2pack', { srcPath });
}
```

Remove `exportProfile` and `importProfile` (no callers remain after this task).

- [ ] **Step 2: Detail export.** In `ModpackDetail.tsx`, rename the prop `onExportJson` → `onExportFile` (and update the destructure + the KebabItem label to `t('profiles.kebab.exportFile')`, keep the `Copy`→ use a `Download`/`FileDown` icon already imported or add one). The KebabItem calls `onExportFile?.(profile.name)`.

- [ ] **Step 3: Profiles export handler.** In `Profiles.tsx`, replace `handleExport` body with a save-dialog flow:

```tsx
import { save, open } from '@tauri-apps/plugin-dialog';
// ...
async function handleExportFile(name: string) {
  try {
    const dest = await save({
      defaultPath: `${name}.sts2pack`,
      filters: [{ name: 'STS2 Modpack', extensions: ['sts2pack'] }],
    });
    if (!dest) return; // user cancelled
    await exportProfileToFile(name, dest);
    toastCtx.success(t('profiles.toast.exportedFile', { name }));
  } catch (e) {
    toastCtx.error(t('profiles.toast.exportFailed', { error: e instanceof Error ? e.message : String(e) }));
  }
}
```

Wire `onExportFile={handleExportFile}` on `<ModpackDetail>`.

- [ ] **Step 4: Profiles import.** Replace the "Import JSON" header `<Button>` (which toggled `showImport`) with an "Import from file…" button that calls a new `handleImportFile`, and DELETE the `{showImport && (<Card>...textarea...</Card>)}` panel + the `showImport`/`importJson` state + `handleImport`:

```tsx
async function handleImportFile() {
  try {
    const src = await open({ multiple: false, filters: [{ name: 'STS2 Modpack', extensions: ['sts2pack'] }] });
    if (!src || Array.isArray(src)) return;
    const profile = await importSts2pack(src);
    setProfiles((prev) => [...prev, profile]);
    toastCtx.success(t('profiles.toast.importedModpack', { name: profile.name, count: profile.mods.length }));
  } catch (e) {
    toastCtx.error(t('profiles.toast.importFailed', { error: e instanceof Error ? e.message : String(e) }));
  }
}
```

Header button:

```tsx
<Button variant="secondary" size="sm" onClick={handleImportFile}>
  <Upload size={14} />
  {t('profiles.actions.importFile')}
</Button>
```

Remove now-unused imports (`exportProfile`, `importProfile`) and the `showImport`/`importJson`/`handleImport` symbols.

- [ ] **Step 5: i18n.** Add to all 4 locales:
  - `profiles.actions.importFile` (en: "Import from file"), `profiles.kebab.exportFile` (en: "Export to file…"), `profiles.toast.exportedFile` (en: "Exported \"{{name}}\" to file"). Keep `profiles.toast.importedModpack`, `importFailed`, `exportFailed` (already exist).
  - Remove keys that are now unreferenced after grepping the codebase: `profiles.actions.importJson`, `profiles.toast.exported`, `profiles.form.jsonLabel`, `profiles.form.jsonPlaceholder` (note `jsonPlaceholder` is in `SAME_AS_ENGLISH_ALLOWED` — also remove it from that allowlist in `parity.test.ts`), and `profiles.toast.imported` if unused. Add translations for the new keys in ru/zh-Hans/ar.

- [ ] **Step 6: Tests.** Mock `@tauri-apps/plugin-dialog` in the test (or extend the existing mock in `setup.ts`). In `ModpackDetail.test.tsx`, assert the Advanced kebab "Export to file…" item calls `onExportFile`. In `Profiles.test.tsx`, replace the old import-JSON / export-JSON tests with: clicking "Import from file" calls `open` then `importSts2pack` and adds the profile; the detail "Export to file…" path calls `save` then `exportProfileToFile`. Use loud lookups; assert the invoked args.

```tsx
// setup.ts (or local mock):
vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn().mockResolvedValue('/tmp/Pack.sts2pack'),
  open: vi.fn().mockResolvedValue('/tmp/Pack.sts2pack'),
}));
```

- [ ] **Step 7: Verify + commit.**

```bash
npm run qa:i18n && npx vitest run src/views/Profiles.test.tsx src/components/ModpackDetail.test.tsx
git add -A && git commit -m "feat(modpacks): .sts2pack file export/import takes over JSON buttons (#135)"
```

---

### Task 9: Cross-cutting verification & manual QA

**Goal:** Confirm the whole branch is green and the visual fixes (items 1, 4) hold in light theme + RTL.

**Files:** none (verification only)

**Acceptance Criteria:**
- [ ] `npm test`, `npm run qa:i18n`, `npm run build` all pass.
- [ ] `cargo test` (from `src-tauri/`) passes.
- [ ] Manual: share-code dialog renders the code on one line with copy buttons wrapping, in en + ru + ar, light + dark.
- [ ] Manual: editing a shared pack shows the out-of-sync banner; Re-share clears it.
- [ ] Manual: export a pack to `.sts2pack` and import it on a clean mods dir → same mods + pack.

**Verify:** all commands above green; manual checks done.

**Steps:**

- [ ] **Step 1: Full automated suite.**

```bash
npm run qa:i18n && npm test && npm run build
(cd src-tauri && cargo test)
```

- [ ] **Step 2: Manual QA.** Run the app (`npm run tauri dev` or the project's run skill). Switch locale to Russian then Arabic (Settings → language) and open Share on a pack to check the code layout in both themes (toggle theme in Settings). Edit a shared pack and confirm the out-of-sync banner + Re-share. Export a pack, import the `.sts2pack` into a fresh state.

- [ ] **Step 3: Final commit (if any tweaks).**

```bash
git add -A && git commit -m "chore(#135): cross-cutting verification fixes"
```

---

## Self-Review

**Spec coverage:** Item 1 (out-of-sync) → Tasks 5+6. Item 2 (remove Snapshot) → Task 1. Item 3 (wizard option) → Task 2. Item 4 (auto-detect dedup) → Task 3. Item 5 (share-code layout) → Task 4. Item 6 (`.sts2pack`) → Tasks 7+8. i18n + manual QA → woven in + Task 9. All spec sections covered.

**Type consistency:** `profile_publish_signature` (Rust) used in Tasks 5 only; `out_of_sync` field name consistent across Rust `ShareResult`, TS `ShareResult`, and the banner read. `exportProfileToFile`/`importSts2pack` (TS) match `export_profile_to_sts2pack`/`import_sts2pack` (Rust commands) with `destPath`/`srcPath` arg casing matching Tauri's auto camelCase mapping. `onExportFile` prop renamed consistently (ModpackDetail + Profiles).

**Known implementation-time verifications (not placeholders):** exact `load_profile`/apply signatures and `zip_profile_mod_files`/`repack_dir_as_zip` visibility (Task 7 names the files to confirm); whether `profiles.toast.imported` is still referenced (Task 8 greps before removing). These are confirm-then-act, not undefined logic.
