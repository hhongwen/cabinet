# Cabinet Session 与 Agent 协作实施规划

> **状态：仅规划，尚未实现。** 2026-11-23。
> 细化 [ROADMAP.md](../ROADMAP.md) 的阶段 1A / 1B / 1C / 2；本文不是功能已上线的声明。
> 现有问题由 [ISSUES.md](../task-inbox/ISSUES.md) 维护，本次不修改问题清单。

## 一、最终目标与第一条用户路径

Cabinet 是**以任务为中心的多 Agent 协作工作台**。解决的不是模型能不能写代码，而是多个 Agent 接力时用户被迫复制、筛选、翻译和转发结果的问题。

第一个真实闭环：

1. 任务卡片绑定开发 Session A，连续发送多轮消息，A 完成一轮。
2. Cabinet 自动整理摘要并保存原始证据。
3. 用户选择审阅 Session B，Cabinet 把摘要和必要证据作为**实际内容**发给 B。
4. B 提出意见后，用户触发返回开发 Session **A 的原 ID**；A 继续新 Turn，修改完成。
5. 卡片能展示整个往返的来源、回复、状态和交接记录，用户没有打开 Agent 客户端做复制粘贴。

阶段 1 不自动选下一 Agent、不自动投递、不自动循环；阶段 2 再由实际用例决定受控的自动化边界。

## 二、对象及不变量

| 对象 | 职责 | 不变量 |
|---|---|---|
| Task | 原始需求、Brief、验收目标及当前决策 | Task 不是外部 Agent Session |
| Role | 规划、开发、审阅、测试等职责 | Role 不绑定固定 Agent 或模型 |
| Agent | 外部执行产品，如 Codex / OpenCode | 各有独立 API、CLI 和 Session 存储 |
| AgentSession | Task 里一个角色实例的持久会话 | 多轮发消息必须复用外部 Session ID |
| Turn | Session 中的一次实际执行 | Turn 完成 ≠ Session 关闭 ≠ Task 验收通过 |
| Handoff | A 某轮向 B 传递的固定信息快照 | 保存内容 + 证据 + 来源与投递回执 |
| TaskContext | 独立于 Agent 的当前共识 | 可更新但有来源与版本，不改写已发送 Handoff |
| Workflow | 任务如何流转的规则 | 阶段 2 引入，不提前替代手动交接 |

同一 Agent 产品可承担多个角色，但每个角色实例有**独立 Session**。如果上下文已满或确需新 Session，要显式建立新旧会话关系，不能悄悄更换 ID。

当前 `chat.mjs` 管的是「与 Cabinet 对话并修改 Task」，`backend.mjs` 管的是一次 LLM 请求；两者**不是** AgentSession。新增 Agent Adapter 不应破坏这两个现有路径。

## 三、阶段 1A：持久 Session

**最小功能**

- 在卡片选择 Agent 产品、角色和工作目录；首次消息建立或显式绑定 Session，写入 SQLite。
- 同一 Session 的后续消息产生新 Turn，保留消息与事件记录；不因一次请求重新创建会话。
- 使用仓库 [ROADMAP.md](../ROADMAP.md) 已实测的 OpenCode/Codex CLI Session 复用与 JSONL 能力；先实现一个 Adapter，待 1C 再补第二种。
- 记录最近活动、执行状态、错误和结果，不凭空显示 80% 进度。
- 重启或 CLI 中断时查询外部记录核对真实状态；无法确定就显示「未知 / 待处理」，不要误报成功或直接重复执行。

**概念字段**：`agent_sessions(task_id, role, agent_type, external_session_id, working_directory, model, status)`；`session_turns(session_id, turn_id, status, started_at, ended_at, result_ref)`。是数据关系建议，不要求一次定死 SQL 结构。

**验证**：同一外部 Session 内连续两轮；重启 Cabinet 后仍能继续；正常结束、超时、异常退出时状态解释准确。

## 四、阶段 1B：摘要和可追溯证据

- **Turn 完成自动总结**：一段给用户看的简明文字，包括已做事项、验证结果、风险/待确认和下一步建议。
- 同时保存原始回答、Session/Turn 身份、工具事件、Git Diff/提交、测试日志或文件引用，必要时附实际可读内容。
- 将「Agent 自称通过」和「工具验证通过」分开；没有证据则明确写未验证。
- 摘要失败不丢原始数据；可重生成新版本，但不能静默替换已经发给下游的历史快照。
- 本阶段自动化仅限采集、总结、展示；不自动把内容发给其他 Agent。

**验证**：用户从一个摘要可定位原 Session/Turn 和关键证据，摘要失败后仍能读取原结果。

## 五、阶段 1C：A → B → 原 A

