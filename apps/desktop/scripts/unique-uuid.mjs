// electron-builder afterPack hook (macOS). macOS tracks Local Network permission by each
// executable's Mach-O UUID (Apple TN3179), and every app built on the same Electron release
// ships byte-identical executables with the same UUID. Left alone, Communal would share its
// permission, and the name shown in the prompt, with any other Electron app of that version.
// So the main executable and its helpers get UUIDs of their own, derived from the app id and
// the executable's name, before electron-builder signs them.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MH_MAGIC_64 = 0xfeedfacf;
const FAT_MAGIC = 0xcafebabe;
const LC_UUID = 0x1b;

/** Rewrites LC_UUID in one thin 64-bit Mach-O image starting at `base`. */
function patchThin(buf, base, uuid) {
  if (buf.readUInt32LE(base) !== MH_MAGIC_64) throw new Error('not a 64-bit Mach-O image');
  const ncmds = buf.readUInt32LE(base + 16);
  let off = base + 32; // sizeof(mach_header_64)
  for (let i = 0; i < ncmds; i++) {
    const cmd = buf.readUInt32LE(off);
    const size = buf.readUInt32LE(off + 4);
    if (cmd === LC_UUID) {
      uuid.copy(buf, off + 8);
      return true;
    }
    off += size;
  }
  return false;
}

export function setUuid(file, seed) {
  const buf = readFileSync(file);
  // A version-4-shaped UUID from a hash, so the same app always gets the same one.
  const uuid = createHash('sha256').update(seed).digest().subarray(0, 16);
  uuid[6] = (uuid[6] & 0x0f) | 0x40;
  uuid[8] = (uuid[8] & 0x3f) | 0x80;
  let patched = 0;
  if (buf.readUInt32BE(0) === FAT_MAGIC) {
    const n = buf.readUInt32BE(4);
    for (let i = 0; i < n; i++) {
      const offset = buf.readUInt32BE(8 + i * 20 + 8);
      if (patchThin(buf, offset, uuid)) patched++;
    }
  } else if (patchThin(buf, 0, uuid)) patched++;
  if (!patched) throw new Error(`no LC_UUID in ${file}`);
  writeFileSync(file, buf);
}

export default async function uniqueUuid(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appId = context.packager.appInfo.id;
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const executables = [join(app, 'Contents/MacOS', context.packager.appInfo.productFilename)];
  const frameworks = join(app, 'Contents/Frameworks');
  for (const d of readdirSync(frameworks).filter((d) => d.endsWith('.app'))) {
    const exe = join(frameworks, d, 'Contents/MacOS', d.replace(/\.app$/, ''));
    if (existsSync(exe)) executables.push(exe);
  }
  for (const exe of executables) setUuid(exe, `${appId}:${exe.split('/').pop()}`);
  // Patching breaks Electron's ad-hoc signatures, and Apple Silicon won't run unsigned code.
  // Re-sign ad hoc; when a Developer ID is configured, electron-builder signs over this next.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  console.log(`unique-uuid: ${executables.length} executables`);
}
