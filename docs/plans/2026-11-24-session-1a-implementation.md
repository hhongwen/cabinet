# Cabinet 阶段 1A：持久 Agent Session 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **状态：已实现并验收（2026-11-24，分支 `feat/session-1a`）。**
> 验收证据：真实 OpenCode 两轮复用同一 Session；重启后未完成 Turn 变 `unknown`；
> `test-sqlite` 412 / `test-agent` 89 / `test-agent-http` 47 / `test-parsers` 86，
> `style-audit` 0 error。实施记录见 `task-inbox/ISSUES.md` 第九批。
>
> **1A 补丁（2026-11-25）：** schema v10 增加 `agent_sessions.context_seeded_at`；
> 新 Session 首轮自动带任务上下文，补丁前的老 Session 下一条消息自动补一次，
> 之后只发用户新写的内容。计划正文仍按 v9 记录，v10 以这里为准。
>
> **复核后的实施偏差：** Turn 恢复从 `core.init()` 移到 server 启动路径，并加
> 数据目录单实例锁（避免 `cli init` 或第二个实例抢跑正在执行的 Turn）；
> 新增 `deleteSession` / `DELETE /api/sessions/:id`（运行中返回 409）；
> `force:true` 与显式绑定已有 `ses_` 目前只在 API 层，UI 暂不暴露。

**Goal:** 在任务卡片下挂一个可连续对话的 OpenCode 持久 Session，Cabinet 重启后仍能定位并继续，Turn 的状态、结果和原始事件可追溯。

**Architecture:** SQLite 新增 `agent_sessions` / `session_turns` 两张表；`agent.mjs` 负责 Turn 生命周期、串行控制和恢复，`opencode-agent.mjs` 只负责 OpenCode CLI 的创建、发送、事件解析和导出核对；HTTP 层新增任务会话与 Turn 接口；抽屉里新增独立的「Agent 会话」区，和现有「与 Cabinet 对话」分开。

**Tech Stack:** Node 22.5+（`node:sqlite` / 内置 `fetch`）、原生 `http`、OpenCode CLI `run --format json` 与 `session export`、单文件 `board.html`。不引入任何 npm 依赖。

**Spec:** [docs/session-collaboration.md](../session-collaboration.md)、[ROADMAP.md](../../ROADMAP.md) 阶段 1A、[ISSUES.md](../../task-inbox/ISSUES.md) P0/P1 已完成项。

## Global Constraints

- 只做阶段 1A。不做自动选 Agent、自动路由、多 Agent 交接、摘要生成、`TaskContext`、`Artifacts` 表 —— 那些属于 1B / 1C / 2。
- 不新增 npm 依赖；不拆 `board.html`，不引入构建步骤。
- schema 一次只升一个版本号：本批 `SCHEMA_VERSION` 从 8 升到 **9**。
- 「与 Cabinet 对话」继续走 `messages` / `chat.mjs`；Agent 会话只走 `agent_sessions` / `session_turns`，两套数据不混。
- Turn 完成 ≠ 任务完成。不得因为 `turn.status = completed` 自动改 `tasks.status`。
- 同一 Session 同时只允许一个 `queued` / `running` Turn；第二个请求返回 409，不排队、不静默覆盖。
- 进程退出或服务重启后，未完成的 Turn 一律先标 `unknown`，不得标 `completed`；只有 CLI 导出明确证明完成时才改 `completed`。
- OpenCode 以 `--auto` 运行（非交互模式必须自动批准权限）。UI 必须写明「Agent 会在该目录直接执行命令」，工作目录由用户选择。
- `working_directory` 必须是真实存在的绝对路径；首次 Turn 之后不可修改。
- 所有用户可见文案用中文；代码注释说明「为什么」，不只写「做了什么」。

## Review Focus

- CLI 退出码 0、但事件流里没有 `step_finish`：必须落 `unknown`，不能当成功。测试放在 Task 2。
- Cabinet 在 Turn 执行中重启：旧 `running` 必须先变 `unknown`，核对后才能改完成态。测试放在 Task 1 和 Task 2。
- 同一 Session 连续发两条：第二条必须 409，不能出现两个并行 Turn 抢同一个外部会话。测试放在 Task 1 和 Task 3。
- `opencode session export` 不存在、超时或 JSON 坏掉：状态保持 `unknown`，原始 Turn 和事件文件不能丢。测试放在 Task 2。
- 工作目录被删、无权限或路径写错：Turn 失败并给出人话，进程不能崩，Session 不能永久 busy。测试放在 Task 2。
- 删除任务或 Session：`sessions/<turn>.jsonl` 事件文件一起清掉，不能留下孤儿证据。测试放在 Task 1。
- 已归档项目：侧栏和下拉不出现，不能再接新任务；已有任务仍能显示项目名。测试放在 Task 1。
- 结果很长：事件文件保留完整流，`result_text` 截断到 200 KB 并带截断标记，避免一次写入拖死轮询。测试放在 Task 2。

---

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `task-inbox/storage.mjs` | 修改 | schema v9、两张新表、项目三列、索引与迁移 |
| `task-inbox/core.mjs` | 修改 | Session / Turn 的增删改查、状态派生、恢复、项目归档、任务行装饰 |
| `task-inbox/opencode-agent.mjs` | 新建 | OpenCode CLI 适配：事件解析、发送、导出核对 |
| `task-inbox/agent.mjs` | 新建 | Turn 运行器：串行、超时、事件落盘、完成/失败/中断、恢复 |
| `task-inbox/server.mjs` | 修改 | Session / Turn 路由、启动恢复、退出清理 |
| `task-inbox/board.html` | 修改 | 抽屉「Agent 会话」区、卡片徽标、项目默认 Agent / 模型、项目归档入口 |
| `task-inbox/test-sqlite.mjs` | 修改 | v9 迁移、Session / Turn、项目归档、事件文件清理 |
| `task-inbox/test-agent.mjs` | 新建 | 事件解析、导出核对、运行器生命周期、超时、恢复 |
| `task-inbox/test-agent-http.mjs` | 新建 | Session / Turn 路由与 409 |
| `task-inbox/README.md` | 修改 | 使用说明、数据表、schema 版本、已知限制 |
| `task-inbox/ISSUES.md` | 修改 | 第九批进度与验收记录 |
| `README.md` / `ROADMAP.md` | 修改 | 阶段 1A 状态与计划入口 |
| `docs/session-collaboration.md` | 修改 | 顶部状态：1A 已实现，1B/1C 仍为规划 |

