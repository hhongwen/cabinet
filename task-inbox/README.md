# Task Inbox

> 想到什么丢进来，模型判断它是什么、多重要、属于哪个项目，
> 再整理成一份能直接派给 Agent 的需求说明。

不是自动化流水线，是**收件箱**。收和聊是两件事，分开做。

---

## 一分钟装好

**Windows**

```cmd
install.cmd
```

**macOS**

```bash
./install.command     # 或在 Finder 里双击 install.command
```

四件事：查 node、同步到 Alma 插件目录、通知热重载、等端口起来。

想要桌面快捷方式和开机自启：

| | Windows | macOS |
|---|---|---|
| 桌面快捷方式 | `mklinks.cmd` | `./mklinks.command` |
| 开机自启 | `autostart.cmd` | `./autostart.command` |
| 取消自启 | `autostart.cmd off` | `./autostart.command off` |

mac 的开机自启走 launchd（`~/Library/LaunchAgents/com.cabinet.task-inbox.plist`），
plist 里写的是 node 的绝对路径 —— launchd 的 PATH 很短，brew 装的 node 找不到。

> **从 Windows 拷过来的仓库**：`.command` 文件必须是 LF 换行、带可执行位。
> 仓库里已经有 `.gitattributes` 管换行，`install.command` 会补 `chmod`。
> 如果是压缩包传过去的，先跑一次 `chmod +x *.command`。

## 怎么打开

| 方式 | Windows | macOS |
|---|---|---|
| 整页 | `start.cmd` | `./start.command` |
| 只开随手记 | `start.cmd quick` | `./start.command quick` |
| 直接访问 | http://127.0.0.1:46001/ | 同左 |
| 命令行 | `node cli.mjs ls` | 同左 |

启动脚本都先探端口，已经在跑就直接开窗。

**独立窗口**用 `chrome --app`（或 Edge）。Windows 走 `window.cmd`，
mac 走 `start.command` 里的 `open -na`，两者都是无地址栏无标签页的独立窗口。
mac 上没有 Chromium 系浏览器就退回默认浏览器普通标签页 —— 功能不缺，只是没有独立窗口。

## 跨平台

核心逻辑（`core.mjs` / `server.mjs` / `classify.mjs` / `brief.mjs` / `chat.mjs` / `cli.mjs` / `board.html`）
是纯 Node + 标准库，没有一处 import 宿主 API，Windows 和 macOS 跑的是同一份代码。
平台差异只在三个地方，都做了分支：

| 能力 | Windows | macOS |
|---|---|---|
| 选文件夹对话框 | `pickdir.ps1` + PowerShell | `osascript` 的 `choose folder` |
| 浏览器独立窗口 | `window.cmd` + `chrome --app` | `start.command` + `open -na --args` |
| 开机自启 | Startup 文件夹放 `.cmd` | launchd LaunchAgent |
| CLI 兜底通道 | `%APPDATA%\npm` 下的 `.exe` / `.js` | `/opt/homebrew`、`/usr/local` 下的 `lib/node_modules` |

Linux 没专门适配，但选文件夹会**自动降级**到页面里逐层点目录（`/api/browse`），
其余部分理论上直接能跑。

### 界面操作

| 操作 | 效果 |
|---|---|
| 底栏输入 | Enter 存下 · Shift+Enter 换行 · Ctrl+V 贴图 |
| 点卡片 | 右侧滑出抽屉（详情 + 对话） |
| 拖卡片 | 换列 |
| 点侧栏状态/项目 | 筛选，再点取消 |
| 侧栏 `‹` | 收起侧栏，左上角小按钮再展开 |
| 按 `n` | 聚焦底栏 |
| 按 `,` | 打开设置 |
| 按 `[` | 收起 / 展开底栏 |
| 按 `Esc` | 先收右侧文档预览 → 再关抽屉 → 关放大图（一层一层退） |

---

## 命令行

```
node cli.mjs                          看所有任务
node cli.mjs add "买咖啡豆"            加一条
node cli.mjs add "写周报" -p 工作 --p0 -c 工作
node cli.mjs ls --todo                只看未开始
node cli.mjs ls --json                给程序看的输出
node cli.mjs move <id> doing          换列
node cli.mjs done <id>                标完成
node cli.mjs rm <id>                  删除
node cli.mjs init                     初始化数据目录
node cli.mjs export [文件]            导成 tasks.json（给迁移 / 审阅 / diff）
node cli.mjs backup [文件]            热备份成 .db（服务在跑也能备）
```

优先级：`--p0` 阻塞 / `--p1` 紧急 / `--p2` 常规 / `--p3` 低 / `--p4` 待定（默认）。

