# 实现笔记

## 关键决策

**为什么中台和 worker 合成一个进程。** 卡兹克那套要拆两个东西，是因为中台在公网云服务器、Agent 在他家/公司内网，
云服务器推不进内网，所以 Mac 上得挂个长轮询接单程序。单机场景下这个拆分纯属自找麻烦——同一台机器上
再套一层网络往返没有收益。所以 `hub.mjs` 里直接内嵌 `queue.tick()`，跨机需求真出现了再把 `queue` 摘出去当 worker。

**为什么不用 npm 依赖。** Node 24 自带 `node:sqlite`，`node:http` 足够写这个规模的 API，
`chokidar`/`express`/`better-sqlite3` 全都不需要。代价是 glob 得自己写（`util.mjs` 里 40 行搞定常用的 `**/x`），
收益是 Windows 和 Mac 都 `git clone` 就能跑，不用担心 node-gyp 编译。

**prompt 走 stdin。** Windows 上 `codex` 是 `codex.cmd`，把带换行和中文引号的 prompt 拼进命令行必然炸。
用 `spawn(..., {shell:false})` + `stdin.write(prompt)` 绕开整个问题。这也是为什么 config 里 agent 配的是
`node <path-to-codex.js>` 而不是 `codex`——直接调 js 入口，同样躲开 `.cmd` 这层壳。

**`claimJob` 用条件 UPDATE 抢占。** `UPDATE jobs SET status='running' WHERE id=? AND status='queued'`，
看 `changes` 是否为 1。比先 SELECT 再 UPDATE 安全，多 worker 或 tick 重叠时不会重复拉起同一个 job。

**结论里的「需要决策：」是给 Agent 的协议。** 规则里看不清要不要人拍板时，把 `approval` 设成 `review`，
prompt 里要求 Agent 必须拍板时输出 `需要决策：` 开头的一段。runner 扫到就置 `review` + `needs_attention`。
这是最省事的人机协议——不需要结构化输出 schema，模型不会因为 JSON 格式失败。

## 实现中修掉的 bug

1. **`%APPDATA%` 没展开** — agent args 里的 `%APPDATA%/npm/...` 原样传给 spawn，找不到模块。
   修在 `createRuntime`：先 `expandAgentArgs` 再喂 runner。`~` 和 `${VAR}` 走同一套。
2. **`close()` 里 `resolve` 不在作用域** — 优雅退出静默 `ReferenceError`，面板看着正常但进程不退。
3. **中断顺序错** — `killAll` 先于 `markRunningInterrupted`，被杀的子进程被 `finishJob` 写成 `failed(exit 1)`，
   覆盖掉 `interrupted`。改成先标状态，`finishJob` 看到 `interrupted` 就跳过。
4. **关库后回调崩** — 关完 db 还有 statement 回调在跑，`statement has been finalized`。加 `store.isClosed()` 守卫。
5. **watch 的 5s 二次抑制吞真实改动** — 原本想防抖，结果 5 秒内的真实修改被丢掉。删掉，交给 queue 的 `dedupe_key`。
6. **`--port` 后面板显示旧端口** — 实际监听端口没回写给面板 API。修 `cfg.port = actualPort`。

## 没验证的部分（别当成能用）

1. **macOS 一次都没跑过。** 代码层面查过：无 `shell:true`、路径全走 `node:path`、
   唯一平台分支是 `process.platform === 'win32'` 里的 `taskkill`。理论可跑，但没实测。
2. **真实 Ctrl+C 的 SIGINT 路径没端到端验证。** Windows 上 `child.kill('SIGINT')` 实际是 `TerminateProcess`，
   JS 层 handler 不执行（做了对照实验确认）。所以只直接调 `close()` 测了 12 项。真实控制台按 Ctrl+C 能触发
   `process.on('SIGINT')`，但这段没有自动化覆盖。
