# Concurrency & Duplication Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers-extended-cc:subagent-driven-development (recommended) or superpowers-extended-cc:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three automation races/duplications — dev builds cancelled by label churn (A), CHANGELOG `[Unreleased]` shared-edit conflicts (B), and one `@claude` comment firing two agents (C) — shipped as PR1 (A+C, tiny workflow edits) and PR2 (B, the `changelog.d/` fragment system).

**Architecture:** PR1 is two `if:`-expression edits to existing workflows. PR2 introduces a per-PR fragment file convention (`changelog.d/<category>-<slug>.md`) assembled into `CHANGELOG.md` at release by a new tested node module, with the CI/QA/suggester/bot touchpoints rewired to read fragments instead of `[Unreleased]`. The frontend changelog parser is untouched (released versions still live in `CHANGELOG.md`).

**Tech Stack:** GitHub Actions YAML, Node 22 ESM (`node:test`), Bash (`scripts/release.sh`), `actionlint`.

Spec: `docs/superpowers/specs/2026-05-31-concurrency-fixes-design.md`.

---

### Task 1: PR1 — workflow concurrency + dedup fixes (A + C)

**Goal:** A `qa-passed` label toggle no longer cancels a running dev build, and one `@claude` comment on an auto-fix PR triggers exactly one agent.

**Files:**
- Modify: `.github/workflows/build.yml` (the `concurrency:` block, ~lines 25-27)
- Modify: `.github/workflows/claude.yml` (the `claude` job `if:`, lines 13-15)

**Acceptance Criteria:**
- [ ] `build.yml` `cancel-in-progress` is `false` for `pull_request` `labeled` events, `true` otherwise.
- [ ] `claude.yml`'s `if:` excludes `@claude` comments on PRs labeled `auto-fix` (mirroring the revise job's label set), while still firing on issues and non-auto-fix PRs.
- [ ] `actionlint` passes on both files (CI `workflow-lint`).
- [ ] **USER-GATE smoke:** on a throwaway/live auto-fix PR, (a) a label toggle mid-build does NOT cancel the Build run, and (b) `@claude` produces exactly one bot run; `@claude` on a normal issue still produces the investigate run.

**Verify:** `actionlint .github/workflows/build.yml .github/workflows/claude.yml` → no output; then the live smoke above with `gh run list` showing the expected single/uncancelled runs.

**Steps:**

- [ ] **Step 1 — build.yml concurrency.** Replace the `cancel-in-progress: true` line:
```yaml
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ !(github.event_name == 'pull_request' && github.event.action == 'labeled') }}
```

- [ ] **Step 2 — confirm the revise job's label set.** Read `.github/workflows/claude-autofix.yml`'s `revise` job `if:` and note which labels it keys on (`auto-fix`, and `qa` if present). Use that exact set in Step 3.

- [ ] **Step 3 — claude.yml guard.** Replace the `claude` job `if:` (lines 13-15) with a label-excluding form (add `qa` to the excludes only if the revise job keys on it):
```yaml
    if: >-
      (
        (github.event.issue && contains(github.event.issue.body, '@claude')) ||
        (github.event.comment && contains(github.event.comment.body, '@claude'))
      )
      && !contains(github.event.issue.labels.*.name, 'auto-fix')
      && !contains(github.event.pull_request.labels.*.name, 'auto-fix')
```

- [ ] **Step 4 — lint.** `actionlint .github/workflows/build.yml .github/workflows/claude.yml` (install if missing, or rely on CI `workflow-lint`). Expected: clean.

- [ ] **Step 5 — commit + PR.**
```bash
git add .github/workflows/build.yml .github/workflows/claude.yml
git commit -m "fix(ci): label events don't cancel dev builds; @claude fires one agent on auto-fix PRs"
# push branch, open PR1 to main
```

- [ ] **Step 6 — USER-GATE live smoke** (after CI green): trigger the two scenarios on a real/throwaway PR and capture `gh run list` evidence that the build survives a label toggle and only one agent answers `@claude`.

