#!/usr/bin/env bash
set -euo pipefail

# Usage: ./scripts/release.sh [patch|minor|major]

BUMP="${1:-}"
if [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  # Read current version from package.json
  CURRENT=$(node -p "require('./package.json').version")
  IFS='.' read -r MAJ MIN PAT <<< "$CURRENT"
  echo "Current version: $CURRENT"
  echo ""
  echo "  1) patch → ${MAJ}.${MIN}.$((PAT + 1))"
  echo "  2) minor → ${MAJ}.$((MIN + 1)).0"
  echo "  3) major → $((MAJ + 1)).0.0"
  echo ""
  read -rp "Choose [1/2/3]: " choice
  case "$choice" in
    1) BUMP="patch" ;;
    2) BUMP="minor" ;;
    3) BUMP="major" ;;
    *) echo "Invalid choice."; exit 1 ;;
  esac
fi

# Read current version from package.json
CURRENT=$(node -p "require('./package.json').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

case "$BUMP" in
  patch) PATCH=$((PATCH + 1)) ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
esac

NEW="${MAJOR}.${MINOR}.${PATCH}"
echo "Bumping $CURRENT → $NEW"

# Update all three version files
node -e "
const fs = require('fs');
for (const f of ['package.json', 'package-lock.json']) {
  if (!fs.existsSync(f)) continue;
  const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
  pkg.version = '$NEW';
  fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + '\n');
}
"

# Cargo.toml — replace first occurrence of version = "x.y.z"
sed -i "0,/^version = \".*\"/s//version = \"$NEW\"/" src-tauri/Cargo.toml

# tauri.conf.json
node -e "
const fs = require('fs');
const f = 'src-tauri/tauri.conf.json';
const conf = JSON.parse(fs.readFileSync(f, 'utf8'));
conf.version = '$NEW';
fs.writeFileSync(f, JSON.stringify(conf, null, 2) + '\n');
"

# Commit, tag, push
git add -A
git commit -m "release: v${NEW}"
git tag "v${NEW}"
git push origin main --tags

echo "✅ Released v${NEW} — CI will build and publish."