3. **cron 没真的等到 08:30。** 用 `_check()` 手动推进验证了防重和「重启不补跑」。
4. **飞书 / Telegram 是空壳。** `src/notify.mjs` 里有 `createFeishuAdapter` / `createTelegramAdapter`，
   注释写了要填什么。接飞书需要改三处：
   - `notify.mjs`：填 app_id/app_secret 拿 tenant_access_token，然后调 `/open-apis/im/v1/messages` 发交互卡片；
   - `hub.mjs`：加一条 `POST /api/feishu/callback` 路由接收卡片按钮回调，转成 `approveJob`/`rejectJob`；
   - `cabinet.config.json`：`notify.feishu = { appId, appSecret, chatId }`。
   飞书卡片回调需要公网可达地址，单机场景建议先用 Tailscale Funnel 或 cloudflared，别直接开公网端口。
5. **规则里的 `reasoning` 字段没生效。** 目前只存进 job 表，没映射到 codex 的 `-c model_reasoning_effort`。
   要让生效：config 的 codex args 加 `"-c", "model_reasoning_effort={reasoning}"`，runner 里补这个占位符。

## 下一步建议

- **先只用一条规则跑一周**。`inbox-triage` 是最有价值的——你这个 han_kl 仓库的 `00_Inbox` 明显在堆东西。
  跑顺了再加 `daily-brief`。规则一多，噪音会盖过收益。
- **规则文件要进 git** （`rules.json` 已经在仓库里了），但 `~/.cabinet/` 那个 db 别进——里面有 transcript 路径和结论。
- **`--json` 的 transcript 会很大。** 现在全量落盘，长期要加轮转（保留最近 N 天）。
- 真要跨机，把 `queue.mjs` 抽成一个 HTTP 拉取端点，Mac 上跑同一个 `bin/cabinet.mjs worker` 连回来，
  规则里加 `where: "mac"` 字段过滤。这是卡兹克那套长轮询的最小实现，现在没必要。

---

# 二期：任务编排层（2026-11-11）

从「事件驱动」改成「任务驱动」。目标见 GOAL.md，方案见 DESIGN.md。
本节记录实现期的决定和踩到的坑。

## 新增模块

| 文件 | 作用 |
|---|---|
| `src/magpie.mjs` | Magpie 对接。唯一允许「知道有哪些模型」的地方 |
| `src/schema-tasks.mjs` | 任务层表定义（和原 events/jobs 分离，便于迁移期并存） |
| `src/tasks.mjs` | 任务存储 + 状态迁移 + 群消息 + 待办 + 时间线 |
| `src/planner.mjs` | 拆解器。调 LLM 把任务拆成图，判模糊 |

测试：`examples/tasktest.mjs`（44 项）、`examples/plannertest.mjs`（31 项）。

## 关键决定

**Magpie 不写插件，读两个现成出口。**
它的插件系统是「接模型供应商」用的，属于它的内政，侵入会跟着它升级挂掉。
实测两条通道冷热差异极大：
- 网关 `127.0.0.1:3425/v1` 的 `/v1/models` → **26ms**，63 个模型
- CLI `magpie quota --json` → **8~12 秒**；`magpie ls` → 十几秒

所以：热路径只走网关，CLI 只给 doctor 和低频缓存。
额度必须「后台刷新 + 长缓存」，绝不能同步等，更不能进调度循环。

**`blocked` 状态不落库。**
由 deps 每次现算（`depsSatisfied`）。
落库的 blocked 标记一定会出现「前置完成了但忘记解锁」的经典 bug。
代价是每次 tick 要查一次 deps，但单机场景这点开销可以忽略。

**前置 rejected/failed 都不算满足。**
下游不该在前置失败时照跑。`depsSatisfied` 只认 `done`。

**防环在写入时算，不在查询时算。**
`wouldCycle` 沿 depends_on 上溯，发现能回到自己就拒。
三节点环（X→Y→Z，Z 再依赖 X）已测。