`export` 写出来的就是老 `tasks.json` 的形状 —— 跟迁移代码认的格式一致，
所以它既是备份，也是一个能原样倒回去的迁移包。不传路径就落在数据目录，
文件名带时间戳。

---

## 三个入口，一份数据

```
            随手记（Ctrl+V 贴图 / Enter 存下）
                      ↓
对话里说一句 ────→  tasks.db  ────→  看板（拖拽换列）
                      ↑                    ↑
                  CLI 命令            独立窗口 / 浏览器
```

---

## 自动判断

丢进去就行，不用选类型也不用选优先级。收下时**立刻返回**（10~40ms），
模型在后台跑，卡片上短暂显示「判断中…」，完成后自动刷新。

### 优先级 P0–P4

| 级别 | 含义 | 典型场景 |
|---|---|---|
| P0 | 阻塞 | 核心业务中断、线上故障、严重安全漏洞 |
| P1 | 紧急 | 核心功能受限、即将到期的关键需求 |
| P2 | 常规 | 常规迭代、一般体验优化、普通 bug |
| P3 | 低 | 小优化、技术债、长期探索 |
| P4 | 待定 | 文案微调、极低频边缘问题 |

判据是**看后果，不看语气**。轻描淡写说「数据库偶尔断」是 P0；
加三个感叹号说「周报字号要改」还是 P4。

### 类型

`text` / `image` / `image_text` / `link` / `file` / `mixed`。
附件支持任意类型，**文本类会读内容片段**参与判断，
非文本按扩展名和大小描述。

---

## 项目：名字 + 别名 + 目录

```json
{
  "name": "诺华-数据分析平台",
  "aliases": ["诺华", "novartis", "NVRP"],
  "dirs": [
    { "path": "D:/WorkFiles/code/novartis", "note": "主后端", "primary": true },
    { "path": "D:/WorkFiles/code/nvrp-adm", "note": "管理后台" }
  ]
}
```

**别名的目录名都会喂给模型**，所以「提到 NVRP」和「提到 nvrp-adm」
都能归到同一个项目。

怎么管：`⚙`（或按 `,`）→ 「项目」区 → 点一行编辑 / `+ 新建项目`。
目录行右边的 📁 会弹系统原生的选择文件夹对话框。

**判不出来怎么办**：卡片上出现橙色「选项目」徽章。点它输入名字，
已有项目就归过去，不存在的**当场建一个再归过去**。

---

## 卡片抽屉

点卡片右侧滑出，三块：

1. **头部**：标题 + 标签（优先级 / 项目 / 类别 / 状态）+ 三个下拉直接改
2. **详情**：原始描述 / 图片 / 附件 / 整理后的需求，每段可折叠
3. **对话**：说的每句话都会改动任务本身

### 对话不是聊天，是操作

模型返回结构化补丁，不是只回一段话：

```json
{ "reply": "行，改成 P2", "patch": { "priority": "p2" } }
```

- 「改成 P1」→ 真改优先级
- 「这不是诺华的，是欧加隆的」→ 真换项目，顺手把标题里的一起改
- 「你觉得该怎么修」→ 只回话，patch 为空

### 整理后的需求

「生成需求」按钮会读原文、附件内容、项目目录、已有对话，
输出五段：**目标 / 背景 / 要做的事 / 验收标准 / 风险待确认**。

原文没提的关键信息（指标、截止时间、具体模块）会写进「待确认」提问，
**不会自己拍板**。生成过一次就缓存，点「重新生成」才覆盖。

### 文档预览（右侧展开）

抽屉里那块详情区最高只有 44vh，一条需求常常只露出三分之一。
需求卡片上的「展开」会把抽屉拉宽成左右两栏：左边照旧改字段、对话，
右边一整条高度都是文档。

- 两栏之间那条线可以拖，宽度记在 `localStorage`（`ti.drPaneW`）
- 「需求说明 / 原始描述」两个页签，外加一个「复制」拿 markdown 原文
- 窗口窄于 1080px 时不分栏，预览直接铺满抽屉 —— 各剩 400 宽谁都读不下去
- markdown 支持标题 / 列表 / 粗体 / 行内代码 / 链接 / 引用 / 分隔线 /
  围栏代码 / 表格。**没有引第三方库**，全部在 `board.html` 的 `mdToHtml()` 里，
  约 90 行；文本一律先 `esc()` 再拼标签，链接只放行 `http(s)://` 和 `/`

---

## 模型接入：三条通道自动降级

按顺序探测，第一个能用的就走：

