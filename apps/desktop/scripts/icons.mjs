// Renders the app and tray icons from the mark (three overlapping discs). Run after changing
// the mark: `node scripts/icons.mjs`. Outputs are committed.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sharp = createRequire(join(here, '../../../packages/core/package.json'))('sharp');

const discs = (fill) => `
  <circle cx="8" cy="9" r="6" fill="${fill[0]}"/>
  <circle cx="16" cy="9" r="6" fill="${fill[1]}" fill-opacity="${fill[3]}"/>
  <circle cx="12" cy="16" r="6" fill="${fill[2]}" fill-opacity="${fill[3]}"/>`;

// App icon: the mark on a rounded tile, with the usual platform margin.
const app = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect x="100" y="100" width="824" height="824" rx="190" fill="#f3f6f5"/>
  <g transform="translate(212 200) scale(25)">${discs(['#2f5bea', '#18936a', '#e0a43a', 0.85])}</g>
</svg>`;

// macOS tray: a template image (black + alpha), so the menu bar tints it.
const tray = (
  size,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
  <g fill="none" stroke="#000" stroke-width="1.8">
    <circle cx="8" cy="9" r="5.2"/><circle cx="16" cy="9" r="5.2"/><circle cx="12" cy="16" r="5.2"/>
  </g>
</svg>`;

mkdirSync(join(here, '../build'), { recursive: true });
mkdirSync(join(here, '../resources'), { recursive: true });
await sharp(Buffer.from(app)).png().toFile(join(here, '../build/icon.png'));
await sharp(Buffer.from(app)).resize(256, 256).png().toFile(join(here, '../resources/icon.png'));
await sharp(Buffer.from(tray(16)))
  .png()
  .toFile(join(here, '../resources/trayTemplate.png'));
await sharp(Buffer.from(tray(32)))
  .png()
  .toFile(join(here, '../resources/trayTemplate@2x.png'));
console.log('icons written');
