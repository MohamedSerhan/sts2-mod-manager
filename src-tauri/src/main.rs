// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Fix white/blank screen and EGL crashes on Linux
    // WebKitGTK GPU acceleration fails on many setups:
    // - CachyOS/Arch: "Could not create default EGL display: EGL_BAD_PARAMETER"
    // - NVIDIA proprietary drivers: compositing failures
    // - Wayland with some GPU combos: blank window
    #[cfg(target_os = "linux")]
    {
        // Disable GPU compositing (fixes white screen)
        if std::env::var("WEBKIT_DISABLE_COMPOSITING_MODE").is_err() {
            std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
        }
        // Disable DMA-BUF renderer (fixes some NVIDIA issues)
        if std::env::var("WEBKIT_DISABLE_DMABUF_RENDERER").is_err() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        // Force software rendering for WebKitGTK (fixes EGL_BAD_PARAMETER crash)
        if std::env::var("WEBKIT_HARDWARE_ACCELERATION_POLICY").is_err() {
            std::env::set_var("WEBKIT_HARDWARE_ACCELERATION_POLICY", "NEVER");
        }
        // Use software GL if EGL is broken
        if std::env::var("LIBGL_ALWAYS_SOFTWARE").is_err() {
            std::env::set_var("LIBGL_ALWAYS_SOFTWARE", "1");
        }
    }

    sts2_mod_manager_lib::run()
}
