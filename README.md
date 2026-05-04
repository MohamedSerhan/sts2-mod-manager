# STS2 Mod Manager

A cross-platform mod manager for Slay the Spire 2. Install, manage, and share mod profiles with one click.

## Download

Grab the latest installer for your platform from the [Releases page](https://github.com/MohamedSerhan/sts2-mod-manager/releases/latest):

- **Windows**: `.msi` (recommended) or `.exe`
- **macOS**: `.dmg` (universal — Intel + Apple Silicon)
- **Linux**: `.deb`, `.rpm`, or `.AppImage`

Once installed, the app auto-updates: it checks GitHub for new releases on launch (at most once per day) and prompts you to install when one is available.

## macOS: First Launch Warning

The app is not signed with an Apple Developer certificate (yet), so on first launch macOS will show:

> "STS2 Mod Manager" cannot be opened because the developer cannot be verified.

This is Gatekeeper protecting you from unsigned apps. To open it anyway:

### Option 1 — System Settings (recommended on macOS Sequoia / Sonoma)

1. Try opening the app once (it will be blocked — that's expected).
2. Open **System Settings → Privacy & Security**.
3. Scroll to the **Security** section. You'll see a message like *"STS2 Mod Manager was blocked to protect your Mac."*
4. Click **Open Anyway** and confirm with your password / Touch ID.
5. The app will launch. You only need to do this once.

### Option 2 — Right-click Open

1. In Finder, locate **STS2 Mod Manager.app** (in `/Applications` or wherever you installed it).
2. **Right-click** (or Control-click) the app → **Open**.
3. Click **Open** in the dialog that appears.

### Option 3 — Terminal (advanced)

If neither of the above works (e.g. on certain locked-down setups), strip the quarantine attribute manually:

```bash
xattr -dr com.apple.quarantine "/Applications/STS2 Mod Manager.app"
```

After the first launch, future auto-updates from within the app will not re-trigger this warning.

## Linux Notes

Some Arch-based distros (e.g. CachyOS) have a known FUSE issue with AppImages that causes a blank window. If you hit this, install the **`.deb`** or **`.rpm`** package instead — they use the system's WebKitGTK directly and work around the issue.

## Building from Source

Requires Rust (stable), Node.js 22+, and the Tauri 2 prerequisites for your platform.

```bash
npm install
npm run tauri dev    # development
npm run tauri build  # production bundle
```

## License

See repository for license details.
