#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh [patch|minor|major]
#
# Bumps the version in all four tracked files that carry it, commits, tags,
# and pushes. Skips ahead automatically if the proposed tag already exists
# locally or on origin.
#
# Files updated:
#   package.json
#   package-lock.json (both top-level "version" AND packages[""].version)
#   src-tauri/Cargo.toml
#   src-tauri/Cargo.lock
#   src-tauri/tauri.conf.json
#
# Pre-flight: refuses to run unless we're on main, working tree is clean, and
# local main is in sync with origin/main (auto-pulls if behind, errors on
# divergence). This prevents the "ghost release on stale main" failure mode
# that produced the v0.7.4/v0.7.5 mess.
#
# QA gate: after pre-flight, runs the full cross-platform QA suite (Rust tests
# + Vitest). On Windows it also runs the WebDriver smoke in cassette +
# non-cassette modes. The gate blocks the release on any failure. Set
# SKIP_QA=1 to bypass for emergency hotfixes, but understand that's how past
# regressions shipped — the v1.3.1 vunknown bug and the duplicate same-name
# mod collapse both made it to users because nobody ran the existing tests.

# --- Pre-flight ---

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
  echo "Error: must be on main (currently on '$BRANCH')." >&2
  exit 1
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Error: working tree has uncommitted changes. Commit or stash first." >&2
  git status --short >&2
  exit 1
fi

# --- CHANGELOG.md pre-flight ---
#
# Every release MUST have user-facing notes — the in-app "What's new" card
# reads them, and they double as the GitHub release body. The Unreleased
# section is the working scratchpad; if it's empty or missing, we refuse
# to ship so nobody discovers later that v1.X.Y has no changelog entry.

if [[ ! -f CHANGELOG.md ]]; then
  echo "Error: CHANGELOG.md is missing. Create it with an [Unreleased] section before releasing." >&2
  exit 1
fi

# Extract the [Unreleased] block (between `## [Unreleased]` and the next
# `## [` heading). A section qualifies as "has content" if it contains at
# least one bullet (`-` / `*` at line start) under an `### ...` subhead —
# this excludes the empty `### Added` / `### Changed` skeleton the script
# itself drops in after each release.

