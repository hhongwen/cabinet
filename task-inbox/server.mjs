// server.mjs —— 独立跑的 HTTP 服务
//
// 这就是主程序：`node server.mjs` 起来之后，浏览器打开 http://127.0.0.1:46001/
// 就能用。不依赖任何外部应用，也不再有「宿主进程」这一层 ——
// 早先它同时被当成 Alma 插件的内嵌服务，插件一开就抢走端口，
// 于是「改了代码要重启宿主」变成常态。现在没有宿主了。
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

const { createCore, AGENT_ROLES } = await loadLocal('core.mjs');
const { createAgentRunner } = await loadLocal('agent.mjs');
const { createClassifier } = await loadLocal('classify.mjs');
const { listRoots, listDir } = await loadLocal('browse.mjs');
const { createChat } = await loadLocal('chat.mjs');
const { createBriefWriter } = await loadLocal('brief.mjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* 数据目录。以前挂在 ~/.config/alma/ 下面 —— 那只是因为它当初是个插件，
   借了宿主的目录。现在它自己的东西放自己的地方。
   TASK_INBOX_DATA 环境变量可以整个覆盖（换机器 / 放到同步盘都用它）。 */
export const DEFAULT_DATA_DIR = path.join(os.homedir(), '.config', 'cabinet');
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

      // 初判只负责「先把它挡在待澄清里」：模型明确说不够开发就落 0。
      // undefined（模型没给这个字段）时不要覆盖 —— 老任务默认是 1，
      // 覆盖成 0 会让一条已经在看板上的任务凭空消失。
      //
      // dev_gaps 必须和 dev_ready 一起落：只落 0 不落原因，待澄清页签里
      // 就只能显示「缺东西」而说不出缺什么，用户还得自己再问一遍模型。
      if (r.dev_ready !== undefined) {
        patch.dev_ready = r.dev_ready ? 1 : 0;
        patch.dev_gaps = r.dev_ready ? [] : (r.dev_gaps || []);
      }
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

    // windowsHide: false 会先弹一个控制台窗口再弹对话框，用户看到的是黑框闪一下。
    // pickdir.ps1 自己负责显示文件对话框，不需要宿主窗口。
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
  } catch { /* 没有第二家了：magpie 拉不到就是空清单 */ }

  return { at: Date.now(), data: [], from: 'none' };
}

