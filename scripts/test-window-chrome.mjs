#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const app = fs.readFileSync(path.join(root, 'src/App.tsx'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'src/styles.css'), 'utf8');
const capabilities = JSON.parse(
  fs.readFileSync(path.join(root, 'src-tauri/capabilities/default.json'), 'utf8')
);

function assert(condition, message) {
  if (!condition) {
    console.error(message);
    process.exitCode = 1;
  }
}

assert(
  app.includes('data-tauri-drag-region'),
  'custom titlebar must mark its draggable region with data-tauri-drag-region'
);

assert(
  app.includes('startResizeDragging'),
  'undecorated window must expose explicit resize handles wired to startResizeDragging'
);

for (const direction of [
  'North',
  'NorthEast',
  'East',
  'SouthEast',
  'South',
  'SouthWest',
  'West',
  'NorthWest',
]) {
  assert(app.includes(`'${direction}'`), `missing resize direction: ${direction}`);
}

assert(
  styles.includes('.gf-resize-handle'),
  'resize handles must have CSS hit targets'
);

assert(
  capabilities.permissions.includes('core:window:allow-start-resize-dragging'),
  'capabilities must allow start_resize_dragging'
);

if (process.exitCode) process.exit(process.exitCode);
console.log('window chrome checks ok');
