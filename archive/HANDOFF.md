我要你接手一个已经在跑的项目：Cabinet。

===========================================================
一、先读这些，按顺序，别跳
===========================================================

1. README.md      —— 项目定位、架构、和参考实现的差异
2. NOTES.md       —— 实现期的决策、修过的 6 个 bug、5 项未验证内容、下一步建议
3. cabinet.config.json 和 rules.example.json —— 运行时配置、规则 schema
4. src 目录下 9 个模块：util / config / db / rules / queue / runner / hub / notify，以及 sources 下的 cron / watch / http

===========================================================
二、这是个什么东西
===========================================================

单机版个人 Agent 自动化系统。核心思想来自数字生命卡兹克的方案，和 DeepSeek 的《Super-agent 设计探索》：
把任务的起点从人身上拿掉。事件触发 Agent，Agent 自己干，只有需要人拍板时才来找我。

Cabinet 这个名字是双关：内阁，替我办事只呈报大事；文件柜，每件事都留底。

四层结构：

  事件源（cron / 文件监控 / HTTP / CLI）
    -> 统一事件信封（source, type, subject, summary, link）
    -> 规则派发（rules.json 决定谁干、在哪干、用什么模型、要不要我批）
    -> 无头 Agent 执行（codex exec 或 opencode run）
    -> 本地面板批奏折（http://127.0.0.1:8787）

===========================================================
三、技术事实（硬约束，不许改）
===========================================================

1. 零 npm 依赖。只用 Node 内置模块：node:sqlite、node:http、node:child_process。
   Node 版本要求 >= 22。
2. 必须 Windows 和 macOS 双平台可跑。路径全部走 node:path，禁止硬编码斜杠。
   禁止 shell: true。
3. prompt 必须走 stdin 传参。Windows 下 CLI 是 .cmd，把带换行的 prompt
   拼进命令行参数必然会炸。这是踩过的坑，不要"优化"掉。
4. 默认只绑 127.0.0.1，不暴露公网。
5. 代码注释用中文。

===========================================================
四、代码地图
===========================================================

src/db.mjs
  node:sqlite。4 张表：events、jobs、rules_seen、meta。WAL 模式。
  claimJob 用条件 UPDATE 抢占，防止并发时重复拉起同一个 job。

src/rules.mjs
  rules.json 加载与匹配。从上往下第一条命中即止。
  subject 支持星号前缀通配。
  按文件 mtime 热加载，规则文件写坏了就保留旧规则，不崩。

src/queue.mjs
  去重（dedupe_key，命中时给旧 job 的 duplicate_count 加一）。
  双层并发限制：全局 workers 上限，加上每条规则自己的 concurrency。
  tick() 是唯一的驱动入口。

src/runner.mjs
  拼命令（占位符替换，为 null 的可选参数要整对剔除）。
  喂 stdin。把 --json 输出解析成 JSONL transcript。
  读 -o 指定的文件拿最终结论。超时 kill。

src/hub.mjs
  HTTP 服务、API 路由、tick 循环、优雅退出。

src/sources/cron.mjs    定时。支持 at:"08:30" 和 every:"15m"。同分钟防重，重启不补跑。
src/sources/watch.mjs   文件变化。fs.watch recursive + debounce。
src/sources/http.mjs    POST /api/events，可选 Bearer token。

src/notify.mjs
  adapter 模式：panel 和 webhook 已实现，feishu 和 telegram 是空壳，注释里写了要填什么。

bin/cabinet.mjs   CLI 入口。
public/index.html 单文件三栏面板，零 CDN，2 秒轮询。

===========================================================
五、状态机（7 个状态，别自创）
===========================================================

  queued
    -> awaiting_approval --approve--> queued -> running
    -> awaiting_approval --reject---> rejected
    -> running（规则不需要事前审批时直接进这里）

  running 的出口：done、failed、review、interrupted

  review 表示"跑完了但需要人看一眼"，由 needs_attention 标记。

