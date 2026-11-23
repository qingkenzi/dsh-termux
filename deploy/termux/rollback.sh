#!/bin/sh
# Reverse the last `cutover.sh` swap: put the previous checkout back on the live
# path, restart the watchdog, and verify the restarted server.
#
# Contract:
#   * The preflight stops nothing and checks that the previous checkout exists,
#     that it can serve (installed dependencies, CLI version), that the parking
#     path for the replaced checkout is free, and that this shell is not the dsh
#     tmux session; `--check` runs the preflight only and exits.
#   * The swap is `FROM -> FAILED` and `ASIDE -> FROM`. Both files of every git
#     worktree link that spans a moved directory are rewritten, because a gitfile
#     and its admin `gitdir` file each name the other side by absolute path.
#   * The replaced checkout stays at CUTOVER_FAILED for inspection; nothing is
#     deleted, and deploying it again means moving it back to CUTOVER_TO.
#   * Success means the restarted server published a login URL, that URL
#     answered 200 or 303, the serving process runs from FROM, and that checkout
#     reports the expected version and branch.
#
# Usage: ./rollback.sh [--check]
#
# Environment (default in brackets; an empty ROLLBACK_EXPECT disables the check,
# an unset one means "the version the previous checkout declares"):
#   DSH_TERMUX_BASE   [$HOME/dsh] launcher, checkouts, and .logs directory
#   CUTOVER_FROM      [$DSH_TERMUX_BASE/deepseek-harness] live checkout
#   CUTOVER_ASIDE     [$DSH_TERMUX_BASE/previous] previous checkout to restore
#   CUTOVER_FAILED    [$DSH_TERMUX_BASE/failed] where the replaced checkout lands
#   ROLLBACK_EXPECT   [ASIDE package.json version] version the restored CLI reports
#   ROLLBACK_BRANCH   [ASIDE branch] branch the restored checkout must report
#   DSH_HOME          [$HOME/.dsh] the watchdog lock lives in $DSH_HOME/run
set -u
BASE=${DSH_TERMUX_BASE:-$HOME/dsh}
FROM=${CUTOVER_FROM:-$BASE/deepseek-harness}
TO=${CUTOVER_TO:-$BASE/next}
ASIDE=${CUTOVER_ASIDE:-$BASE/previous}
FAILED=${CUTOVER_FAILED:-$BASE/failed}
PORT=3080
LOG="$BASE/.logs/dsh-web.log"
RUN=${DSH_HOME:-$HOME/.dsh}/run
# The watchdog this script restarts reads the same two variables; export the
# values resolved here so both cannot disagree about the deployment directory.
export DSH_TERMUX_BASE=$BASE
export DSH_HOME=${DSH_HOME:-$HOME/.dsh}
PHASE=pre
DONE=0
EXPECT=
BRANCH=
CLI_VER=
CUR_VER=
CUR_BRANCH=

say() { printf '%s\n' "$*"; }
fail() { printf 'rollback: %s\n' "$*" >&2; exit 1; }

# HTTP status the local server returns, or 000 when nothing answers.
port_code() {
  curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT/" 2>/dev/null || true
}

# Current byte size of the server log. The smoke test accepts only URLs written
# after this offset, so a URL left by the previous server cannot pass it.
log_size() {
  size=$(wc -c <"$LOG" 2>/dev/null | tr -d ' ')
  case "${size:-}" in ''|*[!0-9]*) printf '0\n' ;; *) printf '%s\n' "$size" ;; esac
}

# Version declared by a checkout's package.json, or nothing.
package_version() {
  node -p "require(process.argv[1]).version" "$1/package.json" 2>/dev/null || true
}

# Version the source CLI of a checkout reports, or nothing. Requires that
# checkout's installed dependencies, which the preflight demands anyway.
cli_version() {
  ( cd "$1" 2>/dev/null && node --import tsx/esm apps/cli/src/bin.ts --version 2>/dev/null | tail -1 )
}

