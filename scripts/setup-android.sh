#!/bin/sh
# Restore the Android-arm64 native addons that DeepSeekRuntime needs but whose
# official packages do not ship for Android. Run this after any `pnpm install`.
#
# The restore is fail-closed: every prebuilt is checked against
# `vendor/android-prebuilds/addons.manifest.json` before it is copied, and the
# copy is verified again before the previous file is replaced. `--check` only
# verifies the current installation and never writes.
#
# Termux prerequisites and order:
#   pkg install nodejs-lts python clang make cmake git binutils
#   pnpm install
#   pnpm run setup:android            # or: sh scripts/setup-android.sh --sharp=build
#   pnpm run build
#   pnpm run verify:android
#
# Usage:
#   sh scripts/setup-android.sh [--check] [--sharp=check|build|skip] [--restore-sharp]
#
# Options:
#   --check             Verify only; fail when a target is missing or different.
#   --sharp=check       Verify the installed sharp addon (default).
#   --sharp=build       Build libvips when absent, then rebuild sharp.
#   --sharp=skip        Skip sharp entirely (compatible alias: --skip-sharp).
#   --restore-sharp     Restore sharp from the setup-android-sharp cache.
#
# Steps:
#   1. require_builtin.node -> node-addon-require-builtin's Android N-API directory
#   2. system.node         -> the flock addon's platform-package and entry bionic directories
#   3. vendor/android-prebuilds/rg -> verified by scripts/setup-android-rg.sh
#   4. sharp               -> verified, built, or restored by scripts/setup-android-sharp.sh
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
VENDOR="$REPO/vendor/android-prebuilds"
MANIFEST="$VENDOR/addons.manifest.json"

CHECK_ONLY=0
SHARP_POLICY=check
RESTORE_SHARP=0

usage() {
  cat <<'EOF'
Usage: sh scripts/setup-android.sh [--check] [--sharp=check|build|skip] [--restore-sharp]

  --check           Verify only; never write the restored addons.
  --sharp=check     Verify the installed sharp addon (default).
  --sharp=build     Build libvips when absent, then rebuild sharp.
  --sharp=skip      Skip sharp (compatible alias: --skip-sharp).
  --restore-sharp   Restore sharp from the setup-android-sharp cache.
EOF
}

fail() {
  echo "setup-android: $*" >&2
  exit 1
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    node -e 'const {createHash}=require("node:crypto");const fs=require("node:fs");process.stdout.write(createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"
  fi
}

manifest_field() {
  node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));if(m.schemaVersion!==1||m.target!=="aarch64-linux-android"||m.algorithm!=="sha256")process.exit(3);const e=m.files&&m.files[process.argv[2]];const v=e&&e[process.argv[3]];if(v===undefined)process.exit(2);process.stdout.write(String(v))' \
    "$MANIFEST" "$1" "$2" 2>/dev/null \
    || fail "cannot read $1.$2 from $MANIFEST"
}

manifest_sha() {
  manifest_field "$1" sha256
}

manifest_size() {
  manifest_field "$1" size
}

check_build_tools() {
  missing_tools=
  for tool in clang cmake make; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      missing_tools="$missing_tools $tool"
    fi
  done
  if [ -n "$missing_tools" ]; then
    echo "setup-android: missing build tools:$missing_tools" >&2
    echo "Termux: pkg install clang cmake make" >&2
    exit 1
  fi
}

# Copy one pinned addon into the installed package. The manifest is the only
# accepted SHA-256 source; the vendor and target copies are never compared to
# each other.
restore_addon() {
  name=$1
  dst=$2
  src="$VENDOR/$name"
  [ -f "$src" ] || fail "missing prebuilt addon: $src"
  expected_sha=$(manifest_sha "$name")
  expected_size=$(manifest_size "$name")

  actual_size=$(wc -c < "$src" | tr -d ' ')
  [ "$actual_size" = "$expected_size" ] \
    || fail "$src is $actual_size bytes but $MANIFEST records $expected_size; update the vendor prebuild and manifest"
  actual_sha=$(sha256_of "$src")
  [ "$actual_sha" = "$expected_sha" ] \
    || fail "$src SHA-256 is $actual_sha but $MANIFEST records $expected_sha; update the vendor prebuild and manifest"

  if [ -f "$dst" ] && [ "$(sha256_of "$dst")" = "$expected_sha" ]; then
    echo "setup-android: $name is up to date at $dst"
    return 0
  fi
  if [ "$CHECK_ONLY" = 1 ]; then
    fail "$dst is missing or differs from $MANIFEST; rerun without --check to restore it"
  fi

  mkdir -p "$(dirname "$dst")"
  temporary="$dst.tmp.$$"
  if ! cp "$src" "$temporary"; then
    rm -f "$temporary"
    fail "cannot copy $src to $dst"
  fi
  if [ "$(sha256_of "$temporary")" != "$expected_sha" ]; then
    rm -f "$temporary"
    fail "the copied $name does not match $MANIFEST; $dst was not replaced"
  fi
  chmod 755 "$temporary"
  if ! mv -f "$temporary" "$dst"; then
    rm -f "$temporary"
    fail "cannot replace $dst"
  fi
  echo "setup-android: restored $name -> $dst"
}

