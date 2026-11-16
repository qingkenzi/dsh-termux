#!/bin/sh
# Restores the Android-arm64 native addons that DeepSeekRuntime needs but whose
# official packages do not ship for Android. Run this after any `pnpm install`.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO="$HERE/.."
VENDOR="$REPO/vendor/android-prebuilds"

# 1) node-addon-require-builtin (used by the boot loader)
SRC_REQUIRE="$VENDOR/require_builtin.node"
DSTDIR_REQUIRE=$(find "$REPO/node_modules/.pnpm" -maxdepth 1 -type d -name 'node-addon-require-builtin@0.1.9*' | head -1)/node_modules/node-addon-require-builtin/build/napi/napi-v9-android-arm64

if [ ! -f "$SRC_REQUIRE" ]; then
  echo "missing prebuilt addon: $SRC_REQUIRE" >&2
  exit 1
fi
if [ -z "$DSTDIR_REQUIRE" ] || [ "$DSTDIR_REQUIRE" = "/node_modules/node-addon-require-builtin/build/napi/napi-v9-android-arm64" ]; then
  echo "node-addon-require-builtin not installed; run pnpm install first" >&2
  exit 1
fi
mkdir -p "$DSTDIR_REQUIRE"
cp "$SRC_REQUIRE" "$DSTDIR_REQUIRE/require_builtin.node"
echo "restored require_builtin.node -> $DSTDIR_REQUIRE/require_builtin.node"

# 2) node-addon-system flock addon (used by session persistence)
SRC_FLOCK="$VENDOR/system.node"
DSTDIR_FLOCK="$REPO/native/system/packages/entry/bin/glibc"
if [ ! -f "$SRC_FLOCK" ]; then
  echo "missing prebuilt addon: $SRC_FLOCK" >&2
  exit 1
fi
mkdir -p "$DSTDIR_FLOCK"
cp "$SRC_FLOCK" "$DSTDIR_FLOCK/system.node"
echo "restored system.node -> $DSTDIR_FLOCK/system.node"