| 顺序 | 通道 | 地址 | 图片 | 特点 |
|---|---|---|---|---|
| 1 | **magpie** | `127.0.0.1:3425/v1` | base64 直接给 | 最快，不要 key |
| 2 | **alma** | `localhost:23001` | 先传 gallery 换 url | 要 Alma 在跑 |
| 3 | **opencode** | CLI | ✗ | 进程启动慢，纯兜底 |
| 4 | **codex** | CLI | ✗ | 同上 |

`GET /api/backend` 看当前哪几条通。

### 在页面上选

`⚙`（或按 `,`）：

- **模型通道** —— auto / magpie / alma / opencode / codex
- **模型** —— 输入框带下拉，65 个模型现拉，标了哪些支持图片
- **开关** —— 关掉就只收不判

保存立刻生效，不用重启。

设置存在 `tasks.db` 的 `settings` 表里（键值）：

```json
{ "backend": "auto", "model": "auto/deepseek-v4.1-flash", "classify": true }
```

老版本存在 `settings.json`，首次建库时一并搬进 `settings` 表。

### 为什么优先 magpie

OpenAI 兼容，少一跳，图可以直接给 base64：

```json
{ "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
```

走 Alma 就没这么舒服 —— 必须先 POST `/api/attachments/image` 换成
`http://localhost:23001/api/gallery/cache/xxx.png` 才能用，否则模型说「没看到图片」。

### 不需要把 Cabinet 接进 magpie 的 agents

`magpie ls` 里那些是 **agent 配置**（管某个 CLI 用哪个模型、什么推理强度）。
Task Inbox 要的是「问一句拿个 JSON」，属于**调模型**不是**派 agent**。
走 `/v1/chat/completions` 就够了。

---

## 数据

```
~/.config/alma/task-inbox/
  tasks.db        ← SQLite，唯一真相（WAL 模式）
  tasks.json      ← 老版本遗留，首次建库时自动迁进来，之后不再读
  images/         ← 贴进来的图
  files/          ← 附件
```

⚠️ **不要**放到 `~/.config/alma/tasks/` —— 那是 Alma 自己的任务队列，
写进去会被 Alma 覆盖，读回来永远是空。

用 SQLite 而不是整份 JSON 重写，是为了**多进程安全**：插件（Alma 进程内）和
`serve.command` 起的独立服务可能同时在跑，还可能加上 CLI。JSON 全量重写会互相
覆盖，WAL + `busy_timeout` 不会。

五张表：

| 表 | 装什么 |
|---|---|
| `tasks` | 任务本体。`payload` 是 JSON 字符串（text / images / files / urls） |
| `messages` | 卡片抽屉里的对话，`ON DELETE CASCADE` |
| `projects` | 项目，`aliases` / `dirs` 也是 JSON 字符串 |
| `settings` | 通道、模型这类键值 |
| `meta` | 库版本号，迁移用 |

老数据自动迁移：建库时如果目录里还有 `tasks.json` 而且 `tasks` 表是空的，
会一次性导入，然后把 JSON 改名留档。**不删任何东西。**

`claimed_by` 是给以后 agent 领任务留的。领的时候用条件更新：

```sql
UPDATE tasks SET status='doing', claimed_by=?
WHERE id=? AND status='todo'
```

看影响行数是不是 1。两个 agent 同时抢，只有一个抢得到。

---

## 部署：两种跑法

### 作为 Alma 插件

`install.cmd` 之后自动加载，状态栏显示待办数。

### 作为独立服务

```cmd
serve.cmd       探端口，没人就跑起来（开机自启用这个）
```

**为什么需要这个**：插件起的服务跑在 Alma 进程里，Alma 一关就没了。
装过一次 `autostart.cmd` 之后，开机先起独立服务，Alma 启动时看到端口已占
就复用 —— 谁第二谁复用，不会跑出两个实例。

| Alma | 独立服务 | 页面能开吗 |
|---|---|---|
| 开 | 开 | ✅ |
| 开 | 关 | ✅ |
| 关 | 开 | ✅ |
| 关 | 关 | ❌ |

---

## 文件结构

```
task-inbox/
  core.mjs       任务逻辑（纯 Node，不依赖任何宿主）
  storage.mjs    SQLite 底层：驱动探测 + 建表 + 语句包装
  server.mjs     HTTP 服务（可独立跑，也可作插件）
  main.mjs       Alma 插件外壳：注册工具 + 状态栏
  classify.mjs   判类型 / 优先级 / 项目
  brief.mjs      整理成需求说明
  chat.mjs       卡片抽屉里的对话
  backend.mjs    模型通道与降级
  browse.mjs     目录浏览
  cli.mjs        命令行
  pickdir.ps1    Windows 选文件夹对话框（mac 用 osascript，写在 server.mjs 里）
  board.html     全部界面（单文件，无构建）
  STYLE.md       样式规范：三层材质 / 颜色 / 控件总则 / z-index / 降级
  style-audit.mjs 样式体检脚本（提交前跑，见下）

  # Windows
  install.cmd / start.cmd / serve.cmd / window.cmd / mklinks.cmd / autostart.cmd

  # macOS
  install.command / start.command / serve.command / mklinks.command / autostart.command
  _lib.sh        mac 脚本共用：端口探测 / 等端口 / 查 node
```

