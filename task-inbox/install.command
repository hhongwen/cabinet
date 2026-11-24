#!/bin/bash
# install.command —— macOS 安装脚本（双击运行）
#
# 和 install.cmd 做同样的事：把程序文件拷到 ~/.config/cabinet/app，
# 起一次服务，然后确认真的起来了。
#
# 和 Windows 版的差别只有一个：这里还要 chmod，让 pickdir 之类的东西能跑，
# 顺带把权限写进 copy 后的文件，避免从压缩包解出来的文件丢 exec 位。

set -u

cd "$(dirname "$0")" || exit 1
. ./_lib.sh

DST="$HOME/.config/cabinet/app"

echo
echo "=== Task Inbox Setup (macOS) ==="
echo

# ---------- 前置检查 ----------

if ! require_node; then
  echo "    或者从 https://nodejs.org 下 pkg 安装包"
  echo
  read -r -p "按回车关闭..." _
  exit 1
fi

# ---------- 拷文件 ----------

mkdir -p "$DST" || { echo "[X] 建不了目录：$DST"; exit 1; }

# 这张清单要和 install.cmd 里的 for %%f 完全一致 —— 少一个文件服务就起不来。
FILES=(
  manifest.json
  core.mjs
  storage.mjs
  server.mjs
  classify.mjs
  backend.mjs
  chat.mjs
  brief.mjs
  browse.mjs
  cli.mjs
  pickdir.ps1
  stop-service.ps1
  style-audit.mjs
  board.html
)

for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
    cp -f "$f" "$DST/" && echo "[OK] $f"
  else
    echo "[!] 缺 $f"
  fi
done

# icons 目录是可选的，有就一起带上（mac 用不上 .ico，但保留一致性）
if [ -d icons ]; then
  cp -Rf icons "$DST/" && echo "[OK] icons/"
fi

chmod -R u+rw "$DST"

# ---------- 起服务 ----------

echo
echo "启动服务..."
if pgrep -f "server.mjs" >/dev/null 2>&1; then
  echo "[skip] 已有实例在跑"
else
  nohup node "$DST/server.mjs" > "$DST/server.log" 2>&1 &
  echo "[OK] 已启动（日志 $DST/server.log）"
fi

# ---------- 确认服务 ----------

echo
echo "等服务起来..."
BASE=""
for _ in $(seq 1 30); do
  if BASE=$(find_base); then break; fi
  sleep 0.5
done

if [ -n "$BASE" ]; then
  echo "[OK] 服务就绪：$BASE"
else
  echo "[!] 服务没起来。看一眼日志：$DST/server.log"
  echo "    也可以手动跑一次看报错：node \"$DST/server.mjs\""
  BASE="http://127.0.0.1:46001"
fi

echo
echo "  看板：    $BASE/"
echo "  随手记：  $BASE/quick"
echo
echo "接下来："
echo "  ./start.command       起服务 + 打开看板窗口"
echo "  ./start.command quick 只开随手记小窗"
echo "  ./serve.command       只起后台服务（开机自启走这个）"
echo "  ./autostart.command   加入开机自启"
echo "  ./mklinks.command     在桌面建两个快捷方式"
echo "  node cli.mjs ls       命令行看任务"
echo

read -r -p "按回车关闭..." _
