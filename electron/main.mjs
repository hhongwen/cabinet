// main.mjs —— Electron 主进程：只负责桌面生命周期
//
// 边界（见 docs/plans/desktop-migration.md §3.3 / §5）：
//   主进程：单实例、窗口、托盘、退出协调
//   UtilityProcess：业务 Runtime（锁、SQLite、Agent 子进程）
//   不在这里实现任何任务规则或数据库操作。

import {
  app, BrowserWindow, Tray, Menu, nativeImage, utilityProcess, shell, ipcMain, dialog, Notification
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HOST = path.join(HERE, 'runtime-host.mjs');
const SMOKE = process.argv.includes('--smoke');

const ICON_ICO = path.join(ROOT, 'task-inbox', 'icons', 'cabinet-dark.ico');
const TRAY_PNG = path.join(ROOT, 'task-inbox', 'icons', 'dark.png');

let win = null;
let tray = null;
let runtime = null;
let runtimeReady = null;
let quitting = false;

app.setName('Cabinet');

// 本地接口凭据：每个进程一份，只经 preload 交给本应用的渲染层。
// 不下发到 URL、日志，也不传给 Runtime 的子进程。
const AUTH_TOKEN = crypto.randomBytes(32).toString('hex');

// IPC 来源校验：只认本应用的窗口。渲染层即使被注入脚本，也不能凭空拿到凭据
// 或调用原生能力（来源是 process 级 sender，伪造不了）。
function trustedSender(e) {
  return !!win && !win.isDestroyed() && e.sender === win.webContents;
}

ipcMain.on('cabinet:token', (e) => {
  e.returnValue = trustedSender(e) ? AUTH_TOKEN : '';
});

// 白名单能力：选一个本地目录。参数只做长度与类型收敛，不接收任意路径语义。
ipcMain.handle('cabinet:pick-directory', async (e, initial) => {
  if (!trustedSender(e)) return null;
  const defaultPath = (typeof initial === 'string' && initial.length < 260) ? initial : undefined;
  const r = await dialog.showOpenDialog(win, {
    title: '选择项目目录',
    properties: ['openDirectory'],
    defaultPath
  });
  return r.canceled ? null : (r.filePaths[0] || null);
});

// 单实例：第二个进程只激活已有窗口，不起第二个 Runtime。
if (!SMOKE && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });
}

function log(...args) {
  console.log('[cabinet]', ...args);
}

// 通知只由 Runtime 的真实 Turn 事件触发，渲染层不能自己弹通知（§7.3）。
function notifyTurn(msg) {
  const ok = msg.status === 'completed';
  const title = 'Cabinet · ' + (ok ? 'Agent 一轮完成' : 'Agent 执行未完成');
  const detail = [msg.task, msg.role, msg.error || msg.preview].filter(Boolean).join(' · ').slice(0, 200);
  log('NOTIFY', title, detail);
  if (SMOKE || !Notification.isSupported()) return;
  const n = new Notification({ title, body: detail || '打开窗口查看结果' });
  n.on('click', () => { win?.show(); win?.focus(); });
  n.show();
}

function startRuntime() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };

    runtime = utilityProcess.fork(HOST, [], { env, serviceName: 'cabinet-runtime' });

    const timer = setTimeout(() => reject(Object.assign(
      new Error('Runtime 启动超时（15 秒）'), { code: 'ETIMEOUT' }
    )), 15000);
    const done = (fn, arg) => { clearTimeout(timer); fn(arg); };

    runtime.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello') { runtime?.postMessage({ type: 'init', token: AUTH_TOKEN }); return; }
      if (msg.type === 'log') { log('[runtime]', msg.line); return; }
      if (msg.type === 'turn-finished') { notifyTurn(msg); return; }
      if (msg.type === 'ready') { done(resolve, msg); return; }
      if (msg.type === 'fatal') {
        const err = new Error(msg.message);
        err.code = msg.code || '';
        done(reject, err);
        return;
      }
      if (msg.type === 'stopped') { done(() => {}, null); }
    });

    runtime.on('exit', (code) => {
      log('Runtime 退出，code =', code);
      runtime = null;
    });

    runtime.stdout?.on('data', (d) => log('[runtime:out]', String(d).trim()));
    runtime.stderr?.on('data', (d) => log('[runtime:err]', String(d).trim()));
  });
}

