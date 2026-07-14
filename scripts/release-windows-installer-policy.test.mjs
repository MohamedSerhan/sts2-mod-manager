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
  assert.equal(conf.bundle.windows.nsis.installerHooks, 'nsis-hooks.nsh');
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

test('Windows app updates pin NSIS to the currently running install directory', () => {
  const rust = read('src-tauri/src/app_update.rs');
  assert.match(rust, /std::env::current_exe\(\)/);
  assert.match(rust, /OsString::from\("\/D="\)/);
  assert.match(rust, /builder\.installer_arg\(arg\)/);
  assert.match(read('src-tauri/src/lib.rs'), /app_update::install_app_update/);
  assert.match(read('src-tauri/src/dev_builds.rs'), /pin_current_nsis_install_dir\(app\.updater_builder\(\)\)/);
  assert.match(read('src/hooks/useTauri.ts'), /invoke\('install_app_update'\)/);
});

test('Windows setup EXE corrects stale install metadata only when no install dir is pinned', () => {
  const hooks = read('src-tauri/nsis-hooks.nsh');
  assert.match(hooks, /NSIS_HOOK_PREINSTALL/);
  assert.match(hooks, /GetOptions\}\s+\$CMDLINE\s+"\/D="/);
  assert.match(hooks, /\$UpdateMode\s*==\s*1/);
  assert.match(hooks, /\$\{AndIf\}\s+\$\{Errors\}/);
  assert.match(hooks, /\$LOCALAPPDATA\\\$\{PRODUCTNAME\}/);
  assert.match(hooks, /StrCpy\s+\$INSTDIR\s+"\$LOCALAPPDATA\\\$\{PRODUCTNAME\}"/);
  assert.match(hooks, /SetOutPath\s+"\$INSTDIR"/);
});

test('Windows setup EXE offers an opt-in app-data cleanup on uninstall', () => {
  const hooks = read('src-tauri/nsis-hooks.nsh');
  assert.match(hooks, /NSIS_HOOK_PREUNINSTALL/);
  assert.match(hooks, /Remove STS2 Mod Manager saved modpacks, settings, backups, logs, and cached downloads/);
  assert.match(hooks, /MB_YESNO\|MB_ICONQUESTION/);
  assert.match(hooks, /\$UpdateMode\s*<>\s*1/);
  assert.match(hooks, /\/SD\s+IDNO/);
  assert.match(hooks, /RMDir\s+\/r\s+"\$APPDATA\\sts2-mod-manager"/);
  assert.match(hooks, /RMDir\s+\/r\s+"\$LOCALAPPDATA\\sts2-mod-manager"/);
  const guardStart = hooks.indexOf('${If} $UpdateMode <> 1');
  const guardEnd = hooks.indexOf('${EndIf}', guardStart);
  assert.ok(guardStart >= 0 && guardEnd > guardStart, 'cleanup must be enclosed by the update-mode guard');
  const guardedCleanup = hooks.slice(guardStart, guardEnd);
  assert.match(guardedCleanup, /MB_YESNO\|MB_ICONQUESTION/);
  assert.match(guardedCleanup, /RMDir\s+\/r\s+"\$APPDATA\\sts2-mod-manager"/);
  assert.match(guardedCleanup, /RMDir\s+\/r\s+"\$LOCALAPPDATA\\sts2-mod-manager"/);
  const removalLines = hooks.split('\n').filter((line) => /RMDir\s+\/r/.test(line)).join('\n');
  assert.doesNotMatch(removalLines, /sts2-mod-manager-dev/);
  assert.doesNotMatch(removalLines, /SlayTheSpire2|mods_disabled|steamapps|workshop/i);
});

test('user-facing update install buttons do not bypass the pinned backend installer', () => {
  const app = read('src/App.tsx');
  assert.match(app, /installAppUpdate\(\)/, 'App banner install button must use installAppUpdate()');
  assert.doesNotMatch(app, /\.downloadAndInstall\(/, 'App must not install via JS updater resource');

  for (const file of ['src/components/AboutCard.tsx', 'src/views/Settings.tsx']) {
    const source = read(file);
    assert.match(source, /onCheckForAppUpdate/, `${file} must delegate manual checks to the app shell`);
    assert.doesNotMatch(source, /installAppUpdate\(\)/, `${file} manual checks must not install`);
    assert.doesNotMatch(source, /\.downloadAndInstall\(/, `${file} must not install via JS updater resource`);
  }
});
