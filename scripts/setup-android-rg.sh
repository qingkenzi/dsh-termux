#!/bin/sh
# Verify or rebuild the vendored Android ripgrep binary.
#
# `vendor/android-prebuilds/rg` is committed because the npm platform package
# has no Android bionic build. Verification is read-only and checks the pinned
# SHA-256 and size, the reported version, ELF LOAD alignment for 16 KB-page
# devices, and the 6 MiB payload ceiling. Rebuilding uses the version pinned in
# `rg.manifest.json`, keeps the previous binary until the replacement has been
# verified, and rewrites the manifest and the combined addons manifest.
#
# Usage:
#   sh scripts/setup-android-rg.sh --verify    # verify the committed binary
#   sh scripts/setup-android-rg.sh --rebuild   # cargo install, strip, verify, install
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO="$HERE/.."
VENDOR="$REPO/vendor/android-prebuilds"
RG="$VENDOR/rg"
MANIFEST="$VENDOR/rg.manifest.json"
COMBINED_MANIFEST="$VENDOR/addons.manifest.json"
CACHE_DIR="${DSH_ANDROID_RG_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/dsh-android-rg}"
MAX_SIZE=6291456
MIN_ALIGN=16384
PAGE_ALIGN_TEXT='0x4000'

fail() {
  echo "setup-android-rg: $*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: sh scripts/setup-android-rg.sh --verify|--rebuild

  --verify   Check the vendored ripgrep hash, size, version, and ELF alignment.
  --rebuild  Rebuild ripgrep from the version pinned in rg.manifest.json.
EOF
}

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    node -e 'const {createHash}=require("node:crypto");const fs=require("node:fs");process.stdout.write(createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"
  fi
}

manifest_value() {
  node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const v=m[process.argv[2]];if(v===undefined)process.exit(2);process.stdout.write(String(v))' \
    "$MANIFEST" "$1" 2>/dev/null \
    || fail "cannot read '$1' from $MANIFEST; run: sh scripts/setup-android-rg.sh --rebuild"
}

combined_sha() {
  node -e 'const fs=require("node:fs");const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(m.files.rg.sha256)' \
    "$COMBINED_MANIFEST" 2>/dev/null \
    || fail "cannot read the rg SHA-256 from $COMBINED_MANIFEST; run --rebuild"
}

verify_elf() {
  file=$1
  command -v readelf >/dev/null 2>&1 \
    || fail "readelf is missing: pkg install binutils, then run: sh scripts/setup-android-rg.sh --rebuild"
  aligns=$(readelf -lW "$file" | awk '$1 == "LOAD" { print $NF }')
  [ -n "$aligns" ] || fail "$file has no ELF LOAD segments; run: sh scripts/setup-android-rg.sh --rebuild"
  for align in $aligns; do
    case "$align" in
      0x*|[0-9]*) ;;
      *) fail "$file has an unparseable LOAD alignment: $align; run: sh scripts/setup-android-rg.sh --rebuild" ;;
    esac
    value=$((align))
    [ "$value" -ge "$MIN_ALIGN" ] \
      || fail "$file has ELF LOAD alignment $align, below $PAGE_ALIGN_TEXT; run: sh scripts/setup-android-rg.sh --rebuild with a 16 KB-page compatible toolchain"
  done
}

verify() {
  [ -f "$RG" ] || fail "missing $RG; run: sh scripts/setup-android-rg.sh --rebuild"
  [ -x "$RG" ] || fail "$RG is not executable; run: sh scripts/setup-android-rg.sh --rebuild"
  [ -f "$MANIFEST" ] || fail "missing $MANIFEST; run: sh scripts/setup-android-rg.sh --rebuild"

  version=$(manifest_value version)
  expected_sha=$(manifest_value sha256)
  expected_size=$(manifest_value size)

  actual_sha=$(sha256_of "$RG")
  [ "$actual_sha" = "$expected_sha" ] \
    || fail "$RG SHA-256 is $actual_sha but $MANIFEST records $expected_sha; run: sh scripts/setup-android-rg.sh --rebuild"

  actual_size=$(wc -c < "$RG" | tr -d ' ')
  [ "$actual_size" = "$expected_size" ] \
    || fail "$RG is $actual_size bytes but $MANIFEST records $expected_size; run: sh scripts/setup-android-rg.sh --rebuild"
  [ "$actual_size" -le "$MAX_SIZE" ] \
    || fail "$RG is $actual_size bytes, above the $MAX_SIZE-byte ceiling; run: sh scripts/setup-android-rg.sh --rebuild"

  if [ -f "$COMBINED_MANIFEST" ]; then
    pinned=$(combined_sha)
    [ "$pinned" = "$expected_sha" ] \
      || fail "$COMBINED_MANIFEST pins rg as $pinned but $MANIFEST records $expected_sha; run: sh scripts/setup-android-rg.sh --rebuild"
  else
    fail "missing $COMBINED_MANIFEST; run: sh scripts/setup-android-rg.sh --rebuild"
  fi

  version_output=$("$RG" --version 2>&1) \
    || fail "$RG cannot run; run: sh scripts/setup-android-rg.sh --rebuild"
  version_line=$(printf '%s\n' "$version_output" | sed -n '1p')
  case "$version_line" in
    "ripgrep $version"*) ;;
    *) fail "$RG reports '$version_line', expected ripgrep $version; run: sh scripts/setup-android-rg.sh --rebuild" ;;
  esac
  verify_elf "$RG"

  echo "setup-android-rg: verified $RG (ripgrep $version, $actual_size bytes, sha256 $actual_sha)"
}