```json:metadata
{"files": [".github/workflows/build.yml", ".github/workflows/claude.yml"], "verifyCommand": "actionlint .github/workflows/build.yml .github/workflows/claude.yml", "acceptanceCriteria": ["build.yml cancel-in-progress false on labeled events", "claude.yml skips @claude on auto-fix PRs", "actionlint clean", "live smoke: build survives label toggle AND one agent per @claude"], "userGate": true, "tags": ["user-gate"], "gateScope": "this-task"}
```

---

### Task 2: `changelog-fragments.mjs` engine + tests (PR2 foundation)

**Goal:** A tested node module that lists `changelog.d/` fragments, assembles them into a Keep-a-Changelog block, counts them, suggests a bump, and lints dev-speak — the single source of truth for the dev-speak rules.

**Files:**
- Create: `scripts/changelog-fragments.mjs`
- Test: `scripts/changelog-fragments.test.mjs`

**Acceptance Criteria:**
- [ ] `listFragments()` parses `changelog.d/<category>-<slug>.md`, ignores `README.md`/`.gitkeep`, throws on unknown category or empty body.
- [ ] `assemble()` groups by `Added, Changed, Fixed, Security` in that order, emits `### <Title>` + `- ` bullets, omits empty categories.
- [ ] `suggestedBump()` → `minor` if any `added`/`changed`, else `patch` if any `fixed`/`security`, else `null`.
- [ ] `lint(text)` flags the existing file-path / dev-word / type-name patterns from `release.sh`.
- [ ] CLI `assemble|count|suggested-bump|lint` works (cross-platform guard like the repo's other `.mjs` CLIs).
- [ ] `node --test scripts/changelog-fragments.test.mjs` passes.

**Verify:** `node --test scripts/changelog-fragments.test.mjs` → all pass.

**Steps:**

- [ ] **Step 1 — write the module** `scripts/changelog-fragments.mjs`:
```js
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const DIR = "changelog.d";
export const CATEGORIES = ["added", "changed", "fixed", "security"];
const TITLES = { added: "Added", changed: "Changed", fixed: "Fixed", security: "Security" };
const MINOR = new Set(["added", "changed"]);

const DEV_PATH_RE = /`(src\/|src-tauri\/|qa\/|tests\/|scripts\/|node_modules\/|target\/)/;
const DEV_WORDS_RE = /\b(refactor(ed|ing|s)?|integration test|unit test|harness|WebDriver|tauri-driver|msedgedriver|AppContext|IPC|Tauri command|cargo|serde|reqwest|\.rs[^a-z]|\.tsx?[^a-z])\b/i;
const DEV_TYPES_RE = /`?(parse_manifest|lookup_entry|auditByKey|install_mod_from_zip|scan_mods|RawManifest|ModInfo|ModSourceEntry|qa_cassette)`?/;

export function listFragments(dir = DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort()
    .map((file) => {
      const dash = file.indexOf("-");
      const category = dash === -1 ? "" : file.slice(0, dash).toLowerCase();
      if (!CATEGORIES.includes(category))
        throw new Error(`Fragment "${file}" must start with one of: ${CATEGORIES.join(", ")} then "-".`);
      const body = readFileSync(join(dir, file), "utf8").trim();
      if (!body) throw new Error(`Fragment "${file}" is empty.`);
      return { category, slug: file.slice(dash + 1, -3), file, body };
    });
}

export function assemble(fragments) {
  const out = [];
  for (const category of CATEGORIES) {
    const items = fragments.filter((f) => f.category === category);
    if (!items.length) continue;
    out.push(`### ${TITLES[category]}`, "");
    for (const f of items)
      for (const line of f.body.split("\n").map((l) => l.trim()).filter(Boolean))
        out.push(line.startsWith("-") ? line : `- ${line}`);
    out.push("");
  }
  return out.join("\n").trim();
}

export const count = (frags) => frags.length;
export function suggestedBump(frags) {
  if (!frags.length) return null;
  return frags.some((f) => MINOR.has(f.category)) ? "minor" : "patch";
}
export function lint(text) {
  const v = [];
  if (DEV_PATH_RE.test(text)) v.push("file path / directory reference");
  if (DEV_WORDS_RE.test(text)) v.push("developer jargon");
  if (DEV_TYPES_RE.test(text)) v.push("internal type/function name");
  return v;
}

const invoked = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\\\/g, "/")}`).href;
if (invoked) {
  const frags = listFragments();
  const cmd = process.argv[2];
  if (cmd === "assemble") process.stdout.write(assemble(frags) + "\n");
  else if (cmd === "count") process.stdout.write(count(frags) + "\n");
  else if (cmd === "suggested-bump") process.stdout.write((suggestedBump(frags) ?? "") + "\n");
  else if (cmd === "lint") {
    const v = lint(assemble(frags));
    if (v.length) { process.stderr.write("changelog dev-speak: " + v.join(", ") + "\n"); process.exit(1); }
  } else { process.stderr.write("usage: <assemble|count|suggested-bump|lint>\n"); process.exit(2); }
}
```
*(If the `invoked` guard misbehaves on Windows, copy the exact CLI-detection idiom already used in `scripts/ci-changes.mjs`.)*

