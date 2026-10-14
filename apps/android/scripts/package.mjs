// Builds the release APK (ADR 0023): fetches the pinned Node runtime, bundles the core with
// its native addons, and runs Gradle. Output: release/communal-<version>-<abi>.apk.
//
//   pnpm --filter @communal/android package [-- --abi arm64-v8a]
//
// Signing comes from the environment (COMMUNAL_ANDROID_KEYSTORE, …_KEYSTORE_PASSWORD,
// …_KEY_ALIAS, …_KEY_PASSWORD); without it Gradle signs with the debug key, which is fine for
// trying a build but can't update an installed release.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const abi = args.includes('--abi') ? args[args.indexOf('--abi') + 1] : 'arm64-v8a';
const short = { 'arm64-v8a': 'arm64', x86_64: 'x64' }[abi];
if (!short) throw new Error(`unknown ABI ${abi}`);
const { version } = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
const run = (cmd, argv) => execFileSync(cmd, argv, { cwd: here, stdio: 'inherit' });

if (!process.env.COMMUNAL_ANDROID_KEYSTORE)
  console.warn('warning: no COMMUNAL_ANDROID_KEYSTORE; the APK is signed with the debug key');
run('sh', ['scripts/fetch-node.sh', abi]);
run('sh', ['scripts/prepare-jnilibs.sh', abi]);
run(process.platform === 'win32' ? 'gradlew.bat' : './gradlew', [
  '--no-daemon',
  ':app:assembleRelease',
  `-Pcommunal.abis=${abi}`,
]);
const out = join(here, 'release');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const apk = join(out, `communal-${version}-${short}.apk`);
copyFileSync(join(here, 'app/build/outputs/apk/release/app-release.apk'), apk);
console.log(apk);
