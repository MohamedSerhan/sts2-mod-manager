#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const game = fs.readFileSync(path.join(root, 'src-tauri/src/game.rs'), 'utf8');
const externalOpen = fs.readFileSync(path.join(root, 'src-tauri/src/external_open.rs'), 'utf8');
const hooks = fs.readFileSync(path.join(root, 'src/hooks/useTauri.ts'), 'utf8');
const logsViewer = fs.readFileSync(path.join(root, 'src/components/LogsViewer.tsx'), 'utf8');
const diagnosticBundle = fs.readFileSync(path.join(root, 'src/components/DiagnosticBundle.tsx'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exitCode = 1;
  }
}

assert(
  !game.includes('that_in_background('),
  'Steam launch must not use open::that_in_background; it drops opener failures on Linux'
);

assert(
  game.includes('launch_game_via_steam'),
  'Steam launch should go through launch_game_via_steam so Linux fallback behavior is centralized'
);

assert(
  !game.includes('open::that(') && !game.includes('open::that_detached('),
  'Game open/launch paths must use external_open so AppImage runtime env is scrubbed before spawning host apps'
);

assert(
  externalOpen.includes('APPIMAGE_REMOVE_ENV') &&
  externalOpen.includes('LD_LIBRARY_PATH') &&
  externalOpen.includes('LD_PRELOAD') &&
  externalOpen.includes('PATH') &&
  externalOpen.includes('XDG_DATA_DIRS'),
  'external_open must scrub AppImage library/path environment before spawning host apps'
);

assert(
  game.includes('open_external_blocking(STEAM_URL)'),
  'Steam launch should wait for the sanitized system opener and return launcher errors'
);

assert(
  game.includes('"steam"') && game.includes('"-applaunch"') && game.includes('"flatpak"'),
  'Linux Steam launch should include direct steam and Flatpak fallbacks when steam:// opener registration is broken'
);

assert(
  hooks.includes("invoke('open_external_url'"),
  'Frontend browser links should route through the sanitized backend external opener command'
);

for (const [label, source] of [
  ['LogsViewer', logsViewer],
  ['DiagnosticBundle', diagnosticBundle],
]) {
  assert(
    source.includes('openExternalUrl('),
    `${label} support links must use the sanitized backend external opener`
  );
  assert(
    !source.includes('window.open(') && !source.includes('@tauri-apps/plugin-opener'),
    `${label} must not call browser/plugin openers directly inside Tauri`
  );
}

if (process.exitCode) process.exit(process.exitCode);
console.log('launch/support opener checks ok');