function createWindow(url) {
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: 'Cabinet',
    icon: fs.existsSync(ICON_ICO) ? ICON_ICO : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(HERE, 'preload.cjs')
    }
  });

  win.loadURL(url);

  win.once('ready-to-show', () => {
    if (!SMOKE) win.show();
  });

  // 外链一律交给系统浏览器，不在应用内导航
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) shell.openExternal(target);
    return { action: 'deny' };
  });

  // 应用内只允许停在 Runtime 自己的地址：任何页面发起的导航都拦下。
  win.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith(url)) {
      e.preventDefault();
      log('已阻止导航到', target);
    }
  });

  // 不加载 webview，也不授予任何系统权限（通知由 Main 发，不走页面权限）。
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.webContents.session.setPermissionCheckHandler(() => false);

  win.on('close', (e) => {
    if (SMOKE || quitting || !tray) return;
    e.preventDefault();
    win.hide();
  });

  return win;
}

// D0 验收用：真实收一条任务 → 等模型分类落库 → 删掉。不改变产品行为。
async function smokeClassify(w) {
  const run = (js) => w.webContents.executeJavaScript(js);
  const token = "(window.cabinet && window.cabinet.authToken) || ''";
  const created = await run(
    "fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json', 'x-cabinet-token': " + token + " },"
    + " body: JSON.stringify({ title: '冒烟：分类通道验证', text: '冒烟验证用，完成后自动删除。' }) })"
    + ".then(r => r.json()).catch(e => ({ error: String(e) }))"
  );
  if (!created || !created.id) return { ok: false, why: '创建任务失败：' + JSON.stringify(created) };

  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    const state = await run(
      "fetch('/api/state?include_archived=1', { headers: { 'x-cabinet-token': " + token + " } })"
      + ".then(r => r.json()).catch(() => null)"
    );
    const t = state && (state.tasks || []).find((x) => x.id === created.id);
    if (t && t.classify_state === 'failed') return { ok: false, why: '分类失败' };
    if (t && t.classify_state === 'done') {
      await run("fetch('/api/tasks/" + created.id + "', { method: 'DELETE', headers: { 'x-cabinet-token': " + token + " } }).catch(() => {})");
      return { ok: true, priority: t.priority, project: t.project };
    }
  }
  return { ok: false, why: '60 秒内未完成分类' };
}

// D0 验收用：在打包环境里连发两轮 OpenCode 消息，确认 Session 可复用。
// 成功后不删任务：下一次启动用 --smoke-recover <taskId> 验证重启后仍能定位。
async function smokeSession(w) {
  const work = process.env.CABINET_SMOKE_WORK || '';
  if (!work) return { ok: false, why: '缺 CABINET_SMOKE_WORK' };
  const js = `(async () => {
    const h = { 'content-type': 'application/json', 'x-cabinet-token': (window.cabinet && window.cabinet.authToken) || '' };
    const post = (u, b) => fetch(u, { method: 'POST', headers: h, body: JSON.stringify(b) }).then(r => r.json());
    const get = (u) => fetch(u, { headers: h }).then(r => r.json());
    const proj = await post('/api/projects', { name: 'D0 packaged smoke', dirs: [{ path: ${JSON.stringify(work)}, primary: true }] });
    const task = await post('/api/tasks', { title: 'D0 packaged session', project: 'D0 packaged smoke', text: 'Smoke only.' });
    const s = await post('/api/tasks/' + task.id + '/sessions', { role: 'dev', agent: 'opencode', working_directory: ${JSON.stringify(work)} });
    if (!s || !s.session) return { ok: false, why: '会话创建失败：' + JSON.stringify(s) };
    const sid = s.session.id;
    const wait = async (pred) => {
      const end = Date.now() + 180000;
      while (Date.now() < end) {
        await new Promise(r => setTimeout(r, 1500));
        const list = await get('/api/tasks/' + task.id + '/sessions');
        const cur = (list.sessions || []).find(x => x.id === sid);
        if (cur && pred(cur)) return cur;
      }
      return null;
    };
    await post('/api/sessions/' + sid + '/turns', { text: 'Reply with exactly: packaged turn one ok. Do not modify files.' });
    const one = await wait(c => c.last_turn && c.last_turn.status === 'completed');
    if (!one) return { ok: false, why: '第一轮未完成', task: task.id, session: sid };
    await post('/api/sessions/' + sid + '/turns', { text: 'Reply with exactly: packaged turn two ok. Do nothing else.' });
    const two = await wait(c => c.last_turn && c.last_turn.status === 'completed' && c.turn_count === 2);
    if (!two) return { ok: false, why: '第二轮未完成', task: task.id, session: sid };
    return { ok: true, task: task.id, session: sid, external: two.external_session_id, turns: two.turn_count, reply: two.last_turn.result_text };
  })()`;
  return await w.webContents.executeJavaScript(js);
}