---

## Task 1: schema v9 与 Session / Turn 数据层

**Files:**
- Modify: `task-inbox/storage.mjs`
- Modify: `task-inbox/core.mjs`
- Test: `task-inbox/test-sqlite.mjs`

**Interfaces:**
- Consumes: 现有 `createCore(dataDir)`、`applySchema(db)`、`MIGRATIONS`。
- Produces:
  - `SCHEMA_VERSION = 9`
  - `createSession({ taskId, role, agent, workingDirectory, model }) -> Session`
  - `listSessions(taskId) -> Session[]`
  - `getSession(id) -> Session | null`
  - `updateSession(id, { model?, working_directory? }) -> Session`
  - `bindExternalSession(sessionId, externalSessionId) -> Session`
  - `startTurn(sessionId, userText) -> Turn`
  - `markTurnRunning(turnId, { externalRef, eventsFile }) -> Turn`
  - `finishTurn(turnId, { status, resultText, error, exitCode }) -> Turn`
  - `getTurn(id) -> Turn | null`
  - `listTurns(sessionId, limit = 20) -> Turn[]`
  - `openTurn(sessionId) -> Turn | null`
  - `recoverOpenTurns() -> number`
  - `refreshSessionStatus(sessionId) -> Session`
  - `updateProject(id, { default_agent?, default_model?, archived_at?, ... }) -> Project`
  - `listProjects({ include_archived } = {})`

**数据形状：**

```sql
CREATE TABLE agent_sessions (
  id                  TEXT PRIMARY KEY,
  task_id             TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  role                TEXT NOT NULL DEFAULT 'dev',
  agent               TEXT NOT NULL DEFAULT 'opencode',
  external_session_id TEXT,
  working_directory   TEXT NOT NULL,
  model               TEXT,
  status              TEXT NOT NULL DEFAULT 'idle',
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE session_turns (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'queued',
  user_text     TEXT NOT NULL,
  result_text   TEXT NOT NULL DEFAULT '',
  error         TEXT NOT NULL DEFAULT '',
  events_file   TEXT,
  external_ref  TEXT,
  exit_code     INTEGER,
  started_at    TEXT,
  ended_at      TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_turns_one_open
  ON session_turns(session_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX idx_turns_session ON session_turns(session_id, created_at);
CREATE INDEX idx_sessions_task  ON agent_sessions(task_id, updated_at);
```

`projects` 增加：

```sql
ALTER TABLE projects ADD COLUMN default_agent TEXT;   -- opencode | codex | NULL
ALTER TABLE projects ADD COLUMN default_model TEXT;   -- NULL = 用 Agent 默认
ALTER TABLE projects ADD COLUMN archived_at  TEXT;    -- NULL = 未归档
```

- [ ] **Step 1: 在 `test-sqlite.mjs` 追加第 22 节失败测试**

覆盖这些断言，先让它们在 `SCHEMA_VERSION = 8` 时失败：

