#!/bin/bash
# autostart.command —— 开机自启（launchd）
#
# 对应 Windows 的 autostart.cmd（往 Startup 文件夹里丢一个 .cmd）。
# mac 的对应物是 launchd 的 LaunchAgent：~/Library/LaunchAgents/*.plist。
#
#   ./autostart.command        开启
#   ./autostart.command off    关闭
#
# 跟 Windows 版一样只指向 serve.command：它会先探端口，
# 已经有人跑就直接退，不会起出两个实例。

set -u

cd "$(dirname "$0")" || exit 1

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.cabinet.task-inbox"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

# ---------- 关 ----------

if [ "${1:-}" = "off" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null \
    || launchctl unload "$PLIST" 2>/dev/null
  rm -f "$PLIST"
  echo "[OK] 已取消开机自启"
  exit 0
fi

# ---------- 开 ----------

# launchd 的 PATH 很短（/usr/bin:/bin:/usr/sbin:/sbin），
# brew 装的 node 在 /opt/homebrew/bin，不在里面。所以这里拿到绝对路径写进 plist。
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[X] 找不到 node。先装：brew install node"
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"
echo "[OK] node: $NODE_BIN"

mkdir -p "$HOME/Library/LaunchAgents"

# 已经加载过就先卸掉，否则改完的 plist 不会生效
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$HERE/serve.command</string>
  </array>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <false/>

  <key>WorkingDirectory</key>
  <string>$HERE</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>StandardOutPath</key>
  <string>$HOME/.config/cabinet/launchd.out.log</string>

  <key>StandardErrorPath</key>
  <string>$HOME/.config/cabinet/launchd.err.log</string>
</dict>
</plist>
PLIST_EOF

mkdir -p "$HOME/.config/cabinet"

if launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null; then
  echo "[OK] 已加入开机自启（launchd）"
elif launchctl load "$PLIST" 2>/dev/null; then
  # 老版本 macOS 的写法
  echo "[OK] 已加入开机自启（launchd，legacy load）"
else
  echo "[!] launchctl 加载失败。手动检查："
  echo "    launchctl list | grep task-inbox"
  exit 1
fi

echo "     $PLIST"
echo
echo "说明：开机后自动起服务（就是 Cabinet 本身）。已有实例会跳过，不会起两个。"
echo "      改完代码用 stop.cmd / stop.command 停一下再启动即可。"
echo
echo "取消：./autostart.command off"
