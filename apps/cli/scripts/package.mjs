// Packages the headless client as a tarball for this platform (HANDOFF §12 M9):
//   pnpm --filter @communal/cli package
// → apps/cli/release/communal-<version>-<platform>-<arch>.tar.gz, holding the app with its
// production dependencies (native prebuilds for this platform), a `bin/communal` launcher, the
// systemd unit and install.sh. It needs Node.js 24 on the target machine. The Docker image
// (docker/headless.Dockerfile) is the other way to run it.
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const here = dirname(new URL(import.meta.url).pathname);
const cli = join(here, '..');
const root = join(cli, '../..');
const { version } = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8'));
const name = `communal-${version}-${process.platform}-${process.arch}`;
const out = join(cli, 'release', name);
const run = (cmd, a, cwd = root) => execFileSync(cmd, a, { cwd, stdio: 'inherit' });

run('pnpm', ['--filter', '@communal/cli...', 'run', 'build']);
rmSync(out, { recursive: true, force: true });
run('pnpm', [
  '--filter',
  '@communal/cli',
  'deploy',
  '--prod',
  '--config.node-linker=hoisted',
  join(out, 'lib'),
]);
for (const f of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'src', 'scripts', 'packaging', 'release'])
  rmSync(join(out, 'lib', f), { recursive: true, force: true });
rmSync(join(out, 'lib/node_modules/.pnpm'), { recursive: true, force: true });

mkdirSync(join(out, 'bin'), { recursive: true });
writeFileSync(
  join(out, 'bin/communal'),
  `#!/bin/sh
# Communal CLI and daemon. Uses the Node.js on PATH (24 or later).
here=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
exec node "$here/../lib/dist/main.js" "$@"
`,
);
chmodSync(join(out, 'bin/communal'), 0o755);
for (const f of ['communal.service', 'install.sh', 'communal.env.example'])
  cpSync(join(cli, 'packaging', f), join(out, f));

// The packaged CLI must run: `communal --version` from the unpacked tree.
run(join(out, 'bin/communal'), ['--version'], out);
run('tar', ['-czf', `${name}.tar.gz`, name], join(cli, 'release'));
console.log(`package: apps/cli/release/${name}.tar.gz`);
