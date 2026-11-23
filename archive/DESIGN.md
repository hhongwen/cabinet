# Cabinet 设计

> 目标见 [GOAL.md](./GOAL.md)。本文只讲怎么实现，以及每个决定为什么这么定。

---

## 零、两个已定的前提

来自需求方：

1. **任务入口**：飞书发消息、面板发消息。两个，暂定。
2. **拆解方式**：Cabinet 调 LLM 自动拆。模糊的等人审，能确定的自动分。

第 2 条是整套系统里最难的一条，下面第三节专门处理。

---

## 一、Magpie 怎么接（先定这个，因为它决定了边界）

**结论：不写插件。读两个现成出口。**

```
magpie ls / magpie models <agent>     → CLI，拿 agent 清单与可用模型
http://127.0.0.1:3425/v1              → 网关，OpenAI 兼容
```

为什么不是插件：Magpie 的插件是「接模型供应商」用的，属于它的内政。
外部系统往里塞插件，它一升级就要跟着修。而 `ls` 和网关是它对外承诺的接口。

用什么：

| Cabinet 需要 | 从哪拿 |
|---|---|
| 有哪些 agent | `magpie ls`，解析 agent 名 |
| 某 agent 能用哪些模型 | `magpie models <agent>` |
| 额度还剩多少 | `magpie quota --json` |
| 拆解任务用的 LLM | 网关 `/v1/chat/completions`，模型填 `magpie/auto/xxx` |

**封装成一个模块 `src/magpie.mjs`**，带缓存（agent/模型清单 10 分钟内不重复读），
取不到就降级（用配置里的默认值，不让整个系统挂掉）。

Cabinet 的配置里**不出现任何 provider 名和 key**。
唯一和模型有关的配置项是 `agent` 和 `model` 两个字符串。

---

## 二、数据模型

六张核心表。原则：**每次状态变化都能追溯到一条记录。**

```sql
-- 项目：cwd 就是边界
CREATE TABLE projects (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  cwd         TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL
);

-- 任务：可以嵌套（拆解产物）
CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  project_id   TEXT,
  parent_id    TEXT,              -- 拆出来的子任务指向父任务
  title        TEXT NOT NULL,
  body         TEXT,              -- 原始描述
  status       TEXT NOT NULL,     -- 见第三节状态机
  priority     INTEGER NOT NULL DEFAULT 0,
  agent        TEXT,
  model        TEXT,
  cwd          TEXT,
  done_when    TEXT,              -- 验收标准：拆解器必须填，也是判模糊的依据
  effect       TEXT,              -- read_only | write | external
  approval     TEXT,              -- before | after | review | never
  session_id   TEXT,              -- 绑定的 agent 会话，跨轮次复用
  source       TEXT,              -- feishu | panel | cli | agent
  source_ref   TEXT,              -- 飞书 message_id 等
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  ended_at     TEXT
);

-- 依赖
CREATE TABLE task_deps (
  task_id     TEXT NOT NULL,
  depends_on  TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on)
);

-- 执行尝试：一个 task 多次 run（重试、换 agent）
CREATE TABLE task_runs (
  id               TEXT PRIMARY KEY,
  task_id          TEXT NOT NULL,
  attempt          INTEGER NOT NULL DEFAULT 1,
  agent            TEXT,
  model            TEXT,
  agent_session_id TEXT,          -- codex 的 thread_id / opencode 的 session id
  status           TEXT NOT NULL, -- 沿用现有 job 的 7 状态
  prompt           TEXT,
  last_message     TEXT,
  exit_code        INTEGER,
  error            TEXT,
  transcript_path  TEXT,
  log_path         TEXT,
  started_at       TEXT,
  ended_at         TEXT
);

-- 群：kind 决定它挂在哪
CREATE TABLE groups (
  id        TEXT PRIMARY KEY,
  kind      TEXT NOT NULL,        -- project | task | module
  scope_id  TEXT NOT NULL,        -- project_id 或 task_id
  name      TEXT NOT NULL
);

-- 消息
CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  group_id    TEXT NOT NULL,
  sender_kind TEXT NOT NULL,      -- human | session | system
  sender_id   TEXT,               -- session_id 或人
  task_id     TEXT,
  run_id      TEXT,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  consumed_by TEXT               -- JSON 数组：哪些 session 已读过
);

-- 待办：所有等你的事，统一在这里
CREATE TABLE todos (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,     -- approval | decision | plan_review | failed
  task_id     TEXT,
  run_id      TEXT,
  title       TEXT NOT NULL,
  detail      TEXT,
  options     TEXT,              -- JSON：可选项
  status      TEXT NOT NULL,     -- open | resolved | dismissed
  resolution  TEXT,
  created_at  TEXT,
  resolved_at TEXT
);

-- 时间线：只追加，不改
CREATE TABLE timeline (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT,
  run_id  TEXT,
  at      TEXT NOT NULL,
  actor   TEXT,                  -- human | session:<id> | system
  action  TEXT NOT NULL,
  detail  TEXT
);
```

