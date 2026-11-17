#!/usr/bin/env bash
# Drive an Android/Termux checkout from a self-hosted CI runner over SSH.
#
# The runner does not need to be Android itself; it needs `ssh` and `rsync`,
# and DSH_ANDROID_DEVICE set to an SSH destination whose login shell can run
# Termux commands. DSH_ANDROID_ROOT defaults to a dedicated directory below
# the Termux home so CI never edits a developer checkout.
#
# Usage:
#   scripts/ci/android-device.sh sync
#   scripts/ci/android-device.sh run 'pnpm install --frozen-lockfile'
#   scripts/ci/android-device.sh shell
set -euo pipefail

device=${DSH_ANDROID_DEVICE:?set DSH_ANDROID_DEVICE to the Termux SSH destination}
remote_root=${DSH_ANDROID_ROOT:-/data/data/com.termux/files/home/dsh-ci}

case "${1:-}" in
  sync)
    local_root=$(cd "$(dirname "$0")/../.." && pwd)
    ssh "$device" "mkdir -p '$remote_root'"
    rsync -az --delete \
      --exclude '.git' \
      --exclude 'node_modules' \
      --exclude '.selfcheck' \
      --exclude 'apps/web/dist' \
      "$local_root/" "$device:$remote_root/"
    ;;
  run)
    shift
    [ "$#" -gt 0 ] || { echo "android-device.sh run needs a command" >&2; exit 2; }
    command_string=$*
    ssh "$device" "cd '$remote_root' && $command_string"
    ;;
  shell)
    ssh -t "$device" "cd '$remote_root' && exec \"\${SHELL:-sh}\""
    ;;
  *)
    echo "usage: scripts/ci/android-device.sh sync|run <command>|shell" >&2
    exit 2
    ;;
esac
