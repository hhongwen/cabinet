# Cabinet 桌面运行时契约（D1A）

> 日期：2026-11-26  
> 依据：`c136bff`（Windows 打包与 D0 验收完成后的稳定形态）  
> 状态：已落盘。**代码是唯一真相**；本文件只记录不能悄悄漂移的约束，改动契约必须同时改测试与本文。  
> 上游：[桌面迁移规划](../plans/desktop-migration.md)、[ROADMAP](../../ROADMAP.md)

## 0. 分层与边界

| 层 | 负责 | 不负责 |
| --- | --- | --- |
| Renderer（board.html） | 展示、交互、前端状态 | 直接访问数据库、执行命令、读写文件 |
| Preload | 白名单 IPC：凭据、选目录 | 通用 Node API、ipcRenderer 原样透出 |
| Electron Main | 单实例、窗口、托盘、通知、退出协调 | 任务规则、SQLite、Agent 进程 |
| Runtime（`task-inbox/runtime.mjs`） | 数据锁、初始化/迁移、恢复、HTTP、Agent 生命周期 | 窗口与桌面 UI |
| Storage（`storage.mjs` + `core.mjs`） | SQLite、迁移、备份 | 业务决策 |
| Agent Adapter | 外部 CLI 调用、事件解析、状态核对 | 跨任务分配 |

Node 独立模式（`node server.mjs`、`cli.mjs`）与桌面模式共用同一份业务代码；Electron 只是宿主。

## 1. Runtime Contract

**入口**：`openRuntime()` / `main()`（`task-inbox/runtime.mjs:48`、`:124`）。`server.mjs` 只提供 `createHandler`（`:504`）与 `start`（`:1250`）。

| 阶段 | 行为 | 证据/位置 |
| --- | --- | --- |
| 启动 | 先拿数据锁，再 `core.init()`（建库/迁移/归档扫描） | `runtime.mjs:48-97` |
| ready | UtilityProcess 回传 `{ port, url, dataDir }`；Main 最多等 15 秒，超时为 `ETIMEOUT` | `electron/main.mjs:86-120` |
| health | `GET /api/ping` 返回 `version/pid/stale/node`；**端口不是身份**，数据锁才是 | `server.mjs` `buildInfo()` |
| 启动失败 | `ELOCKED` / `EPORTS` / `ETIMEOUT` 分别给出人话提示并退出，不出现空引用 | `electron/main.mjs:337` |
| 关停 | 关 HTTP → 停 Agent Runner（中止在跑 Turn）→ 关库（WAL checkpoint）→ 释放锁 | `runtime.mjs:52-80`、`agent.mjs:383` |
| 失败收尾 | 启动过程中抛错也必须释放本实例的锁与半开的库 | `runtime.mjs` `catch → stop()` |

**约束**

- Main 不得直接读写业务库；Runtime 不得管理窗口。
- 端口回退（46001→46005）不能绕过数据锁；同目录第二个实例必须被拒。
- CLI 是唯一例外：普通读写直接走 `core`（WAL 多进程安全）；`init`/迁移必须先拿数据锁（`task-inbox/cli.mjs:183`），服务在跑时明确拒绝。

## 2. Data Contract

**业务数据目录**：`~/.config/cabinet/`，可用 `TASK_INBOX_DATA` 整体覆盖。

```text
tasks.db              业务真相（WAL）；另有 -wal / -shm
tasks.json            旧版本遗留，迁移后改名留档
images/               贴进来的图（core.mjs:68）
files/                其他附件（core.mjs:69）
sessions/             每轮 Agent 事件 JSONL（core.mjs:1872）
settings.json         旧版设置，首次建库并入 settings 表
server.lock           Runtime 数据锁
```

- `logs/`、`backups/` 是桌面模式**计划新增**，当前不存在，写之前必须先建目录。
- Electron `userData`（`%APPDATA%\Cabinet`、`~/Library/Application Support/Cabinet`）只放窗口配置与 Chromium 缓存，**不得指向业务目录**。
- 备份用 `VACUUM INTO`（`node cli.mjs backup`）或正常关库后复制；**不得直接复制活跃 WAL 的单文件**。
- 迁移只在 `core.init()` 里发生；迁移前后都不得静默新建空库。

## 3. Instance Contract

| 锁 | 归属 | 行为 |
| --- | --- | --- |
| 桌面实例锁 | `app.requestSingleInstanceLock()` | 第二个进程只激活已有窗口，不起第二个 Runtime（`electron/main.mjs:59`） |
| Runtime 数据锁 | `acquireDataLock()`（`server.mjs:114`） | `wx` 原子创建；`{ pid, id, started_at }`；过期锁用 rename 抢占；释放只删自己 `id` 的锁 |

- 冲突时返回 `ELOCKED`，附带占用者 pid；**不自动杀进程、不靠端口回退绕开**。
- 拿到锁必须在恢复 Turn、打开可写库**之前**；退出只释放本实例拥有的锁。
- 已知限制：PID 复用无法完全排除（未校验进程启动时间），属可接受的单机风险。