`core.mjs` 和 `server.mjs` 都不 import 宿主 API，所以插件只是个外壳。

### 改样式之前

界面全在 `board.html` 一个文件里，改之前读 [STYLE.md](STYLE.md)，改完跑：

```bash
node style-audit.mjs
```

它会拦住几类最常见的跑偏：`:root` 外写死颜色、绕过控件总则自己重写按钮材质、
重复定义同一个选择器、白字配 `--orange`（对比度不够）、玻璃层漏登记降级。

`board.html` 里那三段 `@supports` / `@media (prefers-reduced-*)` 是材质降级，
新增任何 `backdrop-filter` 都要去登记，否则老浏览器上会糊成一片。

---

## 已知限制

### 项目自己的问题

完整的清单在 [ISSUES.md](ISSUES.md)，带证据和复现步骤。

**2026-11-23 修掉的一批**（每条的证据和踩坑都在 [ISSUES.md](ISSUES.md)）：

| 原来 | 现在 |
|---|---|
| 改了代码不重启不生效，还看不出来 | `/api/ping` 和 `/api/state` 带 `stale`；磁盘代码比进程新时页面顶部挂黄条；`install.cmd` 装完自动停旧服务 |
| 「选项目」徽章从不出现 | `needs_project` 真的进了库（schema v2，迁移机制同时补上） |
| 删任务后附件永久残留 | 删任务时一起清附件，且只清 payload 里指向本目录的文件 |
| 超 12 MB 传不上去，报错 `fetch failed` | 请求体上限 40 MB，超限返回 413 和一句人话；附件 25 MB、图片 12 MB 都真的能到 |
| 分类卡在「判断中…」永不恢复 | 启动时把超 5 分钟的 `pending` 收成 `failed` |
| 界面不能删任务 | 抽屉右上角「删」，带确认和附件数提示 |
| 每 3 秒全量轮询，后台也拉 | 隐藏时不轮询；轮询带 `?since=`，库没变只回 150 字节且不重绘（401 条时省 99.9%） |
| 首屏失败只插一行红字 | 有「重试」按钮 |
| 没有备份 / 导出 | `node cli.mjs export` 导出 tasks.json 形状 / `backup` 用 VACUUM INTO 热备 |
| classify / chat 没有测试 | `node test-parsers.mjs`，65 项，假 backend 覆盖畸形输出、patch 白名单、队列与路由 |
| 分类失败后完全没救（点都没得点） | 抽屉里有「未判断 · 重试」；PATCH 也不再能写 `classify_*` 造出卡死态 |
| 分类排队用 `setInterval` 空转 | 显式等待队列；`/api/backend` 带 `queue:{running,waiting}` 水位 |

**还留着的只有两条，且都要等规模上来**：搜索、分页（任务过 100 条再做）。
详见 [ISSUES.md](ISSUES.md)。

### 测试

```bash
node test-sqlite.mjs    # 存储层，100 项
node test-parsers.mjs   # classify / chat 解析层 + 队列路由，65 项，不碰真模型
node style-audit.mjs    # 界面样式规范
```

### Alma 插件系统本身的缺口（不是本项目的 bug）

1. **状态栏点击没接线** —— 后端注册了，渲染层没监听。只能当指示器。
2. **`contributes.components.sidebar` 是空壳** —— schema 接受，前端无消费代码。
3. **`ui.openExternal` 在无头模式只打日志** —— 不真的开浏览器。
4. **卸载插件不清理状态栏项** —— 要重新激活同名插件手动 dispose。

---

## 下一步

**先修问题，再加功能。** 顺序见 [ISSUES.md](ISSUES.md) 末尾，
路线图见 [../ROADMAP.md](../ROADMAP.md)。

当前的方向是「多 Agent Session 协作」，但在开始之前要先清掉
[ISSUES.md](ISSUES.md) 里的 P0 和 P1 —— 那些是已经坏了、或者马上会坏的东西。
带着这些问题做 Session，同一个坑会重复三次。

---

*2026-11-20 起 · 2026-11-23 重构*
