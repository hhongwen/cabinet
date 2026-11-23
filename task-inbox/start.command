#!/bin/bash
# start.command —— 起服务 + 打开看板窗口（双击运行）
#
# 对应 Windows 的 start.cmd + window.cmd。
# 优先用 Chrome/Edge 的 --app 模式开无边框窗口（和 Windows 版一致的外观），
# 都没有就退回系统默认浏览器开普通标签页。

set -u

cd "$(dirname "$0")" || exit 1
. ./_lib.sh

# ---------- 1. 服务没起就先起 ----------

# 注意拿的是它返回的 base —— 端口可能不在 46001 上。
if ! BASE=$(find_base); then
  echo "启动任务服务..."
  "$(dirname "$0")/serve.command" || exit 1
  BASE=$(find_base) || { echo "[X] 服务起不来，放弃"; exit 1; }
fi

# ---------- 2. 找浏览器 ----------

# 按顺序找支持 --app 的 Chromium 系浏览器
BROWSER=""
for p in \
  "/Applications/Google Chrome.app" \
  "/Applications/Microsoft Edge.app" \
  "/Applications/Brave Browser.app" \
  "/Applications/Arc.app"
do
  if [ -d "$p" ]; then BROWSER="$p"; break; fi
done

# ---------- 3. 开窗 ----------

MODE="${1:-board}"

if [ "$MODE" = "quick" ]; then
  URL="$BASE/?solo=1"
  SIZE="460,340"
else
  URL="$BASE/"
  SIZE="1280,900"
fi

if [ -n "$BROWSER" ]; then
  # -n 开新实例，避免复用已有窗口把它当普通标签页吞掉
  open -na "$BROWSER" --args --app="$URL" --window-size="$SIZE"
else
  # 没有 Chromium 系浏览器：普通标签页开。功能一个不少，只是没有独立窗口。
  open "$URL"
fi
