// test-auth.mjs —— 桌面模式下的本地接口认证
//
// 规则：Runtime 带 authToken 时，/api、/images、/files 必须带凭据。
// 凭据只走 Header；Header 认证成功后由服务端下发 HttpOnly Cookie，
// 供 <img src>、附件下载这类带不了 Header 的请求使用。
// URL 里不接受凭据（?t= 必须无效）。页面本身允许匿名加载。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

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
const handler = createHandler(core, { authToken: TOKEN, port: 46200 });
const SID = crypto.createHash('sha256').update('cabinet-cookie:' + TOKEN).digest('hex').slice(0, 32);
const server = http.createServer((req, res) => { handler(req, res).catch(() => {}); });
await new Promise((r) => server.listen(46200, '127.0.0.1', r));

function get(pathname, headers = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 46200, path: pathname, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', () => resolve({ status: null, headers: {} }));
  });
}

const noAuth = await get('/api/ping');
ok('未带凭据不能读 /api/ping', noAuth.status === 401, String(noAuth.status));

const withHeader = await get('/api/ping', { 'x-cabinet-token': TOKEN });
ok('Header 凭据可以读 /api/ping', withHeader.status === 200);
ok('Header 认证后下发 HttpOnly Cookie', /cabinet_sid=/.test(String(withHeader.headers['set-cookie'] || ''))
  && /HttpOnly/i.test(String(withHeader.headers['set-cookie'] || '')), String(withHeader.headers['set-cookie'] || 'none'));

const withCookie = await get('/api/ping', { cookie: 'cabinet_sid=' + SID });
ok('Cookie 凭据可以读 /api/ping', withCookie.status === 200);

ok('错误凭据被拒', (await get('/api/ping', { 'x-cabinet-token': 'wrong' })).status === 401);
ok('URL 里的凭据无效（?t= 已移除）', (await get('/api/ping?t=' + TOKEN)).status === 401);
ok('未带凭据不能读 /api/state', (await get('/api/state')).status === 401);
ok('Host 不匹配时拒绝（DNS rebinding）', (await get('/api/ping', { 'x-cabinet-token': TOKEN, host: 'evil.example:46200' })).status === 403);
ok('Origin 不匹配时拒绝（跨站请求）', (await get('/api/ping', { 'x-cabinet-token': TOKEN, origin: 'http://evil.example' })).status === 403);
ok('本机 Origin 正常放行', (await get('/api/ping', { 'x-cabinet-token': TOKEN, origin: 'http://127.0.0.1:46200' })).status === 200);
ok('未带凭据不能读图片/附件', (await get('/images/x.png')).status === 403);
ok('Cookie 可以读图片', (await get('/images/x.png', { cookie: 'cabinet_sid=' + SID })).status === 404);

const page = await get('/');
ok('页面本身可以匿名加载（否则窗口打不开）', page.status === 200);
ok('页面带 CSP 头', /default-src/.test(String(page.headers['content-security-policy'] || '')), String(page.headers['content-security-policy'] || 'none'));

server.close();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
