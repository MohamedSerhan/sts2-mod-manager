#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const game = fs.readFileSync(path.join(root, 'src-tauri/src/game.rs'), 'utf8');
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
  game.includes('open::that(STEAM_URL)'),
  'Steam launch should wait for the system opener and return launcher errors'
);

assert(
  game.includes('"steam"') && game.includes('"-applaunch"') && game.includes('"flatpak"'),
  'Linux Steam launch should include direct steam and Flatpak fallbacks when steam:// opener registration is broken'
);

for (const [label, source] of [
  ['LogsViewer', logsViewer],
  ['DiagnosticBundle', diagnosticBundle],
]) {
  assert(
    source.includes('@tauri-apps/plugin-opener') && source.includes('openUrl('),
    `${label} support links must use the Tauri opener plugin`
  );
  assert(
    !source.includes('window.open('),
    `${label} must not call window.open directly inside Tauri`
  );
}

if (process.exitCode) process.exit(process.exitCode);
console.log('launch/support opener checks ok');
