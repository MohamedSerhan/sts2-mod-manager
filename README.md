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
- **Modpack import — code or link.** Paste a friend's `username/CODE` share
  code into the **Modpacks** page (Quick-Add), or click an
  `sts2mm://import/username/CODE` link they sent you. The app installs the
  pack: bundled mods and GitHub releases pull automatically; Nexus-only mods
  that weren't bundled surface as pending so you know what to grab.
- **Smart link handling.** A click on a share link routes through the same
  logic as paste: brand-new pack installs after a confirm; pack you
  already have asks to switch or apply a pending update; pack you're
  already on shows a friendly "you're up to date" toast.
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

The Share / Re-share flow uploads your pack to a public GitHub repo on
**your** account (`<your-username>/sts2mm-profiles`). The manager creates
that repo on first share using your OAuth login. The bundle exists so
profile-switching, repair, and recovery all work locally without
redownloading anything — sharing reuses the same bundle.

A few practical notes:

- The repo lives on **your** GitHub, not somewhere central. The manager's
  author doesn't host anything and keeps no list of who's sharing what.
- To remove a pack later: delete its `.json` from your `sts2mm-profiles`
  repo, or delete the whole repo from GitHub → Settings.
- The publish dialog has a Visibility option — Friends only (default) or
  Public. Friends only keeps the pack share-code-only — friends with the
  code can still install, but it won't appear in Browse Modpacks.

If you're sharing mods you didn't write yourself, glancing at the mod's
permissions page is good practice. Most authors are happy for their work
to travel; a few mark mods "do not redistribute" and respecting that
keeps the modding scene friendly. The manager won't check this for you.

**For mod authors:** the manager's author has no access to other users'
personal `sts2mm-profiles` repos and can't remove content from them. To
request removal of a specific share, open an issue on the curator's repo
at `https://github.com/<owner>/sts2mm-profiles`, or use GitHub's standard
process at <https://github.com/contact/dmca>. Requests sent to the
manager project repo can't be acted on from here.

### Languages

- **English** and **Simplified Chinese (简体中文)** are bundled.
- The picker lives in **Settings → General → Language** and in the
  onboarding header (top-right). `Auto` follows your system locale; any
  `zh-*` locale routes to Simplified Chinese until a Traditional
  translation exists.