export function createHandler(core, opts = {}) {
  const webDir = opts.webDir || HERE;
  const queue = opts.queue || null;
  const runner = opts.runner || null;

  const needRunner = () => {
    if (!runner) throw new HttpError(400, 'Agent 未启用');
    return runner;
  };

  // 归档的两个触发点：进程启动 + 每次收下一条新记录。
  // 刻意不起定时器 —— 单机自用，多一个看不见的循环就多一条故障线。
  // 阈值来自 settings，懒得读库就退回默认 30 天。
  const runArchive = () => {
    try {
      return core.archiveStale(core.loadSettings().archive_after_days);
    } catch (e) {
      // 归档失败不该让「收一条记录」这件事失败
      console.warn('[task-inbox] 归档扫描失败：' + e.message);
      return 0;
    }
  };
  runArchive();

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
        // 视图参数先归一成两个值，revision 和 core.state 用的是同一份 ——
        // 否则「指纹按一种理解算、数据按另一种理解查」，短路会命中错的缓存。
        const incArch = url.searchParams.get('include_archived');
        const devReady = url.searchParams.get('dev_ready');
        // include_merged 也要进 scope：被合并的卡默认不出现在任何视图里，
        // 但关系浮层要按 id 找到它们。两种请求的返回体不一样，
        // 共用指纹会让前端把「有旧卡」的那份缓存当成「没有」的用。
        const incMerged = url.searchParams.get('include_merged');
        const rev = core.revision((incArch || '0') + '|' + (devReady || '-') + '|' + (incMerged || '0'));
        const since = url.searchParams.get('since');
        const build = buildInfo();

        // 轮询时带上上次拿到的 revision：库里什么都没变就只回几十字节，
        // 不重传整个看板（2000 条任务时那是 0.9MB）。
        // 用 200 + unchanged 而不是 304：fetch 的 res.ok 对 304 是 false，
        // 前端还得多写一个分支，省下的字节远不值得。
        if (since && since === rev) {
          return json(res, 200, { unchanged: true, revision: rev, build });
        }

        // include_archived / dev_ready 是视图参数，原样透传给 core 的过滤层：
        // 「待澄清」页签查 dev_ready=0，归档视图查 include_archived=1
        const st = core.state({
          include_archived: incArch ?? undefined,
          dev_ready: devReady ?? undefined,
          include_merged: incMerged ?? undefined
        });
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
      // Agent 能力清单：前端新建会话时用它决定下拉里哪些可用。
      // 没有 runner 不算错，返回空清单即可（CLI 入口、只读客户端都能跑）。
      if (p === '/api/agents' && req.method === 'GET') {
        if (!runner) return json(res, 200, { agents: [], roles: AGENT_ROLES, running: 0 });
        return json(res, 200, {
          agents: await runner.listAgents(),
          roles: AGENT_ROLES,
          running: runner.runningCount
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
      // 可用模型清单：从 magpie 现拉，缓存 5 分钟
      if (p === '/api/models' && req.method === 'GET') {
        return json(res, 200, await listModels());
      }

      if (p === '/api/tasks' && req.method === 'POST') {
        const b = await readBody(req);
        const auto = b.classify !== false;
        const t = core.add({ ...b, classify_state: auto ? 'pending' : 'off' });
        if (auto && queue) queue.enqueue(t.id);   // 后台跑，不等
        runArchive();
        return json(res, 200, t);
      }
      if (p === '/api/tasks' && req.method === 'GET') {
        // 查询参数原样透传，include_archived / dev_ready 由 core.buildWhere 解释
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
      // 同步分类：等模型跑完才返回，会卡住请求几秒。
      // 内部已经没人调了（前端走 POST /api/tasks/:id/reclassify 进队列，异步不阻塞），
      // 留着是因为它是个"立刻要结果"的调试入口，curl 一下就能验通道通不通。
      // 新代码别用它。
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
        // 侧栏默认不显示归档项目；设置里的「显示已归档」显式要
        return json(res, 200, {
          projects: core.listProjects({
            include_archived: url.searchParams.get('include_archived')
          })
        });
      }
      if (p === '/api/projects' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, core.addProject(b.name, { aliases: b.aliases, dirs: b.dirs }));
      }
      // 拖拽排序：整串一次性提交。逐条 PATCH 会让 6 个项目跳 6 次 revision，
      // 前端会跟着重绘 6 遍。
      if (p === '/api/projects/reorder' && req.method === 'POST') {
        const b = await readBody(req);
        core.reorderProjects(b.ids);
        return json(res, 200, { projects: core.listProjects() });
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


      // ---------- 卡片关系（links）----------
      //
      // 注意顺序：下面那条 `^\/api\/tasks\/([^/]+)$` 带子路径匹配不上，
      // 但 `/api/tasks/merge` 会被它当成交付 id="merge" 吃掉 ——
      // 所以固定路径必须写在前面，带子路径的也要写在单条路由之前。
      if (p === '/api/tasks/merge' && req.method === 'POST') {
        const b = await readBody(req);
        const t = core.mergeTasks(b.targetIds, {
          title: b.title,
          text: b.text,
          project: b.project,
          category: b.category,
          priority: b.priority
        });
        return json(res, 200, { task: t });
      }
      if (p === '/api/links' && req.method === 'POST') {
        const b = await readBody(req);
        const link = core.linkTasks(b.fromId, b.toId, b.kind, b.note);
        return json(res, 200, { link });
      }
      {
        const lm = p.match(/^\/api\/links\/([^/]+)$/);
        if (lm && req.method === 'DELETE') {
          return json(res, 200, { ok: true, ...core.deleteLink(decodeURIComponent(lm[1])) });
        }
      }

      // /api/tasks/:id/{links,split,unmerge} —— 必须早于单条任务路由
      {
        const sm = p.match(/^\/api\/tasks\/([^/]+)\/(links|split|unmerge)$/);
        if (sm) {
          const id = decodeURIComponent(sm[1]);
          const action = sm[2];

          if (action === 'links' && req.method === 'GET') {
            if (!core.getTask(id)) return json(res, 404, { error: '任务不存在' });
            return json(res, 200, core.listLinks(id));
          }

          if (action === 'split' && req.method === 'POST') {
            const b = await readBody(req);
            return json(res, 200, core.splitTask(id, b.parts, { note: b.note }));
          }

          if (action === 'unmerge' && req.method === 'POST') {
            return json(res, 200, core.revertMerge(id));
          }
        }
      }

      // ---------- 依赖（depends_on）----------
      //
      // 三个入口都挂在 /api/tasks/:id/ 下面，所以必须早于单条任务路由。
      // 方向按文档 1.4：**from_id 是等的人，to_id 是前置**。
      // 这里只做转发，环检测和「前置没做完不能进 doing」都在 core 里 ——
      // 校验放在路由层的话，CLI 那条路就绕过去了。
      {
        // 删一条：DELETE /api/tasks/:id/depends/:onId
        // 写在建那条之前 —— 不带 onId 的正则匹配不上这个路径，顺序其实无所谓，
        // 但先写长的更不容易在以后再改时踩到。
        const dd = p.match(/^\/api\/tasks\/([^/]+)\/depends\/([^/]+)$/);
        if (dd && (req.method === 'DELETE' || req.method === 'POST')) {
          const id = decodeURIComponent(dd[1]);
          const onId = decodeURIComponent(dd[2]);
          const r = core.unlinkTasks(id, onId, 'depends_on');
          if (!r.removed) return json(res, 404, { error: '这条依赖不存在' });
          return json(res, 200, { ok: true, task: core.getTask(id) });
        }
        const dm = p.match(/^\/api\/tasks\/([^/]+)\/depends$/);
        if (dm && req.method === 'POST') {
          const id = decodeURIComponent(dm[1]);
          const b = await readBody(req);
          const onTaskId = String(b.onTaskId || b.toId || '').trim();
          if (!onTaskId) return json(res, 400, { error: '要给 onTaskId（要等哪张卡）' });
          // 成环在这里被抛出来，落到下面那个 catch —— 400 + 人话
          core.linkTasks(id, onTaskId, 'depends_on', b.note);
          return json(res, 200, { task: core.getTask(id), ...core.blockedBy(id) });
        }
        const bm = p.match(/^\/api\/tasks\/([^/]+)\/blocked$/);
        if (bm && req.method === 'GET') {
          const id = decodeURIComponent(bm[1]);
          if (!core.getTask(id)) return json(res, 404, { error: '任务不存在' });
          return json(res, 200, core.blockedBy(id));
        }
      }

      // ---------- 层级（parent / child）----------
      //
      // 方向和依赖一样：**子 → 父**，`POST /api/tasks/:id/parent` 里的 `:id`
      // 是子卡，body.parentId 是要挂上去的父卡。所以这里的路径读起来是
      // 「把 :id 这张卡挂到 body 里那张下面」。
      //
      // 三条约束都不在这层：环检测 / 5 层上限 / 父卡状态派生全在 core 里，
      // 路由只做转发 —— 校验写在路由里，CLI 和以后的批量操作就绕过去了。
      {
        const pm = p.match(/^\/api\/tasks\/([^/]+)\/parent$/);
        if (pm) {
          const id = decodeURIComponent(pm[1]);
          if (req.method === 'POST') {
            const b = await readBody(req);
            const parentId = String(b.parentId || b.toId || '').trim();
            if (!parentId) return json(res, 400, { error: '要给 parentId（挂到哪张卡下面）' });
            // linkTasks 会对「换父卡」自己解掉旧边，并把两边状态重算一遍
            const link = core.linkTasks(id, parentId, 'parent', b.note);
            return json(res, 200, {
              link,
              task: core.getTask(id),
              parent: core.getTask(parentId),
              children: core.childrenOf(parentId),
              subtree: core.subtreeStats(parentId)
            });
          }
          if (req.method === 'DELETE') {
            const t = core.getTask(id);
            if (!t) return json(res, 404, { error: '任务不存在' });
            if (!t.parent_id) return json(res, 404, { error: '这张卡没有上级' });
            // 先记下父卡：解完边之后 task.parent_id 会被清空，就拿不到了
            const upId = t.parent_id;
            const r = core.unlinkTasks(id, upId, 'parent');
            if (!r.removed) return json(res, 404, { error: '这条上下级关系不存在' });
            return json(res, 200, {
              ok: true,
              task: core.getTask(id),
              parent: core.getTask(upId),
              children: core.childrenOf(upId),
              subtree: core.subtreeStats(upId)
            });
          }
        }

        const cm = p.match(/^\/api\/tasks\/([^/]+)\/children$/);
        if (cm && req.method === 'GET') {
          const id = decodeURIComponent(cm[1]);
          if (!core.getTask(id)) return json(res, 404, { error: '任务不存在' });
          // subtree 是所有后代（卡片上的「3/5」），children 是直接子项（就地展开的清单）
          return json(res, 200, {
            children: core.childrenOf(id),
            subtree: core.subtreeStats(id)
          });
        }
      }

      // ---------- Agent Session / Turn（阶段 1A） ----------
      //
      // 这里只做「参数归一 + 转发」。角色 / Agent / 工作目录的约束在 core，
      // Turn 的串行、超时、恢复在 agent.mjs —— 放在路由层，CLI 就绕过去了。
      {
        const sm = p.match(/^\/api\/tasks\/([^/]+)\/sessions$/);
        if (sm) {
          const taskId = decodeURIComponent(sm[1]);
          const t = core.getTask(taskId);
          if (!t) return json(res, 404, { error: '任务不存在' });
          // 连只读会话列表也不在没有 runner 时假装空：那会让「Agent 未启用」
          // 看起来像「这张卡还没挂会话」。
          needRunner();

          if (req.method === 'GET') {
            return json(res, 200, { sessions: core.listSessions(taskId) });
          }

          if (req.method === 'POST') {
            const b = await readBody(req);
            const project = t.project_id
              ? core.getProject(t.project_id)
              : core.findProject(t.project, { include_archived: true });
            if (project && project.archived_at) {
              throw new HttpError(400, '项目已归档，先恢复或换一个项目');
            }

            const role = String(b.role || 'dev').trim();
            const agent = String(b.agent || (project && project.default_agent) || 'opencode').trim();
            const model = b.model === undefined
              ? ((project && project.default_model) || null)
              : (b.model ? String(b.model).trim() : null);
            const dirs = (project && Array.isArray(project.dirs)) ? project.dirs : [];
            const primary = dirs.find((x) => x.primary) || dirs[0];
            const workingDirectory = String(b.working_directory || (primary && primary.path) || '').trim();
            if (!workingDirectory) {
              throw new HttpError(400, '先给项目配一个工作目录，或者手动选一个');
            }

            const agents = await runner.listAgents();
            const hit = agents.find((a) => a.kind === agent);
            if (!hit) throw new HttpError(400, '这个 Agent 还没有接入: ' + agent);
            if (!hit.available) {
              throw new HttpError(400, (agent === 'opencode' ? 'OpenCode' : agent) + ' 不可用，先确认 CLI 装好');
            }

            // 同一张卡的同一个角色 + Agent，默认复用最近那条会话。
            // 要故意开第二条（比如上下文满了）时传 force:true。
            if (b.force !== true) {
              const existing = core.listSessions(taskId)
                .filter((s) => s.role === role && s.agent === agent)
                .sort((x, y) => String(y.updated_at).localeCompare(String(x.updated_at)))[0];
              if (existing) return json(res, 200, { session: existing, created: false });
            }

            const session = core.createSession({
              taskId, role, agent, workingDirectory, model
            });
            return json(res, 200, { session, created: true });
          }

          return json(res, 405, { error: '用 GET 或 POST' });
        }
      }

      {
        const sm = p.match(/^\/api\/sessions\/([^/]+)$/);
        if (sm) {
          if (req.method !== 'GET') return json(res, 405, { error: '用 GET' });
          const st = needRunner().state(decodeURIComponent(sm[1]));
          if (!st) return json(res, 404, { error: '会话不存在' });
          return json(res, 200, st);
        }
      }

      {
        const tm = p.match(/^\/api\/sessions\/([^/]+)\/turns$/);
        if (tm) {
          if (req.method !== 'POST') return json(res, 405, { error: '用 POST' });
          const sessionId = decodeURIComponent(tm[1]);
          if (!core.getSession(sessionId)) return json(res, 404, { error: '会话不存在' });
          const b = await readBody(req);
          const text = String(b.text || '').trim();
          if (!text) return json(res, 400, { error: '说点什么再发送' });
          if (core.openTurn(sessionId)) {
            throw new HttpError(409, '这个会话还有一轮没结束');
          }
          let started;
          try {
            started = needRunner().start({ sessionId, text });
          } catch (e) {
            // 检查与插入之间有窗口：startTurn 的部分唯一索引才是最后一道闸，
            // 这里把数据库错误翻成 409，别让前端看到「UNIQUE constraint」。
            if (/还有一轮/.test(String(e.message || ''))) throw new HttpError(409, e.message);
            throw e;
          }
          started.done.catch((e) => {
            console.warn('[task-inbox] Agent Turn 收尾失败：' + e.message);
          });
          return json(res, 202, { turn: started.turn });
        }
      }

      {
        const rm = p.match(/^\/api\/sessions\/([^/]+)\/reconcile$/);
        if (rm) {
          if (req.method !== 'POST') return json(res, 405, { error: '用 POST' });
          const sessionId = decodeURIComponent(rm[1]);
          if (!core.getSession(sessionId)) return json(res, 404, { error: '会话不存在' });
          // 导出失败是「核对不了」，不是服务端错误：200 + error 让 UI 原样显示
          return json(res, 200, await needRunner().reconcile(sessionId));
        }
      }

      {
        const im = p.match(/^\/api\/turns\/([^/]+)\/interrupt$/);
        if (im) {
          if (req.method !== 'POST') return json(res, 405, { error: '用 POST' });
          const turn = needRunner().interrupt(decodeURIComponent(im[1]));
          if (!turn) return json(res, 404, { error: 'Turn 不存在' });
          return json(res, 200, { turn });
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
        // 附件形状跟 /api/tasks 一致（上传完的 {path,url,name} / {path,name,original,size}）
        const images = Array.isArray(b.images) ? b.images.filter(Boolean) : [];
        const files = Array.isArray(b.files) ? b.files.filter(Boolean) : [];
        // 纯文件、纯图片没有文字也要能发。三者全空才算「什么都没说」。
        if (!userText && !images.length && !files.length) {
          return json(res, 400, { error: '说点什么，或者贴张图/加个文件' });
        }

        // 先取旧对话当上下文（不含这条新消息，和改造前一致），再写库
        const thread = core.listMessages(t.id);

        // 先把用户这句存进去，再调模型
        core.pushMessage(t.id, {
          role: 'user',
          text: userText,
          attachments: { images, files }
        });

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
            images,
            files,
            projects: core.listProjects()
          });
        } catch (e) {
          // CLI 通道不支持图片时 backend 直接抛错 —— 原样显示给用户，
          // 不要在这里吞掉改写成「调用失败」，否则用户不知道该换通道。
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
  // 服务启动时先把上次没跑完的 Turn 收成 unknown，再后台核对。
  // 必须在 listen 之前做：先让端口可用、再标状态，会有一段「页面能打开、
  // 但卡片显示 running」的假运行窗口。
  const runner = opts.runner || createAgentRunner({
    core,
    dataDir: core.dataDir,
    adapters: opts.adapters,
    timeoutMs: opts.agentTimeoutMs
  });
  const recoveredTurns = runner.recover();
  const handler = createHandler(core, { ...opts, queue, runner });
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
      s.listen(p, '127.0.0.1', () => resolve({ server: s, port: p, queue, runner, recoveredTurns }));
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
  try {
    const archived = core.archiveStale(core.loadSettings().archive_after_days);
    if (archived) console.log('[task-inbox] 已归档 ' + archived + ' 条超期的已完成任务');
  } catch (e) {
    console.log('[task-inbox] 归档扫描失败：' + e.message);
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
  if (started.recoveredTurns) {
    console.log('[task-inbox] ' + started.recoveredTurns + ' 轮 Agent 执行被上次退出打断，已标成待核对');
  }

  const stop = async () => {
    try { started.server.close(); } catch {}
    // 先把子进程收掉，再关库：反过来的话，正在跑的 Agent 收尾时会写一个
    // 已经关掉的连接，日志里全是「database is closed」。
    try { await started.runner.close(); } catch {}
    // 关库时把 WAL 收回去，不留一个几 MB 的 -wal 文件在目录里
    try { core.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
