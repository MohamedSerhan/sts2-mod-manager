#!/usr/bin/env bash
# patch-appimage-apprun.sh
#
# Patches the AppRun script inside a Tauri-generated AppImage to set
# LD_PRELOAD=/usr/lib/libwayland-client.so before exec'ing the binary.
#
# WHY THIS IS NEEDED
# ------------------
# On Arch-based distros (CachyOS, Manjaro, EndeavourOS) the AppImage bundles
# its own libwayland-client which may differ from the system's version.
# WebKit spawns WebKitGPUProcess as a child, which calls
# eglGetPlatformDisplay(EGL_PLATFORM_WAYLAND_KHR) using the mismatched
# library -> EGL_BAD_PARAMETER -> abort() -> blank white window.
#
# Preloading the system libwayland-client.so forces the correct version to
# be used by WebKitGPUProcess and other WebKit subprocesses.
#
# WHY LD_PRELOAD MUST BE SET IN AppRun (NOT IN THE RUST BINARY)
# -------------------------------------------------------------
# WebKitGTK explicitly strips LD_PRELOAD from subprocess environments as a
# security measure before spawning WebKitGPUProcess, WebKitWebProcess, etc.
# Setting LD_PRELOAD via std::env::set_var() in Rust application code is
# therefore too late — WebKit sanitises the environment before forking.
# Setting it in AppRun ensures it is present in the *main process* environment
# from the start, meaning it is already applied to the current process's
# dynamic linker state *and* is set before WebKit can strip it from children.
#
# USAGE
# -----
#   scripts/patch-appimage-apprun.sh <path/to/App.AppImage> [tag]
#
#   <path/to/App.AppImage>  Required. Path to the AppImage to patch in-place.
#   [tag]                   Optional. Git tag (e.g. v0.7.6). When provided the
#                           script also creates a signed .tar.gz + .sig pair
#                           suitable for tauri-plugin-updater and replaces the
#                           corresponding assets in the GitHub release.
#                           Requires GITHUB_TOKEN, TAURI_SIGNING_PRIVATE_KEY,
#                           and TAURI_SIGNING_PRIVATE_KEY_PASSWORD to be set.

set -euo pipefail

APPIMAGE="${1:?Usage: $0 <path/to/App.AppImage> [tag]}"
TAG="${2:-}"

APPIMAGE="$(realpath "$APPIMAGE")"
APPIMAGE_NAME="$(basename "$APPIMAGE")"
BUNDLE_DIR="$(dirname "$APPIMAGE")"
WORK_DIR="$(mktemp -d)"

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

echo "==> Patching AppRun in: $APPIMAGE_NAME"

# ---------------------------------------------------------------------------
# 1. Extract the AppImage
# ---------------------------------------------------------------------------
cp "$APPIMAGE" "$WORK_DIR/$APPIMAGE_NAME"
cd "$WORK_DIR"

# --appimage-extract unpacks the squashfs without needing a FUSE mount.
"./$APPIMAGE_NAME" --appimage-extract >/dev/null 2>&1
if [ ! -d squashfs-root ]; then
  echo "ERROR: AppImage extraction failed — squashfs-root not created." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# 2. Inject LD_PRELOAD fix into AppRun before the final exec line
# ---------------------------------------------------------------------------
APPRUN="squashfs-root/AppRun"

python3 - "$APPRUN" <<'PYEOF'
import sys, pathlib

apprun = pathlib.Path(sys.argv[1])
content = apprun.read_text()

# The patch is a POSIX sh snippet that finds the system libwayland-client.so
# and prepends it to LD_PRELOAD, then falls through to the normal exec.
patch = (
    "\n"
    "# LD_PRELOAD fix for Arch/Wayland blank white screen\n"
    "# (WebKitGTK strips LD_PRELOAD from child processes, so this must be\n"
    "#  set here in AppRun before the binary starts — not from Rust code.)\n"
    "for _wl in \\\n"
    "    /usr/lib/libwayland-client.so \\\n"
    "    /usr/lib/libwayland-client.so.0 \\\n"
    "    /usr/lib/x86_64-linux-gnu/libwayland-client.so.0 \\\n"
    "    /usr/lib64/libwayland-client.so.0; do\n"
    '    [ -f "$_wl" ] && export LD_PRELOAD="${_wl}${LD_PRELOAD:+:${LD_PRELOAD}}" && break\n'
    "done\n"
    "unset _wl\n"
)