===========================================================
六、人机协议（最容易被误删的一条）
===========================================================

规则里 approval 设为 review 时，prompt 会要求 Agent：
只要必须由人拍板，就在结论里输出以"需要决策："开头的一段。

runner 扫到这个字符串，就把 job 置为 review 并设 needs_attention=1。

这是刻意的设计，不是偷懒：用自然语言协议代替结构化输出 schema，
模型不会因为 JSON 格式不合规而整个任务失败。

如果你打算重构这块，请先想清楚替代方案怎么处理"模型格式失败"这个场景。

===========================================================
七、CLI 命令
===========================================================

node bin/cabinet.mjs doctor
    环境自检。node 版本、node:sqlite、agent 是否存在、规则能否解析、db 能否打开、端口是否空闲。

node bin/cabinet.mjs start --port 8787
    起中台和 worker，前台常驻。

node bin/cabinet.mjs emit --source cli --type manual --subject test --summary "..." --link url --payload json --yes
    手动投一个事件并跑一次。--yes 表示跳过事前审批直接跑。

node bin/cabinet.mjs jobs --status awaiting_approval --limit 20
    任务列表。

node bin/cabinet.mjs show job_xxx
    任务详情，包括 transcript 尾部。

node bin/cabinet.mjs approve job_xxx --note "..."
node bin/cabinet.mjs reject  job_xxx --note "..."
node bin/cabinet.mjs stats
    各状态计数，按规则分组的耗时。

===========================================================
八、已验证 / 未验证（别把未验证的当能用）
===========================================================

已验证：

- doctor 15 项全绿
- 真实 codex 无头跑通两次。一次直接返回"收到"，耗时约 1 分 42 秒；
  一次经由面板 API approve 后跑完。
- examples/selftest.mjs 44 项断言全过，用假 agent 跑完整链路。
- examples/httptest.mjs 13 项全过，含目录穿越拦截、去重合并、状态机非法转换返回 400。

未验证（改动这些区域要格外小心，也别声称已经能用）：

1. macOS 一次都没跑过。代码层面查过：无 shell:true、路径全走 node:path、
   唯一的平台分支是 win32 下的 taskkill。理论可跑，但没实测。
2. 真实 Ctrl+C 的 SIGINT 路径没做过端到端验证。Windows 上 child.kill('SIGINT')
   实际是 TerminateProcess，JS 层 handler 根本不执行。所以只直接调用 close() 测了 12 项。
3. cron 没真的等到触发时刻。用内部 check 方法手动推进，验证了防重复触发和"重启不补跑"。
4. 飞书和 Telegram adapter 是空壳，只有注释说明要填什么。
5. 规则里的 reasoning 字段目前不生效。只存进了 job 表，没有映射到 codex 的
   model_reasoning_effort 参数。要生效需要在 config 的 codex args 里加占位符。

===========================================================
九、工作方式
===========================================================

- 改完代码先跑 node bin/cabinet.mjs doctor。
- 涉及链路的改动，跑 node examples/selftest.mjs。
- 要测真实 Agent 就用 emit --yes，但单次要一分多钟，别频繁跑。
- 测试会在用户目录下生成 .cabinet 目录，里面有 db 和 logs。
  这是本地运行数据，.gitignore 已排除，绝对不要提交。
- 提 commit 前确认没有把 db 文件、logs 目录、真实 token 带进去。
- 分支是 main，远端是 https://github.com/hhongwen/cabinet.git

===========================================================
十、当前我最想要的方向
===========================================================

先别急着加功能。优先级：

1. 让 inbox-triage 这一条规则真正跑顺。它监听知识库的 00_Inbox 目录，
   新文件进来就按 AGENTS.md 的规则归位。跑稳一周再加别的。
2. 补 macOS 上的实测。这是目前最大的未知。
3. 规则文件里的 reasoning 字段接上 codex 的推理强度参数。

功能扩张排在后面。规则一多，噪音会盖过收益，这是参考实现里最值得吸取的教训。
