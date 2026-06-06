# Scenario index

| ID | Title | Tier | User | Flow(s) | Hist. bug | Status |
|---|---|---|---|---|---|---|
| [001](001-baselib-bom-shows-real-version.md) | BaseLib BOM manifest yields the real version | 1 | player | 1, 3, 8 | #2 | active |
| [002](002-two-same-named-mods-stay-distinct.md) | Two CardArtEditor folders stay distinct on toggle | 1 | player | 1, 5, 6 | #1 | active |
| [003](003-pin-survives-modpack-apply.md) | Pinned mod survives a modpack apply | 1 | player | 7, 11 | — | active |
| [004](004-downloads-watcher-respects-pin.md) | Downloads-watcher respects pin | 1 | player | 4, 7 | #32 | active |
| [005](005-install-pipeline-preserves-bom-version.md) | install_mod_from_zip preserves BOM-manifest version | 1 | player | 3, 4 | #2 | active |
| [006](006-toggle-moves-mod-to-disabled.md) | Toggling a mod off moves it to mods_disabled/ | 2 | player | 5 | — | active |
| [007](007-audit-count-against-cassette.md) | Audit reports the cassette's expected pending count | 2 | player | 9 | — | active |
| [008](008-pin-suppresses-pending-update.md) | Pinning drops a mod from the audit pending count | 2 | player | 7, 9 | — | active |
| [009](009-delete-mod-removes-from-disk.md) | Deleting a mod removes both row and folder | 2 | player | 6 | — | active |
| [010](010-create-profile-via-ui.md) | "New profile" creates a profile and shows it in the list | 2 | player | 10 | — | active |

## Coverage map

Cross-referenced against [walkthrough-findings.md](../walkthrough-findings.md):

### Player flows
- Flow 1 (first-time setup) — 001, 002
- Flow 3 (Quick Add GitHub) — 001, 005
- Flow 4 (Nexus download → watcher) — 004, 005
- Flow 5 (toggle on/off) — 002, 006
- Flow 6 (delete) — 002, 009
- Flow 7 (pin survives apply) — 003, 004, 008
- Flow 8 (update single mod) — 001
- Flow 9 (audit / Check for updates) — 007, 008
- Flow 10 (snapshot / create profile) — 010
- Flow 11 (switch profiles) — 003

Additional flow owners live in [../coverage-matrix.md](../coverage-matrix.md): share-code import, share publish, repair, restore backup, onboarding, subscription updates, and bulk operations now have automated owners. Drag-drop install, launch, and OS protocol registration stay in the short manual release checklist because they cross desktop/OS integration boundaries.

### Mod-author flows
Covered author-flow owners:
- A1 (iterate on dev build with malformed manifest) — `src-tauri/src/mods/scan.rs` lenient/invalid manifest tests.
- A8 (DLL-only mod surfaces correctly) — `src-tauri/tests/qa_scenarios.rs::author_a8_dll_only_mod_surfaces_correctly`.

### Historical bugs (Tier 1 — must be regression-tested before next minor)
- #1 — 002 ✓
- #2 — 001 + 005 ✓
- #4 — `src-tauri/tests/qa_scenarios.rs::historical_4_mixed_layout_zip_lands_under_one_folder` ✓
- #6 — `src-tauri/tests/qa_scenarios.rs::historical_6_source_entry_migrates_on_manifest_rename` ✓
- #11 — `src-tauri/tests/qa_scenarios.rs::historical_11_zip_slip_traversal_is_refused` ✓
- #20 — `qa/runner/smoke.mjs::specDisabledLibraryExtrasArePreserved` ✓
- #21 — `qa/runner/smoke.mjs::specSkippedModAbsentFromSnapshot` ✓
- #22 — `qa/runner/smoke.mjs::specToggleStickyAcrossProfileSwitch` ✓
- #32 — 004 ✓

9 / 9 Tier-1 bugs have automated owners. See [../coverage-matrix.md](../coverage-matrix.md) for the full release-confidence map and remaining lower-tier gaps.
