// Task Inbox —— 统一任务入口 + 看板
//
// 设计原则：
//   1. 数据不属于 Alma，属于用户。放在 ~/.config/alma/tasks/tasks.json，
//      任何外部程序（未来的 agent）都能直接读写。
//   2. 所有入口塌成同一种结构：kind + payload。加新入口只加 kind，不动表结构。
//   3. 状态只有三档：todo / doing / done。优先用 "最紧急的一件"，不做时间估算。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STATUSES = ['todo', 'doing', 'done'];
const PRIORITIES = ['p0', 'p1', 'p2', 'p3']; // 紧急重要 / 重要 / 紧急 / 普通
const KINDS = ['text', 'image', 'image_text', 'link'];

let server = null;
let dataDir = '';
let dataFile = '';
let boardDir = '';
let port = 0;
let ctxRef = null;
let statusItem = null;

// ---------- 状态栏 ----------

function refreshStatusBar() {
  if (!statusItem) return;
  try {
    const c = state().counts;
    statusItem.text = `📋 ${c.todo}`;
    statusItem.tooltip = `任务收件箱：${c.todo} 待办 / ${c.doing} 进行中 / ${c.done} 已完成\n点击打开看板`;
  } catch { /* 静默：状态栏失败不影响业务 */ }
}

// ---------- 存储 ----------

function emptyStore() {
  return { version: 1, projects: ['默认'], tasks: [] };
}

// 只认带 version 字段的对象格式。别的形状（比如 Alma 自己那个数组）
// 一律当成「不是我的文件」，绝不覆盖 —— 这是踩过的坑。
function looksLikeMine(obj) {
  return !!obj && typeof obj === 'object' && !Array.isArray(obj)
    && obj.version === 1 && Array.isArray(obj.tasks);
}

function loadStore() {
  try {
    const raw = fs.readFileSync(dataFile, 'utf8');
    const d = JSON.parse(raw);
    if (!looksLikeMine(d)) {
      throw new Error('数据文件格式不属于 task-inbox，拒绝读写: ' + dataFile);
    }
    if (!Array.isArray(d.projects) || !d.projects.length) d.projects = ['默认'];
    return d;
  } catch (e) {
    if (e && e.code === 'ENOENT') return emptyStore();
    if (e && e.message && e.message.includes('拒绝读写')) throw e;
    return emptyStore();
  }
}

// 先写临时文件再 rename：中途崩溃不会留下半个 JSON
function saveStore(d) {
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = dataFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
  fs.renameSync(tmp, dataFile);
}

function nowIso() { return new Date().toISOString(); }

let seq = 0;
function newId() {
  seq = (seq + 1) % 1000;
  return 't_' + Date.now().toString(36) + seq.toString(36).padStart(2, '0');
}

function normalizeKind(k) { return KINDS.includes(k) ? k : 'text'; }

function makeTask(input = {}) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('title 不能为空');
  const now = nowIso();
  return {
    id: newId(),
    title,
    kind: normalizeKind(input.kind),
    payload: {
      text: input.text ?? null,
      images: Array.isArray(input.images) ? input.images : [],
      urls: Array.isArray(input.urls) ? input.urls : [],
      path: input.path ?? null
    },
    project: String(input.project || '默认'),
    category: String(input.category || ''),          // 工作 / 学习 …
    status: STATUSES.includes(input.status) ? input.status : 'todo',
    priority: PRIORITIES.includes(input.priority) ? input.priority : 'p3',
    note: input.note ?? '',
    source: String(input.source || 'chat'),          // chat / panel / screenshot / feishu
    claimed_by: null,                                // 留给以后的 agent 领任务
    created_at: now,
    updated_at: now,
    doing_at: null,
    done_at: null
  };
}

// ---------- 业务动作 ----------

function addTask(input) {
  const d = loadStore();
  const t = makeTask(input);
  if (!d.projects.includes(t.project)) d.projects.push(t.project);
  d.tasks.unshift(t);
  saveStore(d);
  refreshStatusBar();
  return t;
}

function patchTask(id, fields = {}) {
  const d = loadStore();
  const t = d.tasks.find((x) => x.id === id);
  if (!t) throw new Error('任务不存在: ' + id);

  const editable = ['title', 'kind', 'project', 'category', 'priority', 'note', 'claimed_by'];
  for (const k of editable) {
    if (fields[k] !== undefined) t[k] = fields[k];
  }
  if (fields.payload && typeof fields.payload === 'object') {
    t.payload = { ...t.payload, ...fields.payload };
  }
  if (fields.status !== undefined) applyStatus(t, fields.status);
  t.updated_at = nowIso();

  if (!d.projects.includes(t.project)) d.projects.push(t.project);
  saveStore(d);
  refreshStatusBar();
  return t;
}