- [ ] **Step 2 — write tests** `scripts/changelog-fragments.test.mjs` using `node:test` + a temp dir: cover assemble ordering/grouping, the `- ` prefixing, unknown-category throw, empty-body throw, `suggestedBump` (added→minor, fixed→patch, security→patch, empty→null), and `lint` catching a `src/foo.ts` path and the word "refactor". Run `node --test`.

- [ ] **Step 3 — commit.** `git add scripts/changelog-fragments.mjs scripts/changelog-fragments.test.mjs && git commit -m "feat(changelog): fragment assembler + dev-speak lint with tests"`

```json:metadata
{"files": ["scripts/changelog-fragments.mjs", "scripts/changelog-fragments.test.mjs"], "verifyCommand": "node --test scripts/changelog-fragments.test.mjs", "acceptanceCriteria": ["listFragments parses + validates", "assemble groups in section order", "suggestedBump minor/patch/null", "lint flags dev-speak", "tests pass"]}
```

---

### Task 3: `changelog.d/` scaffolding + `release.sh` integration (PR2)

**Goal:** `release.sh` assembles fragments (+ legacy `[Unreleased]` body for the 1.7.0 transition) into the new version section and deletes the fragments; the pre-flight gate + dev-speak lint run via the node module.

**Files:**
- Create: `changelog.d/.gitkeep`, `changelog.d/README.md`
- Modify: `scripts/release.sh` (pre-flight ~43-105; promotion ~269-287)

**Acceptance Criteria:**
- [ ] Pre-flight passes when `changelog.d/` has ≥1 fragment OR legacy `[Unreleased]` has a bullet; fails with a clear message when neither.
- [ ] Dev-speak lint runs on `node scripts/changelog-fragments.mjs lint` (+ the legacy body) and blocks on a violation.
- [ ] On bump, the new `## [<version>] - <date>` section contains legacy `[Unreleased]` body + assembled fragments; `changelog.d/<category>-*.md` are `git rm`'d; `[Unreleased]` is reset to a thin placeholder pointing at `changelog.d/`.
- [ ] `bash -n scripts/release.sh` clean; a dry-run (`SKIP_QA=1` + no tag/push, or a guarded `--dry-run`) shows the assembled section.

**Verify:** `bash -n scripts/release.sh`; manual dry-run inspection of the assembled CHANGELOG diff with a sample fragment present.

**Steps:**