复用的部分：`claimJob` 的条件 UPDATE 抢占思路、WAL、`busy_timeout`、
`statement` 缓存、`isClosed` 守卫。全部保留。

---

## 三、拆解：怎么判「模糊」

这是整套系统最脆弱的环节，先说清楚它脆弱在哪：
**拆错一张图，下面五个子任务全做错，你第二天才发现。**

所以判据不能是「模型说自己有没有信心」。那东西无法验证。

### 3.1 用结构化完备性代替自信度

拆解器必须为每个子任务填满三样东西：

| 字段 | 填不出来意味着什么 |
|---|---|
| `cwd` | 不知道该在哪个项目做 → 拆解错了 |
| `done_when` | 写不出验收标准 → 需求本身没说清 |
| `agent` + `model` | 不知道该谁做 → 大概率是需求模糊 |

**任一项为空或填成占位符 → 整个拆解结果进待办。**

这条判据是客观的：你可以拿任何一个子任务检查这三个字段，不看模型脸色。

### 3.2 副作用分级决定要不要人审

拆解器还要为每个子任务标 `effect`：

| effect | 含义 | 处置 |
|---|---|---|
| `read_only` | 只读 | 自动进图，自动执行 |
| `write` | 改本机文件 | 自动进图，但沙箱锁在 workspace-write |
| `external` | 对外发送（发消息、提 PR、发邮件、调外部 API） | **必须人审**，无论多确定 |

理由：前两种做错了能改，第三种做错了收不回来。
「能不能撤回」比「模型多确定」重要得多。

### 3.3 三种结果，不是两种

```
拆解结果
├── 原子任务（不需要拆）      → 直接 ready，自动执行
├── 完全确定（三项齐全 + 无 external） → 自动进图，群里留一条可改
└── 有模糊项                  → 进待办，等人审
```

第一类很重要：**大部分任务是原子的，不该被拆。**
拆解器要能说「这就是一件事」，而不是硬拆成三件。

### 3.4 输出协议：JSON 优先，失败降级

HANDOFF 里定的人机协议是自然语言（`需要决策：`），理由是模型不会因格式失败。
但拆解不一样：拆解要建 5 个任务、3 条依赖，**必须结构化**。

所以拆解用 JSON，但失败路径要想清楚：

```
第 1 次输出不是合法 JSON  → 重试一次（附上解析错误）
第 2 次仍失败              → 进待办，附原始输出，人手动建
```

这不会导致「整个任务白做」，最坏情况是「人看一眼输出、手动建几个任务」。
和人机协议的场景不同——那个在任务末端，失败等于全废；
拆解在任务开头，失败只是慢一点。

**附：拆解的输出 schema**

```json
{
  "kind": "atomic" | "plan",
  "reason": "为什么这么拆",
  "tasks": [
    {
      "title": "...",
      "body": "...",
      "cwd": "D:/abs/path",
      "agent": "codex",
      "model": "magpie/auto/deepseek-v4.1-flash",
      "done_when": "...",
      "effect": "read_only|write|external",
      "deps": [0]
    }
  ]
}
```

`deps` 用下标指向 `tasks` 数组，落库时转成真实 id。

### 3.5 防错放的三个措施

自动拆 + 自动执行，错误会放大。三道闸：

1. **拆解产物的父任务保留**。子任务全挂在它下面，
   一键「退回未拆状态」重拆。原始描述不丢。
2. **`external` 一律人审**。见 3.2。
3. **首次跑新项目的任务，并发压到 1**。跑稳了再放开。
   配置项 `project.firstRunConcurrency`，默认 1。

---

## 四、状态机

### 4.1 Task 层（新）

```
inbox               收到，还没拆
  │  拆解器处理
  ├── atomic ────────> ready
  ├── plan 确定 ─────> ready（子任务各自 ready/blocked）
  ├── plan 模糊 ─────> awaiting_plan ──approve──> ready
  │                                  └─reject──> rejected
  └── 拆解失败 ──────> awaiting_plan（附原始输出）

ready               依赖已满足，可调度
  │  claim
  ▼
running
  ├── 成功         ──> done
  ├── 要人看一眼   ──> review ──approve──> done
  │                          └─reject──> rejected
  ├── 失败可重试   ──> ready（attempt+1）
  └── 失败到上限   ──> failed（进待办）

blocked             有前置没完成。由 deps 计算得出，不手工设
```

`blocked` 是**计算出来的**，不落库。每次调度时用 deps 现算，
避免「前置完成了但忘记解锁」这种经典 bug。

### 4.2 Run 层

