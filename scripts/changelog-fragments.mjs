// scripts/changelog-fragments.mjs
// Lists changelog.d/ fragments, assembles them into a Keep-a-Changelog block,
// counts them, suggests a version bump, and lints dev-speak.
//
// CANONICAL RULESET: this module is the single source of truth for dev-speak
// detection. It must remain at least as strict as the inline patterns in
// scripts/release.sh (lines ~85-87). When release.sh is updated, sync here too.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DIR = "changelog.d";
export const CATEGORIES = ["added", "changed", "fixed", "security"];
const TITLES = { added: "Added", changed: "Changed", fixed: "Fixed", security: "Security" };
const MINOR = new Set(["added", "changed"]);

const DEV_PATH_RE = /`(src\/|src-tauri\/|qa\/|tests\/|scripts\/|node_modules\/|target\/)/;
// Matches both standalone bare words (e.g. "the tsx component") AND file
// extensions (e.g. "foo.ts"). release.sh has the bare `tsx?` alternative;
// the \.tsx?[^a-z] extension form is kept for the dot-prefixed case.
// Same logic applies to .rs vs bare rs — release.sh only has the extension
// form for rs, so we match release.sh exactly there.
const DEV_WORDS_RE = /\b(refactor(ed|ing|s)?|integration test|unit test|harness|WebDriver|tauri-driver|msedgedriver|AppContext|IPC|Tauri command|cargo|serde|reqwest|tsx?|\.rs[^a-z]|\.tsx?[^a-z])\b/i;
// Intentional strengthening over release.sh: backticks are OPTIONAL here
// (release.sh requires them). This catches bare mentions like `parse_manifest`
// without backticks. Do NOT revert to backtick-required — that's a weakening.
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

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "assemble") {
    const frags = listFragments();
    console.log(assemble(frags));
  } else if (cmd === "count") {
    const frags = listFragments();
    console.log(count(frags));
  } else if (cmd === "suggested-bump") {
    const frags = listFragments();
    const b = suggestedBump(frags);
    if (b) console.log(b);
  } else if (cmd === "lint") {
    const frags = listFragments();
    let anyViolation = false;
    for (const frag of frags) {
      const violations = lint(frag.body);
      if (violations.length) {
        process.stderr.write(`${frag.file}: ${violations.join(", ")}\n`);
        anyViolation = true;
      }
    }
    if (anyViolation) process.exit(1);
  } else {
    console.error("usage: changelog-fragments.mjs assemble|count|suggested-bump|lint");
    process.exit(2);
  }
}
