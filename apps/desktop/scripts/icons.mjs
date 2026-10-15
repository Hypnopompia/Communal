// Renders every app icon from the mark: three overlapping hexagons, a Venn diagram of three
// people's shelves with the part all three share in the middle. Run after changing the mark:
// `node scripts/icons.mjs`. Outputs are committed:
//
// - build/icon.icon: the Icon Composer document for macOS (light, dark, clear and tinted looks).
//   electron-builder compiles it with Xcode 26's actool into Assets.car plus an .icns for older
//   macOS, so packaging a Mac app needs Xcode 26.
// - build/icon.png, resources/icon.png: the plain tile for Windows, and the window icon.
// - build/icons/<n>x<n>.png: the tile at the hicolor theme's sizes for Linux, which looks icons up
//   only at the sizes its theme lists (up to 512), so a lone 1024 one shows as a generic icon.
// - resources/trayTemplate*.png: the macOS menu bar template.
// - The Android adaptive icon layers (foreground, background, monochrome for themed icons)
//   and the notification icon.
// - site/icon.png, and build/mark.svg: the inline mark the renderer and the site pages copy.
import { createRequire } from 'node:module';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../..');
const sharp = createRequire(join(root, 'packages/core/package.json'))('sharp');

// --- The mark, in a 100 × 100 box --------------------------------------------------------------

const COLOURS = {
  hex: ['#4d7cff', '#1fb383', '#f4b23c'], // blue, green, amber
  // Each overlap: the two hexagons and its colour.
  pair: [
    [0, 1, '#2aa6c8'],
    [1, 2, '#a8c740'],
    [0, 2, '#ee7d6a'],
  ],
  core: '#ffffff',
};
const NAVY = ['#1f2a4d', '#0e1430']; // the tile, top to bottom

const at = (cx, cy, r, deg) => [
  cx + r * Math.cos((deg * Math.PI) / 180),
  cy + r * Math.sin((deg * Math.PI) / 180),
];

// A pointy-top hexagon with rounded corners, flattened to a polygon so the overlaps can be cut
// exactly (Android vectors have no clip paths, and exact regions keep every output the same).
function roundedHex(cx, cy, r, corner) {
  const pts = Array.from({ length: 6 }, (_, i) => at(cx, cy, r, -90 + i * 60));
  const out = [];
  for (let i = 0; i < 6; i++) {
    const p = pts[i];
    const [a, b] = [pts[(i + 5) % 6], pts[(i + 1) % 6]];
    const toward = (q) => {
      const l = Math.hypot(q[0] - p[0], q[1] - p[1]);
      return [p[0] + ((q[0] - p[0]) / l) * corner, p[1] + ((q[1] - p[1]) / l) * corner];
    };
    const [s, e] = [toward(a), toward(b)];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const u = 1 - t;
      out.push([
        u * u * s[0] + 2 * u * t * p[0] + t * t * e[0],
        u * u * s[1] + 2 * u * t * p[1] + t * t * e[1],
      ]);
    }
  }
  return out;
}

// Sutherland–Hodgman: `subject` clipped to the convex polygon `clip` (both clockwise on screen).
function intersect(subject, clip) {
  let out = subject;
  for (let i = 0; i < clip.length; i++) {
    const [a, b] = [clip[i], clip[(i + 1) % clip.length]];
    const inside = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0;
    const cross = (p, q) => {
      const [dx, dy] = [q[0] - p[0], q[1] - p[1]];
      const t =
        ((a[0] - p[0]) * (b[1] - a[1]) - (a[1] - p[1]) * (b[0] - a[0])) /
        (dx * (b[1] - a[1]) - dy * (b[0] - a[0]));
      return [p[0] + t * dx, p[1] + t * dy];
    };
    const input = out;
    out = [];
    for (let j = 0; j < input.length; j++) {
      const [p, q] = [input[j], input[(j + 1) % input.length]];
      if (inside(q)) {
        if (!inside(p)) out.push(cross(p, q));
        out.push(q);
      } else if (inside(p)) out.push(cross(p, q));
    }
  }
  return out;
}

// Two hexagons on top, one below, like the old discs; then moved so the whole mark is centred.
let hexes = [210, 330, 90].map((deg) => roundedHex(...at(50, 50, 13.5, deg), 26, 3.5));
{
  const ys = hexes.flat().map((p) => p[1]);
  const dy = 50 - (Math.min(...ys) + Math.max(...ys)) / 2;
  hexes = hexes.map((h) => h.map(([x, y]) => [x, y + dy]));
}
const pairs = COLOURS.pair.map(([i, j]) => intersect(hexes[i], hexes[j]));
const core = intersect(pairs[0], hexes[2]);

