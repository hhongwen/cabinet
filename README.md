# Cabinet

> 内阁，也是文件柜。

**以任务为中心的多 Agent 协作工作台。**
想到什么丢进来，模型判它属于哪个项目、多重要；一张卡片下面挂多个 Agent 的
持久会话，让它们之间传递信息，人不用再当传话的。

目标是消掉这个位置：**我不该是它们之间的路由器和翻译。**

- 路线图与技术判断 → [ROADMAP.md](ROADMAP.md)
- 待修问题清单 → [task-inbox/ISSUES.md](task-inbox/ISSUES.md)
- 旧版 Cabinet（事件 → 规则派发 → 无头 Agent）已归档 → [ARCHIVED.md](ARCHIVED.md)

---

## 现在到哪一步了

```
随手记一句  →  自动判类型 / 优先级 / 项目  →  整理成需求  →  挂 Agent 会话 + 交接
     ✅                    ✅                      ✅           ⬜ 下一步
```

| 阶段 | 状态 | 说明 |
|---|---|---|
| **收** | ✅ 可用 | 底栏输入框，贴图、拖文件、甩链接都行 |
| **判** | ✅ 可用 | P0–P4 五级，自动归项目 |
| **理** | ✅ 可用 | 抽屉里生成需求说明（目标/背景/步骤/验收/待确认） |
| **会话** | ⬜ 未开始 | 卡片下挂 Codex / OpenCode 的持久会话，能连续对话 |
| **交接** | ⬜ 未开始 | Session 之间传摘要 + 证据，人不用复制粘贴 |

前三条已经能用了。后两条是这份仓库存在的理由，也是接下来要做的事 ——
但先得把 [ISSUES.md](task-inbox/ISSUES.md) 里 P0/P1 的问题清掉。

## 快速开始

**Windows**

```cmd
cd task-inbox
install.cmd
```

**macOS**

```bash
cd task-inbox
./install.command
```

装完点桌面快捷方式，或者直接开 http://127.0.0.1:46001/

> 需要 Node 22.5+（用到内置 `node:sqlite`）。平台差异只在启动脚本和
> 系统对话框上，核心代码两边跑的是同一份 —— 详见
> [task-inbox/README.md 的跨平台章节](task-inbox/README.md#跨平台)。

详细用法见 [task-inbox/README.md](task-inbox/README.md)。

## 目录

```
Cabinet/
  task-inbox/          ← 在用的东西
    core.mjs           任务逻辑（纯 Node，不依赖任何宿主）
    storage.mjs        SQLite 底层：驱动探测 + 建表 + 迁移
    server.mjs         HTTP 服务（可独立跑，也可作 Alma 插件）
    main.mjs           Alma 插件外壳
    classify.mjs       判类型 / 优先级 / 项目
    brief.mjs          整理成需求说明
    chat.mjs           卡片抽屉里的对话
    backend.mjs        模型通道：magpie / alma / cli 自动降级
    browse.mjs         目录浏览
    board.html         全部界面（单文件）
    cli.mjs            命令行
    *.cmd              Windows：安装、启动、开机自启
    *.command          macOS：安装、启动、开机自启
  archive/             旧版 Cabinet（已冻结，留作参考）
  ARCHIVED.md          为什么停、哪部分资产还活着
  ROADMAP.md           目标、演进路线、已验证的技术事实、已定的判断
  task-inbox/ISSUES.md 待修问题与待完善功能（带证据和复现）
```

## 为什么拆成两层

`task-inbox/core.mjs` 和 `task-inbox/server.mjs` **不 import 任何宿主 API**。
所以：

- `node server.mjs` 能单独跑，Alma 关了也不影响
- 插件只是它的一个宿主，换掉 Alma 也不用改代码
- 数据在 `~/.config/alma/task-inbox/tasks.db`（SQLite，WAL），不属于任何应用

## 关于旧的 Cabinet

那套系统（任务图、LLM 拆解、飞书长连接、调度器）跑通过，但停在了
「一天做完架构，还没承载过一天真实工作」的位置。

**19 条跨平台踩坑记录**是它最值钱的产出，已提炼成
`~/.config/alma/skills/win-gitbash-agent-automation/SKILL.md`。

细节见 [ARCHIVED.md](ARCHIVED.md)。
