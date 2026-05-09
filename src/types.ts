export interface ModInfo {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  files: string[];
  source: string | null;
  hash: string | null;
  dependencies: string[];
  size_bytes: number;
  github_url: string | null;
  nexus_url: string | null;
  folder_name: string | null;
  mod_id: string | null;
  pinned: boolean;
}

export interface Profile {
  name: string;
  game_version: string | null;
  created_by: string | null;
  mods: ProfileMod[];
  created_at: string;
  updated_at: string;
}

export interface ProfileMod {
  name: string;
  version: string;
  source: string | null;
  hash: string | null;
  files: string[];
  enabled: boolean;
  bundle_url: string | null;
  folder_name: string | null;
  mod_id: string | null;
}

export interface SwitchProfileResult {
  applied: boolean;
  missing_mods: string[];
  downloaded: number;
  failed_downloads: string[];
}

export interface RepairProfileResult extends SwitchProfileResult {
  /** Mods that were on disk but not in the profile manifest, deleted as
   *  part of the repair. Includes both active and disabled folder orphans. */
  deleted_orphans: string[];
}

export interface GameInfo {
  game_path: string | null;
  mods_path: string | null;
  disabled_mods_path: string | null;
  mods_count: number;
  disabled_count: number;
  valid: boolean;
}

export interface GitHubRepo {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  updated_at: string;
  owner: { login: string; avatar_url: string };
}

export interface GitHubRelease {
  tag_name: string;
  name: string;
  published_at: string;
  assets: GitHubAsset[];
}

export interface GitHubAsset {
  name: string;
  size: number;
  browser_download_url: string;
}

export interface NexusModInfo {
  mod_id: number;
  name: string | null;
  summary: string | null;
  description: string | null;
  version: string | null;
  author: string | null;
  category_id: number | null;
  picture_url: string | null;
}

export interface ModUpdate {
  mod_name: string;
  current_version: string;
  latest_version: string;
  source_type: string;
  source_id: string;
  download_url: string;
}

export type QuickAddResult =
  | { type: 'github_installed'; mod_info: ModInfo }
  | { type: 'nexus_info'; nexus_info: NexusModInfo };

export interface ShareResult {
  code: string;
  owner: string;
  file_path: string;
  url: string;
}

export interface ModSourceEntry {
  github_repo: string | null;
  nexus_url: string | null;
  nexus_game_domain: string | null;
  nexus_mod_id: number | null;
}

export interface AutoDetectResult {
  matched: AutoDetectMatch[];
  unmatched: string[];
  /** Mods skipped because they already had a GitHub or Nexus link.
   *  Surfaced so the modal can show "X already linked — nothing to detect"
   *  instead of three confusing zero badges. */
  skipped_already_linked?: number;
}

export interface AutoDetectMatch {
  mod_name: string;
  github_repo: string;
  confidence: string;
}

export interface Subscription {
  share_id: string;
  share_url: string;
  profile_name: string;
  curator: string | null;
  last_checked: string;
  last_synced: string;
}

export interface SubscriptionUpdate {
  share_id: string;
  profile_name: string;
  has_update: boolean;
  added_mods: string[];
  removed_mods: string[];
  updated_mods: ModVersionChange[];
  remote_profile: Profile | null;
}

export interface ModVersionChange {
  name: string;
  old_version: string;
  new_version: string;
}

export interface BackupInfo {
  name: string;
  timestamp: string;
  mod_count: number;
  size_bytes: number;
}

export interface ModAuditEntry {
  mod_name: string;
  github_repo: string | null;
  installed_version: string;
  latest_release_tag: string | null;
  latest_release_with_assets_tag: string | null;
  latest_has_assets: boolean;
  needs_update: boolean;
  asset_names: string[];
  releases_scanned: number;
  error: string | null;
  nexus_url: string | null;
  nexus_version: string | null;
  nexus_update_available: boolean;
  update_source: string | null;
  github_auto_detected: boolean;
  pinned: boolean;
}

