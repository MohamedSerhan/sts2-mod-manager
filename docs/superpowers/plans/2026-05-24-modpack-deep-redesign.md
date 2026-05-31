# STS2 Mod Manager 1.7.0 — Deep Redesign Plan (v2)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers-extended-cc:subagent-driven-development.
> This plan SUPERSEDES the incremental tasks 8-12 of `2026-05-23-modpack-ux-simplification.md`. Tasks 1-7 from that plan are committed and remain the foundation.

**Goal:** Ship v1.7.0 — a Paradox-launcher-simple mod manager. Shrink the visual surface drastically. Make Home the only page 90% of users ever touch. Hide power-user features behind progressive disclosure. Re-architect god-components and the largest Rust files. Remove any feature that competes with the "switch modpack and play" flow without justifying its existence.

**Why a v2 plan:** v1 (tasks 1-7) was largely vocabulary + chips + one new wizard. User feedback after v1: *"the app still mostly seems the same and very complicated."* The Paradox launcher screenshots show a 5-item sidebar where each screen does one thing. Our app currently has a 7-item sidebar where each screen does 6+ things. v2 fixes that.

**No-restriction directive:** The user explicitly removed constraints — visual redesign OK, Rust file splits OK, prop/component renames OK, feature relocations OK, anything that serves simplicity. The only hard constraints remain: no feature **removed** (all reachable somewhere), no internal data-model rename (profile JSON format unchanged), no test regressions.

**Tech Stack:** No new deps. Existing React 19 / Tauri 2 / react-i18next / Vitest stack.

**Spec:** `docs/superpowers/specs/2026-05-23-modpack-ux-simplification-design.md` (already in repo).

**Worktree:** `C:\Users\xxsku\repos\sts2-mod-manager\.claude\worktrees\happy-lovelace-2ad8bc` on `claude/happy-lovelace-2ad8bc`.

---

## What v1 (tasks 1-7) accomplished — foundation

- `modpack.*` i18n vocabulary (singular/plural/storage/membership) — reusable.
- Mods view shows storage + membership chips per row — disambiguates Solo's confusion case.
- Modpacks view (renamed from Profiles in user copy) uses "In this modpack" / "Stored" wording.
- Home has a launcher-style hero with empty-state CTAs and Play.
- Help view replaces Tutorial with FAQ section structure.
- `CreateModpackWizard` exists as a guided 4-step modal.
- `ShareSetupPanel` explains GitHub inline when sharing.

**What v1 did NOT do:** shrink the navigation, collapse per-row actions, restructure the Modpacks page into a detail-driven layout, extract god-components, or touch Rust.

---

## v2 design principles

1. **One thing per screen.** Home plays the game. Modpacks manages packs. Library lists mods. Settings has knobs. That's it.
2. **Progressive disclosure.** Click a modpack to see its mods. Click a mod row to see its source/audit/repair drawer. Click "Advanced" to see destructive actions. Never show everything at once.
3. **Default to the simple path.** Per-row toggles and kebab menus exist but they're not the primary visible UI. The primary visible action is whatever the user usually wants.
4. **No competing entry points.** "Create modpack" lives in one place. "Share" lives in one place. "Audit" lives in one place. Today the same action lives 3 places.
5. **Help is contextual, not navigational.** Help leaves the sidebar. A "?" topbar icon opens a Help drawer with FAQ. Inline `<HelpHint>` "?" icons explain confusing states where they appear.
6. **Test what you ship.** Every UI change has a test. No `if (btn) { click(btn) }`. Coverage stays at thresholds or rises.

---

## New top-level information architecture

### Sidebar — shrinks from 7 to 4 items

| Today | v2 |
|------|-----|
| Home | **Home** |
| Profiles (= Modpacks) | **Modpacks** (absorbs Browse Modpacks as a tab) |
| Mods | **Library** (rename; absorbs Browse Mods as a tab) |
| Browse Mods | ⟶ Library → Browse tab |
| Browse Modpacks | ⟶ Modpacks → Browse tab |
| Tutorial (= Help) | ⟶ Topbar `?` icon + Settings → Help tab |
| Settings | **Settings** |

