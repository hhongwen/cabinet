#!/bin/bash
# mklinks.command —— 在桌面建两个快捷方式
#
# mac 上没有 .url，对应物是 .webloc（一个装 URL 的 plist）。
# 图标这块 mac 比 Windows 麻烦：.webloc 的自定义图标要走资源分支（Rez / SetFile），
# 需要 Xcode CLI 工具，而且新版 macOS 越来越不认。所以这里只做 .webloc，
# 不折腾图标 —— 一个能双击打开的东西比一个好看但打不开的东西有用。

set -u

cd "$(dirname "$0")" || exit 1

DESK="$HOME/Desktop"

make_link() {
  local name="$1" url="$2"
  local plist="$DESK/$name.webloc"

  # 已存在就先删，plutil 不会覆盖
  rm -f "$plist"

  if ! plutil -create xml1 "$plist" 2>/dev/null; then
    echo "[!] plutil 不可用，跳过 $name"
    return 1
  fi

  plutil -insert URL -string "$url" "$plist" || {
    echo "[!] 写 $name 失败"
    rm -f "$plist"
    return 1
  }

  echo "[OK] $name → $plist"
}

make_link "任务看板" "http://127.0.0.1:46001/"
make_link "随手记"   "http://127.0.0.1:46001/?solo=1"

echo
echo "提示：这两个只是 URL 快捷方式，双击会用默认浏览器开一个普通标签页。"
echo "      想要 Windows 那种无边框独立窗口，用 start.command —— 它会调 Chrome 的 --app 模式。"
