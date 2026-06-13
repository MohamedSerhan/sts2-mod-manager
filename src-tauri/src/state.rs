use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde::{Deserialize, Serialize};

const GAME_PATH_FILE: &str = "game_path.txt";
const NEXUS_DOWNLOAD_DIR_FILE: &str = "nexus_download_dir.txt";

/// How the user wants to start Slay the Spire 2 from the Launch button and
/// the `Ctrl/⌘ L` shortcut.
///
/// `Steam` (default) goes through `steam://rungameid/2868840` and keeps
/// cloud saves, achievements, and Proton on Linux working. `Direct`
/// invokes the game executable itself — useful for Family Sharing
/// borrowers, offline-mode users, and non-Steam copies, at the cost of
/// the Steam-side niceties. There's no auto-fallback between them: an
/// explicit user choice is the only thing that picks the path, so a
/// failed direct launch surfaces an error rather than quietly reaching
/// for Steam (which is what the borrower opted out of in the first place).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum LaunchMode {
    #[default]
    Steam,
    Direct,
}

impl LaunchMode {
    /// On-disk token for `launch_mode.txt`. Matches the serde lowercase
    /// form so a user editing the file by hand sees the same shape as
    /// the frontend / API.
    pub fn as_str(&self) -> &'static str {
        match self {
            LaunchMode::Steam => "steam",
            LaunchMode::Direct => "direct",
        }
    }

    pub fn parse(s: &str) -> Option<LaunchMode> {
        match s.trim().to_ascii_lowercase().as_str() {
            "steam" => Some(LaunchMode::Steam),
            "direct" => Some(LaunchMode::Direct),
            _ => None,
        }
    }
}

/// A Nexus mod that the user has just queued for download via Quick Add.
/// The downloads watcher uses this hint to attach the Nexus URL to the
/// resulting mod once the user clicks "Mod Manager Download" on Nexus.
#[derive(Debug, Clone)]
pub struct PendingNexusInstall {
    pub mod_name: String,
    pub nexus_url: String,
    pub game_domain: String,
    pub mod_id: u64,
    pub queued_at: Instant,
}

/// One page of cached modpack-browser results.
/// `fetched_at` is unix seconds since epoch.
#[derive(Debug, Clone)]
pub struct CachedBrowserPage {
    pub fetched_at: i64,
    pub cards: Vec<crate::modpack_browser::BrowserCard>,
    pub has_next_page: bool,
}