Total: **4 sidebar items**.

### Topbar — gains Help icon

- Profile chip (existing) — switches active modpack.
- Launch button (existing).
- **NEW**: `?` icon → opens HelpDrawer with player + creator quick-start + FAQ.
- Window controls (existing).

### Home — single-block launcher

| Today | v2 |
|------|-----|
| Hero (5 sections inside) + Quick-Add card + Other Packs + Pending Updates banner + Empty state | **ONE block**: active modpack name → Play. Contextual pills (sync / not shared / drift). |
| | When no active modpack: ONE block with "Pick a modpack" → opens Modpacks page. |

Quick-Add code paste relocates to **Modpacks page** (it belongs to modpack management, not to "play the game").

### Modpacks — list with detail drill-down

- **List view:** cards with modpack name, mod count, sync state, share state. Click → detail view.
- **Detail view:** opens inline (or full-page replacement). Shows modpack metadata, mod editor (existing `LibraryTable` extracted), audit summary, Share button, Advanced section (delete, export JSON, snapshot, load order edit).
- **Top toolbar:** Create modpack (opens wizard from v1 task 6), Add modpack code (existing).
- **Tabs:** "Yours" / "Browse" (absorbs Browse Modpacks).
- The old "Mod Library workspace" as a separate concept **goes away**. It's now just the per-modpack mod editor inside detail view.

### Library — clean list of all installed mods

- One page, one purpose: see every mod installed on disk, manage its state.
- **Row:** mod name + version + state chips (`Active`/`Stored`, `In this modpack`/`Not in this modpack`) + ONE kebab menu.
- **Kebab actions:** Toggle active/stored, View sources, Audit, Open folder, Freeze, Repair, Rollback, Delete (Advanced section).
- **Click a row** → expands inline drawer with source pills + audit details + update pill.
- **Tabs:** "Installed" / "Browse" (absorbs Browse Mods).
- The `<ModRow>` component gets extracted from Mods.tsx (per code review).

### Settings — absorbs Help

- Tabs: General, Accounts, Backups, **Help** (new tab, content from Help view), Advanced.
- Game settings remain General. Diagnostic bundle stays Advanced.

---

## Tasks

Twelve tasks total. T13 from v1 (missing-bundles UX) remains. Tasks below are new (T14-T18) plus expansions of T8-T12 from v1.

