#!/usr/bin/env bash
# Build libvips and sharp from source for Termux/Android.
#
# npm's sharp packages ship prebuilt binaries for glibc/musl Linux, macOS,
# Windows, and FreeBSD; none target Android's bionic libc, so `require('sharp')`
# fails with "Could not load the sharp module using the android-arm64 runtime".
# This script compiles libvips with the codecs sharp relies on into an
# app-private prefix, then rebuilds sharp's addon against it and records that
# prefix in the addon's RUNPATH so the DSH process needs no LD_LIBRARY_PATH.
#
# Prerequisites:
#   pkg install nodejs-lts python clang make pkg-config \
#               libwebp libtiff cgif libimagequant librsvg libexif
#   pip install meson ninja
#
# Usage:
#   sh scripts/setup-android-sharp.sh          # build libvips (if absent), then sharp
#   sh scripts/setup-android-sharp.sh --check  # verify the existing install
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
VIPS_VERSION="${VIPS_VERSION:-8.18.7}"
VIPS_PREFIX="${DSH_ANDROID_VIPS_PREFIX:-$HOME/dsh-vips}"
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/dsh-android-sharp"
ATTACHMENT_DIR="$REPO/packages/attachment/attachment-local"

fail() {
  echo "setup-android-sharp: $*" >&2
  exit 1
}

[ "$(node -p 'process.platform')" = "android" ] \
  || fail "this script targets Termux/Android"

sharp_dir() {
  # sharp's exports map hides package.json, so walk up from its entry point.
  (cd "$ATTACHMENT_DIR" && node -p "require('path').resolve(require('path').dirname(require.resolve('sharp')), '..')")
}

sharp_addon() {
  local dir
  dir="$(sharp_dir)"
  echo "$dir/src/build/Release/sharp-android-arm64-$(node -p "require('$dir/package.json').version").node"
}

check_install() {
  [ -f "$(sharp_addon)" ] || fail "sharp addon is not built; run without --check"
  (cd "$ATTACHMENT_DIR" \
    && node -e "const s = require('sharp'); console.log('sharp', s.versions.sharp, 'vips', s.versions.vips)")
}

if [ "${1:-}" = "--check" ]; then
  check_install
  exit 0
fi

command -v cc >/dev/null || fail "clang is missing: pkg install clang"
command -v meson >/dev/null || fail "meson is missing: pip install meson"
command -v ninja >/dev/null || fail "ninja is missing: pip install ninja"
command -v pkg-config >/dev/null || fail "pkg-config is missing: pkg install pkg-config"

if [ ! -f "$VIPS_PREFIX/lib/pkgconfig/vips-cpp.pc" ]; then
  for dep in libwebp.pc libtiff-4.pc cgif.pc imagequant.pc librsvg-2.0.pc libexif.pc; do
    [ -f "$PREFIX/lib/pkgconfig/$dep" ] \
      || fail "missing build dependency $dep; install the matching Termux package"
  done
  echo "setup-android-sharp: building libvips $VIPS_VERSION into $VIPS_PREFIX"
  mkdir -p "$CACHE_DIR"
  if [ ! -d "$CACHE_DIR/vips-$VIPS_VERSION" ]; then
    curl -fsSL --retry 3 -o "$CACHE_DIR/vips.tar.xz" \
      "https://github.com/libvips/libvips/releases/download/v$VIPS_VERSION/vips-$VIPS_VERSION.tar.xz"
    tar -C "$CACHE_DIR" -xf "$CACHE_DIR/vips.tar.xz"
  fi
  (
    cd "$CACHE_DIR/vips-$VIPS_VERSION"
    [ -d build ] || meson setup build --prefix="$VIPS_PREFIX" --buildtype=release \
      -Ddeprecated=false -Dexamples=false -Ddocs=false -Dcplusplus=true -Dcpp-docs=false \
      -Dmodules=disabled -Dintrospection=disabled -Dvapi=false \
      -Djpeg=enabled -Dpng=enabled -Dwebp=enabled -Dtiff=enabled -Dcgif=enabled \
      -Dimagequant=enabled -Drsvg=enabled -Dexif=enabled
    ninja -C build
    ninja -C build install
  )
fi

NODE_GYP="$(cd "$REPO" && ls -d "$PWD"/node_modules/.pnpm/node-gyp@*/node_modules/node-gyp 2>/dev/null | head -1)"
ADDON_API="$(cd "$REPO" && ls -d "$PWD"/node_modules/.pnpm/node-addon-api@*/node_modules/node-addon-api 2>/dev/null | head -1)"
[ -n "$NODE_GYP" ] && [ -d "$NODE_GYP" ] || fail "node-gyp is missing from the workspace store; run pnpm install"
[ -n "$ADDON_API" ] && [ -d "$ADDON_API" ] || fail "node-addon-api is missing from the workspace store; run pnpm install"
BIN_DIR="$CACHE_DIR/bin"
mkdir -p "$BIN_DIR"
printf '#!/bin/sh\nexec node "%s/bin/node-gyp.js" "$@"\n' "$NODE_GYP" > "$BIN_DIR/node-gyp"
chmod +x "$BIN_DIR/node-gyp"

echo "setup-android-sharp: building sharp against $VIPS_PREFIX"
(
  cd "$(sharp_dir)"
  PATH="$BIN_DIR:$PATH" \
  NODE_PATH="$(dirname "$ADDON_API"):$(dirname "$NODE_GYP")" \
  PKG_CONFIG_PATH="$VIPS_PREFIX/lib/pkgconfig" \
  SHARP_FORCE_GLOBAL_LIBVIPS=1 \
  LDFLAGS="-Wl,-rpath,$VIPS_PREFIX/lib" \
  node install/build.js
)

check_install
