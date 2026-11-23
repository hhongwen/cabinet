# 待修问题与待完善功能

> 每条都标了**证据**（文件 + 函数 + 实测数字），不凭印象。
> 行号会随代码变化漂移，所以引用都写成「文件 : 函数名」加特征字符串。
>
> 优先级：**P0** 会丢数据或已经坏掉 / **P1** 明显影响使用 / **P2** 该补但不急 / **P3** 可以不做
>
> 对应路线图见 [../ROADMAP.md](../ROADMAP.md)。**阶段 1（Session 协作）之前，
> 先把这份清单里的 P0 和 P1 处理完。**

---

## P0 — 会丢数据或功能已经坏了

### ✅ P0-1 线上跑的是旧进程，改了代码没生效

> **已修**：`/api/ping` 和 `/api/state` 返回 `build`（version / pid / started_at / stale）。
> 进程启动时记一份磁盘代码的 stat 指纹，请求时再算一遍，不一致就是 `stale: true`，
> 页面顶部挂黄条提示重启。`install.cmd` 装完自动跑 `stop-service.ps1` 停旧进程
> （只杀命令行里带 task-inbox 的 node，不碰别的）。
> 验证：改磁盘文件 → stale 变 true；重启 → 恢复 false。

这是最隐蔽的一条：仓库里的代码是对的，但 `46001` 端口上跑的是**几分钟前启动的旧进程**。

实测（2026-11-23 16:35）：

```
仓库 server.mjs 的 readBody → 已经改成 Buffer.concat(chunks) 再解码
46001 上跑的进程（pid 59500）→ 还是 str += chunk 逐片 toString()
```

后果：`readBody` 那个中文分片修复**在线上没有生效**。实测写入 120KB 中文正文：

```
title 完整: true          ← 短字符串没跨分片
text 完整: false          ← 120KB 跨了多个分片，被切坏
含 U+FFFD: true           ← 数据真的损坏了
```

用新代码另起一个端口（46098）同样测试：

```
title 完整: true
text 完整: true           ✅
含 U+FFFD: false          ✅
```

**所以这不是代码 bug，是部署流程的缺口。** 改完代码必须重启，但没有任何机制保证这件事发生：

- `install.cmd` 会拷文件 + 通知 Alma 重载插件，但它不杀已经在跑的独立服务
- `serve.cmd` / `autostart.cmd` 起的进程没人管
- 前端不知道后端是哪一版

**修法（三选一，建议全做）**：

1. `/api/ping` 返回 `version` 和 `started_at`，前端启动时比对，不一致就在页面顶部挂一条黄条：「后端是旧版本，需要重启」
2. `install.cmd` 装完之后主动杀掉占用 46001 的进程（或者提示用户）
3. 把版本号写进 `manifest.json` 并在 `core` 里读出来一起返回

第 1 条最重要——它让问题自己暴露出来，而不是等人偶然发现数据错了。

---

### ✅ P0-2 「选项目」徽章永远不出现（功能从未生效）

> **已修**：`tasks` 表加 `needs_project`，`PATCHABLE` 放行，`rowToTask` 映射。
> schema 升到 v2，老库自动 `ALTER TABLE` 补列（P1-5 的迁移机制同时完成）。
> 验证：新建默认 false → PATCH true → 重读 true → PATCH 回 false，HTTP 层也测过。

`server.mjs` 的 `runOne()` 在判不出项目时会设置 `needs_project`，前端靠它显示橙色徽章。
但这个字段既不在数据库表里，也不在 `patch()` 的白名单里，两处都被静默丢弃。

```
server.mjs : runOne()        patch.needs_project = ...           ← 写
board.html : cardHTML()      t.needs_project                     ← 读
storage.mjs: CREATE TABLE    tasks 表里没有这一列                 ← 存不进去
core.mjs   : patch()         PATCHABLE 白名单里没有               ← 被过滤掉
```

实测：

```
PATCH {"needs_project": true} → 返回对象里有这个字段吗? false
```

**这不是 SQLite 改造引入的** —— 旧版 `core.mjs` 的白名单里同样没有这个字段，
从加上那天起就没通过。只是因为现有 12 条任务全部分类成功，一次都没走到失败分支。

**修法**：`storage.mjs` 加列 + `core.mjs` 的 `PATCHABLE` 加一项 + `rowToTask` 映射。
需要一次 `schema_version` 升到 2 的迁移（`ALTER TABLE tasks ADD COLUMN`）。
**顺便把 schema 版本迁移机制补上**（见 P1-5）。

