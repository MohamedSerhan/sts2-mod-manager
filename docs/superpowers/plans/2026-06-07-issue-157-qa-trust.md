# Issue 157 QA Trust Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the QA inventory and gates trustworthy enough that covered user-facing features no longer need routine manual regression checks.

**Architecture:** Keep the existing `qa/coverage-matrix.md` as the scenario and bug owner map, add a dedicated interaction inventory for user-visible paths, and make one Node gate validate/report both. CI and release preflight must run the gate for app/QA changes so unowned interactions cannot merge or release.

**Tech Stack:** Node ESM scripts, Node test runner, GitHub Actions, Bash release script, existing QA markdown docs.

---

### Task 1: Matrix Gate Contract

**Files:**
- Modify: `scripts/qa-coverage-matrix.test.mjs`
- Create: `scripts/qa-coverage-matrix.mjs`

- [ ] Add failing Node tests that require an interaction inventory file, automated/manual owner validation, and release/CI wiring.
- [ ] Run `node --test scripts/qa-coverage-matrix.test.mjs` and confirm the new assertions fail because the inventory script/file do not exist yet.
- [ ] Implement a small parser/validator/reporter in `scripts/qa-coverage-matrix.mjs`.
- [ ] Rerun the Node test and confirm the gate contract passes.

### Task 2: Interaction Inventory

**Files:**
- Create: `qa/interaction-inventory.md`
- Modify: `qa/coverage-matrix.md`

- [ ] Inventory global shell, menus, dialogs, profile/modpack flows, mod library actions, settings, empty/error states, large-list cases, and manual-only OS boundaries.
- [ ] Map each automated row to a concrete smoke, Vitest, Rust, or script owner and release command.
- [ ] Give every manual row a reason and review date.
- [ ] Point `qa/coverage-matrix.md` at the interaction inventory as the issue #157 release-confidence source.

### Task 3: Gate Wiring

**Files:**
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `scripts/release.sh`

- [ ] Make `npm run qa:matrix` print the inventory completeness report and fail on missing/unowned rows.
- [ ] Add a `qa-matrix` CI job for app, QA, and script changes and include it in `CI Gate`.
- [ ] Add the matrix gate to release preflight before the heavier Rust/Vitest/WebDriver suite.

### Task 4: Release Trust Docs

**Files:**
- Modify: `qa/README.md`
- Modify: `RELEASING.md`

- [ ] Document that covered inventory rows do not need routine manual regression checks after the matrix, coverage, Rust, and smoke gates pass.
- [ ] Keep the manual regression list limited to explicitly manual rows with reasons and review dates.
- [ ] Explain how to add a new interaction row when a user-facing feature is added.

### Task 5: Verification And Merge

**Files:**
- Verify working tree, pushed branch, PR, CI, merge state.

- [ ] Run `npm run qa:matrix`.
- [ ] Run `node --test scripts/qa-coverage-matrix.test.mjs scripts/ci-changes.test.mjs`.
- [ ] Run `npm run qa:i18n`.
- [ ] Run the relevant broader QA gates available locally, then inspect GitHub CI after pushing.
- [ ] Open a PR labeled `no-changelog`, merge to `main` only after required checks pass, and confirm issue #157 acceptance criteria are satisfied.
