#!/bin/sh
# 打印当前实例的新登录链接：登录 cookie 默认保留 30 天且跨重启有效，通常不需要重签。
# 菜单 8 使用；会重启实例，由 keep-alive.sh 重新发布链接。
set -eu
BASE=${DSH_TERMUX_BASE:-$HOME/dsh}
RUN=${DSH_HOME:-$HOME/.dsh}/run
LOG="$BASE/.logs/dsh-web.log"
WATCHLOG="$BASE/.logs/watchdog.log"

# 日志当前字节数；文件不存在时视为 0
log_size() {
  if [ -f "$LOG" ]; then
    wc -c <"$LOG" 2>/dev/null | tr -d ' '
  else
    printf '0\n'
  fi
}

# 输出 $LOG 中偏移 $1 之后最后一条 `dsh web: http://...` 的 URL。
log_url_since() {
  [ -f "$LOG" ] || return 1
  size=$(log_size)
  case "${size:-}" in ''|*[!0-9]*) return 1 ;; esac
  off=${1:-0}
  case "$off" in ''|*[!0-9]*) off=0 ;; esac
  [ "$size" -lt "$off" ] && off=0   # 日志被截断/轮转时从头读
  tail -c +"$((off + 1))" "$LOG" 2>/dev/null \
    | awk '/^dsh web: http:\/\// { url = $3 } END { if (url != "") print url }'
}

# Termux 的 Node 主线程 /proc/<pid>/comm 是 node-MainThread，不能只匹配 node。
is_node() {
  [ -n "${1:-}" ] || return 1
  comm=$(cat "/proc/$1/comm" 2>/dev/null) || return 1
  case "$comm" in
    node|node-*) return 0 ;;
    *) return 1 ;;
  esac
}

# 与 dsh-menu.sh 的 dsh_pid() 相同：watchdog.log → pgrep + comm 过滤 → web-*.url 回退
find_pid() {
  # 1) watchdog.log 最后一条 started pid=
  p=$(grep -a 'started pid=' "$WATCHLOG" 2>/dev/null \
        | tail -n 1 | sed -n 's/.*started pid=\([0-9][0-9]*\).*/\1/p' || true)
  if is_node "${p:-}"; then
    printf '%s\n' "$p"
    return 0
  fi
  # 2) pgrep 结果还要按 /proc/<pid>/comm 过滤，避免把 bash -c 自身当成 dsh
  for q in $(pgrep -f 'apps/cli/src/bin.ts web' 2>/dev/null || true); do
    if is_node "$q"; then
      printf '%s\n' "$q"
      return 0
    fi
  done
  # 3) 兼容旧行为：退回 web-*.url 文件名里的 pid
  f=$(ls -t "$RUN"/web-*.url 2>/dev/null | head -1 || true)
  [ -n "${f:-}" ] || return 1
  p=$(basename "$f" | sed 's/^web-//; s/\.url$//')
  case "$p" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s\n' "$p"
}

# 最多等 60 秒，输出偏移之后出现的新 URL；超时返回 1
wait_for_url() {
  i=0
  while [ "$i" -lt 60 ]; do
    sleep 1
    i=$((i + 1))
    u=$(log_url_since "$1" 2>/dev/null || true)
    if [ -n "${u:-}" ]; then
      printf '%s\n' "$u"
      return 0
    fi
  done
  return 1
}

pid=$(find_pid 2>/dev/null || true)
if [ -z "${pid:-}" ]; then
  echo "没有找到运行中的 dsh 实例。请先在菜单选 1 启动，或运行：tmux new -d -s dsh '~/dsh/keep-alive.sh'" >&2
  exit 1
fi

case "$pid" in
  ''|*[!0-9]*)
    echo "无法解析实例 pid（$pid），请检查 $WATCHLOG 或 $RUN/web-*.url" >&2
    exit 1
    ;;
esac

off=$(log_size)
case "${off:-}" in ''|*[!0-9]*) off=0 ;; esac

echo "重启实例 pid=$pid ..." >&2
kill -9 "$pid" 2>/dev/null || true

url=$(wait_for_url "$off" || true)
if [ -z "${url:-}" ]; then
  echo "等待新实例超时（60 秒）：请检查 $LOG 与 $WATCHLOG，或确认 tmux 会话 dsh 中的守护仍在运行。" >&2
  exit 1
fi

# keep-alive.sh 可能已把同一条链接写入 latest.url；只在内容一致时采用，避免输出旧文件。
if [ -f "$RUN/latest.url" ]; then
  latest=$(cat "$RUN/latest.url" 2>/dev/null || true)
  if [ "${latest:-}" = "$url" ]; then
    printf '%s\n' "$latest"
    exit 0
  fi
fi
printf '%s\n' "$url"
