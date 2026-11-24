#!/bin/bash
# serve.command —— 后台起服务
#
# 和 serve.cmd 一个作用：先探端口，已经有人跑就直接退出，不重复起第二个实例。
# 所以拿它做开机自启是安全的。
#
# 唯一比 Windows 版多做的一件事：探测整个端口区间（46001–46005），
# 而不是只看 46001。server.mjs 撞端口会往后挪，只认 46001 会误判成「没起」。

set -u

cd "$(dirname "$0")" || exit 1
. ./_lib.sh

LOG_DIR="$HOME/.config/cabinet"
LOG="$LOG_DIR/serve.log"

# 区间里任何一个已经活着就复用
if BASE=$(find_base); then
  echo "[skip] 服务已经在跑了：$BASE"
  exit 0
fi

require_node || exit 1

mkdir -p "$LOG_DIR"

echo "[start] 启动任务服务..."
# nohup + & ：脱离终端，关掉 Terminal 也不影响。
# setsid 不存在就算了（mac 没有），nohup 已经够用。
nohup node "$(dirname "$0")/server.mjs" >>"$LOG" 2>&1 &
PID=$!

# 起来之后重新探一遍端口区间，拿到它实际落在哪一个。
# 只判断 spawn 成功是不够的 —— 进程可能起来就崩了（缺文件、端口全占）。
# 但它也需要几百毫秒才开始监听，所以给 10 秒重试窗口。
for _ in $(seq 1 20); do
  if BASE=$(find_base); then
    echo "[OK] $BASE  (pid $PID)"
    exit 0
  fi
  sleep 0.5
done

echo "[!] 服务没起来。日志：$LOG"
tail -n 20 "$LOG" 2>/dev/null
exit 1
