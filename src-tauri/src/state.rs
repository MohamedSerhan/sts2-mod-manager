use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

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
}

pub type AppState = Arc<Mutex<AppStateInner>>;

impl AppStateInner {
    pub fn new() -> Self {
        let config_path = dirs::config_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("sts2-mod-manager");

        let cache_path = dirs::cache_dir()
            .unwrap_or_else(|| PathBuf::from(".cache"))
            .join("sts2-mod-manager");

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
        let disabled_mods_path = mods_path.parent()
            .unwrap_or(&path)
            .join("mods_disabled");

        // Ensure mod directories exist
        let _ = std::fs::create_dir_all(&mods_path);
        let _ = std::fs::create_dir_all(&disabled_mods_path);

        self.mods_path = Some(mods_path);
        self.disabled_mods_path = Some(disabled_mods_path);
        self.game_path = Some(path);
    }
}

pub fn create_app_state() -> AppState {
    Arc::new(Mutex::new(AppStateInner::new()))
}
