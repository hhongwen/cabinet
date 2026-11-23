// main.mjs —— Alma 插件外壳
//
// 真正的逻辑在 core.mjs（存储）和 server.mjs（HTTP）。
// 这个文件只做三件事：
//   1. 把服务拉起来（如果已经有一个在跑，就不重复起）
//   2. 注册 Alma 工具，让对话里能读写任务
//   3. 挂状态栏指示器
//
// 这样即使 Alma 没开，单独 `node server.mjs` 也能用同一套页面和数据。

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 关键：Alma 重载插件时只给入口文件加 ?t=，它 import 的子模块会被 ESM 缓存住。
// 所以子模块必须用带时间戳的动态 import —— 否则改了 core/server 根本不生效。
// （踩过：改了 classify.mjs 半天不生效，以为是模型问题）
const HERE = path.dirname(fileURLToPath(import.meta.url));
const reloadTag = '?t=' + Date.now();

const coreMod = await import(pathToFileURL(path.join(HERE, 'core.mjs')).href + reloadTag);
const serverMod = await import(pathToFileURL(path.join(HERE, 'server.mjs')).href + reloadTag);

const { createCore, STATUSES, PRIORITIES, KINDS } = coreMod;
const { start, DEFAULT_DATA_DIR, DEFAULT_PORT } = serverMod;

let server = null;
let port = 0;
let statusItem = null;
let core = null;

function refreshStatusBar() {
  if (!statusItem || !core) return;
  try {
    const c = core.state().counts;
    statusItem.text = `📋 ${c.todo}`;
    statusItem.tooltip = `任务收件箱：${c.todo} 待办 / ${c.doing} 进行中 / ${c.done} 已完成\n点击打开看板`;
  } catch { /* 状态栏失败不影响业务 */ }
}

const TOOL_DEFS = (api) => {
  const reg = (name, def) => {
    try { api.tools.register(name, def); } catch (e) { api.logger.warn('[task-inbox] tool ' + name + ': ' + e.message); }
  };

  reg('task_add', {
    description: '把一句话/一张截图/一个链接收进任务收件箱。返回新任务的 id。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '任务标题，一句话说清要做什么' },
        kind: { type: 'string', enum: KINDS, description: '入口类型，默认 text' },
        project: { type: 'string', description: '所属项目，默认「默认」' },
        priority: { type: 'string', enum: PRIORITIES, description: 'p0 紧急重要 / p1 重要 / p2 紧急 / p3 普通' },
        category: { type: 'string', description: '类别，如 工作 / 学习' },
        text: { type: 'string', description: '原文/补充说明' },
        images: { type: 'array', items: { type: 'string' }, description: '图片路径或 URL' },
        urls: { type: 'array', items: { type: 'string' }, description: '相关链接' }
      },
      required: ['title']
    },
    execute: async (a) => {
      const t = core.add(a || {});
      refreshStatusBar();
      return { success: true, id: t.id, task: t, message: `已收进收件箱：${t.title}（${t.priority} / ${t.project}）` };
    }
  });

  reg('task_list', {
    description: '看任务列表。可按项目、状态、类别过滤。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        status: { type: 'string', enum: STATUSES },
        category: { type: 'string' },
        limit: { type: 'number' }
      },
      required: []
    },
    execute: async (a) => {
      const r = core.list(a || {});
      const lines = r.tasks.map((t) => `[${t.status}] ${t.priority} ${t.title}  (${t.project}${t.category ? ' / ' + t.category : ''})`);
      return { success: true, ...r, message: `${r.total} 条任务\n` + lines.join('\n') };
    }
  });

  reg('task_update', {
    description: '改任务的字段（标题/项目/优先级/类别/备注/状态）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string' },
        project: { type: 'string' },
        priority: { type: 'string', enum: PRIORITIES },
        category: { type: 'string' },
        note: { type: 'string' },
        status: { type: 'string', enum: STATUSES }
      },
      required: ['id']
    },
    execute: async (a) => {
      const { id, ...rest } = a || {};
      const t = core.patch(id, rest);
      refreshStatusBar();
      return { success: true, task: t };
    }
  });

  reg('task_move', {
    description: '把任务挪到某一列：todo / doing / done。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, status: { type: 'string', enum: STATUSES } },
      required: ['id', 'status']
    },
    execute: async (a) => {
      const t = core.move(a.id, a.status);
      refreshStatusBar();
      return { success: true, task: t };
    }
  });

  reg('task_done', {
    description: '把一个任务标记为完成。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async (a) => {
      const t = core.move(a.id, 'done');
      refreshStatusBar();
      return { success: true, task: t };
    }
  });
};