rebuild() {
  [ -f "$MANIFEST" ] || fail "missing $MANIFEST; cannot determine the ripgrep version"
  command -v cargo >/dev/null 2>&1 || fail "cargo is missing: pkg install rust"
  command -v strip >/dev/null 2>&1 || fail "strip is missing: pkg install binutils"
  command -v readelf >/dev/null 2>&1 \
    || fail "readelf is missing: pkg install binutils, then run: sh scripts/setup-android-rg.sh --rebuild"

  version=$(manifest_value version)
  build_root="$CACHE_DIR/rg-$version"
  mkdir -p "$CACHE_DIR"
  if [ ! -x "$build_root/bin/rg" ]; then
    echo "setup-android-rg: cargo install ripgrep --version $version --locked --root $build_root"
    if ! cargo install ripgrep --version "$version" --locked --root "$build_root"; then
      fail "cargo install failed (network, registry, or toolchain); $RG was left untouched. Retry with network access or set DSH_ANDROID_RG_CACHE to a populated cache."
    fi
  fi

  temporary="$VENDOR/rg.new.$$"
  trap 'rm -f "$temporary"' EXIT INT TERM
  cp "$build_root/bin/rg" "$temporary" || fail "cannot copy $build_root/bin/rg"
  strip --strip-all "$temporary" || fail "strip failed; $RG was left untouched"
  chmod 755 "$temporary"
  "$temporary" --version >/dev/null 2>&1 || fail "the rebuilt ripgrep cannot run on this host; $RG was left untouched"
  verify_elf "$temporary"

  new_sha=$(sha256_of "$temporary")
  new_size=$(wc -c < "$temporary" | tr -d ' ')
  [ "$new_size" -le "$MAX_SIZE" ] || fail "the rebuilt ripgrep is $new_size bytes, above the $MAX_SIZE-byte ceiling; $RG was left untouched"
  build_date=$(date -u +%Y-%m-%d)
  mv -f "$temporary" "$RG"
  trap - EXIT INT TERM

  node -e '
    const fs = require("node:fs")
    const [file, version, size, sha256, date, root] = process.argv.slice(1)
    const previous = JSON.parse(fs.readFileSync(file, "utf8"))
    const manifest = {
      tool: "ripgrep",
      version,
      target: "aarch64-linux-android",
      path: "rg",
      size: Number(size),
      sha256,
      source: `https://github.com/BurntSushi/ripgrep/releases/tag/${version}`,
      build: {
        ...previous.build,
        command: `cargo install ripgrep --version ${version} --locked --root ${root}`,
        date,
        postProcess: "strip --strip-all",
        pageSizeCompatibility: "ELF LOAD p_align 0x4000",
      },
    }
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
  ' "$MANIFEST" "$version" "$new_size" "$new_sha" "$build_date" "$build_root" \
    || fail "cannot rewrite $MANIFEST"
  node "$REPO/scripts/android-addons-manifest.mjs" \
    || fail "cannot rewrite $COMBINED_MANIFEST"

  echo "setup-android-rg: rebuilt $RG (ripgrep $version, $new_size bytes, sha256 $new_sha)"
  verify
}

MODE=
while [ $# -gt 0 ]; do
  case "$1" in
    --verify) MODE=verify ;;
    --rebuild) MODE=rebuild ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; fail "unknown option: $1" ;;
  esac
  shift
done

case "$MODE" in
  verify) verify ;;
  rebuild) rebuild ;;
  *) usage >&2; fail "choose --verify or --rebuild" ;;
esac
