mod backup;
mod bug_report;
mod download;
mod downloads_watcher;
mod error;
mod external_open;
mod game;
// `mod_sources` and `mods` are pub so `tests/qa_scenarios.rs` can call
// scan_mods / install_mod_from_zip / load_sources / lookup_entry the
// same way Tauri commands do. Everything exposed here was already
// reachable through the IPC surface; this just makes the integration
// tests tractable.
pub mod mod_sources;
mod modpack_browser;
pub mod mods;
mod nexus;
pub mod profiles;
mod qa_cassette;
mod quick_add;
// `sharing` is pub for the same reason as `mods` / `mod_sources` / `updater`:
// integration tests in `src-tauri/tests/qa_scenarios.rs` exercise
// `download_bundle` directly so the qa-cassette release-asset path can be
// verified end-to-end without spinning up a Tauri window or a wiremock server.
pub mod sharing;
mod state;
mod subscriptions;
// `updater` is pub for the same reason as `mods` / `mod_sources`: the
// integration tests in `src-tauri/tests/` exercise check_all_updates +
// audit_mod_versions directly so the qa-cassette playback layer can be
// verified without spinning up a Tauri window.
pub mod updater;

use state::create_app_state;
use state::AppState;

/// Drain and return any `sts2mm://` URL that was received before the
/// frontend was ready to listen. Called once on mount by the React
/// deep-link router so cold-start URLs don't get lost. Subsequent URLs
/// arrive via the `sts2mm-open-url` Tauri event directly.
#[tauri::command]
fn consume_pending_deep_link(
    state: tauri::State<'_, AppState>,
) -> std::result::Result<Option<String>, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    Ok(s.pending_deep_link.take())
}