**判模糊不靠模型自评。**
用结构化完备性：`cwd` / `done_when` / `agent` 三项必须填全且不是占位符。
这条判据是客观的，可以拿任何一条子任务去验证，不用看模型脸色。

**`atomic` 不是「工作量小」，是「只有一个可验证产出」。**
第一版 prompt 写的是「一个人一次能干完就判 atomic」，
结果把「加优先级功能（存储+调度+面板）」判成了 atomic —— 明显该拆。
改成按三条判据：能否分别验证 / 副作用等级是否不同 / 有无真实先后依赖 / 某步失败是否该连累其他。
改完 3/3 命中。

## 踩到的坑

1. **长 heredoc 会静默截断。** 用 `cat > f << EOF` 写超过约 200 行的文件，
   在 Git Bash 下会被切断且只报一个 warning，文件看似存在但内容不全。
   症状：`node --check` 报 `Unexpected end of input`。
   对策：分段追加，每段写完立刻 `node --check`。

2. **截断导致函数被切掉一半，补写时容易留下重复定义。**
   `reasoningLevelsOf` 一度出现两份。写完要用
   `grep -c "function xxx"` 逐个确认为 1。

3. **`quota` 的窗口字段是 `name`/`used`/`remaining`。**
   第一次截断把 `name` 和 `used` 两行吃掉，导致刹车判据报
   「codex 的「undefined」只剩 12%」。已修。

## 未验证

- 拆解器只测了 3 个用例，样本太小。真实任务的长尾（尤其是中文模糊需求）没覆盖。
- 拆解耗时 7~25 秒，串在任务入口上会让「发消息→看到任务」有明显延迟。
  可能需要先建 inbox 任务立刻返回，后台再拆。
- 尚未接入调度器。`tasks.mjs` 只是存储层，`scheduler.mjs` 还没写。

## 调度器（src/scheduler.mjs + src/runner-task.mjs）

一期链路：`拆解 → 落库 → 调度 → 执行 → 结论回群`，已用真实 codex 跑通。

测试：`examples/schedtest.mjs`（39 项，假 agent）、`examples/e2etest.mjs`（真实 codex，约 3 分钟）。

### 决定

**runner 不改，另起 runner-task.mjs。**
原 runner.mjs 有 44 项 selftest 覆盖，动它风险大。新版复用它的
`buildCommand` / `extractAssistantText` / `needsDecision`，
只补「首轮 exec / 续轮 resume」这一层。

实测：`codex exec resume <id>` **不支持 `-C` 和 `-s`**。
续轮时这两个参数必须剔除，沙箱只能靠 config.toml 的 `sandbox_mode`。

**重试开新会话，追加轮续旧会话。**
一开始我用 `attempt === 1` 判断，结果把「同一个任务跑第二轮」也当成了重试。
正确判据是**上一轮 run 的结局**：
- 上一轮 failed → 重试，开新会话（在错的上下文里接着聊只会更错）
- 上一轮 done 且有新消息 → 追加轮，续会话保记忆

**依赖要传产出，不只是等完成。**
这是端到端实测踩出来的，假 agent 永远测不到：
子任务 A 算出「3」，子任务 B 依赖 A，B 的 prompt 里只有「A 已完成」，
没有 A 的结论 —— B 直接回答「未找到前一任务的结果，需要决策」。
修法：`collectDepOutputs` 把前置任务的 `last_message` + 新产生的文件
注入下游 prompt 的「前置任务的结果」段。
改完同一个用例跑通：B 拿到 `0` 并写进 answer.txt。

**系统消息不能回灌给 agent。**
scheduler 会往群里发「▶ 开始执行」，然后再读未读消息拼 prompt ——
结果把自己刚发的播报当成人类指令喂了进去。
修法：`unreadMessages` 只取 `human` 和 `session`，`system` 不参与。

**日志路径必须落库。**
`startRun` 里算出来的 log_path / transcript_path 一开始只在内存里，
没写回 db，面板根本找不到日志。现在由 runner 返回、scheduler 落库。

