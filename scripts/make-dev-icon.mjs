// scripts/make-dev-icon.mjs
// Composite a "DEV" badge onto the Windows runtime icons so dev builds are
// visually distinct. Run on the CI runner during the dev stamp step; never
// committed. Pure-JS (jimp + png-to-ico) — no native build, runs on
// windows-latest. Windows-only scope: macOS .icns and Linux PNGs are left
// untouched.
//
// jimp v1 API notes (verified against v1.6.1):
//   - `new Jimp({ width, height, color })` creates a solid-colour image
//   - `Jimp.read(path)` reads an existing PNG
//   - `img.composite(overlay, x, y)` composites in-place
//   - `img.print({ font, x, y, text: { text, alignmentX, alignmentY },
//       maxWidth, maxHeight })` — alignmentX/Y must be the numeric enum
//       values from HorizontalAlign / VerticalAlign (not strings)
//   - `img.write(path)` overwrites the file
//   - `loadFont(SANS_32_WHITE)` from 'jimp/fonts'

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Jimp, loadFont, HorizontalAlign, VerticalAlign } from 'jimp';
import { SANS_32_WHITE, SANS_16_WHITE } from 'jimp/fonts';
import pngToIco from 'png-to-ico';

const WIN_PNGS = ['32x32.png', '128x128.png', '128x128@2x.png'];

/** Composite a red "DEV" ribbon across the bottom third of one image. */
async function badgeOne(path, font32, font16) {
  const img = await Jimp.read(path);
  const w = img.bitmap.width;
  const h = img.bitmap.height;
  const band = Math.max(8, Math.round(h * 0.34));

  // Solid red band across the bottom.
  const red = new Jimp({ width: w, height: band, color: 0xd33232ff });
  img.composite(red, 0, h - band);

  // "DEV" text centered in the band (only legible at >=64px; harmless at 32).
  if (w >= 64) {
    // Use a smaller font for 64–127px, larger for 128+.
    const font = w >= 128 ? font32 : font16;
    img.print({
      font,
      x: 0,
      y: h - band,
      text: {
        text: 'DEV',
        alignmentX: HorizontalAlign.CENTER,
        alignmentY: VerticalAlign.MIDDLE,
      },
      maxWidth: w,
      maxHeight: band,
    });
  }

  await img.write(path);
}

/** Badge the Windows PNGs in `iconDir` and (re)build icon.ico from them. */
export async function badgeIcons(iconDir) {
  // Load fonts once; they're needed for >=64px images.
  const font32 = await loadFont(SANS_32_WHITE);
  const font16 = await loadFont(SANS_16_WHITE);

  const present = [];
  for (const name of WIN_PNGS) {
    const p = join(iconDir, name);
    if (!existsSync(p)) {
      console.warn(`make-dev-icon: ${name} missing, skipping`);
      continue;
    }
    await badgeOne(p, font32, font16);
    present.push(p);
  }

  if (present.length === 0) {
    console.warn('make-dev-icon: no source PNGs found, skipping icon.ico');
    return;
  }

  // Build a multi-resolution .ico from the badged PNGs.
  const ico = await pngToIco(present);
  writeFileSync(join(iconDir, 'icon.ico'), ico);
}

const isMain = fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  badgeIcons(process.argv[2] || 'src-tauri/icons').catch((e) => {
    console.error('make-dev-icon failed:', e);
    process.exit(1);
  });
}
