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
