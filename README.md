<p align="center">
  <img src="public/icon.png?v=2" alt="STS2 Mod Manager" width="128" height="128" />
</p>

<h1 align="center">STS2 Mod Manager</h1>

<p align="center">
  A cross-platform mod manager for <strong>Slay the Spire 2</strong>.<br/>
  Built around playing your friends' modpacks — share via code or one-click link.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white" alt="Windows" />
  <img src="https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white" alt="macOS" />
  <img src="https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black" alt="Linux" />
  <img src="https://github.com/MohamedSerhan/sts2-mod-manager/actions/workflows/build.yml/badge.svg" alt="Build" />
</p>

<p align="center">
  <a href="https://github.com/MohamedSerhan/sts2-mod-manager/releases/latest"><strong>Download latest →</strong></a>
  ·
  <a href="https://mohamedserhan.github.io/sts2-mod-manager/">Website</a>
  ·
  <a href="https://github.com/MohamedSerhan/sts2-mod-manager/issues">Report a bug</a>
</p>

<p align="center">
  <img src="docs/screenshots/hero-home.png?v=1" alt="STS2 Mod Manager Home view — active modpack hero with Launch and a share-code chip" width="900" />
</p>

---

## Why this one

This mod manager has a social focus — built around sharing modpacks and
playing the same builds as your friends. The bits that don't usually
exist elsewhere:

- **Share by code or one-click link.** Friend pastes you
  `jess/AA5A-315D-61AE`, or clicks `sts2mm://import/jess/AA5A-315D-61AE`.
  Either way the app installs the pack — bundled mods and GitHub releases
  pull automatically; any Nexus-only mods the curator didn't bundle show
  up as pending so you know what to grab from Nexus. Re-shares reuse the
  same code so followers see "update available" instead of having to
  follow a new one.
- **Smart import.** Click a friend's link and the app figures out what to
  do: brand-new pack → confirm + install; you already have it but it's
  not active → "Switch to *X*?"; an update is pending → "Apply update?";
  already on the latest → friendly "you're already on this" toast.
- **Game-version aware Repair.** When a mod's latest release needs a
  newer Slay the Spire 2 build than yours, Repair walks back through
  the mod's release history and installs the newest version that's
  *actually compatible* with your game. No more "the manager says it's
  installed but the game won't load it."
- **Drift detection.** If your installed mods diverge from the active
  profile (you toggled something, an update reshaped a mod), the app
  flags it with a one-click Repair that re-applies the manifest.
- **Pin locks both version and on/off state.** Most managers only pin
  versions; a curator's modpack update can still toggle your pinned
  mods. This one prevents that.
- **No account, no telemetry.** Open source, MIT, ships standalone.
  Network calls go to GitHub releases and (optionally) the Nexus API. The
  only other outbound traffic is opt-in: if you hit **Report a bug**, a
  redacted diagnostic report (tokens, file paths, and your username stripped)
  is uploaded so it can be linked in a GitHub issue — nothing leaves the app
  unless you choose to send it.

---

## Status

**Feature-complete and usable for daily play.** Designed to keep working through
the Slay the Spire 2 1.0 launch and beyond without needing a manager update —
the game-version, mod-source, and share pipelines all read what the game and
mods ship today rather than baking in current values. PRs welcome; the codebase
is small enough that most additions are straightforward.

If you hit a bug, the **Home footer → Report a bug** button builds a redacted
report (recent logs, mod list, active modpack + load order, app and game
version) and opens a prefilled GitHub issue. On official release builds the
full report is uploaded and linked automatically — no token, nothing
truncated; otherwise the full report is copied to your clipboard to paste in.

---

## Features

### Modpacks & sharing
- **Import by code or link.** Paste a friend's `username/CODE` into the
  **Modpacks** page, or click their `sts2mm://import/...` link. Bundled mods +
  GitHub releases pull automatically; un-bundled Nexus mods surface as pending.
- **Smart import.** A code or link routes to the right action — install a new
  pack, switch to one you already have, apply a pending update, or just a
  "you're up to date" toast.
- **Same-code re-share.** Re-publishing a profile reuses the same share code —
  followers see "update available" instead of having to follow a new code.
- **Modpack switcher.** Top-bar modpack chip → popover with every pack;
  one click to activate.
- **Drift detection.** If your mods on disk diverge from the active profile's
  manifest, you get a banner with a one-click Repair (re-applies the manifest).

> **Your `sts2mm-profiles` repo on GitHub stays public.** The manager
> creates it that way and your share codes only work for friends
> because the manifest is publicly fetchable. Don't flip it to private
> on GitHub — your friends will get "Profile not found" when they try
> to install your code.

> **If you never publish a pack, no repo is created.** The
> `sts2mm-profiles` repo only appears on your GitHub the first time
> you hit Share. Solo users who only consume friends' packs never
> have anything written to their account.