| # | Task | Risk |
|---|------|------|
| T14 | Sidebar shrink + topbar Help icon + new IA scaffolding | High |
| T15 | Home → single-block launcher (deeper than v1 T4) | Medium |
| T16 | Modpacks detail-driven restructure + extract LibraryTable | High |
| T17 | Library (renamed from Mods) per-row simplification + extract ModRow | High |
| T18 | Code re-architecture: split sharing.rs + mods.rs, extract ProfileActionsMenu, useClipboard, reqwest timeouts, deep-link regex, DiagnosticBundle redaction | High |
| T9 | Per-row action collapse + AdvancedSection component (was v1 T9; expanded to include Solo's "Disable in Game" removal) | Medium |
| T8 | Onboarding deep redesign (was v1 T8; expanded for new IA) | Medium |
| T13 | Missing-bundles publish error UX (already created from user feedback) | Low |
| T10 | HelpHint + topbar Help drawer + consistency pass (was v1 T10) | Medium |
| T11 | zh-Hans translation parity sweep (was v1 T11) | Low |
| T12 | Quality gates + responsive smoke + version bump 1.7.0 (was v1 T12) | Gate |

**Dependency graph:**

- T14 blocks T15, T16, T17 (everything reroutes around new IA).
- T16 unlocks T9 (per-row collapse in Modpacks).
- T17 unlocks T9 (per-row collapse in Library).
- T15, T16, T17, T8 unlock T10 (contextual help wiring).
- T18 mostly independent — can run after T17 or in parallel.
- T13 independent.
- T11 depends on all UI tasks completing.
- T12 depends on T11.

---

## T14 — Sidebar shrink + Topbar Help icon

**Goal:** Reduce sidebar from 7 items to 4 (Home, Modpacks, Library, Settings). Move Browse Modpacks into Modpacks as a tab. Move Browse Mods into Library as a tab. Move Help out of sidebar entirely; add a `?` topbar icon that opens a `HelpDrawer`.

**Files:**
- Modify: `src/App.tsx` (NAV array shrinks; FOOT_NAV loses Tutorial; add HelpDrawer state + trigger).
- Modify: `src/App.test.tsx` (assertion cascade).
- Create: `src/components/HelpDrawer.tsx` + `.test.tsx` (slide-out panel with FAQ; reuses Help view content via shared component).
- Modify: `src/views/Help.tsx` — refactor so its content sections can be embedded inside HelpDrawer AND remain reachable via Settings → Help tab. Likely extract `<HelpContent />` as a shared subcomponent.
- Modify: `src/views/Modpacks.tsx` (was Profiles.tsx — keep filename; just user-facing label) — add internal tabs "Yours" / "Browse" where Browse renders the existing `BrowseModpacksView` content.
- Modify: `src/views/Library.tsx` (was Mods.tsx — keep filename for now; just user-facing label) — add internal tabs "Installed" / "Browse" where Browse renders existing `BrowseView` content.
- Modify: `src/views/Settings.tsx` — add "Help" tab containing `<HelpContent />`.
- Delete: `src/views/Browse.tsx` as a top-level route (file becomes a subcomponent in Library) — OR keep file, just remove sidebar entry.
- Modify: `src/i18n/locales/en.json` + `zh-Hans.json` — relabel `nav.mods` → "Library", remove unused nav entries, add `topbar.help` label.

**Acceptance Criteria:**
- Sidebar visibly has 4 main items: Home, Modpacks, Library, Settings. No Browse Mods, Browse Modpacks, or Help/Tutorial in the sidebar.
- Topbar shows a `?` Help icon between the profile chip and the Launch buttons (or wherever fits the existing layout).
- Clicking `?` opens HelpDrawer (slide-out from the right) showing player + creator quick starts + FAQ.
- Modpacks view has "Yours" / "Browse" tabs; Browse tab renders existing BrowseModpacks UI.
- Library view has "Installed" / "Browse" tabs; Browse tab renders existing Browse UI.
- Settings has a Help tab with the same content the topbar drawer shows.
- All existing routes still reachable; no regressions.
- All tests green.

**Verify:** `npx vitest run`

**Steps:**

1. **Read the current nav** (App.tsx lines 50-60).
2. **Extract `<HelpContent />`** from current `Help.tsx` (it has 3 sections — Player QS, Creator QS, FAQ).
3. **Build `HelpDrawer`** as a slide-out panel using existing modal-backdrop styling. Tests: opens on click, closes on Escape/backdrop click, renders HelpContent.
4. **Add `?` icon to topbar** — between profile chip and Launch buttons. Use `HelpCircle` from lucide.
5. **Shrink NAV array** in App.tsx — keep only `home`, `profiles` (label: "Modpacks"), `mods` (label: "Library"), `settings`.
6. **Remove `browse-mods`, `browse-modpacks`, `tutorial` from NAV + FOOT_NAV**. Their view-ids may stay in the `View` type union temporarily for backward compat (but no UI to trigger them).
7. **Add tabs to Modpacks (Profiles.tsx)**: "Yours" (default) / "Browse" — Browse renders the existing BrowseModpacksView content as a child component.
8. **Add tabs to Library (Mods.tsx)**: "Installed" (default) / "Browse" — Browse renders existing BrowseView content as a child component.
9. **Add Help tab to Settings.tsx** — renders `<HelpContent />`.
10. **Delete `Help.tsx` view** OR keep it as a thin wrapper that renders `<HelpContent />` (only relevant if the `'tutorial'` view-id is ever activated; otherwise unreachable).
11. **i18n updates**: relabel `nav.mods` to "Library" / "模组库". Add `topbar.help` to en + zh.
12. **Run tests, fix cascades.**
13. **Commit.**

```json:metadata
{"files": ["src/App.tsx", "src/App.test.tsx", "src/components/HelpDrawer.tsx", "src/components/HelpDrawer.test.tsx", "src/views/Help.tsx", "src/views/Profiles.tsx", "src/views/Mods.tsx", "src/views/Settings.tsx", "src/i18n/locales/en.json", "src/i18n/locales/zh-Hans.json"], "verifyCommand": "npx vitest run", "acceptanceCriteria": ["Sidebar shrinks to 4 items: Home/Modpacks/Library/Settings", "Topbar has ? icon opening HelpDrawer", "Modpacks has Yours/Browse tabs", "Library has Installed/Browse tabs", "Settings has Help tab", "All existing routes reachable somewhere", "All tests green"]}
```

---

## T15 — Home single-block launcher (deeper)

**Goal:** Strip Home to a single hero block + contextual pills. No competing Quick-Add card, no separate Other Packs card, no Pending Updates anywhere except in the hero. Moves Quick-Add code paste to the Modpacks page where it belongs.

**Files:**
- Modify: `src/views/Home.tsx` — remove Quick-Add card + Other Packs section + any remaining secondary cards. Hero is the whole page.
- Modify: `src/views/Home.test.tsx`
- Modify: `src/views/Profiles.tsx` — add Quick-Add code paste to the Modpacks page toolbar.
- Modify: `src/views/Profiles.test.tsx`
- Modify: `src/i18n/locales/en.json` + `zh-Hans.json` — wording may shift; `home.*` shrinks substantially.

**Acceptance Criteria:**
- Home shows ONLY: active modpack hero (name + mod count + Play + Switch dropdown + contextual pills) OR empty-state hero (when no active modpack, with link to Modpacks).
- No Quick-Add input on Home. No Other Packs list. No Pending Updates banner. No "Browse" CTA (Browse moves to Modpacks tab).
- Modpacks page has a Quick-Add code paste input in its toolbar.
- "Other modpacks" still visible inside the Modpacks page (it's the full list there).
- Tests cover the single-block hero in both states.

**Verify:** `npx vitest run src/views/Home.test.tsx src/views/Profiles.test.tsx`

```json:metadata
{"files": ["src/views/Home.tsx", "src/views/Home.test.tsx", "src/views/Profiles.tsx", "src/views/Profiles.test.tsx", "src/i18n/locales/en.json", "src/i18n/locales/zh-Hans.json"], "verifyCommand": "npx vitest run src/views/Home.test.tsx src/views/Profiles.test.tsx", "acceptanceCriteria": ["Home is single-block hero only", "No Quick-Add input on Home", "No Other Packs list on Home", "No Pending Updates banner on Home", "Modpacks page has Quick-Add code paste input", "Tests cover hero states"]}
```

---

## T16 — Modpacks detail-driven restructure

**Goal:** Convert Modpacks view from "list + inline workspace + tabs" into "list of cards with detail drill-down". Click a modpack → opens a detail view showing the modpack's mods (editable), audit summary, share button, and an Advanced section. Eliminates "Mod Library workspace" as a separate concept — it's now the per-modpack editor.

**Files:**
- Modify: `src/views/Profiles.tsx` (big — restructure list view + add detail view route)
- Create: `src/components/ModpackDetail.tsx` + `.test.tsx` — detail view component.
- Create: `src/components/LibraryTable.tsx` + `.test.tsx` — extracted from current Profiles.tsx Mod Library workspace (lines ~885-1093 + ~1150-1660). Reusable as the per-modpack mod editor.
- Modify: `src/views/Profiles.test.tsx` — major restructure.
- Modify: `src/i18n/locales/en.json` + `zh-Hans.json` — new keys for detail view.

**Acceptance Criteria:**
- Modpacks list view shows cards (name, mod count, share state, active indicator, sync indicator). Each card is clickable.
- Click a card → opens ModpackDetail (inline or full-replace; pick one based on existing pattern). Detail shows:
  - Header with modpack name + Switch/Activate button + Share button + Back link.
  - Body: LibraryTable for the per-modpack mod editor (replaces the old "Mod Library workspace").
  - Audit summary section.
  - Advanced collapsible section: Delete, Duplicate, Export JSON, Load Order, Snapshot.
- The standalone "Mod Library" inside Modpacks page goes away — it lives inside detail view now.
- LibraryTable is extracted as a reusable component with clear prop interface.
- All existing modpack actions still reachable (just relocated to detail view or Advanced section).
- Tests cover list + detail navigation + each detail action.

**Verify:** `npx vitest run src/views/Profiles.test.tsx src/components/ModpackDetail.test.tsx src/components/LibraryTable.test.tsx`

```json:metadata
{"files": ["src/views/Profiles.tsx", "src/views/Profiles.test.tsx", "src/components/ModpackDetail.tsx", "src/components/ModpackDetail.test.tsx", "src/components/LibraryTable.tsx", "src/components/LibraryTable.test.tsx", "src/i18n/locales/en.json", "src/i18n/locales/zh-Hans.json"], "verifyCommand": "npx vitest run src/views/Profiles.test.tsx src/components/ModpackDetail.test.tsx src/components/LibraryTable.test.tsx", "acceptanceCriteria": ["Modpacks list shows clickable cards", "Detail view shows modpack mods + audit + share + Advanced", "LibraryTable extracted as reusable component", "Mod Library workspace as standalone is gone (now per-modpack editor)", "All actions reachable", "Tests cover list + detail flows"]}
```

---

## T17 — Library (renamed from Mods) per-row simplification + extract ModRow

**Goal:** Library view becomes a clean list of all installed mods. Each row shows minimum info + ONE kebab. Click row to expand inline drawer for sources/audit/details. Extract `ModRow` as a reusable component (per code review).

**Files:**
- Modify: `src/views/Mods.tsx` (big — restructure rows, extract subcomponents)
- Create: `src/components/ModRow.tsx` + `.test.tsx`
- Modify: `src/views/Mods.test.tsx`
- Modify: `src/i18n/locales/en.json` + `zh-Hans.json`

**Acceptance Criteria:**
- Each row shows: mod name + version + state chips (storage + membership from v1) + ONE kebab menu.
- Click row → expands inline drawer with source pills, audit details (update pill, blocked-by-game-version, frozen badge), per-mod actions (open folder, view sources, edit, repair, rollback, freeze, skip update, delete).
- The current "advanced toggle" at the top of Mods.tsx (which currently reveals per-row source pills + Freeze/Delete inline) is removed — these all live inside the row drawer now.
- All current actions are reachable.
- ModRow is a tested standalone component.
- Per-row state chips remain (storage + membership from v1 — Task 2's work).
- The current per-row "Disable in Game" / "Active in game folder" button (Solo's complaint) is removed from the row's primary visible area — toggle is in the kebab.

**Verify:** `npx vitest run src/views/Mods.test.tsx src/components/ModRow.test.tsx`

```json:metadata
{"files": ["src/views/Mods.tsx", "src/views/Mods.test.tsx", "src/components/ModRow.tsx", "src/components/ModRow.test.tsx", "src/i18n/locales/en.json", "src/i18n/locales/zh-Hans.json"], "verifyCommand": "npx vitest run src/views/Mods.test.tsx src/components/ModRow.test.tsx", "acceptanceCriteria": ["Each row: name + version + chips + ONE kebab", "Click row expands inline drawer with all per-mod details", "ModRow extracted as tested component", "Per-row Disable in Game button removed; toggle is in kebab", "All actions reachable", "No advanced toggle at top of Library (drawer handles it)"]}
```

---

## T18 — Code re-architecture

**Goal:** Address the code review items now in scope: extract `ProfileActionsMenu` + `useClipboard` hook, split `sharing.rs` and `mods.rs` into smaller modules, add reqwest timeouts, tighten deep-link regex, add token-pattern redaction in DiagnosticBundle.

**Files:**
- Create: `src/hooks/useClipboard.ts` + `.test.ts`
- Create: `src/components/ProfileActionsMenu.tsx` + `.test.tsx` — extracted from Profiles.tsx kebab actions (lines ~1590-1656).
- Modify: `src/views/Home.tsx`, `src/views/Profiles.tsx` — use `useClipboard` hook.
- **Rust** — split `src-tauri/src/sharing.rs` (4680 lines) into:
  - `src-tauri/src/sharing/mod.rs` — re-exports + public API surface unchanged.
  - `src-tauri/src/sharing/code.rs` — share-code generation/parsing/validation.
  - `src-tauri/src/sharing/github.rs` — GitHub Gist/repo/release API calls.
  - `src-tauri/src/sharing/upload.rs` — asset upload (bundling, retry, GC).
- **Rust** — split `src-tauri/src/mods.rs` (3934 lines) into:
  - `src-tauri/src/mods/mod.rs` — re-exports.
  - `src-tauri/src/mods/install.rs` — zip extract, manifest parse, install.
  - `src-tauri/src/mods/scan.rs` — fs scan, hashing.
  - `src-tauri/src/mods/state.rs` — enable/disable + state queries.
- **Rust** — add `.timeout(Duration::from_secs(60))` + `.connect_timeout(Duration::from_secs(10))` to every reqwest::Client::builder() call (`src-tauri/src/download.rs`, Nexus client, GitHub client).
- Modify: `src/lib/shareImport.tsx` — tighten regex from `/^[a-z]+\//i` to `/^(import|install|load)\//i` at line ~42.
- Modify: `src/components/DiagnosticBundle.tsx` — add token-pattern redaction passes to `redact()` (line ~29): `gh[pousr]_[A-Za-z0-9]{36,}`, `github_pat_[A-Za-z0-9_]{82}`, query-string keys (`[?&](api[_-]?key|key|token|access_token)=[^&\s]+`).

**Acceptance Criteria:**
- `useClipboard` hook centralizes the navigator.clipboard + toast + setCopied(null) pattern; used in both Home and Profiles where the existing 5-line repetition occurs.
- `ProfileActionsMenu` extracted with clear prop interface, replaces the duplicated kebab JSX in Profiles.tsx.
- `sharing.rs` and `mods.rs` split into module directories with `mod.rs` re-exports. **No public API changes** — Tauri command names, return types, lib.rs handler registry all unchanged.
- `cargo check` + `cargo test` green after the split.
- reqwest builders have 60s timeout + 10s connect_timeout.
- shareImport regex rejects unknown prefixes (e.g. `sts2mm://foo/abc-def-ghi` is no longer silently treated as `import/foo/abc-def-ghi`; user sees a "didn't recognize" toast).
- DiagnosticBundle redactor strips GitHub OAuth tokens and query-string API keys before clipboard write.
- All tests green; full coverage thresholds maintained.

**Verify:** `cargo check --manifest-path=src-tauri/Cargo.toml && cargo test --manifest-path=src-tauri/Cargo.toml && npx vitest run`

```json:metadata
{"files": ["src/hooks/useClipboard.ts", "src/hooks/useClipboard.test.ts", "src/components/ProfileActionsMenu.tsx", "src/components/ProfileActionsMenu.test.tsx", "src/views/Home.tsx", "src/views/Profiles.tsx", "src-tauri/src/sharing/mod.rs", "src-tauri/src/sharing/code.rs", "src-tauri/src/sharing/github.rs", "src-tauri/src/sharing/upload.rs", "src-tauri/src/mods/mod.rs", "src-tauri/src/mods/install.rs", "src-tauri/src/mods/scan.rs", "src-tauri/src/mods/state.rs", "src-tauri/src/download.rs", "src/lib/shareImport.tsx", "src/components/DiagnosticBundle.tsx"], "verifyCommand": "cargo check --manifest-path=src-tauri/Cargo.toml && cargo test --manifest-path=src-tauri/Cargo.toml && npx vitest run", "acceptanceCriteria": ["useClipboard hook extracted + used in Home + Profiles", "ProfileActionsMenu extracted", "sharing.rs split into 4 files (mod/code/github/upload)", "mods.rs split into 4 files (mod/install/scan/state)", "reqwest has 60s timeout + 10s connect_timeout", "shareImport regex tightened to whitelist", "DiagnosticBundle redacts GitHub tokens + query-string API keys", "cargo + vitest all green", "no public API changes (Tauri command names + types unchanged)"]}
```

---

## T9 (expanded) — Per-row action collapse + AdvancedSection component

(Carried over from v1 with expanded scope.) Build `<AdvancedSection>` component. Wrap power-user actions inside all views (Modpacks Advanced section in detail view, Library row drawer's Advanced sub-section, Settings Advanced tab).

This task's scope SHRINKS because T16 and T17 already moved most per-row actions into kebab/drawer. T9 just adds the `<AdvancedSection>` wrapper for the truly destructive ones (Delete, Export JSON, Load Order edit, Bulk delete).

---

## T8 (expanded) — Onboarding deep redesign

(Carried over from v1 with expanded scope.) First-launch overlay: ONE question — Player or Creator. Each path walks through 2-3 cards explaining the new IA + giving one action. GitHub introduced ONLY at share time (T7 + T13 handle that). Branded as "Welcome" instead of "Onboarding" copy.

---

## T13 — Missing-bundles publish error UX

(Already created from Solo's bug report.) Inline panel + Repair button + auto-retry.

---

## T10 (expanded) — HelpHint + topbar Help drawer + consistency pass

(Carried over from v1 with expanded scope.) Build `<HelpHint>` "?" component. Place at key spots: Library row chips ("What is Stored?"), Modpacks detail Audit ("What does Audit do?"), Share setup ("Why GitHub?"). The topbar HelpDrawer from T14 is the canonical Help surface. Consistency pass: standardize empty-state markup, button variants, kebab placement across views.

---

## T11 — zh-Hans translation parity sweep

(Carried over from v1.) Final pass to ensure all new and modified strings have natural Chinese translations. Run `npm run qa:i18n`. Prune unused keys (`tutorial.*`, `home.pendingUpdates*`, `publish.tokenRequired/Explanation/openSettings`, `mods.title`, etc.).

---

## T12 — Quality gates + responsive smoke + version bump

(Carried over from v1.) tsc, cargo check, cargo test, vitest with thresholds (ratchet branches back to 91), qa:i18n. Manual responsive smoke at wide/medium/narrow. Bump to 1.7.0 via release script.

**USER-ORDERED GATE — NON-SKIPPABLE.**

---

## Process

- TDD inside each task.
- One task → one commit (or one stack of related commits with clear prefixes).
- Surface large IA moves (T14, T16, T17) for review checkpoints BEFORE merging.
- Coverage thresholds maintained at each task close.
- Worktree-first; no main branch touches.

## Risk register

- **T14 sidebar shrink** has the highest cascade risk — every test that navigates to a removed nav item breaks. Plan: keep view-ids in the union type union so JSX routing still works for whatever's left; just remove sidebar entries.
- **T16 Modpacks restructure** is the biggest single component rewrite. Plan: extract LibraryTable BEFORE rewriting Profiles.tsx so the change feels like "swap one big chunk for the new chunk + use the extracted component".
- **T18 Rust split** has zero behavioral change but a big surface area for compile errors. Plan: split one file at a time, run `cargo check` between each, never combine splits into one commit.
- **T13 missing-bundles** depends on accurate Rust error string matching. Plan: prefer adding a structured error variant in Rust over fragile regex match on the error message.

## Done when

The 10 acceptance criteria in the goal condition still hold, AND:

- Sidebar has 4 items.
- Home is a single hero block.
- Modpacks detail-driven; LibraryTable extracted.
- Library per-row simplified; ModRow extracted.
- sharing.rs + mods.rs split.
- reqwest has timeouts.
- DiagnosticBundle redacts tokens.
- Help is a topbar drawer + Settings tab — not a sidebar item.
- 1.7.0 ships.
