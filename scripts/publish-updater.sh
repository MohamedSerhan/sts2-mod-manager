#!/usr/bin/env bash
set -euo pipefail

# Usage:
#   ./scripts/publish-updater.sh <tag> [repo]
#
# Assembles latest.json from the .sig files already attached to a GitHub
# release and uploads it back to that release. Safe to re-run; replaces any
# existing latest.json on the release.
#
# Requires: gh (authenticated), jq.
# In CI the workflow passes both args explicitly. Locally, omit <repo> and it
# is detected from the current git remote.

TAG="${1:-}"
REPO="${2:-}"

if [ -z "$TAG" ]; then
  echo "usage: $0 <tag> [repo]" >&2
  exit 2
fi

if [ -z "$REPO" ]; then
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
fi

VERSION="${TAG#v}"
BASE="https://github.com/${REPO}/releases/download/${TAG}"

SIGDIR=$(mktemp -d)
trap 'rm -rf "$SIGDIR"' EXIT
gh release download "$TAG" --repo "$REPO" --pattern "*.sig" --dir "$SIGDIR"

sig() {
  local f="${SIGDIR}/$1.sig"
  if [ -f "$f" ]; then cat "$f"; else echo ""; fi
}

ASSETS_JSON=$(gh release view "$TAG" --repo "$REPO" --json assets)
asset_name() {
  echo "$ASSETS_JSON" | jq -r ".assets[] | select(.name | test(\"$1\")) | .name" | head -1
}

NSIS=$(asset_name 'setup\\.exe$')
MSI=$(asset_name '\\.msi$')
APPIMAGE=$(asset_name '\\.AppImage$')
DEB=$(asset_name '\\.deb$')
RPM=$(asset_name '\\.rpm$')
APP_TAR=$(asset_name '\\.app\\.tar\\.gz$')

PUB_DATE=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")

PLATFORMS="{}"
add_platform() {
  local key="$1" file="$2"
  [ -z "$file" ] && return
  local signature
  signature=$(sig "$file")
  [ -z "$signature" ] && return
  PLATFORMS=$(echo "$PLATFORMS" | jq \
    --arg k "$key" --arg sig "$signature" --arg url "${BASE}/${file}" \
    '. + {($k): {signature: $sig, url: $url}}')
}

add_platform "darwin-aarch64"      "$APP_TAR"
add_platform "darwin-x86_64"       "$APP_TAR"
add_platform "darwin-aarch64-app"  "$APP_TAR"
add_platform "darwin-x86_64-app"   "$APP_TAR"

add_platform "linux-x86_64"           "$APPIMAGE"
add_platform "linux-x86_64-appimage"  "$APPIMAGE"
add_platform "linux-x86_64-deb"       "$DEB"
add_platform "linux-x86_64-rpm"       "$RPM"

if [ -n "$NSIS" ]; then
  add_platform "windows-x86_64"       "$NSIS"
  add_platform "windows-x86_64-nsis"  "$NSIS"
elif [ -n "$MSI" ]; then
  add_platform "windows-x86_64"       "$MSI"
fi
[ -n "$MSI" ] && add_platform "windows-x86_64-msi" "$MSI"

jq -n \
  --arg version "$VERSION" \
  --arg pub_date "$PUB_DATE" \
  --argjson platforms "$PLATFORMS" \
  '{version: $version, notes: "", pub_date: $pub_date, platforms: $platforms}' \
  > latest.json

echo "Generated latest.json with platforms:"
jq -r '.platforms | keys[]' latest.json

gh release delete-asset "$TAG" --repo "$REPO" "latest.json" --yes 2>/dev/null || true
gh release upload "$TAG" --repo "$REPO" latest.json
