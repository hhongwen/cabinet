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
import { spawn } from 'node:child_process';

// 把入口带上的 ?t= 继续往下传给子模块，否则 static import 会被 ESM 缓存住，
// 改了 core/classify 也不生效（踩过的坑）。
const RELOAD_TAG = new URL(import.meta.url).search || '';
const loadLocal = (rel) => import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), rel)).href + RELOAD_TAG);

const { createCore } = await loadLocal('core.mjs');
const { createClassifier } = await loadLocal('classify.mjs');
const { listRoots, listDir } = await loadLocal('browse.mjs');
const { createChat } = await loadLocal('chat.mjs');
const { createBriefWriter } = await loadLocal('brief.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.config', 'alma', 'task-inbox');
export const DEFAULT_PORT = 46001;
export const FALLBACK_PORTS = [46002, 46003, 46004, 46005];

// ---------- 运行时身份 ----------
//
// 为什么要这个：改完代码忘了重启，是最容易踩的坑。表现是「代码明明改了却没生效」，
// 而且没有任何提示 —— 排查方向会被带到完全错的地方（实测踩过一次：
// 中文分片修复写好了，线上跑的还是旧进程，是测数据损坏才发现的）。
//
// 做法：进程启动时记一份「磁盘上这几个文件长什么样」，请求时再算一遍。
// 两份不一样 = 磁盘代码比正在跑的进程新 = 需要重启。
// 只 stat 不读内容，4 个文件的成本可以忽略。

const WATCH_FILES = ['core.mjs', 'storage.mjs', 'server.mjs', 'board.html', 'classify.mjs', 'chat.mjs', 'brief.mjs', 'backend.mjs'];

function codeFingerprint() {
  const parts = [];
  for (const rel of WATCH_FILES) {
    try {
      const st = fs.statSync(path.join(HERE, rel));
      // 只要 100ms 精度就够：同一秒内改两次本来就分不出来，而这里只需要判断「变没变」
      parts.push(rel + ':' + st.size + ':' + Math.floor(st.mtimeMs / 100));
    } catch {
      parts.push(rel + ':-');
    }
  }
  return parts.join('|');
}

function readVersion() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(HERE, 'manifest.json'), 'utf8'));
    return String(m.version || '0');
  } catch { return '0'; }
}

const BOOTED_AT = new Date().toISOString();
const BOOT_FINGERPRINT = codeFingerprint();
const VERSION = readVersion();

/** /api/ping 和 /api/state 都会带上它，前端据此提示「需要重启」 */
export function buildInfo() {
  const now = codeFingerprint();
  return {
    version: VERSION,
    pid: process.pid,
    started_at: BOOTED_AT,
    // true = 磁盘上的代码比这个进程新，得重启才生效
    stale: now !== BOOT_FINGERPRINT,
    node: process.version
  };
}

function json(res, code, obj) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

// 请求体上限。要跟 core.mjs 里 saveFile 的 25MB 对得上：
// 附件是 base64 传的，膨胀 4/3，25MB 二进制 = 33.3MB 文本，再留点 JSON 包装的余量 → 40MB。
const MAX_BODY_BYTES = 40 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413,
      '内容太大：请求体超过 ' + (MAX_BODY_BYTES / 1024 / 1024) + 'MB。'
      + '考虑到 base64 会膨胀约 1/3，单个附件上限约 25MB、图片约 12MB。');

    // 有 content-length 就先看，超了立刻拒 —— 不用白读几十 MB
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_BODY_BYTES) {
      req.resume();               // 把 body 读完丢掉，让响应能干净地送出去
      return reject(tooLarge());
    }

    // 必须先把 Buffer 收齐再解码：直接 `str += chunk` 会对每个分片单独调
    // toString()，一个中文字符被切在两个 TCP 分片之间就会变成 U+FFFD，
    // 实测能造出「Ĭ��」这种烂项目名，还写进了库。
    const chunks = [];
    let size = 0;
    let overflow = false;

    req.on('data', (c) => {
      size += c.length;

      if (overflow) return;       // 已超限：剩下的继续读、直接丢，见下

      if (size > MAX_BODY_BYTES) {
        // 三件事都不能做错，否则 413 送不到前端手上（实测踩过两次）：
        //   destroy() → 连接被掐，前端只看到「fetch failed」，以为是网络问题
        //   pause()   → body 卡在 TCP 缓冲里，响应发完 Node 会 RST，客户端 ECONNRESET
        //   立刻 reject → 响应在 body 还没读完时就写，同样被 RST
        // 正确做法是继续把剩余数据读完丢弃，等 'end' 之后再 reject。
        overflow = true;
        chunks.length = 0;
        // 极端情况（比如有人传 1GB）不能一直读：超过两倍上限就直接掐，
        // 这时候保护进程比给一句好错误重要。
        if (size > MAX_BODY_BYTES * 2) {
          req.destroy();
          reject(tooLarge());
        }
        return;
      }

      chunks.push(c);
    });

    req.on('end', () => {
      if (overflow) return reject(tooLarge());
      if (!chunks.length) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(JSON.parse(raw)); } catch { reject(new HttpError(400, 'invalid JSON')); }
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
    const t = core.getTask(id);
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

  // 收下就先返回，分类在后台跑 —— 入口不能等 3 秒。
  //
  // 排队用显式的等待队列，不用 setInterval 轮询空位：
  // 旧写法每个排队请求都留一个 200ms 的定时器，一次贴 50 条就是 50 个定时器
  // 每 200ms 空转一次；而且 clearInterval 只在「抢到位」那条路径上，
  // 万一 runOne 抛错前就没人清。队列版本是零定时器，跑满就 wake 下一个。
  const waiting = [];

  function pump() {
    while (running < MAX && waiting.length) {
      const job = waiting.shift();
      running++;
      runOne(job.id)
        .then(job.resolve, job.reject)
        .finally(() => { running--; pump(); });
    }
  }

  function enqueue(id) {
    return new Promise((resolve, reject) => {
      waiting.push({ id, resolve, reject });
      pump();
    });
  }

  /** 排队里还有多少条。给 /api/backend 和排查用。 */
  function pendingCount() {
    return waiting.length;
  }

  return {
    enqueue, runOne, resetClassifier, pendingCount,
    get runningCount() { return running; },
    get classifier() { return buildClassifier(); }
  };
}

