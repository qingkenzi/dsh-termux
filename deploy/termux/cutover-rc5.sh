#!/bin/sh
# Switch the Termux deployment from the rc.3 checkout to the rc.5 checkout.
#
# The running `dsh web` process serves the session that prepared this switch,
# so the swap has to run from a terminal the agent does not own (or detached).
# This script checks the rc.5 build first, stops the watchdog and the server,
# swaps the two checkouts, repairs the git worktree links, starts the watchdog,
# and then verifies the restarted server: checkout, version, and login URL.
# Any failure after the service stops rolls the swap back and restarts rc.3.
#
# Usage: ~/dsh/cutover-rc5.sh [--check]
#   --check   run the preflight only and exit without stopping anything
set -u
BASE=${DSH_TERMUX_BASE:-$HOME/dsh}
OLD="$BASE/deepseek-harness"
NEW="$BASE/rc5"
ASIDE="$BASE/deepseek-harness-rc3"
FAILED="$BASE/rc5-failed"
PORT=3080
LOG="$BASE/.logs/dsh-web.log"
RUN=${DSH_HOME:-$HOME/.dsh}/run
EXPECT_NEW=0.2.2-rc.5
EXPECT_OLD=0.2.2-rc.3
PHASE=pre
DONE=0

say() { printf '%s\n' "$*"; }
fail() { printf 'cutover: %s\n' "$*" >&2; exit 1; }
cd "$BASE" 2>/dev/null || fail "missing $BASE"

port_code() {
  curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT/" 2>/dev/null || true
}