```js
console.log('\n=== 22. Agent Session（v9） ===');
{
  // 22.1 v8 -> v9 迁移
  core.conn().exec('DROP TABLE IF EXISTS session_turns');
  core.conn().exec('DROP TABLE IF EXISTS agent_sessions');
  for (const c of ['default_agent', 'default_model', 'archived_at']) {
    try { core.conn().exec('ALTER TABLE projects DROP COLUMN ' + c); } catch { /* 已经没有 */ }
  }
  core.conn().run("UPDATE meta SET value='8' WHERE key='schema_version'");
  const v9 = createCore(tmp);
  v9.init();
  const cols = (t) => v9.conn().all('PRAGMA table_info(' + t + ')').map((x) => x.name);
  ok('agent_sessions 表回来了', !!v9.conn().get("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_sessions'"));
  ok('session_turns 表回来了', !!v9.conn().get("SELECT name FROM sqlite_master WHERE type='table' AND name='session_turns'"));
  ok('projects 三个列回来了', ['default_agent','default_model','archived_at'].every((c) => cols('projects').includes(c)));
  eq('SCHEMA_VERSION 就是 9', SCHEMA_VERSION, 9);
  v9.close();

  // 22.2 项目默认 Agent / 模型与归档
  const p = core.addProject('临时归档项目');
  core.updateProject(p.id, { default_agent: 'opencode', default_model: 'provider/model-a' });
  eq('默认 Agent 落库', core.getProject(p.id).default_agent, 'opencode');
  eq('默认模型落库', core.getProject(p.id).default_model, 'provider/model-a');

  const t = core.add({ title: '归档项目里的任务', project: '临时归档项目' });
  let refused = false;
  try { core.updateProject(p.id, { archived_at: '2026-01-01T00:00:00.000Z' }); } catch { refused = true; }
  ok('有活跃任务时拒绝归档', refused, '归档不应把任务一起藏起来');

  core.patch(t.id, { status: 'done' });
  core.patch(t.id, { archived_at: '2026-01-01T00:00:00.000Z' });
  core.updateProject(p.id, { archived_at: '2026-01-01T00:00:00.000Z' });
  ok('默认列表看不到已归档项目', !core.listProjects().some((x) => x.id === p.id));
  ok('include_archived 能看到', core.listProjects({ include_archived: true }).some((x) => x.id === p.id));

  let assign = false;
  try { core.add({ title: '不该落进归档项目', project: '临时归档项目' }); } catch { assign = true; }
  ok('已归档项目不能再接新任务', assign);

  core.updateProject(p.id, { archived_at: null });
  ok('恢复后重新出现在列表', core.listProjects().some((x) => x.id === p.id));

  // 22.3 Session / Turn 生命周期
  const host = core.add({ title: '会话宿主', project: 'Cabinet' });
  const sess = core.createSession({
    taskId: host.id, role: 'dev', agent: 'opencode',
    workingDirectory: tmp, model: 'provider/model-a'
  });
  eq('外部 Session ID 先为空', sess.external_session_id, null);
  eq('会话初始 idle', sess.status, 'idle');
  eq('任务行带会话数', core.getTask(host.id).agent_session_count, 1);

  const bound = core.bindExternalSession(sess.id, 'ses_test_1');
  eq('外部 Session ID 能绑定', bound.external_session_id, 'ses_test_1');
  ok('绑定后不允许换成另一个外部 ID', (() => {
    try { core.bindExternalSession(sess.id, 'ses_other'); return false; } catch { return true; }
  })());

  const turn = core.startTurn(sess.id, '第一轮');
  eq('新 Turn 是 queued', turn.status, 'queued');
  ok('同一会话不能再开第二个未完成 Turn', (() => {
    try { core.startTurn(sess.id, '并发第二条'); return false; } catch { return true; }
  })());

  core.markTurnRunning(turn.id, { externalRef: 'msg_1', eventsFile: 'sessions/' + turn.id + '.jsonl' });
  eq('会话变 busy', core.getSession(sess.id).status, 'busy');
  eq('事件文件落库', core.getTurn(turn.id).events_file, 'sessions/' + turn.id + '.jsonl');
  core.finishTurn(turn.id, { status: 'completed', resultText: '收到', exitCode: 0 });
  eq('会话回 idle', core.getSession(sess.id).status, 'idle');
  eq('结果落库', core.getTurn(turn.id).result_text, '收到');

  const turn2 = core.startTurn(sess.id, '第二轮');
  eq('第二轮复用同一个 Session', turn2.session_id, sess.id);
  core.finishTurn(turn2.id, { status: 'failed', error: '模拟失败', exitCode: 1 });
  eq('失败 Turn 记录错误', core.getTurn(turn2.id).error, '模拟失败');
  eq('失败后会话仍是 idle', core.getSession(sess.id).status, 'idle');

  // 22.4 重启恢复：running 变 unknown，不冒充 completed
  const turn3 = core.startTurn(sess.id, '第三轮');
  core.markTurnRunning(turn3.id, {
    externalRef: 'msg_3',
    eventsFile: 'sessions/' + turn3.id + '.jsonl'
  });
  const recovered = core.recoverOpenTurns();
  eq('恢复只收未完成 Turn', recovered, 1);
  eq('未完成 Turn 变 unknown', core.getTurn(turn3.id).status, 'unknown');
  eq('会话也变 unknown', core.getSession(sess.id).status, 'unknown');

  // 22.5 删除任务清事件文件
  const evFile = path.join(tmp, 'sessions', turn3.id + '.jsonl');
  fs.mkdirSync(path.dirname(evFile), { recursive: true });
  fs.writeFileSync(evFile, '{"type":"step_start"}\n');
  core.remove(host.id);
  ok('删任务时事件文件一起清掉', !fs.existsSync(evFile));
  eq('会话跟着任务删掉', core.getSession(sess.id), null);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test-sqlite.mjs`
Expected: 第 22 节失败，`SCHEMA_VERSION` 仍是 8，`createSession is not a function`。

- [ ] **Step 3: 实现 `storage.mjs` 的 v9 schema 和迁移**

- `SCHEMA_VERSION = 9`。
- 在 `SCHEMA` 里追加两张表和索引；`projects` 的三列直接写进 `CREATE TABLE`（新库路径）。
- 在 `MIGRATIONS[8]` 里：给 `projects` 补三列（用已有的 `PRAGMA table_info` 幂等写法），再 `CREATE TABLE IF NOT EXISTS` 两张表和索引。
- 迁移里不要回填任何 Session 数据 —— 老库本来就没有。
- 把 `test-sqlite.mjs` 第 21 节末尾的 `eq('SCHEMA_VERSION 就是 8', ...)` 改成 9。

- [ ] **Step 4: 实现 `core.mjs` 的 Session / Turn 与项目归档**

新增常量和映射：

```js
export const AGENT_ROLES = ['plan', 'dev', 'review', 'test'];
export const AGENT_TYPES = ['opencode', 'codex'];
export const SESSION_STATUSES = ['idle', 'busy', 'unavailable', 'unknown'];
export const TURN_STATUSES = ['queued', 'running', 'completed', 'failed', 'interrupted', 'unknown'];
```

关键规则：

