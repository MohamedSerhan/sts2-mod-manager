# Non-GitHub feedback channel (Nexus Posts pointer)

Give users who can't use GitHub — especially in mainland China, where GitHub
is unreliable — a way to send feedback that needs **no GitHub account**. The
app surfaces a clearly-labelled link to the mod's Nexus **Posts** tab; the
existing Nexus → GitHub triage automation already polls, (implicitly)
translates, and files everything posted there, so the maintainer keeps reading
English in the normal issues list.

Resolves #116. Sibling of #117 (local-file modpack sharing, already shipped) —
both reduce the app's reliance on GitHub.

## Why this channel (not email or an in-app form)

The deciding constraint is **reachability in mainland China without a VPN**,
because that is the audience #116 targets. Research (Cloudflare community +
China-Network docs, GFW behaviour) ranked the candidates:

- **In-app form → Cloudflare Worker** (the issue's Option B): *worst.*
  `*.workers.dev` is GFW-blocklisted (DNS-poisoned / sinkholed); a custom
  domain dodges that, but without an ICP licence Cloudflare's offshore IPs are
  throttled / selectively blocked. The form would fail for exactly the users it
  targets. The existing bug-report Worker (`tools/bug-report-worker/`) shares
  this problem.
- **Email** (the issue's Option A): *good* — the user's domestic mail provider
  relays server-to-server to an overseas mailbox, outside the device's GFW
  path (must avoid Gmail/Google, which the GFW scrambles). But it needs a new
  intake mailbox + poller to stand up.
- **Nexus Posts tab** (*chosen*): *good for this audience specifically* — every
  user reached Nexus to download the mod, so Nexus is reachable for them, and
  the triage automation already handles translation + filing. **Zero new
  infrastructure.**

The only *guaranteed* option is China-hosted infra with an ICP licence, which
violates the maintainer's "abandonable, nothing personal to maintain"
constraint. Among the realistic options, the Nexus pointer is the lowest-effort
one that actually reaches the audience and is already wired into translation.

**Decision:** ship the Nexus pointer now; an email / domestic-mailbox intake
remains a documented future option if Nexus proves insufficient.

## Goals

- A non-GitHub feedback path, **discoverable** to a user who can't/won't use
  GitHub.
- Incoming feedback reaches the maintainer **in English** (existing triage +
  reactive `@claude`).
- **Fully abandonable:** the channel is UI text + a URL constant; removing it
  (or retargeting the constant) removes it, with nothing tied to one person's
  inbox or identity.
- Localised, with first-class **zh-Hans** copy (the target audience).

## Out of scope

- Any backend, email intake, Cloudflare Worker, or bot token (rejected above on
  China-reachability + maintenance grounds).
- Changes to the triage automation itself — it already polls the Posts tab
  (`scripts/nexus-triage.mjs`, `GAME_DOMAIN='slaythespire2'`, `MOD_ID=856`).
- Replacing the existing GitHub / diagnostic-bundle path — it stays for users
  who *can* use GitHub (it carries richer diagnostics than a free-text comment).
- Deep-linking into a *prefilled* Nexus comment — Nexus exposes no such URL
  parameter.

## Architecture

Frontend-only. One new constants module + three call sites + i18n. No Rust /
Tauri changes — the existing `openExternalUrl` command opens the URL.

```
 AboutCard footer "Send feedback" button ┐
 DiagnosticBundle modal  "No GitHub?" row ├─► openExternalUrl(NEXUS_FEEDBACK_URL)
 LogsViewer "Send to support" link        ┘            │
                                                       ▼
                            https://www.nexusmods.com/slaythespire2/mods/856?tab=posts
                                                       │  (user writes a comment, any language)
                                                       ▼
                       existing Nexus→GitHub triage (local, daily) polls Posts tab
                                                       │  files a GitHub issue with @claude prompt
                                                       ▼
                          reactive @claude investigates + replies IN ENGLISH
                                                       │
                                                       ▼
                            maintainer reads English in the normal issues list
```

## Components

### `src/lib/nexusLinks.ts` (new)

Single source of truth for the mod's own Nexus URLs, mirroring
`src/lib/githubLinks.ts`:

```ts
export const NEXUS_GAME_DOMAIN = 'slaythespire2';
export const NEXUS_MOD_ID = '856';
export const NEXUS_FEEDBACK_URL =
  `https://www.nexusmods.com/${NEXUS_GAME_DOMAIN}/mods/${NEXUS_MOD_ID}?tab=posts`;
```

Matches the live triage constants so the link always points where the poller
reads.

### `src/components/AboutCard.tsx` — visible "Send feedback" footer action

A third ghost `Button`, alongside "Check for updates" / "Generate support
bundle", that calls `openExternalUrl(NEXUS_FEEDBACK_URL)`. This is the
discoverable, top-level entry point.

### `src/components/DiagnosticBundle.tsx` — in-flow alternative

A small secondary row in the modal, visible alongside the GitHub action:
"No GitHub account? **Post feedback on the Nexus page →**" plus a one-line
reassurance that it is read in any language. Opens the same URL. The existing
two-step GitHub / upload flow is untouched.

### `src/components/LogsViewer.tsx` — in-flow alternative

The same secondary link beside the existing "Send to support" button, reusing
the shared i18n keys.

## UX / copy

Shared keys under a `feedback.*` namespace, reused by all three sites (plus one
`about.*` button label). Decided English source strings:

- `feedback.noGitHubPrompt` — "No GitHub account?"
- `feedback.nexusCta` — "Post feedback on the Nexus page"
- `feedback.translatedNote` — "Write in your own language — we read every
  comment (translated to English automatically)."
- `about.sendFeedback` — "Send feedback"

Destination is the **Posts** tab — the general comments surface, the
lowest-friction "just write something" entry; the triage classifies posts into
bug / feature / question regardless. Bugs are equally welcome there. A single
CTA avoids choice-overload for non-English users.

## i18n

Add the keys above to **all four** locales — `en`, `zh-Hans`, `ru`, `ar` —
because `src/i18n/locales/parity.test.ts` enforces both (a) identical key sets
and (b) no copied-English values. A brand token ("Nexus" / "GitHub") embedded
inside an otherwise-translated sentence is fine; only a *whole value* equal to
English fails (unless allow-listed, which these are not).

- `en`: source copy.
- `zh-Hans`: carefully authored — this is the audience.
- `ru`, `ar`: AI-generated, pending human verification — consistent with the
  convention already documented in `parity.test.ts`.

## Error handling

An `openExternalUrl` rejection is caught and surfaced via the existing
`toast.error` pattern in each component. No new failure modes.

## Testing

- `src/lib/nexusLinks.test.ts` (new) — `NEXUS_FEEDBACK_URL` resolves to the
  `slaythespire2/mods/856?tab=posts` Posts URL.
- `AboutCard.test.tsx` — the "Send feedback" button renders and, when clicked,
  calls `openExternalUrl` with `NEXUS_FEEDBACK_URL`.
- `DiagnosticBundle.test.tsx` + `LogsViewer.test.tsx` — the Nexus link renders
  and clicking it calls `openExternalUrl` with the Posts URL.
- All tests use loud lookups (`getByRole` / `getByText`) and always assert
  visible behaviour — no `if (btn) click(btn)` silent-skip pattern.
- `parity.test.ts` (existing) gates the new keys across every locale.

## Acceptance (maps to #116)

- ✅ A non-GitHub way for a user to send feedback (Nexus Posts; no GitHub
  account required).
- ✅ Incoming feedback reaches the maintainer **in English** (existing triage +
  `@claude`).
- ✅ The channel can be disabled / handed off without code changes tied to one
  person — delete the button + links, or retarget `NEXUS_FEEDBACK_URL`; the
  intake is the public Nexus page plus the already-running triage.
