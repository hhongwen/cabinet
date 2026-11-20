# Task Inbox

把「想到的事」收进来，再决定什么时候做。

和 Cabinet 不是一回事 —— Cabinet 是「事件进来 → agent 自己干完」，
这个是「我先收下 → 回头再说」。前者是自动化，后者是收集。

## 现在有什么

| 部分 | 状态 |
|---|---|
| 任务存储（JSON） | ✅ 可用 |
| 看板：项目 / 状态 / 优先级 / 类别筛选 | ✅ 可用 |
| 随手记（Ctrl+V 贴图） | ✅ 可用 |
| 5 个 Alma 工具（task_add 等） | ✅ 可用 |
| 图片缩略图 + 点击放大 | ✅ 可用 |
| 状态栏指示器 | ⚠️ 只能看，点不动（Alma 未接线） |
| 桌面快捷方式 | ✅ 已生成 .url |
| 独立窗口（chrome --app） | ⬜ 未做 |
| 截图自动入箱 | ⬜ 未做 |
| agent 领任务 | ⬜ 未做 |

## 装到哪

源码在这里，运行副本在 Alma 的插件目录。改完源码要同步过去：

```
install.cmd
```

或者手动：

```bash
cp manifest.json main.mjs board.html quick.html ~/.config/alma/plugins/task-inbox/
curl -X POST http://localhost:23001/api/plugins/refresh
```

## 数据在哪

```
~/.config/alma/task-inbox/tasks.json     ← 唯一真相
~/.config/alma/task-inbox/images/        ← 贴进来的图
```

**不要**放到 `~/.config/alma/tasks/` —— 那是 Alma 自己的任务队列，
写进去会被 Alma 覆盖回去，而且读回来是空的。第一版就踩过这个坑。

## 为什么用 JSON 不用 SQLite

插件跑在 Alma 的 Electron 进程里，`node:sqlite` 不一定有；
几百条任务用 JSON 完全够，写的时候走「临时文件 + rename」，
中途崩溃不会留下半个文件。

## 数据模型

所有入口塌成同一个结构，加新入口只加 `kind`，不动表结构：

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
  "source": "chat | panel | quick",
  "claimed_by": null,
  "created_at": "...", "updated_at": "...",
  "doing_at": null, "done_at": null
}
```

`claimed_by` 是留给以后的 agent 领任务用的。领的时候用条件更新：

```sql
-- 如果换成 SQLite 就是这个语义
UPDATE tasks SET status='doing', claimed_by=?
WHERE id=? AND status='todo'
```

看 `changes` 是不是 1。两个 agent 同时抢，只有一个抢得到。

## 已知的 Alma 限制

1. **状态栏点击没接线。** 后端注册了 `statusbar/execute`，
   但渲染层从没监听 `plugin-statusbar-update` / `plugin-statusbar-execute-command`。
   所以状态栏只能当指示器。
2. **`contributes.components.sidebar` / `artifactRenderers` 是空壳。**
   schema 接受，前端 bundle 里搜不到消费代码。
3. **`ui.openExternal` 在无头模式下只打日志**，不真的开浏览器。
   所以「点一下打开看板」这个动作发不出去。
4. **卸载插件不会清理状态栏项**，要重新激活同名插件手动 dispose。

## 下一步（按优先级）

1. 独立窗口：`chrome --app=http://127.0.0.1:46001/quick --window-size=460,360`
2. 截图自动入箱：`fs.watch` 附件目录
3. agent 领任务：`claim` 接口 + 条件更新

---

*2026-11-20*
