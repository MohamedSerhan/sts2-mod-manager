# GitHub Token Scope Discoverability

## Problem

A user reported that the GitHub token scopes required for publishing modpacks were hard to find: they only discovered them under the token input in Settings *after* already adding a token, and the info was absent during onboarding and from the Nexus listing.

Inspection confirms three in-app gaps:

1. **Onboarding wizard** (`src/components/OnboardingOverlay.tsx`, Step 2) frames the GitHub token purely as a rate-limit booster. It does not mention that the token is required to publish modpacks, nor what scopes are needed.
2. **Settings page** (`src/views/Settings.tsx:580-602`) shows full scope info only when the token is unsaved (or being replaced). Once saved, the block collapses to a single "Saved · raises API rate limit" line — so a returning user looking up scopes sees nothing.
3. **Tutorial → Creator Guide Step 1** (`src/views/Tutorial.tsx:394`) lists `repo` (classic) and `Contents: Read and write` (fine-grained) but **omits `Administration: Read and write`**, which Settings correctly states is needed for the one-time repo create. The tutorial contradicts Settings.

The Nexus listing (mod page on nexusmods.com) is also missing this info, but that page is not in the repo — it must be edited manually.

## Changes

### 1. Onboarding Step 2 — `src/components/OnboardingOverlay.tsx`

In the GitHub token field's help text, add a single sentence noting the publishing use case and required scopes. Keep it inline; no new UI elements.

Current text (when not saved):
> Skipping is fine — you'll just hit rate limits faster on Browse.

New text:
> Skipping is fine — you'll just hit rate limits faster on Browse. **Required to publish modpacks** — needs `repo` scope (classic PAT) or `Contents: R/W` + `Administration: R/W` (fine-grained).

### 2. Settings page — `src/views/Settings.tsx`

Make the scope info always visible below the token input. Currently it lives inside the `else` branch of the `githubTokenSaved && !githubToken` conditional; lift it out so it always renders, with the saved/unsaved-specific status line rendered above or below it.

The "Saved · raises API rate limit to 5,000 req/hr" line remains conditional; the scopes block becomes unconditional reference info.

### 3. Tutorial Creator Guide — `src/views/Tutorial.tsx:394`

Update the scope bullet to match Settings:

Current:
> Give it `repo` access (classic) or `Contents: Read and write` (fine-grained).

New:
> Give it `repo` access (classic) or `Contents: Read and write` + `Administration: Read and write` (fine-grained — Administration is only needed for the one-time repo create, you can drop it after).

### 4. Nexus listing snippet (out-of-repo)

Provide a paste-ready paragraph in the implementation reply for the user to add to the Nexus mod description. Not a code change.

## Out of Scope

- No "Test token" button or scope-validation on save.
- No new modal, popover, or help icon — inline text in existing locations only.
- `PublishModal.tsx` already states scopes correctly when blocking on missing token; leave it.

## Verification

- Onboarding: open the wizard (clear `onboarded` localStorage / first run), advance to Step 2, confirm the new text appears under the GitHub token input.
- Settings: open Settings → Accounts with a saved token, confirm scope info is visible without clearing the input.
- Tutorial: open Tutorial → Modpack Creator, confirm Step 1 lists the Administration scope.
- Existing tests in `Settings.test.tsx`, `PublishModal.test.tsx`, and any onboarding tests still pass. Add or update tests only if existing assertions reference the modified copy.
