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
