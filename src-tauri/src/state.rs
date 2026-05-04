use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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
        }
    }

    /// Update game-related paths when the game path is set.
    pub fn set_game_path(&mut self, path: PathBuf) {
        let mods_path = path.join("mods");
        let disabled_mods_path = path.join("mods_disabled");

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