// 弹系统原生的选择文件夹对话框。浏览器做不到这件事，只有进程能调。
//   Windows → PowerShell 的 IFileOpenDialog（pickdir.ps1）
//   macOS   → osascript 的 choose folder
// 其它平台直接 reject，前端会退回 /api/browse 逐层点 —— 那不是错误，是降级。
function pickDir(initial) {
  if (process.platform === 'win32') return pickDirWindows(initial);
  if (process.platform === 'darwin') return pickDirMac(initial);
  return Promise.reject(new Error('这个系统没有原生目录对话框，用 /api/browse 逐层选'));
}

function pickDirWindows(initial) {
  return new Promise((resolve, reject) => {
    const script = path.join(HERE, 'pickdir.ps1');
    if (!fs.existsSync(script)) return reject(new Error('缺 pickdir.ps1'));

    const args = ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', script];
    if (initial) args.push('-Initial', initial);

    const child = spawn('powershell.exe', args, { windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    // 用户可能开着对话框很久，给 5 分钟
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('对话框超时')); }, 5 * 60 * 1000);

    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || ('退出码 ' + code)));
      resolve(out.trim());
    });
  });
}

// macOS：osascript 的 choose folder。
// 用户点取消时 AppleScript 抛 error number -128，这里当成「没选」返回 null ——
// 前端对 null 和抛错的处理不一样（null 什么都不做，抛错才降级到页面浏览）。
// 初始目录通过 argv 传进去，不拼进脚本，免掉引号和反斜杠的转义问题。
function pickDirMac(initial) {
  // default location 指到一个不存在/无权限的路径会让 choose folder 直接抛错，
  // 用户看到的就是「打不开对话框」。所以先自己验一遍，不合格就不传。
  let valid = '';
  try {
    if (initial && fs.statSync(initial).isDirectory()) valid = initial;
  } catch { /* 路径不存在，不传初始目录 */ }

  const script = [
    'on run argv',
    '  set init to item 1 of argv',
    '  try',
    '    if init is "" then',
    '      set p to POSIX path of (choose folder with prompt "选择项目目录")',
    '    else',
    '      set p to POSIX path of (choose folder with prompt "选择项目目录" default location (POSIX file init))',
    '    end if',
    '    return p',
    '  on error number -128',
    '    return ""',
    '  end try',
    'end run'
  ].join('\n');

  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-e', script, valid],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });

    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error('对话框超时')); }, 5 * 60 * 1000);

    child.on('error', (e) => {
      clearTimeout(timer);
      // 没有 GUI 会话（ssh / launchd 里跑）时 osascript 直接起不来
      reject(new Error('osascript 起不来：' + e.message + '（换成 /api/browse 逐层选）'));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || ('osascript 退出码 ' + code)));
      let p = out.trim();
      if (!p) return resolve(null);                 // 用户取消
      if (p.length > 1) p = p.replace(/\/+$/, '');  // choose folder 带尾斜杠
      resolve(p);
    });
  });
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
        try { n = core.count(); } catch { /* 忽略 */ }
        return json(res, 200, { ok: true, tasks: n, ...buildInfo() });
      }
      if (p === '/api/state' && req.method === 'GET') {
        const rev = core.revision();
        const since = url.searchParams.get('since');
        const build = buildInfo();

        // 轮询时带上上次拿到的 revision：库里什么都没变就只回几十字节，
        // 不重传整个看板（2000 条任务时那是 0.9MB）。
        // 用 200 + unchanged 而不是 304：fetch 的 res.ok 对 304 是 false，
        // 前端还得多写一个分支，省下的字节远不值得。
        if (since && since === rev) {
          return json(res, 200, { unchanged: true, revision: rev, build });
        }

        const st = core.state();
        const cfg = core.loadSettings();
        st.settings = { backend: cfg.backend, model: cfg.model, classify: cfg.classify };
        if (queue && queue.classifier?.backend) st.backend = { name: queue.classifier.backend.name };
        st.build = build;         // 前端靠这个判断「跑的是不是最新代码」
        st.revision = rev;
        return json(res, 200, st);
      }
      if (p === '/api/backend' && req.method === 'GET') {
        if (!queue) return json(res, 200, { error: '分类未启用' });
        const b = queue.classifier && queue.classifier.backend;
        if (!b) return json(res, 200, { error: '后端未初始化' });
        // 顺带把队列水位带上：粘一批任务进来之后想确认排到哪了，看这里就够
        return json(res, 200, {
          ...(await b.status()),
          queue: { running: queue.runningCount, waiting: queue.pendingCount() }
        });
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
      if (p === '/api/pickdir' && req.method === 'POST') {
        const b = await readBody(req);
        try {
          const picked = await pickDir(b.initial || '');
          return json(res, 200, { path: picked || null });
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
      }
      if (p === '/api/browse' && req.method === 'GET') {
        const target = url.searchParams.get('path');
        try {
          if (!target) return json(res, 200, { roots: listRoots(), home: os.homedir() });
          return json(res, 200, listDir(target));
        } catch (e) {
          return json(res, 400, { error: e.message });
        }
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


      // 单条任务 + 它的对话
      {
        const dm = p.match(/^\/api\/tasks\/([^/]+)$/);
        if (dm && req.method === 'GET') {
          const id = decodeURIComponent(dm[1]);
          const t = core.getTask(id);
          if (!t) return json(res, 404, { error: '任务不存在' });
          return json(res, 200, { task: t, messages: core.listMessages(id) });
        }
      }

      // 生成 / 重生成需求说明
      if (p === '/api/brief' && req.method === 'POST') {
        if (!queue) return json(res, 400, { error: '模型未启用' });
        const b = await readBody(req);
        const t = core.getTask(b.taskId);
        if (!t) return json(res, 404, { error: '任务不存在' });

        // 用户手改过的说明，不覆盖
        if (t.brief && b.force !== true) {
          return json(res, 200, { brief: t.brief, brief_at: t.brief_at, cached: true });
        }

        const project = t.project_id
          ? core.getProject(t.project_id)
          : core.listProjects().find((x) => x.name === t.project);

        // 老版本靠 task.messages 拿上下文，现在单独查最近几条
        const briefTask = { ...t, messages: core.recentMessages(t.id, 6) };

        const writer = createBriefWriter({
          ...opts,
          imagesDir: core.imagesDir,
          filesDir: core.filesDir,
          mode: core.loadSettings().backend,
          model: core.loadSettings().model
        });

        try {
          const r = await writer.write({ task: briefTask, project });
          const updated = core.setBrief(t.id, r.brief);
          return json(res, 200, { brief: updated.brief, brief_at: updated.brief_at, from: r.backend });
        } catch (e) {
          return json(res, 500, { error: '生成失败：' + String(e.message || e).slice(0, 200) });
        }
      }

      // 手改保存
      if (p === '/api/brief' && (req.method === 'PUT' || req.method === 'PATCH')) {
        const b = await readBody(req);
        const t = core.setBrief(b.taskId, b.brief);
        return json(res, 200, { brief: t.brief, brief_at: t.brief_at });
      }

      if (p === '/api/chat' && req.method === 'POST') {
        if (!queue) return json(res, 400, { error: '模型未启用' });
        const b = await readBody(req);
        const t = core.getTask(b.taskId);
        if (!t) return json(res, 404, { error: '任务不存在' });

        const userText = String(b.text || '').trim();
        if (!userText) return json(res, 400, { error: '说点什么' });

        // 先取旧对话当上下文（不含这条新消息，和改造前一致），再写库
        const thread = core.listMessages(t.id);

        // 先把用户这句存进去，再调模型
        core.pushMessage(t.id, { role: 'user', text: userText });

        const chat = createChat({
          ...opts,
          imagesDir: core.imagesDir,
          filesDir: core.filesDir,
          mode: core.loadSettings().backend,
          model: core.loadSettings().model
        });

        let result;
        try {
          result = await chat.reply({
            task: t,
            thread,
            userText,
            projects: core.listProjects()
          });
        } catch (e) {
          const msg = core.pushMessage(t.id, {
            role: 'assistant',
            text: '模型调用失败：' + String(e.message || e).slice(0, 200)
          });
          return json(res, 200, { reply: msg.text, patch: {}, failed: true });
        }

        // 应用补丁（模型说要改的字段）
        let updated = t;
        if (result.patch && Object.keys(result.patch).length) {
          const patch = { ...result.patch };
          // 项目名要对回 id
          if (patch.project) {
            const hit = core.findProject(patch.project);
            if (hit) { patch.project_id = hit.id; patch.project = hit.name; }
          }
          patch.needs_project = false;
          try { updated = core.patch(t.id, patch); } catch { /* 字段非法就跳过 */ }
        }

        const msg = core.pushMessage(t.id, {
          role: 'assistant',
          text: result.reply,
          patch: result.patch
        });

        return json(res, 200, {
          reply: result.reply,
          patch: result.patch,
          message: msg,
          task: core.getTask(t.id)
        });
      }

      if (p === '/api/chat/clear' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, { task: core.clearMessages(b.taskId) });
      }

      const m = p.match(/^\/api\/tasks\/([^/]+)(\/(?:move|reclassify))?$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const action = m[2] || '';

        if (action === '/move') {
          if (req.method !== 'POST') return json(res, 405, { error: '用 POST' });
          const b = await readBody(req);
          return json(res, 200, core.move(id, b.status));
        }

        if (action === '/reclassify') {
          if (req.method !== 'POST') return json(res, 405, { error: '用 POST' });
          if (!queue) return json(res, 400, { error: '分类未启用' });
          const t = core.getTask(id);
          if (!t) return json(res, 404, { error: '任务不存在' });
          // 已经在跑就别重复排队，否则同一条会被连续判好几次
          if (t.classify_state === 'pending') {
            return json(res, 200, { queued: false, reason: 'already running', task: t });
          }
          queue.enqueue(id).catch(() => { /* runOne 内部已经落了 failed，这里不重复报 */ });
          return json(res, 200, { queued: true });
        }

        // 以下三个只对「任务本体」生效，带子路径的一律不进来
        if (req.method === 'PATCH' || req.method === 'PUT') {
          const b = await readBody(req);
          // classify_* 是分类引擎自己的状态位，不接受外部写。
          // 尤其是 classify_state='pending'：以前能写进去，但写进去不会触发分类，
          // 只会把卡片永远钉在「判断中…」（实测过）。要重判走 /reclassify。
          const body = { ...b };
          for (const k of ['classify_state', 'classify_reason', 'classify_model']) delete body[k];
          return json(res, 200, core.patch(id, body));
        }

        if (req.method === 'DELETE') {
          const t = core.remove(id);
          // 顺手清掉的附件个数返回给前端，好显示「已删除，同时清掉 2 个附件」
          return json(res, 200, { ...t, attachments_removed: (t.removedFiles || []).length });
        }
      }

      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (e) {
      // 自己抛的 HttpError 带状态码（413/400），其余当 400 处理
      const status = e instanceof HttpError ? e.status : 400;
      json(res, status, { error: e instanceof Error ? e.message : String(e) });
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

  // 建库建表；目录里如果有老的 tasks.json，顺手迁进来
  const initResult = core.init();
  if (initResult.migration?.migrated) {
    const mg = initResult.migration;
    console.log('[task-inbox] 已从 tasks.json 迁移：'
      + mg.tasks + ' 个任务 / ' + mg.messages + ' 条消息 / ' + mg.projects + ' 个项目'
      + (mg.backup ? '，原文件改名为 ' + path.basename(mg.backup) : ''));
  } else if (initResult.migration?.reason && !/没有 tasks\.json/.test(initResult.migration.reason)) {
    console.log('[task-inbox] 迁移跳过：' + initResult.migration.reason);
  }
  if (initResult.revived) {
    console.log('[task-inbox] ' + initResult.revived + ' 条任务的判断被上次退出打断，已标成失败，可以重新判断');
  }

  const started = await start(core, { port: argPort });
  if (!started) {
    console.error('[task-inbox] 端口都被占用了：' + [argPort, ...FALLBACK_PORTS].join(', '));
    process.exit(1);
  }

  const base = 'http://127.0.0.1:' + started.port;
  console.log('[task-inbox] 已启动  v' + VERSION + '  pid ' + process.pid);
  console.log('  看板：' + base + '/');
  console.log('  随手记：' + base + '/quick');
  console.log('  数据：' + core.dbFile);

  const stop = () => {
    try { started.server.close(); } catch {}
    // 关库时把 WAL 收回去，不留一个几 MB 的 -wal 文件在目录里
    try { core.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
