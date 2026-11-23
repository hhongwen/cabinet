# Cabinet 路线图

> 这份文件回答三件事：Cabinet 最终要做什么、现在到哪一步、哪些判断已经定下来了。
> 具体的代码问题在 [task-inbox/ISSUES.md](task-inbox/ISSUES.md)，
> 怎么装怎么用在 [task-inbox/README.md](task-inbox/README.md)。

---

## 一、我们要解决的那个问题

用户手里已经有 Codex、OpenCode 这些能干活的东西。它们单打独斗都行，
但一旦一件事需要多个 Agent 接力，人就变成了传话的：

```
人：把这段需求复制给 Codex        →  Codex 干完
人：读一遍 Codex 说了什么
人：总结一下再复制给 OpenCode     →  OpenCode 干完
人：再读一遍，判断要不要回到 Codex
```

**Cabinet 要消掉的，就是这个"人当路由器和翻译"的位置。**

不是让 Agent 更能干，而是让它们之间的信息不用经过人手上。

所以定位不是"任务管理器"，而是：

> **以任务为中心的多 Agent 协作工作台**
> Task-centric Multi-Agent Workspace

三个职责，按重要程度排：

1. **Session 管理** —— 一张任务卡下挂多个 Agent 的持久会话，能连续对话、能看状态、能读结果。
2. **协作管理** —— Session 之间能交接：谁干完了、干了什么、证据在哪、下一棒交给谁。
3. **任务管理** —— 收集、判断、整理成能派的活。（这部分已经能用了）

顺序很重要：**任务管理是入口，Session 管理和协作才是它存在的理由。**
如果只做第 3 条，它就是一个好看的待办清单。

---

## 二、演进路线

三个阶段。每个阶段的价值判断标准是**人还需要做多少传话的活**。

| 阶段 | 定位 | 人要做什么 | 人不用再做什么 |
|---|---|---|---|
| **0. 现在** | AI 任务收件箱 | 记录、确认任务 | 想不起来要做什么 |
| **1. 下一步** | 多 Agent Session 工作台 | 选 Agent、手动触发交接 | 打开 Agent 客户端、复制粘贴上下文 |
| **2. 最终** | 多 Agent 协作中枢 | 定目标、审批关键决策、验收 | 盯着状态、手动编排顺序 |

**判断阶段 1 是否成功的唯一标准**：一件事需要在两个 Agent 之间接力时，
你不需要打开任何一个 Agent 的客户端。

---

## 三、阶段 1 的验收标准（还没开始）

不是"四个 Agent 自动协作"，而是打通一条最小闭环。五步，一步都不能跳：

| # | 要做的事 | 怎么算做到了 |
|---|---|---|
| 1 | 从卡片创建一个 Agent Session，把 Session ID 存进库 | 关掉 Cabinet 再打开，任务卡还能认出那个 Session |
| 2 | 在卡片里连续发多轮消息，每次都进同一个 Session | 问它"我上一句说了什么"，它答得出来 |
| 3 | 能看到执行状态，服务重启后还能恢复 | 执行中重启 Cabinet，回来仍是"执行中"或变"已完成"，不会卡在中间态 |
| 4 | 一轮结束后，Cabinet 自动生成摘要并关联原始证据 | 摘要旁边能点到原始 session id / turn id |
| 5 | 把摘要 + 证据交给另一个 Agent 的 Session，完成一次审阅 | 第二个 Agent 能基于交接内容干活，不需要人再解释一遍 |

**这五步之前，不做任何自动化。** 不自动选下一个 Agent、不自动派发、不自动循环。
先证明这条链路有真价值，再谈编排。

---

## 四、已验证的技术事实

下面每条都在本机（2026-11-23）实际跑过，不是查文档抄的。
这些事实直接决定了架构，不要凭印象推翻。

### OpenCode

```bash
# 一轮执行，JSONL 事件流，带 session id / token / cost
opencode run --format json "只回复两个字：收到"
# {"type":"step_start","sessionID":"ses_df89...","part":{...}}
# {"type":"text","text":"收到",...}
# {"type":"step_finish","reason":"stop","cost":0.0048,"tokens":{...}}
```

