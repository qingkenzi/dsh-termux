#!/bin/sh
# Revert the Termux deployment to the rc.3 checkout after a failed cutover.
#
# Usage: ~/dsh/rollback-rc3.sh
set -eu
BASE=${DSH_TERMUX_BASE:-$HOME/dsh}
RUN=${DSH_HOME:-$HOME/.dsh}/run
OLD="$BASE/deepseek-harness"
ASIDE="$BASE/deepseek-harness-rc3"
FAILED="$BASE/rc5-failed"
PORT=3080

say() { printf '%s\n' "$*"; }
fail() { printf 'rollback: %s\n' "$*" >&2; exit 1; }

[ -d "$ASIDE/.git" ] || fail "no rc.3 checkout at $ASIDE; nothing to roll back to"
[ -e "$FAILED" ] && fail "$FAILED already exists; move it away first"

say 'stopping watchdog and server'
tmux kill-session -t dsh 2>/dev/null || true
pkill -f 'apps/cli/src/bin.ts web' 2>/dev/null || true
tries=0
while [ "$tries" -lt 30 ]; do
  code=$(curl -s -o /dev/null -w '%{http_code}' -m 2 "http://127.0.0.1:$PORT/" 2>/dev/null || true)
  [ "$code" = "000" ] && break
  tries=$((tries + 1))
  sleep 1
done
[ "$code" = "000" ] || fail "port $PORT still answering; stop it manually and rerun"
rm -rf "$RUN/watchdog.lock" 2>/dev/null || true

say "restoring $ASIDE -> $OLD"
mv "$OLD" "$FAILED"
mv "$ASIDE" "$OLD"

# Moving the main repository back breaks the gitfiles of its worktrees:
# `git worktree repair` cannot read a gitfile whose target has disappeared,
# so rewrite both sides of each link directly.
WORKTREE_ID=$(sed -n 's#^gitdir: .*/worktrees/\([^/]*\)$#\1#p' "$FAILED/.git" 2>/dev/null | head -1)
if [ -n "${WORKTREE_ID:-}" ] && [ -d "$OLD/.git/worktrees/$WORKTREE_ID" ]; then
  admin="$OLD/.git/worktrees/$WORKTREE_ID"
  printf '%s\n' "$FAILED/.git" > "$admin/gitdir" || true
  printf 'gitdir: %s\n' "$admin" > "$FAILED/.git" || true
fi
for admin in "$OLD"/.git/worktrees/*; do
  [ -d "$admin" ] || continue
  gitfile=$(head -n 1 "$admin/gitdir" 2>/dev/null | tr -d '\r')
  [ -n "${gitfile:-}" ] || continue
  [ -f "$gitfile" ] || continue
  printf 'gitdir: %s\n' "$admin" > "$gitfile" || true
done

say 'starting watchdog on rc.3'
tmux new-session -d -s dsh -n watchdog "cd $BASE && ./keep-alive.sh"
sleep 8
tail -n 5 "$BASE/.logs/dsh-web.log" 2>/dev/null || true
say 'rollback done. The failed rc.5 checkout is at rc5-failed for inspection.'