#[derive(Debug, Clone)]
pub struct AppStateInner {
    /// Detected or manually set game directory
    pub game_path: Option<PathBuf>,
    /// The mods/ subfolder inside the game directory
    pub mods_path: Option<PathBuf>,
    /// The mods_disabled/ subfolder for disabled mods
    pub disabled_mods_path: Option<PathBuf>,
    /// Local cache for downloaded archives
    pub cache_path: PathBuf,
    /// App configuration directory
    pub config_path: PathBuf,
    /// Where profile JSON files are stored
    pub profiles_path: PathBuf,
    /// Nexus Mods API key
    pub nexus_api_key: Option<String>,
    /// GitHub personal access token
    pub github_token: Option<String>,
    /// Flag: mods were disabled for vanilla launch and should be restored on next normal launch
    pub vanilla_mode: bool,
    /// Name of the currently active profile
    pub active_profile: Option<String>,
    /// Nexus mods queued by Quick Add but not yet downloaded. Consumed by the
    /// downloads watcher to attach Nexus URLs to auto-installed mods.
    pub pending_nexus_installs: Vec<PendingNexusInstall>,
    /// Profile names currently being shared/re-shared. Used as an in-flight
    /// guard so a double-click on Share / Re-share doesn't kick off a second
    /// upload that races the first one against the same gist files (causing
    /// 409 conflicts on GitHub's create-or-update endpoint).
    pub sharing_in_flight: HashSet<String>,
    /// Profile names whose active share/re-share should stop at the next
    /// cancellation checkpoint. The publish modal writes this through its
    /// Cancel button; ShareGuard clears it when the operation unwinds.
    pub sharing_cancel_requested: HashSet<String>,
    /// Slay the Spire 2 build version, parsed from `<game>/release_info.json`
    /// at startup or whenever the game path changes. Stored as a plain
    /// string ("v0.103.2", "0.105.0", etc.) so we can compare against
    /// each mod's `min_game_version` to flag incompatible installs and
    /// drive Repair's walk-back logic. None when the file is missing or
    /// can't be parsed — in that case we fail open and skip compatibility
    /// checks rather than blocking the user on a guess.
    pub game_version: Option<String>,
    /// A `sts2mm://...` URL that arrived before the React frontend was
    /// ready to listen for it (cold-start case — the OS launches the
    /// app with the URL as argv, the deep-link plugin's on_open_url
    /// fires inside .setup(), but the JS-side `listen('sts2mm-open-url')`
    /// isn't registered until React mounts). We buffer the URL here and
    /// the frontend drains it via `consume_pending_deep_link` on mount.
    /// Subsequent URLs (warm-hit case: user clicks another sts2mm:// link
    /// while the app is already running) skip the buffer and emit directly.
    pub pending_deep_link: Option<String>,
    /// How the Launch button and `Ctrl/⌘ L` should start STS2. Persisted
    /// in `<config>/launch_mode.txt`. Default `Steam`. See `LaunchMode`.
    pub launch_mode: LaunchMode,
    /// User-configured folder to watch for Nexus mod downloads. When `None`
    /// the watcher falls back to the OS default Downloads folder. Persisted
    /// in `<config>/nexus_download_dir.txt`.
    pub nexus_download_dir: Option<PathBuf>,
    /// How many automatic backups the manager keeps. Newest `N` are retained
    /// after each successful backup; `0` disables automatic backups entirely
    /// (existing backups are left untouched). Clamped to `0..=MAX_BACKUPS`.
    /// Persisted in `<config>/backup_retention.txt`.
    pub backup_retention: u8,
    /// In-memory cache for `fetch_modpack_browser_page`. Keyed by page
    /// number. TTL is enforced in the command, not here.
    pub modpack_browser_cache: std::collections::HashMap<u32, CachedBrowserPage>,
}

/// On-disk directory name for app data. Dev builds (version contains "-dev")
/// use a separate dir so testing never touches the release app's settings,
/// mod_sources.json, profiles/modpacks, cache, or logs. Release builds are
/// byte-for-byte unaffected. The QA env overrides (STS2_CONFIG_DIR /
/// STS2_CACHE_DIR) still take precedence at the call sites below.
pub fn app_dir_name() -> &'static str {
    dir_name_for(env!("CARGO_PKG_VERSION"))
}

/// Pure mapping from a version string to the data-dir name. Testable without a
/// build. Any version containing "-dev" (e.g. "1.6.1-dev.pr42.ga1b2c3d") maps
/// to the dev dir.
pub fn dir_name_for(version: &str) -> &'static str {
    if version.contains("-dev") {
        "sts2-mod-manager-dev"
    } else {
        "sts2-mod-manager"
    }
}

#[cfg(test)]
mod app_dir_name_tests {
    use super::dir_name_for;

    #[test]
    fn release_version_uses_base_dir() {
        assert_eq!(dir_name_for("1.6.1"), "sts2-mod-manager");
    }

    #[test]
    fn dev_version_uses_dev_dir() {
        assert_eq!(
            dir_name_for("1.6.1-dev.pr42.ga1b2c3d"),
            "sts2-mod-manager-dev"
        );
    }
}

pub type AppState = Arc<Mutex<AppStateInner>>;

