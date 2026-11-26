// main.mjs —— Electron 主进程：只负责桌面生命周期
//
// 边界（见 docs/plans/desktop-migration.md §3.3 / §5）：
//   主进程：单实例、窗口、托盘、退出协调
//   UtilityProcess：业务 Runtime（锁、SQLite、Agent 子进程）
//   不在这里实现任何任务规则或数据库操作。

import {
  app, BrowserWindow, Tray, Menu, nativeImage, utilityProcess, shell, ipcMain
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
ipcMain.on('cabinet:token', (e) => { e.returnValue = AUTH_TOKEN; });

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

function startRuntime() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };

    runtime = utilityProcess.fork(HOST, [], { env, serviceName: 'cabinet-runtime' });

    const timer = setTimeout(() => reject(new Error('Runtime 启动超时（15 秒）')), 15000);
    const done = (fn, arg) => { clearTimeout(timer); fn(arg); };

    runtime.on('message', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'hello') { runtime?.postMessage({ type: 'init', token: AUTH_TOKEN }); return; }
      if (msg.type === 'log') { log('[runtime]', msg.line); return; }
      if (msg.type === 'ready') { done(resolve, msg); return; }
      if (msg.type === 'fatal') { done(reject, new Error(msg.message)); return; }
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

  win.on('close', (e) => {
    if (SMOKE || quitting || !tray) return;
    e.preventDefault();
    win.hide();
  });

  return win;
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

app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  if (runtime) {
    e.preventDefault();
    shutdownRuntime().finally(() => app.exit(0));
  }
});

app.whenReady().then(async () => {
  try {
    runtimeReady = await startRuntime();
    log('Runtime ready：', runtimeReady.url, '数据：', runtimeReady.dataDir);
  } catch (e) {
    log('Runtime 启动失败：', e.message);
    if (SMOKE) { app.exit(1); return; }
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
      log('SMOKE ' + (ok ? 'OK' : 'FAILED') + ' port=' + runtimeReady.port + ' data=' + runtimeReady.dataDir);
      await shutdownRuntime();
      app.exit(ok ? 0 : 1);
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
