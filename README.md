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
  <img src="docs/screenshots/hero-home.png?v=1" alt="STS2 Mod Manager Home view — active profile hero with Launch and share-code Quick Add" width="900" />
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
  Network calls go to GitHub releases and (optionally) the Nexus API.
  Nothing else leaves the app.

---

## Status

**Feature-complete and usable for daily play.** Designed to keep working through
the Slay the Spire 2 1.0 launch and beyond without needing a manager update —
the game-version, mod-source, and share pipelines all read what the game and
mods ship today rather than baking in current values. PRs welcome; the codebase
is small enough that most additions are straightforward.

If you hit a bug, the **Home footer → Generate support bundle** button
copies a redacted text report (recent logs, mod list, profile state) to your
clipboard for pasting into a GitHub issue.

---

## Features

### Profiles & sharing
- **Profile import — code or link.** Paste a friend's `username/CODE` share
  code on Home, or click an `sts2mm://import/username/CODE` link they sent
  you. The app installs the pack: bundled mods and GitHub releases pull
  automatically; Nexus-only mods that weren't bundled surface as pending
  so you know what to grab.
- **Smart link handling.** A click on a share link routes through the same
  logic as paste: brand-new pack installs after a confirm; pack you
  already have asks to switch or apply a pending update; pack you're
  already on shows a friendly "you're up to date" toast.
- **Same-code re-share.** Re-publishing a profile reuses the same share code —
  followers see "update available" instead of having to follow a new code.
- **Profile switcher.** Top-bar profile chip → popover with every pack;
  one click to activate.
- **Drift detection.** If your mods on disk diverge from the active profile's
  manifest, you get a banner with a one-click Repair (re-applies the manifest).

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

### Browse
- **GitHub search.** Full text search of GitHub repos with a Slay the Spire 2
  topic.
- **Nexus trending / latest.** Browse what's hot on Nexus directly inside the
  app (requires a free Nexus API key — Settings → Accounts). Nexus's free API
  doesn't expose general text search, so this surface is Trending and Latest
  Added only.
- **One-click install for GitHub cards.** Nexus cards open the mod's Files
  page in your browser — see the Nexus note below.

> **Nexus integration is free-tier only.** When you install a Nexus mod
> via Quick Add or the Browse view, the app opens the mod's Files page
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
- **Settings → Audit** runs a scan that compares each installed mod against
  its source. Color-coded LEDs show up-to-date / has-update / no-compatible-release.
- **Per-row pin toggle** to lock a mod at its current version even when the
  source publishes updates.

### App polish
- **First-run onboarding wizard** — three gated steps: detect game install,
  connect optional accounts, pick a starter profile.
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
2. On first launch, the **onboarding wizard** runs. Steps:
   1. **Find Slay the Spire 2** — auto-detected from Steam, or pick the
      install folder manually.
   2. **Connect accounts (optional)** — paste a Nexus API key for Nexus
      browsing; sign in to GitHub for higher API limits. You can skip both.
   3. **Pick your first profile** — start vanilla, follow a friend's code, or
      import a JSON.
3. Hit the **Launch STS2** button in the top bar. An auto-backup runs first.

That's it. Day-to-day usage from there:

- Friend sends you a code? Paste it on Home and hit **Add Pack**.
- Friend sends you an `sts2mm://import/...` link? Just click it — the app
  opens and routes you through the right action (install, switch, sync, or
  "you're already on it").
- Modpack out of date? Profiles → **Update all** on the active pack.
- Something broke after a launch? Settings → Backups → **Restore** the most
  recent.
- Want to publish your own pack? Profiles → **Share** (paper-plane icon on
  the row). The app gives you back both the share code and a paste-ready
  message with the `sts2mm://` link so you can drop it into Discord and
  friends with the manager installed can click straight through.

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
  views/                  # Home / Profiles / Mods / Browse / Settings / Tutorial
  components/             # Button, Card, Toggle, Badge, Input,
                          # ConfirmDialog, OnboardingOverlay,
                          # ProfileSwitcher, KebabMenu, PublishModal,
                          # AutoDetectModal, QuickAddModal, BrowseDetail,
                          # SourceEditor, LogsViewer, DiagnosticBundle,
                          # LaunchSpinner, AboutCard, SubUpdateDetail
  contexts/               # ToastContext, AppContext
  hooks/useTauri.ts       # all Tauri command bindings (one place)
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

---

## License

MIT — see [LICENSE](LICENSE). Use it, fork it, ship your own version.

Built by [Mohamed Serhan](https://github.com/MohamedSerhan) with Tauri 2 +
React + Rust.
