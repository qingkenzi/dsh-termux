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
#
# `run` takes one command string that the remote login shell evaluates; the
# caller owns the inner quoting, so pass the command as a single quoted
# argument. Extra arguments are joined with spaces rather than dropped.
set -euo pipefail

device=${DSH_ANDROID_DEVICE:?set DSH_ANDROID_DEVICE to the Termux SSH destination}
remote_root=${DSH_ANDROID_ROOT:-/data/data/com.termux/files/home/dsh-ci}

die() {
  echo "android-device.sh: $*" >&2
  exit 2
}

# The remote root becomes part of remote shell commands. Require an absolute
# path without single quotes or newlines so it can be single-quoted verbatim.
case "$remote_root" in
  '') die 'DSH_ANDROID_ROOT must not be empty' ;;
  /*) ;;
  *) die "DSH_ANDROID_ROOT must be an absolute path: $remote_root" ;;
esac
newline='
'
case "$remote_root" in
  *"'"*|*"$newline"*|*"$(printf '\r')"*) die "DSH_ANDROID_ROOT must not contain single quotes or newlines: $remote_root" ;;
esac

# The validation above leaves no character that can escape single quotes.
remote_quote() {
  printf "'%s'" "$1"
}

# BatchMode fails instead of prompting on the runner; ConnectTimeout bounds a
# dead device. Every remote invocation uses both.
remote_ssh() {
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$device" "$@"
}

remote_ssh_tty() {
  ssh -t -o BatchMode=yes -o ConnectTimeout=10 "$device" "$@"
}

require_remote_root() {
  if ! remote_ssh "test -d $(remote_quote "$remote_root")"; then
    die "remote root $remote_root does not exist; run 'scripts/ci/android-device.sh sync' first"
  fi
}

case "${1:-}" in
  sync)
    local_root=$(cd "$(dirname "$0")/../.." && pwd)
    remote_ssh "mkdir -p $(remote_quote "$remote_root")"
    rsync -az --delete \
      -e 'ssh -o BatchMode=yes -o ConnectTimeout=10' \
      --exclude '.git' \
      --exclude 'node_modules' \
      --exclude '.selfcheck' \
      --exclude 'apps/web/dist' \
      "$local_root/" "$device:$remote_root/"
    ;;
  run)
    shift
    [ "$#" -gt 0 ] || die 'run needs one command string'
    command_string=$*
    [ -n "$command_string" ] || die 'run needs a non-empty command string'
    require_remote_root
    remote_ssh "cd $(remote_quote "$remote_root") && $command_string"
    ;;
  shell)
    require_remote_root
    remote_ssh_tty "cd $(remote_quote "$remote_root") && exec \"\${SHELL:-sh}\""
    ;;
  *)
    echo "usage: scripts/ci/android-device.sh sync|run <command>|shell" >&2
    exit 2
    ;;
esac
