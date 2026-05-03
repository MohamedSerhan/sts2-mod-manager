use std::fmt;

#[derive(Debug)]
pub enum AppError {
    Io(std::io::Error),
    Network(reqwest::Error),
    Json(serde_json::Error),
    GameNotFound(String),
    ModNotFound(String),
    InvalidProfile(String),
    NxmParseError(String),
    ZipError(zip::result::ZipError),
    UrlParseError(url::ParseError),
    Other(String),
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            AppError::Io(e) => write!(f, "IO error: {}", e),
            AppError::Network(e) => write!(f, "Network error: {}", e),
            AppError::Json(e) => write!(f, "JSON parse error: {}", e),
            AppError::GameNotFound(msg) => write!(f, "Game not found: {}", msg),
            AppError::ModNotFound(msg) => write!(f, "Mod not found: {}", msg),
            AppError::InvalidProfile(msg) => write!(f, "Invalid profile: {}", msg),
            AppError::NxmParseError(msg) => write!(f, "NXM parse error: {}", msg),
            AppError::ZipError(e) => write!(f, "ZIP error: {}", e),
            AppError::UrlParseError(e) => write!(f, "URL parse error: {}", e),
            AppError::Other(msg) => write!(f, "{}", msg),
        }
    }
}

impl std::error::Error for AppError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            AppError::Io(e) => Some(e),
            AppError::Network(e) => Some(e),
            AppError::Json(e) => Some(e),
            AppError::ZipError(e) => Some(e),
            AppError::UrlParseError(e) => Some(e),
            _ => None,
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(e: std::io::Error) -> Self {
        AppError::Io(e)
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        AppError::Network(e)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::Json(e)
    }
}

impl From<zip::result::ZipError> for AppError {
    fn from(e: zip::result::ZipError) -> Self {
        AppError::ZipError(e)
    }
}

impl From<url::ParseError> for AppError {
    fn from(e: url::ParseError) -> Self {
        AppError::UrlParseError(e)
    }
}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Other(s)
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Other(s.to_string())
    }
}

/// Convert AppError to a String for Tauri command return types.
impl From<AppError> for String {
    fn from(e: AppError) -> Self {
        e.to_string()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