// 重启后核对：会话和外部 Session ID 是否还在，reconcile 能否对回。
async function smokeRecover(w, taskId) {
  const js = `(async () => {
    const h = { 'content-type': 'application/json', 'x-cabinet-token': (window.cabinet && window.cabinet.authToken) || '' };
    const list = await fetch('/api/tasks/${taskId}/sessions', { headers: h }).then(r => r.json());
    const s = (list.sessions || [])[0];
    if (!s) return { ok: false, why: '重启后找不到会话' };
    const rec = await fetch('/api/sessions/' + s.id + '/reconcile', { method: 'POST', headers: h }).then(r => r.json());
    return { ok: Boolean(s.external_session_id), external: s.external_session_id, status: s.status,
      last: rec && rec.session && rec.session.last_turn ? rec.session.last_turn.status : '' };
  })()`;
  return await w.webContents.executeJavaScript(js);
}

function createTray() {
  if (SMOKE || !fs.existsSync(TRAY_PNG)) return;
  tray = new Tray(nativeImage.createFromPath(TRAY_PNG));
  tray.setToolTip('Cabinet');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 Cabinet', click: () => { win?.show(); win?.focus(); } },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() }
  ]));
  tray.on('click', () => { win?.show(); win?.focus(); });
}

async function shutdownRuntime(timeoutMs = 5000) {
  if (!runtime) return;
  const child = runtime;
  runtime = null;
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    try { child.postMessage({ type: 'shutdown' }); } catch { clearTimeout(timer); resolve(); }
  });
}

// 退出前问 Runtime「还有几轮在跑」。拿不到就按 0 处理，不阻塞退出。
function queryActiveCount(timeoutMs = 2000) {
  return new Promise((resolve) => {
    const child = runtime;
    if (!child) return resolve(0);
    const timer = setTimeout(() => { child.removeListener('message', onMsg); resolve(0); }, timeoutMs);
    function onMsg(msg) {
      if (!msg || msg.type !== 'active') return;
      clearTimeout(timer);
      child.removeListener('message', onMsg);
      resolve(Number(msg.count) || 0);
    }
    child.on('message', onMsg);
    try { child.postMessage({ type: 'query-active' }); } catch {
      clearTimeout(timer);
      child.removeListener('message', onMsg);
      resolve(0);
    }
  });
}

let quitPending = false;

app.on('before-quit', (e) => {
  if (quitting) return;
  if (!runtime) { quitting = true; return; }
  if (quitPending) { e.preventDefault(); return; }
  quitPending = true;
  e.preventDefault();

  (async () => {
    const active = await queryActiveCount();
    if (active > 0 && !SMOKE) {
      const r = dialog.showMessageBoxSync(win || undefined, {
        type: 'question',
        buttons: ['继续后台运行', '停止任务并退出', '取消'],
        defaultId: 0,
        cancelId: 2,
        title: '还有任务在跑',
        message: '有 ' + active + ' 轮 Agent 正在执行。',
        detail: '关闭窗口只会隐藏到托盘；这里退出会中止这些任务。'
      });
      if (r === 2) { quitPending = false; return; }
      if (r === 0) { quitPending = false; win?.hide(); return; }
    }
    quitting = true;
    await shutdownRuntime();
    app.exit(0);
  })();
});