impl AppStateInner {
    pub fn new() -> Self {
        // QA harness escape hatch: $STS2_CONFIG_DIR / $STS2_CACHE_DIR
        // redirect both directories to fresh tempdirs so the WebDriver
        // smoke doesn't read the developer's real mod_sources.json /
        // active_profile.txt / cached zips (which would tie test
        // outcomes to whatever the dev had on disk and could leak real
        // pinned-mod state into a deterministic test). When unset,
        // behavior is unchanged from a normal user install.
        let config_path = std::env::var("STS2_CONFIG_DIR")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::config_dir()
                    .unwrap_or_else(|| PathBuf::from("."))
                    .join(app_dir_name())
            });

        let cache_path = std::env::var("STS2_CACHE_DIR")
            .ok()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                dirs::cache_dir()
                    .unwrap_or_else(|| PathBuf::from(".cache"))
                    .join(app_dir_name())
            });

        let profiles_path = config_path.join("profiles");

        // Ensure directories exist
        let _ = std::fs::create_dir_all(&config_path);
        let _ = std::fs::create_dir_all(&cache_path);
        let _ = std::fs::create_dir_all(&profiles_path);

        Self {
            game_path: None,
            mods_path: None,
            disabled_mods_path: None,
            cache_path,
            config_path,
            profiles_path,
            nexus_api_key: None,
            github_token: None,
            vanilla_mode: false,
            active_profile: None,
            pending_nexus_installs: Vec::new(),
            sharing_in_flight: HashSet::new(),
            sharing_cancel_requested: HashSet::new(),
            game_version: None,
            pending_deep_link: None,
            launch_mode: LaunchMode::default(),
            nexus_download_dir: None,
            backup_retention: crate::backup::DEFAULT_BACKUP_RETENTION,
            modpack_browser_cache: std::collections::HashMap::new(),
        }
    }

    /// Update game-related paths when the game path is set.
    /// On macOS the game ships as a `.app` bundle and mods live inside
    /// `SlayTheSpire2.app/Contents/MacOS/mods/` rather than next to the bundle.
    pub fn set_game_path(&mut self, path: PathBuf) {
        let mods_path = {
            let mac_mods = path.join("SlayTheSpire2.app/Contents/MacOS/mods");
            if cfg!(target_os = "macos") && mac_mods.parent().map_or(false, |p| p.exists()) {
                mac_mods
            } else {
                path.join("mods")
            }
        };
        let disabled_mods_path = mods_path.parent().unwrap_or(&path).join("mods_disabled");

        // Ensure mod directories exist
        let _ = std::fs::create_dir_all(&mods_path);
        let _ = std::fs::create_dir_all(&disabled_mods_path);

        self.mods_path = Some(mods_path);
        self.disabled_mods_path = Some(disabled_mods_path);
        // Parse the game's release_info.json so we know which build the user
        // is on. Drives min_game_version compatibility checks and Repair's
        // walk-back. Failures are non-fatal — we just leave game_version as
        // None and skip the check (fail-open) rather than blocking the
        // user on a parse hiccup.
        self.game_version = read_release_info_version(&path);
        self.game_path = Some(path);
    }
}

/// Read `<game>/release_info.json` and pull out the `version` string.
///
/// The file's shape (verified against an actual STS2 install):
/// ```json
/// { "commit": "...", "version": "v0.103.2", "date": "...", ... }
/// ```
///
/// Returns the trimmed version string with a leading "v" stripped so
/// comparisons against mod manifests (which usually omit the "v") match.
/// Returns None on any read / parse error — caller should treat that as
/// "we don't know" and skip compatibility checks.
fn read_release_info_version(game_path: &Path) -> Option<String> {
    let path = game_path.join("release_info.json");
    let content = std::fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&content).ok()?;
    let raw = value.get("version")?.as_str()?.trim().to_string();
    let stripped = raw.trim_start_matches('v').to_string();
    if stripped.is_empty() {
        log::warn!(
            "release_info.json had empty version string at {}",
            path.display()
        );
        None
    } else {
        log::info!(
            "Detected game version v{} from {}",
            stripped,
            path.display()
        );
        Some(stripped)
    }
}

pub fn create_app_state() -> AppState {
    Arc::new(Mutex::new(AppStateInner::new()))
}

pub(crate) fn persist_game_path(config_path: &Path, game_path: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(config_path)?;
    std::fs::write(
        config_path.join(GAME_PATH_FILE),
        game_path.to_string_lossy().as_ref(),
    )
}

pub(crate) fn load_persisted_game_path(config_path: &Path) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(config_path.join(GAME_PATH_FILE)).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

