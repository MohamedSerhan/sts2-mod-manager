import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildModFileBody,
  buildUpdateGroupBody,
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