app.whenReady().then(async () => {
  try {
    runtimeReady = await startRuntime();
    log('Runtime ready：', runtimeReady.url, '数据：', runtimeReady.dataDir);
  } catch (e) {
    log('Runtime 启动失败：', e.message);
    if (SMOKE) { app.exit(1); return; }
    const hints = {
      ELOCKED: '这个数据目录已经有一个 Cabinet 在运行。请先正常关闭原来的服务（或用 stop.cmd 停掉），再启动桌面端。',
      EPORTS: '端口 46001–46005 都被占用。先关闭占用这些端口的程序，再重试。',
      ETIMEOUT: 'Runtime 启动超时。检查数据目录权限与杀毒软件拦截，或重试。'
    };
    dialog.showErrorBox('Cabinet 启动失败',
      e.message + '\n\n' + (hints[e.code] || '请重试；若问题持续，从命令行启动查看完整日志。'));
    app.quit();
    return;
  }

  createWindow(runtimeReady.url);
  createTray();

  if (SMOKE) {
    const failTimer = setTimeout(() => { log('SMOKE FAILED: 窗口 20 秒内未加载'); app.exit(1); }, 20000);
    win.webContents.once('did-finish-load', async () => {
      clearTimeout(failTimer);
      const ok = await win.webContents.executeJavaScript(
        "fetch('/api/ping', { headers: { 'x-cabinet-token': (window.cabinet && window.cabinet.authToken) || '' } })"
        + ".then(r => r.status === 200 ? r.json() : null).then(j => Boolean(j && j.ok)).catch(() => false)"
      );

      // --smoke-classify：用真实模型通道收一条任务，等分类落库，再删掉。
      // 只用于 D0 验收，不改变产品行为。
      let cls = null;
      if (ok && process.argv.includes('--smoke-classify')) {
        cls = await smokeClassify(win);
      }

      // --smoke-session：打包环境连发两轮 OpenCode 消息。
      // --smoke-recover <taskId>：重启后核对会话与外部 Session 仍在。
      let sess = null;
      if (ok && process.argv.includes('--smoke-session')) sess = await smokeSession(win);
      const ri = process.argv.indexOf('--smoke-recover');
      if (ok && ri > -1) sess = await smokeRecover(win, process.argv[ri + 1] || '');

      const allOk = ok && (!cls || cls.ok) && (!sess || sess.ok);
      const bridge = await win.webContents.executeJavaScript(
        "Boolean(window.cabinet && typeof window.cabinet.pickDirectory === 'function')"
      );
      log('SMOKE ' + (allOk ? 'OK' : 'FAILED') + ' port=' + runtimeReady.port + ' data=' + runtimeReady.dataDir
        + ' bridge=' + (bridge ? 'pick' : 'missing')
        + (cls ? ' classify=' + (cls.ok ? 'OK' : 'FAILED:' + (cls.why || '')) : '')
        + (sess ? ' session=' + (sess.ok ? 'OK task=' + sess.task + ' turns=' + sess.turns + ' ext=' + sess.external
          : 'FAILED:' + (sess.why || '')) : ''));
      // 打包后的 GUI 进程没有可读的控制台，冒烟结果写一个临时文件给验收脚本读。
      try {
        fs.writeFileSync(path.join(app.getPath('temp'), 'cabinet-smoke.json'),
          JSON.stringify({ at: new Date().toISOString(), ok: allOk, port: runtimeReady.port,
            dataDir: runtimeReady.dataDir, classify: cls, session: sess, bridge }));
      } catch { /* 写不了文件不影响退出码 */ }
      await shutdownRuntime();
      app.exit(allOk ? 0 : 1);
    });
    win.webContents.once('did-fail-load', (_e, code, desc) => {
      clearTimeout(failTimer);
      log('SMOKE FAILED: did-fail-load', code, desc);
      app.exit(1);
    });
  }
});

app.on('window-all-closed', () => {
  // 有托盘时关窗只是隐藏，运行中的 Agent 继续跑；没有托盘才按平台惯例退出。
  if (SMOKE) return;
  if (process.platform !== 'darwin' && !tray) app.quit();
});