pub(crate) fn persist_nexus_download_dir(config_path: &Path, dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(config_path)?;
    std::fs::write(
        config_path.join(NEXUS_DOWNLOAD_DIR_FILE),
        dir.to_string_lossy().as_ref(),
    )
}

pub(crate) fn load_persisted_nexus_download_dir(config_path: &Path) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(config_path.join(NEXUS_DOWNLOAD_DIR_FILE)).ok()?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

pub(crate) fn restore_persisted_game_path<F>(state: &mut AppStateInner, validate: F) -> bool
where
    F: Fn(&Path) -> bool,
{
    let Some(game_path) = load_persisted_game_path(&state.config_path) else {
        return false;
    };

    if !validate(&game_path) {
        log::warn!(
            "Saved game path no longer validates, ignoring for this startup: {}",
            game_path.display()
        );
        return false;
    }

    log::info!("Restored saved game path: {}", game_path.display());
    state.set_game_path(game_path);
    true
}

#[cfg(test)]
mod game_path_persistence_tests {
    use super::*;

    #[test]
    fn persisted_game_path_round_trips_from_config_dir() {
        let config = tempfile::tempdir().unwrap();
        let game = PathBuf::from(r"C:\Program Files (x86)\Steam\steamapps\common\Slay the Spire 2");

        persist_game_path(config.path(), &game).unwrap();

        assert_eq!(load_persisted_game_path(config.path()), Some(game));
    }

    #[test]
    fn blank_persisted_game_path_is_ignored() {
        let config = tempfile::tempdir().unwrap();
        std::fs::write(config.path().join("game_path.txt"), " \r\n ").unwrap();

        assert_eq!(load_persisted_game_path(config.path()), None);
    }

    #[test]
    fn restore_persisted_game_path_rehydrates_runtime_paths() {
        let config = tempfile::tempdir().unwrap();
        let game = tempfile::tempdir().unwrap();
        persist_game_path(config.path(), game.path()).unwrap();

        let mut state = AppStateInner {
            game_path: None,
            mods_path: None,
            disabled_mods_path: None,
            cache_path: config.path().join("cache"),
            config_path: config.path().to_path_buf(),
            profiles_path: config.path().join("profiles"),
            nexus_api_key: None,
            github_token: None,
            vanilla_mode: false,
            active_profile: None,
            pending_nexus_installs: Vec::new(),
            sharing_in_flight: HashSet::new(),
            sharing_cancel_requested: HashSet::new(),
            game_version: None,
            pending_deep_link: None,
            launch_mode: LaunchMode::default(),
            nexus_download_dir: None,
            backup_retention: crate::backup::DEFAULT_BACKUP_RETENTION,
            modpack_browser_cache: std::collections::HashMap::new(),
        };

        let expected_mods = game.path().join("mods");
        let expected_disabled = game.path().join("mods_disabled");
        assert!(restore_persisted_game_path(&mut state, |_| true));
        assert_eq!(state.game_path.as_deref(), Some(game.path()));
        assert_eq!(state.mods_path.as_deref(), Some(expected_mods.as_path()));
        assert_eq!(
            state.disabled_mods_path.as_deref(),
            Some(expected_disabled.as_path())
        );
    }
}

#[cfg(test)]
mod nexus_download_dir_persistence_tests {
    use super::*;

    #[test]
    fn persisted_nexus_download_dir_round_trips() {
        let config = tempfile::tempdir().unwrap();
        let dir = PathBuf::from("/custom/downloads");

        persist_nexus_download_dir(config.path(), &dir).unwrap();

        assert_eq!(load_persisted_nexus_download_dir(config.path()), Some(dir));
    }

    #[test]
    fn missing_nexus_download_dir_file_returns_none() {
        let config = tempfile::tempdir().unwrap();
        assert_eq!(load_persisted_nexus_download_dir(config.path()), None);
    }

    #[test]
    fn blank_nexus_download_dir_file_returns_none() {
        let config = tempfile::tempdir().unwrap();
        std::fs::write(config.path().join(NEXUS_DOWNLOAD_DIR_FILE), "  \n  ").unwrap();
        assert_eq!(load_persisted_nexus_download_dir(config.path()), None);
    }
}
