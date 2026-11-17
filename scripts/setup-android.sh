#!/bin/sh
# Restores the Android-arm64 native addons that DeepSeekRuntime needs but whose
# official packages do not ship for Android. Run this after any `pnpm install`.
#
# Termux prerequisites and order:
#   pkg install nodejs-lts python clang make cmake git
#   pnpm install
#   sh scripts/setup-android.sh
#   pnpm run build
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO="$HERE/.."
VENDOR="$REPO/vendor/android-prebuilds"

# koffi and other source-built native packages need an Android toolchain.
missing_tools=
for tool in clang cmake make; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    missing_tools="$missing_tools $tool"
  fi
done
if [ -n "$missing_tools" ]; then
  echo "missing build tools:$missing_tools" >&2
  echo "Termux: pkg install clang cmake make" >&2
  exit 1
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    node -e 'const {createHash}=require("node:crypto");const fs=require("node:fs");process.stdout.write(createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"
  fi
}

restore_addon() {
  src=$1
  dst=$2
  if [ ! -f "$src" ]; then
    echo "missing prebuilt addon: $src" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  src_hash=$(sha256_of "$src")
  dst_hash=$(sha256_of "$dst")
  if [ "$src_hash" != "$dst_hash" ]; then
    echo "sha256 mismatch for $dst: vendor $src_hash != target $dst_hash" >&2
    exit 1
  fi
  echo "restored $(basename "$dst") -> $dst (sha256 $dst_hash)"
}

# 1) node-addon-require-builtin (used by the boot loader)
SRC_REQUIRE="$VENDOR/require_builtin.node"
# Resolve the installed package so a dependency upgrade does not silently miss.
REQUIRE_PKG_JSON=
if REQUIRE_PKG_JSON=$(cd "$REPO/apps/cli" && node -e "console.log(require.resolve('node-addon-require-builtin/package.json'))" 2>/dev/null) &&
  [ -n "$REQUIRE_PKG_JSON" ]; then
  REQUIRE_PKG_DIR=${REQUIRE_PKG_JSON%/package.json}
  DSTFILE_REQUIRE=$REQUIRE_PKG_DIR/build/napi/napi-v9-android-arm64/require_builtin.node
else
  echo "could not resolve node-addon-require-builtin from apps/cli; falling back to find, which is pinned to node-addon-require-builtin@0.1.9* and silently misses other versions" >&2
  PINNED_REQUIRE=$(find "$REPO/node_modules/.pnpm" -maxdepth 1 -type d -name 'node-addon-require-builtin@0.1.9*' | head -1)
  if [ -z "$PINNED_REQUIRE" ]; then
    echo "node-addon-require-builtin not installed; run pnpm install first (resolution failed and the pinned fallback found no 0.1.9 install)" >&2
    exit 1
  fi
  DSTFILE_REQUIRE=$PINNED_REQUIRE/node_modules/node-addon-require-builtin/build/napi/napi-v9-android-arm64/require_builtin.node
fi
restore_addon "$SRC_REQUIRE" "$DSTFILE_REQUIRE"

# 2) node-addon-system flock addon (used by session persistence)
SRC_FLOCK="$VENDOR/system.node"
# Android uses bionic libc; keep the addon in its own directory so the
# glibc/musl selection logic for desktop Linux never mistakes it for one.
DSTFILE_FLOCK="$REPO/native/system/packages/entry/bin/bionic/system.node"
restore_addon "$SRC_FLOCK" "$DSTFILE_FLOCK"
