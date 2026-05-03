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
  version: string | null;
  author: string | null;
  category_id: number | null;
}

export interface ModUpdate {
  mod_name: string;
  current_version: string;
  latest_version: string;
  source: string;
  download_url: string;
}

export type QuickAddResult =
  | { type: 'github_installed'; mod_info: ModInfo }
  | { type: 'nexus_info'; nexus_info: NexusModInfo };

export interface ShareResult {
  id: string;
  url: string;
  secret_token: string;
}

export interface BackupInfo {
  name: string;
  timestamp: string;
  mod_count: number;
  size_bytes: number;
}
