// Packages the desktop app (HANDOFF §12 M9, ADR 0016):
//
//   pnpm --filter @communal/desktop package                 # this OS and CPU → release/<arch>/
//   pnpm --filter @communal/desktop package -- --arch x64   # another CPU (macOS: x64 on Apple Silicon)
//   pnpm --filter @communal/desktop package -- --dir        # unpacked app only (quick check)
//
// 1. Builds the workspace packages and the app (main, preload, renderer).
// 2. Makes a flat production copy with `pnpm deploy` for the target CPU (hoisted node_modules,
//    no symlinks, the native prebuilds for that CPU), which electron-builder copies into the app.
// 3. Runs electron-builder on that copy, then smoke-tests the unpacked app (x64 on Apple
//    Silicon runs under Rosetta).
//
// Releases use scripts/release.mjs, which runs this for each Mac CPU and uploads the results.
// Signing: a Developer ID identity in the keychain (macOS) is picked up automatically
// (CSC_IDENTITY_AUTO_DISCOVERY=false turns that off). Notarizing happens when APPLE_API_KEY,
// APPLE_API_KEY_ID and APPLE_API_ISSUER are set.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch as hostArch, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const here = dirname(new URL(import.meta.url).pathname);
const app = join(here, '..');
const root = join(app, '../..');
const argv = process.argv.slice(2).filter((a) => a !== '--');
const archAt = argv.indexOf('--arch');
const arch = archAt >= 0 ? argv[archAt + 1] : hostArch();
if (!['x64', 'arm64'].includes(arch)) throw new Error(`unsupported --arch ${arch}`);
const builderArgs = argv.filter((_, i) => i !== archAt && i !== archAt + 1);
// Outside the repo: inside it, electron-builder's `pnpm list` would see the workspace and copy
// packages from there (including other CPUs' builds) instead of from this copy.
const stage = join(tmpdir(), `communal-desktop-stage-${arch}`);
const out = join(app, 'release', arch);
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
  `--cpu=${arch}`,
  stage,
]);
// pnpm reuses the ffmpeg binary it built for this machine; fetch the one for the target CPU
// (its installer skips the download while a binary is there).
if (arch !== hostArch()) {
  rmSync(join(stage, 'node_modules/ffmpeg-static/ffmpeg'), { force: true });
  run('node', ['install.js'], join(stage, 'node_modules/ffmpeg-static'), {
    npm_config_arch: arch,
  });
}
// `--cpu` installs the target CPU's platform packages next to this machine's: drop the others.
if (process.platform === 'darwin') {
  const other = `darwin-${arch === 'x64' ? 'arm64' : 'x64'}`;
  const nm = join(stage, 'node_modules');
  for (const d of readdirSync(nm)) {
    const pkgs = d.startsWith('@') ? readdirSync(join(nm, d)).map((p) => `${d}/${p}`) : [d];
    for (const p of pkgs)
      if (p.endsWith(other) || p.includes(`${other}-`))
        rmSync(join(nm, p), { recursive: true, force: true });
  }
}
// The copy must not look like a workspace, or electron-builder asks pnpm about it.
for (const f of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) rmSync(join(stage, f), { force: true });
cpSync(join(app, 'build'), join(stage, 'build'), { recursive: true });
cpSync(join(app, 'scripts/unique-uuid.mjs'), join(stage, 'scripts/unique-uuid.mjs'));

const electronVersion = JSON.parse(
  readFileSync(createRequire(join(app, 'package.json')).resolve('electron/package.json'), 'utf8'),
).version;
const config = [`-c.electronVersion=${electronVersion}`, `-c.directories.output=${out}`];
const notarize = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'].every(
  (k) => process.env[k],
);
if (process.platform === 'darwin') config.push(`-c.mac.notarize=${notarize}`);
const builder = join(
  app,
  'node_modules/.bin',
  process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
);
rmSync(out, { recursive: true, force: true });
run(
  builder,
  [
    '--projectDir',
    stage,
    '--config',
    join(app, 'electron-builder.yml'),
    `--${arch}`,
    '--publish',
    'never',
    ...config,
    ...builderArgs,
  ],
  stage,
);

// On Apple Silicon, Rosetta runs arm64 helpers from an x64 app, so the smoke test alone can't
// catch a binary built for the wrong CPU: check every executable and native module directly.
if (process.platform === 'darwin') {
  const want = arch === 'x64' ? 'x86_64' : 'arm64';
  const appDir = join(out, readdirSync(out).find((d) => /^mac/.test(d)) ?? '', 'Communal.app');
  const found = execFileSync(
    'find',
    [
      appDir,
      '-type',
      'f',
      '(',
      '-name',
      '*.node',
      '-o',
      '-name',
      'ffmpeg',
      '-o',
      '-name',
      '*.dylib',
      ')',
    ],
    { encoding: 'utf8' },
  ).split('\n');
  // Prebuild folders for other platforms ship alongside and are never loaded here.
  const files = found.filter(
    (f) => f && (!f.includes('/prebuilds/') || f.includes(`/prebuilds/darwin-${arch}/`)),
  );
  const wrong = files.filter((f) => {
    if (!execFileSync('file', ['-b', f], { encoding: 'utf8' }).includes('Mach-O')) return false;
    return !execFileSync('lipo', ['-archs', f], { encoding: 'utf8' })
      .trim()
      .split(' ')
      .includes(want);
  });
  if (wrong.length) throw new Error(`built for the wrong CPU (want ${want}):\n${wrong.join('\n')}`);
  console.log(`package: ${files.length} native files checked for ${want}`);
}

// Smoke-test the unpacked app: the core starts and every native piece works (main/index.ts).
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
// Chromium refuses to run as root with its sandbox (containers, some CI); only then turn it off.
const asRoot = process.platform === 'linux' && process.getuid?.() === 0;
const smokeEnv = { COMMUNAL_SMOKE: '1', COMMUNAL_UPNP: 'false', COMMUNAL_USER_DATA: smokeData };
if (process.platform === 'darwin' && arch !== hostArch())
  run('arch', [`-${arch === 'x64' ? 'x86_64' : 'arm64'}`, bin], out, smokeEnv);
else run(bin, asRoot ? ['--no-sandbox'] : [], out, smokeEnv);
rmSync(smokeData, { recursive: true, force: true });
console.log(`package: built and smoke-tested (${process.platform}-${arch}, ${out})`);
