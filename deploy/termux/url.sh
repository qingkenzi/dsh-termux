#!/bin/sh
# 打印当前 dsh web 的访问地址（守护重启后 token 会变化，用这个脚本获取最新地址）。
# 优先读取 watchdog 发布的 latest.url，旧版本的 web-<pid>.url 作为回退。
set -eu
BASE=${DSH_TERMUX_BASE:-$HOME/dsh}
RUN_DIR=${DSH_HOME:-$HOME/.dsh}/run

if [ -f "$RUN_DIR/latest.url" ]; then
  echo "当前 dsh 地址："
  head -n 1 "$RUN_DIR/latest.url"
  exit 0
fi

LATEST=$(ls -t "$RUN_DIR"/web-*.url 2>/dev/null | head -1 || true)
if [ -z "$LATEST" ]; then
  echo "未找到登录 URL，dsh 可能未启动。检查：cat \"$BASE/.logs/watchdog.log\"" >&2
  exit 1
fi
echo "当前 dsh 地址："
grep -oE 'http://[^ ]+' "$LATEST" | head -1