function applyStatus(t, status) {
  if (!STATUSES.includes(status)) throw new Error('非法状态: ' + status);
  const now = nowIso();
  if (t.status === status) return;
  t.status = status;
  if (status === 'doing' && !t.doing_at) t.doing_at = now;
  if (status === 'done') { t.done_at = now; if (!t.doing_at) t.doing_at = now; }
  if (status === 'todo') { t.doing_at = null; t.done_at = null; }
}

function moveTask(id, status) {
  return patchTask(id, { status });
}

function deleteTask(id) {
  const d = loadStore();
  const i = d.tasks.findIndex((x) => x.id === id);
  if (i < 0) throw new Error('任务不存在: ' + id);
  const [t] = d.tasks.splice(i, 1);
  saveStore(d);
  refreshStatusBar();
  return t;
}

function listTasks(opts = {}) {
  const d = loadStore();
  let arr = d.tasks;
  if (opts.project) arr = arr.filter((t) => t.project === opts.project);
  if (opts.status) arr = arr.filter((t) => t.status === opts.status);
  const order = { p0: 0, p1: 1, p2: 2, p3: 3 };
  arr = [...arr].sort((a, b) => {
    const oa = order[a.priority] ?? 9;
    const ob = order[b.priority] ?? 9;
    if (oa !== ob) return oa - ob;
    return String(b.created_at).localeCompare(String(a.created_at));
  });
  if (opts.limit) arr = arr.slice(0, opts.limit);
  return { projects: d.projects, tasks: arr, total: d.tasks.length };
}

function state() {
  const d = loadStore();
  const order = { p0: 0, p1: 1, p2: 2, p3: 3 };
  const tasks = [...d.tasks].sort((a, b) => {
    const oa = order[a.priority] ?? 9;
    const ob = order[b.priority] ?? 9;
    if (oa !== ob) return oa - ob;
    return String(b.created_at).localeCompare(String(a.created_at));
  });
  const counts = { todo: 0, doing: 0, done: 0 };
  for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
  return { projects: d.projects, tasks, counts, total: tasks.length };
}

function addProject(name) {
  const d = loadStore();
  const n = String(name || '').trim();
  if (!n) throw new Error('项目名不能为空');
  if (!d.projects.includes(n)) { d.projects.push(n); saveStore(d); }
  return d.projects;
}

// ---------- HTTP ----------

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 4 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function serveFile(res, file, type) {
  try {
    const body = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}

async function handle(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const p = url.pathname;

  try {
    if (p === '/' || p === '/index.html') {
      return serveFile(res, path.join(boardDir, 'board.html'), 'text/html; charset=utf-8');
    }
    if (p === '/quick') {
      return serveFile(res, path.join(boardDir, 'quick.html'), 'text/html; charset=utf-8');
    }
    if (p.startsWith('/images/')) {
      const name = path.basename(p);
      const file = path.join(dataDir, 'images', name);
      const ext = path.extname(name).toLowerCase();
      const type = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.webp' ? 'image/webp'
        : ext === '.gif' ? 'image/gif' : 'image/png';
      return serveFile(res, file, type);
    }
    if (p === '/api/upload' && req.method === 'POST') {
      const b = await readBody(req);
      const m = String(b.dataUrl || '').match(/^data:image\/([a-z]+);base64,(.+)$/i);
      if (!m) return json(res, 400, { error: '需要 dataUrl: data:image/png;base64,...' });
      const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 12 * 1024 * 1024) return json(res, 400, { error: '图片太大（>12MB）' });
      const dir = path.join(dataDir, 'images');
      fs.mkdirSync(dir, { recursive: true });
      const name = 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6) + '.' + ext;
      fs.writeFileSync(path.join(dir, name), buf);
      return json(res, 200, { path: path.join(dir, name), url: '/images/' + name });
    }
    if (p === '/api/state' && req.method === 'GET') return json(res, 200, state());

    if (p === '/api/tasks' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, addTask(b));
    }
    if (p === '/api/tasks' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      return json(res, 200, listTasks(q));
    }

    const m = p.match(/^\/api\/tasks\/([^/]+)(\/move)?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      if (m[2] && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, moveTask(id, b.status));
      }
      if (req.method === 'PATCH' || req.method === 'PUT') {
        const b = await readBody(req);
        return json(res, 200, patchTask(id, b));
      }
      if (req.method === 'DELETE') return json(res, 200, deleteTask(id));
    }

    if (p === '/api/projects' && req.method === 'POST') {
      const b = await readBody(req);
      return json(res, 200, { projects: addProject(b.name) });
    }

    if (p === '/api/ping') return json(res, 200, { ok: true, port, tasks: loadStore().tasks.length });

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (e) {
    json(res, 400, { error: e instanceof Error ? e.message : String(e) });
  }
}