// Every region in paint order, each with its colour.
const regions = [
  ...hexes.map((poly, i) => ({ poly, fill: COLOURS.hex[i] })),
  ...pairs.map((poly, i) => ({ poly, fill: COLOURS.pair[i][2] })),
  { poly: core, fill: COLOURS.core, core: true },
];

const n = (v, digits = 2) => +v.toFixed(digits);
/**
 * Path data for polygons, mapped from the 100-box by scale `s` and offset (ox, oy), with points
 * that round to the same place dropped.
 */
const pathData = (polys, s = 1, ox = 0, oy = 0, digits = 2) =>
  polys
    .map((poly) => {
      const pts = poly
        .map(([x, y]) => `${n(ox + x * s, digits)} ${n(oy + y * s, digits)}`)
        .filter((p, i, all) => p !== all[(i + all.length - 1) % all.length]);
      return `M${pts.join('L')}Z`;
    })
    .join('');

/** The mark as SVG elements in the 100-box. */
const markSvg = () =>
  regions.map((r) => `<path d="${pathData([r.poly])}" fill="${r.fill}"/>`).join('');

// --- Desktop: tile, tray, Icon Composer -----------------------------------------------------

// The plain tile on Apple's 1024 grid (824 square, 185 corner): navy so it sits with dark docks.
const tile = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${NAVY[0]}"/><stop offset="1" stop-color="${NAVY[1]}"/></linearGradient></defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)"/>
  <g transform="translate(512 512) scale(7.4) translate(-50 -50)">${markSvg()}</g>
</svg>`;

// macOS tray: a template image (black + alpha) that the menu bar tints: the three outlines and a
// solid core.
const tray = (
  size,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
  <g transform="translate(50 50) scale(1.12) translate(-50 -50)">
    <path d="${pathData(hexes)}" fill="none" stroke="#000" stroke-width="6.5" stroke-linejoin="round"/>
    <path d="${pathData([core])}" fill="#000"/>
  </g>
</svg>`;

const desktop = join(here, '..');
mkdirSync(join(desktop, 'build'), { recursive: true });
mkdirSync(join(desktop, 'resources'), { recursive: true });
const png = (svg, px) => sharp(Buffer.from(svg)).resize(px, px).png();
await png(tile, 1024).toFile(join(desktop, 'build/icon.png'));
await png(tile, 256).toFile(join(desktop, 'resources/icon.png'));
rmSync(join(desktop, 'build/icons'), { recursive: true, force: true });
mkdirSync(join(desktop, 'build/icons'));
for (const px of [16, 24, 32, 48, 64, 128, 256, 512])
  await png(tile, px).toFile(join(desktop, `build/icons/${px}x${px}.png`));
await png(tile, 256).toFile(join(root, 'site/icon.png'));
await png(tray(16), 16).toFile(join(desktop, 'resources/trayTemplate.png'));
await png(tray(32), 32).toFile(join(desktop, 'resources/trayTemplate@2x.png'));

// Icon Composer document. Each part of the Venn is its own layer on the same 1024 canvas, so
// macOS can give the hexagons glass and pick their luminance for the clear and tinted looks.
// The fill is light in the light look and navy in the dark one. Here the whole 1024 canvas is the
// tile (macOS adds the margin), so the mark is drawn larger than on the plain tile.
{
  const doc = join(desktop, 'build/icon.icon');
  rmSync(doc, { recursive: true, force: true });
  mkdirSync(join(doc, 'Assets'), { recursive: true });
  const layer = (name, body) => {
    writeFileSync(
      join(doc, 'Assets', `${name}.svg`),
      `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024"><g transform="translate(512 512) scale(9) translate(-50 -50)">${body}</g></svg>\n`,
    );
    return name;
  };
  const p3 = (hex) =>
    `srgb:${[1, 3, 5].map((i) => (parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5)).join(',')},1.00000`;
  const layers = [
    // Icon Composer lists layers top first.
    { name: layer('core', `<path d="${pathData([core])}" fill="${COLOURS.core}"/>`), glass: false },
    {
      name: layer(
        'overlaps',
        pairs
          .map(
            (poly, i) =>
              `<path fill-rule="evenodd" d="${pathData([poly, core])}" fill="${COLOURS.pair[i][2]}"/>`,
          )
          .join(''),
      ),
      glass: false,
    },
    ...[2, 1, 0].map((i) => ({
      name: layer(`hex-${i + 1}`, `<path d="${pathData([hexes[i]])}" fill="${COLOURS.hex[i]}"/>`),
      glass: true,
    })),
  ];
  const icon = {
    'fill-specializations': [
      { value: { 'linear-gradient': [p3('#ffffff'), p3('#e3e9f2')] } },
      { appearance: 'dark', value: { 'linear-gradient': [p3(NAVY[0]), p3(NAVY[1])] } },
    ],
    groups: [
      {
        layers: layers.map(({ name, glass }) => ({
          glass,
          'image-name': `${name}.svg`,
          name,
        })),
        shadow: { kind: 'neutral', opacity: 0.5 },
        specular: true,
        translucency: { enabled: false, value: 0.5 },
      },
    ],
    'supported-platforms': { squares: ['macOS'] },
  };
  writeFileSync(join(doc, 'icon.json'), JSON.stringify(icon, null, 2) + '\n');
}