- `rowToProject` 增加 `default_agent` / `default_model` / `archived_at` 映射；`getProject` / `listProjects` 都吃这一份，别只加列不加读。
- `createSession`：`taskId` 必须存在；`role` / `agent` 必须在枚举内；`working_directory` 必填且必须是真实存在的目录（`fs.statSync().isDirectory()`），否则抛「工作目录不存在」；`external_session_id = null`，等首次发送时由 Adapter 生成；初始 `status = 'idle'`。
- `updateSession`：只允许 `model` 和 `working_directory`；如果该 Session 已有 Turn（`SELECT COUNT(*)`），改 `working_directory` 直接抛错「工作目录在首次发送后不能改」。
- `bindExternalSession`：只在 `external_session_id` 为空时写入；已有值时只有传入同一个 ID 才允许（幂等），换 ID 抛错「这个会话已经绑定外部 Session」。
- `startTurn`：插入 `status='queued'`；依赖部分唯一索引拦住并发；捕获 SQLITE_CONSTRAINT 时抛「这个会话还有一轮没结束」。
- `markTurnRunning`：写 `status='running'`、`started_at`、`external_ref`、`events_file`，同时把 Session 置 `busy`。
- `finishTurn`：终态只能是 `completed/failed/interrupted/unknown`；写 `ended_at`、`result_text`（截到 200 KB，超出追加 `\n[结果超过 200 KB，已截断；完整事件见 events_file]`）、`error`、`exit_code`；**completed / failed / interrupted 把 Session 置 `idle`，unknown 把 Session 置 `unknown`**，不调用「保留 unknown」的模糊逻辑。
- `refreshSessionStatus`：有 `queued/running` → `busy`；否则如果最近一轮是 `unknown` → `unknown`；否则 `idle`；`unavailable` 只在 Adapter 明确报告不可用时写入。
- `openTurn(sessionId)`：取 `status IN ('queued','running')` 的那一条。
- `recoverOpenTurns`：把所有 `queued/running` 改成 `unknown`，`error` 写「Cabinet 重启，执行状态待核对」，`ended_at = now`；对应 Session 置 `unknown`；返回条数。在 `init()` 里 `reviveStuckPending()` 之后调用。
- `TASK_SELECT` 增加：
  ```sql
  (SELECT COUNT(*) FROM agent_sessions s WHERE s.task_id = t.id) AS agent_session_count,
  (SELECT s.status FROM agent_sessions s WHERE s.task_id = t.id
    ORDER BY s.updated_at DESC LIMIT 1) AS agent_status
  ```
  `rowToTask` 映射成 `agent_session_count`（Number）和 `agent_status`（字符串或 null）。
- `updateProject` 新增支持 `default_agent`、`default_model`、`archived_at`：
  - `default_agent` 只接受 `null` / `opencode` / `codex`。
  - 写 `archived_at` 非空时：拒「默认」；统计该项目的活跃任务（`archived_at IS NULL AND merged_into IS NULL`），大于 0 抛「还有 N 条任务没移走」；写时间戳。
  - 写 `archived_at = null` 即恢复。
  - UPDATE 语句要带上这三列，别再只更新 name / aliases / dirs。
- `listProjects(opts)`：默认 `WHERE archived_at IS NULL`；`include_archived` 时不过滤。`taskCount` 口径不变。
- `findProject` / `ensureProject`：默认不命中已归档项目；`ensureProject` 命中已归档时抛「项目已归档，先恢复或换一个项目」。`getProject(id)` 仍返回归档项目，供历史任务显示。
- `reorderProjects`：只给未归档项目排序；归档项目的 `sort_order` 原样保留，恢复后不会插到第一位。
- `remove(id)`：删库前收集该任务所有 `session_turns.events_file`，删库成功后逐个删除 `path.join(dataDir, events_file)`；只删 `sessions/` 下且真实存在的文件。

- [ ] **Step 5: 跑测试并提交**

Run: `node test-sqlite.mjs`
Expected: `通过 370+N / 370+N 全绿`。

```bash
git add task-inbox/storage.mjs task-inbox/core.mjs task-inbox/test-sqlite.mjs
git commit -m "task-inbox: schema v9 落 Session 与 Turn 数据层"
```

---

## Task 2: OpenCode Adapter 与 Turn 运行器

**Files:**
- Create: `task-inbox/opencode-agent.mjs`
- Create: `task-inbox/agent.mjs`
- Modify: `task-inbox/backend.mjs`（把 `resolveCliBin` 导出，供 Adapter 复用）
- Test: `task-inbox/test-agent.mjs`
- Test fixture: `task-inbox/test-fixtures/fake-opencode.mjs`（读 stdin，按参数输出合法/缺 `step_finish`/非零退出三种 JSONL）

**Interfaces:**
- Consumes: `core` 的 `getSession` / `startTurn` / `markTurnRunning` / `finishTurn` / `getTurn` / `openTurn` / `listSessions` / `refreshSessionStatus`。
- Produces:
  - `parseEventLine(line) -> { type, sessionID?, messageID?, text?, finishReason? } | null`
  - `summarizeExport(json) -> { outcome, status, lastText, messageCount, messages }`
    （`messages` 是 `[{ id, type, text, completed }]` 的紧凑数组，给 reconcile 按 `external_ref` 对回某一轮用）
  - `createOpenCodeAdapter({ command?, args?, env? }) -> Adapter`
  - `createAgentRunner({ core, dataDir, adapters?, timeoutMs? }) -> Runner`
  - Adapter 形状：
    ```js
    {
      kind: 'opencode',
      async available() -> boolean,
      async ensureSession({ session }) -> { externalSessionId, created },
      async runTurn({ session, text, onEvent, signal }) -> {
        externalRef, resultText, exitCode, finalReason, timedOut
      },
      async exportSession({ session }) -> { outcome, status, lastText, messageCount, messages }
    }
    ```
  - Runner 形状：
    ```js
    {
      start({ sessionId, text }) -> { turn, done },
      state(sessionId) -> { session, turns, running },
      reconcile(sessionId) -> { session, turn },
      recover() -> number,
      interrupt(turnId) -> Turn,
      close(),
      runningCount
    }
    ```

- [ ] **Step 1: 写 `test-agent.mjs` 的失败测试**

至少包含：

