import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

function read(path) {
  return readFileSync(path, 'utf8');
}

test('release config builds NSIS/current-user Windows installers and not MSI', () => {
  const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
  assert.deepEqual(conf.bundle.targets, ['nsis', 'app', 'dmg', 'deb', 'rpm', 'appimage']);
  assert.equal(conf.bundle.windows.nsis.installMode, 'currentUser');
});

test('updater manifest refuses MSI fallback for Windows releases', () => {
  const script = read('scripts/publish-updater.sh');
  assert.match(script, /Windows releases must include the NSIS setup\.exe asset/);
  assert.match(script, /add_platform "windows-x86_64"\s+"\$NSIS"/);
  assert.match(script, /add_platform "windows-x86_64-nsis"\s+"\$NSIS"/);
  assert.doesNotMatch(script, /windows-x86_64-msi/);
  assert.doesNotMatch(script, /add_platform "windows-x86_64"\s+"\$MSI"/);
});

test('release workflow does not publish or recommend MSI as a Windows path', () => {
  const workflow = read('.github/workflows/build.yml');
  assert.match(workflow, /STS2\.Mod\.Manager_\$\{VERSION\}_x64-setup\.exe/);
  assert.match(workflow, /STS2\.Mod\.Manager_\$\{VERSION\}_x64_portable\.zip/);
  assert.doesNotMatch(workflow, /\.msi\b/i);
  assert.doesNotMatch(workflow, /Alternative MSI installer/i);
});