UNRELEASED_CONTENT=$(awk '
  /^## \[Unreleased\]/ { in_block=1; next }
  in_block && /^## \[/ { in_block=0 }
  in_block { print }
' CHANGELOG.md)

# Check whether the legacy [Unreleased] body has any bullets.
LEGACY_HAS_BULLETS=0
if echo "$UNRELEASED_CONTENT" | grep -qE '^[[:space:]]*[-*][[:space:]]+\S'; then
  LEGACY_HAS_BULLETS=1
fi

# Count changelog.d/ fragments (excludes README.md and .gitkeep).
FRAGMENT_COUNT="$(node scripts/changelog-fragments.mjs count)"

# Require at least one source of changelog content before releasing.
if [[ "$LEGACY_HAS_BULLETS" -eq 0 && "$FRAGMENT_COUNT" -eq 0 ]]; then
  echo "Error: no changelog content — add a fragment under changelog.d/ (or [Unreleased] bullets)." >&2
  echo "  • For post-release changes: create changelog.d/<category>-<slug>.md (see changelog.d/README.md)" >&2
  echo "  • For this release only: add at least one bullet under ### Added / ### Changed / ### Fixed / ### Security" >&2
  exit 1
fi

# --- Dev-speak lint ---
#
# The changelog is for PLAYERS, not developers. Block release if either
# the fragment files or the legacy [Unreleased] body contains obvious
# dev-speak (file paths, refactor vocabulary, internal type names).
#
# False positive? Either rewrite the bullet for a player (preferred —
# it almost always reads better), or delete the bullet entirely if
# the change isn't user-visible.

# Lint changelog.d/ fragments via the module (single source of truth).
if ! node scripts/changelog-fragments.mjs lint 2>/tmp/fragment_lint_out; then
  echo "Error: changelog.d/ fragment(s) contain dev-speak." >&2
  echo >&2
  sed 's/^/  /' /tmp/fragment_lint_out >&2
  echo >&2
  echo "Rewrite for players. Describe what they see or do, not how the code works." >&2
  echo "See changelog.d/README.md for the player-language rules." >&2
  exit 1
fi

# Lint the legacy [Unreleased] body (guards the 1.7.0 transition notes and
# any hand-edited bullets that exist alongside fragments).
DEV_PATH_RE='`(src/|src-tauri/|qa/|tests/|scripts/|node_modules/|target/)'
DEV_WORDS_RE='\b(refactor(ed|ing|s)?|integration test|unit test|harness|WebDriver|tauri-driver|msedgedriver|AppContext|IPC|Tauri command|cargo|serde|reqwest|tsx?|\.rs[^a-z]|\.tsx?[^a-z])\b'
DEV_TYPES_RE='`(parse_manifest|lookup_entry|auditByKey|install_mod_from_zip|scan_mods|RawManifest|ModInfo|ModSourceEntry|qa_cassette)`'

devspeak_hits=$(echo "$UNRELEASED_CONTENT" \
  | grep -nE "$DEV_PATH_RE|$DEV_WORDS_RE|$DEV_TYPES_RE" \
  | head -10 \
  || true)

if [[ -n "$devspeak_hits" ]]; then
  echo "Error: CHANGELOG.md [Unreleased] contains dev-speak." >&2
  echo >&2
  echo "$devspeak_hits" | sed 's/^/  /' >&2
  echo >&2
  echo "Rewrite for players. Describe what they see or do, not how the code works." >&2
  echo "See the 'Writing rules' section at the top of CHANGELOG.md." >&2
  echo >&2
  echo "(If a bullet doesn't have anything a player would notice, delete it." >&2
  echo " Internal-only changes belong in commit messages, not the changelog.)" >&2
  exit 1
fi

echo "Checking localized changelog fragments..."
node scripts/changelog-translations.mjs check-fragments

# --- Translation gate ---
#
# This is intentionally outside SKIP_QA. A release may skip the heavier
# QA suite only for an emergency hotfix, but it must never ship missing
# locale keys or copied-English fallback prose in supported languages.

echo "Checking locale completeness..."
npm run --silent qa:i18n

echo "Fetching origin..."
# Fetch the branch ref, but NOT --tags. We don't need local tags in sync;
# the collision check below uses `git ls-remote --tags origin` directly.
# Fetching tags here used to silently abort the whole script when a local
# tag pointed at a different SHA than origin (e.g. the v0.7.4/v0.7.5 mess
# left a stale local v0.7.6) — `set -euo pipefail` + `--quiet` made the
# resulting "would clobber existing tag" error invisible.
git fetch origin main --quiet

LOCAL=$(git rev-parse main)
REMOTE=$(git rev-parse origin/main)
BASE=$(git merge-base main origin/main)

if [[ "$LOCAL" != "$REMOTE" ]]; then
  if [[ "$LOCAL" == "$BASE" ]]; then
    echo "Local main is behind origin/main. Pulling..."
    git pull --rebase origin main
  elif [[ "$REMOTE" == "$BASE" ]]; then
    echo "Local main is ahead of origin/main — releasing your local commits."
  else
    echo "Error: local main and origin/main have diverged. Resolve manually." >&2
    exit 1
  fi
fi

# --- QA suite gate ---
#
# The QA harness is our last line of defence before users see bugs.
# It runs five suites:
#   1. QA matrix and interaction inventory completeness
#   2. Rust unit + integration tests (default features)
#   3. Rust integration tests with `qa-cassette` (proves the HTTP
#      intercept didn't regress)
#   4. Frontend parser unit tests via Vitest
#   5. WebDriver smoke against a built binary, in both modes
#      (non-cassette + CASSETTE=1) on Windows, where the harness is supported
#
# This blocks a release if anything is red. To bypass for an
# emergency hotfix, set SKIP_QA=1. Use it sparingly — past releases
# that skipped pre-flight checks produced the v0.7.4/v0.7.5 mess and
# the v1.3.1 vunknown bug that 1.3.3 had to fix.

if [[ "${SKIP_QA:-0}" == "1" ]]; then
  echo "⚠  SKIP_QA=1 — skipping the QA suite. You are flying blind." >&2
else
  echo "==== QA suite ===="
  echo "[1/5] QA matrix and interaction inventory..."
  npm run --silent qa:matrix

  echo "[2/5] Rust tests (default features)..."
  cargo test --manifest-path=src-tauri/Cargo.toml --quiet

  echo "[3/5] Rust tests (qa-cassette feature)..."
  cargo test --manifest-path=src-tauri/Cargo.toml --features qa-cassette --quiet

  echo "[4/5] Frontend unit tests + coverage gate (vitest)..."
  # qa:coverage runs Vitest with the v8 coverage reporter AND enforces
  # the thresholds declared in vitest.config.ts. A regression that
  # drops coverage below the floor blocks the release.
  npm run --silent qa:coverage

  echo "[5/5] WebDriver smoke..."
  PLATFORM=$(node -p "process.platform")
  if [[ "$PLATFORM" == "win32" ]]; then
    # Ensure the matching msedgedriver is on disk. The auto-fetch
    # detects the local WebView2 version and downloads the exact
    # driver — idempotent if already current.
    if [[ -f qa/runner/scripts/download-msedgedriver.mjs ]]; then
      node qa/runner/scripts/download-msedgedriver.mjs
    fi
    # The smoke binary must be built with `qa-cassette` so the
    # CASSETTE=1 pass exercises the intercept. Build once and reuse
    # for both modes.
    npm run tauri build -- --no-bundle --features qa-cassette
    node qa/runner/smoke.mjs
    CASSETTE=1 node qa/runner/smoke.mjs
  else
    echo "WebDriver smoke skipped on ${PLATFORM}; the current harness is Windows-only."
    echo "Rust, cassette, and frontend coverage gates remain mandatory."
  fi
  echo "==== QA suite green — proceeding with release ===="
fi

# --- Determine bump type ---

BUMP="${1:-}"
if [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  CURRENT=$(node -p "require('./package.json').version")
  IFS='.' read -r MAJ MIN PAT <<< "$CURRENT"
  echo "Current version: $CURRENT"
  echo ""
  echo "  1) patch -> ${MAJ}.${MIN}.$((PAT + 1))"
  echo "  2) minor -> ${MAJ}.$((MIN + 1)).0"
  echo "  3) major -> $((MAJ + 1)).0.0"
  echo ""
  read -rp "Choose [1/2/3]: " choice
  case "$choice" in
    1) BUMP="patch" ;;
    2) BUMP="minor" ;;
    3) BUMP="major" ;;
    *) echo "Invalid choice."; exit 1 ;;
  esac