```js
// 解析
eq('step_start 取 sessionID',
  parseEventLine('{"type":"step_start","sessionID":"ses_x","part":{"messageID":"msg_1"}}').sessionID, 'ses_x');
eq('text 取正文',
  parseEventLine('{"type":"text","text":"收到","part":{}}').text, '收到');
eq('坏 JSON 返回 null', parseEventLine('not json'), null);

// 导出核对
const okExport = { info: { outcome: 'succeeded', time: { busy: 10, idle: 20 } },
  messages: [{ type: 'assistant', content: [{ type: 'text', text: '收到' }] },
             { type: 'idle', outcome: 'succeeded' }] };
eq('导出成功识别 succeeded', summarizeExport(okExport).outcome, 'succeeded');
eq('导出取最后一段助手正文', summarizeExport(okExport).lastText, '收到');
const busyExport = { info: { outcome: 'running', time: { busy: 30, idle: 20 } }, messages: [] };
eq('busy > idle 判为 busy', summarizeExport(busyExport).status, 'busy');

// 运行器：正常完成
const runner = createAgentRunner({ core, dataDir: tmp, adapters: [fakeAdapter] });
const { turn, done } = runner.start({ sessionId: sess.id, text: '只回复收到' });
await done;
eq('Turn completed', core.getTurn(turn.id).status, 'completed');
ok('事件文件存在且有 step_start', fs.readFileSync(path.join(tmp, core.getTurn(turn.id).events_file), 'utf8').includes('step_start'));

// 运行器：退出 0 但没有 step_finish -> unknown
// 运行器：超时 -> failed 且会话回 idle
// 运行器：recover 把 running 变 unknown
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test-agent.mjs`
Expected: `Cannot find module './opencode-agent.mjs'`。

- [ ] **Step 3: 实现 `opencode-agent.mjs`**

- `resolveOpenCode()`：默认复用 `backend.mjs` 导出的 `resolveCliBin('opencode')`；允许 `opts.command` / `opts.args` 覆盖（测试用）。
- `ensureSession({ session })`：
  - 已有 `external_session_id` → 原样返回。
  - 没有 → 生成 `ses_` + `Date.now().toString(36)` + 6 位随机，返回 `{ externalSessionId, created: true }`。
- `runTurn`：
  - 参数：`opencode run --format json --auto --session <id> [--model <model>]`，`cwd = session.working_directory`，`windowsHide: true`，`stdio: ['pipe','pipe','pipe']`。
  - prompt 走 stdin（不要拼命令行，Windows 有长度和转义问题）。已实测 `opencode run --session <id>` 会从 stdin 读消息。
  - 逐行解析 stdout；每行调用 `onEvent(parsed)`；同时记录 `sessionID` / 最后一条 `part.messageID` / **每个 step 的文本** / **最后一个 `step_finish` 的 `part.reason`**。
  - **一次 `run` 可能包含多个 step**：工具调用会先产生 `step_finish.reason='tool-calls'`，然后新的 `step_start`。不能把第一次 `step_finish` 当终态；只认进程退出前的最后一个 reason。
  - `resultText` 取**最后一个有文本的 step** 的全部 `text`；如果所有 step 都没文本，才回退到全部文本。不要把 `tool_use` 的 `state.output` 混进结果正文。
  - stderr 按行包成 `{ type: 'stderr', text }` 交给 `onEvent`，不混进结果正文。
  - 退出码非 0 → `exitCode` 保留，`resultText` 保留已收到的正文。
  - `signal` 中止时 `child.kill()`；Windows 下先 `taskkill /PID <pid> /T /F`，再等 2 秒强杀。
  - 返回 `{ externalRef, resultText, exitCode, finalReason, timedOut }`；`finalReason` 是最后一个 `step_finish.reason`，没有则为 `null`。
- `exportSession`：
  - 执行 `opencode session export <id>`，`maxBuffer` 32 MB，超时 15 秒。
  - 解析失败、退出非 0、无 `info` → 抛错，由 Runner 落 `unknown`。
  - `summarizeExport` 的判断：
    - `time.busy > (time.idle || 0)` → `status='busy'`
    - `info.outcome === 'succeeded'` 且不 busy → `status='idle'`
    - 其它 → `status='unknown'`
    - `lastText` 从后往前找 `type==='assistant'` 的第一条，拼接 `content` 里的 `type==='text'`。
    - `messages`：遍历导出里的消息，保留 `{ id, type, text, completed: !!time.completed }`；只给核对用，不返回完整内容。

- [ ] **Step 4: 实现 `agent.mjs`**

- `start({ sessionId, text })`：
  1. 校验 `text.trim()` 非空；`core.getSession` 存在；`working_directory` 真实存在（`fs.statSync().isDirectory()`），否则抛「工作目录不存在」。
  2. `core.startTurn` 插入 queued；拿 `turn.id`。
  3. `ensureSession` 拿到外部 ID；`core.bindExternalSession` 写回；写 `events_file = 'sessions/<turnId>.jsonl'`；`core.markTurnRunning`。
  4. 打开文件流，`onEvent` 逐行写 JSON；同时把每个 step 的 text 存在内存。
  5. `adapter.runTurn` 用 `AbortController` + `timeoutMs`（默认 30 分钟，`AGENT_TURN_TIMEOUT_MS` 可覆盖）。
  6. 终态：
     - 正常退出且最后一个 `step_finish.reason === 'stop'` → `completed`
     - 最后一个 reason 是 `length` → `completed`，`error` 写「模型输出达到长度上限，结果可能不完整」
     - 超时 → `failed`，error「执行超时（N 分钟）已中止」
     - 中止 → `interrupted`
     - 退出非 0 → `failed`，error 带退出码和 stderr 尾部
     - 退出 0 但没有 `step_finish`，或最后 reason 仍是 `tool-calls` → `unknown`，error「事件流不完整，执行结果待核对」
  7. `done` Promise 在 `finishTurn` 后 resolve；所有异常都要落到 `finishTurn`，不能留 `running`。
- `state(sessionId)`：返回 `session` + 最近 20 个 Turn + `running`（如果有）。
- `reconcile(sessionId)`：
  - 调 `adapter.exportSession`；成功则更新 Session 状态。
  - 如果有一轮 `unknown` 且有 `external_ref`，在导出消息里找同 `id` 的 assistant 消息：有 `time.completed` → `completed`；`info.outcome` 失败 → `failed`；找不到 → 保持 `unknown`。
  - 导出失败 → Session 保持 `unknown`，不抛给 HTTP 500，返回 `{ error }` 由 UI 提示。
