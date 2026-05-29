import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { badgeIcons } from './make-dev-icon.mjs';

async function writePng(path, size) {
  const img = new Jimp({ width: size, height: size, color: 0x3366ffff });
  await img.write(path);
}

test('badgeIcons rewrites the windows PNGs and (re)builds icon.ico', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devicon-'));
  try {
    await writePng(join(dir, '32x32.png'), 32);
    await writePng(join(dir, '128x128.png'), 128);
    await writePng(join(dir, '128x128@2x.png'), 256);
    const before = statSync(join(dir, '128x128.png')).size;

    await badgeIcons(dir);

    // icon.ico produced; PNGs still present and changed (badge composited).
    assert.ok(existsSync(join(dir, 'icon.ico')), 'icon.ico written');
    assert.ok(statSync(join(dir, 'icon.ico')).size > 0, 'icon.ico non-empty');
    assert.notEqual(statSync(join(dir, '128x128.png')).size, before, '128 png changed by badge');

    // Idempotent: a second run does not throw.
    await badgeIcons(dir);
    assert.ok(existsSync(join(dir, 'icon.ico')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('badgeIcons skips a missing source png without throwing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'devicon-'));
  try {
    await writePng(join(dir, '32x32.png'), 32); // only one present
    await badgeIcons(dir); // must not throw
    assert.ok(existsSync(join(dir, 'icon.ico')), 'ico built from whatever pngs exist');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
