// test-auth.mjs —— 桌面模式下的本地接口认证
//
// 规则：Runtime 带 authToken 时，/api、/images、/files 必须带凭据；
// 页面本身（/ 与 /quick）不含数据，允许匿名加载，否则窗口打不开。
// 独立 Node 模式不传 authToken，行为与现在完全一样。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { createCore } from './core.mjs';
import { createHandler } from './server.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-auth-'));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

const core = createCore(tmp);
core.init();
const TOKEN = 'test-token-123';
const handler = createHandler(core, { authToken: TOKEN });
const server = http.createServer((req, res) => { handler(req, res).catch(() => {}); });
await new Promise((r) => server.listen(46200, '127.0.0.1', r));

function get(pathname, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 46200, path: pathname, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', () => resolve(null));
  });
}

ok('未带凭据不能读 /api/ping', (await get('/api/ping')) === 401);
ok('Header 凭据可以读 /api/ping', (await get('/api/ping', { 'x-cabinet-token': TOKEN })) === 200);
ok('查询参数凭据可以读 /api/ping', (await get('/api/ping?t=' + TOKEN)) === 200);
ok('错误凭据被拒', (await get('/api/ping', { 'x-cabinet-token': 'wrong' })) === 401);
ok('未带凭据不能读 /api/state', (await get('/api/state')) === 401);
ok('未带凭据不能读图片/附件', (await get('/images/x.png')) === 403);
ok('带凭据的图片请求进入文件服务', (await get('/images/x.png?t=' + TOKEN)) === 404);
ok('页面本身可以匿名加载（否则窗口打不开）', (await get('/')) === 200);

server.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