- `recover()`：`core.recoverOpenTurns()`，然后对最多 20 个 `unknown` Session 在后台逐个 `reconcile`；不要阻塞服务启动。
- `interrupt(turnId)`：找内存里的 child，abort；没有则只把 DB 里的 `running` 改 `interrupted`，error「Cabinet 未找到运行中的进程，已按中断记录」。
- `close()`：abort 所有子进程，等待文件流关闭。
- 结果截断：`result_text` 超过 200 KB 时截断并加标记；事件文件保持完整。

- [ ] **Step 5: 跑测试并提交**

Run: `node test-agent.mjs`
Expected: 全绿。

```bash
git add task-inbox/opencode-agent.mjs task-inbox/agent.mjs task-inbox/backend.mjs task-inbox/test-agent.mjs task-inbox/test-fixtures/fake-opencode.mjs
git commit -m "task-inbox: OpenCode 持久 Session 适配器与 Turn 运行器"
```

---

## Task 3: HTTP 路由与启动恢复

**Files:**
- Modify: `task-inbox/server.mjs`
- Test: `task-inbox/test-agent-http.mjs`

**Interfaces:**
- Consumes: `createAgentRunner`、`createOpenCodeAdapter`、`core` 的 Session API。
- Produces:
  - `GET /api/agents` → `{ agents: [{ kind, available }], roles, running }`
  - `GET /api/tasks/:id/sessions` → `{ sessions }`
  - `POST /api/tasks/:id/sessions` → `{ session, created }`
  - `GET /api/sessions/:id` → `{ session, turns, running }`
  - `POST /api/sessions/:id/turns` → `202 { turn }`
  - `POST /api/sessions/:id/reconcile` → `{ session, turn? }`
  - `POST /api/turns/:id/interrupt` → `{ turn }`
  - `GET /api/projects?include_archived=1` → 包含归档项目

- [ ] **Step 1: 写 `test-agent-http.mjs` 的失败测试**

用 `createCore(tmp)` + `createAgentRunner({core, dataDir: tmp, adapters:[fakeAdapter]})` + `createHandler(core, { runner, queue: null })`，监听 `127.0.0.1:0`，断言：

```js
// 创建会话：默认从项目继承 agent/model/工作目录
const r1 = await fetch(base + '/api/tasks/' + task.id + '/sessions', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({})
});
eq('创建会话 200', r1.status, 200);
eq('继承项目默认 Agent', (await r1.json()).session.agent, 'opencode');

// 发送 Turn
const r2 = await fetch(base + '/api/sessions/' + sid + '/turns', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: '只回复收到' })
});
eq('发送 Turn 202', r2.status, 202);

// 运行中再发 -> 409
const r3 = await fetch(base + '/api/sessions/' + sid + '/turns', { ... });
eq('同一会话并发发送 409', r3.status, 409);

// 核对
const r4 = await fetch(base + '/api/sessions/' + sid + '/reconcile', { method: 'POST' });
eq('核对 200', r4.status, 200);

// 项目归档列表：先造一个空项目并归档
const spare = core.addProject('HTTP 归档项目');
core.updateProject(spare.id, { archived_at: new Date().toISOString() });
const r5 = await fetch(base + '/api/projects?include_archived=1');
ok('include_archived 参数生效', (await r5.json()).projects.some((p) => p.archived_at));
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node test-agent-http.mjs`
Expected: 404 / `createAgentRunner` 未接入。

- [ ] **Step 3: 实现路由**

- `createHandler(core, opts)` 增加 `const runner = opts.runner || null;`；没有 runner 时 Session 路由返回 400「Agent 未启用」。
- 路由顺序：所有 `/api/tasks/:id/sessions`、`/api/sessions/:id`、`/api/turns/:id` 必须写在 `/api/tasks/:id` 单条路由之前。
- `POST /api/tasks/:id/sessions`：
  - 任务不存在 → 404；项目已归档 → 400「项目已归档，先恢复或换一个项目」。
  - `role` 默认 `dev`；`agent` 默认 `project.default_agent || 'opencode'`；`model` 默认 `project.default_model`；`working_directory` 默认项目 `dirs` 里 `primary` 的第一条，否则第一条目录。
  - 没有目录 → 400「先给项目配一个工作目录，或者手动选一个」。
  - 该 Agent 的 Adapter 不存在或 `available() === false` → 400「OpenCode 不可用，先确认 CLI 装好」；1A 只注册 OpenCode，选 Codex 也走这条。
  - 同 `(taskId, role, agent)` 已有会话且 `body.force !== true` → 用 `listSessions(taskId)` 找最新一条返回，`created: false`。
- `POST /api/sessions/:id/turns`：
  - `text` 空 → 400。
  - 已有 `openTurn` → 409（用 `HttpError`，不要走默认 400）。
  - 调 `runner.start`，返回 202 和 `turn`；后台 `done` 的失败只记日志，DB 里已有失败态。
- `POST /api/sessions/:id/reconcile`：`await runner.reconcile(id)`；导出失败返回 200 + `error` 字段，不 500。
- `POST /api/turns/:id/interrupt`：调 `runner.interrupt`。
- `GET /api/projects`：透传 `include_archived`。
- `start(core, opts)`：
  - `const runner = opts.runner || createAgentRunner({ core, dataDir: core.dataDir, adapters: opts.adapters, timeoutMs: opts.agentTimeoutMs });`
  - `runner.recover()` 在 listen 之前调用；返回 `{ server, port, queue, runner }`。
  - 主入口 `stop()` 调 `started.runner.close()`。
  - 启动日志打印恢复条数。

- [ ] **Step 4: 跑测试与回归**

Run:
```
node test-agent-http.mjs
node test-sqlite.mjs
node test-parsers.mjs
```
Expected: 全绿。

- [ ] **Step 5: 提交**

```bash
git add task-inbox/server.mjs task-inbox/test-agent-http.mjs
git commit -m "task-inbox: Agent Session HTTP 接口与启动恢复"
```

---

## Task 4: 抽屉「Agent 会话」区与卡片徽标

**Files:**
- Modify: `task-inbox/board.html`

