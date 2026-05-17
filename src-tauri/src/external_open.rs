use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

const APPIMAGE_REMOVE_ENV: &[&str] = &[
    "APPDIR",
    "APPIMAGE",
    "ARGV0",
    "OWD",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
    "PYTHONHOME",
    "PYTHONPATH",
    "PERLLIB",
    "PERL5LIB",
    "GSETTINGS_SCHEMA_DIR",
    "GI_TYPELIB_PATH",
    "GIO_EXTRA_MODULES",
    "GDK_PIXBUF_MODULE_FILE",
    "GDK_PIXBUF_MODULEDIR",
    "GTK_EXE_PREFIX",
    "GTK_PATH",
    "GTK_IM_MODULE_FILE",
    "QT_PLUGIN_PATH",
    "QML2_IMPORT_PATH",
    "GST_PLUGIN_PATH",
    "GST_PLUGIN_SYSTEM_PATH",
    "GST_PLUGIN_SYSTEM_PATH_1_0",
    "TCL_LIBRARY",
    "TK_LIBRARY",
];

const HOST_PATH_FALLBACK: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const HOST_XDG_DATA_FALLBACK: &str = "/usr/local/share:/usr/share";

pub(crate) fn prepare_external_command(cmd: &mut Command) -> &mut Command {
    if !appimage_runtime_active() {
        return cmd;
    }

    let appdir = appdir_from_env();
    prepare_external_command_for_appimage(
        cmd,
        appdir.as_deref(),
        std::env::var_os("PATH"),
        std::env::var_os("XDG_DATA_DIRS"),
    )
}

fn prepare_external_command_for_appimage<'a>(
    cmd: &'a mut Command,
    appdir: Option<&Path>,
    path_value: Option<OsString>,
    xdg_data_dirs_value: Option<OsString>,
) -> &'a mut Command {
    for key in APPIMAGE_REMOVE_ENV {
        cmd.env_remove(key);
    }

    apply_clean_path_like_env(cmd, "PATH", path_value, appdir, Some(HOST_PATH_FALLBACK));
    apply_clean_path_like_env(
        cmd,
        "XDG_DATA_DIRS",
        xdg_data_dirs_value,
        appdir,
        Some(HOST_XDG_DATA_FALLBACK),
    );

    cmd
}

pub(crate) fn spawn_external_command(cmd: &mut Command) -> io::Result<Child> {
    prepare_external_command(cmd)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
}

pub(crate) fn open_external_blocking(path: impl AsRef<OsStr>) -> io::Result<()> {
    let mut last_err = None;
    for mut cmd in open::commands(path.as_ref()) {
        prepare_external_command(&mut cmd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        match cmd.status() {
            Ok(status) if status.success() => return Ok(()),
            Ok(status) => {
                last_err = Some(io::Error::new(
                    io::ErrorKind::Other,
                    format!("Launcher {cmd:?} failed with {status}"),
                ));
            }
            Err(err) => last_err = Some(err),
        }
    }
    Err(last_err
        .unwrap_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no opener command found")))
}

pub(crate) fn open_external_detached(path: impl AsRef<OsStr>) -> io::Result<()> {
    let mut last_err = None;
    for mut cmd in open::commands(path.as_ref()) {
        match spawn_external_command(&mut cmd) {
            Ok(_) => return Ok(()),
            Err(err) => last_err = Some(err),
        }
    }
    Err(last_err
        .unwrap_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no opener command found")))
}

#[tauri::command]
pub fn open_external_url(url: String) -> std::result::Result<bool, String> {
    let parsed = url::Url::parse(&url).map_err(|e| format!("Invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" | "mailto" | "tel" => {}
        scheme => return Err(format!("Unsupported URL scheme: {scheme}")),
    }

    open_external_detached(&url)
        .map(|_| true)
        .map_err(|e| format!("Failed to open URL: {e}"))
}

fn appimage_runtime_active() -> bool {
    std::env::var_os("APPDIR").is_some() || std::env::var_os("APPIMAGE").is_some()
}

fn appdir_from_env() -> Option<PathBuf> {
    std::env::var_os("APPDIR").map(PathBuf::from)
}

fn apply_clean_path_like_env(
    cmd: &mut Command,
    key: &str,
    value: Option<OsString>,
    appdir: Option<&Path>,
    fallback: Option<&str>,
) {
    let cleaned = value
        .and_then(|value| clean_path_like_value(&value, appdir))
        .or_else(|| fallback.map(OsString::from));

    if let Some(cleaned) = cleaned {
        cmd.env(key, cleaned);
    } else {
        cmd.env_remove(key);
    }
}

fn clean_path_like_value(value: &OsStr, appdir: Option<&Path>) -> Option<OsString> {
    let kept: Vec<PathBuf> = std::env::split_paths(value)
        .filter(|path| !appdir.is_some_and(|root| path.starts_with(root)))
        .collect();

    if kept.is_empty() {
        return None;
    }

    std::env::join_paths(kept).ok().map(OsString::from)
}

#[cfg(test)]
mod tests {
    use super::prepare_external_command_for_appimage;
    use std::env;
    use std::ffi::{OsStr, OsString};
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn env_change(cmd: &Command, key: &str) -> Option<Option<OsString>> {
        cmd.get_envs()
            .find(|(name, _)| *name == OsStr::new(key))
            .map(|(_, value)| value.map(OsStr::to_os_string))
    }

    fn split(value: &OsStr) -> Vec<PathBuf> {
        env::split_paths(value).collect()
    }

    #[test]
    fn appimage_child_commands_drop_bundled_runtime_env() {
        let appdir = Path::new("/tmp/.mount_STS2mm");
        let path_value = env::join_paths([
            appdir.join("usr/bin"),
            PathBuf::from("/usr/local/bin"),
            appdir.join("bin"),
            PathBuf::from("/usr/bin"),
        ])
        .unwrap();
        let xdg_value = env::join_paths([
            appdir.join("usr/share"),
            PathBuf::from("/usr/local/share"),
            PathBuf::from("/usr/share"),
        ])
        .unwrap();

        let mut cmd = Command::new("xdg-open");
        prepare_external_command_for_appimage(
            &mut cmd,
            Some(appdir),
            Some(path_value),
            Some(xdg_value),
        );

        for key in [
            "APPDIR",
            "APPIMAGE",
            "LD_LIBRARY_PATH",
            "LD_PRELOAD",
            "PYTHONHOME",
            "PYTHONPATH",
            "GSETTINGS_SCHEMA_DIR",
            "QT_PLUGIN_PATH",
            "GST_PLUGIN_SYSTEM_PATH",
        ] {
            assert_eq!(env_change(&cmd, key), Some(None), "{key} should be removed");
        }

        let cleaned_path = env_change(&cmd, "PATH")
            .and_then(|value| value)
            .expect("PATH should be overridden");
        let path_entries = split(&cleaned_path);
        assert_eq!(
            path_entries,
            vec![PathBuf::from("/usr/local/bin"), PathBuf::from("/usr/bin")]
        );
        assert!(!path_entries.iter().any(|path| path.starts_with(appdir)));

        let cleaned_xdg = env_change(&cmd, "XDG_DATA_DIRS")
            .and_then(|value| value)
            .expect("XDG_DATA_DIRS should be overridden");
        let xdg_entries = split(&cleaned_xdg);
        assert_eq!(
            xdg_entries,
            vec![
                PathBuf::from("/usr/local/share"),
                PathBuf::from("/usr/share")
            ]
        );
        assert!(!xdg_entries.iter().any(|path| path.starts_with(appdir)));
    }
}