- [ ] **Step 1 — scaffolding.** `changelog.d/.gitkeep` (empty). `changelog.d/README.md` documenting the format (`<category>-<slug>.md`, one player-facing line, bot prefixes the issue number).
- [ ] **Step 2 — pre-flight gate.** In `release.sh`, replace the "extract `[Unreleased]` + require a bullet" block: compute `ASSEMBLED="$(node scripts/changelog-fragments.mjs assemble)"`, keep extracting the legacy `[Unreleased]` body, require either non-empty, and feed both through the lint (`node scripts/changelog-fragments.mjs lint` for fragments; keep/port the existing grep for the legacy body, or pipe the combined text to the node lint).
- [ ] **Step 3 — promotion.** Replace the rename block: build `NEW_SECTION="## [$NEW] - $TODAY\n\n$LEGACY_BODY\n$ASSEMBLED"` (skip blank halves), insert it after the `## [Unreleased]` placeholder line, then `git rm -q changelog.d/<category>-*.md` for each category glob that matched, and reset `[Unreleased]` to the one-line placeholder.
- [ ] **Step 4 — verify** `bash -n scripts/release.sh`; create a sample `changelog.d/fixed-0-demo.md`, dry-run, confirm the assembled section + deletion, remove the sample.
- [ ] **Step 5 — commit.** `git add changelog.d scripts/release.sh && git commit -m "feat(release): assemble changelog.d fragments on bump, delete them, reset [Unreleased]"`

```json:metadata
{"files": ["changelog.d/.gitkeep", "changelog.d/README.md", "scripts/release.sh"], "verifyCommand": "bash -n scripts/release.sh", "acceptanceCriteria": ["pre-flight gate on fragments or legacy", "lint via node module", "promotion assembles + deletes + resets placeholder", "dry-run shows assembled section"]}
```

---

### Task 4: CI / suggester / QA wiring to read fragments (PR2)

**Goal:** The CI changelog gate, `ci-changes.mjs`, the release-suggester, and the QA check all read `changelog.d/` instead of `[Unreleased]`.

**Files:**
- Modify: `scripts/ci-changes.mjs` (`unreleasedBulletCount`/`suggestedBump` delegate to `changelog-fragments.mjs`)
- Modify: `.github/workflows/ci.yml` (changelog gate → "user-facing PR adds a fragment")
- Modify: `.github/workflows/release-suggester.yml` (count fragments + suggested bump)
- Modify: `.github/workflows/claude-autofix-qa.yml` (QA prompt: "is there a `changelog.d/` fragment?")

**Acceptance Criteria:**
- [ ] `node scripts/ci-changes.mjs unreleased-count` and `suggested-bump` reflect `changelog.d/` (delegating to the new module); existing CLI contract/exit codes preserved.
- [ ] `ci.yml` changelog job passes when the PR adds/edits a `changelog.d/` fragment for a user-facing change.
- [ ] `release-suggester.yml` posts the suggested bump derived from fragment categories.
- [ ] `claude-autofix-qa.yml` prompt asks for a fragment, not an `[Unreleased]` bullet.
- [ ] `node --test scripts/*.test.mjs` green; `actionlint` clean on edited workflows.

**Verify:** `node --test scripts/ci-changes.test.mjs` (update its fixtures to fragments) + `actionlint` on the three workflows.

**Steps:**

- [ ] **Step 1 — ci-changes.mjs.** Import `count`/`suggestedBump`/`listFragments` from `changelog-fragments.mjs`; make `unreleased-count` return `count(listFragments())` and `suggested-bump` return `suggestedBump(listFragments())`. Update `scripts/ci-changes.test.mjs` fixtures to fragments.
- [ ] **Step 2 — ci.yml.** Point the changelog gate at the fragment check (PR adds a `changelog.d/` file when `changes` classified it user-facing). Keep it advisory-vs-blocking exactly as today.
- [ ] **Step 3 — release-suggester.yml.** Swap its `[Unreleased]` detection for `node scripts/ci-changes.mjs suggested-bump` (now fragment-backed); keep the marker-comment upsert.
- [ ] **Step 4 — QA prompt.** In `claude-autofix-qa.yml`, change the changelog bullet line to: "If user-facing, is there a `changelog.d/<category>-<slug>.md` fragment (player language)?"
- [ ] **Step 5 — verify + commit.** `node --test scripts/ci-changes.test.mjs`; `actionlint`; `git commit -m "feat(ci): read changelog.d fragments in CI gate, suggester, QA check"`