---

### ✅ P0-3 删除任务后，附件和图片永久残留

> **已修**：`remove()` 先记下 `payload.images` / `payload.files` 的文件名，删库成功后再删文件
> （顺序不能反）。只删指向本目录且确实存在的文件，payload 里塞 `../../etc/passwd`
> 这种不会跟着删。接口返回 `attachments_removed` 数量。
> 验证：带 2 个附件的任务删掉 → 文件真没了；塞目录外路径 → 那个文件没被动。

`core.remove()` 只删数据库行，`images/` 和 `files/` 里的文件没人管。

```
core.mjs 里 unlink / rmSync 出现次数: 0
images/  实际文件 2 个，被任务引用的 0 个（已全是孤儿）
```

现在只有 2 个孤儿文件、268 KB，无所谓。但这条路只会越走越脏：
删一张带 3 张图的卡，就多 3 个永远没人再引用、也永远不会被清的文件。

**修法**：`remove()` 里读出 `payload.images` / `payload.files`，删库成功后
再删文件（顺序不能反 —— 先删文件后删库，库删失败就丢了引用）。
文件删失败只记日志，不回滚，因为库已经删了，回滚反而更糟。

---

### ✅ P0-4 超过 12 MB 的文件传不上去，报错是「fetch failed」

> **已修**：请求体上限提到 40 MB，跟 `saveFile` 的 25 MB 对得上；超限返回 413 + 一句人话。
>
> **踩了两次才做对**，记下来免得重蹈：
> - `destroy()` → 前端只看到 `fetch failed`
> - `pause()` → body 卡在 TCP 缓冲里，响应发完 Node 发 RST，前端 `ECONNRESET`
> - 正确做法：把剩余 body 读完丢弃，等 `end` 之后再 reject
>
> 验证：12 / 20 / 24 MB 附件全部 200；33 MB → 413 带文案；
> 26 / 28 MB → 「附件太大（>25MB）」，不再是网络错误。

三处限制互相矛盾：

```
server.mjs : readBody()     请求体上限  16 MB
core.mjs   : saveImage()    图片上限    12 MB
core.mjs   : saveFile()     附件上限    25 MB
```

`readBody` 检查的是 base64 **解码后**的字符串长度。base64 有 4/3 膨胀，
所以实际能传的二进制上限是 `16 / 1.33 ≈ 12 MB`。
**代码里写的 12 MB 图片和 25 MB 附件都几乎达不到。**

实测（本机，`POST /api/upload`）：

```
图片 11.9 MB (body 15.9MB) → HTTP 200  ✅
图片 12.1 MB (body 16.1MB) → fetch failed  ❌

附件 11.9 MB (body 15.9MB) → HTTP 200  ✅
附件 12.1 MB (body 16.1MB) → fetch failed  ❌  ← 用户看到的就是这个
附件 20.0 MB               → fetch failed  ❌
附件 24.0 MB               → fetch failed  ❌
```

问题在两处：

1. **`req.destroy()` 直接把连接掐了**（`readBody`），前端拿到的是
   `fetch failed`，完全看不出是「文件太大」。用户会以为是网络问题，反复重试。
2. **附件上限 25 MB 是句空话** —— 72% 的额度永远用不到。

**修法**：
- `readBody` 超限时不要 `destroy()`，改成 `req.pause()` + 返回 `413` 带明确文案
- 请求体上限提到 40 MB（这样 25 MB 附件才真的能用）
- 或者反过来：把代码里写的 25 MB 改成 12 MB，让文档和实际一致

两条路都行，**但必须一致**。现在的状态是文档说 25、实际 12、报错说「网络失败」。

---

## P1 — 明显影响使用

### ✅ P1-1 每 3 秒全量拉一次看板，2000 条任务时一天 26 GB

> **已修**：`/api/state` 返回 `revision`，轮询时带 `?since=`。库没变只回 150 字节
> （`{unchanged:true, revision, build}`），前端连 `render()` 都不跑，滚动位置不会被重置。
> 页面隐藏时不轮询，切回前台拉一次全量（不能用 since —— 后台期间库可能变过）。
>
> **第一版是错的**，记下来：用各表 `COUNT` + `MAX(updated_at)` 算指纹，
> 漏掉两种 —— 改状态只动 `status` 列（同毫秒内 `updated_at` 不变）、
> 改 `settings` 那张表根本没有时间戳列。两个都被测试抓到了。
> 现在用 `total_changes()`（本连接累计改动行数）+ `PRAGMA data_version`
> （别的连接提交时会变，实测 2→3），O(1) 不扫表。
>
> 实测 401 条任务：全量 254080 字节 → 不变时 150 字节，省 99.9%；
> 一天 8 小时轮询从 2.3 GB 降到几乎为 0。

