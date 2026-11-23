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
import { createCore, STATUSES, PRIORITIES, KINDS } from './core.mjs';
import { start, DEFAULT_DATA_DIR, DEFAULT_PORT } from './server.mjs';

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

  // 初始化数据目录（顺便验证可写）
  try {
    core.save(core.load());
  } catch (e) {
    logger.warn('[task-inbox] 初始化数据: ' + e.message);
  }

  TOOL_DEFS(ctx);

  // 起服务。如果端口已占（比如 CLI 已经跑着），就复用，不重复起。
  const started = await start(core, { port: DEFAULT_PORT, webDir: extensionPath || undefined });
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
      // 自己起的服务才关；复用的不关。
      try { if (server) server.close(); } catch {}
      try { statusItem?.dispose?.(); } catch {}
    }
  };
}
