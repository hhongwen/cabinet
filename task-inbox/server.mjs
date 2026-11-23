// server.mjs —— 可以独立跑的 HTTP 服务
//
// 两种用法：
//   1. Alma 插件里被 main.mjs import，跟着 Alma 一起活
//   2. 命令行 `node server.mjs` 单独跑，不依赖 Alma
//
// 端口被占时不报错，直接退出（说明已经有一个在跑了）。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 把入口带上的 ?t= 继续往下传给子模块，否则 static import 会被 ESM 缓存住，
// 改了 core/classify 也不生效（踩过的坑）。
const RELOAD_TAG = new URL(import.meta.url).search || '';
const loadLocal = (rel) => import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), rel)).href + RELOAD_TAG);

const { createCore } = await loadLocal('core.mjs');
const { createClassifier } = await loadLocal('classify.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.config', 'alma', 'task-inbox');
export const DEFAULT_PORT = 46001;
export const FALLBACK_PORTS = [46002, 46003, 46004, 46005];

function json(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => {
      buf += c;
      if (buf.length > 16 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { reject(new Error('invalid JSON')); }
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

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif'
};

// ---------- 自动分类 ----------

export function createClassifyQueue(core, opts = {}) {
  const onDone = opts.onDone || (() => {});
  let running = 0;
  const MAX = 2;

  // 分类器要能随设置变化重建 —— 用户在页面上换模型，不用重启服务。
  // 用 createClassifier 每次现建，切换时只换这一个对象。
  let classifier = null;
  let classifierKey = '';

  function buildClassifier() {
    const st = core.loadSettings();
    const key = st.backend + '|' + st.model;
    if (classifier && key === classifierKey) return classifier;
    const { createClassifier: make } = opts._classifyMod || {};
    classifier = createClassifier({
      ...opts,
      imagesDir: core.imagesDir,
      filesDir: core.filesDir,
      mode: st.backend,
      model: st.model
    });
    classifierKey = key;
    return classifier;
  }

  function resetClassifier() { classifier = null; classifierKey = ''; }

  async function runOne(id) {
    const t = core.load().tasks.find((x) => x.id === id);
    if (!t) return null;

    core.patch(id, { classify_state: 'pending' });
    try {
      const projects = core.listProjects();
      const r = await buildClassifier().classify({
        text: t.payload?.text || t.title,
        title: t.title,
        urls: t.payload?.urls || [],
        images: t.payload?.images || [],
        files: t.payload?.files || []
      }, { projects });

      // 模型给的是项目名，这里对回 id。对不上就保持原样，标 needs_project
      let projectId = null;
      let projectName = null;
      if (r.project) {
        const hit = core.findProject(r.project);
        if (hit) { projectId = hit.id; projectName = hit.name; }
      }

      const patch = {
        priority: r.priority,
        kind: r.kind,
        title: r.title || t.title,
        category: t.category || r.category,
        classify_state: 'done',
        classify_reason: r.reason || '',
        classify_model: (r.backend ? r.backend + ':' : '') + (r.model || '')
      };
      if (projectId && projectId !== t.project_id) {
        patch.project_id = projectId;
        patch.project = projectName;
      }
      // 没判出项目：保留用户手选的，没有就留在「默认」并打标记
      patch.needs_project = !projectId && (!t.project_id || t.project === '默认');

      const updated = core.patch(id, patch);
      onDone(updated);
      return updated;
    } catch (e) {
      core.patch(id, {
        classify_state: 'failed',
        classify_reason: String(e.message || e).slice(0, 200)
      });
      return null;
    }
  }

  // 收下就先返回，分类在后台跑 —— 入口不能等 3 秒
  function enqueue(id) {
    if (running >= MAX) {
      return new Promise((resolve) => {
        const tick = setInterval(() => {
          if (running < MAX) { clearInterval(tick); resolve(runOne(id)); }
        }, 200);
      });
    }
    running++;
    return runOne(id).finally(() => { running--; });
  }

  return {
    enqueue, runOne, resetClassifier,
    get classifier() { return buildClassifier(); }
  };
}

// ---------- 模型清单 ----------

let modelCache = { at: 0, data: null, from: '' };

async function listModels() {
  if (modelCache.data && Date.now() - modelCache.at < 5 * 60 * 1000) return modelCache;

  // 先从 magpie 拉，字段最全
  try {
    const r = await fetch((process.env.MAGPIE_URL || 'http://127.0.0.1:3425/v1') + '/models',
      { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = await r.json();
      const list = (d.data || []).map((m) => ({
        id: m.id,
        name: m.display_name || m.magpie_label || m.id,
        vision: (m.modalities?.input || []).includes('image'),
        context: m.context_window || m.context_length || 0,
        owner: m.owned_by || ''
      }));
      modelCache = { at: Date.now(), data: list, from: 'magpie' };
      return modelCache;
    }
  } catch { /* 继续试 alma */ }

  try {
    const r = await fetch((process.env.ALMA_API_URL || 'http://localhost:23001') + '/api/models',
      { signal: AbortSignal.timeout(4000) });
    if (r.ok) {
      const d = await r.json();
      const list = (d.data || []).map((m) => ({
        id: m.id,
        name: m.name || m.id,
        vision: !!m.capabilities?.vision,
        context: m.capabilities?.contextWindow || 0,
        owner: m.providerName || ''
      }));
      modelCache = { at: Date.now(), data: list, from: 'alma' };
      return modelCache;
    }
  } catch { /* 都没有 */ }

  return { at: Date.now(), data: [], from: 'none' };
}

export function createHandler(core, opts = {}) {
  const webDir = opts.webDir || HERE;
  const queue = opts.queue || null;

  const runClassify = async (id) => {
    if (!queue) throw new Error('分类器未启用');
    return await queue.runOne(id);
  };

  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const p = url.pathname;

    try {
      if (p === '/' || p === '/index.html') {
        return serveFile(res, path.join(webDir, 'board.html'), 'text/html; charset=utf-8');
      }
      if (p === '/quick' || p === '/quick.html') {
        // 同一个页面，solo 模式只留随手记那一栏
        res.writeHead(302, { location: '/?solo=1' });
        return res.end();
      }
      if (p.startsWith('/images/')) {
        const name = path.basename(p);
        return serveFile(res, core.imagePath(name), MIME[path.extname(name).toLowerCase()] || 'application/octet-stream');
      }
      if (p === '/api/ping') {
        let n = 0;
        try { n = core.load().tasks.length; } catch { /* 忽略 */ }
        return json(res, 200, { ok: true, tasks: n });
      }
      if (p === '/api/state' && req.method === 'GET') {
        const st = core.state();
        const cfg = core.loadSettings();
        st.settings = { backend: cfg.backend, model: cfg.model, classify: cfg.classify };
        if (queue && queue.classifier?.backend) st.backend = { name: queue.classifier.backend.name };
        return json(res, 200, st);
      }
      if (p === '/api/backend' && req.method === 'GET') {
        if (!queue) return json(res, 200, { error: '分类未启用' });
        const b = queue.classifier && queue.classifier.backend;
        if (!b) return json(res, 200, { error: '后端未初始化' });
        return json(res, 200, await b.status());
      }
      if (p === '/api/settings' && req.method === 'GET') {
        return json(res, 200, core.loadSettings());
      }
      if (p === '/api/settings' && (req.method === 'POST' || req.method === 'PUT')) {
        const b = await readBody(req);
        const next = core.saveSettings(b);
        if (queue) queue.resetClassifier();     // 立刻生效，不用重启
        return json(res, 200, next);
      }
      // 可用模型清单：从 magpie 或 alma 现拉，缓存 5 分钟
      if (p === '/api/models' && req.method === 'GET') {
        return json(res, 200, await listModels());
      }

      if (p === '/api/tasks' && req.method === 'POST') {
        const b = await readBody(req);
        const auto = b.classify !== false;
        const t = core.add({ ...b, classify_state: auto ? 'pending' : 'off' });
        if (auto && queue) queue.enqueue(t.id);   // 后台跑，不等
        return json(res, 200, t);
      }
      if (p === '/api/tasks' && req.method === 'GET') {
        return json(res, 200, core.list(Object.fromEntries(url.searchParams)));
      }
      if (p === '/api/upload' && req.method === 'POST') {
        const b = await readBody(req);
        if (b.filename) return json(res, 200, core.saveFile(b.dataUrl, b.filename));
        return json(res, 200, core.saveImage(b.dataUrl));
      }
      if (p.startsWith('/files/')) {
        const name = path.basename(p);
        const full = core.filePath(name);
        return serveFile(res, full, MIME[path.extname(name).toLowerCase()] || 'application/octet-stream');
      }
      if (p === '/api/classify' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, await runClassify(b.id));
      }
      if (p === '/api/projects' && req.method === 'GET') {
        return json(res, 200, { projects: core.listProjects() });
      }
      if (p === '/api/projects' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, core.addProject(b.name, { aliases: b.aliases, dirs: b.dirs }));
      }
      {
        const pm = p.match(/^\/api\/projects\/([^/]+)$/);
        if (pm) {
          const id = decodeURIComponent(pm[1]);
          if (req.method === 'PATCH' || req.method === 'PUT') {
            const b = await readBody(req);
            return json(res, 200, core.updateProject(id, b));
          }
          if (req.method === 'DELETE') return json(res, 200, core.deleteProject(id));
        }
      }


      const m = p.match(/^\/api\/tasks\/([^/]+)(\/move)?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        if (m[2] && req.method === 'POST') {
          const b = await readBody(req);
          return json(res, 200, core.move(id, b.status));
        }
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const b = await readBody(req);
          return json(res, 200, core.patch(id, b));
        }
        if (req.method === 'DELETE') return json(res, 200, core.remove(id));
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (e) {
      json(res, 400, { error: e instanceof Error ? e.message : String(e) });
    }
  };
}

// 起服务。返回 { server, port } 或 null（所有端口都被占）
export function start(core, opts = {}) {
  const preferred = opts.port || DEFAULT_PORT;
  const queue = opts.queue || createClassifyQueue(core, opts);
  const handler = createHandler(core, { ...opts, queue });
  const portQueue = [preferred, ...FALLBACK_PORTS.filter((x) => x !== preferred)];

  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= portQueue.length) return resolve(null);
      const p = portQueue[i];
      const s = http.createServer((req, res) => { handler(req, res).catch(() => {}); });
      s.once('error', (e) => {
        if (e && e.code === 'EADDRINUSE') return tryNext(i + 1);
        resolve(null);
      });
      s.listen(p, '127.0.0.1', () => resolve({ server: s, port: p, queue }));
    };
    tryNext(0);
  });
}

// ---------- 命令行入口 ----------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const argPort = (() => {
    const i = process.argv.indexOf('--port');
    return i > -1 ? Number(process.argv[i + 1]) : DEFAULT_PORT;
  })();

  const dataDir = process.env.TASK_INBOX_DATA || DEFAULT_DATA_DIR;
  const core = createCore(dataDir);

  const started = await start(core, { port: argPort });
  if (!started) {
    console.error('[task-inbox] 端口都被占用了：' + [argPort, ...FALLBACK_PORTS].join(', '));
    process.exit(1);
  }

  const base = 'http://127.0.0.1:' + started.port;
  console.log('[task-inbox] 已启动');
  console.log('  看板：' + base + '/');
  console.log('  随手记：' + base + '/quick');
  console.log('  数据：' + core.dataFile);

  const stop = () => { try { started.server.close(); } catch {} process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