**Interfaces:**
- Consumes: Task 3 的接口。
- Produces:
  - `drSessions = { sessions: [] }`
  - `drActiveSessionId`
  - `drAgentTimer`
  - `agentSectionHTML(t)` / `drRenderAgent()` / `drStartAgent(t)` / `drSendAgent(sessionId)` / `pollAgentSession(sessionId)`

- [ ] **Step 1: 在 `drLoad` 并行拉会话**

```js
drSessions = await api('GET', '/api/tasks/' + encodeURIComponent(id) + '/sessions')
  .catch(() => ({ sessions: [] }));
```
失败降级为空列表，不能影响整张卡打开。

- [ ] **Step 2: 在 `buildSections(t)` 增加「Agent 会话」区**

- 位置：在「整理后的需求」之后。
- 标题：`Agent 会话` + 数量；右上角 `.mini-btn`「挂一个」。
- 空态：`还没有 Agent 会话。挂一个之后，这里是一个能连续对话的外部 CLI 会话，和上面的 Cabinet 对话不是一回事。`
- 每条会话一行：
  - 状态点（`.agent-dot` + `idle/busy/unknown/unavailable` 类）
  - `角色 · Agent`（如「开发 · OpenCode」）
  - 模型（有值时显示）
  - 最近一轮状态（`已完成 / 失败 / 待核对 / 执行中`）
  - 「打开」按钮
- 展开的当前会话：
  - 最近一轮结果 `<pre class="agent-result">`，失败显示 `.agent-error`
  - 输入框 `textarea.agent-input` + 「发送」`.primary` + 忙碌时「停止」按钮
  - 「核对状态」`.mini-btn`
  - 一行提示：`Agent 会在 <工作目录> 直接执行命令（自动批准权限）。`

- [ ] **Step 3: 绑定事件**

- `[data-agent-new]` → `drStartAgent(t)`。
- `[data-agent-open]` → 设置 `drActiveSessionId`，调 `drRenderAgent()`。
- `[data-agent-send]` → `drSendAgent(sessionId)`；发送时按钮变「发送中…」，成功后清空输入框，启动轮询。
- `[data-agent-stop]` → `POST /api/turns/:id/interrupt`，刷新。
- `[data-agent-reconcile]` → `POST /api/sessions/:id/reconcile`，刷新。
- 输入框 `Ctrl+Enter` 发送；`Enter` 换行（和 Cabinet 对话框一致）。

- [ ] **Step 4: 新建会话弹窗**

复用 `relDialog`，字段：

- 角色：开发 / 审阅 / 规划 / 测试（默认开发）
- Agent：OpenCode（1A 只有一个；Codex 置灰并写「1C 再接」）
- 工作目录：输入框 + 「选目录」按钮（复用 `/api/pickdir`）；默认项目 `primary` 目录
- 模型：输入框，占位符显示项目默认模型
- 提示：`会话建立后工作目录不能改。Agent 会在这个目录直接执行命令。`

提交：`POST /api/tasks/:id/sessions` → 关闭弹窗 → `drLoad()` → 打开新会话。

- [ ] **Step 5: 轮询**

- `pollAgentSession(id)`：每 2 秒 `GET /api/sessions/:id`；更新 `drSessions`；只重绘 Agent 区（`drRenderAgent()`），不重绘整个抽屉，避免输入框内容丢失。
- 会话不忙时停止轮询；`drClose()` 里 `clearInterval(drAgentTimer)`，并把 `drSessions` / `drActiveSessionId` 复位。
- 轮询失败静默，连续 3 次失败显示一行「状态刷新失败，点核对重试」。

- [ ] **Step 6: 卡片徽标**

在 `cardHTML(t)` 的 `meta` 里：

```js
if (Number(t.agent_session_count || 0) > 0) {
  const st = t.agent_status;
  const label = st === 'busy' ? 'Agent 运行中'
    : st === 'unknown' ? 'Agent 待核对'
    : 'Agent ' + t.agent_session_count;
  meta.push('<span class="tag agent ' + esc(st || 'idle') + '" title="这张卡挂着外部 Agent 会话">'
    + esc(label) + '</span>');
}
```

CSS 用现有变量：`.tag.agent` 只加左边框色和状态点，不写死颜色；`idle` 用 `--text-3`，`busy` 用 `--doing`，`unknown` 用 `--p1`。

- [ ] **Step 7: 样式检查与手动验证**

Run: `node style-audit.mjs`
Expected: 0 error。

手动（浏览器 1440×900，打开一张有会话的卡）：
- Agent 区独立于 Cabinet 对话，标题和提示能看出区别。
- 新建会话后工作目录、角色、模型都正确显示。
- 发送后 2 秒内出现「执行中」，完成后显示结果，输入框内容不被轮询清掉。
- 卡片上出现「Agent 运行中 / Agent 1」徽标；完成会后变成「Agent 1」。
- 关闭抽屉再打开，会话和结果还在。

- [ ] **Step 8: 提交**

```bash
git add task-inbox/board.html
git commit -m "task-inbox: 抽屉里的 Agent 会话区与卡片徽标"
```

---

## Task 5: 项目默认 Agent / 模型与归档入口

**Files:**
- Modify: `task-inbox/board.html`

**Interfaces:**
- Consumes: `GET /api/projects?include_archived=1`、`PATCH /api/projects/:id`（`default_agent` / `default_model` / `archived_at`，后者由 core 的 `updateProject` 校验）。
- Produces: 设置里可配置项目默认 Agent / 模型；项目可归档 / 恢复；新建会话自动继承。

- [ ] **Step 1: 项目编辑弹窗加字段**

- `#p-agent`：`<select>`，选项「不指定 / OpenCode / Codex（1C）」。
- `#p-model`：文本输入，占位符「留空 = 用 Agent 默认模型」。
- `#projArchive`：非「默认」且未归档时显示「归档项目」；已归档时显示「恢复项目」。
- `projForm` 提交时带上 `default_agent` / `default_model`。

