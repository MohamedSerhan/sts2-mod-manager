<p align="center">
  <img src="public/icon.png?v=2" alt="STS2 Mod Manager" width="96" height="96" />
</p>

<h1 align="center">STS2 Mod Manager</h1>

<p align="center">
  A free, open-source <strong>Slay the Spire 2 mod manager</strong> focused on
  fast launches, shareable modpacks, source-aware updates, and safe backups.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/current-1.8.3-f4bf4f" alt="Current release: 1.8.3" />
  <img src="https://img.shields.io/badge/Windows-0078D6?logo=windows&logoColor=white" alt="Windows" />
  <img src="https://img.shields.io/badge/macOS-000000?logo=apple&logoColor=white" alt="macOS" />
  <img src="https://img.shields.io/badge/Linux-FCC624?logo=linux&logoColor=black" alt="Linux" />
  <img src="https://github.com/MohamedSerhan/sts2-mod-manager/actions/workflows/build.yml/badge.svg" alt="Build" />
</p>

<p align="center">
  <a href="https://github.com/MohamedSerhan/sts2-mod-manager/releases/latest"><strong>Download from GitHub Releases</strong></a>
  &nbsp;|&nbsp;
  <a href="https://mohamedserhan.github.io/sts2-mod-manager/">Website</a>
  &nbsp;|&nbsp;
  <a href="https://github.com/MohamedSerhan/sts2-mod-manager/issues">Report a bug</a>
</p>

<p align="center">
  <img src="docs/screenshots/hero-home.png?v=2" alt="STS2 Mod Manager Home view with the current top bar interface and fake modpack data" width="960" />
</p>

## At a Glance