**当时的实测数字**（修之前）：

| 数据量 | 每次轮询 | 耗时 | 一天流量（3 秒一次，8 小时） |
|---|---|---|---|
| 12 条 | 12 KB | ~1 ms | 350 MB |
| 401 条 | 254 KB | 11 ms | 2.3 GB |
| 2000 条 | 0.93 MB | 75 ms | **26 GB** |

而且 `render()` 是**全量重绘**：`board.innerHTML = COLS.map(...)`，每次轮询
重建整个看板 DOM。滚动容器 `.board-scroll` 的 `scrollTop` 没有恢复逻辑，
所以数据一多，正在滚动的列表每 3 秒跳一次。

**修完之后**：401 条任务时，库没变的轮询只回 **150 字节**（省 99.9%），
1ms 返回，且前端直接跳过 `render()`，滚动位置不受影响。

**为什么不用 304**：`fetch` 的 `res.ok` 对 304 是 `false`，前端得多写一个分支，
省下的字节远不值得多一处判断。

---

### ✅ P1-2 分类卡在 pending 后永不恢复

> **已修**：`core.init()` 调 `reviveStuckPending()`，把 `pending` 且 `updated_at` 超过
> 5 分钟的标成 `failed`，reason 写「上次判断被中断（进程退出）」。前端本来就有失败态。
> 验证：把一条的 `updated_at` 改成 2020 年 → init → 变 failed，刚建的 pending 不动。

`runOne()` 一开始就写 `classify_state='pending'`，然后 await 模型。
如果进程在这中间被杀（重启、崩溃、断电），这条任务就永远停在「判断中…」。

```
server.mjs : runOne()      core.patch(id, { classify_state: 'pending' })
core.mjs   : init()        启动时扫 pending 的逻辑: 没有
```

现有 12 条都是 `done`，没踩到。但这是迟早的事，而且**卡住之后没有任何入口能重试** ——
前端只有失败才显示「未判断」，`pending` 就显示「判断中…」一直转。

**修法**：`core.init()` 里加一次 —— 把 `pending` 且 `updated_at` 超过 5 分钟的
标成 `failed`，reason 写「进程中断」。前端本来就有失败态，不用改。

---

### ✅ P1-3 界面上没有删除任务的入口

> **已修**：抽屉右上角「删」按钮 + `confirm()`，文案带任务标题。
> 删完显示「已删除，同时清掉 N 个附件」。按钮平时灰、悬停才变红。

```
board.html 里 api('DELETE', ...) 只出现一次，删的是项目
cli.mjs 有 rm，但得开终端、手敲 id
```

界面上能删项目，不能删任务。误收一条之后只能在命令行删。

**修法**：抽屉底部加「删除」按钮 + `confirm()`（跟删项目的做法一致）。

---

### ✅ P1-4 没有备份 / 导出，误删不可恢复

> **已修**：`node cli.mjs export [文件]` 把整库导成老的 `tasks.json` 形状
> （正是 `migrateFromJson` 认识的格式，所以导出文件能原样倒回去）；
> `node cli.mjs backup [文件]` 用 `VACUUM INTO` 热备，服务在跑也能备。
> 不传路径就落在数据目录，文件名带时间戳。目标已存在时拒绝覆盖。
>
> 验证：导出 11 个任务 / 4 个项目 / 8 条消息；备份文件能独立打开且行数一致。


```
core.mjs / server.mjs / board.html 里 backup/export 的实现: 0
任务删除: 硬删，无软删除、无回收站
```

一次误删就是永久丢。而且库文件坏了没有任何恢复途径。

**修法（最小）**：
- `cli.mjs` 加 `export`，把全库导成 JSON（`migrateFromJson` 已经会读这个格式，等于双向可用）
- `cli.mjs` 加 `backup`，用 `VACUUM INTO` 热备（SQLite 原生，WAL 下安全，已验证可用）
- 界面上可以不做，命令行够

---

### ✅ P1-5 schema 版本号只是写进去，从来没读过

> **已修**：`applySchema()` 先读 `meta.schema_version`，小于 `SCHEMA_VERSION` 就按顺序跑
> `MIGRATIONS`（整个在一个事务里）。新库直接记版本号跳过；每个步骤自己检查列是否存在。
> 验证：把 v2 库降级成 v1 → 新代码打开 → 列补回来、版本升到 2、数据一条没丢。