export async function activate(ctx) {
  const { logger, ui, extensionPath } = ctx;

  const dataDir = process.env.TASK_INBOX_DATA || DEFAULT_DATA_DIR;
  core = createCore(dataDir);

  // 建库建表（顺手把老的 tasks.json 迁进来），同时验证可写
  try {
    const r = core.init();
    const mg = r.migration;
    if (mg?.migrated) {
      logger.info('[task-inbox] 已从 tasks.json 迁移：'
        + mg.tasks + ' 个任务 / ' + mg.messages + ' 条消息 / ' + mg.projects + ' 个项目'
        + (mg.backup ? '，原文件改名为 ' + mg.backup.split(/[\\/]/).pop() : ''));
    } else if (mg?.reason && !/没有 tasks\.json/.test(mg.reason)) {
      logger.info('[task-inbox] 迁移跳过：' + mg.reason);
    }
  } catch (e) {
    logger.warn('[task-inbox] 初始化数据库: ' + e.message);
  }

  TOOL_DEFS(ctx);

  // 起服务。如果端口已占（比如 CLI 已经跑着），就复用，不重复起。
  // 插件重载时，旧的服务实例还占着端口，而且它是旧代码。
  // 模块重载在同一个 Node 进程里，所以用 globalThis 记住它，先关掉再起新的。
  // （踩过：改了 server.mjs 之后怎么都不生效，因为一直在复用旧进程）
  const prev = globalThis.__taskInboxServer;
  if (prev) {
    try { prev.close(); logger.info('[task-inbox] 关掉上一个实例'); } catch { /* 忽略 */ }
    globalThis.__taskInboxServer = null;
  }

  // 再探一次端口：自己刚关的应该已经空了；如果是别的进程占着，就复用。
  let occupied = false;
  try {
    const r = await fetch('http://127.0.0.1:' + DEFAULT_PORT + '/api/ping', { signal: AbortSignal.timeout(1200) });
    occupied = r.ok;
  } catch { occupied = false; }

  const started = occupied ? null : await start(core, { port: DEFAULT_PORT, webDir: extensionPath || undefined });
  if (started) globalThis.__taskInboxServer = started.server;
  if (started) {
    server = started.server;
    port = started.port;
    logger.info('[task-inbox] 页面服务已启动 http://127.0.0.1:' + port);
  } else {
    port = DEFAULT_PORT;
    logger.info('[task-inbox] 端口已被占用，复用已运行的服务');
  }

  try {
    const item = ui.createStatusBarItem({ id: 'task-inbox.status', alignment: 'right', priority: 88 });
    statusItem = item;
    item.command = 'task-inbox.openBoard';
    item.show?.();
    refreshStatusBar();
  } catch (e) { logger.warn('[task-inbox] statusbar: ' + e.message); }

  try {
    ctx.commands.register('openBoard', async () => 'http://127.0.0.1:' + port + '/');
    ctx.commands.register('openQuick', async () => 'http://127.0.0.1:' + port + '/quick');
  } catch (e) { logger.warn('[task-inbox] commands: ' + e.message); }

  return {
    dispose() {
      try { if (server) server.close(); } catch {}
      if (globalThis.__taskInboxServer === server) globalThis.__taskInboxServer = null;
      try { core?.close?.(); } catch { /* 数据库句柄 */ }
      try { statusItem?.dispose?.(); } catch {}
      // 清掉模块缓存标记，下次激活会重新探测
      server = null;
      statusItem = null;
    }
  };
}
