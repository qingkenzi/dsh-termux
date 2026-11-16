#!/bin/sh
# Applies the Termux/Android platform fixes to the DeepSeekRuntime source.
# Idempotent: safe to run multiple times. Re-run `pnpm run build` afterwards.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO="$HERE/.."
PO="$REPO/packages/util/native-command/src/path-opener.ts"

if grep -q 'effectivePlatform' "$PO" 2>/dev/null; then
  echo "Android path-opener fix already applied."
  exit 0
fi

python3 - "$PO" <<'PY'
import sys
p = sys.argv[1]
s = open(p).read()

s = s.replace(
    "  const wsl = platform === 'linux' && isWsl(internals)",
    "  // Termux reports `android`; its xdg-open is a symlink to termux-open, which\n"
    "  // hands the path to Android's own viewer, so it shares Linux's open path.\n"
    "  const effectivePlatform = platform === 'android' ? 'linux' : platform\n"
    "  const wsl = effectivePlatform === 'linux' && isWsl(internals)",
    1,
)
s = s.replace(
    "  if (platform === 'linux') {\n"
    "    if (wsl) {\n"
    "      await openWslPath(path, signal, run)\n"
    "      return\n"
    "    }\n"
    "    await run('xdg-open', [path], signal, 'hidden')\n"
    "    return\n"
    "  }\n"
    "\n"
    "  throw new Error(`native path opener is unsupported on ${platform}`)",
    "  if (effectivePlatform === 'linux') {\n"
    "    if (wsl) {\n"
    "      await openWslPath(path, signal, run)\n"
    "      return\n"
    "    }\n"
    "    await run('xdg-open', [path], signal, 'hidden')\n"
    "    return\n"
    "  }\n"
    "\n"
    "  throw new Error(`native path opener is unsupported on ${platform}`)",
    1,
)
s = s.replace(
    "  if (platform === 'darwin' || platform === 'win32') return true\n"
    "  if (platform !== 'linux') return false",
    "  if (platform === 'darwin' || platform === 'win32') return true\n"
    "  // Termux/Android reaches Android's viewer through its xdg-open (termux-open).\n"
    "  if (platform === 'android') return true\n"
    "  if (platform !== 'linux') return false",
    1,
)
open(p, 'w').write(s)
print("Applied Android path-opener fix to", p)
PY

echo "Done. Now run: cd $REPO && pnpm run build"
