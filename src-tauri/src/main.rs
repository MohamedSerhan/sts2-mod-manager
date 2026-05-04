// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Known issue: AppImage builds show a blank white screen on Arch-based Linux
    // (CachyOS, Manjaro, EndeavourOS) due to a Tauri framework bug where WebKit's
    // GPU subprocess fails EGL init through the AppImage FUSE layer.
    // See: https://github.com/tauri-apps/tauri/pull/12491
    //
    // Environment variable workarounds (WEBKIT_DISABLE_COMPOSITING_MODE,
    // LIBGL_ALWAYS_SOFTWARE, etc.) do NOT fix this -- the issue is in how
    // AppImage propagates library paths to WebKit subprocesses.
    //
    // Workaround for Arch users: install from .rpm package instead of AppImage:
    //   bsdtar -C /tmp/rpm-extract -xf sts2-mod-manager.rpm
    //   sudo cp /tmp/rpm-extract/usr/bin/sts2-mod-manager /usr/local/bin/

    sts2_mod_manager_lib::run()
}
