import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listFragments, assemble, count, suggestedBump, lint } from "./changelog-fragments.mjs";

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