// --- Android adaptive icon (108 dp layers, the launcher shows the middle 72 and the mask can cut
// into everything outside a 66 dp circle) --------------------------------------------------------

{
  const res = join(root, 'apps/android/app/src/main/res');
  mkdirSync(join(res, 'drawable'), { recursive: true });
  mkdirSync(join(res, 'mipmap-anydpi-v26'), { recursive: true });
  // Fit the mark inside a 31 dp radius around the centre, inside the 33 dp safe circle.
  const reach = Math.max(...hexes.flat().map(([x, y]) => Math.hypot(x - 50, y - 50)));
  const s = 31 / reach;
  const o = 54 - 50 * s;
  const head = (comment) => `<?xml version="1.0" encoding="utf-8"?>
<!-- ${comment} Made by apps/desktop/scripts/icons.mjs. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
`;
  const argb = (hex) => `#FF${hex.slice(1).toUpperCase()}`;
  writeFileSync(
    join(res, 'drawable/ic_launcher_foreground.xml'),
    head('The mark: three overlapping hexagons.') +
      regions
        .map(
          (r) =>
            `    <path android:fillColor="${argb(r.fill)}"\n        android:pathData="${pathData([r.poly], s, o, o)}" />\n`,
        )
        .join('') +
      '</vector>\n',
  );
  writeFileSync(
    join(res, 'drawable/ic_launcher_background.xml'),
    head('The navy tile behind the mark.') +
      `    <path android:pathData="M0,0h108v108h-108z">
        <aapt:attr name="android:fillColor">
            <gradient android:type="linear"
                android:startX="54" android:startY="0"
                android:endX="54" android:endY="108"
                android:startColor="${argb(NAVY[0])}"
                android:endColor="${argb(NAVY[1])}" />
        </aapt:attr>
    </path>
</vector>\n`,
  );
  // Themed icons (Android 13+) tint this one-colour version: the outlines and a solid core.
  writeFileSync(
    join(res, 'drawable/ic_launcher_monochrome.xml'),
    head('One-colour mark for themed icons.') +
      `    <path android:strokeColor="#FF000000"
        android:strokeWidth="${n(7 * s)}"
        android:strokeLineJoin="round"
        android:pathData="${pathData(hexes, s, o, o)}" />
    <path android:fillColor="#FF000000"
        android:pathData="${pathData([core], s, o, o)}" />
</vector>\n`,
  );
  // The status bar's notification icon: the same outline form, white, filling a 24 dp box.
  {
    const span = Math.max(
      ...hexes.flat().map(([x, y]) => Math.max(Math.abs(x - 50), Math.abs(y - 50))),
    );
    const k = 10.5 / span;
    const c = 12 - 50 * k;
    writeFileSync(
      join(res, 'drawable/ic_stat_communal.xml'),
      `<?xml version="1.0" encoding="utf-8"?>
<!-- Notification icon. Made by apps/desktop/scripts/icons.mjs. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="24dp"
    android:height="24dp"
    android:viewportWidth="24"
    android:viewportHeight="24">
    <path android:strokeColor="#FFFFFFFF"
        android:strokeWidth="${n(7.5 * k)}"
        android:strokeLineJoin="round"
        android:pathData="${pathData(hexes, k, c, c)}" />
    <path android:fillColor="#FFFFFFFF"
        android:pathData="${pathData([core], k, c, c)}" />
</vector>\n`,
    );
  }
  writeFileSync(
    join(res, 'mipmap-anydpi-v26/ic_launcher.xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<!-- Made by apps/desktop/scripts/icons.mjs. -->
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@drawable/ic_launcher_foreground" />
    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />
</adaptive-icon>\n`,
  );
}

// --- The inline mark (renderer `Mark`, site headers): 24 box, core left see-through so it
// reads on light and dark pages alike --------------------------------------------------------

const span = Math.max(
  ...[0, 1].map(
    (k) => Math.max(...hexes.flat().map((p) => p[k])) - Math.min(...hexes.flat().map((p) => p[k])),
  ),
);
const si = 22.4 / span;
const inline = regions
  .filter((r) => !r.core)
  .map(
    (r) =>
      `<path fill-rule="evenodd" fill="${r.fill}" d="${pathData([r.poly, core], si, 12 - 50 * si, 12 - 50 * si, 1)}"/>`,
  )
  .join('\n');
writeFileSync(
  join(desktop, 'build/mark.svg'),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">\n${inline}\n</svg>\n`,
);
console.log('icons written; inline mark in build/mark.svg');