**验收**：`test-lock` 15 项，含 6 进程同时抢锁仅 1 成功、过期锁回收、坏锁回收、误删保护；`test-agent-http` 的锁用例；桌面重复启动实测。

## 4. Agent Contract

- 一张卡下可有多个角色 Session；**同一 Session 同时只允许一轮**（`openTurn` 检查 + 部分唯一索引），运行中再发返回 `409`。
- Turn 状态：`queued → running → completed | failed | interrupted | unknown`。
- 停止语义：`runtime.stop()` / `runner.close()` 中止在跑 Turn，落 `interrupted`，**不自动重跑**有副作用的 Turn；异常退出后未确认的 Turn 落 `unknown`，等待核对。
- 恢复不等于重跑：`runner.recover()` 启动时把未完成 Turn 收成 `unknown`，再用 `reconcile` 对外部 Session；`turnCount` 与外部 Session ID 必须保留。
- 工作目录在首轮发送后不可更改。
- Turn 终态事件：`core.onTurnFinished`（`core.mjs:78`）只读广播；监听器抛错不影响落库；桌面通知只消费该事件，渲染层不能自弹。
- Electron 差异集中在一处：`ELECTRON_RUN_AS_NODE=1` 只设在 `runtime-host` 内、供 Runtime 的子进程使用；**不得**放进 `utilityProcess.fork` 的 env（会让子进程直接 exit 9）。

**验收**：`test-events` 8 项；打包环境两轮 OpenCode（`turn_count=2`）；重启后外部 Session ID 不变、`reconcile` 末轮 `completed`；运行中 `stop()` 实测 Turn 落 `interrupted`、`openTurns=0`、无后代进程残留。

## 5. Security Contract

| 面 | 约束 |
| --- | --- |
| 凭据 | 每个应用进程一份 32 字节随机 token；只经 preload 的 `sendSync` 交给本窗口；**URL 永不携带**（`?t=` 已移除） |
| Cookie | Header 首次认证成功后下发 `cabinet_sid`（由 token 派生、`HttpOnly; SameSite=Strict; Path=/`），供 `<img src>` 与桌面附件下载 |
| 保护范围 | `/api/*`、`/images/*`、`/files/*`；页面本身（`/`、`/quick`）可匿名加载，否则窗口打不开 |
| Host/Origin | 端口参与身份判定：只接受 `127.0.0.1:<port>` 或 `localhost:<port>`；不符返回 403（`server.mjs:567-575`） |
| 页面 | 下发 CSP（`default-src 'self' data: blob:`、`img-src` 放行 https、inline 样式/脚本）、`frame-ancestors 'none'` |
| IPC | 白名单只有 `cabinet:token`、`cabinet:pick-directory`；每个 handler 校验 `e.sender === 本窗口`；不暴露 `exec`、任意 `readFile`、原始 `ipcRenderer` |
| 导航 | `will-navigate` 限死在 Runtime 地址；`window.open` 只把 http(s) 交给系统浏览器，其余一律 deny；禁止 webview；权限请求一律拒绝 |
| 附件 | 桌面模式点击后带 Header 拉取再下载（不开新窗口）；浏览器模式保持原新窗口行为 |
| 通知 | 只由 Runtime 的 Turn 事件触发 |

**验收**：`test-auth` 14 项（无凭据 401、Header/Cookie 放行、URL 凭据无效、Host/Origin 拒绝、CSP 存在、图片 403/404 路径）。

## 6. 契约与测试映射

| 契约 | 自动化 | 手工/打包 |
| --- | --- | --- |
| Runtime | `test-runtime` 10 项 | 打包 `--smoke`、启动失败提示 |
| Data | `test-sqlite` 412 项 | 真实库只读拷贝核对（29 任务/5 图/Session/Turn/事件文件） |
| Instance | `test-lock` 15 项 | 桌面重复启动只激活窗口；独立服务冲突 ELOCKED |
| Agent | `test-agent` 89、`test-agent-http` 47、`test-events` 8 | 打包两轮 OpenCode、重启核对、运行中 stop |
| Security | `test-auth` 14 | 未授权请求 401、页面 200 |

`npm test` 合计 681 项 + `style-audit`（0 error）。

## 7. 已知缺口（不假装已覆盖）

- macOS DMG 与签名未做（需在 Mac 上构建）。
- 桌面「还有任务在跑」退出确认框、真实 Turn 结束通知未人工点过。
- D0-09 未做渗透式验证；Cookie 与 Header 在本机进程威胁模型下等价，未额外加固。
- 从桌面图标 / Finder 启动时的 PATH 未逐项实测（PATH 剥离冒烟只证明不依赖系统 Node）。
- 消息附件与文件附件在当前真实库无样本，未逐项覆盖。
- 休眠/断电恢复、Runtime 崩溃受限重启属于 D1B，未进入本契约。

## 8. 变更规则

1. 契约变更先改代码与测试，再同步本文；不接受“文档写一套、代码跑一套”。
2. 任何新增 IPC 能力必须同时：语义化命名、sender 校验、参数收敛、本文表格登记。
3. 任何新增数据目录或文件必须登记到 Data Contract，并明确是否进备份。
4. 任何绕过数据锁的路径（端口回退、直接 `start()`）视为回归。
