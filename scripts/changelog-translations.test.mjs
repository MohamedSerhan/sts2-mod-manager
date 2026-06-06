import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  LOCALES,
  assembleLocaleFragments,
  listTranslationProblems,
  writeVersionTranslations,
} from "./changelog-translations.mjs";

function makeRepo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), "changelog-i18n-test-"));
  mkdirSync(join(dir, "changelog.d"), { recursive: true });
  mkdirSync(join(dir, "changelog.i18n"), { recursive: true });
  mkdirSync(join(dir, "src", "i18n", "changelog"), { recursive: true });
  for (const locale of LOCALES) {
    mkdirSync(join(dir, "changelog.i18n", locale.key), { recursive: true });
    writeFileSync(join(dir, "src", "i18n", "changelog", `${locale.key}.json`), "{}\n", "utf8");
  }
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body, "utf8");
  }
  return dir;
}

test("listTranslationProblems reports missing locale fragments for each English fragment", () => {
  const dir = makeRepo({
    "changelog.d/fixed-profile-save.md": "Saving profiles is clearer.",
    "changelog.i18n/ru/fixed-profile-save.md": "Сохранение профилей стало понятнее.",
  });
  try {
    const problems = listTranslationProblems({ rootDir: dir });
    assert.deepEqual(problems, [
      "Missing Arabic changelog translation: changelog.i18n/ar/fixed-profile-save.md",
      "Missing Simplified Chinese changelog translation: changelog.i18n/zh-Hans/fixed-profile-save.md",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listTranslationProblems reports stale localized fragments without an English source", () => {
  const dir = makeRepo({
    "changelog.i18n/zh-Hans/fixed-old.md": "旧条目。",
  });
  try {
    const problems = listTranslationProblems({ rootDir: dir });
    assert.deepEqual(problems, [
      "Stale Simplified Chinese changelog translation has no English source: changelog.i18n/zh-Hans/fixed-old.md",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("assembleLocaleFragments emits localized section headings in canonical order", () => {
  const dir = makeRepo({
    "changelog.d/fixed-one.md": "One fix.",
    "changelog.d/added-one.md": "One addition.",
    "changelog.i18n/zh-Hans/fixed-one.md": "一个修复。",
    "changelog.i18n/zh-Hans/added-one.md": "一个新增功能。",
  });
  try {
    const body = assembleLocaleFragments("zh-Hans", { rootDir: dir });
    assert.equal(body, "### 新增\n\n- 一个新增功能。\n\n### 修复\n\n- 一个修复。");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeVersionTranslations writes version-keyed locale JSON from translated fragments", () => {
  const dir = makeRepo({
    "changelog.d/fixed-one.md": "One fix.",
    "changelog.i18n/ru/fixed-one.md": "Одно исправление.",
    "changelog.i18n/ar/fixed-one.md": "إصلاح واحد.",
    "changelog.i18n/zh-Hans/fixed-one.md": "一个修复。",
  });
  try {
    const result = writeVersionTranslations({ rootDir: dir, version: "1.7.3" });
    assert.deepEqual(result.written.sort(), ["ar", "ru", "zh-Hans"]);
    const zh = JSON.parse(readFileSync(join(dir, "src", "i18n", "changelog", "zh-Hans.json"), "utf8"));
    assert.equal(zh["1.7.3"], "### 修复\n\n- 一个修复。");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
