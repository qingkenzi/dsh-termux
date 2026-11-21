#!/bin/sh
# dsh / pi-web 快速启动菜单（Termux）
# 纯 POSIX sh，零额外依赖。默认在新终端第一屏自动弹出（由 ~/.bashrc 调用）。
set -u
BASE=${DSH_TERMUX_BASE:-$HOME/dsh}
RUN=${DSH_HOME:-$HOME/.dsh}/run
DSH_LOG="$BASE/.logs/dsh-web.log"
DSH_PORT=3080
PIWEB_PORT="${PI_WEB_PORT:-30141}"
DSH_TMUX=dsh
PIWEB_TMUX=piweb
# ---------- 酒馆 SillyTavern ----------
ST_DIR="$HOME/SillyTavern"
ST_PORT="${ST_PORT:-8000}"
ST_TMUX=tavern
ST_LOG="$BASE/.logs/sillytavern.log"

if [ -t 1 ]; then
  C_R=$(printf '\033[31m'); C_G=$(printf '\033[32m'); C_Y=$(printf '\033[33m')
  C_D=$(printf '\033[2m'); C_B=$(printf '\033[1m'); C_0=$(printf '\033[0m')
else
  C_R=; C_G=; C_Y=; C_D=; C_B=; C_0=
fi

# ---------- 基础探测 ----------
http_code() {  # $1=port → HTTP 状态码，连不上为 000
  c=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$1/" 2>/dev/null) || c=000
  printf '%s' "${c:-000}"
}
# $DSH_LOG 的字节数；文件不存在时视为 0
dsh_log_size() {
  if [ -f "$DSH_LOG" ]; then
    wc -c <"$DSH_LOG" 2>/dev/null | tr -d ' '
  else
    printf '0\n'
  fi
}
# 输出 $DSH_LOG 中偏移 $1 之后最后一条 `dsh web: http://...` 的 URL。
dsh_log_url_since() {
  [ -f "$DSH_LOG" ] || return 1
  size=$(dsh_log_size)
  case "${size:-}" in ''|*[!0-9]*) return 1 ;; esac
  off=${1:-0}
  case "$off" in ''|*[!0-9]*) off=0 ;; esac
  [ "$size" -lt "$off" ] && off=0   # 日志被截断/轮转时从头读
  tail -c +"$((off + 1))" "$DSH_LOG" 2>/dev/null \
    | awk '/^dsh web: http:\/\// { url = $3 } END { if (url != "") print url }'
}
# Termux 的 Node 主线程 /proc/<pid>/comm 是 node-MainThread，不能只匹配 node。
dsh_is_node() {
  [ -n "${1:-}" ] || return 1
  comm=$(cat "/proc/$1/comm" 2>/dev/null) || return 1
  case "$comm" in
    node|node-*) return 0 ;;
    *) return 1 ;;
  esac
}
dsh_running() { [ "$(http_code "$DSH_PORT")" != "000" ]; }
piweb_running() { [ "$(http_code "$PIWEB_PORT")" != "000" ]; }
dsh_pid() {
  # 1) watchdog.log 最后一条 started pid=
  p=$(grep -a 'started pid=' "$BASE/.logs/watchdog.log" 2>/dev/null \
        | tail -n 1 | sed -n 's/.*started pid=\([0-9][0-9]*\).*/\1/p')
  if dsh_is_node "${p:-}"; then
    printf '%s\n' "$p"
    return 0
  fi
  # 2) pgrep 结果还要按 /proc/<pid>/comm 过滤，避免把 bash -c 自身当成 dsh
  for q in $(pgrep -f 'apps/cli/src/bin.ts web' 2>/dev/null); do
    if dsh_is_node "$q"; then
      printf '%s\n' "$q"
      return 0
    fi
  done
  # 3) 兼容旧行为：退回 web-*.url 文件名里的 pid
  f=$(ls -t "$RUN"/web-*.url 2>/dev/null | head -1)
  [ -n "${f:-}" ] || return 1
  basename "$f" | sed 's/^web-//; s/\.url$//'
}
dsh_uptime() {
  p=$(dsh_pid 2>/dev/null) || return 1
  ps -o etime= -p "$p" 2>/dev/null | tr -d ' '
}
open_url() {
  opened=1
  if command -v termux-open-url >/dev/null 2>&1; then
    termux-open-url "$1" >/dev/null 2>&1 || opened=0
  else
    opened=0
  fi
  if [ "$opened" -eq 1 ]; then
    printf '%s已发送到浏览器：%s\n' "$C_D" "$C_0"
  else
    printf '%s无法自动打开浏览器，请手动访问：%s\n' "$C_Y" "$C_0"
  fi
  printf '  %s%s%s\n' "$C_D" "$1" "$C_0"
}
pause() { printf '\n%s按回车返回菜单…%s' "$C_D" "$C_0"; read -r _ || true; }

