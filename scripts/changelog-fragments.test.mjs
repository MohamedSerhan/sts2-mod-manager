import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listFragments, assemble, count, suggestedBump, lint, mergeCategorySections } from "./changelog-fragments.mjs";

// Helper: create a temp dir, write named files, return dir path
function makeTempDir(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "changelog-frags-test-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, "utf8");
  }
  return dir;
}

// ─── listFragments ────────────────────────────────────────────────────────────

test("listFragments returns [] when dir does not exist", () => {
  const result = listFragments("/nonexistent-dir-that-does-not-exist-99999");
  assert.deepEqual(result, []);
});

test("listFragments ignores README.md (case-insensitive)", () => {
  const dir = makeTempDir({
    "README.md": "# readme",
    "Readme.md": "# readme",
    "readme.md": "# readme",
    "fixed-1-real.md": "A real fix.",
  });
  try {
    const frags = listFragments(dir);
    assert.equal(frags.length, 1);
    assert.equal(frags[0].category, "fixed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listFragments throws on unknown-category filename", () => {
  const dir = makeTempDir({ "foo-bar.md": "Some content." });
  try {
    assert.throws(
      () => listFragments(dir),
      /Fragment "foo-bar\.md" must start with one of:/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listFragments throws on empty-body file", () => {
  const dir = makeTempDir({ "fixed-empty.md": "   \n  " });
  try {
    assert.throws(
      () => listFragments(dir),
      /Fragment "fixed-empty\.md" is empty\./
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listFragments parses category and slug correctly, including slug with dashes", () => {
  const dir = makeTempDir({ "fixed-57-mod-source-sync.md": "Sync fix." });
  try {
    const frags = listFragments(dir);
    assert.equal(frags.length, 1);
    assert.equal(frags[0].category, "fixed");
    assert.equal(frags[0].slug, "57-mod-source-sync");
    assert.equal(frags[0].file, "fixed-57-mod-source-sync.md");
    assert.equal(frags[0].body, "Sync fix.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listFragments returns fragments sorted by filename", () => {
  const dir = makeTempDir({
    "fixed-z.md": "Z fix.",
    "added-a.md": "A add.",
    "changed-m.md": "M change.",
  });
  try {
    const frags = listFragments(dir);
    assert.deepEqual(
      frags.map((f) => f.file),
      ["added-a.md", "changed-m.md", "fixed-z.md"]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── assemble ─────────────────────────────────────────────────────────────────

test("assemble returns empty string for no fragments", () => {
  assert.equal(assemble([]), "");
});

test("assemble groups categories in order Added→Changed→Fixed→Security", () => {
  const dir = makeTempDir({
    "security-1.md": "Security update.",
    "fixed-1.md": "A fix.",
    "added-1.md": "A new thing.",
    "changed-1.md": "A change.",
  });
  try {
    const frags = listFragments(dir);
    const out = assemble(frags);
    const lines = out.split("\n");
    const addedIdx = lines.indexOf("### Added");
    const changedIdx = lines.indexOf("### Changed");
    const fixedIdx = lines.indexOf("### Fixed");
    const securityIdx = lines.indexOf("### Security");
    assert.ok(addedIdx !== -1, "### Added present");
    assert.ok(changedIdx !== -1, "### Changed present");
    assert.ok(fixedIdx !== -1, "### Fixed present");
    assert.ok(securityIdx !== -1, "### Security present");
    assert.ok(addedIdx < changedIdx, "Added before Changed");
    assert.ok(changedIdx < fixedIdx, "Changed before Fixed");
    assert.ok(fixedIdx < securityIdx, "Fixed before Security");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assemble emits ### Title + blank line + - bullets", () => {
  const dir = makeTempDir({ "added-1.md": "A new feature." });
  try {
    const frags = listFragments(dir);
    const out = assemble(frags);
    assert.equal(out, "### Added\n\n- A new feature.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assemble omits empty categories", () => {
  const dir = makeTempDir({ "fixed-1.md": "Just a fix." });
  try {
    const frags = listFragments(dir);
    const out = assemble(frags);
    assert.ok(!out.includes("### Added"), "no Added section");
    assert.ok(!out.includes("### Changed"), "no Changed section");
    assert.ok(out.includes("### Fixed"), "Fixed section present");
    assert.ok(!out.includes("### Security"), "no Security section");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assemble does NOT add '- ' prefix if body already starts with '-'", () => {
  const dir = makeTempDir({ "fixed-1.md": "- Already a bullet." });
  try {
    const frags = listFragments(dir);
    const out = assemble(frags);
    assert.ok(!out.includes("- - "), "no double dash");
    assert.ok(out.includes("- Already a bullet."), "bullet preserved as-is");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assemble adds '- ' prefix when body does not start with '-'", () => {
  const dir = makeTempDir({ "fixed-1.md": "No prefix here." });
  try {
    const frags = listFragments(dir);
    const out = assemble(frags);
    assert.ok(out.includes("- No prefix here."), "dash prefix added");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── count ────────────────────────────────────────────────────────────────────

test("count returns the number of fragments", () => {
  const dir = makeTempDir({
    "added-1.md": "Thing one.",
    "fixed-1.md": "Fix one.",
    "fixed-2.md": "Fix two.",
  });
  try {
    const frags = listFragments(dir);
    assert.equal(count(frags), 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─── suggestedBump ────────────────────────────────────────────────────────────

test("suggestedBump: added -> minor", () => {
  assert.equal(suggestedBump([{ category: "added" }]), "minor");
});

test("suggestedBump: changed -> minor", () => {
  assert.equal(suggestedBump([{ category: "changed" }]), "minor");
});

test("suggestedBump: fixed -> patch", () => {
  assert.equal(suggestedBump([{ category: "fixed" }]), "patch");
});

test("suggestedBump: security -> patch", () => {
  assert.equal(suggestedBump([{ category: "security" }]), "patch");
});

test("suggestedBump: added + fixed -> minor", () => {
  assert.equal(suggestedBump([{ category: "added" }, { category: "fixed" }]), "minor");
});

test("suggestedBump: empty -> null", () => {
  assert.equal(suggestedBump([]), null);
});

// ─── lint ─────────────────────────────────────────────────────────────────────

test("lint flags a file path reference", () => {
  const violations = lint("See `src/foo.ts` for details.");
  assert.ok(violations.includes("file path / directory reference"), JSON.stringify(violations));
});

test("lint flags the word 'refactor'", () => {
  const violations = lint("Refactored the mod loader.");
  assert.ok(violations.includes("developer jargon"), JSON.stringify(violations));
});

test("lint flags 'refactoring' and 'refactored' variants", () => {
  assert.ok(lint("Refactoring in progress.").includes("developer jargon"));
  assert.ok(lint("refactors the core.").includes("developer jargon"));
});

test("lint returns [] for a clean player-facing sentence", () => {
  const violations = lint("Mods now show their source links.");
  assert.deepEqual(violations, []);
});

test("lint returns [] for another clean sentence", () => {
  const violations = lint("Fixed a crash when installing mods from Nexus.");
  assert.deepEqual(violations, []);
});

test("lint flags internal type names", () => {
  assert.ok(lint("Fixed parse_manifest handling.").includes("internal type/function name"));
  assert.ok(lint("Updated RawManifest schema.").includes("internal type/function name"));
});

// M2: multi-line fragment body renders correctly
test("assemble handles multi-line fragment body correctly", () => {
  const dir = makeTempDir({
    "fixed-1.md": "First improvement.\n- Second improvement.",
  });
  try {
    const frags = listFragments(dir);
    const out = assemble(frags);
    // First line gets "- " prefix added; second already starts with "-" so kept as-is
    assert.ok(out.includes("- First improvement."), "first line gets dash prefix");
    assert.ok(out.includes("- Second improvement."), "second line preserved as-is");
    assert.ok(!out.includes("- - "), "no double-dash on pre-bulleted line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// M3: lint() tripping all three regexes returns array of length 3 (no short-circuit)
test("lint returns all three violations when all three regexes match", () => {
  // "src/" trips DEV_PATH_RE, "refactor" trips DEV_WORDS_RE, "parse_manifest" trips DEV_TYPES_RE
  const violations = lint("Refactored `src/foo.ts` by rewriting parse_manifest.");
  assert.equal(violations.length, 3, `expected 3 violations, got: ${JSON.stringify(violations)}`);
});

// I1: bare tsx?/ts word (without leading dot) now flagged — matches release.sh `tsx?` alternative
test("lint flags bare 'tsx' word (no dot prefix)", () => {
  const violations = lint("the tsx component loader");
  assert.ok(violations.includes("developer jargon"), JSON.stringify(violations));
});

test("lint flags bare 'ts' word (no dot prefix)", () => {
  const violations = lint("Updated the ts build config.");
  assert.ok(violations.includes("developer jargon"), JSON.stringify(violations));
});

// I1: bare type name without backticks — intentional strengthening kept
test("lint flags bare parse_manifest without backticks", () => {
  const violations = lint("bare parse_manifest mention");
  assert.ok(violations.includes("internal type/function name"), JSON.stringify(violations));
});

// ─── mergeCategorySections ──────────────────────────────────────────────────
// Regression guard for the 1.7.0 release bug: legacy [Unreleased] sections
// concatenated with the assembled fragment block produced duplicate
// "### Fixed" / "### Added" / "### Security" headers in one version.

test("mergeCategorySections collapses duplicate same-category headers into one", () => {
  const input = [
    "### Fixed", "", "- Legacy fix.", "",
    "### Fixed", "", "- Fragment fix.", "",
  ].join("\n");
  const out = mergeCategorySections(input);
  assert.equal((out.match(/^### Fixed$/gm) || []).length, 1, "exactly one ### Fixed");
  assert.ok(out.includes("- Legacy fix."), "keeps legacy bullet");
  assert.ok(out.includes("- Fragment fix."), "keeps fragment bullet");
});

test("mergeCategorySections preserves bullet order within a merged section", () => {
  const input = "### Fixed\n\n- First.\n\n### Fixed\n\n- Second.";
  const out = mergeCategorySections(input);
  assert.ok(out.indexOf("- First.") < out.indexOf("- Second."), "encounter order preserved");
});

test("mergeCategorySections re-emits sections in canonical order", () => {
  const input = "### Security\n\n- S.\n\n### Added\n\n- A.\n\n### Fixed\n\n- F.";
  const out = mergeCategorySections(input);
  const lines = out.split("\n");
  const added = lines.indexOf("### Added");
  const fixed = lines.indexOf("### Fixed");
  const security = lines.indexOf("### Security");
  assert.ok(added < fixed && fixed < security, `Added<Fixed<Security, got ${out}`);
});

test("mergeCategorySections preserves preamble text before the first heading", () => {
  const input = "An intro paragraph for this release.\n\n### Added\n\n- A.";
  const out = mergeCategorySections(input);
  assert.ok(out.startsWith("An intro paragraph for this release."), "preamble kept at top");
  assert.equal((out.match(/^### Added$/gm) || []).length, 1);
});

test("mergeCategorySections is idempotent on an already-clean body", () => {
  const clean = "### Added\n\n- A.\n\n### Fixed\n\n- F.";
  assert.equal(mergeCategorySections(clean), clean);
  assert.equal(mergeCategorySections(mergeCategorySections(clean)), clean);
});

test("mergeCategorySections handles the legacy-plus-fragment release shape", () => {
  // Mirrors release.sh: legacy [Unreleased] body (Added/Changed/Fixed/Security)
  // joined with the assembled fragment block (Added/Fixed/Security).
  const legacy = "### Added\n\n- Legacy added.\n\n### Changed\n\n- Legacy changed.\n\n### Fixed\n\n- Legacy fixed.\n\n### Security\n\n- Legacy security.";
  const assembled = "### Added\n\n- Fragment added.\n\n### Fixed\n\n- Fragment fixed.\n\n### Security\n\n- Fragment security.";
  const out = mergeCategorySections([legacy, assembled].join("\n\n"));
  for (const h of ["Added", "Changed", "Fixed", "Security"]) {
    assert.equal((out.match(new RegExp(`^### ${h}$`, "gm")) || []).length, 1, `one ### ${h}`);
  }
  // All eight bullets survive.
  for (const b of [
    "- Legacy added.", "- Fragment added.", "- Legacy changed.",
    "- Legacy fixed.", "- Fragment fixed.", "- Legacy security.", "- Fragment security.",
  ]) {
    assert.ok(out.includes(b), `keeps ${b}`);
  }
});

test("mergeCategorySections returns empty string for empty input", () => {
  assert.equal(mergeCategorySections(""), "");
  assert.equal(mergeCategorySections("\n\n"), "");
});
