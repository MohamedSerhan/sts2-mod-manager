import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeDevVersion,
  stampFiles,
  renderDevComment,
} from './dev-build-stamp.mjs';

test('computeDevVersion builds the g-prefixed pre-release string', () => {
  assert.equal(computeDevVersion('1.6.1', '42', 'a1b2c3d'), '1.6.1-dev.pr42.ga1b2c3d');
});

test('computeDevVersion keeps valid SemVer for all-digit shas', () => {
  // A bare numeric pre-release identifier with a leading zero is INVALID
  // SemVer; the g-prefix makes it alphanumeric and therefore valid.
  assert.equal(computeDevVersion('1.6.1', '42', '0123456'), '1.6.1-dev.pr42.g0123456');
});

test('stampFiles rewrites version + identity in conf, version in cargo, nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'devstamp-'));
  try {
    const confPath = join(dir, 'tauri.conf.json');
    const cargoPath = join(dir, 'Cargo.toml');
    writeFileSync(confPath, JSON.stringify({
      productName: 'STS2 Mod Manager',
      version: '1.6.1',
      identifier: 'com.sts2mm.app',
      app: { windows: [{ title: 'STS2 Mod Manager' }] },
      bundle: { targets: 'all' },
    }, null, 2) + '\n', 'utf-8');
    writeFileSync(cargoPath,
      '[package]\nname = "sts2-mod-manager"\nversion = "1.6.1"\nedition = "2021"\n\n' +
      '[dependencies]\nserde = { version = "1.0" }\n', 'utf-8');

    stampFiles('1.6.1-dev.pr42.ga1b2c3d', { confPath, cargoPath });

    const conf = JSON.parse(readFileSync(confPath, 'utf-8'));
    assert.equal(conf.version, '1.6.1-dev.pr42.ga1b2c3d');
    assert.equal(conf.identifier, 'com.sts2mm.app.dev');
    assert.equal(conf.productName, 'STS2 Mod Manager (Dev)');
    // Untouched nested key stays intact
    assert.equal(conf.app.windows[0].title, 'STS2 Mod Manager');
    // Dev builds drop the Windows MSI target (WiX rejects the non-numeric
    // "-dev" pre-release); everything else is preserved.
    assert.deepEqual(conf.bundle.targets, ['nsis', 'app', 'dmg', 'deb', 'rpm', 'appimage'], 'msi dropped from dev targets');

    const cargo = readFileSync(cargoPath, 'utf-8');
    assert.match(cargo, /^version = "1\.6\.1-dev\.pr42\.ga1b2c3d"$/m, 'package version stamped');
    assert.match(cargo, /serde = \{ version = "1\.0" \}/, 'dependency version untouched');
    assert.match(cargo, /name = "sts2-mod-manager"/, 'other package keys intact');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('renderDevComment includes marker, metadata, every asset, isolation note', () => {
  const out = renderDevComment({
    pr: '42',
    version: '1.6.1-dev.pr42.ga1b2c3d',
    sha: 'a1b2c3d',
    runUrl: 'https://github.com/x/y/actions/runs/123',
    assets: [
      { platform: 'Windows (portable)', name: 'STS2.Mod.Manager_dev_portable.zip', url: 'https://e/p.zip' },
      { platform: 'macOS', name: 'app.dmg', url: 'https://e/a.dmg' },
    ],
  });
  assert.match(out, /<!-- dev-build-comment -->/);
  assert.match(out, /1\.6\.1-dev\.pr42\.ga1b2c3d/);
  assert.match(out, /a1b2c3d/);
  assert.match(out, /actions\/runs\/123/);
  assert.match(out, /STS2\.Mod\.Manager_dev_portable\.zip/);
  assert.match(out, /app\.dmg/);
  assert.match(out, /\[STS2\.Mod\.Manager_dev_portable\.zip\]\(https:\/\/e\/p\.zip\)/);
  assert.match(out, /sts2-mod-manager-dev/);
  assert.match(out, /portable/i);
});

test('renderDevComment with no assets shows a no-artifacts line', () => {
  const out = renderDevComment({ pr: '7', version: 'x', sha: 'y', runUrl: 'z', assets: [] });
  assert.match(out, /<!-- dev-build-comment -->/);
  assert.match(out, /no build artifacts/i);
});

test('renderDevComment with null assets shows a no-artifacts line', () => {
  const out = renderDevComment({ pr: '7', version: 'x', sha: 'y', runUrl: 'z', assets: null });
  assert.match(out, /<!-- dev-build-comment -->/);
  assert.match(out, /no build artifacts/i);
});
