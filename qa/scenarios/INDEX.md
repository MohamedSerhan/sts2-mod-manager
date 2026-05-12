# Scenario index

| ID | Title | Tier | User | Flow(s) | Hist. bug | Status |
|---|---|---|---|---|---|---|
| [001](001-baselib-bom-shows-real-version.md) | BaseLib BOM manifest yields the real version | 1 | player | 1, 3, 8 | #2 | active |
| [002](002-two-same-named-mods-stay-distinct.md) | Two CardArtEditor folders stay distinct on toggle | 1 | player | 1, 5, 6 | #1 | active |
| [003](003-pin-survives-modpack-apply.md) | Pinned mod survives a modpack apply | 1 | player | 7, 11 | — | active |
| [004](004-downloads-watcher-respects-pin.md) | Downloads-watcher respects pin | 1 | player | 4, 7 | #32 | active |
| [005](005-install-pipeline-preserves-bom-version.md) | install_mod_from_zip preserves BOM-manifest version | 1 | player | 3, 4 | #2 | active |

## Coverage map

Cross-referenced against [walkthrough-findings.md](../walkthrough-findings.md):

### Player flows
- Flow 1 (first-time setup) — 001, 002
- Flow 3 (Quick Add GitHub) — 001, 005
- Flow 4 (Nexus download → watcher) — 004, 005
- Flow 5 (toggle on/off) — 002
- Flow 6 (delete) — 002
- Flow 7 (pin survives apply) — 003, 004
- Flow 8 (update single mod) — 001
- Flow 11 (switch profiles) — 003

Flows still uncovered (priority for next batch): 2 (share code import), 9 (audit), 10 (snapshot create), 12 (share publish), 13 (repair), 14 (drag-drop), 15 (restore backup), 16 (launch), 17 (onboarding), 18 (deep link), 19 (subscription), 20 (bulk).

### Mod-author flows
None yet covered. Priority next:
- A1 (iterate on dev build with malformed manifest)
- A8 (DLL-only mod surfaces correctly)

### Historical bugs (Tier 1 — must be regression-tested before next minor)
- #1 — 002 ✓
- #2 — 001 + 005 ✓
- #4 — TODO (RitsuLib mixed-layout zip)
- #6 — TODO (manifest-rename source migration)
- #11 — TODO (zip-slip refusal)
- #20 — TODO (profile Repair deletes orphan disabled-folder files)
- #21 — TODO (game-version-skipped mods in snapshot)
- #22 — TODO (profile state sticky after toggle)
- #32 — 004 ✓

3 / 9 Tier-1 bugs scenario-locked. Target before v1.4.0: all 9.
