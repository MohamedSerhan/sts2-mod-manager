// scripts/changelog-translations.mjs
// Enforces and assembles localized changelog.d/ fragments.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, listFragments } from "./changelog-fragments.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SOURCE_DIR = "changelog.d";
const TRANSLATION_DIR = "changelog.i18n";
const FRAGMENT_RE = /^(added|changed|fixed|security)-.+\.md$/;
const IGNORED_FILES = new Set([".gitkeep", "README.md", "readme.md"]);

export const LOCALES = [
  {
    key: "ru",
    name: "Russian",
    titles: { added: "Добавлено", changed: "Изменено", fixed: "Исправлено", security: "Безопасность" },
  },
  {
    key: "ar",
    name: "Arabic",
    titles: { added: "مُضاف", changed: "مُغيّر", fixed: "مُصلَح", security: "الأمان" },
  },
  {
    key: "zh-Hans",
    name: "Simplified Chinese",
    titles: { added: "新增", changed: "变更", fixed: "修复", security: "安全" },
  },
];

function rel(rootDir, path) {
  return relative(rootDir, path).replace(/\\/g, "/");
}

function localeByKey(localeKey) {
  const locale = LOCALES.find((item) => item.key === localeKey);
  if (!locale) {
    throw new Error(`Unknown changelog locale "${localeKey}". Expected one of: ${LOCALES.map((l) => l.key).join(", ")}`);
  }
  return locale;
}

function fragmentFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => FRAGMENT_RE.test(file))
    .sort();
}

function extraMarkdownFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".md") && !IGNORED_FILES.has(file) && !FRAGMENT_RE.test(file))
    .sort();
}

function hasBody(path) {
  return existsSync(path) && readFileSync(path, "utf8").trim().length > 0;
}

export function listTranslationProblems({ rootDir = REPO_ROOT } = {}) {
  const sourceDir = join(rootDir, SOURCE_DIR);
  const sourceFiles = new Set(fragmentFiles(sourceDir));
  const problems = [];

  for (const locale of LOCALES) {
    const dir = join(rootDir, TRANSLATION_DIR, locale.key);
    for (const file of sourceFiles) {
      const translatedPath = join(dir, file);
      if (!hasBody(translatedPath)) {
        problems.push(`Missing ${locale.name} changelog translation: ${rel(rootDir, translatedPath)}`);
      }
    }

    for (const file of fragmentFiles(dir)) {
      if (!sourceFiles.has(file)) {
        problems.push(`Stale ${locale.name} changelog translation has no English source: ${rel(rootDir, join(dir, file))}`);
      }
    }

    for (const file of extraMarkdownFiles(dir)) {
      problems.push(`Invalid ${locale.name} changelog translation filename: ${rel(rootDir, join(dir, file))}`);
    }
  }

  return problems;
}

export function assertTranslationFragmentsComplete(options = {}) {
  const problems = listTranslationProblems(options);
  if (problems.length) {
    throw new Error(`Localized changelog fragments are incomplete:\n- ${problems.join("\n- ")}`);
  }
}

function assembleWithTitles(fragments, titles) {
  const out = [];
  for (const category of CATEGORIES) {
    const items = fragments.filter((fragment) => fragment.category === category);
    if (!items.length) continue;
    out.push(`### ${titles[category]}`, "");
    for (const fragment of items) {
      for (const line of fragment.body.split("\n").map((item) => item.trim()).filter(Boolean)) {
        out.push(line.startsWith("-") ? line : `- ${line}`);
      }
    }
    out.push("");
  }
  return out.join("\n").trim();
}

export function assembleLocaleFragments(localeKey, { rootDir = REPO_ROOT } = {}) {
  const locale = localeByKey(localeKey);
  const fragments = listFragments(join(rootDir, TRANSLATION_DIR, locale.key));
  return assembleWithTitles(fragments, locale.titles);
}

function localeJsonPath(rootDir, localeKey) {
  return join(rootDir, "src", "i18n", "changelog", `${localeKey}.json`);
}

function readMap(path) {
  try {
    return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  } catch {
    return {};
  }
}

function writeOrderedMap(path, map) {
  mkdirSync(dirname(path), { recursive: true });
  const ordered = Object.fromEntries(
    Object.keys(map).sort().reverse().map((key) => [key, map[key]]),
  );
  writeFileSync(path, `${JSON.stringify(ordered, null, 2)}\n`, "utf8");
}

export function writeVersionTranslations({ rootDir = REPO_ROOT, version } = {}) {
  if (!version) {
    throw new Error("writeVersionTranslations requires a version");
  }
  assertTranslationFragmentsComplete({ rootDir });

  const written = [];
  for (const locale of LOCALES) {
    const body = assembleLocaleFragments(locale.key, { rootDir });
    if (!body) continue;
    const path = localeJsonPath(rootDir, locale.key);
    const map = readMap(path);
    map[version] = body;
    writeOrderedMap(path, map);
    written.push(locale.key);
  }

  return { version, written };
}

function usage() {
  return [
    "usage: changelog-translations.mjs check-fragments",
    "   or: changelog-translations.mjs write-version --version X.Y.Z",
  ].join("\n");
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const cmd = process.argv[2];
  if (cmd === "check-fragments") {
    const problems = listTranslationProblems();
    if (problems.length) {
      for (const problem of problems) process.stderr.write(`${problem}\n`);
      process.stderr.write("\nAsk Codex to translate each changelog.d/ fragment into matching changelog.i18n/<locale>/ files before merging.\n");
      process.exit(1);
    }
    console.log("changelog translations OK");
  } else if (cmd === "write-version") {
    const versionIndex = process.argv.indexOf("--version");
    const version = versionIndex === -1 ? undefined : process.argv[versionIndex + 1];
    try {
      const result = writeVersionTranslations({ version });
      console.log(`changelog translations: ${result.version} wrote [${result.written.join(", ")}]`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
  } else {
    console.error(usage());
    process.exit(2);
  }
}
