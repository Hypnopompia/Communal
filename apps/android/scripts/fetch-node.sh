#!/bin/sh
# Fetches the Node 24 runtime for the Android app: Termux's nodejs-lts build and the shared
# libraries it needs, pinned by version and SHA-256 (ADR 0023). Upstream Node's Android
# cross-build doesn't work without Termux's patches; our own build replaces this stopgap.
#
#   scripts/fetch-node.sh [arm64-v8a|x86_64 ...]     (default: arm64-v8a)
#
# Unpacks into runtime/<abi>/usr. Termux replaces old packages in its pool, so a pinned file
# can disappear; then refresh the pins below (version, file and hash) from the repo's
# Packages index, or set COMMUNAL_TERMUX_MIRROR to a copy of the old files.
set -eu
HERE=$(cd "$(dirname "$0")/.." && pwd)
MIRROR=${COMMUNAL_TERMUX_MIRROR:-https://packages.termux.dev/apt/termux-main}
ABIS=${*:-arm64-v8a}

# abi file sha256
PINS='
arm64-v8a pool/main/n/nodejs-lts/nodejs-lts_24.18.0-1_aarch64.deb 490f4d08c45b25a7ea7db6ee466ebb3ee61f07083260b85332704ed018f59a87
arm64-v8a pool/main/o/openssl/openssl_1:3.6.5_aarch64.deb a2fb7856875e63ef6b90442752e05974813372c3ca86d2513a78ea43c67a0f8b
arm64-v8a pool/main/libi/libicu/libicu_78.3_aarch64.deb f536403f65a08fe0df6e7304184e902d54def77d5c3bd5edfd9109d57601d276
arm64-v8a pool/main/c/c-ares/c-ares_1.34.8_aarch64.deb 7681fc23e822d7988ba8b2adf3468f93ae68f724dda365cff1385096a9fa87e6
arm64-v8a pool/main/z/zlib/zlib_1.3.2_aarch64.deb 75e7d0af17fcc3b40004309fdc00a1ddb9ae08346dce5e269902c34ac3966ac9
arm64-v8a pool/main/libs/libsqlite/libsqlite_3.54.0_aarch64.deb 9adf91e118fcf4d449f0fb9668485d895916c4f76c2407da17ba114406f43a58
arm64-v8a pool/main/libc/libc++/libc++_30_aarch64.deb 53d0b84a7ba7459024257cb94d5b136fe13ef858567f65a8064b35950799f2ca
x86_64 pool/main/n/nodejs-lts/nodejs-lts_24.18.0-1_x86_64.deb 2a41c61c609993a7d897fed130adf4d6debb0b30713ab85bb47c2fc8373458ba
x86_64 pool/main/o/openssl/openssl_1:3.6.5_x86_64.deb 540f144592d23d35672976e175ede1b5d8cf464f153f646df5d4e6dcd8491a15
x86_64 pool/main/libi/libicu/libicu_78.3_x86_64.deb 19fa8c4d828719f465d523983b1e0d833e4130bb22790104638965d97e27fe60
x86_64 pool/main/c/c-ares/c-ares_1.34.8_x86_64.deb c5d6194d69a04089040ca50dad96ed7df8773bd3c3d7c4be7d1dd5661ceae6b4
x86_64 pool/main/z/zlib/zlib_1.3.2_x86_64.deb c61b089dd30981452f5953b2bad4c4e7857062b2abd971f87fb0aec441bc02f4
x86_64 pool/main/libs/libsqlite/libsqlite_3.54.0_x86_64.deb 8c15e92cef3cb7dc387644c438aa35abab408e3211fcc9c0da6f35cfa0213202
x86_64 pool/main/libc/libc++/libc++_30_x86_64.deb c9bcd9a8067a19c9c0e4893a72d314a2e37d6b67ce8dd05c67b9bbacad044b4f
'

sha256() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

for ABI in $ABIS; do
  OUT=$HERE/runtime/$ABI
  CACHE=$HERE/runtime/cache
  mkdir -p "$CACHE"
  rm -rf "$OUT" && mkdir -p "$OUT"
  echo "$PINS" | while read -r abi file want; do
    [ "$abi" = "$ABI" ] || continue
    deb=$CACHE/$(basename "$file" | tr ':' '_')
    if [ ! -f "$deb" ] || [ "$(sha256 "$deb")" != "$want" ]; then
      curl -fsSL --retry 3 -o "$deb.tmp" "$MIRROR/$(echo "$file" | sed 's/:/%3A/g')"
      mv "$deb.tmp" "$deb"
    fi
    got=$(sha256 "$deb")
    if [ "$got" != "$want" ]; then
      echo "checksum mismatch for $file: $got" >&2
      exit 1
    fi
    tmp=$(mktemp -d)
    # bsdtar (macOS) reads ar archives itself; elsewhere use ar (binutils).
    if tar --version 2>/dev/null | grep -q bsdtar; then
      (cd "$tmp" && tar xf "$deb" && tar xf data.tar.*)
    else
      (cd "$tmp" && ar x "$deb" && tar xf data.tar.*)
    fi
    cp -R "$tmp"/data/data/com.termux/files/usr "$OUT"/
    rm -rf "$tmp"
  done
  test -x "$OUT/usr/bin/node" || { echo "no node in $OUT" >&2; exit 1; }
  echo "$ABI: $(du -sh "$OUT" | cut -f1) in $OUT/usr"
done