lines = content.splitlines(keepends=True)
# Insert before the last exec line (the app launch exec, not an exec test)
patched = False
for i in range(len(lines) - 1, -1, -1):
    if lines[i].lstrip().startswith("exec "):
        lines.insert(i, patch)
        patched = True
        break

if not patched:
    print("WARNING: no exec line found in AppRun — appending patch at end.", file=sys.stderr)
    lines.append(patch)

apprun.write_text("".join(lines))
print("  AppRun patched.")
PYEOF

# ---------------------------------------------------------------------------
# 3. Repackage the AppImage
# ---------------------------------------------------------------------------
APPIMAGETOOL_URL="https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"

if ! command -v appimagetool &>/dev/null; then
  echo "==> Downloading appimagetool..."
  wget -q "$APPIMAGETOOL_URL" -O "$WORK_DIR/appimagetool"
  chmod +x "$WORK_DIR/appimagetool"
  APPIMAGETOOL="$WORK_DIR/appimagetool"
else
  APPIMAGETOOL="appimagetool"
fi

echo "==> Repacking AppImage..."
ARCH=x86_64 "$APPIMAGETOOL" --appimage-extract-and-run --no-appstream \
  squashfs-root "$APPIMAGE_NAME" 2>&1 | grep -v "^$" || true

# Replace the original AppImage with the patched one
cp "$APPIMAGE_NAME" "$APPIMAGE"
echo "==> Patched AppImage written to: $APPIMAGE"

# ---------------------------------------------------------------------------
# 4. (Optional) Re-sign and replace release assets for tauri-plugin-updater
# ---------------------------------------------------------------------------
if [ -n "$TAG" ]; then
  echo "==> Updating release assets for $TAG..."

  : "${GITHUB_TOKEN:?GITHUB_TOKEN must be set for release asset upload}"
  : "${TAURI_SIGNING_PRIVATE_KEY:?TAURI_SIGNING_PRIVATE_KEY must be set}"
  : "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:?TAURI_SIGNING_PRIVATE_KEY_PASSWORD must be set}"

  TARBALL="${APPIMAGE_NAME}.tar.gz"
  SIG="${TARBALL}.sig"

  cd "$BUNDLE_DIR"

  # Create updater tarball
  tar czf "$TARBALL" "$APPIMAGE_NAME"

  # Re-sign using the Tauri minisign key
  # minisign is not in Ubuntu 22.04 default repos — download a pre-built binary.
  if ! command -v minisign &>/dev/null; then
    MINISIGN_URL="https://github.com/jedisct1/minisign/releases/download/0.11/minisign-0.11-linux.tar.gz"
    wget -q "$MINISIGN_URL" -O /tmp/minisign.tar.gz
    tar -C /tmp -xf /tmp/minisign.tar.gz
    MINISIGN=/tmp/minisign-linux/x86_64/minisign
  else
    MINISIGN=minisign
  fi

  KEY_FILE="$(mktemp)"
  printf '%s' "$TAURI_SIGNING_PRIVATE_KEY" | base64 --decode > "$KEY_FILE"
  printf '%s\n' "$TAURI_SIGNING_PRIVATE_KEY_PASSWORD" | \
    "$MINISIGN" -Sm "$TARBALL" -s "$KEY_FILE"
  rm -f "$KEY_FILE"

  # Replace the three assets in the GitHub release
  gh release delete-asset "$TAG" "$APPIMAGE_NAME" --yes 2>/dev/null || true
  gh release delete-asset "$TAG" "$TARBALL"        --yes 2>/dev/null || true
  gh release delete-asset "$TAG" "$SIG"            --yes 2>/dev/null || true
  gh release upload "$TAG" "$APPIMAGE_NAME" "$TARBALL" "$SIG"

  echo "==> Release assets replaced for $TAG"
fi

echo "==> Done."
