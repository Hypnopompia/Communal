// Packages the hub as a tarball (HANDOFF §12 M9):
//   pnpm --filter @communal/hub package
// → apps/hub/release/communal-hub-<version>.tar.gz with the hub and its production
// dependencies, a `bin/communal-hub` launcher, the systemd unit and install.sh. better-sqlite3
// ships prebuilds for every platform, so a tarball built on any OS runs on Linux.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const here = dirname(new URL(import.meta.url).pathname);
const hub = join(here, '..');
const root = join(hub, '../..');
const { version } = JSON.parse(readFileSync(join(hub, 'package.json'), 'utf8'));
const name = `communal-hub-${version}`;
const out = join(hub, 'release', name);
// COPYFILE_DISABLE: macOS tar would otherwise add extended attributes Linux tar warns about.
const run = (cmd, a, cwd = root) =>
  execFileSync(cmd, a, { cwd, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });

run('pnpm', ['--filter', '@communal/hub...', 'run', 'build']);
rmSync(out, { recursive: true, force: true });
run('pnpm', [
  '--filter',
  '@communal/hub',
  'deploy',
  '--prod',
  '--config.node-linker=hoisted',
  join(out, 'lib'),
]);
for (const f of [
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'src',
  'scripts',
  'packaging',
  'release',
  'hub-data',
])
  rmSync(join(out, 'lib', f), { recursive: true, force: true });
rmSync(join(out, 'lib/node_modules/.pnpm'), { recursive: true, force: true });

mkdirSync(join(out, 'bin'), { recursive: true });
writeFileSync(
  join(out, 'bin/communal-hub'),
  `#!/bin/sh
# Communal hub server and admin commands. Uses the Node.js on PATH (24 or later).
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
exec node "$here/../lib/dist/main.js" "$@"
`,
);
chmodSync(join(out, 'bin/communal-hub'), 0o755);
for (const f of ['communal-hub.service', 'install.sh', 'communal-hub.env.example'])
  cpSync(join(hub, 'packaging', f), join(out, f));

run(join(out, 'bin/communal-hub'), ['--help'], out);
run('tar', ['-czf', `${name}.tar.gz`, name], join(hub, 'release'));
console.log(`package: apps/hub/release/${name}.tar.gz`);