- **同一 session 复用**：`opencode run --session <ses_id> "..."` ✅ 实测通过，上下文保留
- **读历史**：`opencode session export <ses_id>` → `{"info":{...,"outcome":"succeeded","time":{"idle":...}}, "messages":[...]}`
- **状态可区分**：`outcome` 给"这一轮行不行"，`time.idle` 给"现在是否空闲"
- **工作目录隔离**：`opencode run -w [=name]` 直接起 git worktree
- **后台服务**：`opencode service` / `opencode api` / `opencode acp`（Agent Client Protocol）

### Codex

```bash
# 一轮执行，JSONL 事件流，带 thread id
codex exec --json "只回复两个字：收到"
# {"type":"thread.started","thread_id":"01a20770-..."}
# {"type":"turn.started"}
# {"type":"item.completed","item":{"type":"agent_message","text":"收到"}}
# {"type":"turn.completed","usage":{...}}
```

- **同一 thread 复用**：`codex exec resume <thread_id> --json "..."` ✅ 实测通过，上下文保留
- **工作目录**：`codex exec -C <DIR>`
- **worktree 隔离**：`codex exec --worktree`
- **排队**：`codex queue --thread <id> --message <text>`（Agent 还在跑时投递下一条）
- **`codex app-server` 是 `[experimental]`** —— 不采用，`exec --json` 的事件模型已经够用

### 两家的会话库互不相通

```
OpenCode  ~/.local/share/opencode/opencode.db
Codex     ~/.codex/sessions/2026/...  +  session_index.jsonl
```

**这条决定了交接表的设计**：Cabinet 不能只存对方的 session id 当指针，
必须自己把交接内容（摘要、diff、证据）真的存下来。下游 Agent 拿到的是
Cabinet 拼装的东西，不是上游会话的引用。

### 运行时

```
Alma 插件宿主  D:\Program Files\Alma\alma-server\runtime\node.exe  → v24.22.3
node:sqlite    内置可用，不需要 --experimental 标志
Bun 1.3.14     无 node:sqlite，但有 bun:sqlite
```

所以 `storage.mjs` 做了双驱动探测，将来宿主换 Bun 也不会挂。

---

## 五、已经定下来的判断

这些是讨论过的结论，再遇到时不用重新论证。

### 架构

| 判断 | 理由 |
|---|---|
| **存储用 SQLite，不用 JSON** | 已完成。多进程安全、增量写、规模不敏感 |
| **不引入 ORM** | 本地单用户，手写 SQL 更短，也保住零 npm 依赖 |
| **不自己实现 Agent 队列** | `codex queue` 已经有了 |
| **不用 Codex `app-server`** | 实验性协议，`exec --json` 够用 |
| **Cabinet 自己的 LLM 和 Agent 执行通道必须拆开** | 前者失败只需重试，后者失败要保留现场，语义完全不同 |
| **交接必须存内容，不能存指针** | 两家会话库不通 |
| **任务上下文独立于所有 Agent，而且要"活"** | 见下 |

### 关于"任务上下文"

`tasks.brief` 已经是"独立于所有 Agent 的任务上下文"的雏形 —— 它由 Cabinet 生成，
不来自任何 Agent。但它是**静态的**：派活之前写一次，之后就不动了。

真做多 Agent 的时候它得是活的：

```
brief        初始目标 + 验收标准      ← 已有
  ↓
handoffs     每次交接的产物           ← 待建
  ↓
context      累积的最新共识（markdown）← 缺这一层
```

没有第三层，站到第四个 Agent 的时候它得读三份 handoff 才知道现状 ——
那还是传话，只是从人手上转移到了 Agent 手上。

### 关于界面

| 判断 | 理由 |
|---|---|
| **最重要的界面始终是任务卡片，不是聊天窗口** | 否则就是一个聚合多个聊天窗的工具，没有本质区别 |
| **卡片上只显示"当前 Agent + 一句进度"，点进去才展开全部 Session** | 四个 Session 全展开时一张卡占满一屏，90% 的时间你只关心"在谁手上、卡在哪" |
| **"与 Cabinet 对话"和"与某个 Agent 对话"必须分开** | 否则"改成 P1"到底是改任务优先级还是改代码里的配置，说不清 |