### About modpack sharing

Share / Re-share uploads your pack to a public `<your-username>/sts2mm-profiles`
repo the manager creates on first share (via your GitHub OAuth login). It lives
on **your** account — nothing is hosted centrally, and no list of who's sharing
what is kept anywhere.

- **Remove a pack later:** delete its `.json` from your `sts2mm-profiles` repo,
  or delete the whole repo on GitHub.
- **Visibility:** the publish dialog offers Friends only (default — code-only)
  or Public (also listed in Browse Modpacks); switch anytime.
- **Sharing others' mods:** a glance at the mod's permissions page is good
  practice — a few authors mark mods "do not redistribute." The manager won't
  check for you.
- **Mod authors:** to request removal of a share, open an issue on the curator's
  `https://github.com/<owner>/sts2mm-profiles` repo or use GitHub's
  [DMCA process](https://github.com/contact/dmca) — the manager project can't
  act on content in other users' repos.

### Languages

- **English**, **Simplified Chinese (简体中文)**, **Russian (Русский)** and
  **Arabic (العربية)** are bundled — Arabic lays the UI out right-to-left.
- The picker lives in **Settings → General → Language** and the onboarding
  header. `Auto` follows your system locale (`zh-*` routes to Simplified
  Chinese until a Traditional translation exists).
- **The maintainer doesn't read most of these languages**, so accuracy depends
  on community contributors; non-English users get a What's New notice pointing
  at the translation tracker on each update. Spotted a mistake? Open an issue
  with the [`translation` label](https://github.com/MohamedSerhan/sts2-mod-manager/issues/new?labels=translation)
  or PR `src/i18n/locales/<code>.json`. New languages welcome — see
  [Translations](#translations).

### Mods
- **Toggle on/off** per-mod with instant effect.
- **Auto-updates.** "Update all" pulls fresh GitHub releases; pinned mods
  are skipped so a known-good version survives modpack updates.
- **Pin** locks both the version *and* the on/off state — pinned mods don't
  auto-update and modpack updates can't toggle them. Useful when a mod
  works perfectly at v1 and you want it to stay that way regardless of what
  the curator pushes.
- **Source linking.** Link a mod to its GitHub repo or Nexus page. GitHub
  links join the auto-update flow ("Update all"); Nexus links surface updates
  in the audit so you know to re-download from Nexus. Auto-detect button
  scans filenames against known sources.
- **Drag and drop** any `.zip` onto the window to install a mod.
- **Quick Add by URL** for one-off installs from a GitHub or Nexus URL.

### Browse Mods
- **GitHub search.** Full text search of GitHub repos with a Slay the Spire 2
  topic.
- **Nexus trending / latest.** Browse what's hot on Nexus directly inside the
  app (requires a free Nexus API key — Settings → Accounts). Nexus's free API
  doesn't expose general text search, so this surface is Trending and Latest
  Added only.
- **One-click install for GitHub cards.** Nexus cards open the mod's Files
  page in your browser — see the Nexus note below.
- **Browse Modpacks.** The **Browse** tab on the Modpacks page shows public
  modpacks people have opted into listing. Each pack is one click to install
  (same smart-import flow as paste-a-code). Your own packs default to
  unlisted — when you Share or Re-share, the Publish dialog has a
  Visibility option — Friends only (default) or Public. You can flip
  it anytime from the Publish dialog.

> **Nexus integration is free-tier only.** Installing a Nexus mod (via Quick
> Add or Browse Mods) opens the mod's Files page in your browser — click
> Nexus's **Slow Download** / **Manual** button (the free one) and the app's
> downloads-folder watcher picks up the saved zip and installs it. The **Mod
> Manager Download** (`nxm://`) button isn't wired in, and Nexus Premium's
> instant-download API isn't either — so stick to Slow / Manual, and paid
> subscribers don't get faster downloads here.

### Backups
- **Auto-backup before every launch.** Keeps the last 5 by default.
- **Backup-current-first on restore.** The restore confirm dialog ships
  with a pre-checked "save current as a new backup before restoring" option,
  so you can roll forward again if the restored state isn't what you wanted.

### Audit
- **Check for updates** scans each installed mod against its source and shows
  up-to-date / has-update / no-compatible-release. Run it from **Mod Library**
  for every mod, or from a modpack's detail page to check just that pack's
  mods.
- **Per-row pin toggle** to lock a mod at its current version even when the
  source publishes updates.

### App polish
- **First-run onboarding** — a branched welcome asks whether you want to play
  modpacks others made or make your own, then walks the matching path: detect
  the game install, connect optional accounts, and pick a first modpack.
- **Custom titlebar** with min / max / close controls.
- **In-app log viewer** with filter chips (Info / Warn / Error / Debug),
  free-text search, and "Send to support" that opens a GitHub issue prefilled
  with the recent log tail.
- **Keyboard shortcut.** `Ctrl/⌘ L` launches the active modpack from anywhere
  in the app.
- **Toasts** on every action with success / info / error severity.
- **Confirm dialogs** for destructive actions, with optional checkbox
  ("backup first") and typed-phrase confirmation for the really scary stuff.
- **Vanilla launch** — top-bar Vanilla button starts the game with all mods
  temporarily disabled (auto-backup runs first so the next launch puts
  everything back).
- **Launch mode (Steam vs Direct).** Defaults to Steam; Settings → General →
  Launch can switch to **Direct**, which runs the game executable itself (and
  drops a `steam_appid.txt` so Steamworks still inits). Useful for **Family
  Sharing borrowers** and **offline mode** — Steam still has to be running.
  On Linux, Direct needs a native binary; Proton-only installs get a clear
  error pointing back at Steam launch mode.

---

## Download

Grab the latest installer for your platform from the
[Releases page](https://github.com/MohamedSerhan/sts2-mod-manager/releases/latest):

- **Windows**: `.msi` (recommended) or `.exe`
- **macOS**: `.dmg` (universal — Intel + Apple Silicon)
- **Linux**: `.deb`, `.rpm`, or `.AppImage`

Once installed, the app auto-updates: it checks GitHub for new releases on
launch (at most once per day) and prompts you to install when one is available.

## macOS: First Launch Warning

The app isn't signed with an Apple Developer certificate, so on first launch
Gatekeeper shows *"…cannot be opened because the developer cannot be verified."*
To open it anyway:

1. Try opening the app once (it'll be blocked — that's expected).
2. **System Settings → Privacy & Security** → scroll to **Security** → click
   **Open Anyway** next to the STS2 Mod Manager notice, then confirm with your
   password / Touch ID.

You only need this once; in-app auto-updates afterward won't re-trigger it. If
it still won't open, strip the quarantine flag manually:

```bash
xattr -dr com.apple.quarantine "/Applications/STS2 Mod Manager.app"
```

## Windows: Antivirus False Positives

Some antivirus engines, including Microsoft Defender, occasionally flag the
Windows installer as a trojan or suspicious download. This can happen whether
you download from GitHub/Nexus or install through the in-app updater, because
both paths fetch the same release asset. **These are false positives when the
detections are generic heuristics.** The installer is built in public by
GitHub Actions from this repository's source — every release links the exact
commit it was built from, and you can compare any release on
[VirusTotal](https://www.virustotal.com) (typically 0–2 generic ML detections
out of ~70 engines, no named malware family).

Why it happens: the app is not Authenticode-signed (certificates cost money
this free project doesn't have), and it legitimately does things heuristic
scanners score as suspicious in *unsigned* binaries — it downloads and
extracts mod archives, self-updates, registers the `sts2mm://` link handler,
and checks whether the game process is running. Signed software does all of
the same things silently.

What you can do:

1. **Verify instead of trust**: upload the installer you downloaded to
   [VirusTotal](https://www.virustotal.com) and check that the few engines
   flagging it report only generic heuristics ("ML", "Gen", "Heur"), not a
   named family.
2. **Report the false positive** — this actually helps every other user:
   for Microsoft Defender, open **Windows Security → Protection history**,
   select the STS2 Mod Manager detection, and use Microsoft's false-positive
   submission flow. Kaspersky accepts samples at
   [opentip.kaspersky.com](https://opentip.kaspersky.com); most other vendors
   have similar portals.
3. **Allow-list the install folder** (`%LOCALAPPDATA%\STS2 Mod Manager`)
   if your AV keeps quarantining updates.

If a release is *widely* flagged with a named detection (not 1–2 generic
hits), do not install it — report it on the
[issue tracker](https://github.com/MohamedSerhan/sts2-mod-manager/issues)
immediately.

## Linux Notes

Some Arch-based distros (e.g. CachyOS) have a known FUSE issue with AppImages
that causes a blank window. If you hit this, install the **`.deb`** or
**`.rpm`** package instead — they use the system's WebKitGTK directly and work
around the issue.

**`sts2mm://` deep links:** the `.deb`, `.rpm`, `.msi`, `.exe`, and `.dmg`
installers all register the `sts2mm://` URL scheme automatically so clicking
a share link opens the app. The AppImage is a portable bundle with no install
step, so it tries to register the scheme at runtime on first launch. If that
fails (sandboxed Flatpak, read-only mount, restrictive distro policy), the
link won't open the app — paste the code into Home instead.

---

## Quick start

1. Install (see Download above).
2. On first launch, the **onboarding** runs. It first asks whether you want to
   play modpacks others made or make your own, then walks you through:
   1. **Find Slay the Spire 2** — auto-detected from Steam, or pick the
      install folder manually.
   2. **Connect accounts (optional)** — paste a Nexus API key for Nexus
      browsing; sign in to GitHub for higher API limits. You can skip both.
   3. **Pick your first modpack** — start vanilla, follow a friend's code, or
      import a JSON.
3. Hit the **Launch STS2** button in the top bar. An auto-backup runs first.

That's it. Day-to-day from there:

- **Got a friend's code or `sts2mm://` link?** Paste the code into the
  **Modpacks** page, or just click the link — the app routes you to the right
  action (install, switch, sync, or "you're already on it").
- **Following a pack that updated?** Home shows a **Sync** button on the active
  pack; the **Modpacks** sidebar badges any other followed pack with an update.
- **Publishing your own?** Open it in **Modpacks** → **Share**; you get back a
  code plus a paste-ready Discord message with the `sts2mm://` link.
- **Something broke?** Settings → Backups → **Restore** the most recent.

---

## Building from Source

Requires Rust (stable), Node.js 22+, and the
[Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your
platform.

```bash
git clone https://github.com/MohamedSerhan/sts2-mod-manager
cd sts2-mod-manager
npm install
npm run tauri dev    # development with HMR
npm run tauri build  # production bundle in src-tauri/target/release/bundle
```

The Rust backend lives in `src-tauri/`, the React frontend in `src/`. All
Tauri commands are registered in [src-tauri/src/lib.rs](src-tauri/src/lib.rs)
and exposed to TS via [src/hooks/useTauri.ts](src/hooks/useTauri.ts).

### Project layout

```
src/
  App.tsx                 # chrome (titlebar, sidebar, top bar, banners)
  views/                  # Home / Profiles (Modpacks) / Mods (Mod Library) /
                          #   Browse / BrowseModpacks / Settings / Help
  components/             # shared UI — dialogs, modals, tables, onboarding, …
  contexts/               # ToastContext, AppContext
  hooks/useTauri.ts       # all Tauri command bindings (one place)
  i18n/                   # i18next init + locale routing;
                          # locales/{en,zh-Hans,ru,ar}.json (parity-tested vs en)
  styles.css              # all theme tokens + utility classes (gf-*)
src-tauri/
  src/                    # Rust backend (game.rs, mods/, sharing/, backup.rs,
                          # download.rs, updater.rs, etc.)
  tauri.conf.json         # window config, bundle settings, updater config
.github/workflows/        # CI + release (ci.yml, build.yml)
```

---

## Contributing

Forks and PRs welcome — the codebase is small, so most additions are
straightforward. The Rust backend lives in `src-tauri/`, the React frontend in
`src/`. Wanted features (dependency auto-install + a dependency-tree view,
conflict detection, per-mod update progress) are tracked in the
[issues](https://github.com/MohamedSerhan/sts2-mod-manager/issues).

### Adding or changing user-visible strings

Every user-facing string lives in `src/i18n/locales/*.json`, and all locales
must stay key-for-key in sync with `en.json`. Add the English value, reference
it with `t('your.key')` / `<Trans>` (never hardcode prose in JSX, toasts,
`title=`, `aria-label=`, or `placeholder=`), and flag the PR for a human
translator if you can't translate it yourself. The i18n gate (`npm run qa:i18n`)
fails on missing keys or copied-English prose and **blocks release** — even
emergency ones. Full rules, including for AI-assisted contributions, are in
[`AGENTS.md`](AGENTS.md).

### Translations

PRs against `src/i18n/locales/*.json` are the fastest path — the maintainer
can't review accuracy, so PRs from native speakers merge on trust + parity-test
pass. To add a language: copy `en.json` to `<code>.json` (IETF tags like `fr`,
`ja`, `zh-Hant`), register the code in `src/i18n/language.ts` and import it in
`src/i18n/index.ts`. Family routing (e.g. `zh-Hant` → `zh-TW/HK/MO`) extends
`resolveOneLocale` in `language.ts`.

### Credits

- **Simplified Chinese translation:** initial work by
  [@xiatinfeng](https://github.com/xiatinfeng) in PR
  [#45](https://github.com/MohamedSerhan/sts2-mod-manager/pull/45),
  reworked onto current `main` and extended for new strings by the
  maintainer.
- **Russian localization, QA & feature ideas:**
  [@Solomag](https://github.com/Solomag) — *Chief Bug-Hunter &
  Idea-Smith.* Relentless playtesting, a steady stream of ideas that
  shaped the manager, and the full Russian translation.

---

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, ship your own version.

Built by [Mohamed Serhan](https://github.com/MohamedSerhan) with Tauri 2 +
React + Rust.