沿用现在的 7 状态：`queued / awaiting_approval / running / done / failed / review / interrupted`。
`claimJob` 的条件 UPDATE 直接搬过来，只把 `jobs` 换成 `task_runs`。

---

## 五、调度

每 tick 做四件事，顺序有意义：

```
1. 热加载规则 / 项目配置
2. 找出 ready 的任务（deps 全部 done 且 status=ready）
3. 排序：priority DESC, created_at ASC
4. 逐个尝试 claim，受三重限制
```

三重并发限制：

| 层级 | 来源 | 说明 |
|---|---|---|
| 全局 | `cfg.workers` | 现有逻辑 |
| 项目 | `project.maxConcurrency` | 防止一个项目吃满 |
| 任务链 | `task.concurrencyKey` | 现有 `concurrency.key/max` 的延续 |

**不做抢占**（GOAL 4.1）。高优先级只影响排队顺序，不打断正在跑的。

额度刹车：tick 里读一次 `magpie quota`（缓存 5 分钟），
低于阈值就把全局 workers 临时降到 1，并写一条 timeline。
一期只降级 + 记日志，不做花哨的自适应。

---

## 六、群与轮次式沟通

### 6.1 群是同一个东西的三种作用域

```js
// 项目群：一个项目一个，所有 session 默认在里面
groups: { kind: 'project', scope_id: projectId }
// 任务群：一个任务链一个
groups: { kind: 'task', scope_id: rootTaskId }
// 模块群：一条任务链里，子任务之间协调用
groups: { kind: 'module', scope_id: taskId }
```

消息只存一份，靠 `group_id` 归属。面板上三个入口看的是同一批数据。

### 6.2 一轮到底怎么跑

```
起 run 之前：
  unread = messages where group in (该任务的所有群)
                        and 不在 run 的 consumed_by 里
  prompt = 任务描述 + done_when + 未读消息（格式化成对话记录）

跑：
  首次：codex exec --json -C <cwd> ...        ← 拿 thread.started 里的 thread_id
  续轮：codex exec resume <thread_id> --json ...

跑完：
  1. 解析结论 → 定 run 状态（沿用 needsDecision 的逻辑）
  2. 把未读消息标记为 consumed_by
  3. 结论里有 @通知 / @交接 → 投消息到群，必要时唤起下游
  4. 写 timeline
```

**关键：`thread_id` 要落库。** 实测确认 codex `--json` 首行事件是
`{"type":"thread.started","thread_id":"..."}`，续轮用 `codex exec resume <id>`。
opencode 对应 `--session <id>`。

拿不到 session id 的 agent（比如 dsh 若没有）→ 降级成「每轮重新喂完整上下文」，
并在 timeline 里标注，不假装它有记忆。

### 6.3 agent 之间怎么说话

不引入新的协议层。扩展现有的自然语言协议，风格保持一致：

| 结论里的写法 | Cabinet 的动作 |
|---|---|
| `需要决策：...` | 建 todo(kind=decision)，进待办 |
| `@通知 <群名> <内容>` | 投一条 message 到该群 |
| `@交接 <子任务标题> <说明>` | 投消息 + 若下游 ready 则立刻调度 |

为什么还是自然语言：和 HANDOFF 第六节同一个理由——
模型不会因为 JSON 格式不合规导致整个任务失败。
这里失败一次只是丢一条交接，不影响主流程。

---

## 七、任务入口

两个入口，归一化成同一个内部结构（`source` + `body` + 可选的 hint）：

```
飞书消息  ─┐
面板输入  ─┴─> TaskAdapter.parse() ─> tasks(inbox) ─> 拆解器
```

### 7.1 飞书：走长连接，不要公网

**重要修正**：早先以为飞书必须公网可达，所以一期只做单向。
实际上飞书开放平台的事件订阅支持**长连接**方式，由本机主动建 WebSocket，
事件从这条连接推回来。不需要公网 IP、不需要 cloudflared。

Node 24 已内置全局 `WebSocket`（已实测 `typeof WebSocket === 'function'`），
零依赖可做。

```
飞书长连接 ──> 收到 im.message.receive_v1 ──> 过滤（只认配置的 chat_id / 白名单发件人）
           ──> 建 Task(source=feishu, source_ref=message_id)
           ──> 回一条「收到，正在拆」的卡片

卡片按钮回调（todo 审批）也走同一条连接。
```

要做的：申请自建应用 → 开机器人能力 → 订阅 `im.message.receive_v1` →
拿 app_id / app_secret → 换 tenant_access_token（缓存到过期前）→ 建长连接。

**风险**：长连接需要常驻 + 心跳 + 断线重连。
这块必须写测试，不能只靠手工验证。

### 7.2 面板

`POST /api/tasks`，body 就是一段文字。和飞书入口共用同一个 parse。

---

## 八、面板信息架构