# Admin directory named by a worktree's .git file, or nothing for a checkout
# that holds a .git directory (a main repository).
worktree_admin() {
  [ -f "$1/.git" ] || return 0
  sed -n 's/^gitdir: //p' "$1/.git" 2>/dev/null | head -1 | tr -d '\r'
}

# Rewrite a path recorded before the swap: `<old-a>/...` becomes `<new-a>/...`
# and `<old-b>/...` becomes `<new-b>/...`. A gitfile and its admin `gitdir` file
# each name the other side by absolute path, so moving either side invalidates
# both records.
translate_path() {
  translate_source=$1
  case "$translate_source" in
    "$2"/*) printf '%s/%s\n' "$3" "${translate_source#"$2"/}" ;;
    "$4"/*) printf '%s/%s\n' "$5" "${translate_source#"$4"/}" ;;
    *) printf '%s\n' "$translate_source" ;;
  esac
}

# Point one worktree and its admin directory at each other again. Both files
# are written because either side may name a directory the swap moved.
link_worktree() {
  link_path=$1
  link_admin=$2
  [ -n "$link_admin" ] || return 0
  if [ ! -d "$link_admin" ]; then
    say "warning: no git worktree entry at $link_admin; git in $link_path may fail"
    return 0
  fi
  printf '%s\n' "$link_path/.git" >"$link_admin/gitdir" \
    || say "warning: cannot write $link_admin/gitdir"
  printf 'gitdir: %s\n' "$link_admin" >"$link_path/.git" \
    || say "warning: cannot write $link_path/.git"
}

# Re-point the other worktrees of a main repository at their admin directories.
# Their own paths did not move, but the admin path did when the main repository
# did, and every gitfile names that admin path.
repair_other_worktrees() {
  repair_main=$1
  for admin in "$repair_main"/.git/worktrees/*; do
    [ -d "$admin" ] || continue
    gitfile=$(head -n 1 "$admin/gitdir" 2>/dev/null | tr -d '\r')
    [ -n "${gitfile:-}" ] || continue
    [ -f "$gitfile" ] || continue
    printf 'gitdir: %s\n' "$admin" >"$gitfile" || say "warning: cannot repair $gitfile"
  done
}

wait_port_free() {
  tries=0
  while [ "$tries" -lt 30 ]; do
    [ "$(port_code)" = "000" ] && return 0
    tries=$((tries + 1))
    sleep 1
  done
  return 1
}

# Stop the watchdog and the server. The lock is removed only after the watchdog
# exited: it deletes its own lock during cleanup, and a lock removed under a
# still-running watchdog would let a second instance start.
kill_server() {
  tmux kill-session -t dsh 2>/dev/null || true
  pkill -f 'apps/cli/src/bin.ts web' 2>/dev/null || true
  tries=0
  while pgrep -f 'keep-alive[.]sh' >/dev/null 2>&1 && [ "$tries" -lt 20 ]; do
    tries=$((tries + 1))
    sleep 1
  done
  wait_port_free || return 1
  rm -rf "$RUN/watchdog.lock" 2>/dev/null || true
  return 0
}

start_service() {
  tmux new-session -d -s dsh -n watchdog "cd '$BASE' && ./keep-alive.sh"
}

# Login URL the watchdog published after log offset $1, or nothing after 60s.
wait_url() {
  wait_url_offset=$1
  tries=0
  while [ "$tries" -lt 60 ]; do
    url=$(tail -c +"$((wait_url_offset + 1))" "$LOG" 2>/dev/null \
      | grep -o "http://127\.0\.0\.1:$PORT/?token=[A-Za-z0-9_-]*" | tail -1)
    if [ -n "${url:-}" ]; then printf '%s' "$url"; return 0; fi
    tries=$((tries + 1))
    sleep 1
  done
  return 1
}

# Termux names the Node main thread `node-MainThread`, so match the prefix. A
# shell whose command line happens to contain the server pattern must not count
# as the server.
is_node() {
  is_node_comm=$(cat "/proc/$1/comm" 2>/dev/null) || return 1
  case "$is_node_comm" in
    node|node-*) return 0 ;;
    *) return 1 ;;
  esac
}

# Verify the restarted server: it must publish a login URL, answer it, run from
# the live path, and report the expected version and branch.
smoke() {
  smoke_want=$1
  smoke_offset=$2
  smoke_branch=$3
  [ -n "$smoke_want" ] || { say 'smoke failed: no expected version to compare against'; return 1; }
  url=$(wait_url "$smoke_offset") || { say "smoke failed: no login URL within 60s (see $LOG)"; return 1; }
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$url" 2>/dev/null || true)
  case "$code" in
    200|303) ;;
    *) say "smoke failed: login URL answered ${code:-none}"; return 1 ;;
  esac
  pid=
  for candidate in $(pgrep -f 'apps/cli/src/bin.ts web' 2>/dev/null || true); do
    is_node "$candidate" || continue
    if [ "$(readlink "/proc/$candidate/cwd" 2>/dev/null || true)" = "$FROM" ]; then
      pid=$candidate
    fi
  done
  [ -n "$pid" ] || { say "smoke failed: no dsh web process running from $FROM"; return 1; }
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  [ "$cwd" = "$FROM" ] || { say "smoke failed: serving checkout is ${cwd:-unknown}, expected $FROM"; return 1; }
  actual=$(package_version "$FROM")
  [ "$actual" = "$smoke_want" ] \
    || { say "smoke failed: running version is ${actual:-unknown}, expected $smoke_want"; return 1; }
  actual_branch=$(git -C "$FROM" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  [ "$actual_branch" = "$smoke_branch" ] \
    || { say "smoke failed: git branch is ${actual_branch:-unknown}, expected ${smoke_branch:-unknown}"; return 1; }
  say "smoke ok: $smoke_want on $smoke_branch serving $PORT (pid $pid)"
  say "login URL: $url"
}

# Bring the service back after a failed rollback. Runs from the EXIT trap, so it
# must not exit on its own. A failed restore leaves the intended checkout in
# place; a failed park is undone so the deployment returns to its prior state.
recover() {
  case "$PHASE" in
    stopping|parked|restored) ;;
    *) return 0 ;;
  esac
  say 'rollback aborted; bringing the service back'
  kill_server || say "warning: port $PORT still busy; the recovery continues"
  recover_want=$CUR_VER
  recover_branch=$CUR_BRANCH
  case "$PHASE" in
    parked)
      # The replaced checkout left the live path but the previous one is not in
      # place yet, so moving the parked checkout back restores the prior state.
      if [ -e "$FROM" ]; then
        say "warning: $FROM already exists; leaving both checkouts in place"
      elif mv "$FAILED" "$FROM"; then
        say "recovered: the replaced checkout is back at $FROM"
      else
        say "warning: could not move $FAILED back to $FROM"
      fi
      ;;
    restored)
      recover_want=$EXPECT
      recover_branch=$BRANCH
      say "warning: $FROM holds the restored checkout but the rollback did not finish; see $LOG"
      ;;
  esac
  offset=$(log_size)
  start_service || { say 'warning: could not restart the watchdog'; return 0; }
  smoke "$recover_want" "$offset" "$recover_branch" \
    || say "warning: the restarted server did not pass its smoke test; see $LOG"
}

on_exit() {
  rc=$?
  trap - EXIT INT TERM
  if [ "$DONE" -ne 1 ] && [ "$PHASE" != pre ]; then
    say "rollback aborted (rc=$rc)"
    recover
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

case "${1:-}" in
  ''|--check) ;;
  *) fail "unknown argument $1 (usage: rollback.sh [--check])" ;;
esac

for tool in tmux curl pgrep pkill node git; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required command: $tool"
done
cd "$BASE" 2>/dev/null || fail "missing deployment directory $BASE (set DSH_TERMUX_BASE)"

# --- preflight: nothing is stopped until every check passes -------------------
[ -e "$FROM/.git" ] || fail "missing live checkout $FROM"
[ -e "$ASIDE/.git" ] || fail "no previous checkout at $ASIDE; nothing to roll back to"
[ -f "$BASE/keep-alive.sh" ] || fail "missing $BASE/keep-alive.sh, the watchdog this script restarts"
if [ -e "$FAILED" ]; then
  fail "$FAILED already exists; move it away before rolling back (it holds the checkout this run would replace)"
fi
[ -f "$ASIDE/node_modules/.bin/tsx" ] \
  || fail "$ASIDE has no installed dependencies (missing node_modules/.bin/tsx); it cannot serve"

case "${ROLLBACK_EXPECT+set}" in
  set) EXPECT=$ROLLBACK_EXPECT ;;
  *) EXPECT=$(package_version "$ASIDE")
     [ -n "$EXPECT" ] || fail "cannot read the version of $ASIDE/package.json; set ROLLBACK_EXPECT" ;;
esac
if [ -n "$EXPECT" ]; then
  CLI_VER=$(cli_version "$ASIDE")
  [ "$CLI_VER" = "$EXPECT" ] || fail "$ASIDE CLI reports ${CLI_VER:-nothing}, expected $EXPECT"
else
  say 'preflight: restored version check disabled (ROLLBACK_EXPECT is empty)'
fi

case "${ROLLBACK_BRANCH+set}" in
  set) BRANCH=$ROLLBACK_BRANCH ;;
  *) BRANCH=$(git -C "$ASIDE" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
     [ -n "$BRANCH" ] || fail "cannot read the git branch of $ASIDE; set ROLLBACK_BRANCH" ;;
esac

CUR_VER=$(package_version "$FROM")
CUR_BRANCH=$(git -C "$FROM" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
[ -n "$CUR_VER" ] || fail "cannot read the version of $FROM/package.json"

if [ -n "${TMUX:-}" ]; then
  tmux_session=$(tmux display-message -p '#S' 2>/dev/null || true)
  if [ "$tmux_session" = dsh ]; then
    fail 'run this from a plain Termux shell, not inside the dsh tmux session'
  fi
fi

say "preflight: live $FROM ($CUR_VER on ${CUR_BRANCH:-unknown}) -> $FAILED"
say "preflight: restore $ASIDE (${EXPECT:-unknown} on ${BRANCH:-unknown}) -> $FROM"
say "preflight ok: $CUR_VER -> ${EXPECT:-unknown}, replaced checkout lands at $FAILED"

if [ "${1:-}" = "--check" ]; then
  DONE=1
  say 'preflight only: nothing was stopped'
  exit 0
fi

# --- swap --------------------------------------------------------------------
say 'stopping watchdog and server'
PHASE=stopping
kill_server || fail "port $PORT still answering; stop the server manually and rerun"
offset=$(log_size)

# Read both links before the move: each side names the other by absolute path,
# and after the swap only the translation below can find the new location.
live_admin=$(worktree_admin "$FROM")
aside_admin=$(worktree_admin "$ASIDE")
PHASE=parked
mv "$FROM" "$FAILED" || fail "could not move $FROM to $FAILED"
mv "$ASIDE" "$FROM" || fail "could not move $ASIDE to $FROM"
PHASE=restored
say "restored: $FROM (previous), $FAILED (replaced)"

say 'repairing git worktree links'
link_worktree "$FROM" "$(translate_path "$aside_admin" "$ASIDE" "$FROM" "$FROM" "$FAILED")"
link_worktree "$FAILED" "$(translate_path "$live_admin" "$ASIDE" "$FROM" "$FROM" "$FAILED")"
repair_other_worktrees "$FROM"
repair_other_worktrees "$FAILED"
git -C "$FROM" rev-parse --abbrev-ref HEAD >/dev/null 2>&1 \
  || say "warning: $FROM is not a usable git worktree"

say 'starting watchdog'
start_service || fail 'could not start the watchdog'
want=$EXPECT
[ -n "$want" ] || want=$(package_version "$FROM")
smoke "$want" "$offset" "$BRANCH" || fail "the restored server did not pass its smoke test"

DONE=1
say "rollback done: $FROM runs $want on ${BRANCH:-unknown}; the replaced checkout is at $FAILED"
say "to deploy the replaced checkout again, move it back to $TO and run: $BASE/cutover.sh"
