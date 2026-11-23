#!/bin/sh
# Swap a prepared checkout into the live Termux deployment and restart it.
#
# Contract:
#   * The preflight stops nothing. It validates both checkouts, the versions
#     they report, the expected branch, and that this shell is not the dsh tmux
#     session; `--check` runs the preflight only and exits.
#   * Once the watchdog is stopped the service is down until the swap completes
#     or the automatic rollback restores the previous checkout. A failure after
#     that point costs a full stop and restart of the old version, so every
#     cheap check belongs in the preflight.
#   * The swap is `FROM -> ASIDE` and `TO -> FROM`. Both files of every git
#     worktree link that spans a moved directory are rewritten: `git worktree
#     repair` cannot follow a moved main repository because it resolves the
#     recorded admin path before it can repair anything.
#   * Success means the restarted server published a login URL, that URL
#     answered 200 or 303, the serving process runs from FROM, and that checkout
#     reports the expected version and branch.
#
# Usage: ./cutover.sh [--check]
#
# Environment (default in brackets; an empty CUTOVER_EXPECT_* disables that
# check, an unset one means "the version that checkout declares"):
#   DSH_TERMUX_BASE      [$HOME/dsh] launcher, checkouts, and .logs directory
#   CUTOVER_FROM         [$DSH_TERMUX_BASE/deepseek-harness] live checkout
#   CUTOVER_TO           [$DSH_TERMUX_BASE/next] prepared checkout to deploy
#   CUTOVER_ASIDE        [$DSH_TERMUX_BASE/previous] where FROM lands
#   CUTOVER_FAILED       [$DSH_TERMUX_BASE/failed] where a failed TO lands on rollback
#   CUTOVER_EXPECT_FROM  [FROM package.json version] version the live checkout reports
#   CUTOVER_EXPECT_TO    [TO package.json version] version the prepared CLI reports
#   CUTOVER_BRANCH       [android/latest] branch the live checkout must report
#   DSH_HOME             [$HOME/.dsh] the watchdog lock lives in $DSH_HOME/run
set -u
BASE=${DSH_TERMUX_BASE:-$HOME/dsh}
FROM=${CUTOVER_FROM:-$BASE/deepseek-harness}
TO=${CUTOVER_TO:-$BASE/next}
ASIDE=${CUTOVER_ASIDE:-$BASE/previous}
FAILED=${CUTOVER_FAILED:-$BASE/failed}
BRANCH=${CUTOVER_BRANCH:-android/latest}
PORT=3080
LOG="$BASE/.logs/dsh-web.log"
RUN=${DSH_HOME:-$HOME/.dsh}/run
# The watchdog this script restarts reads the same two variables; export the
# values resolved here so both cannot disagree about the deployment directory.
export DSH_TERMUX_BASE=$BASE
export DSH_HOME=${DSH_HOME:-$HOME/.dsh}
PHASE=pre
DONE=0
EXPECT_FROM=
EXPECT_TO=
LIVE_VER=
LIVE_BRANCH=
CLI_VER=
TO_BRANCH=

say() { printf '%s\n' "$*"; }
fail() { printf 'cutover: %s\n' "$*" >&2; exit 1; }

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

# Undo the swap after the service stopped. Runs from the EXIT trap, so it must
# not exit on its own: every step it cannot complete is reported and the rest of
# the recovery still runs.
rollback() {
  case "$PHASE" in
    stopping|half|swapped) ;;
    *) return 0 ;;
  esac
  say "rolling back to ${LIVE_VER:-the previous checkout}"
  kill_server || say "warning: port $PORT still busy; the rollback continues"
  case "$PHASE" in
    half)
      # Only FROM moved, so moving it back restores the exact paths the git
      # links name and no repair is needed.
      if [ -d "$ASIDE" ] && [ ! -e "$FROM" ]; then
        mv "$ASIDE" "$FROM" || say "warning: could not move $ASIDE back to $FROM"
      fi
      ;;
    swapped)
      # The failed checkout has to leave the live path before the previous one
      # can take it. Without a free parking path the swap cannot be undone
      # automatically; the operator has to move $FAILED away first.
      if [ ! -e "$FROM" ]; then
        say "warning: $FROM is missing; nothing to park"
      elif [ -e "$FAILED" ]; then
        say "warning: $FAILED already exists; the failed checkout stays at $FROM"
      else
        # Both links are read before either directory moves.
        failed_admin=$(worktree_admin "$FROM")
        aside_admin=$(worktree_admin "$ASIDE")
        if ! mv "$FROM" "$FAILED"; then
          say "warning: could not move the failed checkout to $FAILED"
          failed_admin=
          aside_admin=
        elif ! mv "$ASIDE" "$FROM"; then
          say "warning: could not move $ASIDE back to $FROM; the failed checkout is at $FAILED"
        else
          link_worktree "$FROM" "$(translate_path "$aside_admin" "$ASIDE" "$FROM" "$FROM" "$FAILED")"
          link_worktree "$FAILED" "$(translate_path "$failed_admin" "$ASIDE" "$FROM" "$FROM" "$FAILED")"
          repair_other_worktrees "$FROM"
          repair_other_worktrees "$FAILED"
          say "rolled back: the previous checkout is back at $FROM, the failed one at $FAILED"
        fi
      fi
      ;;
  esac
  offset=$(log_size)
  start_service || { say 'warning: could not restart the watchdog'; return 0; }
  smoke "$LIVE_VER" "$offset" "$LIVE_BRANCH" || say "rollback smoke failed; see $LOG"
}