现在是单文件三栏 + 2 秒轮询。改造而不重写：

```
┌──────────┬───────────────────────────────┬──────────────┐
│ 左：树    │ 中：主区（三选一）             │ 右：待办      │
│          │                               │              │
│ 项目      │  ① 任务看板                    │  ▣ 等你批 3   │
│  └ 任务   │     按状态分列，卡片式          │  ▣ 等决策 1   │
│     └ 子  │     点卡片 → ②                │  ▣ 拆解待审 2 │
│          │                               │              │
│ 群列表    │  ② 任务详情                    │  点一条 →     │
│  ├ 项目群 │     上半：任务信息 + 依赖图      │  右侧展开     │
│  ├ 任务群 │     下半：群消息流              │  操作按钮     │
│  └ 模块群 │     点消息 → ③                 │              │
│          │                               │              │
│          │  ③ session 抽屉                │              │
│          │     prompt / transcript /      │              │
│          │     结论 / 耗时 / 会话 id       │              │
└──────────┴───────────────────────────────┴──────────────┘
```

三条必须做对的交互：

1. **点消息跳到它的 session** —— 这是「群」和「session」的连接点，不能断
2. **任务卡片上能看见依赖** —— 至少显示「等 2 个前置」
3. **待办一条一操作** —— 批 / 驳 / 改，不跳页面

轮询改成 SSE（`text/event-stream`，`node:http` 原生支持）。
2 秒轮询在消息流场景下会漏更新、也会白烧 CPU。
单机场景 SSE 足够。

---

## 九、现有代码怎么迁移

**不推倒重来。** 现有 44 项 selftest 是资产。

| 现有 | 处置 |
|---|---|
| `db.mjs` | 保留，加新表；`jobs` 表改名为 `task_runs` 并加 `task_id/attempt/agent_session_id` |
| `queue.mjs` | 大改：`ingest` 拆成「建 task」和「拆解」两步；`tick` 改成扫 task 表 |
| `runner.mjs` | 小改：加 `session_id` 的读（thread_id）和写（resume） |
| `rules.mjs` | 保留，但规则从「匹配事件」变成「项目默认配置」 |
| `hub.mjs` | 保留骨架，加 SSE 和新路由 |
| `sources/*` | 保留，`http` 源复用来做面板入口 |
| `notify.mjs` | 加飞书长连接 adapter，替换空壳 |
| `public/index.html` | 大改，但保留零 CDN 单文件的做法 |
| `bin/cabinet.mjs` | 加 `task` 子命令组 |

迁移分两段：先建新表跑通，`jobs` 表只读保留一个版本，确认没问题再删。

---

## 十、分期与验收

| 期 | 内容 | 验收 |
|---|---|---|
| **一** | 数据模型 + 拆解器 + 调度 + 一个任务群 + 轮次式沟通 + 面板任务详情 | 一个任务自动拆成两个子任务，两个 session 在同一群里交接，面板看到消息流和两个 session 的完整记录 |
| **二** | 优先级 + 待办中心 + 飞书长连接（收发）+ 失败重试 | 飞书发一句话能建任务；待办在飞书点按钮能批；失败自动重试一次 |
| **三** | 任务图可视化 + 拆合操作 + 额度刹车 | 图上能看见依赖和进度；能手动拆合 |
| **四** | 打磨：移动端、消息搜索、成本视图 | — |

一期必须真跑通，不接受「代码写完了但没验证」。

---

## 十一、我考虑过但否决的方案

写出来，方便判断我的判断对不对。

**用文件系统当任务队列**（每个任务一个目录）
→ 否决。状态查询要遍历目录，排序和依赖计算全靠读文件，一多就慢。
SQLite 已经在这个项目里了，没理由不用。

**每个 task 起一个常驻 agent 进程，靠 stdin/stdout 实时通信**
→ 否决。进程管理复杂度爆炸，崩溃恢复困难，而且大多数任务不需要实时。

**用 JSON schema 强约束所有 agent 输出**
→ 只用于拆解，不用于执行。理由见 3.4。

**把 Magpie 的配置定期同步进 Cabinet 的配置表**
→ 否决。这就是缓存不一致的经典来源。要用时现查，查不到降级。

**拆解做成独立服务（单独进程/端口）**
→ 一期不做。单机场景多一个进程就多一份故障面。先做成 `src/planner.mjs` 一个模块。

---

## 十二、最大风险

**自动拆解的质量。** 整个方案里唯一无法用工程手段保证的部分。

缓解：结构化完备性判据（3.1）、副作用分级（3.2）、父任务保留可重拆（3.5）、
首次跑新项目并发压到 1（3.5）。

但这些都是「限制错误的传播范围」，不是「保证不犯错」。
**一期跑通之后，建议先用它在只读任务上跑两周，再放开写操作。**
