#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/updater-signature.sh
source "$ROOT_DIR/scripts/lib/updater-signature.sh"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

RAW_SIG="$TMP_DIR/raw.sig"
ENCODED_SIG="$TMP_DIR/encoded.sig"

cat > "$RAW_SIG" <<'SIG'
untrusted comment: signature from minisign secret key
RURuCFCtAvvSq1ym9rX1kxeBXKGM1fe9RbcV4OFIo8c/V9oGheTa15KNWGHqlvyuKZSmWN2rODbG8R87ceGAQh4NKsnc3HVBaAQ=
trusted comment: timestamp:1778301274	file:STS2 Mod Manager_1.0.0_amd64.AppImage	hashed
+2YBaa50R6h26V8+pxS56dqWD4fvvYLKar5u1b7QMjStwyLIKM15cDvvGM/mNOLOsDjWaPlxTRTDgQYGiHZVCQ==
SIG

base64 < "$RAW_SIG" | tr -d '\n' > "$ENCODED_SIG"

normalized_raw="$(tauri_signature_field "$RAW_SIG")"
expected_raw="$(cat "$ENCODED_SIG")"
if [[ "$normalized_raw" != "$expected_raw" ]]; then
  echo "raw minisign signatures must be base64 encoded for Tauri updater manifests" >&2
  exit 1
fi

normalized_encoded="$(tauri_signature_field "$ENCODED_SIG")"
if [[ "$normalized_encoded" != "$expected_raw" ]]; then
  echo "existing Tauri base64 signature files must be preserved unchanged" >&2
  exit 1
fi

printf '%s' "$normalized_raw" | base64 --decode > "$TMP_DIR/decoded.sig"
if ! cmp -s "$RAW_SIG" "$TMP_DIR/decoded.sig"; then
  echo "normalized signature must decode back to the original minisign payload" >&2
  exit 1
fi

echo "updater signature normalization ok"