fi

# --- Compute next version, skipping any tags that already exist ---

CURRENT=$(node -p "require('./package.json').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

EXISTING_TAGS=$(
  {
    git tag -l 'v*'
    git ls-remote --tags origin 'v*' 2>/dev/null \
      | awk '{print $2}' \
      | sed 's|refs/tags/||' \
      | grep -v '\^{}$' || true
  } | sort -u
)

apply_bump() {
  case "$1" in
    patch) PATCH=$((PATCH + 1)) ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  esac
}

apply_bump "$BUMP"
# If the requested level collides, fall through to patch bumps until free.
# (e.g. if 0.8.0 is taken on a "minor" request, try 0.8.1, 0.8.2, ...)
while echo "$EXISTING_TAGS" | grep -qx "v${MAJOR}.${MINOR}.${PATCH}"; do
  echo "  v${MAJOR}.${MINOR}.${PATCH} already exists, trying next..."
  apply_bump patch
done

NEW="${MAJOR}.${MINOR}.${PATCH}"
TAG="v${NEW}"
echo "Bumping $CURRENT -> $NEW"

# --- Update version in all five files ---

# package.json + package-lock.json (npm version handles BOTH version fields)
npm version "$NEW" --no-git-tag-version >/dev/null

# src-tauri/Cargo.toml — replace the first version = "..." (the package's own)
sed -i "0,/^version = \".*\"$/s//version = \"$NEW\"/" src-tauri/Cargo.toml
cargo metadata --manifest-path=src-tauri/Cargo.toml --format-version=1 --no-deps >/dev/null