```
storage.mjs : applySchema()   if (!cur) 就写入版本号
                              → 有版本号的情况下，没有任何比较逻辑
```

也就是说 `SCHEMA_VERSION` 现在是个装饰。将来加字段（比如 P0-2 要加的
`needs_project`）时，老库不会自动迁移，新代码读老库会直接缺列。

**修法**：`applySchema()` 里读当前版本，小于 `SCHEMA_VERSION` 就按顺序跑
迁移函数。P0-2 正好是这个机制的第一个使用者。

---

### ✅ P1-6 WAL 不主动 checkpoint

> **已修**：`core.close()` 里先 `PRAGMA wal_checkpoint(TRUNCATE)` 再关；
> 服务收到 SIGINT/SIGTERM 也会调 `core.close()`。
> 验证：写 500 条后 close，WAL 从 4032 KB 变 0 字节。

实测（写 N 条消息后看 WAL 大小）：

```
500 条   → WAL 3.93 MB   主库 120 KB
2000 条  → WAL 3.95 MB   主库 412 KB
```

SQLite 默认在 1000 页（约 4 MB）时自动 checkpoint，所以**它不会无限涨**，
这点是好的。但 4 MB 的 WAL 常驻，配合 72 KB 的真实库，看着不成比例。

单进程时 `close()` 会清 WAL，所以正常关停不会留下大文件。
如果进程被 kill（比如 P0-1 说的那种情况），就会留一个 4 MB 的 WAL 在那儿。

**修法（低优先）**：`close()` 前跑一次 `PRAGMA wal_checkpoint(TRUNCATE)`。
或者不改 —— 4 MB 是上限不是起点，不值得为它加代码。

---

### 🟡 P1-7 前端错误处理不均匀

> **部分已做**：首屏失败改成顶部横幅 + 「重试」按钮。其余 catch 保持原样 ——
> 轮询失败静默是对的，抖动不该弹窗。

```
board.html 里 catch 出现 12 次，但风格不统一：
  · 有的 toast('失败：' + err.message)
  · 有的 catch { } 静默吞掉
  · 轮询失败完全静默（refresh().catch(() => {})）
```

轮询失败静默是合理的（抖动不该弹窗），但**首屏加载失败只在最上面插一行红字，
没有任何重试按钮**，用户只能自己刷新。

**修法**：首屏失败时给个「重试」按钮。其余保持现状。

---

## P2 — 该补但不急

### P2-1 搜索

```
core.mjs 里 search / FTS 出现次数: 0
```

12 条时能一眼扫完，200 条就得靠浏览器 Ctrl+F（而 Ctrl+F 搜不到抽屉里的内容）。
SQLite 加 `LIKE` 查询半天就能做，加 FTS5 一天。

**触发条件**：任务数过 100 条，或者你自己开始"我记得记过一条关于 X 的"。

### P2-2 分页

`/api/state` 一次全量返回，`list()` 不支持 offset。跟 P1-1 是同一件事的两面。

**触发条件**：跟 P2-1 一起做，或者轮询优化之后还是慢。

### ✅ P2-3 非存储层的测试

> **已修**：`node test-parsers.mjs` → 57 项，注入假 backend，不碰真模型。
> 覆盖 classify 的畸形输出（code fence、前后夹废话、非法枚举、缺标题、
> 无信息量标题、完全不返回 JSON）、chat 的 patch 白名单（拒 `id` / `claimed_by` /
> `created_at`）、以及两个模块的 prompt 拼装。
>
> 最后一项值得留着：断言 `FIELD_LABEL` 里每个字段都能真的通过 `core.patch` 写进去。
> `needs_project` 那个 bug 就属于这一类 —— 模型给得出、前端读得到、库里存不下。


```
test-sqlite.mjs   60 项，全绿，只覆盖存储层
classify / chat / brief / backend   一行测试都没有
```

归档版有 18 个测试文件在 `archive/examples/`，思路可以直接借。
最该补的是 `classify` 的字段解析和 `chat` 的 patch 白名单 ——
这两个都是「模型返回不规范就会炸」的地方。

### P2-4 分类失败不重试

`runOne()` 的 catch 里直接把 `classify_state` 标成 `failed`，没有重试。
网络抖动一次就永久失败，得手动点。

**修法**：失败计数写进 `classify_reason`，或者简单点 —— 启动时把所有
`failed` 的重新排一次队（代价是模型挂了会一直重试，得加次数上限）。