| Need | What the app does |
| --- | --- |
| Install the manager | Download Windows, macOS, and Linux builds from [GitHub Releases](https://github.com/MohamedSerhan/sts2-mod-manager/releases/latest). |
| Play the same setup as friends | Paste a share code or click an `sts2mm://` link to install, switch to, or update a modpack. |
| Keep sources clear | Track GitHub releases, Nexus pages/downloads, Steam Workshop subscriptions, and manual archives without pretending they are the same thing. |
| Avoid broken launches | Repair chooses the newest mod release compatible with your Slay the Spire 2 game version, and launch checks treat active Workshop subscriptions as dependency providers. |
| Recover quickly | The app auto-backs up before launch and can restore a previous setup. |
| Stay private | No telemetry. Optional accounts and support bundles are only used when you choose those flows. |

## Why Players Use It

- **Modpacks first.** Follow a friend's pack by code, publish your own, browse public packs, and keep followers on the same share code when you re-share.
- **Current topbar workflow.** Home, Modpacks, Mod Library, and Settings live in the top bar; the active pack and launch controls stay reachable.
- **Source-aware updates.** GitHub releases can auto-update, Nexus files are handled through the browser/download watcher, and Workshop items stay Steam-owned.
- **Pin with intent.** Pinning locks both version and enabled/disabled state so a curator update cannot flip a mod you deliberately pinned.
- **Drift detection.** If disk state no longer matches the active modpack, the app flags it and offers one-click repair.
- **Open and inspectable.** MIT licensed, built in public with Tauri 2, React, TypeScript, and Rust.

## Screenshots

These screenshots use fake sample data and the current no-sidebar/topbar UI.

| Home | Modpacks | Mod Library |
| --- | --- | --- |
| <img src="docs/screenshots/hero-home.png?v=2" alt="Home view with Daily Cheese Build sample pack" width="320" /> | <img src="docs/screenshots/modpacks-dark.png?v=2" alt="Modpacks view with fake share codes and update state" width="320" /> | <img src="docs/screenshots/library-dark.png?v=2" alt="Mod Library view with fake installed mods and source labels" width="320" /> |

## Quick Start

1. Download the latest installer or portable build from [GitHub Releases](https://github.com/MohamedSerhan/sts2-mod-manager/releases/latest).
2. Launch the app and let onboarding find Slay the Spire 2, or pick the game folder manually.
3. Add mods with a drag-and-drop archive, a GitHub/Nexus URL, the download watcher, or a Workshop subscription already managed by Steam.
4. Paste a friend's `username/CODE`, click an `sts2mm://import/...` link, import a `.sts2pack`, or browse public modpacks in-app.
5. Press **Launch**. The app backs up first, then starts the selected modpack.

## Source Compatibility

App downloads are hosted on **GitHub Releases only**. The source integrations below are for mods and modpacks, not for distributing the manager itself.

| Source | Supported behavior |
| --- | --- |
| GitHub releases | Link a repo, install compatible release assets, update from releases, and include redistributable assets in shared packs. |
| Nexus Mods | Link mod pages, audit known sources, open the Files page in your browser, then let the downloads-folder watcher install the saved archive. |
| Steam Workshop | Show subscribed Workshop mods in the Library, prefer newer active Workshop copies when a local copy would shadow them, and reference them in modpacks by Workshop item ID. Steam remains the owner; the manager does not delete, repair, or auto-update Workshop files. |
| Manual archives | Drag and drop or import local `.zip`, `.7z`, and `.rar` archives when a mod source is not linkable. |

## Modpack Sharing

Share and Re-share publish a small manifest to a public `<your-username>/sts2mm-profiles` repo on your GitHub account. Friends can install with a code, and public packs can appear in the in-app Browse Modpacks tab when you opt in.

- Packs default to code-only sharing.
- Re-sharing reuses the same code, so followers see an update instead of needing a new link.
- If you later want a pack gone, delete its JSON file or the `sts2mm-profiles` repo from your GitHub account.
- The manager project does not host a central catalog of private packs.
- The manager itself is distributed through GitHub Releases, not Nexus Mods or Steam Workshop.

## Privacy and Openness

STS2 Mod Manager does not include telemetry. GitHub sign-in is only needed for publishing packs or higher GitHub API limits, and a Nexus API key is only needed for Nexus browsing/audits. The in-app support bundle is generated and sent only when you choose to report a bug; release builds redact sensitive paths, tokens, and usernames before upload.

<details>
<summary><strong>Install notes</strong></summary>

### Windows

Use the setup `.exe` for the normal installed app and updater flow, or the portable `.zip` if you want a self-contained folder. Unsigned hobby apps can trigger generic antivirus warnings; releases are built publicly by GitHub Actions from this repository.

### macOS

The app is not signed with an Apple Developer certificate. On first launch, macOS may block it until you open **System Settings -> Privacy & Security** and choose **Open Anyway** for STS2 Mod Manager.

If needed:

```bash
xattr -dr com.apple.quarantine "/Applications/STS2 Mod Manager.app"
```

### Linux

Use `.deb`, `.rpm`, or `.AppImage` from GitHub Releases. If an AppImage opens to a blank window on an Arch-based distro with FUSE issues, try the `.deb` or `.rpm` package instead.

</details>

<details>
<summary><strong>Build from source</strong></summary>

Requires Rust stable, Node.js 22+, and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
git clone https://github.com/MohamedSerhan/sts2-mod-manager
cd sts2-mod-manager
npm install
npm run tauri dev
npm run tauri build
```

Frontend code lives in `src/`, Rust backend code lives in `src-tauri/`, and Tauri command bindings are exposed to TypeScript through `src/hooks/useTauri.ts`.

</details>

<details>
<summary><strong>Contributing and translations</strong></summary>

PRs are welcome. User-visible strings must go through `react-i18next` and keep every locale file in sync; see [AGENTS.md](AGENTS.md) for the full rules. Player-facing behavior changes need focused tests/QA ownership, and docs-only changes do not need a changelog fragment.

Bundled languages include English, Simplified Chinese, Russian, and Arabic. Translation accuracy depends on community contributors.

Credits:

- Simplified Chinese translation: initial work by [@xiatinfeng](https://github.com/xiatinfeng).
- Russian localization, QA, and feature ideas: [@Solomag](https://github.com/Solomag).

</details>

## License

MIT - see [LICENSE](LICENSE). Slay the Spire 2 is a trademark of Mega Crit; this project is unaffiliated.
