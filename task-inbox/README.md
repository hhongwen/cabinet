# Task Inbox

把「想到的事」收进来，再决定什么时候做。

不是自动化，是收集。Cabinet 那套是「事件进来 → agent 自己干完」，
这个是「我先收下 → 回头再说」。

---

## 一分钟装好

```cmd
install.cmd
```

它会做完四件事：检查 node、把文件同步到 Alma 插件目录、通知 Alma 热重载、等端口起来。

想要桌面快捷方式：

```cmd
mklinks.cmd
```

---

## 怎么打开

| 方式 | 命令 | 说明 |
|---|---|---|
| 看板 | `start.cmd` | 起服务 + 开独立窗口（1280×900） |
| 随手记 | `start.cmd quick` | 起服务 + 开小窗（460×340） |
| 直接访问 | http://127.0.0.1:46001/ | 浏览器 |
| 命令行 | `node cli.mjs ls` | 不开任何界面 |

`start.cmd` 会先探一下端口。已经有一个在跑就直接开窗，不会重复起服务。

**独立窗口**用的是 `chrome --app`（或 Edge），没有地址栏、没有标签页，
Alt+Tab 能直接切回来，不像普通网页标签那样淹没在一堆页面里。

---

## 命令行

```
node cli.mjs                          看所有任务
node cli.mjs add "买咖啡豆"            加一条
node cli.mjs add "写周报" -p 工作 --p0 -c 工作
node cli.mjs ls --todo                只看未开始
node cli.mjs ls --json                给程序看的输出
node cli.mjs move <id> doing          换列
node cli.mjs done <id>                标完成
node cli.mjs rm <id>                  删除
node cli.mjs init                     初始化数据目录
```

`--p0` 紧急重要 / `--p1` 重要 / `--p2` 紧急 / `--p3` 普通（默认）。

---

## 三个入口，各管一段

```
            随手记（Ctrl+V 贴图 / Enter 存下）
                      ↓
对话里说一句 ────→  tasks.json  ────→  看板（拖拽换列）
                      ↑                    ↑
                  CLI 命令            独立窗口 / 浏览器
```

数据只有一份，三个入口读写同一个文件。

---

## 文件结构

```
task-inbox/
  manifest.json   Alma 插件清单
  main.mjs        插件外壳：注册工具 + 状态栏
  core.mjs        存储逻辑（纯 Node，不依赖 Alma）
  server.mjs      HTTP 服务（可独立跑）
  cli.mjs         命令行
  board.html      看板
  quick.html      随手记
  install.cmd     安装
  mklinks.cmd     桌面快捷方式
  start.cmd       起服务 + 开窗
  window.cmd      浏览器探测与开窗
```

**关键设计**：`core.mjs` 和 `server.mjs` 都不 import 任何 Alma API。
所以 `node server.mjs` 能单独跑，插件只是它的一个宿主。

这意味着：Alma 关了，服务还在；Alma 换了，数据还在。

---

## 数据在哪

```
~/.config/alma/task-inbox/tasks.json     ← 唯一真相
~/.config/alma/task-inbox/images/        ← 贴进来的图
```

⚠️ **不要**放到 `~/.config/alma/tasks/` —— 那是 Alma 自己的任务队列，
写进去会被 Alma 覆盖，读回来永远是空的。第一版就踩过这个坑，
现在文件里带 `version` 字段做签名，形状不对会拒绝读写而不是默默覆盖。

---

## 数据模型

所有入口塌成同一个结构。加新入口（语音、PDF）只加 `kind`，不动表结构。

```json
{
  "id": "t_xxx",
  "title": "一句话说清要做什么",
  "kind": "text | image | image_text | link",
  "payload": { "text": null, "images": [], "urls": [], "path": null },
  "project": "默认",
  "category": "工作",
  "status": "todo | doing | done",
  "priority": "p0 | p1 | p2 | p3",
  "note": "",
  "source": "chat | panel | quick | cli",
  "claimed_by": null,
  "created_at": "...",
  "updated_at": "...",
  "doing_at": null,
  "done_at": null
}
```

`claimed_by` 是给以后 agent 领任务留的。领的时候用条件更新：

```
UPDATE tasks SET status='doing', claimed_by=?
WHERE id=? AND status='todo'
```

看影响行数是不是 1。两个 agent 同时抢，只有一个抢得到。

---

## 为什么用 JSON 不用 SQLite

插件跑在 Alma 的 Electron 进程里，`node:sqlite` 不一定有。
几百条任务用 JSON 完全够，写入走「临时文件 + rename」，
中途崩溃不会留下半个文件。

真要换 SQLite，改 `core.mjs` 一个文件就够了。

---

## 已知的 Alma 限制

这四条不是本项目的 bug，是 Alma 插件系统当前的状态：

1. **状态栏点击没接线。** 后端注册了 `statusbar/execute`，
   但渲染层从没监听 `plugin-statusbar-update` / `plugin-statusbar-execute-command`。
   所以状态栏只能当指示器，点不动。
2. **`contributes.components.sidebar` / `artifactRenderers` 是空壳。**
   schema 接受，前端 bundle 里搜不到消费代码。
3. **`ui.openExternal` 在无头模式下只打日志**，不真的开浏览器。
4. **卸载插件不会清理状态栏项**，要重新激活同名插件手动 `dispose()`。

---

## 下一步（按优先级）

1. **开机自启**：把 `server.mjs` 放进启动目录，不依赖 Alma
2. **截图自动入箱**：`fs.watch` 附件目录 —— 但先确认不会变成噪音
3. **agent 领任务**：`claim` 接口 + 条件更新

---

*2026-11-20 起，2026-11-23 重构*