log_size() {
  size=$(wc -c <"$LOG" 2>/dev/null | tr -d ' ')
  printf '%s\n' "${size:-0}"
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

kill_server() {
  tmux kill-session -t dsh 2>/dev/null || true
  pkill -f 'apps/cli/src/bin.ts web' 2>/dev/null || true
  # A watchdog handling its own signal may run cleanup up to 15s later; wait it
  # out so it cannot remove the lock the replacement watchdog is about to own.
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
  tmux new-session -d -s dsh -n watchdog "cd $BASE && ./keep-alive.sh"
}

wait_url() {
  offset=$1
  tries=0
  while [ "$tries" -lt 60 ]; do
    url=$(tail -c +"$((offset + 1))" "$LOG" 2>/dev/null \
      | grep -o "http://127\.0\.0\.1:$PORT/?token=[A-Za-z0-9_-]*" | tail -1)
    if [ -n "${url:-}" ]; then printf '%s' "$url"; return 0; fi
    tries=$((tries + 1))
    sleep 1
  done
  return 1
}

# Re-point every linked worktree whose gitfile still names the old main repo.
# Needed because moving the main checkout breaks the `<worktree>/.git` files of
# its other worktrees; their own paths did not change.
repair_other_worktrees() {
  main=$1
  for admin in "$main"/.git/worktrees/*; do
    [ -d "$admin" ] || continue
    gitfile=$(head -n 1 "$admin/gitdir" 2>/dev/null | tr -d '\r')
    [ -n "${gitfile:-}" ] || continue
    [ -f "$gitfile" ] || continue
    printf 'gitdir: %s\n' "$admin" >"$gitfile" || say "warning: cannot repair $gitfile"
  done
}

# Verify the freshly restarted server: it must serve a login URL, answer it,
# run from the expected checkout, and report the expected package version.
smoke() {
  want=$1
  offset=$2
  branch=$3
  url=$(wait_url "$offset") || { say "smoke failed: no login URL within 60s (see $LOG)"; return 1; }
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$url" 2>/dev/null || true)
  case "$code" in
    200|303) ;;
    *) say "smoke failed: login URL answered ${code:-none}"; return 1 ;;
  esac
  pid=""
  for candidate in $(pgrep -f 'apps/cli/src/bin.ts web' 2>/dev/null || true); do
    if [ "$(readlink "/proc/$candidate/cwd" 2>/dev/null || true)" = "$OLD" ]; then
      pid=$candidate
    fi
  done
  [ -n "$pid" ] || { say "smoke failed: no dsh web process running from $OLD"; return 1; }
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  [ "$cwd" = "$OLD" ] || { say "smoke failed: running checkout is ${cwd:-unknown}, expected $OLD"; return 1; }
  actual=$(node -p "require('$OLD/package.json').version" 2>/dev/null || true)
  [ "$actual" = "$want" ] || { say "smoke failed: running version is ${actual:-unknown}, expected $want"; return 1; }
  actual_branch=$(git -C "$OLD" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  [ "$actual_branch" = "$branch" ] || { say "smoke failed: git branch is ${actual_branch:-unknown}, expected $branch"; return 1; }
  say "smoke ok: $want on $branch serving $PORT (pid $pid)"
  say "login URL: $url"
}

rollback() {
  case "$PHASE" in
    stopping|half|swapped) ;;
    *) return 0 ;;
  esac
  say 'rolling back to rc.3'
  kill_server || say "warning: port $PORT still busy; rollback continues"
  if [ "$PHASE" = "swapped" ]; then
    mv "$OLD" "$FAILED" 2>/dev/null || say "warning: could not move the failed rc.5 checkout aside"
  fi
  if [ "$PHASE" = "half" ] || [ "$PHASE" = "swapped" ]; then
    if [ -d "$ASIDE" ]; then
      mv "$ASIDE" "$OLD" 2>/dev/null || say "warning: could not restore $ASIDE"
    fi
  fi
  if [ "$PHASE" = "swapped" ] && [ -n "${WORKTREE_ID:-}" ]; then
    admin="$OLD/.git/worktrees/$WORKTREE_ID"
    if [ -d "$admin" ] && [ -f "$FAILED/.git" ]; then
      printf '%s\n' "$FAILED/.git" >"$admin/gitdir" || say "warning: could not repair $admin/gitdir"
      printf 'gitdir: %s\n' "$admin" >"$FAILED/.git" || say "warning: could not repair $FAILED/.git"
      repair_other_worktrees "$OLD"
    fi
  fi
  offset=$(log_size)
  start_service || { say "warning: could not restart the watchdog"; return 0; }
  smoke "$EXPECT_OLD" "$offset" android/align-official-rc3 || say "rollback smoke failed; see $LOG"
}

on_exit() {
  rc=$?
  trap - EXIT INT TERM
  if [ "$DONE" -ne 1 ] && [ "$PHASE" != "pre" ]; then
    say "cutover aborted (rc=$rc)"
    rollback
  fi
  exit "$rc"
}
trap on_exit EXIT
trap 'exit 130' INT TERM

# --- preflight: nothing is stopped until every check passes -------------------
if [ "${1:-}" = "--check" ]; then
  say 'preflight only'
fi

[ -e "$OLD/.git" ] || fail "missing checkout $OLD"
[ -e "$NEW/.git" ] || fail "missing new checkout $NEW (build rc.5 first)"
[ -d "$ASIDE" ] && fail "$ASIDE already exists; run rollback-rc3.sh first or move it away"
[ -f "$NEW/node_modules/.bin/tsx" ] || fail "$NEW has no installed dependencies"
old_ver=$(node -p "require('$OLD/package.json').version" 2>/dev/null || true)
[ "$old_ver" = "$EXPECT_OLD" ] || fail "live checkout reports ${old_ver:-unknown}, expected $EXPECT_OLD; is the switch already done?"
new_ver=$(cd "$NEW" && node --import tsx/esm apps/cli/src/bin.ts --version 2>/dev/null | tail -1)
[ "$new_ver" = "$EXPECT_NEW" ] || fail "rc.5 CLI reports ${new_ver:-nothing}, expected $EXPECT_NEW"
if [ -n "${TMUX:-}" ]; then
  tmux_session=$(tmux display-message -p '#S' 2>/dev/null || true)
  [ "$tmux_session" = "dsh" ] && fail 'run this from a plain Termux shell, not inside the dsh tmux session'
fi
say "preflight ok: live $old_ver, new $new_ver"

if [ "${1:-}" = "--check" ]; then
  DONE=1
  exit 0
fi

# --- swap --------------------------------------------------------------------
WORKTREE_ID=$(sed -n 's#^gitdir: .*/worktrees/\([^/]*\)$#\1#p' "$NEW/.git" 2>/dev/null | head -1)
[ -n "${WORKTREE_ID:-}" ] || WORKTREE_ID=rc5

say 'stopping watchdog and server'
PHASE=stopping
kill_server || fail "port $PORT still answering; stop it manually and rerun"
offset=$(log_size)

PHASE=half
mv "$OLD" "$ASIDE" || fail "could not move $OLD aside"
mv "$NEW" "$OLD" || fail "could not move rc.5 into place"
PHASE=swapped
say "swapped: $ASIDE (rc.3), $OLD (rc.5)"

say 'repairing git worktree links'
admin="$ASIDE/.git/worktrees/$WORKTREE_ID"
if [ -d "$admin" ]; then
  printf '%s\n' "$OLD/.git" >"$admin/gitdir" || say "warning: cannot write $admin/gitdir"
  printf 'gitdir: %s\n' "$admin" >"$OLD/.git" || say "warning: cannot write $OLD/.git"
  repair_other_worktrees "$ASIDE"
else
  say "warning: no worktree entry at $admin; git commands in $OLD will fail"
fi
git -C "$OLD" rev-parse --abbrev-ref HEAD >/dev/null 2>&1 || say "warning: $OLD is not a usable git worktree"

say 'starting watchdog'
start_service || fail "could not start the watchdog"
sleep 2
smoke "$EXPECT_NEW" "$offset" android/align-official || fail "the restarted rc.5 server did not pass its smoke test"

DONE=1
say 'cutover done. Open the login URL above (also sent as a Termux notification).'
say "If the new build misbehaves, run: $BASE/rollback-rc3.sh"
