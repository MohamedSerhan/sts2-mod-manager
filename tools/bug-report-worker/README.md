# Bug-report ingest Worker

A tiny Cloudflare Worker that lets STS2 Mod Manager upload a redacted
diagnostic report and get back a short view URL to put in a GitHub issue —
so reporters need **no token** and the report is never truncated into the
issue URL.

```
POST /          { "report": "<text>" }   ->  { "url": "<base>/r/<id>" }
GET  /r/<id>                              ->  the stored report (text/plain)
```

The app redacts paths / tokens / your GitHub username **before** uploading.
Reports are stored in KV for 90 days, then expire.

## Deploy (one time)

1. Install Wrangler and sign in:
   ```sh
   npm i -g wrangler
   wrangler login
   ```
2. Create the KV namespace and paste its id into `wrangler.toml`
   (`kv_namespaces[0].id`):
   ```sh
   wrangler kv namespace create REPORTS
   ```
3. (Recommended) Set a shared key so only the app can upload:
   ```sh
   wrangler secret put APP_KEY      # enter any long random string
   ```
4. Deploy:
   ```sh
   wrangler deploy
   ```
   Wrangler prints the Worker URL, e.g. `https://sts2-bug-reports.<you>.workers.dev`.

## Point the app at it

The app reads the endpoint from build-time env vars (so it ships only in
the releases you cut). Set them before `tauri build`:

```sh
# the Worker URL from `wrangler deploy`
export STS2_BUG_REPORT_ENDPOINT="https://sts2-bug-reports.<you>.workers.dev"
# only if you set APP_KEY above — must match exactly
export STS2_BUG_REPORT_KEY="<the same random string>"
npm run tauri build
```

If `STS2_BUG_REPORT_ENDPOINT` is unset, the app falls back to copying the
full report to the clipboard and opening a truncated prefilled issue — so
debug builds and forks work fine without any of this.

## Abuse protection

- `APP_KEY` blocks uploads that don't come from the app.
- Reports are capped at 512 KB and expire after 90 days.
- For rate limiting, add a Cloudflare WAF rate-limit rule on the Worker
  route (e.g. N requests/min per IP) — kept out of the Worker so you can
  tune it without redeploying.
