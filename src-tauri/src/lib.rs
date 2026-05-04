mod backup;
mod download;
mod error;
mod game;
mod mod_sources;
mod mods;
mod nexus;
mod profiles;
mod quick_add;
mod sharing;
mod state;
mod subscriptions;
mod updater;

use state::create_app_state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let app_state = create_app_state();

    // Auto-detect game path on startup
    if let Some(game_path) = game::detect_game() {
        log::info!("Auto-detected game at: {}", game_path.display());
        if let Ok(mut s) = app_state.lock() {
            s.set_game_path(game_path);
        }
    } else {
        log::info!("Game not auto-detected; user must set path manually.");
    }

    // Attempt to load Nexus API key from system keyring
    if let Ok(entry) = keyring::Entry::new("sts2-mod-manager", "nexus-api-key") {
        if let Ok(key) = entry.get_password() {
            if let Ok(mut s) = app_state.lock() {
                s.nexus_api_key = Some(key);
                log::info!("Loaded Nexus API key from keyring.");
            }
        }
    }

    // Attempt to load GitHub token from system keyring
    if let Ok(entry) = keyring::Entry::new("sts2-mod-manager", "github-token") {
        if let Ok(token) = entry.get_password() {
            if let Ok(mut s) = app_state.lock() {
                s.github_token = Some(token);
                log::info!("Loaded GitHub token from keyring.");
            }
        }
    }

    // Check if vanilla mode flag was left from a previous session
    if let Ok(s) = app_state.lock() {
        let flag_path = s.config_path.join(".vanilla_mode");
        if flag_path.exists() {
            drop(s);
            if let Ok(mut s) = app_state.lock() {
                s.vanilla_mode = true;
                log::info!("Vanilla mode flag detected from previous session - will restore mods on next launch.");
            }
        }
    }

    tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_deep_link::init())
        .invoke_handler(tauri::generate_handler![
            // Game detection & QOL
            game::detect_game_path,
            game::set_game_path,
            game::get_game_info,
            game::open_mods_folder,
            game::open_game_folder,
            game::launch_game,
            game::launch_vanilla,
            game::set_github_token,
            game::get_active_profile,
            game::set_active_profile,
            // Mod management
            mods::get_installed_mods,
            mods::toggle_mod,
            mods::delete_mod_cmd,
            mods::install_mod_from_file,
            mods::enable_all_mods,
            mods::disable_all_mods,
            // Downloads
            download::search_github_mods,
            download::download_github_mod,
            download::download_url_mod,
            // Nexus Mods
            nexus::handle_nxm_link,
            nexus::get_nexus_mod_info,
            nexus::set_nexus_api_key,
            // Profiles
            profiles::list_profiles_cmd,
            profiles::create_profile,
            profiles::delete_profile_cmd,
            profiles::switch_profile,
            profiles::snapshot_profile,
            profiles::export_profile_cmd,
            profiles::import_profile_cmd,
            // Curator workflow
            updater::check_for_updates,
            updater::update_mod,
            updater::update_all_mods,
            quick_add::quick_add_mod,
            // Mod source linking
            mod_sources::get_mod_sources,
            mod_sources::set_mod_source,
            mod_sources::set_mod_sources_full,
            mod_sources::remove_mod_source,
            mod_sources::auto_detect_sources,
            mod_sources::find_github_from_nexus,
            // Dependency resolution
            mods::check_mod_dependencies,
            mods::get_mod_dependents,
            // Backup & safety
            backup::create_backup_cmd,
            backup::list_backups_cmd,
            backup::restore_backup_cmd,
            backup::reset_to_vanilla_cmd,
            // Sharing
            sharing::share_profile,
            sharing::reshare_profile,
            sharing::fetch_shared_profile_cmd,
            sharing::install_shared_profile,
            // Subscriptions (friend sync)
            subscriptions::subscribe_to_profile,
            subscriptions::get_subscriptions,
            subscriptions::unsubscribe,
            subscriptions::check_subscription_updates,
            subscriptions::apply_subscription_update,
        ])
        .setup(|app| {
            // Register deep link handler for nxm:// and sts2mm:// protocols
            #[cfg(desktop)]
            {
                use tauri::Listener;
                let handle = app.handle().clone();
                app.listen("deep-link://new-url", move |event| {
                    log::info!("Deep link received: {:?}", event.payload());
                    // Deep link events will be forwarded to the frontend
                    // The frontend handles NXM links via the handle_nxm_link command
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