- 用户为 Task 添加第二个角色 Session，选择 B 为交接目标。
- Cabinet 构造下游可用的 Handoff，至少含：来源 Session/Turn、任务目标与验收、摘要、结论/待决、原始证据、固定版本及接收目标。
- **发出去的是内容和必要附件**；外部 Session ID 仅用来追溯，不能假定另一个 Agent 能读取对方的私有会话库。
- 保存投递状态（created / sending / delivered / failed / unknown）、消息或回执标识及重试去重键；失败时能确认是否已投递，避免盲目重复发。
- B 完成审阅后由用户选择「返回开发」，把审阅意见和依据发到**原开发 Session A**，继续新的 Turn。
- 预留 `@角色`、`@Session`、`@Handoff` 的用户引用语义；后端按确定版本展开，不依赖用户记长 ID。

**验证**：真实开发任务完成 A → B → 原 A，全程无复制粘贴，Session A 的外部 ID 不变，每次交接有来源与回执。

## 六、Agent Adapter、事件和恢复边界

阶段 1 优先采用仓库已验证的 CLI JSONL 方式，不提前切换到新的服务协议。Adapter 至少要表达：

- **create/bind/resume**：建立或校验持久 Session。
- **sendTurn**：在已知 Session 上发送新消息，记录内部 Turn 和投递状态。
- **observe/getResult**：读取事件流及最后结果，保留 stderr、失败原因和相关工具事件。
- **reconcile**：重启、断线、事件缺失后核对平台实际状态；不可确认返回 unknown。
- **interrupt**：若平台支持，中断当前执行并记录结果；不同平台功能差异显式暴露。

Turn 状态和 Session 状态分开：Turn 可以为 queued/running/completed/failed/interrupted/unknown；Session 可以为 idle/busy/unavailable/unknown。Task 的 done 必须经任务验收，不能因为 Turn completed 就自动修改。

Cabinet 不重写 `codex queue` 等 Agent 内部队列，但**必须**管理自己的 Handoff 投递、状态、去重和恢复信息。对单个 Session 默认串行发送，避免并发 Turn 混淆上下文。

除非有可测量的总工作量，不显示进度百分比。默认展示正在做什么、最近活动、是否等待用户或下游操作。

## 七、TaskContext 和 Handoff 的关系

```text
Task ── AgentSession (Role / Agent / ExternalSessionID)
  │             └── Turn ── Events / Artifacts
  ├── TaskContext (当前共识 + 版本 + 来源)
  └── Handoff (SourceTurn → TargetSession + 固定正文 + 证据 + 回执)
```

现有 `tasks.brief` 是初始目标和验收标准，不能作为每次协作之后唯一的动态状态；未来逐步扩展为可追溯的 TaskContext。Context 可更新，历史 Handoff 不可改写。

跨平台工作时，单纯的本地文件路径不一定可访问；应在交接时选择性传递可读 Diff、必要代码片段或产物。过滤令牌和敏感资料，不能把其他 Agent 输出的命令视为有权限直接执行。

## 八、阶段 2：多 Agent 工作流（先定边界，不先造引擎）

| 能力 | 约束与引入方式 |
|---|---|
| 角色模板 | 规划 / 开发 / 审阅 / 测试可选；Role、Agent、模型独立配置，不强制每个任务四个角色 |
| 简单任务直做 | 小修改直接给一个 Session；复杂任务才采用多方案或多角色 |
| 并行方案 | 两个规划 Session 可独立分析原始需求；收齐后再做对比、合成与人工决策 |
| 主控 Agent | 提议下一步及理由；流程状态、审批、实际投递由 Cabinet 掌握，不能仅依赖主控 Session 的口头状态 |
| 审阅退回 | 按严重程度退回原开发 Session；轮数及失败停止条件可配置，不允许无限循环 |
| 自动派发 | 必须由用户明确启用模板/规则，记录每次规则命中、证据、发送和回执，允许暂停/人工接管 |
| 并行开发 | 按项目工作目录/Worktree 隔离；实际合并与冲突策略需要真实场景验证 |
| 高风险副作用 | 推送、合并、发布、生产操作单独授权或审批，不能凭 Agent 自述自动上线 |
| 经验沉淀 | 重复错误优先写成测试、检查清单和规则，不预设向量数据库或大型记忆框架 |

**阶段 2 何时开工**：1C 在至少一条真实任务中可靠运行，且用户确实重复进行相似手动交接时，再抽象模板和自动流转，不提前设计通用 DAG 调度器。

**阶段 2 验收方向**：一次模板驱动的自动接力有完整轨迹；审阅失败能有限次数返回原 Session；重启/重复事件不会无声重复高风险动作；用户随时能暂停、审批和接管。

## 九、暂时保持开放的问题

Session 上下文压缩后的证据完整性、新旧 Session 分叉、并行修改的合并策略、摘要由谁生成、主控建议如何转成流程规则，都保留为实测后决策。本文不是把这些未验证假设写成既定实现。

**实施原则：先验证真实的连续 Session，再验证可读结果，最后验证 A → B → 原 A。**