- [ ] **Step 2: 归档规则**

- 归档前 `confirm`：`归档后侧栏不再显示这个项目。项目里还有未归档任务时会被拒绝。`
- 调 `PATCH /api/projects/:id { archived_at: new Date().toISOString() }`；失败原样 toast。
- 恢复调 `PATCH { archived_at: null }`。

- [ ] **Step 3: 设置里的归档视图**

- 项目列表底部加一行「显示已归档（N）」复选框。
- 勾选时 `GET /api/projects?include_archived=1`，结果存 `archivedProjects`，只用于设置弹窗；侧栏继续用 `store.projects`。
- 已归档项目行显示淡字「已归档」和「恢复」按钮，不显示删除。

- [ ] **Step 4: 新建会话继承**

- `drStartAgent` 打开弹窗时，角色默认开发；Agent 默认 `project.default_agent || 'opencode'`；模型占位符 `project.default_model`；工作目录默认 `project.dirs` 的 primary。
- 如果项目没有目录，工作目录为空并提示先选；不自动猜路径。

- [ ] **Step 5: 手动验证**

- 项目设置里保存默认 Agent / 模型，刷新后仍在。
- 新建会话不填任何字段 → 继承项目默认值。
- 有活跃任务的项目归档被拒，提示条数。
- 空项目归档后侧栏消失；设置里勾「显示已归档」能看到并恢复。
- `node style-audit.mjs` 0 error。

- [ ] **Step 6: 提交**

```bash
git add task-inbox/board.html
git commit -m "task-inbox: 项目默认 Agent、模型与归档入口"
```

---

## Task 6: 端到端验收与文档收口

**Files:**
- Modify: `task-inbox/README.md`
- Modify: `task-inbox/ISSUES.md`
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Modify: `docs/session-collaboration.md`

- [ ] **Step 1: 全量自动化检查**

Run:
```
node test-sqlite.mjs
node test-agent.mjs
node test-agent-http.mjs
node test-parsers.mjs
node style-audit.mjs
```
Expected: 全绿；style-audit 0 error。

- [ ] **Step 2: 真实 OpenCode 两轮验收**

用独立数据目录和端口，不碰真实库：

```powershell
$env:TASK_INBOX_DATA="$env:TEMP\cabinet-1a-accept"
node task-inbox\server.mjs --port 46098
```

在页面上：
1. 新建一条临时任务「1A 验收：连续两轮」。
2. 挂一个 OpenCode 会话，工作目录选 `D:\WorkFiles\code\04_own_github\Cabinet`。
3. 第一轮发「只回复两个字：收到」→ 结果是「收到」。
4. 第二轮发「我刚才让你回复的两个字是什么？只回复那两个字」→ 结果是「收到」。
5. `GET /api/tasks/:id/sessions` 确认 `external_session_id` 两轮不变。
6. 重启服务（`Ctrl+C` 后重开），再打开同一张卡：
   - 会话还在，外部 ID 不变；
   - 状态不是 `completed` 误报（如果没有执行中的轮次，应为 idle）；
   - 第二轮结果还能看到。
7. 删除临时任务，确认 `sessions/` 下对应事件文件消失。
8. 关闭临时服务，删除 `%TEMP%\cabinet-1a-accept`。

- [ ] **Step 3: 恢复场景验收**

在临时库里手工把一条 Turn 置成 `running`，重启服务：
- 启动后 Turn 变 `unknown`，Session 变 `unknown`；
- 点「核对状态」：OpenCode 导出能确认时变 `completed` / `failed`，不能确认时保持 `unknown`；
- 任务状态没有被自动改成 done。

- [ ] **Step 4: 文档更新**

- `task-inbox/README.md`：
  - 流水线表加「会话」一行：`✅ 1A（OpenCode）`。
  - 数据表加 `agent_sessions` / `session_turns`。
  - schema 版本 v8 → v9，补迁移说明。
  - 新增「Agent 会话」使用章节：和 Cabinet 对话的区别、工作目录、`--auto` 提示、恢复语义。
  - 已知限制：1A 只有 OpenCode；不支持图片附件；不做自动交接。
- `README.md`：状态表「会话」改 `✅ 1A 可用`；「交接」仍 `⬜ 1C`；加计划链接。
- `ROADMAP.md` §7：
  - 「还没开始的」移除 1A，保留 1B / 1C；
  - 记录 1A 验收证据（两轮同 ID、重启恢复、测试数）。
- `docs/session-collaboration.md` 顶部：
  - `1A 已实现（OpenCode）；1B / 1C 仍为规划`。
- `task-inbox/ISSUES.md` 末尾「进度」加第九批：
  - schema v9、Session / Turn、Adapter、HTTP、UI、测试数、已知限制。

- [ ] **Step 5: 最终提交**

```bash
git add task-inbox/README.md task-inbox/ISSUES.md README.md ROADMAP.md docs/session-collaboration.md
git commit -m "docs: 收口阶段 1A 的验收与使用说明"
```

---

## 完成定义

- [ ] 同一张卡能挂 OpenCode 持久 Session，两轮对话复用同一个 `external_session_id`。
- [ ] Cabinet 重启后仍能定位原 Session；未完成 Turn 显示 `unknown`，不误报完成。
- [ ] 同一 Session 不会并行跑两个 Turn；第二个请求 409。
- [ ] 每轮有 `user_text`、`result_text`、`error`、`events_file`、起止时间。
- [ ] 删除任务时 Session、Turn 和事件文件一起清掉。
- [ ] 卡片上有 Agent 会话徽标，抽屉里能新建、发送、停止、核对。
- [ ] 项目可配置默认 Agent / 模型；新会话自动继承；项目可归档 / 恢复。
- [ ] `test-sqlite` / `test-agent` / `test-agent-http` / `test-parsers` / `style-audit` 全绿。
- [ ] README / ROADMAP / ISSUES / session-collaboration 与实现一致，不提前宣称 1B / 1C。
