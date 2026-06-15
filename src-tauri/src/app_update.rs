use std::ffi::OsString;
use std::path::Path;

use tauri_plugin_updater::UpdaterExt;

/// Build the NSIS `/D=<dir>` argument that forces an update install into the
/// directory of the app that initiated it. NSIS requires `/D=` to be the final
/// argument; tauri-plugin-updater appends custom installer args after its own
/// `/UPDATE /ARGS ...` parameters, so one custom arg is the right place for it.
pub(crate) fn nsis_install_dir_arg(install_dir: &Path) -> Option<OsString> {
    if install_dir.as_os_str().is_empty() {
        return None;
    }
    let mut arg = OsString::from("/D=");
    arg.push(install_dir.as_os_str());
    Some(arg)
}

#[cfg(windows)]
fn current_nsis_install_dir_arg() -> Option<OsString> {
    let exe = std::env::current_exe().ok()?;
    let install_dir = exe.parent()?;
    nsis_install_dir_arg(install_dir)
}

pub(crate) fn pin_current_nsis_install_dir(
    builder: tauri_plugin_updater::UpdaterBuilder,
) -> tauri_plugin_updater::UpdaterBuilder {
    #[cfg(windows)]
    {
        if let Some(arg) = current_nsis_install_dir_arg() {
            log::info!(
                "App update: pinning Windows NSIS install directory with {}",
                arg.to_string_lossy()
            );
            return builder.installer_arg(arg);
        }
        log::warn!("App update: could not determine current install directory for NSIS /D arg");
    }

    builder
}

#[tauri::command]
pub async fn install_app_update(app: tauri::AppHandle) -> Result<(), String> {
    let builder = pin_current_nsis_install_dir(app.updater_builder());

    let updater = builder
        .build()
        .map_err(|e| format!("Updater build error: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("Update check failed: {e}"))?
        .ok_or_else(|| "No app update is available.".to_string())?;

    log::info!(
        "Installing app update {} over {}",
        update.version,
        update.current_version
    );
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("Update install failed: {e}"))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nsis_install_dir_arg_preserves_spaces_without_quotes() {
        let arg =
            nsis_install_dir_arg(Path::new(r"C:\Users\tester\AppData\Local\STS2 Mod Manager"))
                .expect("argument");
        assert_eq!(
            arg.to_string_lossy(),
            r"/D=C:\Users\tester\AppData\Local\STS2 Mod Manager"
        );
    }

    #[test]
    fn nsis_install_dir_arg_rejects_empty_paths() {
        assert!(nsis_install_dir_arg(Path::new("")).is_none());
    }
}
