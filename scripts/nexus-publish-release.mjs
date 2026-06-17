#!/usr/bin/env node
import { existsSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const RELEASE_ASSETS = [
  {
    key: 'macos',
    suffix: 'universal.dmg',
    groupEnv: 'NEXUS_FILE_GROUP_ID_MACOS',
    label: 'macOS Universal',
    groupName: 'STS2 Mod Manager (macOS Universal)',
    primary: false,
  },
  {
    key: 'linux',
    suffix: 'amd64.AppImage',
    groupEnv: 'NEXUS_FILE_GROUP_ID_LINUX',
    label: 'Linux AppImage',
    groupName: 'STS2 Mod Manager (Linux AppImage)',
    primary: false,
  },
  {
    key: 'windows',
    suffix: 'x64_portable.zip',
    groupEnv: 'NEXUS_FILE_GROUP_ID',
    label: 'Windows Portable',
    groupName: 'STS2 Mod Manager (Windows Portable)',
    primary: true,
  },
];

const DEFAULT_API_BASE = 'https://api.nexusmods.com/v3';
const DEFAULT_GAME_DOMAIN = 'slaythespire2';
const DEFAULT_GAME_SCOPED_MOD_ID = '856';
const DEFAULT_CONCURRENCY = 6;

export function filenameForAsset(version, asset) {
  return `STS2.Mod.Manager_${version}_${asset.suffix}`;
}

export function uploadDisplayName(version, asset) {
  return `STS2 Mod Manager ${version} (${asset.label})`;
}

export function orderedReleaseAssets(onlyKey = '') {
  const assets = [...RELEASE_ASSETS];
  const key = String(onlyKey || '').trim();
  if (!key) {
    return assets;
  }
  const asset = assets.find((candidate) => candidate.key === key);
  if (!asset) {
    const expected = assets.map((candidate) => candidate.key).join(', ');
    throw new Error(`Unknown --only asset "${key}". Expected one of: ${expected}`);
  }
  return [asset];
}

export function buildModFileBody({ uploadId, modId, version, asset }) {
  return {
    upload_id: uploadId,
    mod_id: modId,
    name: asset.groupName,
    version,
    file_category: 'main',
    primary_mod_manager_download: asset.primary,
    allow_mod_manager_download: true,
    show_requirements_pop_up: false,
  };
}

export function buildUpdateGroupBody({ uploadId, version, asset }) {
  return {
    upload_id: uploadId,
    name: uploadDisplayName(version, asset),
    version,
    file_category: 'main',
    archive_existing_file: true,
    primary_mod_manager_download: asset.primary,
    allow_mod_manager_download: true,
    show_requirements_pop_up: false,
  };
}

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    args.set(key, value);
    i += 1;
  }
  return args;
}

function requireValue(value, name) {
  if (!value || !String(value).trim()) {
    throw new Error(`${name} is required`);
  }
  return String(value).trim();
}