# src-tauri/tauri.conf.json
node -e "
const fs = require('fs');
const f = 'src-tauri/tauri.conf.json';
const conf = JSON.parse(fs.readFileSync(f, 'utf8'));
conf.version = '$NEW';
fs.writeFileSync(f, JSON.stringify(conf, null, 2) + '\n');
"

# --- Promote [Unreleased] → [vX.Y.Z] in CHANGELOG.md ---
#
# Done via node so we can safely rewrite the file with the new heading and
# insert the thin [Unreleased] placeholder above it.
#
# Two cases:
#   LEGACY_HAS_BULLETS=1  (1.7.0 transition): the existing bullets in
#     [Unreleased] move under the new version heading. If fragments also
#     exist, their assembled block is appended AFTER the legacy body.
#   LEGACY_HAS_BULLETS=0  (normal post-1.7.0 releases): the new version
#     section body is solely the assembled fragment block.
#
# Both cases replace the entire [Unreleased] section (everything up to the
# next ## [ heading, or end-of-file) so that we can rebuild the body in the
# correct order: legacyBody (if any) then assembled fragments (if any).
#
# The thin [Unreleased] placeholder that replaces the working section keeps
# the heading (the frontend parser keys on it) but has no skeleton headings —
# just a note pointing contributors to changelog.d/.

TODAY=$(date +%Y-%m-%d)
ASSEMBLED="$(node scripts/changelog-fragments.mjs assemble)"