function startServer(preferred) {
  return new Promise((resolve) => {
    const tryPort = (p, remaining) => {
      const s = http.createServer((req, res) => { handle(req, res).catch(() => {}); });
      s.once('error', () => {
        if (remaining.length) tryPort(remaining[0], remaining.slice(1));
        else resolve(null);
      });
      s.listen(p, '127.0.0.1', () => resolve({ server: s, port: p }));
    };
    tryPort(preferred, [46002, 46003, 46004, 46005]);
  });
}

// ---------- 工具 ----------

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
      const t = addTask(a || {});
      return { success: true, id: t.id, task: t, message: `已收进收件箱：${t.title}（${t.priority} / ${t.project}）` };
    }
  });

  reg('task_list', {
    description: '看任务列表。可按项目或状态过滤。',
    parameters: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        status: { type: 'string', enum: STATUSES },
        limit: { type: 'number' }
      },
      required: []
    },
    execute: async (a) => {
      const r = listTasks(a || {});
      const lines = r.tasks.map((t) => `[${t.status}] ${t.priority} ${t.title}  (${t.project})`);
      return { success: true, ...r, message: `${r.total} 条任务\n` + lines.join('\n') };
    }
  });

  reg('task_update', {
    description: '改任务的字段（标题/项目/优先级/类别/备注/payload）。',
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
    execute: async (a) => { const { id, ...rest } = a || {}; return { success: true, task: patchTask(id, rest) }; }
  });

  reg('task_move', {
    description: '把任务挪到某一列：todo / doing / done。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string' }, status: { type: 'string', enum: STATUSES } },
      required: ['id', 'status']
    },
    execute: async (a) => ({ success: true, task: moveTask(a.id, a.status) })
  });

  reg('task_done', {
    description: '把一个任务标记为完成。',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    execute: async (a) => ({ success: true, task: moveTask(a.id, 'done') })
  });
};

// ---------- 激活 ----------

export async function activate(ctx) {
  const { logger, ui, commands, extensionPath } = ctx;
  ctxRef = ctx;

  // 注意：~/.config/alma/tasks/ 是 Alma 自己的任务队列目录，不能碰。
  // 这里用独立的 task-inbox 目录，避免任何冲突。
  const home = os.homedir();
  dataDir = path.join(home, '.config', 'alma', 'task-inbox');
  dataFile = path.join(dataDir, 'tasks.json');
  boardDir = extensionPath || '.';

  loadStore(); // 触发目录补建
  try { saveStore(loadStore()); } catch (e) { logger.warn('[task-inbox] init store: ' + e.message); }

  TOOL_DEFS(ctx);

  const started = await startServer(46001);
  if (started) {
    server = started.server;
    port = started.port;
    logger.info('[task-inbox] board on http://127.0.0.1:' + port);
  } else {
    logger.error('[task-inbox] 没有可用端口，看板不可用');
  }

  const boardUrl = () => 'http://127.0.0.1:' + (port || 46001) + '/';

  try {
    commands.register('openBoard', async () => { ui.openExternal(boardUrl()); return boardUrl(); });
    commands.register('openInbox', async () => { ui.openExternal(boardUrl() + '#todo'); return boardUrl(); });
  } catch (e) { logger.warn('[task-inbox] commands: ' + e.message); }

  try {
    statusItem = ui.createStatusBarItem({ id: 'task-inbox.status', alignment: 'right', priority: 88 });
    statusItem.command = 'task-inbox.openBoard';
    statusItem.show?.();
    refreshStatusBar();
  } catch (e) { logger.warn('[task-inbox] statusbar: ' + e.message); }

  return {
    dispose() {
      try { server?.close(); } catch {}
    }
  };
}