### 明确不做

- **不做独立的 Agent 调度服务** —— SQLite 加几张表就够，先不上微服务
- **不重做旧版的"任务图 + 自动拆解 + 调度器"** —— 见 [ARCHIVED.md](ARCHIVED.md)，那条路已经证明是重复造基础设施
- **不做实时协作 / 多用户** —— 一个人用，WAL + busy_timeout 已经够
- **不做 WebSocket 推送** —— 轮询够用（但轮询本身有代价，见 ISSUES.md）

---

## 六、还没定下来的问题

留在这里，等真遇到的时候再想，不要提前决策。

1. **Session 上下文满了怎么办？**
   Agent 各自有压缩策略，但当 Cabinet 想"把上下文交接清楚"时，
   压缩过的历史还能不能作为证据？如果要分叉，新 Session 和旧 Session 的关系怎么记？

2. **多个 Agent 同时改代码怎么隔离？**
   `--worktree` 是一行参数的事，但合并策略、冲突处理不属于 Cabinet 该管的范围。
   初期：开发写、审阅只读、测试跑测试。真并行再说。

3. **交接内容是 Cabinet 生成还是 Agent 生成？**
   Cabinet 生成更中立，但要吃一次 LLM 调用；Agent 生成更准确，但会带着它自己的立场。
   倾向 Cabinet 生成摘要 + 存原始证据，两者都给下游。

4. **阶段 2 的"自动"到底自动到哪一步？**
   自动选下一个 Agent？自动判断"审阅没通过要回退"？这属于需要拍板的事，
   等阶段 1 跑够次数再说。

---

## 七、当前状态（2026-11-23）

### 已经能用的

| 能力 | 说明 |
|---|---|
| 收 | 底栏输入、贴图、拖文件、甩链接；六种入口类型 |
| 判 | P0–P4 优先级、自动归项目、8 个类别，后台异步不阻塞 |
| 看 | 三列看板 + 拖拽换列 + 侧栏项目导航 + 筛选条 |
| 谈 | 卡片抽屉里对话，模型返回结构化补丁直接改卡片字段 |
| 理 | 生成五段式需求说明（目标/背景/步骤/验收/待确认） |
| 存 | SQLite（WAL），老 `tasks.json` 自动迁移 |
| 接 | 四条模型通道自动降级：magpie → alma → opencode → codex |
| 跑 | Alma 插件 / 独立服务两种方式，Windows + macOS |

### 还没开始的

**Session 管理、协作管理 —— 也就是这份文档第二节说的阶段 1 的全部内容。**

现状是"阶段 0"：一个能用的收件箱，但没有任何 Session 概念。
`tasks.claimed_by` 这一列是留给它的占位，至今没有代码写过。

### 实际使用数据（2026-11-23 下午的一次快照）

> 这不是实时数字。想看当前的，跑 `node cli.mjs ls` 或打开看板。
> 更重要的是：**每过一段时间重新看一次这个比例，它是判断"该做什么"的依据。**

那一次快照：

```
12 条任务 / 4 个项目 / 6 条消息
来源:     quick 11, chat 1
分类:     done 12（全部成功）
有 brief: 1/12
有对话:   1/12
```

**只有"收"和"判"跑起来了。** 抽屉对话和需求生成基本没被用过。

这个比例比任何架构判断都重要：在给"理"和"派"加功能之前，
要先看"收"和"判"是不是真的在省时间。如果它连"记住该做什么"这件事都没做到，
那多 Agent 协作就是空中楼阁。

**怎么读这个比例**：

| 现象 | 说明什么 |
|---|---|
| 任务数长期不涨 | 它没成为习惯，先解决"懒得记"而不是"记了没法派" |
| 任务涨但 brief 一直不涨 | "整理成需求"这一步的入口不够顺，或者没这个需求 |
| brief 涨但对话不涨 | 需求一次说清就够，不需要反复讨论 —— 那是好事 |
| 有任务长期停在 doing | 缺的是推进力，不是记录能力 |

---

*2026-11-20 起 · 2026-11-23 定稿*
