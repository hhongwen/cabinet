# Cabinet

> 内阁，也是文件柜。

你雇了一屋子 Agent。它们自己找活、自己干、自己收尾。
**Cabinet** 是中间那个角色：替你张罗、替你留底，只有真正该你拍板的事才呈上来。

要是你更爱卡兹克那个比喻——你只负责**批奏折**，其余免打扰。

---

单机版个人 Agent 自动化系统。参考
[数字生命卡兹克：折腾了整整1年，我这套Agent自动化系统](https://x.com/Khazix0918/article/2117054043868860521)
和 DeepSeek《Super-agent 设计探索》。

**核心命题**：把任务的起点从人身上拿掉。事件触发 Agent，Agent 自己干，
只有需要拍板的时候才来找你。

## 和卡兹克那套的差别

他的是**多机 + 公网**：事件中台在云服务器，Agent 在办公室/家里内网的 Mac 上，
靠长轮询接单；审批走飞书卡片。

你这只有一两台电脑，所以砍掉一半：

| 他那套 | 你这套 | 原因 |
|---|---|---|
| 云服务器上的中台 | 本机常驻进程 | 不用服务器，不用公网 IP |
| 长轮询接单程序 | 本地直跑；跨机时同一套 `worker` 拉取 | Windows/Mac 都能当 worker |
| 飞书卡片审批 | 本地 http://127.0.0.1:8787 面板 | 零外部依赖，通道留 adapter |
| rules.json 派发 | **保留**（这是他这套最值钱的部分） | 换 Agent / 换模型改一行 |

## 四层

```
事件源 (cron / 文件监控 / HTTP / CLI)
        │  统一信封 {source,type,subject,summary,link}
        ▼
   事件中台 (hub)
        │  rules.json 决定：谁干、在哪干、用什么模型、要不要你批
        │  去重 + 并发限制 + 全量落库
        ▼
   执行层 (worker)
        │  codex exec / opencode run 无头运行，transcript 全留
        ▼
   决策层 (批奏折)
           面板里 approve / reject，点完 Agent 继续
```

## 目录

```
Cabinet/
  bin/cabinet.mjs      CLI 入口
  src/hub.mjs             HTTP 服务 + 面板 + API
  src/db.mjs              node:sqlite 存储
  src/rules.mjs           rules.json 加载与匹配
  src/queue.mjs           去重、排队、并发
  src/runner.mjs          调 codex / opencode
  src/sources/cron.mjs    定时
  src/sources/watch.mjs   文件变化
  src/sources/http.mjs    POST /api/events
  src/notify.mjs          审批通知 adapter（panel / webhook / feishu 预留）
  public/index.html       面板
  rules.example.json      规则示例
  cabinet.config.json    运行配置
```

## 快速开始

```bash
node bin/cabinet.mjs doctor          # 检查 codex / opencode
node bin/cabinet.mjs start           # 起中台 + 本地 worker
node bin/cabinet.mjs emit --source cli --type manual \
  --subject han_kl --summary "整理 00_Inbox 里今天的笔记"
node bin/cabinet.mjs jobs            # 看任务
node bin/cabinet.mjs approve <jobId>
```

面板：http://127.0.0.1:8787

## 状态机

```
queued ──(需要事前批)──> awaiting_approval ──approve──> running
   │                          └──reject──> rejected
   └──(无需批)────────────────────────────────────────> running
                                                            │
                              ┌──需要事后确认──> review ──approve──> accepted
                              └──无需确认──────────────────────> done
                                                        running ──err──> failed
```

## 设计约束

- **零 npm 依赖**：只用 Node 24 内置（`node:sqlite` / `node:http` / `node:child_process`），
  Windows 和 Mac 都是 `git clone` 就能跑。
- **不暴露公网**：默认只绑 `127.0.0.1`；跨机用 Tailscale/SSH 隧道。
- **所有事件必留底**：谁来的、交给了谁、结论是什么、要不要你留意，全在库里。
- **Prompt 走 stdin**：避免 Windows `.cmd` 的引号地狱。
