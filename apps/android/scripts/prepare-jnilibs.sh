#!/bin/sh
# Puts the Node 24 runtime and the core bundle into the APK sources, for each ABI (ADR 0023).
#
#   scripts/prepare-jnilibs.sh [arm64-v8a|x86_64 ...]     (default: arm64-v8a)
#
# Needs runtime/<abi>/usr from scripts/fetch-node.sh, the Android NDK and patchelf.
#
# Node: an APK only extracts files named lib*.so, so the executable becomes libnode.so and
# versioned sonames (libssl.so.3…) are renamed with patchelf. Kotlin runs
# nativeLibraryDir/libnode.so as a child process: apps may exec files from nativeLibraryDir, not
# from their writable data dir. The core bundle goes to assets/core/<abi>/, with that ABI's
# native addons; the app unpacks it into its files dir on first start after an update.
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
ABIS=${*:-arm64-v8a}
NDK=${ANDROID_NDK_HOME:-${ANDROID_HOME:-$HOME/Library/Android/sdk}/ndk/28.2.13676358}
HOST=$(uname | tr A-Z a-z)-x86_64
STRIP=$NDK/toolchains/llvm/prebuilt/$HOST/bin/llvm-strip
ASSETS=$HERE/app/src/main/assets
command -v patchelf >/dev/null || { echo "patchelf is needed (brew install patchelf)" >&2; exit 1; }
test -x "$STRIP" || { echo "no NDK at $NDK (set ANDROID_NDK_HOME)" >&2; exit 1; }

# soname -> APK-safe file name
SONAMES='
libz.so.1 libz1.so
libcares.so libcares.so
libsqlite3.so libsqlite3.so
libcrypto.so.3 libcrypto3.so
libssl.so.3 libssl3.so
libicui18n.so.78 libicui18n78.so
libicuuc.so.78 libicuuc78.so
libicudata.so.78 libicudata78.so
libc++_shared.so libc++_shared.so
'
renames() {
  echo "$SONAMES" | while read -r from to; do
    if [ -n "$from" ] && [ "$from" != "$to" ]; then patchelf --replace-needed "$from" "$to" "$1"; fi
  done
  patchelf --remove-rpath "$1"
}

rm -rf "$ASSETS/core" && mkdir -p "$ASSETS/core"
for ABI in $ABIS; do
  USR=$HERE/runtime/$ABI/usr
  test -x "$USR/bin/node" || { echo "run scripts/fetch-node.sh $ABI first" >&2; exit 1; }
  case $ABI in
    arm64-v8a) TARGET=android-arm64 NDKARCH=arm64 ;;
    x86_64) TARGET=android-x64 NDKARCH=x86_64 ;;
    *) echo "unknown ABI $ABI" >&2; exit 1 ;;
  esac
  OUT=$HERE/app/src/main/jniLibs/$ABI
  rm -rf "$OUT" && mkdir -p "$OUT"
  echo "$SONAMES" | while read -r from to; do
    [ -n "$from" ] || continue
    cp "$USR/lib/$from" "$OUT/$to"
    chmod u+w "$OUT/$to"
    patchelf --set-soname "$to" "$OUT/$to"
    renames "$OUT/$to"
  done
  cp "$USR/bin/node" "$OUT/libnode.so"
  chmod u+w "$OUT/libnode.so"
  renames "$OUT/libnode.so"
  "$STRIP" "$OUT"/*.so 2>/dev/null || true

  SQLITE=$HERE/build/sqlite/$ABI/better_sqlite3.node
  mkdir -p "$(dirname "$SQLITE")"
  [ -f "$SQLITE" ] || sh "$HERE/scripts/ndk-sqlite.sh" "$SQLITE" "$NDKARCH"
  (cd "$HERE" && node scripts/build.mjs --target "$TARGET" --sqlite "$SQLITE" --out "dist/$ABI")
  cp -R "$HERE/dist/$ABI" "$ASSETS/core/$ABI"
  # AAPT can't list asset dirs cheaply at run time: keep an index for unpacking.
  (cd "$ASSETS/core/$ABI" && find . -type f ! -name files.txt | sed 's#^\./##' | sort > files.txt)
  du -sh "$OUT" "$ASSETS/core/$ABI"
done
