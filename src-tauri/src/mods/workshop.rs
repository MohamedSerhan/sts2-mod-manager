use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::game::{find_steam_path, parse_library_folders, STS2_STEAM_APPID};

use super::{scan_mods_inner, ModInfo, ModInstallSource};

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct WorkshopItemMetadata {
    pub manifest: Option<String>,
    pub size: Option<u64>,
    pub time_updated: Option<i64>,
    pub update_pending: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct AppWorkshopMetadata {
    pub needs_update: bool,
    pub needs_download: bool,
    pub items: HashMap<String, WorkshopItemMetadata>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum VdfToken {
    String(String),
    Open,
    Close,
}

fn tokenize_vdf(raw: &str) -> Vec<VdfToken> {
    let mut tokens = Vec::new();
    let mut chars = raw.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                let mut value = String::new();
                let mut escaped = false;
                for next in chars.by_ref() {
                    if escaped {
                        value.push(next);
                        escaped = false;
                        continue;
                    }
                    match next {
                        '\\' => escaped = true,
                        '"' => break,
                        _ => value.push(next),
                    }
                }
                tokens.push(VdfToken::String(value));
            }
            '{' => tokens.push(VdfToken::Open),
            '}' => tokens.push(VdfToken::Close),
            _ => {}
        }
    }
    tokens
}

fn parse_bool_flag(raw: &str) -> bool {
    matches!(raw.trim(), "1" | "true" | "True" | "TRUE")
}

fn metadata_item_mut<'a>(
    metadata: &'a mut AppWorkshopMetadata,
    path: &[String],
) -> Option<&'a mut WorkshopItemMetadata> {
    let section = path.get(path.len().checked_sub(2)?)?;
    if section != "WorkshopItemsInstalled" && section != "WorkshopItemDetails" {
        return None;
    }
    let item_id = path.last()?.trim();
    if item_id.is_empty() || !item_id.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some(metadata.items.entry(item_id.to_string()).or_default())
}

pub(crate) fn parse_appworkshop_acf(raw: &str) -> AppWorkshopMetadata {
    let tokens = tokenize_vdf(raw);
    let mut metadata = AppWorkshopMetadata::default();
    let mut path: Vec<String> = Vec::new();
    let mut index = 0usize;

    while index < tokens.len() {
        match &tokens[index] {
            VdfToken::String(key) => {
                if matches!(tokens.get(index + 1), Some(VdfToken::Open)) {
                    path.push(key.clone());
                    index += 2;
                    continue;
                }
                let Some(VdfToken::String(value)) = tokens.get(index + 1) else {
                    index += 1;
                    continue;
                };

                if path.last().is_some_and(|section| section == "AppWorkshop") {
                    match key.as_str() {
                        "NeedsUpdate" => metadata.needs_update = parse_bool_flag(value),
                        "NeedsDownload" => metadata.needs_download = parse_bool_flag(value),
                        _ => {}
                    }
                }

                if let Some(item) = metadata_item_mut(&mut metadata, &path) {
                    match key.as_str() {
                        "manifest" => item.manifest = Some(value.clone()),
                        "size" => item.size = value.parse::<u64>().ok(),
                        "timeupdated" => item.time_updated = value.parse::<i64>().ok(),
                        "NeedsUpdate" | "needs_update" | "NeedsDownload" | "needs_download" => {
                            item.update_pending = parse_bool_flag(value)
                        }
                        _ => {}
                    }
                }

                index += 2;
            }
            VdfToken::Open => index += 1,
            VdfToken::Close => {
                path.pop();
                index += 1;
            }
        }
    }

    metadata
}

pub(crate) fn workshop_url(item_id: &str) -> String {
    format!("https://steamcommunity.com/sharedfiles/filedetails/?id={item_id}")
}

pub(crate) fn workshop_item_id_from_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        return Some(trimmed.to_string());
    }

    for marker in ["?id=", "&id=", "/filedetails/?id=", "CommunityFilePage/"] {
        let Some((_, rest)) = trimmed.split_once(marker) else {
            continue;
        };
        let id: String = rest.chars().take_while(|ch| ch.is_ascii_digit()).collect();
        if !id.is_empty() {
            return Some(id);
        }
    }
    None
}

pub(crate) fn workshop_item_id_from_reference(
    source: Option<&str>,
    folder_name: Option<&str>,
) -> Option<String> {
    source.and_then(workshop_item_id_from_url).or_else(|| {
        let folder = folder_name?.trim();
        if folder.chars().all(|ch| ch.is_ascii_digit()) {
            Some(folder.to_string())
        } else {
            None
        }
    })
}

pub(crate) fn workshop_content_root_for_library(library: &Path) -> PathBuf {
    library
        .join("steamapps")
        .join("workshop")
        .join("content")
        .join(STS2_STEAM_APPID)
}

fn appworkshop_acf_for_library(library: &Path) -> PathBuf {
    library
        .join("steamapps")
        .join("workshop")
        .join(format!("appworkshop_{STS2_STEAM_APPID}.acf"))
}

