# Task Inbox

把「想到的事」收进来，再决定什么时候做。

不是自动化，是收集。Cabinet 那套是「事件进来 → agent 自己干完」，
这个是「我先收下 → 回头再说」。

---

## 一分钟装好

```cmd
install.cmd
```

它会做完四件事：检查 node、把文件同步到 Alma 插件目录、通知 Alma 热重载、等端口起来。

想要桌面快捷方式：

```cmd
mklinks.cmd
```

---

## 怎么打开

**一个页面，两栏。** 左边看板，右边随手记，中间一条可拖动的分隔条。

| 方式 | 命令 | 说明 |
|---|---|---|
| 整页 | `start.cmd` | 起服务 + 开独立窗口（1280×900） |
| 只开随手记 | `start.cmd quick` | 起服务 + 开小窗（460×340），隐藏看板 |
| 直接访问 | http://127.0.0.1:46001/ | 浏览器 |
| 命令行 | `node cli.mjs ls` | 不开任何界面 |

`start.cmd` 会先探一下端口。已经有一个在跑就直接开窗，不会重复起服务。

**独立窗口**用的是 `chrome --app`（或 Edge），没有地址栏、没有标签页，
Alt+Tab 能直接切回来，不像普通网页标签那样淹没在一堆页面里。

### 布局操作

| 操作 | 效果 |
|---|---|
| 拖动中间的分隔条 | 调两栏宽度（240px ~ 屏宽 60%） |
| 双击分隔条 | 宽度复位到 340px |
| 点右上角 `»` | 收起随手记，看板变全宽 |
| 点右下角「📝 随手记」 | 重新展开 |
| 按 `[` | 收起 / 展开随手记 |
| 按 `n` | 聚焦输入框（收着会自动展开） |
| `Enter` | 存下 |
| `Ctrl+V` | 贴图 |
| `Shift+Enter` | 输入框内换行 |

宽度和折叠状态记在 localStorage，下次打开还是你调好的样子。

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
```

`--p0` 紧急重要 / `--p1` 重要 / `--p2` 紧急 / `--p3` 普通（默认）。

---

## 三个入口，各管一段

```
            随手记（Ctrl+V 贴图 / Enter 存下）
                      ↓
对话里说一句 ────→  tasks.json  ────→  看板（拖拽换列）
                      ↑                    ↑
                  CLI 命令            独立窗口 / 浏览器
```

数据只有一份，三个入口读写同一个文件。

---

## 文件结构

```
task-inbox/
  manifest.json   Alma 插件清单
  main.mjs        插件外壳：注册工具 + 状态栏
  core.mjs        存储逻辑（纯 Node，不依赖 Alma）
  server.mjs      HTTP 服务（可独立跑）
  cli.mjs         命令行
  board.html      看板 + 随手记（同一页，?solo=1 只留随手记）
  install.cmd     安装
  mklinks.cmd     桌面快捷方式
  start.cmd       起服务 + 开窗
  window.cmd      浏览器探测与开窗
