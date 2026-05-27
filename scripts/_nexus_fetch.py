#!/usr/bin/env python3
# scripts/_nexus_fetch.py
# Python shim called by scripts/nexus-triage.mjs to fetch HTML via curl_cffi.
# Required because Cloudflare's bot detection on Nexus blocks Node's curl-
# impersonate binary from CI runners; curl_cffi has a slightly different
# TLS fingerprint that the reference mod (jadistanbelly/sts2-multiplayer-save-slots)
# demonstrates works ~50% of the time in CI.
#
# Usage:
#   python scripts/_nexus_fetch.py <url> [--header "K: V" ...] [--impersonate chrome136]
#
# Env vars:
#   NEXUSMODS_CURL_IMPERSONATE  override the impersonate browser (default: chrome136)
#   NEXUS_HEADERS_JSON          JSON object of extra headers to merge in
#
# Stdout: raw HTML body
# Stderr: progress/error messages, last line is HTTP_STATUS=<code> on success
# Exit 0: success OR Cloudflare challenge (caller handles CF challenge via isCloudflareChallenge)
# Exit 1: real network failure (timeout, DNS, etc.)

import sys
import os
import json
import argparse

from curl_cffi import requests


def main():
    p = argparse.ArgumentParser(
        description='Fetch a URL via curl_cffi with TLS impersonation.')
    p.add_argument('url', help='URL to fetch')
    p.add_argument('--header', '-H', action='append', default=[],
                   help='Request header in "Key: Value" format (repeatable)')
    p.add_argument('--impersonate',
                   default=os.environ.get('NEXUSMODS_CURL_IMPERSONATE', 'chrome136'),
                   help='curl_cffi impersonate target (default: chrome136)')
    args = p.parse_args()

    headers = {}
    for h in args.header:
        if ':' not in h:
            print(f'bad header: {h}', file=sys.stderr)
            return 1
        k, v = h.split(':', 1)
        headers[k.strip()] = v.strip()

    # Allow extra headers from env (JSON object)
    env_headers = os.environ.get('NEXUS_HEADERS_JSON')
    if env_headers:
        try:
            headers.update(json.loads(env_headers))
        except json.JSONDecodeError as exc:
            print(f'NEXUS_HEADERS_JSON parse error: {exc}', file=sys.stderr)
            return 1

    try:
        sess = requests.Session(impersonate=args.impersonate)
        r = sess.get(args.url, headers=headers, timeout=30)
        sys.stdout.write(r.text)
        # Node side reads last "HTTP_STATUS=NNN" line from stderr
        print(f'HTTP_STATUS={r.status_code}', file=sys.stderr)
        return 0
    except Exception as exc:
        print(f'fetch error: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