resolve_require_builtin() {
  if require_json=$(cd "$REPO/apps/cli" && node -e "process.stdout.write(require.resolve('node-addon-require-builtin/package.json'))" 2>/dev/null) &&
    [ -n "$require_json" ]; then
    DSTFILE_REQUIRE="${require_json%/package.json}/build/napi/napi-v9-android-arm64/require_builtin.node"
    return 0
  fi
  echo "setup-android: could not resolve node-addon-require-builtin from apps/cli; falling back to the pinned 0.1.9 install" >&2
  PINNED_REQUIRE=$(find "$REPO/node_modules/.pnpm" -maxdepth 1 -type d -name 'node-addon-require-builtin@0.1.9*' | head -1)
  [ -n "$PINNED_REQUIRE" ] \
    || fail "node-addon-require-builtin not installed; run pnpm install first (resolution failed and the pinned fallback found no 0.1.9 install)"
  DSTFILE_REQUIRE=$PINNED_REQUIRE/node_modules/node-addon-require-builtin/build/napi/napi-v9-android-arm64/require_builtin.node
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --sharp=*)
      SHARP_POLICY=${1#--sharp=}
      case "$SHARP_POLICY" in
        check|build|skip) ;;
        *) usage >&2; fail "invalid --sharp policy: $SHARP_POLICY" ;;
      esac
      ;;
    --skip-sharp) SHARP_POLICY=skip ;;
    --restore-sharp) RESTORE_SHARP=1 ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
  shift
done

if [ "$RESTORE_SHARP" = 1 ]; then
  if [ "$SHARP_POLICY" != "check" ]; then
    fail "--restore-sharp cannot be combined with --sharp=$SHARP_POLICY"
  fi
  SHARP_POLICY=restore
fi
if [ "$CHECK_ONLY" = 1 ]; then
  case "$SHARP_POLICY" in
    build|restore) fail "--check cannot be combined with --sharp=$SHARP_POLICY" ;;
  esac
fi

command -v node >/dev/null 2>&1 || fail "node is missing: pkg install nodejs-lts"
[ "$(node -p 'process.platform')" = "android" ] \
  || fail "this script targets Termux/Android"
[ -f "$MANIFEST" ] || fail "missing $MANIFEST; update the vendor Android prebuilts"
if [ "$CHECK_ONLY" = 0 ] && [ "$SHARP_POLICY" = "build" ]; then
  check_build_tools
fi
if [ "$CHECK_ONLY" = 1 ]; then
  echo "setup-android: check only; no files will be written"
fi

echo "setup-android: [1/4] require-builtin"
resolve_require_builtin
restore_addon require_builtin.node "$DSTFILE_REQUIRE"

echo "setup-android: [2/4] flock"
# The published Android platform package is the loader's first candidate; the
# entry copy remains for source-only builds.
if [ -d "$REPO/native/system/packages/android-arm64" ]; then
  restore_addon system.node "$REPO/native/system/packages/android-arm64/bin/bionic/system.node"
fi
restore_addon system.node "$REPO/native/system/packages/entry/bin/bionic/system.node"

echo "setup-android: [3/4] ripgrep"
sh "$HERE/setup-android-rg.sh" --verify

echo "setup-android: [4/4] sharp ($SHARP_POLICY)"
case "$SHARP_POLICY" in
  skip) echo "setup-android: sharp skipped (--sharp=skip)" ;;
  check) sh "$HERE/setup-android-sharp.sh" --check ;;
  restore) sh "$HERE/setup-android-sharp.sh" --restore ;;
  build) sh "$HERE/setup-android-sharp.sh" --build ;;
esac

if [ "$CHECK_ONLY" = 1 ]; then
  echo "setup-android: verified the Android addons"
else
  echo "setup-android: the Android addons are restored"
fi