### P2-5 分类队列用 `setInterval` 轮询等位

```
server.mjs : enqueue()   if (running >= MAX) { setInterval(..., 200) }
```

并发满了就每 200ms 空转一次等空位。现在 MAX=2、任务少，看不出来。
但如果一次粘 50 条进去，就是 50 个 interval 在转。

**修法**：换成简单的 Promise 队列（一个待办数组 + `running` 计数）。

### P2-6 桌面快捷方式没装

Startup 里有 `task-inbox.cmd`（开机自启已生效），但桌面上没有图标。
`mklinks.cmd` 是现成的，没跑过。

### P2-7 界面图标是文字符号

`✕`、`📁`、`⚙` 这些直接写在 HTML 里。macOS 上渲染出来的样式和 Windows 不一样。

---

## P3 — 可以不做

| 项 | 为什么不做 |
|---|---|
| WebSocket 推送 | 3 秒轮询优化一下就够了，加推送是给自用工具增加复杂度 |
| 软删除 / 回收站 | P1-4 的 backup + export 解决 90% 的需求，回收站是另一套状态机 |
| 多用户 / 权限 | 一个人用 |
| SSR / 前端框架 | 单文件 `board.html` 现在 2500 行，还在可控范围 |
| 深色模式 | 视觉语言已经定了，加主题是纯工作量 |

---

## 进度

```
第一批（P0）        ✅ 2026-11-23
  P0-1  版本可见 + 装完重启
  P0-2  needs_project（P1-5 的迁移机制一并完成）
  P0-4  上传上限统一
  P0-3  删任务清附件

第二批（P1）        ✅ 2026-11-23
  P1-1  轮询：不可见不轮询 + ?since= 短轮询
  P1-2  启动清 pending
  P1-3  界面删任务
  P1-6  WAL 关库时截断
  P1-7  首屏失败给重试
  P1-4  导出 / 热备份

第三批（P2）        ✅ 2026-11-23
  P2-3  classify / chat 的解析层测试

还留着
  P2-1  搜索
  P2-2  分页
  P2-4  分类失败不重试
  P2-5  分类队列的 setInterval 等位
  P2-6  桌面快捷方式没装
  P2-7  界面图标是文字符号

之后
  → 回 ROADMAP.md 的阶段 1，开始做 Session
```

### 验收记录（2026-11-23）

**自动化测试**：两套，都不碰真模型。

| 脚本 | 覆盖 | 结果 |
|---|---|---|
| `node test-sqlite.mjs` | 迁移、增删改、项目、级联删除、排序过滤、批量 id、revision、导出备份、schema 升级 | **100 / 100** |
| `node test-parsers.mjs` | classify 的畸形模型输出、chat 的 patch 白名单、两处 prompt 拼装、字段一致性 | **57 / 57** |
| `node style-audit.mjs` | 样式规范 | 0 error / 1 warning（历史遗留 63 处写死颜色） |

**HTTP 层实测**：

| 项 | 结果 |
|---|---|
| `GET /api/ping` | 带 `version` / `pid` / `started_at` / `stale` / `node` |
| 改磁盘文件后 `stale` | `false` → `true`；重启后回 `false` |
| `?since=` 库没变 | `150` 字节，`unchanged: true` |
| `?since=` 过期值 | 走全量，正常返回 |
| 改 status / 改 settings 后 | revision 确实变了（第一版方案在这两处漏判） |
| 附件 12 / 20 / 24 MB | 全部 200 |
| 附件 26 / 28 MB | 「附件太大（>25MB）」 |
| 请求体 44 MB | `413` + 可读文案（不再是 `fetch failed`） |
| 删带 1 张图的任务 | `attachments_removed: 1`，文件真的没了 |
| `export` / `backup` | 11 任务 / 4 项目 / 8 消息；备份能独立打开且行数一致 |

**线上数据**：schema 已迁到 v2，11 条任务一条没丢，`needs_project` 列已补上。

### 为什么这个顺序

**P0-1 排第一**：它让「改了没生效」这件事自己暴露出来。不做它，
后面每一条修完之后你都没法确认到底装上没有 —— 记录里那个中文分片 bug
就是这样：代码修了，线上还坏着，不主动测就发现不了。

**不先做 Session**：这批都是"已经坏了"或"马上会坏"的东西。
带着 P0-2 那种「字段写不进去也没人发现」的问题去做 Session，
只会让同一个坑重复三次。

---

*2026-11-23*
