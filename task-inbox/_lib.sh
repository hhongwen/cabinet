#!/bin/bash
# _lib.sh —— mac 启动脚本共用的几个函数
#
# 被 serve.command / start.command / install.command source 进来。
# 不是给人双击的，所以不放可执行说明。

# 端口探测范围必须和 server.mjs 里的 FALLBACK_PORTS 一致。
# server.mjs 的端口被占时会自动往后挪，所以这里不能只认 46001 ——
# 否则第二个实例挪到 46002，脚本就永远找不到它，
# 还会以为「服务没起来」去起第三个。
TI_PORTS=(46001 46002 46003 46004 46005)

# 找到一个已经在跑的服务，把 base URL 打到 stdout。找不到返回 1。
find_base() {
  local p
  for p in "${TI_PORTS[@]}"; do
    if curl -s --max-time 1 "http://127.0.0.1:$p/api/ping" -o /dev/null 2>/dev/null; then
      echo "http://127.0.0.1:$p"
      return 0
    fi
  done
  return 1
}

# 等某个端口起来。最多等 $1 秒。起了返回 0。
wait_port() {
  local want="$1" i
  for ((i = 0; i < want * 2; i++)); do
    if curl -s --max-time 1 "http://127.0.0.1:$want/api/ping" -o /dev/null 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

# node 必须在，且版本够跑 node:sqlite
# 版本门槛和 install.cmd 一致：< 22 直接拦，22 警告可能要 --experimental-sqlite
require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "[X] 找不到 node。先装 Node.js：brew install node"
    return 1
  fi
  local major
  major=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)
  if [ "$major" -lt 22 ]; then
    echo "[X] Node $major 太旧，需要 22.5+（推荐 24+）。"
    echo "    升级：brew upgrade node"
    return 1
  fi
  if [ "$major" -eq 22 ]; then
    echo "[!] Node 22：node:sqlite 可能要 --experimental-sqlite，推荐升到 24+"
  else
    echo "[OK] node $(node -v)（node:sqlite 内置）"
  fi
  return 0
}
