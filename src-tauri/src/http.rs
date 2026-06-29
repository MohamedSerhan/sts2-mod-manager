//! Shared HTTP client construction.
//!
//! reqwest 0.13 flipped its default TLS backend from native-tls to rustls
//! (`default-tls = ["rustls"]`), and `tauri-plugin-updater` pulls rustls into
//! the unified build regardless of our own features — so a plain
//! `reqwest::Client::builder()` would silently negotiate over rustls. We pin
//! native-tls here (SChannel on Windows, SecureTransport on macOS, OpenSSL on
//! Linux) so every app request keeps the exact TLS/cert behavior it had on the
//! 0.12 line. All client construction in the app should go through these
//! helpers rather than calling `reqwest::Client::builder()` directly.

/// An async reqwest client builder pinned to the native-tls backend.
pub fn https_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder().use_native_tls()
}
