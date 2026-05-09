#!/usr/bin/env bash

base64_one_line() {
  base64 < "$1" | tr -d '\n'
}

tauri_signature_field() {
  local file="${1:?signature file required}"
  local first_line
  first_line="$(sed -n '1p' "$file")"

  if [[ "$first_line" == "untrusted comment:"* ]]; then
    base64_one_line "$file"
  else
    tr -d '\r\n' < "$file"
  fi
}
