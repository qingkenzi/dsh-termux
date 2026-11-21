#!/bin/sh
# dsh watchdog v2 — 追加日志 / 记录退出信号 / 推送可用登录地址 / 端口健康检查。
# 用法：tmux new-session -d -s dsh -n watchdog '~/dsh/keep-alive.sh'
set -u
BASE=${DSH_TERMUX_BASE:-$HOME/dsh}
LOG="$BASE/.logs/dsh-web.log"
WATCHLOG="$BASE/.logs/watchdog.log"
RUN=${DSH_HOME:-$HOME/.dsh}/run
PORT=3080
NOTIF_ID=88991
HEALTH_EVERY=8        # 8 * 15s = 2 分钟做一次端口探测
HEALTH_FATAL=3        # 连续 3 次探测失败才判定为卡死
LOG_OFFSET=0          # 本次 start 前的日志字节偏移；只接受之后的 URL 行

mkdir -p "$BASE/.logs" "$RUN"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >>"$WATCHLOG"; }

# 单实例：防止重复拉起两套 node 抢端口
LOCK="$RUN/watchdog.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -f "$LOCK/pid" ] && kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
    echo "watchdog already running (pid $(cat "$LOCK/pid")); exiting" >&2
    exit 0
  fi
  rm -rf "$LOCK"; mkdir "$LOCK" 2>/dev/null || true
fi
echo $$ >"$LOCK/pid"

termux-wake-lock 2>/dev/null && log "wakelock acquired"

# 日志当前字节数；文件不存在时视为 0
log_size() {
  if [ -f "$LOG" ]; then
    wc -c <"$LOG" 2>/dev/null | tr -d ' '
  else
    printf '0\n'
  fi
}

# 输出 $LOG 中 LOG_OFFSET 之后最后一条 `dsh web: http://...` 的 URL。
# 服务器已不再写 web-<pid>.url，URL 只出现在 stdout（追加到 $LOG）。
log_url_since_offset() {
  [ -f "$LOG" ] || return 1
  size=$(log_size)
  case "${size:-}" in ''|*[!0-9]*) return 1 ;; esac
  off=$LOG_OFFSET
  [ "$size" -lt "$off" ] && off=0   # 日志被截断/轮转时从头读
  tail -c +"$((off + 1))" "$LOG" 2>/dev/null \
    | awk '/^dsh web: http:\/\// { url = $3 } END { if (url != "") print url }'
}

# 把本次启动的登录地址落成固定入口，并推一条带「打开」按钮的常驻通知
publish_url() {
  url=$(log_url_since_offset) || return 1
  [ -n "${url:-}" ] || return 1
  printf '%s\n' "$url" >"$RUN/latest.url" || return 1
  chmod 600 "$RUN/latest.url" 2>/dev/null || true
  rm -f "$RUN/latest.url.used"   # 每次签发新链接，清除“已用过”标记
  termux-notification --id "$NOTIF_ID" --title "dsh web 就绪" \
    --content "$url" --priority high --ongoing \
    --button1 "打开" --button1-action "termux-open-url '$url'" \
    2>/dev/null || true
  log "url $url"
  # 只保留最近 3 个 url 文件，避免 run 目录越积越多
  ls -t "$RUN"/web-*.url 2>/dev/null | tail -n +4 | while read -r old; do rm -f "$old"; done
  return 0
}

start() {
  cd "$BASE" || exit 1
  LOG_OFFSET=$(log_size)
  case "${LOG_OFFSET:-}" in ''|*[!0-9]*) LOG_OFFSET=0 ;; esac
  ./dsh web --no-open >>"$LOG" 2>&1 &
  CHILD=$!
  log "started pid=$CHILD"
  i=0
  while [ "$i" -lt 25 ]; do
    if publish_url; then break; fi
    sleep 1
    i=$((i + 1))
  done
  [ "$i" -ge 25 ] && log "warn: no login URL after 25s (see $LOG)"
}

cleanup() {
  log "watchdog stop"
  termux-notification-remove "$NOTIF_ID" 2>/dev/null || true
  termux-wake-unlock 2>/dev/null || true
  # A duplicate start exits through this trap while another watchdog owns the
  # lock; only the owner may remove it, otherwise the survivor loses its
  # single-instance guard.
  if [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ]; then
    rm -rf "$LOCK"
  fi
}
trap 'exit 0' INT TERM HUP
trap 'cleanup' EXIT

UP=$(ps -o etime= -p 1 2>/dev/null | tr -d ' ')
log "watchdog start (系统已运行 ${UP:-unknown})"

while :; do
  start
  TICKS=0
  HANG=0
  while kill -0 "$CHILD" 2>/dev/null; do
    sleep 15
    TICKS=$((TICKS + 1))
    [ "$TICKS" -lt "$HEALTH_EVERY" ] && continue
    TICKS=0
    # 任意 HTTP 状态码（含 401）都说明还在服务；连不上才算异常
    if curl -s -o /dev/null -m 8 "http://127.0.0.1:$PORT/"; then
      HANG=0
    else
      HANG=$((HANG + 1))
      log "health check failed ($HANG/$HEALTH_FATAL)"
      if [ "$HANG" -ge "$HEALTH_FATAL" ]; then
        log "pid=$CHILD unresponsive, killing it"
        kill -9 "$CHILD" 2>/dev/null || true
        break
      fi
    fi
  done
  wait "$CHILD" 2>/dev/null
  rc=$?
  log "child exit rc=$rc signal=$(( rc > 128 ? rc - 128 : 0 ))"
  sleep 5
done
