#!/bin/bash
# install.command —— macOS 安装脚本（双击运行）
#
# 和 install.cmd 做同样的事：把插件文件拷到 Alma 的插件目录，
# 通知 Alma 重新加载，然后确认服务真的起来了。
#
# 和 Windows 版的差别只有一个：这里还要 chmod，让 pickdir 之类的东西能跑，
# 顺带把权限写进 copy 后的文件，避免从压缩包解出来的文件丢 exec 位。

set -u

cd "$(dirname "$0")" || exit 1
. ./_lib.sh

DST="$HOME/.config/alma/plugins/task-inbox"
ALMA_API="http://localhost:23001"

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

# 这张清单要和 install.cmd 里的 for %%f 完全一致 —— 少一个文件插件就激活不了。
FILES=(
  manifest.json
  main.mjs
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

# ---------- 通知 Alma 重载 ----------

echo
echo "通知 Alma 重新加载插件..."
if curl -s --max-time 5 -X POST "$ALMA_API/api/plugins/refresh" -o /dev/null 2>/dev/null; then
  echo "[OK] 重载已发送"
else
  echo "[!] Alma 没在跑。下次启动 Alma 时会自动加载插件。"
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
  echo "[!] 服务没起来。检查 Alma → 设置 → 插件 → task-inbox 是否已启用。"
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
