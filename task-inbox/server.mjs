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
import { fileURLToPath } from 'node:url';
import { createCore } from './core.mjs';

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

export function createHandler(core, opts = {}) {
  const webDir = opts.webDir || HERE;

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
      if (p === '/api/state' && req.method === 'GET') return json(res, 200, core.state());

      if (p === '/api/tasks' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, core.add(b));
      }
      if (p === '/api/tasks' && req.method === 'GET') {
        return json(res, 200, core.list(Object.fromEntries(url.searchParams)));
      }
      if (p === '/api/upload' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, core.saveImage(b.dataUrl));
      }
      if (p === '/api/projects' && req.method === 'POST') {
        const b = await readBody(req);
        return json(res, 200, { projects: core.addProject(b.name) });
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
  const handler = createHandler(core, opts);
  const queue = [preferred, ...FALLBACK_PORTS.filter((x) => x !== preferred)];

  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= queue.length) return resolve(null);
      const p = queue[i];
      const s = http.createServer((req, res) => { handler(req, res).catch(() => {}); });
      s.once('error', (e) => {
        if (e && e.code === 'EADDRINUSE') return tryNext(i + 1);
        resolve(null);
      });
      s.listen(p, '127.0.0.1', () => resolve({ server: s, port: p }));
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