/// Set up logging to both stderr and a log file in the config directory.
fn setup_logging(log_path: &std::path::Path) {
    let _ = std::fs::create_dir_all(log_path.parent().unwrap_or(log_path));

    let log_file = fern::log_file(log_path).unwrap_or_else(|e| {
        eprintln!("Failed to open log file {:?}: {}", log_path, e);
        // Fallback: write to a temp file
        let tmp = std::env::temp_dir().join("sts2mm.log");
        fern::log_file(&tmp).expect("Failed to create any log file")
    });

    fern::Dispatch::new()
        .format(|out, message, record| {
            out.finish(format_args!(
                "[{} {} {}] {}",
                chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
                record.level(),
                record.target(),
                message
            ))
        })
        .level(log::LevelFilter::Info)
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("tao", log::LevelFilter::Warn)
        .chain(std::io::stderr())
        .chain(log_file)
        .apply()
        .unwrap_or_else(|e| eprintln!("Logger setup failed: {}", e));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("sts2-mod-manager");
    setup_logging(&config_dir.join("sts2mm.log"));

    // Startup banner -- makes it easy to find session boundaries when
    // reviewing a log dump from a user.
    log::info!(
        "==== sts2-mod-manager v{} starting (os={}, arch={}) ====",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
    );
    log::info!("Config dir: {}", config_dir.display());

    // One-shot banner so a tester reading the log can confirm cassette
    // playback is actually live for this run. The function returns false
    // in any shipped build (the feature isn't compiled in), so the log
    // line never appears in production user logs.
    if qa_cassette::is_active() {
        log::info!(
            "QA cassette playback ENABLED — outbound GitHub/Nexus GETs will read from {}",
            std::env::var("STS2_CASSETTE_DIR").unwrap_or_default(),
        );
    }

    let app_state = create_app_state();

    // QA harness escape hatch: if STS2_FIXTURE_GAME_PATH is set, use
    // that as the game path instead of auto-detecting. Lets the
    // WebDriver harness point the manager at a tempdir tree it
    // controls (with pre-installed mods, a fake release_info.json,
    // etc.) so UI specs aren't at the mercy of whatever the developer
    // happens to have on their real STS2 install. The path is taken
    // verbatim — caller is responsible for creating the directory and
    // populating it. Logged loudly so a misconfigured CI run is
    // obvious in the log dump.
    let fixture_game_path = std::env::var("STS2_FIXTURE_GAME_PATH")
        .ok()
        .map(std::path::PathBuf::from)
        .filter(|p| p.exists());
    if let Some(p) = fixture_game_path {
        log::info!(
            "STS2_FIXTURE_GAME_PATH override — using {} (auto-detect skipped)",
            p.display(),
        );
        if let Ok(mut s) = app_state.lock() {
            s.set_game_path(p);
        }
    } else {
        let restored_saved_game_path = if let Ok(mut s) = app_state.lock() {
            state::restore_persisted_game_path(&mut s, game::validate_game_path)
        } else {
            false
        };
        if !restored_saved_game_path {
            if let Some(game_path) = game::detect_game() {
                log::info!("Auto-detected game at: {}", game_path.display());
                if let Ok(mut s) = app_state.lock() {
                    let config_path = s.config_path.clone();
                    s.set_game_path(game_path.clone());
                    if let Err(e) = state::persist_game_path(&config_path, &game_path) {
                        log::warn!(
                            "Auto-detected game path but could not persist it to {}: {}",
                            config_path.display(),
                            e
                        );
                    }
                }
            } else {
                log::info!("Game not auto-detected; user must set path manually.");
            }
        }
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

    // Restore active profile from previous session
    if let Ok(mut s) = app_state.lock() {
        let profile_file = s.config_path.join("active_profile.txt");
        if let Ok(name) = std::fs::read_to_string(&profile_file) {
            let name = name.trim().to_string();
            if !name.is_empty() {
                log::info!("Restored active profile from previous session: {}", name);
                s.active_profile = Some(name);
            }
        }
    }

    // Restore configured launch mode (Steam vs Direct). Default is Steam
    // already wired through serde::Default on the enum; we only override
    // when the persisted file parses cleanly.
    if let Ok(mut s) = app_state.lock() {
        let lm_file = s.config_path.join("launch_mode.txt");
        if let Ok(raw) = std::fs::read_to_string(&lm_file) {
            if let Some(mode) = state::LaunchMode::parse(&raw) {
                log::info!(
                    "Restored launch mode from previous session: {}",
                    mode.as_str()
                );
                s.launch_mode = mode;
            } else {
                log::warn!(
                    "Ignoring unrecognized launch_mode.txt content: {:?}",
                    raw.trim()
                );
            }
        }
    }

    let mut builder = tauri::Builder::default();

    // Single-instance has to be the FIRST plugin so its launch-args
    // hook fires before anything else does. Skip on macOS — Apple's
    // OpenURL Apple-Event path already routes the second launch's URL
    // to the first instance, so single-instance there is redundant and
    // (per the plugin's own docs) interferes with Launch Services.
    //
    // We deliberately DON'T emit `sts2mm-open-url` from this callback,
    // even though we have argv in hand. The tauri-plugin-deep-link
    // "deep-link" feature on single-instance already wires the URL
    // through to the deep-link plugin's `on_open_url` handler (see
    // the setup() block below), and THAT handler is the single source
    // of truth for URL routing. Emitting here too would double-fire
    // the frontend listener — the bug that produced two identical
    // "Couldn't open share link" toasts per click. So this callback
    // only has one job: bring the existing window forward so the user
    // sees the confirm dialog when it appears.
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        use tauri::Manager;
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            log::info!("Second instance launched; argv={:?}", argv);
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.unminimize();
                let _ = win.set_focus();
            }
        }));
    }

    builder
        .manage(app_state)
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
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
            game::get_launch_mode,
            game::set_launch_mode,
            game::set_github_token,
            game::get_api_key_status,
            game::get_active_profile,
            game::set_active_profile,
            game::get_log_path,
            game::open_log_file,
            game::read_log_tail,
            game::is_game_running_cmd,
            external_open::open_external_url,
            // Mod management
            mods::get_installed_mods,
            mods::toggle_mod,
            mods::delete_mod_cmd,
            mods::install_mod_from_file,
            mods::enable_all_mods,
            mods::disable_all_mods,
            mods::delete_all_mods,
            // Downloads
            download::search_github_mods,
            download::download_github_mod,
            download::download_url_mod,
            // Nexus Mods
            nexus::handle_nxm_link,
            nexus::get_nexus_mod_info,
            nexus::set_nexus_api_key,
            nexus::nexus_get_trending,
            nexus::nexus_get_latest_added,
            // Profiles
            profiles::list_profiles_cmd,
            profiles::get_profile_memberships,
            profiles::set_profile_mod_membership,
            profiles::set_profile_load_order,
            profiles::create_profile,
            profiles::delete_profile_cmd,
            profiles::duplicate_profile,
            profiles::switch_profile,
            profiles::repair_profile,
            profiles::snapshot_profile,
            profiles::export_profile_cmd,
            profiles::import_profile_cmd,
            profiles::get_profile_drift,
            profiles::save_profile_drift,
            bug_report::upload_bug_report,
            // Curator workflow
            updater::check_for_updates,
            updater::update_mod,
            updater::repair_mod,
            updater::rollback_mod,
            updater::update_all_mods,
            updater::audit_mod_versions,
            quick_add::quick_add_mod,
            // Mod source linking
            mod_sources::get_mod_sources,
            mod_sources::set_mod_source,
            mod_sources::set_mod_sources_full,
            mod_sources::set_mod_extras,
            mod_sources::set_mod_display_overrides,
            mod_sources::set_mod_snooze,
            mod_sources::set_mod_tags,
            mod_sources::remove_mod_source,
            mod_sources::pin_mod,
            mod_sources::unpin_mod,
            mod_sources::auto_detect_sources,
            mod_sources::find_github_from_nexus,
            // Dependency resolution
            mods::check_mod_dependencies,
            mods::get_mod_dependents,
            // Backup & safety
            backup::create_backup_cmd,
            backup::create_backup_preserving_cmd,
            backup::list_backups_cmd,
            backup::restore_backup_cmd,
            backup::delete_backup_cmd,
            backup::reset_to_vanilla_cmd,
            // Sharing
            sharing::share_profile,
            sharing::reshare_profile,
            sharing::set_modpack_listing,
            sharing::get_share_info,
            sharing::fetch_shared_profile_cmd,
            sharing::install::install_shared_profile,
            modpack_browser::fetch_modpack_browser_page,
            // Deep link
            consume_pending_deep_link,
            // Subscriptions (friend sync)
            subscriptions::subscribe_to_profile,
            subscriptions::get_subscriptions,
            subscriptions::unsubscribe,
            subscriptions::check_subscription_updates,
            subscriptions::apply_subscription_update,
            subscriptions::repair_modpack_subscription,
        ])
        .setup(|app| {
            use tauri::{Emitter, Manager};

            // Nexus zips are caught via the Downloads-folder watcher
            // below — user clicks Nexus's Slow / Manual button, the zip
            // lands in ~/Downloads, watcher picks it up.
            {
                let handle = app.handle().clone();
                let watcher_state = app.state::<AppState>().inner().clone();
                downloads_watcher::start_downloads_watcher(handle, watcher_state);
            }

            // `sts2mm://import/<owner>/<code>` deep links. The OS routes
            // a clicked link to our `on_open_url` callback; we emit it as
            // a Tauri event so the frontend can run the SHARE-CODE smart
            // router (which handles "already have this pack" cases —
            // activate, apply pending update, or no-op).
            //
            // Cold-start ordering: when the OS launches the app WITH a
            // URL, this callback fires inside .setup() — before React
            // has mounted, so its `listen()` isn't registered yet and
            // the emit is lost. We buffer the URL in AppState; the
            // frontend drains it via `consume_pending_deep_link` on
            // mount. Warm-hit URLs (a second click while the app is
            // already running) fire through the emit + the buffer
            // (cheap belt-and-suspenders).
            //
            // Per-platform registration: the bundled MSI/NSIS (Win),
            // DMG (macOS), and .deb/.rpm (Linux) installers all
            // register the `sts2mm://` scheme automatically via the
            // plugin's bundler integration. AppImage doesn't — it's a
            // portable bundle, no install step. And `tauri dev` doesn't
            // either. We call `register()` here so both of those cases
            // work without user intervention. The call is idempotent
            // on installer-managed installs (writes the same registry
            // entry / .desktop file that's already there) so there's
            // no downside.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                let dl_state = app.state::<AppState>().inner().clone();
                if let Err(e) = app.deep_link().register("sts2mm") {
                    // Common failure modes: read-only filesystem (the
                    // AppImage user is running off a CD-ROM mount), a
                    // SELinux/AppArmor policy blocking the write, or a
                    // sandboxed Flatpak. Log and continue — the
                    // installer-registered scheme (if present) still
                    // works.
                    log::warn!(
                        "Couldn't runtime-register sts2mm:// handler: {} \
                         (links still work if you installed via MSI/DMG/deb/rpm; \
                         AppImage users may need AppImageLauncher or to add a \
                         .desktop file manually)",
                        e
                    );
                }
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let url_str = url.to_string();
                        log::info!("Deep link received: {}", url_str);
                        if let Ok(mut s) = dl_state.lock() {
                            s.pending_deep_link = Some(url_str.clone());
                        }
                        let _ = handle.emit("sts2mm-open-url", url_str);
                        // Bring the window forward so the user sees the
                        // confirm dialog without having to alt-tab back
                        // to a hidden window. No-op if already focused.
                        if let Some(win) = handle.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.unminimize();
                            let _ = win.set_focus();
                        }
                    }
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