# ---------- dsh ----------
dsh_open() {
  f="$RUN/latest.url"
  if [ -f "$f" ] && [ ! -f "$f.used" ]; then
    age=$(( $(date +%s) - $(stat -c %Y "$f" 2>/dev/null || echo 0) ))
    if [ "$age" -lt 540 ]; then
      open_url "$(cat "$f")"
      : >"$f.used"   # 记一次打开；登录 cookie 会保留，无需每次都走这个链接
      return 0
    fi
  fi
  open_url "http://127.0.0.1:$DSH_PORT/"
  printf '%s提示：登录 cookie 默认有效 30 天且跨重启保留；仅在清除浏览器数据或换设备时，才回菜单选 8 打开登录链接。%s\n' "$C_D" "$C_0"
}

dsh_watchdog_alive() { tmux has-session -t "$DSH_TMUX" 2>/dev/null; }

dsh_start() {
  start_off=$(dsh_log_size)
  if dsh_running; then
    printf '%s dsh 已在运行%s（pid %s，已运行 %s）\n' "$C_G" "$C_0" "$(dsh_pid 2>/dev/null)" "$(dsh_uptime 2>/dev/null)"
    dsh_open
    return 0
  fi
  mkdir -p "$RUN"
  if ! dsh_watchdog_alive; then
    tmux new-session -d -s "$DSH_TMUX" -n watchdog "cd $BASE && ./keep-alive.sh" 2>/dev/null \
      && printf '已启动守护会话（tmux: %s）\n' "$DSH_TMUX" \
      || printf '%stmux 启动失败%s\n' "$C_R" "$C_0"
  fi
  printf '等待 dsh 就绪'
  i=0
  while [ "$i" -lt 60 ]; do
    new_url=$(dsh_log_url_since "${start_off:-0}")
    if [ -n "${new_url:-}" ]; then
      printf '\n'
      rm -f "$RUN/latest.url.used" 2>/dev/null || true
      dsh_open
      return 0
    fi
    sleep 1; i=$((i + 1)); printf '.'
  done
  printf '\n%s超时：60 秒内没拿到登录地址，看日志（菜单 5 → 1）%s\n' "$C_R" "$C_0"
  return 1
}

# ---------- pi-web ----------
piweb_open() { open_url "http://127.0.0.1:$PIWEB_PORT/"; }

piweb_start() {
  if piweb_running; then
    printf '%s pi-web 已在运行%s（%s）\n' "$C_G" "$C_0" "http://127.0.0.1:$PIWEB_PORT/"
    piweb_open
    return 0
  fi
  if ! tmux has-session -t "$PIWEB_TMUX" 2>/dev/null; then
    tmux new-session -d -s "$PIWEB_TMUX" -n watchdog "cd $BASE && ./piweb-watchdog.sh" 2>/dev/null \
      && printf '已启动守护会话（tmux: %s）\n' "$PIWEB_TMUX" \
      || printf '%stmux 启动失败%s\n' "$C_R" "$C_0"
  fi
  printf '等待 pi-web 就绪'
  i=0
  while [ "$i" -lt 60 ]; do
    sleep 1; i=$((i + 1)); printf '.'
    if piweb_running; then
      printf '\n'
      piweb_open
      return 0
    fi
  done
  printf '\n%s超时：60 秒内端口没起来，看日志（菜单 5 → 3）%s\n' "$C_R" "$C_0"
  return 1
}

