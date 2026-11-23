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
export const PRIORITIES = ['p0', 'p1', 'p2', 'p3', 'p4'];
export const KINDS = ['text', 'image', 'image_text', 'link', 'file', 'mixed'];

export const PRIORITY_LABEL = {
  p0: 'P0 阻塞', p1: 'P1 紧急', p2: 'P2 常规', p3: 'P3 低', p4: 'P4 待定'
};

export const KIND_LABEL = {
  text: '文字', image: '图片', image_text: '图+文', link: '链接',
  file: '附件', mixed: '混合'
};

export const DEFAULT_SETTINGS = {
  backend: 'auto',                      // auto | magpie | alma | opencode | codex
  model: 'auto/deepseek-v4.1-flash',
  classify: true                        // 关掉就只收不判
};

export function createCore(dataDir) {
  const dataFile = path.join(dataDir, 'tasks.json');
  const imagesDir = path.join(dataDir, 'images');
  const filesDir = path.join(dataDir, 'files');

  function emptyStore() {
    return {
      version: 2,
      projects: [{ id: 'p_default', name: '默认', aliases: [], dirs: [], created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
      tasks: []
    };
  }

  // 只认带 version 字段的对象格式。别的形状（比如 Alma 自己那个数组）
  // 一律当成「不是我的文件」，绝不覆盖 —— 这是踩过的坑。
  function looksLikeMine(obj) {
    return !!obj && typeof obj === 'object' && !Array.isArray(obj)
      && (obj.version === 1 || obj.version === 2) && Array.isArray(obj.tasks);
  }

  let pidSeq = 0;
  function newProjectId() {
    pidSeq = (pidSeq + 1) % 1000;
    return 'p_' + Date.now().toString(36) + pidSeq.toString(36).padStart(2, '0');
  }

  function makeProject(name, opts = {}) {
    const n = String(name || '').trim();
    if (!n) throw new Error('项目名不能为空');
    return {
      id: newProjectId(),
      name: n,
      aliases: Array.isArray(opts.aliases) ? opts.aliases.map(String) : [],
      dirs: Array.isArray(opts.dirs) ? opts.dirs.map(normalizeDir) : [],
      created_at: nowIso(),
      updated_at: nowIso()
    };
  }

  function normalizeDir(d = {}) {
    const raw = typeof d === 'string' ? { path: d } : d;
    return {
      path: String(raw.path || '').trim(),
      note: String(raw.note || '').trim().slice(0, 200),
      primary: !!raw.primary
    };
  }

  // 老数据里 projects 是字符串数组，任务只有 project 名字。
  // 这里统一升级成对象，并给任务补 project_id。
  function migrate(d) {
    if (!Array.isArray(d.projects)) d.projects = [];
    const objects = [];
    const byName = new Map();

    for (const item of d.projects) {
      if (typeof item === 'string') {
        const name = item.trim() || '默认';
        if (byName.has(name)) continue;
        const proj = { id: newProjectId(), name, aliases: [], dirs: [], created_at: nowIso(), updated_at: nowIso() };
        objects.push(proj);
        byName.set(name, proj);
      } else if (item && typeof item === 'object' && item.name) {
        const proj = {
          id: item.id || newProjectId(),
          name: String(item.name),
          aliases: Array.isArray(item.aliases) ? item.aliases.map(String) : [],
          dirs: Array.isArray(item.dirs) ? item.dirs.map(normalizeDir) : [],
          created_at: item.created_at || nowIso(),
          updated_at: item.updated_at || nowIso()
        };
        objects.push(proj);
        byName.set(proj.name, proj);
      }
    }

    if (!objects.length) {
      const proj = { id: newProjectId(), name: '默认', aliases: [], dirs: [], created_at: nowIso(), updated_at: nowIso() };
      objects.push(proj);
      byName.set('默认', proj);
    }

    for (const t of d.tasks) {
      if (!t.project_id || !objects.some((x) => x.id === t.project_id)) {
        const name = String(t.project || '默认');
        const proj = byName.get(name) || objects[0];
        t.project_id = proj.id;
        t.project = proj.name;
      }
    }

    d.projects = objects;
    d.version = 2;
    return d;
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
    return migrate(d);
  }

  // 先写临时文件再 rename：中途崩溃不会留下半个 JSON
  function save(d) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8');
    fs.renameSync(tmp, dataFile);
  }

  const settingsFile = path.join(dataDir, 'settings.json');

  function loadSettings() {
    try {
      const raw = fs.readFileSync(settingsFile, 'utf8');
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  function saveSettings(patch = {}) {
    const cur = loadSettings();
    const next = { ...cur };

    if (patch.backend !== undefined) {
      const ok = ['auto', 'magpie', 'alma', 'opencode', 'codex'];
      if (!ok.includes(patch.backend)) throw new Error('未知通道: ' + patch.backend);
      next.backend = patch.backend;
    }
    if (patch.model !== undefined) {
      const m = String(patch.model || '').trim();
      if (!m) throw new Error('模型不能为空');
      next.model = m;
    }
    if (patch.classify !== undefined) next.classify = !!patch.classify;

    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = settingsFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, settingsFile);
    return next;
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
        files: Array.isArray(input.files) ? input.files : [],
        urls: Array.isArray(input.urls) ? input.urls : [],
        path: input.path ?? null
      },
      project: String(input.project || '默认'),
      project_id: input.project_id || null,
      category: String(input.category || ''),
      status: STATUSES.includes(input.status) ? input.status : 'todo',
      priority: PRIORITIES.includes(input.priority) ? input.priority : 'p3',
      note: input.note ?? '',
      source: String(input.source || 'chat'),
      // 自动分类的状态：pending 排队中 / done 已完成 / failed 失败 / off 不需要
      classify_state: input.classify_state || 'off',
      classify_reason: '',
      classify_model: '',
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

    for (const k of ['title', 'kind', 'project', 'project_id', 'category', 'priority', 'note', 'claimed_by',
                     'classify_state', 'classify_reason', 'classify_model']) {
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
    const order = { p0: 0, p1: 1, p2: 2, p3: 3, p4: 4 };
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
    if (opts.project) arr = arr.filter((t) => t.project === opts.project || t.project_id === opts.project);
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

  function listProjects() {
    const d = load();
    const counts = {};
    for (const t of d.tasks) counts[t.project_id] = (counts[t.project_id] || 0) + 1;
    return d.projects.map((p) => ({ ...p, taskCount: counts[p.id] || 0 }));
  }

  function addProject(name, opts = {}) {
    const d = load();
    const proj = makeProject(name, opts);
    if (d.projects.some((x) => x.name === proj.name)) {
      throw new Error('项目已存在: ' + proj.name);
    }
    d.projects.push(proj);
    save(d);
    return proj;
  }

  function updateProject(id, patch = {}) {
    const d = load();
    const p = d.projects.find((x) => x.id === id);
    if (!p) throw new Error('项目不存在: ' + id);

    if (patch.name !== undefined) {
      const n = String(patch.name).trim();
      if (!n) throw new Error('项目名不能为空');
      if (d.projects.some((x) => x.id !== id && x.name === n)) throw new Error('项目名重复: ' + n);
      p.name = n;
    }
    if (patch.aliases !== undefined) p.aliases = (patch.aliases || []).map(String).filter(Boolean);
    if (patch.dirs !== undefined) p.dirs = (patch.dirs || []).map(normalizeDir).filter((x) => x.path);

    p.updated_at = nowIso();
    // 同步任务上的冗余名字，方便外部直接读
    for (const t of d.tasks) if (t.project_id === id) t.project = p.name;
    save(d);
    return p;
  }

  function deleteProject(id) {
    const d = load();
    const i = d.projects.findIndex((x) => x.id === id);
    if (i < 0) throw new Error('项目不存在: ' + id);
    if (d.projects.length <= 1) throw new Error('至少要保留一个项目');

    const fallback = d.projects.find((x) => x.id !== id);
    for (const t of d.tasks) {
      if (t.project_id === id) { t.project_id = fallback.id; t.project = fallback.name; }
    }
    const [removed] = d.projects.splice(i, 1);
    save(d);
    return { removed, movedTo: fallback.name };
  }

  // 按 id 或名字（含别名）找项目
  function findProject(key) {
    if (!key) return null;
    const d = load();
    return d.projects.find((x) => x.id === key)
        || d.projects.find((x) => x.name === key)
        || d.projects.find((x) => x.aliases.includes(key))
        || null;
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
    return { path: path.join(imagesDir, name), url: '/images/' + name, name };
  }

  // 存任意附件（base64），保留原文件名便于识别
  function saveFile(dataUrl, filename) {
    const m = String(dataUrl || '').match(/^data:[^;]*;base64,(.+)$/i);
    if (!m) throw new Error('需要 dataUrl');
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > 25 * 1024 * 1024) throw new Error('附件太大（>25MB）');
    fs.mkdirSync(filesDir, { recursive: true });
    const safe = String(filename || 'file')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/^[.]+/, '')
      .slice(-80);
    const name = Date.now().toString(36) + '_' + (safe || 'file');
    fs.writeFileSync(path.join(filesDir, name), buf);
    return { path: path.join(filesDir, name), name, original: safe, size: buf.length };
  }

  function filePath(name) {
    return path.join(filesDir, path.basename(name));
  }

  function imagePath(name) {
    return path.join(imagesDir, path.basename(name));
  }

  return {
    dataDir, dataFile, imagesDir, filesDir, settingsFile,
    load, save, add, patch, move, remove, list, state,
    listProjects, addProject, updateProject, deleteProject, findProject,
    loadSettings, saveSettings,
    saveImage, imagePath, saveFile, filePath
  };
}
