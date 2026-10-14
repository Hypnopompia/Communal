// Builds and publishes a GitHub Release for the version in apps/desktop/package.json:
//   pnpm release        (needs the GitHub CLI `gh`, logged in, and the Mac signing setup below)
//
// Like ListenSync's release, the Mac apps are built, signed and notarized here; GitHub Actions
// builds Windows, Linux and the headless/hub tarballs on their own OSes (.github/workflows/
// release.yml, started by the tag) and uploads them into the same draft release. Then the
// release is published, and installed apps update from it (electron-updater).
//
// 1. The version's notes must be in apps/desktop/changelog.json.
// 2. `main` must be committed and pushed: the tag is made from it.
// 3. A draft release is created and the tag pushed (that starts the Actions build).
// 4. Both Mac apps (Apple Silicon and Intel) are packaged, smoke-tested and uploaded, with one
//    latest-mac.yml listing both so each Mac updates to its own build.
// 5. Once the Actions run succeeds, the release is published.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const desktop = join(root, 'apps/desktop');
const repo = 'Hypnopompia/Communal';
const { version } = JSON.parse(readFileSync(join(desktop, 'package.json'), 'utf8'));
const tag = `v${version}`;
const run = (cmd, args, env = {}) =>
  execFileSync(cmd, args, { cwd: root, stdio: 'inherit', env: { ...process.env, ...env } });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();
const gh = (...args) => out('gh', args);
const fail = (msg) => {
  console.error(`release: ${msg}`);
  process.exit(1);
};

// ── checks ──
if (process.platform !== 'darwin') fail('run this on a Mac: it builds and signs the Mac apps');
const notes = JSON.parse(readFileSync(join(desktop, 'changelog.json'), 'utf8')).find(
  (v) => v.version === version,
);
if (!notes?.date || !notes.changes?.length)
  fail(`add ${version} (with its date and a list of changes) to apps/desktop/changelog.json`);
// The Android app takes its version (and versionCode) from its own package.json.
const android = JSON.parse(readFileSync(join(root, 'apps/android/package.json'), 'utf8')).version;
if (android !== version) fail(`apps/android/package.json is ${android}: bump it to ${version}`);
if (out('git', ['status', '--porcelain'])) fail('commit your changes first');
if (out('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') fail('release from main');
run('git', ['fetch', '-q', 'origin', 'main']);
if (out('git', ['rev-parse', 'HEAD']) !== out('git', ['rev-parse', 'origin/main']))
  fail('push main first: the release is built from what is on GitHub');

// Signing: a Developer ID certificate in the keychain. Notarizing: an App Store Connect API key,
// from the environment or the repo's .env (never committed, never bundled).
const identities = out('security', ['find-identity', '-v', '-p', 'codesigning']);
if (!/Developer ID Application/.test(identities))
  fail(
    'no "Developer ID Application" certificate in the keychain, so the Mac app would not be ' +
      'signed. Create one in Xcode: Settings > Accounts > Manage Certificates > + > Developer ID Application.',
  );
const dotenv = {};
if (existsSync(join(root, '.env')))
  for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m) dotenv[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
const APPLE_KEYS = ['APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];
const apple = Object.fromEntries(APPLE_KEYS.map((k) => [k, process.env[k] || dotenv[k] || '']));
const missing = APPLE_KEYS.filter((k) => !apple[k]);
if (missing.length)
  fail(
    `missing ${missing.join(', ')} (in .env), so the Mac app would not be notarized. See .env.example.`,
  );
if (!existsSync(apple.APPLE_API_KEY))
  fail(`APPLE_API_KEY points to ${apple.APPLE_API_KEY}, which doesn't exist`);

// ── draft release and tag ──
const state = (() => {
  try {
    return JSON.parse(gh('release', 'view', tag, '-R', repo, '--json', 'isDraft'));
  } catch {
    return null;
  }
})();
if (state && !state.isDraft) fail(`${tag} is already published: bump the version first`);
if (!out('git', ['tag', '--list', tag])) run('git', ['tag', tag]);
run('git', ['push', '-q', 'origin', tag]);
if (!state) {
  const [previous] = JSON.parse(
    gh(
      'release',
      'list',
      '-R',
      repo,
      '--exclude-drafts',
      '--exclude-pre-releases',
      '--limit',
      '1',
      '--json',
      'tagName',
    ),
  );
  const body =
    notes.changes.map((c) => `- ${c}`).join('\n') +
    (previous
      ? `\n\n**Full Changelog**: https://github.com/${repo}/compare/${previous.tagName}...${tag}`
      : '');
  console.log(`Creating draft release ${tag}…`);
  gh(
    'release',
    'create',
    tag,
    '-R',
    repo,
    '--draft',
    '--verify-tag',
    '--title',
    version,
    '--notes',
    body,
  );
}

// ── Mac apps ──
for (const arch of ['arm64', 'x64'])
  run('node', [join(desktop, 'scripts/package.mjs'), '--arch', arch], apple);

// One latest-mac.yml for both CPUs: the updater picks the zip with "arm64" in its name on
// Apple Silicon, and one without it on Intel.
const yml = (arch) => readFileSync(join(desktop, 'release', arch, 'latest-mac.yml'), 'utf8');
const filesBlock = (text) =>
  /^files:\n((?: {2}.*\n)+)/m.exec(text)?.[1] ?? fail('unexpected latest-mac.yml');
const merged = yml('arm64').replace(/^files:\n((?: {2}.*\n)+)/m, (m) => m + filesBlock(yml('x64')));
const mergedFile = join(desktop, 'release', 'latest-mac.yml');
writeFileSync(mergedFile, merged);

const assets = ['arm64', 'x64'].flatMap((arch) =>
  ['dmg', 'dmg.blockmap', 'zip', 'zip.blockmap'].map((ext) =>
    join(desktop, 'release', arch, `Communal-${version}-${arch}.${ext}`),
  ),
);
for (const a of assets) if (!existsSync(a)) fail(`missing ${a}`);
console.log('Uploading the Mac apps…');
run('gh', ['release', 'upload', tag, '-R', repo, '--clobber', ...assets, mergedFile]);

// ── Windows, Linux, headless and hub (GitHub Actions) ──
console.log('Waiting for the Windows/Linux build in GitHub Actions…');
let runId = '';
for (let i = 0; i < 30 && !runId; i++) {
  runId = gh(
    'run',
    'list',
    '-R',
    repo,
    '--workflow',
    'release.yml',
    '--branch',
    tag,
    '--limit',
    '1',
    '--json',
    'databaseId',
    '--jq',
    '.[0].databaseId // ""',
  );
  if (!runId) execFileSync('sleep', ['10']);
}
if (!runId) fail(`no release.yml run for ${tag}; the draft is ready apart from Windows/Linux`);
try {
  run('gh', ['run', 'watch', runId, '-R', repo, '--exit-status', '--interval', '30']);
} catch {
  fail(
    `the Actions run failed (https://github.com/${repo}/actions/runs/${runId}); the release stays a draft`,
  );
}

console.log(`Publishing ${tag}…`);
gh('release', 'edit', tag, '-R', repo, '--draft=false', '--latest');
console.log(`Done: https://github.com/${repo}/releases/tag/${tag}`);