# ---------- 酒馆 SillyTavern ----------
st_running() { [ "$(http_code "$ST_PORT")" != "000" ]; }
st_pid() {
  p=$(tmux list-panes -t "$ST_TMUX" -F '#{pane_pid}' 2>/dev/null | head -1)
  if [ -n "${p:-}" ]; then printf '%s\n' "$p"; return 0; fi
  for q in $(pgrep -f 'node server\.js' 2>/dev/null); do
    case "$(readlink "/proc/$q/cwd" 2>/dev/null)" in
      "$ST_DIR"|"$ST_DIR"/*) printf '%s\n' "$q"; return 0 ;;
    esac
  done
  return 1
}
st_uptime() {
  p=$(st_pid 2>/dev/null) || return 1
  [ -n "${p:-}" ] || return 1
  ps -o etime= -p "$p" 2>/dev/null | tr -d ' '
}
st_open() { open_url "http://127.0.0.1:$ST_PORT/"; }

st_start() {
  if st_running; then
    printf '%s 酒馆已在运行%s（%s，已运行 %s）\n' "$C_G" "$C_0" "http://127.0.0.1:$ST_PORT/" "$(st_uptime 2>/dev/null)"
    st_open
    return 0
  fi
  if [ ! -f "$ST_DIR/server.js" ]; then
    printf '%s未找到酒馆安装目录：%s%s\n' "$C_R" "$ST_DIR" "$C_0"
    return 1
  fi
  mkdir -p "$BASE/.logs" 2>/dev/null || true
  if ! tmux has-session -t "$ST_TMUX" 2>/dev/null; then
    tmux new-session -d -s "$ST_TMUX" -n tavern \
      "cd $ST_DIR && exec node server.js >> $ST_LOG 2>&1" 2>/dev/null \
      && printf '已启动会话（tmux: %s）\n' "$ST_TMUX" \
      || printf '%stmux 启动失败%s\n' "$C_R" "$C_0"
  fi
  printf '等待酒馆就绪'
  i=0
  while [ "$i" -lt 120 ]; do
    sleep 1; i=$((i + 1)); printf '.'
    if st_running; then
      printf '\n'
      st_open
      return 0
    fi
  done
  printf '\n%s超时：120 秒内端口没起来（首次启动要编译前端，可能较慢），看日志（菜单 6 → 5）%s\n' "$C_R" "$C_0"
  return 1
}

stop_st() {
  printf '%s注意：若你正在浏览器里用酒馆，停止会中断该页面连接。%s\n' "$C_Y" "$C_0"
  printf '确认停止酒馆？[y/N] '
  read -r a || a=n
  case "$a" in
    y|Y|yes|YES) ;;
    *) printf '已取消\n'; return 0 ;;
  esac
  tmux kill-session -t "$ST_TMUX" 2>/dev/null
  p=$(st_pid 2>/dev/null) && [ -n "${p:-}" ] && kill "$p" 2>/dev/null
  printf '%s 酒馆已停止%s\n' "$C_Y" "$C_0"
}

# ---------- 状态 / 停止 / 日志 ----------
show_status() {
  printf '%s── dsh ─────────────────────────────%s\n' "$C_B" "$C_0"
  if dsh_running; then
    printf '  状态: %s运行中%s  HTTP %s\n' "$C_G" "$C_0" "$(http_code "$DSH_PORT")"
    printf '  PID : %s   已运行 %s\n' "$(dsh_pid 2>/dev/null)" "$(dsh_uptime 2>/dev/null)"
    printf '  守护: %s\n' "$(dsh_watchdog_alive && echo 'tmux 会话 dsh 在线' || echo '未运行')"
    printf '  入口: %s\n' "$(cat "$RUN/latest.url" 2>/dev/null | sed 's/token=.*/token=<登录令牌>/')"
  else
    printf '  状态: %s已停止%s\n' "$C_R" "$C_0"
    printf '  守护: %s\n' "$(dsh_watchdog_alive && echo 'tmux 会话在（进程异常）' || echo '未运行')"
  fi
  if [ -f "$BASE/.logs/watchdog.log" ]; then
    printf '  最近: %s\n' "$(tail -1 "$BASE/.logs/watchdog.log")"
  fi

  printf '\n%s── pi-web ──────────────────────────%s\n' "$C_B" "$C_0"
  if piweb_running; then
    printf '  状态: %s运行中%s  HTTP %s\n' "$C_G" "$C_0" "$(http_code "$PIWEB_PORT")"
    pid=$(pgrep -f 'bin/pi-web$' 2>/dev/null | head -1)
    [ -n "${pid:-}" ] && printf '  PID : %s\n' "$pid"
    printf '  守护: %s\n' "$(tmux has-session -t "$PIWEB_TMUX" 2>/dev/null && echo 'tmux 会话 piweb 在线' || echo '未运行')"
  else
    printf '  状态: %s已停止%s\n' "$C_R" "$C_0"
  fi
  if [ -f "$BASE/.logs/piweb-watchdog.log" ]; then
    printf '  最近: %s\n' "$(tail -1 "$BASE/.logs/piweb-watchdog.log")"
  fi

  printf '\n%s── 酒馆 SillyTavern ────────────────%s\n' "$C_B" "$C_0"
  if st_running; then
    printf '  状态: %s运行中%s  HTTP %s\n' "$C_G" "$C_0" "$(http_code "$ST_PORT")"
    printf '  PID : %s   已运行 %s\n' "$(st_pid 2>/dev/null)" "$(st_uptime 2>/dev/null)"
    printf '  会话: %s\n' "$(tmux has-session -t "$ST_TMUX" 2>/dev/null && echo "tmux 会话 $ST_TMUX 在线" || echo '未运行（可能为手动启动）')"
    printf '  入口: %s\n' "http://127.0.0.1:$ST_PORT/"
  else
    printf '  状态: %s已停止%s\n' "$C_R" "$C_0"
  fi
  if [ -f "$ST_LOG" ]; then
    printf '  最近: %s\n' "$(grep -vE '^[[:space:]=]*$' "$ST_LOG" 2>/dev/null | tail -1)"
  fi
  pause
}