```json:metadata
{"files": ["scripts/ci-changes.mjs", "scripts/ci-changes.test.mjs", ".github/workflows/ci.yml", ".github/workflows/release-suggester.yml", ".github/workflows/claude-autofix-qa.yml"], "verifyCommand": "node --test scripts/ci-changes.test.mjs", "acceptanceCriteria": ["ci-changes delegates to fragments", "ci.yml gate on fragment", "suggester fragment-backed", "QA asks for fragment", "tests + actionlint pass"]}
```

---

### Task 5: auto-fix bot fragment instruction + docs (PR2)

**Goal:** The auto-fix bot writes a `changelog.d/` fragment (not a `CHANGELOG.md` bullet), and the docs explain the fragment workflow. The conflict-watcher's CHANGELOG sentence is trimmed.

**Files:**
- Modify: `.github/workflows/claude-autofix.yml` (and/or `CLAUDE.md`) — fragment instruction
- Modify: `.github/workflows/conflict-watcher.yml` — drop the CHANGELOG-specific sentence
- Modify: `RELEASING.md`, `CHANGELOG.md` (writing-rules header)

**Acceptance Criteria:**
- [ ] Wherever the auto-fix bot is told to record a user-facing change, it now says: create `changelog.d/<category>-<issue#>-<slug>.md` with one player-facing line; do NOT edit `CHANGELOG.md`.
- [ ] `conflict-watcher.yml`'s resolve comment no longer gives CHANGELOG-merge instructions (fragments don't conflict); it just says resolve the conflict.
- [ ] `CHANGELOG.md` header + `RELEASING.md` describe the fragment flow.
- [ ] `actionlint` clean.

**Verify:** `actionlint .github/workflows/claude-autofix.yml .github/workflows/conflict-watcher.yml`; doc read-through.

**Steps:**

- [ ] **Step 1 — find the bot's changelog instruction.** Grep `claude-autofix.yml` + `CLAUDE.md` for where a user-facing change is recorded (the prompt produced bullets for #97/#98). Replace with the fragment instruction.
- [ ] **Step 2 — conflict-watcher.** Trim the `@claude` body's "for CHANGELOG.md, keep ALL `[Unreleased]` bullets…" clause to a generic "resolve the conflict(s) and push."
- [ ] **Step 3 — docs.** Update `CHANGELOG.md`'s writing-rules header to point pending changes at `changelog.d/`; add the assemble step to `RELEASING.md`.
- [ ] **Step 4 — verify + commit.** `actionlint`; `git commit -m "docs+bot: write changelog.d fragments; trim watcher CHANGELOG advice"`

```json:metadata
{"files": [".github/workflows/claude-autofix.yml", ".github/workflows/conflict-watcher.yml", "RELEASING.md", "CHANGELOG.md"], "verifyCommand": "actionlint .github/workflows/claude-autofix.yml .github/workflows/conflict-watcher.yml", "acceptanceCriteria": ["bot writes a fragment not a bullet", "watcher CHANGELOG sentence trimmed", "docs describe fragments", "actionlint clean"]}
```

---

## Notes for the executor
- PR1 (Task 1) is independent and lands first.
- PR2 (Tasks 2-5): Task 2 is the foundation; Tasks 3 & 4 depend on it; Task 5 is docs/prompt (independent of 3/4 but part of PR2).
- Open PR2 once Tasks 2-5 are committed; both PRs target `main` via the `worktree-concurrency-fixes` branch (PR1) and a `changelog-fragments` branch (PR2) — or split worktrees as convenient.
- Never edit `CHANGELOG.md [Unreleased]` for this work; for PR2's own changelog entry, add a `changelog.d/` fragment once Task 2/3 exist.
