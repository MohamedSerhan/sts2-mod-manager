import test from 'node:test';
import assert from 'node:assert/strict';

import {
  allAssetsHaveConfiguredGroups,
  buildModFileBody,
  buildUpdateGroupBody,
  configuredGroupIdForAsset,
  filenameForAsset,
  orderedReleaseAssets,
  uploadDisplayName,
} from './nexus-publish-release.mjs';

test('Nexus release assets publish Windows last so it stays the newest/top file', () => {
  assert.deepEqual(
    orderedReleaseAssets().map((asset) => asset.key),
    ['macos', 'linux', 'windows'],
  );
});

test('--only accepts a known Nexus release asset key', () => {
  assert.deepEqual(
    orderedReleaseAssets('windows').map((asset) => asset.key),
    ['windows'],
  );
});

test('--only rejects unknown Nexus release asset keys', () => {
  assert.throws(
    () => orderedReleaseAssets('steamdeck'),
    /Unknown --only asset "steamdeck"\. Expected one of: macos, linux, windows/,
  );
});

test('--only windows preserves Windows Nexus publish flags', () => {
  const [windows] = orderedReleaseAssets('windows');
  const body = buildUpdateGroupBody({
    uploadId: 'upload-1',
    version: '1.7.11',
    asset: windows,
  });

  assert.equal(filenameForAsset('1.7.11', windows), 'STS2.Mod.Manager_1.7.11_x64_portable.zip');
  assert.equal(body.archive_existing_file, true);
  assert.equal(body.primary_mod_manager_download, true);
  assert.equal(body.allow_mod_manager_download, true);
});

test('configured group lookup reads the selected Nexus asset environment variable', () => {
  const [windows] = orderedReleaseAssets('windows');

  assert.equal(
    configuredGroupIdForAsset(windows, { NEXUS_FILE_GROUP_ID: ' 38293928411992 ' }),
    '38293928411992',
  );
});

test('group discovery can be skipped only when every selected asset has a configured group', () => {
  const env = {
    NEXUS_FILE_GROUP_ID_MACOS: 'macos-group',
    NEXUS_FILE_GROUP_ID_LINUX: 'linux-group',
    NEXUS_FILE_GROUP_ID: 'windows-group',
  };

  assert.equal(allAssetsHaveConfiguredGroups(orderedReleaseAssets('windows'), env), true);
  assert.equal(allAssetsHaveConfiguredGroups(orderedReleaseAssets(), env), true);
  assert.equal(
    allAssetsHaveConfiguredGroups(orderedReleaseAssets(), { ...env, NEXUS_FILE_GROUP_ID_LINUX: '' }),
    false,
  );
});

test('Windows is the primary mod-manager download and other platforms are not', () => {
  const bodies = orderedReleaseAssets().map((asset) => (
    buildUpdateGroupBody({ uploadId: 'upload-1', version: '1.7.4', asset })
  ));

  assert.equal(bodies[0].primary_mod_manager_download, false);
  assert.equal(bodies[1].primary_mod_manager_download, false);
  assert.equal(bodies[2].primary_mod_manager_download, true);
  assert.equal(bodies[2].allow_mod_manager_download, true);
});

test('bootstrap create body uses a stable platform group name', () => {
  const asset = orderedReleaseAssets()[0];
  const body = buildModFileBody({
    uploadId: 'upload-1',
    modId: 'mod-1',
    version: '1.7.4',
    asset,
  });

  assert.equal(body.name, 'STS2 Mod Manager (macOS Universal)');
  assert.equal(body.version, '1.7.4');
  assert.equal(body.file_category, 'main');
});

test('asset filenames and update display names include the release version', () => {
  const windows = orderedReleaseAssets().at(-1);

  assert.equal(filenameForAsset('1.7.4', windows), 'STS2.Mod.Manager_1.7.4_x64_portable.zip');
  assert.equal(uploadDisplayName('1.7.4', windows), 'STS2 Mod Manager 1.7.4 (Windows Portable)');
});