stop_dsh() {
  tmux kill-session -t "$DSH_TMUX" 2>/dev/null
  p=$(dsh_pid 2>/dev/null) && kill -9 "$p" 2>/dev/null
  rm -rf "$RUN/watchdog.lock" 2>/dev/null
  printf '%s dsh 已停止%s\n' "$C_Y" "$C_0"
}

stop_piweb() {
  printf '%s注意：如果你正在用 pi-web 界面，停止会结束该会话。%s\n' "$C_Y" "$C_0"
  printf '确认停止 pi-web？[y/N] '
  read -r a || a=n
  case "$a" in
    y|Y|yes|YES) ;;
    *) printf '已取消\n'; return 0 ;;
  esac
  tmux kill-session -t "$PIWEB_TMUX" 2>/dev/null
  timeout 20 pi-web stop --port "$PIWEB_PORT" >/dev/null 2>&1
  printf '%s pi-web 已停止%s\n' "$C_Y" "$C_0"
}

show_log() {
  case "$1" in
    1) f="$DSH_LOG";                      n='dsh 输出' ;;
    2) f="$BASE/.logs/watchdog.log";       n='dsh 守护' ;;
    3) f="$BASE/.logs/pi-web.log";         n='pi-web 输出' ;;
    4) f="$BASE/.logs/piweb-watchdog.log"; n='pi-web 守护' ;;
    5) f="$ST_LOG";                     n='酒馆输出' ;;
    *) return 0 ;;
  esac
  printf '%s── %s（末 30 行）────────────────%s\n' "$C_B" "$n" "$C_0"
  if [ -f "$f" ]; then
    tail -n 30 "$f"
  else
    printf '%s（暂无日志）%s\n' "$C_D" "$C_0"
  fi
  pause
}

relogin() {
  if ! dsh_running; then
    printf 'dsh 未运行，先启动…\n'
    dsh_start && return 0
    return 1
  fi
  if ! dsh_watchdog_alive; then
    printf '守护不在，先补起守护会话…\n'
    tmux new-session -d -s "$DSH_TMUX" -n watchdog "cd $BASE && ./keep-alive.sh" 2>/dev/null || true
    sleep 2
  fi
  printf '正在重启实例以签发新链接（约 20 秒）…\n'
  url=$(cd "$BASE" && ./relogin.sh 2>/dev/null | tail -1)
  if [ -n "${url:-}" ]; then
    rm -f "$RUN/latest.url.used" 2>/dev/null || true
    printf '%s新链接已就绪%s\n' "$C_G" "$C_0"
    open_url "$url"
    : >"$RUN/latest.url.used"
  else
    printf '%s签发失败，检查 %s%s\n' "$C_R" "$BASE/.logs/watchdog.log" "$C_0"
    pause
  fi
}