pub(crate) fn workshop_content_roots() -> Vec<PathBuf> {
    let Some(steam_path) = find_steam_path() else {
        return Vec::new();
    };
    let mut roots = Vec::new();
    for library in parse_library_folders(&steam_path) {
        let root = workshop_content_root_for_library(&library);
        if root.is_dir() && !roots.iter().any(|existing| existing == &root) {
            roots.push(root);
        }
    }
    roots
}

fn existing_path(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn workshop_library_for_mods_path(
    mods_path: &Path,
    libraries: impl IntoIterator<Item = PathBuf>,
) -> Option<PathBuf> {
    let mods_path = existing_path(mods_path);
    libraries.into_iter().find(|library| {
        let common = existing_path(&library.join("steamapps").join("common"));
        mods_path.starts_with(common)
    })
}

pub(crate) fn workshop_item_dir(item_id: &str) -> Option<PathBuf> {
    let trimmed = item_id.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    workshop_content_roots()
        .into_iter()
        .map(|root| root.join(trimmed))
        .find(|dir| dir.is_dir())
}

fn numeric_item_id(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() || !trimmed.chars().all(|ch| ch.is_ascii_digit()) {
        return None;
    }
    Some(trimmed.to_string())
}

fn item_id_for_mod(info: &ModInfo) -> Option<String> {
    info.folder_name
        .as_deref()
        .and_then(numeric_item_id)
        .or_else(|| {
            info.files.iter().find_map(|file| {
                file.split(|ch| ch == '/' || ch == '\\')
                    .next()
                    .and_then(numeric_item_id)
            })
        })
}

fn annotate_workshop_mod(
    mut info: ModInfo,
    item_id: String,
    app_metadata: &AppWorkshopMetadata,
) -> ModInfo {
    let item_metadata = app_metadata.items.get(&item_id);
    info.install_source = ModInstallSource::SteamWorkshop;
    info.workshop_item_id = Some(item_id.clone());
    info.workshop_url = Some(workshop_url(&item_id));
    info.workshop_manifest = item_metadata.and_then(|item| item.manifest.clone());
    info.workshop_time_updated = item_metadata.and_then(|item| item.time_updated);
    info.workshop_update_pending = app_metadata.needs_update
        || app_metadata.needs_download
        || item_metadata.is_some_and(|item| item.update_pending);
    if info
        .source
        .as_ref()
        .is_none_or(|source| source.trim().is_empty())
    {
        info.source = info.workshop_url.clone();
    }
    info
}

pub(crate) fn scan_workshop_mods_from_root(
    root: &Path,
    appworkshop_acf_path: Option<&Path>,
) -> Vec<ModInfo> {
    if !root.is_dir() {
        return Vec::new();
    }
    let app_metadata = appworkshop_acf_path
        .and_then(|path| fs::read_to_string(path).ok())
        .map(|raw| parse_appworkshop_acf(&raw))
        .unwrap_or_default();

    scan_mods_inner(root, true)
        .into_iter()
        .filter_map(|info| {
            let item_id = item_id_for_mod(&info)?;
            Some(annotate_workshop_mod(info, item_id, &app_metadata))
        })
        .collect()
}

pub(crate) fn scan_workshop_mods_for_mods_path(mods_path: &Path) -> Vec<ModInfo> {
    let Some(steam_path) = find_steam_path() else {
        return Vec::new();
    };
    let Some(library) =
        workshop_library_for_mods_path(mods_path, parse_library_folders(&steam_path))
    else {
        return Vec::new();
    };
    let root = workshop_content_root_for_library(&library);
    if !root.is_dir() {
        return Vec::new();
    }
    let acf = appworkshop_acf_for_library(&library);
    scan_workshop_mods_from_root(&root, Some(&acf))
}

pub fn scan_workshop_mods() -> Vec<ModInfo> {
    let Some(steam_path) = find_steam_path() else {
        return Vec::new();
    };

    let mut mods = Vec::new();
    let mut seen_roots = Vec::<PathBuf>::new();
    for library in parse_library_folders(&steam_path) {
        let root = workshop_content_root_for_library(&library);
        if !root.is_dir() || seen_roots.iter().any(|seen| seen == &root) {
            continue;
        }
        seen_roots.push(root.clone());
        let acf = appworkshop_acf_for_library(&library);
        mods.extend(scan_workshop_mods_from_root(&root, Some(&acf)));
    }
    mods
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_appworkshop_item_metadata() {
        let raw = r#"
        "AppWorkshop"
        {
            "appid" "2868840"
            "NeedsUpdate" "0"
            "NeedsDownload" "1"
            "WorkshopItemsInstalled"
            {
                "3747602295"
                {
                    "size" "12798519"
                    "timeupdated" "1782640939"
                    "manifest" "7697508620998582885"
                }
            }
        }
        "#;

        let parsed = parse_appworkshop_acf(raw);
        assert!(!parsed.needs_update);
        assert!(parsed.needs_download);
        let item = parsed.items.get("3747602295").unwrap();
        assert_eq!(item.size, Some(12798519));
        assert_eq!(item.time_updated, Some(1782640939));
        assert_eq!(item.manifest.as_deref(), Some("7697508620998582885"));
    }

    #[test]
    fn scans_ritsulib_style_workshop_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("content").join(STS2_STEAM_APPID);
        let item = root.join("3747602295");
        fs::create_dir_all(&item).unwrap();
        fs::write(
            item.join("mod_manifest.json"),
            r#"{
              "id": "STS2-RitsuLib",
              "pck_name": "STS2-RitsuLib",
              "name": "RitsuLib",
              "author": "OLC",
              "description": "A shared Slay the Spire 2 mod framework library.",
              "version": "0.4.41",
              "dependencies": [],
              "min_game_version": "0.107.1"
            }"#,
        )
        .unwrap();
        fs::write(item.join("STS2-RitsuLib.dll"), b"dll").unwrap();
        let acf = temp.path().join("appworkshop_2868840.acf");
        fs::write(
            &acf,
            r#""AppWorkshop" { "WorkshopItemsInstalled" { "3747602295" { "manifest" "m1" "timeupdated" "1782640939" } } }"#,
        )
        .unwrap();

        let mods = scan_workshop_mods_from_root(&root, Some(&acf));
        assert_eq!(mods.len(), 1);
        let info = &mods[0];
        assert_eq!(info.install_source, ModInstallSource::SteamWorkshop);
        assert_eq!(info.workshop_item_id.as_deref(), Some("3747602295"));
        assert_eq!(info.name, "RitsuLib");
        assert_eq!(info.version, "0.4.41");
        assert_eq!(info.mod_id.as_deref(), Some("STS2-RitsuLib"));
        assert_eq!(info.min_game_version.as_deref(), Some("0.107.1"));
        assert_eq!(info.workshop_manifest.as_deref(), Some("m1"));
        assert_eq!(info.workshop_time_updated, Some(1782640939));
    }

    #[test]
    fn scans_nested_baselib_style_workshop_manifest() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("content").join(STS2_STEAM_APPID);
        let item = root.join("3737335127").join("BaseLib");
        fs::create_dir_all(&item).unwrap();
        fs::write(
            item.join("BaseLib.json"),
            r#"{
              "id": "BaseLib",
              "name": "BaseLib",
              "author": "Alchyr",
              "description": "Modding utility for Slay the Spire 2",
              "version": "v3.3.2",
              "has_pck": true,
              "has_dll": true,
              "dependencies": [],
              "affects_gameplay": false
            }"#,
        )
        .unwrap();
        fs::write(item.join("BaseLib.dll"), b"dll").unwrap();
        fs::write(item.join("BaseLib.pck"), b"pck").unwrap();
        let acf = temp.path().join("appworkshop_2868840.acf");
        fs::write(
            &acf,
            r#""AppWorkshop" { "WorkshopItemsInstalled" { "3737335127" { "manifest" "base-manifest" "timeupdated" "1782068851" } } }"#,
        )
        .unwrap();

        let mods = scan_workshop_mods_from_root(&root, Some(&acf));
        assert_eq!(mods.len(), 1);
        let info = &mods[0];
        assert_eq!(info.install_source, ModInstallSource::SteamWorkshop);
        assert_eq!(info.workshop_item_id.as_deref(), Some("3737335127"));
        assert_eq!(
            info.workshop_url.as_deref(),
            Some("https://steamcommunity.com/sharedfiles/filedetails/?id=3737335127")
        );
        assert_eq!(info.name, "BaseLib");
        assert_eq!(info.version, "v3.3.2");
        assert_eq!(info.mod_id.as_deref(), Some("BaseLib"));
        assert_eq!(info.folder_name.as_deref(), Some("BaseLib"));
        assert_eq!(info.workshop_manifest.as_deref(), Some("base-manifest"));
        assert_eq!(info.workshop_time_updated, Some(1782068851));
        assert!(info
            .files
            .iter()
            .any(|file| { file.replace('\\', "/") == "3737335127/BaseLib/BaseLib.json" }));
    }

    #[test]
    fn ignores_empty_workshop_item_folders() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("content").join(STS2_STEAM_APPID);
        fs::create_dir_all(root.join("3747602295")).unwrap();

        let mods = scan_workshop_mods_from_root(&root, None);
        assert!(mods.is_empty());
    }

    #[test]
    fn workshop_library_for_mods_path_requires_selected_steam_library() {
        let temp = tempfile::tempdir().unwrap();
        let selected_library = temp.path().join("SteamLibraryA");
        let other_library = temp.path().join("SteamLibraryB");
        let game_mods = selected_library
            .join("steamapps")
            .join("common")
            .join("Slay the Spire 2")
            .join("mods");
        fs::create_dir_all(&game_mods).unwrap();
        fs::create_dir_all(other_library.join("steamapps").join("common")).unwrap();

        let found = workshop_library_for_mods_path(
            &game_mods,
            [other_library.clone(), selected_library.clone()],
        );
        assert_eq!(found.as_deref(), Some(selected_library.as_path()));

        let unrelated_mods = temp.path().join("standalone-game").join("mods");
        fs::create_dir_all(&unrelated_mods).unwrap();
        let not_found =
            workshop_library_for_mods_path(&unrelated_mods, [selected_library, other_library]);
        assert!(not_found.is_none());
    }
}