# Pass the assembled block and control flags as env vars so the inline node
# script receives them without fragile shell-into-JS string escaping.
ASSEMBLED_FRAGS="$ASSEMBLED" \
LEGACY_HAS_BULLETS_ENV="${LEGACY_HAS_BULLETS}" \
NEW_VERSION="${NEW}" \
RELEASE_DATE="${TODAY}" \
node -e "
const fs = require('fs');
const { pathToFileURL } = require('url');
const { resolve } = require('path');
(async () => {
const { mergeCategorySections } =
  await import(pathToFileURL(resolve('scripts/changelog-fragments.mjs')).href);
const clPath = 'CHANGELOG.md';
let txt = fs.readFileSync(clPath, 'utf8');
const assembled        = process.env.ASSEMBLED_FRAGS || '';
const legacyHasBullets = process.env.LEGACY_HAS_BULLETS_ENV === '1';
const newHeading       = '## [' + process.env.NEW_VERSION + '] - ' + process.env.RELEASE_DATE;
const thinUnreleased   =
  '## [Unreleased]\n\n' +
  '_Changes are tracked as fragments in [\`changelog.d/\`](changelog.d/) and assembled here at release._\n\n' +
  '---\n';

if (!/^## \[Unreleased\]/m.test(txt)) {
  process.stderr.write('CHANGELOG.md is missing [Unreleased] heading after pre-flight — refusing to write.\n');
  process.exit(1);
}

// Match the entire [Unreleased] section.
// Two alternatives handle both cases:
//   1. There IS a following ## [ heading  → stop just before \n## [
//   2. [Unreleased] is the last section   → [\s\S]* greedily runs to end-of-string
// The lookahead uses a literal \n## \[ (rather than ^## \[ with /m) to pin the
// boundary to a newline-preceded heading unambiguously.
const sectionRe =
  /^## \[Unreleased\][\s\S]*?(?=\n## \[)|^## \[Unreleased\][\s\S]*/m;

// Extract the legacy body from the captured section content (legacyHasBullets
// case only): strip the heading line, the trailing --- separator, and
// surrounding blank lines so we get the raw bullet text.
let legacyBody = '';
if (legacyHasBullets) {
  const m = txt.match(sectionRe);
  if (m) {
    legacyBody = m[0]
      .replace(/^## \[Unreleased\][^\n]*\n/, '')  // drop the heading line
      .replace(/\n---\s*$/, '')                    // drop trailing ---
      .replace(/^\n+/, '')                         // drop leading blank lines
      .replace(/\n+$/, '');                        // drop trailing blank lines
  }
}

// Build the new version section body:
//   legacyBody (if any) first, then assembled fragments (if any).
//   Parts are joined with a blank line; the whole block ends with one newline
//   so the replacement string can append \n\n before the next ## [ heading.
// Merge the legacy [Unreleased] body with the assembled fragment block and
// collapse any duplicate category headers (### Fixed appearing twice, etc.) —
// the bug that hit the 1.7.0 release when both sources coexisted.
const combined = [legacyBody, assembled].filter(Boolean).join('\n\n');
const sectionBody = combined ? mergeCategorySections(combined) + '\n' : '';

txt = txt.replace(
  sectionRe,
  thinUnreleased + '\n' + newHeading + '\n\n' + sectionBody
);

// Paranoia check: the earlier guard ensures [Unreleased] is present, so the
// replace above should always land. Verify the new version heading actually
// made it into the text before we overwrite CHANGELOG.md — fail loud, not silent.
const escapedVer = process.env.NEW_VERSION.replace(/[.*+?^\${}()|[\]\\\\]/g, '\\\\$&');
if (!new RegExp('^## \\\\[' + escapedVer + '\\\\]', 'm').test(txt)) {
  process.stderr.write('Promotion failed: new version section was not created (no prior \"## [\" heading to anchor on?).\n');
  process.exit(1);
}

fs.writeFileSync(clPath, txt);
})().catch((e) => { process.stderr.write(String((e && e.stack) || e) + '\n'); process.exit(1); });
"

# Delete consumed fragment files (staged by git rm — picked up by the commit
# below). .gitkeep and README.md are intentionally excluded from these globs.
FRAGS=$(find changelog.d -maxdepth 1 \( -name 'added-*.md' -o -name 'changed-*.md' -o -name 'fixed-*.md' -o -name 'security-*.md' \) 2>/dev/null | sort)
if [ -n "$FRAGS" ]; then
  # shellcheck disable=SC2086
  git rm -q -- $FRAGS
fi

node scripts/changelog-translations.mjs write-version --version "$NEW"
LOCALE_FRAGS=$(find changelog.i18n -mindepth 2 -maxdepth 2 \( -name 'added-*.md' -o -name 'changed-*.md' -o -name 'fixed-*.md' -o -name 'security-*.md' \) 2>/dev/null | sort)
if [ -n "$LOCALE_FRAGS" ]; then
  # shellcheck disable=SC2086
  git rm -q -- $LOCALE_FRAGS
fi

# --- Translate the new changelog entry for non-English locales ---
#
# Blocking for releases: every bundled changelog locale must contain THIS
# release's version before we commit/tag. The translator may skip API calls only
# when the JSON files already have the version (for example, a manual prefill).
node scripts/translate-changelog.mjs --require-complete
git add src/i18n/changelog/ru.json src/i18n/changelog/ar.json src/i18n/changelog/zh-Hans.json

# --- Commit, tag, push ---

git add package.json package-lock.json \
  src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json \
  CHANGELOG.md
git commit -m "release: ${TAG}"
git tag "$TAG"
git push origin main "$TAG"

# --- Optional: post the changelog section as the GitHub release body ---
#
# If `gh` is installed and authenticated, create a release pointing at
# the tag with the changelog body. CI may also create the release; we
# defer if a release already exists for this tag.

if command -v gh >/dev/null 2>&1; then
  # Extract just the body of the new vX.Y.Z section we just wrote.
  # Match the heading by parsing the `[VERSION]` token explicitly (not by
  # regex-escaping brackets — that would interpret [1.3.3] as a character
  # class matching one of "1.3"). The next `## [` line ends the section.
  BODY=$(awk -v ver="$NEW" '
    /^## \[/ {
      heading = $0
      sub(/^## \[/, "", heading)
      sub(/\].*$/, "", heading)
      if (heading == ver) { in_block = 1; next }
      if (in_block) { in_block = 0 }
    }
    in_block { print }
  ' CHANGELOG.md)
  if [[ -n "$BODY" ]]; then
    if ! gh release view "$TAG" >/dev/null 2>&1; then
      printf '%s\n' "$BODY" | gh release create "$TAG" --notes-file - --title "$TAG" \
        || echo "(gh release create failed — CI will likely fill it in)"
    else
      echo "(release $TAG already exists — leaving notes alone)"
    fi
  fi
fi

echo ""
echo "Released ${TAG} -- CI will build and publish."