# ---------- 菜单 ----------
menu() {
  clear 2>/dev/null || true
  printf '%s╭─ dsh / pi-web / 酒馆 启动菜单 ──────╮%s\n' "$C_B" "$C_0"
  dsh_running   && printf '  dsh    %s●运行中%s :%s\n' "$C_G" "$C_0" "$DSH_PORT" \
                || printf '  dsh    %s○已停止%s :%s\n' "$C_R" "$C_0" "$DSH_PORT"
  piweb_running && printf '  pi-web %s●运行中%s :%s\n' "$C_G" "$C_0" "$PIWEB_PORT" \
                || printf '  pi-web %s○已停止%s :%s\n' "$C_R" "$C_0" "$PIWEB_PORT"
  st_running    && printf '  酒馆   %s●运行中%s :%s\n' "$C_G" "$C_0" "$ST_PORT" \
                || printf '  酒馆   %s○已停止%s :%s\n' "$C_R" "$C_0" "$ST_PORT"
  printf '%s╰─────────────────────────────────────╯%s\n' "$C_B" "$C_0"
  cat <<'EOF'

  1) 启动 dsh（已在运行则直接打开浏览器）
  2) 启动 pi-web（已在运行则直接打开浏览器）
  3) 启动 酒馆 SillyTavern（已在运行则直接打开浏览器）
  4) 运行状态
  5) 停止 / 重启
  6) 查看日志
  7) 打开浏览器
  8) dsh 登录链接（换设备/清缓存后用）
  0) 退出
EOF
  printf '\n选择 [0-8]: '
}

sub_stop() {
  while :; do
    clear 2>/dev/null || true
    printf '%s── 停止 / 重启 ──%s\n' "$C_B" "$C_0"
    cat <<'EOF'

  1) 停止 dsh
  2) 停止 pi-web
  3) 停止 酒馆
  4) 全部停止
  5) 重启全部（先停后起）
  0) 返回
EOF
    printf '\n选择 [0-5]: '
    read -r c || return 0
    case "$c" in
      1) stop_dsh; pause ;;
      2) stop_piweb; pause ;;
      3) stop_st; pause ;;
      4) stop_dsh; stop_piweb; stop_st; pause ;;
      5) stop_dsh; stop_piweb; stop_st; sleep 1; dsh_start; piweb_start; st_start; pause ;;
      0) return 0 ;;
      *) ;;
    esac
  done
}

sub_logs() {
  while :; do
    clear 2>/dev/null || true
    printf '%s── 查看日志 ──%s\n' "$C_B" "$C_0"
    cat <<'EOF'

  1) dsh 输出（.logs/dsh-web.log）
  2) dsh 守护（.logs/watchdog.log）
  3) pi-web 输出（.logs/pi-web.log）
  4) pi-web 守护（.logs/piweb-watchdog.log）
  5) 酒馆输出（.logs/sillytavern.log）
  0) 返回
EOF
    printf '\n选择 [0-5]: '
    read -r c || return 0
    case "$c" in
      1|2|3|4|5) show_log "$c" ;;
      0) return 0 ;;
      *) ;;
    esac
  done
}

sub_open() {
  while :; do
    clear 2>/dev/null || true
    printf '%s── 打开浏览器 ──%s\n\n  1) dsh\n  2) pi-web\n  3) 酒馆\n  4) 全部打开\n  0) 返回\n' "$C_B" "$C_0"
    printf '\n选择 [0-4]: '
    read -r c || return 0
    case "$c" in
      1) dsh_open; pause ;;
      2) piweb_open; pause ;;
      3) st_open; pause ;;
      4) dsh_open; piweb_open; st_open; pause ;;
      0) return 0 ;;
      *) ;;
    esac
  done
}

while :; do
  menu
  read -r choice || break
  case "$choice" in
    1) dsh_start; pause ;;
    2) piweb_start; pause ;;
    3) st_start; pause ;;
    4) show_status ;;
    5) sub_stop ;;
    6) sub_logs ;;
    7) sub_open ;;
    8) relogin; pause ;;
    0|q|Q|exit) break ;;
    *) ;;
  esac
done
exit 0