- **The maintainer doesn't read Chinese.** Translation accuracy depends
  on community contributors — the first Chinese translation came from
  [@xiatinfeng](https://github.com/xiatinfeng) (PR
  [#45](https://github.com/MohamedSerhan/sts2-mod-manager/pull/45)),
  reworked by the maintainer for current `main`. Non-English users see a
  small notice on the What's New card pointing them at the translation
  issue tracker when they install a new version.
- **Spotted a translation mistake?** Open an issue with the
  [`translation` label](https://github.com/MohamedSerhan/sts2-mod-manager/issues/new?labels=translation)
  or send a PR against `src/i18n/locales/zh-Hans.json`. Pull requests
  adding new languages (`fr.json`, `ja.json`, `zh-Hant.json`, …) are
  welcome — the routing in `src/i18n/language.ts` is already set up to
  pick up additional locale codes.

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

> **Nexus integration is free-tier only.** When you install a Nexus mod
> via Quick Add or the Browse Mods view, the app opens the mod's Files page
> in your browser. From there: click Nexus's **Slow Download** /
> **Manual** button (the free one), wait the few seconds, and your
> browser saves the zip to `~/Downloads`. The app's downloads-folder
> watcher picks the zip up automatically and installs it.
>
> The app does NOT handle the **Mod Manager Download** button —
> Nexus's nxm:// deep-link route isn't wired through to the install
> pipeline. If you click Mod Manager Download, nothing happens.
> Stick to Slow / Manual.
>
> Nexus Premium's instant-download API isn't wired in either, so paid
> subscribers don't get faster downloads here. Everything free-tier-
> downloadable on Nexus works the same way for everyone.

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
- **Launch mode (Steam vs Direct).** Defaults to launching via Steam
  (`steam://rungameid/...`). Settings → General → Launch lets you switch to
  **Direct**, which runs the game executable itself and drops a
  `steam_appid.txt` next to it so STS2's Steamworks init won't bail out.
  Useful for **Steam Family Sharing borrowers** (the lender's library
  lock blocks normal Steam launches) and **Steam offline mode**. Steam
  itself still needs to be running — STS2 uses Steamworks for saves and
  achievements, so Direct bypasses the Steam *launcher*, not Steam-as-a-
  runtime. On Linux, Direct works only with a native binary; Proton-only
  installs (a Windows `.exe` with no Linux binary alongside) get a clear
  error pointing back at Steam launch mode rather than the manager trying
  to drive Proton itself.

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

The app is not signed with an Apple Developer certificate, so on first launch
macOS will show:

> "STS2 Mod Manager" cannot be opened because the developer cannot be verified.

This is Gatekeeper protecting you from unsigned apps. To open it anyway:

### Option 1 — System Settings (recommended on macOS Sequoia / Sonoma)

1. Try opening the app once (it will be blocked — that's expected).
2. Open **System Settings → Privacy & Security**.
3. Scroll to the **Security** section. You'll see *"STS2 Mod Manager was
   blocked to protect your Mac."*
4. Click **Open Anyway** and confirm with your password / Touch ID.
5. The app will launch. You only need to do this once.

### Option 2 — Right-click Open

1. In Finder, locate **STS2 Mod Manager.app**.
2. **Right-click** (or Control-click) the app → **Open**.
3. Click **Open** in the dialog that appears.

### Option 3 — Terminal (advanced)

If neither of the above works, strip the quarantine attribute manually:

```bash
xattr -dr com.apple.quarantine "/Applications/STS2 Mod Manager.app"
```

After the first launch, future auto-updates from within the app will not
re-trigger this warning.

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

That's it. Day-to-day usage from there:

- Friend sends you a code? Open the **Modpacks** page and paste it into
  Quick-Add.
- Friend sends you an `sts2mm://import/...` link? Just click it — the app
  opens and routes you through the right action (install, switch, sync, or
  "you're already on it").
- Following someone's pack and they pushed an update? Home shows a **Sync**
  button (with **View changes**) on the active pack, and the **Modpacks**
  sidebar item carries a badge for any other followed pack with a pending
  update.
- Want newer GitHub releases for your own mods? Open the modpack and run its
  updates check — pinned mods are skipped.
- Something broke after a launch? Settings → Backups → **Restore** the most
  recent.
- Want to publish your own pack? Open it in **Modpacks** and hit **Share**
  (or **Share this pack** on Home). The app gives you back both the share
  code and a paste-ready message with the `sts2mm://` link so you can drop it
  into Discord and friends with the manager installed can click straight
  through.

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
  views/                  # Home / Profiles / Mods / Browse / BrowseModpacks / Settings / Help
                          # (user-facing: Profiles = Modpacks, Mods = Mod Library;
                          #  Help also opens as a top-bar drawer — HelpDrawer)
  components/             # Button, Card, Toggle, Badge, Input,
                          # ConfirmDialog, OnboardingOverlay,
                          # ProfileSwitcher, KebabMenu, PublishModal,
                          # AutoDetectModal, QuickAddModal, BrowseDetail,
                          # SourceEditor, LogsViewer, DiagnosticBundle,
                          # LaunchSpinner, AboutCard, SubUpdateDetail,
                          # LanguageSelect, LibraryTable, LibraryRow,
                          # HelpDrawer, HelpHint, WhatsNewCard
  contexts/               # ToastContext, AppContext
  hooks/useTauri.ts       # all Tauri command bindings (one place)
  i18n/                   # i18next init, language detection/routing,
                          # locales/en.json + locales/zh-Hans.json,
                          # parity test (en ↔ zh-Hans keys must match)
  styles.css              # all theme tokens + utility classes (gf-*)
src-tauri/
  src/                    # Rust backend (game.rs, mods.rs, backup.rs,
                          # download.rs, sharing.rs, etc.)
  tauri.conf.json         # window config, bundle settings, updater config
.github/workflows/
  build.yml               # CI: builds Win/Mac/Linux on tag push
```

---

## Contributing

Forks and PRs welcome. Some areas where the design canvas is ahead of the
implementation (CSS classes are in `styles.css` already; the modals just need
the React components + matching Rust events):

- **Per-mod update progress** modal during "Update all" — needs a streaming
  Tauri event from `download::download_github_mod`.
- **Install conflict picker** when a Quick Add hits an existing mod —
  needs the install path to detect collisions before extraction.
- **Crash recovery prompt** when the game exits with a non-zero code — needs
  a process-watcher event from the launcher.
- **Dependency resolution** — needs a dependency field on the mod manifest.

The CSS for all of those (`.gf-prog-*`, `.gf-conflict-*`, `.gf-dep-*`) is
already wired so it's pure React work once the backend signals exist.

### Adding or changing user-visible strings

Every user-facing string lives in `src/i18n/locales/en.json` and
`src/i18n/locales/zh-Hans.json`. The two files must stay key-for-key in
sync, and supported locales must be translated before release. The i18n
gate fails on missing keys and copied-English fallback prose.

When you add a string:

1. Pick a key path that fits the surface it's on
   (`settings.general.foo`, `mods.toast.bar`, etc.).
2. Add the English value to `en.json` and a translation to
   `zh-Hans.json`. If you don't speak Chinese, flag the PR for a human
   translator before merge. Don't ship copied English placeholders or
   machine-translated guesses.
3. Reference the key from the component with `t('your.key')` or
   `<Trans i18nKey="your.key" components={…} />` — never hardcode prose
   in JSX, `toast.*`, `confirm({…})`, `title=`, `aria-label=`, or
   `placeholder=`.
4. Run `npm run qa:i18n` before pushing.

Release is blocked until this check passes. `scripts/release.sh` runs it
outside `SKIP_QA`, so emergency releases still cannot ship untranslated
supported locales.

The same rule applies to AI-assisted contributions — see `AGENTS.md`.

### Translations

Pull requests against `src/i18n/locales/*.json` are the fastest path. The
maintainer can't review translation accuracy, so PRs from native speakers
get merged on trust + parity-test pass.

Adding a new language:

1. Copy `src/i18n/locales/en.json` to `src/i18n/locales/<code>.json`
   (use IETF tags like `fr`, `ja`, `zh-Hant`).
2. Register the code in `src/i18n/language.ts`'s `SUPPORTED_LANGUAGES`
   array and import it in `src/i18n/index.ts`.
3. If your language family needs custom routing (e.g. `zh-Hant` should
   capture `zh-TW`, `zh-HK`, `zh-MO`), extend `resolveOneLocale` in
   `language.ts` — the Simplified Chinese path there is the model.

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
