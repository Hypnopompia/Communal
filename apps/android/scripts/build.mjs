// Bundles node/main.ts into <out>/main.mjs and copies the native packages next to it with only the
// prebuilds for the target, so the folder can be packed into the APK's assets (ADR 0023) and run
// with `node main.mjs`.
//
//   node scripts/build.mjs [--target android-arm64|android-x64|darwin-arm64|...]
//                          [--sqlite path/to/better_sqlite3.node] [--out dist/<abi>]
import { build } from 'esbuild';
import {
  cpSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const target = opt('--target', 'android-arm64');
const sqliteAddon = opt('--sqlite');
const out = join(here, opt('--out', 'dist/node'));

// Native packages stay outside the bundle: their loaders find the .node file relative to themselves.
const native = ['better-sqlite3', 'udx-native', 'sodium-native'];
// Build-time only (C++ headers for addons).
const skip = new Set(['node-addon-api']);
// Only reached on paths a download-only phone never takes (sharing, media, the OS trash, UPnP).
// Left out of the app altogether: a stray import fails loudly instead of loading.
const absent = [
  'sharp',
  '@napi-rs/canvas',
  'pdfjs-dist',
  'pdfjs-dist/*',
  'ffmpeg-static',
  'trash',
  '@achingbrain/nat-port-mapper',
  'music-metadata',
  'exifr',
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await build({
  entryPoints: [join(here, 'node/main.ts')],
  outfile: join(out, 'main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  conditions: ['@communal/source'],
  external: [...native, ...absent],
  // CommonJS dependencies inside an ESM bundle still call require().
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  metafile: true,
  minify: true,
  sourcemap: false,
  logLevel: 'warning',
});

// Copy each native package and its production dependencies, flattened into node_modules.
const copied = new Set();
function copyPkg(name, fromDir) {
  if (copied.has(name) || skip.has(name)) return;
  const req = createRequire(join(fromDir, 'noop.js'));
  let pkgJson;
  try {
    pkgJson = req.resolve(`${name}/package.json`);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND') {
      // A transitive dependency (sodium-native via secret-stream): find it in pnpm's store.
      const store = join(here, '../../node_modules/.pnpm');
      const flat = name.replace('/', '+');
      const hit = readdirSync(store).find((d) => d.startsWith(`${flat}@`));
      if (!hit) throw err;
      return copyPkg(name, join(store, hit, 'node_modules'));
    }
    // Packages whose exports hide package.json: walk up from the entry.
    let d = dirname(req.resolve(name));
    while (!statSync(join(d, 'package.json'), { throwIfNoEntry: false })) d = dirname(d);
    pkgJson = join(d, 'package.json');
  }
  const src = dirname(realpathSync(pkgJson));
  const dst = join(out, 'node_modules', name);
  copied.add(name);
  cpSync(src, dst, {
    recursive: true,
    dereference: true,
    filter: (p) => {
      const rel = p.slice(src.length + 1);
      if (
        /^(test|deps|src|include|docs|build\/Release\/obj|build\/Release\/\.deps)(\/|$)/.test(rel)
      )
        return false;
      if (rel.startsWith('prebuilds/'))
        return rel === 'prebuilds' || rel.startsWith(`prebuilds/${target}`);
      return !rel.startsWith('node_modules');
    },
  });
  const pkg = JSON.parse(readFileSync(pkgJson, 'utf8'));
  for (const dep of Object.keys(pkg.dependencies ?? {})) copyPkg(dep, src);
}
const core = realpathSync(join(here, '../../packages/core'));
for (const n of native) copyPkg(n, core);

// better-sqlite3 ships no Android build: drop in one built with the NDK (see ndk-sqlite.sh).
if (sqliteAddon) {
  const rel = join(out, 'node_modules/better-sqlite3/build/Release');
  rmSync(rel, { recursive: true, force: true });
  mkdirSync(rel, { recursive: true });
  cpSync(sqliteAddon, join(rel, 'better_sqlite3.node'));
}

const size = (d) =>
  readdirSync(d, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? size(join(d, e.name)) : statSync(join(d, e.name)).size),
    0,
  );
const mb = (n) => (n / 1048576).toFixed(2) + ' MB';
console.log(
  `bundle ${mb(statSync(join(out, 'main.mjs')).size)}, native ${mb(size(join(out, 'node_modules')))}`,
);
console.log(`native packages: ${[...copied].join(', ')}`);
const inputs = Object.keys(result.metafile.inputs);
const pkgs = new Set(
  inputs.map((p) => /.*node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(p)?.[1]).filter(Boolean),
);
console.log(`bundled packages (${pkgs.size}): ${[...pkgs].sort().join(', ')}`);
