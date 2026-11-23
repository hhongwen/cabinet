// core.mjs —— 任务存储的纯逻辑层
//
// 这里不碰 http、不碰 Alma API，只做一件事：
// 把 tasks.json 读进来、改、原子写回去。
//
// 这样拆的目的：插件（Alma 进程内）和 CLI（独立 node 进程）
// 可以共用同一套逻辑，不会出现两份实现走偏。

import fs from 'node:fs';
import path from 'node:path';

export const STATUSES = ['todo', 'doing', 'done'];
export const PRIORITIES = ['p0', 'p1', 'p2', 'p3'];
export const KINDS = ['text', 'image', 'image_text', 'link'];

export const PRIORITY_LABEL = {
  p0: '紧急重要', p1: '重要', p2: '紧急', p3: '普通'
};

export const KIND_LABEL = {
  text: '文字', image: '截图', image_text: '截图+文字', link: '链接'
};

export function createCore(dataDir) {
  const dataFile = path.join(dataDir, 'tasks.json');
  const imagesDir = path.join(dataDir, 'images');

  function emptyStore() {
    return { version: 1, projects: ['默认'], tasks: [] };
  }

  // 只认带 version 字段的对象格式。别的形状（比如 Alma 自己那个数组）
  // 一律当成「不是我的文件」，绝不覆盖 —— 这是踩过的坑。
  function looksLikeMine(obj) {
    return !!obj && typeof obj === 'object' && !Array.isArray(obj)
      && obj.version === 1 && Array.isArray(obj.tasks);
  }

  function load() {
    let raw;
    try {
      raw = fs.readFileSync(dataFile, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return emptyStore();
      throw e;
    }
    const d = JSON.parse(raw);
    if (!looksLikeMine(d)) {
      throw new Error('数据文件格式不属于 task-inbox，拒绝读写: ' + dataFile);
    }
    if (!Array.isArray(d.projects) || !d.projects.length) d.projects = ['默认'];
    return d;
  }

  // 先写临时文件再 rename：中途崩溃不会留下半个 JSON
  function save(d) {
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
      category: String(input.category || ''),
      status: STATUSES.includes(input.status) ? input.status : 'todo',
      priority: PRIORITIES.includes(input.priority) ? input.priority : 'p3',
      note: input.note ?? '',
      source: String(input.source || 'chat'),
      claimed_by: null,
      created_at: now,
      updated_at: now,
      doing_at: null,
      done_at: null
    };
  }

  function add(input) {
    const d = load();
    const t = makeTask(input);
    if (!d.projects.includes(t.project)) d.projects.push(t.project);
    d.tasks.unshift(t);
    save(d);
    return t;
  }

  function applyStatus(t, status) {
    if (!STATUSES.includes(status)) throw new Error('非法状态: ' + status);
    if (t.status === status) return;
    const now = nowIso();
    t.status = status;
    if (status === 'doing' && !t.doing_at) t.doing_at = now;
    if (status === 'done') { t.done_at = now; if (!t.doing_at) t.doing_at = now; }
    if (status === 'todo') { t.doing_at = null; t.done_at = null; }
  }

  function patch(id, fields = {}) {
    const d = load();
    const t = d.tasks.find((x) => x.id === id);
    if (!t) throw new Error('任务不存在: ' + id);

    for (const k of ['title', 'kind', 'project', 'category', 'priority', 'note', 'claimed_by']) {
      if (fields[k] !== undefined) t[k] = fields[k];
    }
    if (fields.payload && typeof fields.payload === 'object') {
      t.payload = { ...t.payload, ...fields.payload };
    }
    if (fields.status !== undefined) applyStatus(t, fields.status);
    t.updated_at = nowIso();

    if (!d.projects.includes(t.project)) d.projects.push(t.project);
    save(d);
    return t;
  }

  function move(id, status) { return patch(id, { status }); }

  function remove(id) {
    const d = load();
    const i = d.tasks.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('任务不存在: ' + id);
    const [t] = d.tasks.splice(i, 1);
    save(d);
    return t;
  }

  function sortTasks(arr) {
    const order = { p0: 0, p1: 1, p2: 2, p3: 3 };
    return [...arr].sort((a, b) => {
      const oa = order[a.priority] ?? 9;
      const ob = order[b.priority] ?? 9;
      if (oa !== ob) return oa - ob;
      return String(b.created_at).localeCompare(String(a.created_at));
    });
  }

  function list(opts = {}) {
    const d = load();
    let arr = d.tasks;
    if (opts.project) arr = arr.filter((t) => t.project === opts.project);
    if (opts.status) arr = arr.filter((t) => t.status === opts.status);
    if (opts.category) arr = arr.filter((t) => t.category === opts.category);
    arr = sortTasks(arr);
    if (opts.limit) arr = arr.slice(0, Number(opts.limit));
    return { projects: d.projects, tasks: arr, total: d.tasks.length };
  }

  function state() {
    const d = load();
    const tasks = sortTasks(d.tasks);
    const counts = { todo: 0, doing: 0, done: 0 };
    for (const t of tasks) counts[t.status] = (counts[t.status] || 0) + 1;
    return { projects: d.projects, tasks, counts, total: tasks.length };
  }

  function addProject(name) {
    const d = load();
    const n = String(name || '').trim();
    if (!n) throw new Error('项目名不能为空');
    if (!d.projects.includes(n)) { d.projects.push(n); save(d); }
    return d.projects;
  }

  // 存一张 base64 图片，返回 { path, url }
  function saveImage(dataUrl) {
    const m = String(dataUrl || '').match(/^data:image\/([a-z]+);base64,(.+)$/i);
    if (!m) throw new Error('需要 dataUrl: data:image/png;base64,...');
    const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 12 * 1024 * 1024) throw new Error('图片太大（>12MB）');
    fs.mkdirSync(imagesDir, { recursive: true });
    const name = 'img_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6) + '.' + ext;
    fs.writeFileSync(path.join(imagesDir, name), buf);
    return { path: path.join(imagesDir, name), url: '/images/' + name };
  }

  function imagePath(name) {
    return path.join(imagesDir, path.basename(name));
  }

  return {
    dataDir, dataFile, imagesDir,
    load, save, add, patch, move, remove, list, state, addProject,
    saveImage, imagePath
  };
}