function createApiClient(apiKey, apiBase = DEFAULT_API_BASE) {
  return async function request(endpoint, options = {}) {
    const response = await fetch(`${apiBase}${endpoint}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        apikey: apiKey,
        'User-Agent': 'sts2-mod-manager-release-publisher',
        ...options.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`${options.method || 'GET'} ${endpoint} failed with ${response.status}: ${await response.text()}`);
    }
    if (response.status === 204) {
      return null;
    }
    return response.json();
  };
}

async function getModUuid(api, gameDomain, gameScopedModId) {
  const body = await api(`/games/${encodeURIComponent(gameDomain)}/mods/${encodeURIComponent(gameScopedModId)}`);
  return requireValue(body?.data?.id, 'Nexus mod UUID');
}

async function getUpdateGroups(api, modId) {
  const body = await api(`/mods/${encodeURIComponent(modId)}/file-update-groups`);
  return body?.data?.groups || body?.data?.data?.groups || body?.groups || [];
}

function findGroupId(groups, asset) {
  const match = groups.find((group) => {
    const name = String(group?.name || '').trim().toLowerCase();
    return name === asset.groupName.toLowerCase()
      || name === uploadDisplayName('', asset).replace('  ', ' ').trim().toLowerCase()
      || name.includes(asset.label.toLowerCase());
  });
  return match?.id ? String(match.id) : null;
}

export function configuredGroupIdForAsset(asset, env = process.env) {
  return String(env[asset.groupEnv] || '').trim();
}

export function allAssetsHaveConfiguredGroups(assets, env = process.env) {
  return assets.every((asset) => Boolean(configuredGroupIdForAsset(asset, env)));
}

async function createMultipartUpload(api, filename, sizeBytes) {
  const body = await api('/uploads/multipart', {
    method: 'POST',
    body: JSON.stringify({
      filename: path.basename(filename),
      size_bytes: String(sizeBytes),
    }),
  });
  return body.data;
}

async function uploadPart(fileHandle, partUrl, partNumber, totalParts, partSize) {
  const buffer = Buffer.alloc(partSize);
  const offset = (partNumber - 1) * partSize;
  const { bytesRead } = await fileHandle.read(buffer, 0, partSize, offset);
  const partData = bytesRead < partSize ? buffer.subarray(0, bytesRead) : buffer;

  console.log(`Uploading part ${partNumber}/${totalParts} (${bytesRead} bytes)`);
  const response = await fetch(partUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytesRead),
    },
    body: partData,
  });
  if (!response.ok) {
    throw new Error(`Part ${partNumber} upload failed with ${response.status}: ${await response.text()}`);
  }
  const etag = response.headers.get('ETag');
  if (!etag) {
    throw new Error(`Part ${partNumber} upload did not return an ETag`);
  }
  return { partNumber, etag: etag.replace(/"/g, '') };
}

async function uploadParts(filename, partUrls, partSize) {
  const fileHandle = await open(filename, 'r');
  const results = [];
  try {
    for (let i = 0; i < partUrls.length; i += DEFAULT_CONCURRENCY) {
      const batch = partUrls.slice(i, i + DEFAULT_CONCURRENCY);
      const uploaded = await Promise.all(batch.map((url, index) => (
        uploadPart(fileHandle, url, i + index + 1, partUrls.length, partSize)
      )));
      results.push(...uploaded);
    }
  } finally {
    await fileHandle.close();
  }
  return results;
}

function multipartXml(parts) {
  const body = parts
    .sort((a, b) => a.partNumber - b.partNumber)
    .map((part) => `  <Part>\n    <PartNumber>${part.partNumber}</PartNumber>\n    <ETag>${part.etag}</ETag>\n  </Part>`)
    .join('\n');
  return `<CompleteMultipartUpload>\n${body}\n</CompleteMultipartUpload>`;
}

async function completeMultipartUpload(completeUrl, parts) {
  const response = await fetch(completeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: multipartXml(parts),
  });
  if (!response.ok) {
    throw new Error(`Completing multipart upload failed with ${response.status}: ${await response.text()}`);
  }
}

async function finaliseUpload(api, uploadId) {
  const body = await api(`/uploads/${encodeURIComponent(uploadId)}/finalise`, { method: 'POST' });
  return body.data;
}

async function pollUploadAvailable(api, uploadId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const body = await api(`/uploads/${encodeURIComponent(uploadId)}`);
    const state = body?.data?.state;
    console.log(`Upload ${uploadId} state: ${state}`);
    if (state === 'available') {
      return;
    }
    const delay = Math.min(2000 * 1.5 ** attempt, 30000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error(`Upload ${uploadId} did not become available in time`);
}

async function createUpload(api, filename) {
  if (!existsSync(filename)) {
    throw new Error(`Release asset not found: ${filename}`);
  }
  const fileSize = statSync(filename).size;
  const upload = await createMultipartUpload(api, filename, fileSize);
  console.log(`Created multipart upload ${upload.id} for ${path.basename(filename)}`);
  const parts = await uploadParts(filename, upload.part_presigned_urls, upload.part_size_bytes);
  await completeMultipartUpload(upload.complete_presigned_url, parts);
  await finaliseUpload(api, upload.id);
  await pollUploadAvailable(api, upload.id);
  return upload.id;
}

async function updateExistingGroup(api, groupId, body) {
  const response = await api(`/mod-file-update-groups/${encodeURIComponent(groupId)}/versions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return response.data;
}

async function createNewModFile(api, body) {
  const response = await api('/mod-files', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return response.data;
}

async function publishAsset({ api, modId, groups, version, assetDir, asset, allowBootstrap }) {
  const filename = path.join(assetDir, filenameForAsset(version, asset));
  const configuredGroupId = configuredGroupIdForAsset(asset);
  const discoveredGroupId = configuredGroupId || findGroupId(groups, asset);
  const uploadId = await createUpload(api, filename);

  if (discoveredGroupId) {
    console.log(`Updating ${asset.label} Nexus group ${discoveredGroupId}`);
    return updateExistingGroup(api, discoveredGroupId, buildUpdateGroupBody({ uploadId, version, asset }));
  }

  if (!allowBootstrap) {
    throw new Error(`${asset.groupEnv} is not set and no existing "${asset.groupName}" Nexus file group was found`);
  }

  console.log(`Creating first Nexus file group for ${asset.label}`);
  return createNewModFile(api, buildModFileBody({ uploadId, modId, version, asset }));
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const version = requireValue(args.get('version') || process.env.VERSION, 'version');
  const assetDir = path.resolve(args.get('asset-dir') || process.cwd());
  const gameDomain = args.get('game-domain') || process.env.NEXUSMODS_GAME_DOMAIN || DEFAULT_GAME_DOMAIN;
  const gameScopedModId = args.get('mod-id') || process.env.NEXUSMODS_MOD_ID || DEFAULT_GAME_SCOPED_MOD_ID;
  const allowBootstrap = (args.get('allow-bootstrap') || process.env.NEXUS_ALLOW_BOOTSTRAP || 'true') !== 'false';
  const assets = orderedReleaseAssets(args.get('only') || process.env.NEXUS_RELEASE_ASSET_ONLY || '');
  const api = createApiClient(requireValue(process.env.NEXUS_API_KEY, 'NEXUS_API_KEY'), process.env.NEXUSMODS_API_BASE || DEFAULT_API_BASE);
  let modId = '';
  let groups = [];
  if (allAssetsHaveConfiguredGroups(assets)) {
    console.log('Using configured Nexus file group ids; skipping file update group discovery');
  } else {
    modId = await getModUuid(api, gameDomain, gameScopedModId);
    groups = await getUpdateGroups(api, modId);
  }

  for (const asset of assets) {
    console.log(`Publishing ${asset.label} to Nexus`);
    await publishAsset({ api, modId, groups, version, assetDir, asset, allowBootstrap });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