## 踩到的坑（补充）

4. **`'\n'` 通过 Node 脚本写文件会被写成真换行。**
   用 heredoc 传 `\n` 到 node，再 `replace` 进文件，反斜杠经常被吃掉一层，
   生成的文件里出现真正的换行，`console.log('` 后面直接断行。
   对策：用 `String.fromCharCode(92) + 'n'` 拼出字面的 `\n`。

5. **`sed -i 'Na\'` 在 Git Bash 下会失败。**
   报 `expected \ after 'a'`。改用 Node 读写文件来做插入。

6. **`/tmp` 在 Git Bash 下是 `C:\Users\<user>\.config\alma\scratch`。**
   `node` 里用 `/tmp/x.json` 会解析成 `<盘符>:\tmp\`，读不到。
   用 `cygpath -w` 换真路径，或直接写项目内路径。

7. **httptest 需要 hub 已在跑**（默认 8891）。
   直接跑会 13 项全失败，报 `fetch failed`。这不是测试坏了。

## 现在的完整测试矩阵

| 测试 | 项数 | 需要什么 |
|---|---|---|
| `examples/tasktest.mjs` | 48 | 无 |
| `examples/plannertest.mjs` | 31 | 无 |
| `examples/schedtest.mjs` | 39 | 无（假 agent） |
| `examples/selftest.mjs` | 44 | 无（假 agent） |
| `examples/sourcetest.mjs` | 21 | 无 |
| `examples/httptest.mjs` | 13 | hub 已在 8891 跑 |
| `examples/e2etest.mjs` | 端到端 | 真 codex + Magpie，约 3 分钟 |

# 三期：面板（public/index.html）

旧面板是三栏 jobs 界面，保留为 `public/jobs.html` 备查。
新的 `index.html` 是任务版：左树 / 中详情+群消息 / 右待办。

## 新增

| 文件 | 作用 |
|---|---|
| `src/hub-tasks.mjs` | 任务层 API 路由，从 hub.mjs 拆出来 |
| `public/index.html` | 新面板 |
| `public/jobs.html` | 旧面板备份 |
| `examples/paneltest.mjs` | 面板 API 测试（21 项） |

## API

| 路由 | 作用 |
|---|---|
| `GET  /api/tasks/state` | 任务列表 + 统计 + 待办 + 群 + 项目 |
| `GET  /api/tasks/:id` | 单任务详情（含 runs / children / timeline / 群消息） |
| `POST /api/tasks` | 新建任务 |
| `POST /api/tasks/:id/approve\|reject\|rerun` | 审批 / 重跑 |
| `POST /api/tasks/:id/priority` | 改优先级 |
| `GET  /api/groups/:id/messages` | 群消息 |
| `POST /api/groups/:id/messages` | 往群里说话 |
| `POST /api/todos/:id/resolve` | 处理待办 |

hub 的 tick 现在同时驱动事件队列和任务调度器。额度刹车命中时并发降到 1。

## 面板验证方式（这次没偷懒）

不只看截图，用 Chrome 无头 + CDP 真的点了：

- 弹窗打开 → 填中文 → 提交 → 服务端标题正确
- 点任务树 → 详情渲染 → 依赖区 1 项（「识别待归位文件 · done」）
- 群消息 7 条、时间线 5 条都渲染出来
- 全程 JS 运行时错误 0

截图：`p3.png`（初始）、`p5.png`（依赖+群消息展开）。

## 踩到的坑（补充）

8. **curl 在 Windows 下发的请求体不是 UTF-8。**
   中文标题存进库变成 `������`。这不是显示问题，是数据被写坏了。
   现在 API 加了编码校验：请求体里出现 U+FFFD 直接 400，
   宁可拒绝也不落库。

9. **演示数据里写 `status: 'ready'` 会被调度器真的拉起来跑。**
   造 mock 数据时要避开会被调度的状态，否则截图期间会有真实 codex 在干活。
   用 `awaiting_plan`（等人审）这类状态安全。

10. **面板挂载路由时，`/api/todos` 漏了分派。**
    路由函数写了但 hub 的分派条件只认 `/api/tasks` 和 `/api/groups`，
    待办 resolve 一直 404。加了 `/api/todos` 前缀才通。

11. **旧 httptest 的两条断言绑定了旧面板。**
    「有手动触发表单」和「轮询 /api/state」都要改成新版
    （「+ 新任务」按钮、轮询 /api/tasks/state）。这不是代码 bug。

## 测试矩阵（更新）

| 测试 | 项数 | 需要什么 |
|---|---|---|
| `examples/tasktest.mjs` | 48 | 无 |
| `examples/plannertest.mjs` | 31 | 无 |
| `examples/schedtest.mjs` | 39 | 无（假 agent） |
| `examples/selftest.mjs` | 44 | 无（假 agent） |
| `examples/sourcetest.mjs` | 21 | 无 |
| `examples/httptest.mjs` | 13 | hub 在跑 |
| `examples/paneltest.mjs` | 21 | hub 在跑 |
| `examples/e2etest.mjs` | 端到端 | 真 codex + Magpie，约 3 分钟 |

离线合计 183 项，在线 34 项。

## 面板还没做的事

- **飞书没接**。长连接方案验证过可行，一行代码没写。
- **拆解没接到面板**。现在面板建的任务停在 `inbox`，
  没有任何东西会去拆它 —— 拆解器写好了但没接进入口。
  这是当前最大的断点。
- **SSE 没做**，还是 3 秒轮询。
- **重跑不清理旧 run**，只在 task_runs 里累加。

## 入口层（src/ingest.mjs）

补上了最关键的断点：面板建的任务原本停在 `inbox` 没人拆。

现在：`POST /api/tasks` → 立刻返回 inbox（实测 **82ms**）→ 后台拆解 → 落库 → 调度器接管。
串行等拆解要 7~25 秒，入口上不能这么干。

实测完整链路（真实 codex，在 han_kl 上）：
```
新建 → 82ms 返回 inbox → 后台拆出 3 个子任务 → 调度器自动拉起第 1 个
```

## 判模糊的落地

`ingesttest.mjs` 26 项覆盖了三条分支：
- 原子任务 → 直接 ready
- 确定计划 → 自动 ready，不等
- 含 external → 全部 `awaiting_plan` + 生成 `plan_review` 待办

`approvePlan` 放行后才变 ready，依赖关系依然生效。

## 踩到的坑（补充）

12. **`renderDetail` 里替换按钮区时留下了一个多余的 `}`。**
    语法检查报 `Unexpected token '}'`，但逐行看结构都正常 ——
    因为括号深度在第 277 行变成负数，前面某处少了一个 `{` 的配对。
    用「按行累加括号深度、找第一个负深度」的方式才定位到。
    以后改这块建议每次改完都跑一次括号平衡检查。

13. **heredoc 里的 `\'` 会被吃成 `'`。**
    面板里那一堆 `onclick="fn('id')"` 拼接，用 heredoc 写入时
    反斜杠会被剥一层，生成非法 JS。
    对策：这类含嵌套引号的代码用 Python `io.open` 写，不用 bash heredoc。

14. **`ingest` 没解构进 startHub。**
    路由传参加了 `ingest`，但 `const { ... } = rt` 那行漏了，
    调用时报 `ingest is not defined`。新增依赖时两处都要改。

15. **后台拆解在库关闭后仍会写库。**
    `accept` 起的是后台 promise，进程退出时 db 已关，
    接着抛 `database is not open` 未捕获异常。
    和原 queue.mjs 修过的 bug #4 是同一类。
    现在加了 `safe()` 守卫：库关了就当正常放弃，只 warn 不崩。

# 四期：飞书（走 lark-cli 长连接）

## 方案选型：走错了两次才对

1. **第一版：Webhook**。我查到官方 SDK 依赖 protobufjs，判断「长连接要手写 protobuf」，
   于是退回 Webhook，还让用户去开 Tailscale Funnel。
2. **第二版：自己写 pbbp2 protobuf**。查了协议（Frame{SeqID,LogID,service,method,
   headers[],payload}），技术上可行但要维护约 200 行协议代码，
   出错表现为「消息随机丢」，很难查。
3. **最终：调 lark-cli 子进程**。这是参考实现 `plugins/feishu/channel.ts` 的做法：
   ```ts
   spawn("lark-cli", ["event", "consume", "card.action.trigger", "--as", "bot"])
   ```
   CLI 挡住 protobuf，我们只读它的 stdout（一行一个 JSON）。

**关键认知**：零 npm 依赖 ≠ 零外部依赖。依赖一个外部 CLI 是完全可接受的，
依赖一个 npm 包会破坏 `git clone` 即跑。这两件事不是一回事。

**收益**：不需要公网地址、不需要 Funnel、不需要手写协议。

## 配置要点

`lark-cli` 用 profile 区分不同 app：

```
lark-cli config init --app-id cli_xxx --app-secret-stdin --brand feishu --name cabinet
lark-cli auth login --profile cabinet --domain im,event
```

`cabinet.config.json` 里 **不存 appSecret**，只存 appId 和 profile 名。
真凭据在 lark-cli 自己的存储里（`~/.lark-cli/config.json`）。

## 踩到的坑（补充）

16. **Windows 上 spawn('lark-cli') 报 ENOENT。**
    它是个 .cmd 包装脚本。照项目一贯做法绕开：直接调
    `node <npm-root>/node_modules/@larksuite/cli/scripts/run.js`。
    见 `resolveCli()`。这和 config 里 codex 的处理方式一致。

17. **lark-cli 把 stdin EOF 当成退出信号。**
    用 `stdio: ['pipe',...]` 并且**不要 `stdin.end()`**，只 write 一个空串保持打开。

18. **同一时刻只能有一个消费者拿到事件。**
    调试时开了多个进程，事件被随机一个吃掉，表现为「明明发了却收不到」。
    测之前一定要 `lark-cli event stop --profile <name>`。

19. **`stats: conn.stats` 存的是快照。**
    在 return 对象里这样写会把构建那一刻的值固化，之后永远不变。
    必须写成 `get stats() { return conn.stats; }`。

## 联调验证

真实链路跑通（2026-11-11 21:39）：

```
飞书发「整理一下我今天的笔记」
  → fs-bridge 收到事件 → 建任务 task_mwc60qt8d97a42
  → planner 拆解：kind=plan 子任务=2 需人审=false
  → 调度器接管
```

`examples/feishucli-test.mjs` 是可重复的联调脚本（需要真账号，会等用户发消息）。

## 测试

| 测试 | 项数 | 需要什么 |
|---|---|---|
| `examples/feishutest.mjs` | 27 | 无（离线） |
| `examples/feishucli-test.mjs` | 4 | 真账号 + 有人在窗口内发消息 |

## 还没做

- 卡片按钮回调没做端到端验证（离线测了逻辑，没真点过）。
  需要 `card.action.trigger` 也起一个消费者。
- 消息去重：飞书会重推事件，目前靠 `message_id` 没做幂等。

## 卡片回调：两个真问题（用户实测反馈）

### 1. 点完按钮还能再点，第二张卡片报错

**现象**：点「通过」之后卡片外观不变，按钮还在，可以反复点。

**根因**：飞书不会因为按钮被点击就自动改变卡片样子。必须主动调
`im messages patch` 把它换成「已处理」的样子。

**修法**：
- 新增 `sender.patchCard(messageId, card)`
- 新增 `settledCard()`：绿色/灰色标题 + 结果文字 + note「已处理，这条不用再点」，
  **不含任何 button 元素**。按钮不在了就没法再点。
- 处理完立刻 `patchCard`。

**顺带加的防御**：
- `handledMessages` 集合：同一条 message_id 只处理一次（飞书可能重推事件）
- 已完成的任务（done/rejected/accepted）不再执行动作，只把卡片刷新成现状

### 2. 「目标回调服务当前在线」报错

**根因**：`card.action.trigger` **必须在飞书开发者后台单独开启**。
用户只开了 `im.message.receive_v1`。

飞书的事件订阅和卡片回调是两套配置：
- 事件订阅 → `im.message.receive_v1`（已开）
- 卡片回调 → `card.action.trigger`（未开）

**这不是代码问题，是后台配置。** 代码侧准备好后，去后台加这一条即可。

### 双消费者

`card.action.trigger` 和 `im.message.receive_v1` 是两个独立事件流，
必须各起一个 lark-cli 消费者。之前只起了消息那个，
所以点按钮根本没人听（日志里 `eventsSeen` 一直是 0）。

现在 `bridge.start()` 会并行起两个，`stats` 里分开统计 `eventsSeen` 和 `cardEvents`。

## 卡片「patch 报成功但没变」——真凶

现象：改了 patchCard 之后，返回 `ok:true, exitCode:0`，
但用户看到卡片还是原样，按钮还在，还能点。

**根因**：`lark-cli` 的失败信息**打在 stderr，stdout 是空的**。
我的 `run()` 只读 stdout，`tryJson('')` 返回 `null`，
调用方拿到 null 就当没事发生了 —— **所有失败都被静默吞掉**。

证据：用不存在的 message_id 调 patch：
```
exit code: 1
STDOUT: ""
STDERR: {"ok":false,"error":{"code":99992354,"message":"...not a valid {open_message_id}..."}}
```

**修法**：
1. `run()` 返回 `{ out, err, code }`（之前丢了 exit code）
2. 新增 `parseResult()`：
   - JSON 先找 stdout，再找 stderr
   - `ok === false` 或 `code !== 0` 一律算失败
   - 完全没输出也算失败（不能静默）
3. `tryJson()` 增强：能从混着日志的文本里挖出 `{...}` 那段

**这个 bug 的影响面比卡片大得多**：发消息、发卡片、patch 全都受影响。
在此之前，任何一次发失败都会被当成「没输出」，调用方察觉不到。

新增 `examples/feishucli-unit.mjs`（12 项）专门覆盖这些失败路径。

## 端到端最终验证（2026-11-11 22:07）

```
推卡片 → 用户点「通过」
  → 卡片回调收到（task=task_mwc6yv2w78d11c msg=om_x100b607327...）
  → 任务 review → done
  → 卡片被 patch 成：
      <card title="最终验证：点「通过」">
      已通过：最终验证：点通过
      📝 已处理，这条不用再点
      </card>
```

按钮消失，重复点击不再可能。

## 关于 card.action.trigger 订阅

飞书开放平台 → 应用 → 事件与回调 → 事件配置 → 添加事件 →
搜「卡片回传交互」/ `card.action.trigger`。

和 `im.message.receive_v1` 是两条独立的订阅，必须分别加。
用户已加。

## 重试

飞书 API 会抖（实测遇到过 3 次 `dial tcp ... connectex` 超时）。
`sendText` / `sendCard` / `patchCard` 都包了重试。

**只重试网络类错误**（`error.type` 匹配 network / transport / timeout）。
业务错误（ID 不存在、权限不足）重试无意义，只会让用户白等 ——
实测业务错误 1120ms 返回，和正常路径 1175ms 差不多，没有白等重试。

参数：3 次，间隔 800ms / 1600ms（递增）。

**patch 失败不阻塞业务**：任务状态该变还是变，只是卡片会停在可点状态
（这种极端情况宁可状态正确、卡片难看，也不要为了卡片好看把业务回滚）。
