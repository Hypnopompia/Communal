// Packages the desktop app for the platform it runs on (HANDOFF §12 M9, ADR 0016):
//
//   pnpm --filter @communal/desktop package          # installers in release/
//   pnpm --filter @communal/desktop package -- --dir # unpacked app only (quick check)
//
// 1. Builds the workspace packages and the app (main, preload, renderer).
// 2. Makes a flat production copy with `pnpm deploy` (hoisted node_modules, no symlinks), which
//    is what electron-builder expects to copy into the app.
// 3. Runs electron-builder on that copy, then smoke-tests the unpacked app.
//
// Update feed: set COMMUNAL_UPDATE_URL (a generic HTTPS folder holding latest*.yml) to build
// an app that checks for updates. Signing: see electron-builder.yml and scripts/notarize.mjs.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const here = dirname(new URL(import.meta.url).pathname);
const app = join(here, '..');
const root = join(app, '../..');
const stage = join(app, 'release/stage');
const args = process.argv.slice(2).filter((a) => a !== '--');
const run = (cmd, a, cwd = root, env = {}) =>
  execFileSync(cmd, a, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });

run('pnpm', ['--filter', '@communal/desktop...', 'run', 'build']);

rmSync(stage, { recursive: true, force: true });
run('pnpm', [
  '--filter',
  '@communal/desktop',
  'deploy',
  '--prod',
  '--config.node-linker=hoisted',
  stage,
]);
// The copy must not look like a workspace, or electron-builder asks pnpm about it.
for (const f of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) rmSync(join(stage, f), { force: true });
cpSync(join(app, 'build'), join(stage, 'build'), { recursive: true });
cpSync(join(app, 'scripts/notarize.mjs'), join(stage, 'scripts/notarize.mjs'));

const electronVersion = JSON.parse(
  readFileSync(createRequire(join(app, 'package.json')).resolve('electron/package.json'), 'utf8'),
).version;
const config = [
  `-c.electronVersion=${electronVersion}`,
  `-c.directories.output=${join(app, 'release')}`,
];
if (process.env.COMMUNAL_UPDATE_URL)
  config.push('-c.publish.provider=generic', `-c.publish.url=${process.env.COMMUNAL_UPDATE_URL}`);
const builder = join(
  app,
  'node_modules/.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);
run(
  builder,
  [
    '--projectDir',
    stage,
    '--config',
    join(app, 'electron-builder.yml'),
    '--publish',
    'never',
    ...config,
    ...args,
  ],
  stage,
);

// Smoke-test the unpacked app: the core starts and every native piece works (main/index.ts).
const out = join(app, 'release');
const unpacked = readdirSync(out).find((d) => /-unpacked$|^mac/.test(d));
if (!unpacked) throw new Error('no unpacked app to smoke-test');
const bin =
  process.platform === 'darwin'
    ? join(out, unpacked, 'Communal.app/Contents/MacOS/Communal')
    : process.platform === 'win32'
      ? join(out, unpacked, 'Communal.exe')
      : join(out, unpacked, 'communal');
if (!existsSync(bin)) throw new Error(`no app binary at ${bin}`);
const smokeData = join(out, 'smoke-data');
rmSync(smokeData, { recursive: true, force: true });
const asRoot = process.platform === 'linux' && process.getuid?.() === 0;
run(bin, asRoot ? ['--no-sandbox'] : [], out, {
  COMMUNAL_SMOKE: '1',
  COMMUNAL_UPNP: 'false',
  COMMUNAL_USER_DATA: smokeData,
});
rmSync(smokeData, { recursive: true, force: true });
console.log('package: built and smoke-tested');