on_exit() {
  rc=$?
  trap - EXIT INT TERM
  if [ "$DONE" -ne 1 ] && [ "$PHASE" != pre ]; then
    say "cutover aborted (rc=$rc)"
    rollback
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

case "${1:-}" in
  ''|--check) ;;
  *) fail "unknown argument $1 (usage: cutover.sh [--check])" ;;
esac

for tool in tmux curl pgrep pkill node git; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing required command: $tool"
done
cd "$BASE" 2>/dev/null || fail "missing deployment directory $BASE (set DSH_TERMUX_BASE)"

# --- preflight: nothing is stopped until every check passes -------------------
[ -e "$FROM/.git" ] || fail "missing live checkout $FROM"
[ -e "$TO/.git" ] || fail "missing prepared checkout $TO (build and install it first)"
[ -f "$BASE/keep-alive.sh" ] || fail "missing $BASE/keep-alive.sh, the watchdog this script restarts"
if [ -e "$ASIDE" ]; then
  fail "$ASIDE already exists; move it away (or run rollback.sh) before cutting over"
fi
[ -f "$TO/node_modules/.bin/tsx" ] \
  || fail "$TO has no installed dependencies (missing node_modules/.bin/tsx); install them there first"

case "${CUTOVER_EXPECT_FROM+set}" in
  set) EXPECT_FROM=$CUTOVER_EXPECT_FROM ;;
  *) EXPECT_FROM=$(package_version "$FROM")
     [ -n "$EXPECT_FROM" ] || fail "cannot read the version of $FROM/package.json; set CUTOVER_EXPECT_FROM" ;;
esac
LIVE_VER=$(package_version "$FROM")
LIVE_BRANCH=$(git -C "$FROM" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
[ -n "$LIVE_VER" ] || fail "cannot read the version of $FROM/package.json"
[ -n "$LIVE_BRANCH" ] || fail "$FROM is not a usable git checkout"
if [ -n "$EXPECT_FROM" ]; then
  [ "$LIVE_VER" = "$EXPECT_FROM" ] \
    || fail "live checkout reports $LIVE_VER, expected $EXPECT_FROM; is the switch already done?"
else
  say 'preflight: live version check disabled (CUTOVER_EXPECT_FROM is empty)'
fi

case "${CUTOVER_EXPECT_TO+set}" in
  set) EXPECT_TO=$CUTOVER_EXPECT_TO ;;
  *) EXPECT_TO=$(package_version "$TO")
     [ -n "$EXPECT_TO" ] || fail "cannot read the version of $TO/package.json; set CUTOVER_EXPECT_TO" ;;
esac
if [ -n "$EXPECT_TO" ]; then
  CLI_VER=$(cli_version "$TO")
  [ "$CLI_VER" = "$EXPECT_TO" ] || fail "$TO CLI reports ${CLI_VER:-nothing}, expected $EXPECT_TO"
else
  say 'preflight: new version check disabled (CUTOVER_EXPECT_TO is empty)'
fi

# The branch is checked here rather than only in the smoke test: failing it
# after the service stopped would cost a rollback restart.
TO_BRANCH=$(git -C "$TO" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
[ "$TO_BRANCH" = "$BRANCH" ] \
  || fail "$TO is on ${TO_BRANCH:-no branch}, expected $BRANCH; set CUTOVER_BRANCH to deploy it anyway"

if [ -n "${TMUX:-}" ]; then
  tmux_session=$(tmux display-message -p '#S' 2>/dev/null || true)
  if [ "$tmux_session" = dsh ]; then
    fail 'run this from a plain Termux shell, not inside the dsh tmux session'
  fi
fi

say "preflight: live $FROM ($LIVE_VER on ${LIVE_BRANCH:-unknown}) -> $ASIDE"
say "preflight: new  $TO (${EXPECT_TO:-unknown} on ${TO_BRANCH:-unknown}) -> $FROM"
say "preflight ok: $LIVE_VER -> ${EXPECT_TO:-unknown}, aside $ASIDE, failed $FAILED"

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
from_admin=$(worktree_admin "$FROM")
to_admin=$(worktree_admin "$TO")
PHASE=half
mv "$FROM" "$ASIDE" || fail "could not move $FROM to $ASIDE"
mv "$TO" "$FROM" || fail "could not move $TO to $FROM"
PHASE=swapped
say "swapped: $ASIDE (previous), $FROM (new)"

say 'repairing git worktree links'
link_worktree "$FROM" "$(translate_path "$to_admin" "$FROM" "$ASIDE" "$TO" "$FROM")"
link_worktree "$ASIDE" "$(translate_path "$from_admin" "$FROM" "$ASIDE" "$TO" "$FROM")"
repair_other_worktrees "$ASIDE"
repair_other_worktrees "$FROM"
git -C "$FROM" rev-parse --abbrev-ref HEAD >/dev/null 2>&1 \
  || say "warning: $FROM is not a usable git worktree"

say 'starting watchdog'
start_service || fail 'could not start the watchdog'
want=$EXPECT_TO
[ -n "$want" ] || want=$(package_version "$FROM")
smoke "$want" "$offset" "$BRANCH" || fail "the restarted server did not pass its smoke test"

DONE=1
say "cutover done: $FROM runs $want on $BRANCH; the previous checkout is at $ASIDE"
say "if the new build misbehaves, run: $BASE/rollback.sh"