```

**关键设计**：`core.mjs` 和 `server.mjs` 都不 import 任何 Alma API。
所以 `node server.mjs` 能单独跑，插件只是它的一个宿主。

这意味着：Alma 关了，服务还在；Alma 换了，数据还在。

---

## 数据在哪

```
~/.config/alma/task-inbox/tasks.json     ← 唯一真相
~/.config/alma/task-inbox/images/        ← 贴进来的图
```

⚠️ **不要**放到 `~/.config/alma/tasks/` —— 那是 Alma 自己的任务队列，
写进去会被 Alma 覆盖，读回来永远是空的。第一版就踩过这个坑，
现在文件里带 `version` 字段做签名，形状不对会拒绝读写而不是默默覆盖。

---

## 数据模型

所有入口塌成同一个结构。加新入口（语音、PDF）只加 `kind`，不动表结构。

```json
{
  "id": "t_xxx",
  "title": "一句话说清要做什么",
  "kind": "text | image | image_text | link",
  "payload": { "text": null, "images": [], "urls": [], "path": null },
  "project": "默认",
  "category": "工作",
  "status": "todo | doing | done",
  "priority": "p0 | p1 | p2 | p3",
  "note": "",
  "source": "chat | panel | quick | cli",
  "claimed_by": null,
  "created_at": "...",
  "updated_at": "...",
  "doing_at": null,
  "done_at": null
}
```

`claimed_by` 是给以后 agent 领任务留的。领的时候用条件更新：

```
UPDATE tasks SET status='doing', claimed_by=?
WHERE id=? AND status='todo'
```

看影响行数是不是 1。两个 agent 同时抢，只有一个抢得到。

---

## 为什么用 JSON 不用 SQLite

插件跑在 Alma 的 Electron 进程里，`node:sqlite` 不一定有。
几百条任务用 JSON 完全够，写入走「临时文件 + rename」，
中途崩溃不会留下半个文件。

真要换 SQLite，改 `core.mjs` 一个文件就够了。

---

## 自动判断类型和优先级

**不用再选"这是文字还是截图"，也不用选 P0 还是 P3。** 丢进去就行。

收下之后立刻返回（实测 10~40ms），模型在后台判断，判断完看板自动更新。
卡片上会短暂显示「判断中…」，跑完变成真实的优先级和类别。

判断依据是 P0-P4 五级制：

| 级别 | 含义 | 典型场景 |
|---|---|---|
| P0 | 阻塞 | 核心业务中断、线上故障、严重安全漏洞 |
| P1 | 紧急 | 核心功能受限、即将到期的关键需求 |
| P2 | 常规 | 常规迭代、一般体验优化、普通 bug |
| P3 | 低 | 小优化、技术债、长期探索 |
| P4 | 待定 | 文案微调、极低频边缘问题、可能永远不做 |

关键：**看后果，不看语气。** 你轻描淡写地说"数据库偶尔断"会是 P0；
你在句尾加三个感叹号说"周报字号要改"还是 P4。

支持的输入类型（自动识别，不用选）：

- 文字 —— 想法、待办、一句话
- 图片 —— Ctrl+V 粘贴、拖进来、点 📎
- 附件 —— PDF / Word / Excel / 代码 / 压缩包，文本类会读内容判断
- 链接 —— 贴 URL 自动归成 link 类型
- 混合 —— 图 + 文字 + 附件一起来

图片会被上传到 Alma 的 gallery 再喂给模型（模型只能读 Alma 自己托管的 url，
直接给本地路径或自建服务的 url 都会失败 —— 这是实测出来的坑）。

配置：

```json
// 环境变量
TASK_INBOX_MODEL=auto/deepseek-v4.1-flash   // 默认这个，看图也够用
```

要换更准的模型，改这个环境变量即可。Alma 的 76 个模型里 75 个支持视觉。

---

## 模型接入：三条通道自动降级

不绑定任何一家。启动时按顺序探测，第一个能用的就走：

| 顺序 | 通道 | 地址 | 图片 | 特点 |
|---|---|---|---|---|
| 1 | **magpie** | `127.0.0.1:3425/v1` | base64 直接给 | 最快，不要 key，OpenAI 兼容 |
| 2 | **alma** | `localhost:23001` | 先传 gallery 换 url | 要 Alma 在跑 |
| 3 | **opencode** | CLI | ✗ | 进程启动慢，纯兜底 |
| 4 | **codex** | CLI | ✗ | 同上 |

`GET /api/backend` 能看到当前哪几条通。

### 为什么优先 magpie

它本身就是 OpenAI 兼容网关，走它比走 Alma 少一跳，而且**图片可以直接给 base64**：

```json
{ "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
```

走 Alma 就没这么舒服 —— 必须先 POST `/api/attachments/image` 换成
`http://localhost:23001/api/gallery/cache/xxx.png` 才能用，否则模型会说"没看到图片"。
（本地路径、dataUrl、自建服务 url 我都试过，全失败。）

### 在页面上选

点看板右上角的 **⚙**（或按 `,`），出来一个设置面板：

- **模型通道** —— auto / magpie / alma / opencode / codex
- **模型** —— 输入框带下拉，65 个模型现拉，标了哪些支持图片
- **开关** —— 关掉就只收不判，纯记事本

保存后**立刻生效**，下一条任务就用新设置，不用重启服务。

设置存在 `~/.config/alma/task-inbox/settings.json`：

```json
{
  "backend": "auto",
  "model": "auto/deepseek-v4.1-flash",
  "classify": true
}
```

### 环境变量（可选，覆盖设置文件）

```bash
MAGPIE_URL=http://127.0.0.1:3425/v1
ALMA_API_URL=http://localhost:23001
TASK_INBOX_CLI_TIMEOUT=60000
```

这两个只是改地址，不改选哪家 —— 选哪家在页面上点就行。

### 关于 magpie 的 agents

**不需要把 Cabinet 接进 magpie 的 agent 列表。**

magpie 里的 Codex / OpenCode / Claude Code 是「agent 配置」——它管的是
那些 CLI 用哪个模型、什么推理强度、配置文件写在哪。

Task Inbox 要的只是「问一句话拿个 JSON」，属于**调模型**，不是**派 agent**。
走 `/v1/chat/completions` 就够了，不会出现在 `magpie ls` 的输出里，也不需要。

真正需要接 agent 的时候是下一步：让 agent 自己领任务去干活。那时候才需要
`magpie ls` 看有哪些 agent，再用 `opencode run` 之类把它们叫起来。

---

## 已知的 Alma 限制

这四条不是本项目的 bug，是 Alma 插件系统当前的状态：

1. **状态栏点击没接线。** 后端注册了 `statusbar/execute`，
   但渲染层从没监听 `plugin-statusbar-update` / `plugin-statusbar-execute-command`。
   所以状态栏只能当指示器，点不动。
2. **`contributes.components.sidebar` / `artifactRenderers` 是空壳。**
   schema 接受，前端 bundle 里搜不到消费代码。
3. **`ui.openExternal` 在无头模式下只打日志**，不真的开浏览器。
4. **卸载插件不会清理状态栏项**，要重新激活同名插件手动 `dispose()`。

---

## 下一步（按优先级）

1. **开机自启**：把 `server.mjs` 放进启动目录，不依赖 Alma
2. **截图自动入箱**：`fs.watch` 附件目录 —— 但先确认不会变成噪音
3. **agent 领任务**：`claim` 接口 + 条件更新

---

*2026-11-20 起，2026-11-23 重构*

---

## 项目：一个名字，若干目录，自动归属

项目不再只是一个标签，它是一个实体：

```json
{
  "id": "p_xxx",
  "name": "诺华-数据分析平台",
  "aliases": ["诺华", "novartis", "NVRP"],
  "dirs": [
    { "path": "D:/WorkFiles/code/novartis", "note": "主后端", "primary": true },
    { "path": "D:/WorkFiles/code/nvrp-adm", "note": "管理后台" }
  ]
}
```

**别名**和**目录说明**都会喂给模型，所以判断时能认出来：

- 提到「诺华」「NVRP」→ 归到诺华
- 提到「nvrp-adm」→ 归到诺华
- 提到「00_Inbox」→ 归到知识库

### 怎么管

看板右上角 ⚙ → 「项目」区：

- 列出所有项目，显示目录和任务数
- 点一行 → 编辑名称 / 别名 / 目录
- 「+ 新建项目」→ 加一个
- 编辑里能「删除」→ 它下面的任务自动移到别的项目，不会丢

### 判断不出来怎么办

任务会带 needs_project 标记，卡片上显示黄色「选项目」徽章。

点它 → 弹输入框，可以：

- 输入已有项目名 → 归过去
- 输入一个不存在的名字 → 当场建项目再归过去

所以「判断失败」不是死路，是一次点击的事。

### 随手记不再有项目下拉

删了。发送时只带内容，项目交给模型判断。

---

## 选目录：点，不用敲

项目的每个目录行右边有个 📁 按钮，点开是目录浏览器：

- 从用户目录或已填路径出发，逐层点进去
- 顶部 ↑ 回上一级，路径框显示当前位置
- git 仓库 / 像项目的目录会有标记
- 选好点「选这个目录」，路径自动填回表单

浏览器里拿不到盘符（`<input webkitdirectory>` 只给相对路径），
所以这套目录浏览是服务端 `browse.mjs` 做的纯 HTTP 遍历。
插件跑在 Node 里，有完整 fs 权限，列目录没问题。

接口：

```
GET /api/browse               → 盘符 + 用户目录
GET /api/browse?path=D:\xxx   → 该目录的子目录、父目录、是否 git 仓库
```

---

## 选目录：先弹系统对话框

点目录行的 📁，**直接弹 Windows 原生的「选择文件夹」**，一次点完。

浏览器自己做不到这件事（`<input webkitdirectory>` 拿不到盘符，
`showDirectoryPicker` 也只给沙箱路径）。所以走服务端：
`server.mjs` spawn 一个 PowerShell，用 `FolderBrowserDialog` 弹窗，
把选中的路径回传给页面。

- `pickdir.ps1`：WinForms 对话框，带一个透明置顶窗体当 owner
  （不然 Alma 在后台时对话框会弹到后面，看着像没反应）
- `POST /api/pickdir { initial }`：起进程、等结果、回路径
- 取消返回 `path: null`，前端什么都不做
- 系统调用失败时自动退回页面里的逐层浏览（`browse.mjs`）

Linux/macOS 上没有这条路径，会直接走页面浏览。

---

## 目录对话框：Vista+ 风格

之前用的是 `FolderBrowserDialog`（老式树形控件，标题还是乱码），
现在换成 `IFileOpenDialog` + `FOS_PICKFOLDERS`：

- 就是 Win11 资源管理器那种界面：地址栏、搜索、详细信息、排序
- 标题用系统本地化的「选择文件夹」，不写死中文，绕开编码问题
- `.ps1` 存成 **UTF-8 with BOM** —— PowerShell 5.1 按 ANSI 读无 BOM 文件，
  中文必然乱码（这就是上一版显示「删除殡傍主妇绫 绔」的原因）

实现要点：COM 接口在 C# 里声明（`IShellItem` / `IFileOpenDialog`），
`Add-Type` 编译后调用；`SetFolder` 把初始路径设进去，用户从那儿开始。

---

## 卡片抽屉：对话即操作

点任意卡片，右侧滑出抽屉。里面三块：

1. 标题 + 标签（优先级 / 项目 / 类别 / 状态）
2. 三个下拉，直接改字段
3. 对话区 —— 说的每句话都会改动任务本身

### 对话不是聊天，是操作

模型必须返回结构化补丁，不是只回一段话：

```json
{ "reply": "行，改成 P2", "patch": { "priority": "p2" } }
```

所以：

- 「改成 P1」→ 真改优先级
- 「这不是诺华的，是欧加隆的」→ 真换项目，顺手把标题里的诺华也改掉
- 「你觉得该怎么修」→ 只回话，patch 为空

实测三种都对。纯讨论不会被硬塞字段改动。

### 接口

```
GET  /api/tasks/:id      任务 + 它的对话
POST /api/chat           { taskId, text } → { reply, patch, task, message }
POST /api/chat/clear     { taskId }
```

对话存在任务的 `messages` 字段里，最多留 200 条。

### 为什么对话挂在任务上

不是单独一张会话表。因为聊完要能立刻看到字段变了，而且
「这条任务被讨论过什么」本身就是它的状态。单独一张表反而要 join。

---

## 抽屉里的详情：原始 + 整理后的需求

抽屉顶部现在有四段，默认展开「原始描述」和「整理后的需求」：

| 区块 | 内容 |
|---|---|
| 原始描述 | 你当时写的那句话、链接 |
| 图片 | 缩略图，点开看大图 |
| 附件 | 文件名，链接到 `/files/` |
| 整理后的需求 | markdown，按「目标 / 背景 / 要做的事 / 验收标准 / 风险待确认」五段 |

### 为什么需要「整理」这一步

「诺华报表导出太慢」是一句抱怨，不是一个能派的活。派给 agent 之前得先有：

- 目标（可验证的）
- 涉及哪个目录（从项目的 dirs 里带）
- 验收标准（能客观判断的）
- 哪些信息缺失该问人

模型会把原文、附件内容、项目目录、已有对话一起读一遍，写出这五段。
**原文没提的，它会在「风险/待确认」里提问，而不是编。**

实测这段整理里，它正确识别出「底栏测试」有歧义，
并追问「是指底部栏功能、某个测试用例集，还是测试环境标识」。

### 生成与改

- 抽屉里点「生成需求」→ 调模型，几秒出结果，落库
- 已经有需求时不重复生成，直接显示缓存
- 点「重新生成」覆盖（`force: true`）
- 也可以直接改 `brief` 字段（`PUT /api/brief`）

接口：

```
POST /api/brief  { taskId, force? }  → { brief, brief_at }
PUT  /api/brief  { taskId, brief }   → 手改保存
```

---

## 界面：STEPX 硅银视觉语言

按 `stepx_silicon_silver_design_spec.md` 重构了整页。

### 设计令牌

```
--silver-50   #F1F3F3   页面背景
--silver-100  #DDE2E3   磨砂面板
--silver-300  #B7BFC2   结构边框
--slate-700   #566168   次要标签
--slate-900   #252B30   深色面板
--ink         #151A1E   正文
--orange      #FA4616   重点（Pantone 172C 近似）
```

橙只用于：主按钮、当前选中、关键数字。正文和边框全是银灰，不抢注意力。

### 结构映射

| 手机背面 | 页面 |
|---|---|
| 上部感知模块 | 顶栏：面包屑、状态灯、编号 |
| 右侧点阵屏 | 侧栏状态块（CORE / ONLINE + 进度条） |
| 下部智能核心 | 三列看板，每列是带角部直角的模块 |
| PCB 走线 | 背景 40px 网格，20% 透明度，向下渐隐 |
| 螺丝接缝 | 卡片 1px 描边 + 序号标签 |
| 橙色镜头圈 | 主按钮、当前选中项 |

### 侧栏

- 状态导航：全部 / 未开始 / 进行中 / 已完成，带实时计数
- 项目导航：从项目列表自动生成，点击筛选，再点取消
- 底部系统块：核心状态 + 七段橙色进度条
- 1100px 以下收窄成图标模式（只留图标）

### 和旧版的差别

- 深色主题 → 银灰浅色
- 浮卡阴影 → 细描边 + 内嵌感
- 蓝色强调 → 橙色单点强调
- 无侧栏 → 带状态/项目双段导航
