// electron-builder afterSign hook: notarizes and staples the macOS app when Apple credentials
// are present (APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID). Without them, or on other
// platforms, it does nothing, so local and CI builds work unsigned.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export default async function notarize(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('notarize: no Apple credentials, skipping');
    return;
  }
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const zip = `${app}.zip`;
  const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
  run('ditto', ['-c', '-k', '--keepParent', app, zip]);
  run('xcrun', [
    'notarytool',
    'submit',
    zip,
    '--wait',
    '--apple-id',
    APPLE_ID,
    '--password',
    APPLE_APP_SPECIFIC_PASSWORD,
    '--team-id',
    APPLE_TEAM_ID,
  ]);
  run('xcrun', ['stapler', 'staple', app]);
  run('rm', [zip]);
}
