// test-runtime.mjs —— Runtime 共享入口的生命周期自测
//
// D0 契约：锁、初始化、start、关闭顺序都走 runtime.mjs；
// server.mjs 只负责 handler + listen。这里不碰真实数据目录，
// 也不用 46001–46005，避免和正在跑的 Cabinet 抢端口。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

import { openRuntime } from './runtime.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-runtime-'));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

const lockFile = path.join(tmp, 'server.lock');
const probe = (port) => new Promise((resolve) => {
  const req = http.get('http://127.0.0.1:' + port + '/api/ping', (res) => {
    res.resume();
    resolve(res.statusCode);
  });
  req.on('error', () => resolve(null));
});

// 同一个数据目录只能有一个 Runtime；端口不参与身份判定
let rt1;
try {
  rt1 = await openRuntime({
    dataDir: tmp,
    port: 46150,
    startOptions: { ports: [46150] },
    log: () => {}
  });
  ok('openRuntime 返回真实端口', rt1.port === 46150, String(rt1.port));
  ok('返回 url 与端口一致', rt1.url === 'http://127.0.0.1:46150', rt1.url);
  ok('启动后写锁文件', fs.existsSync(lockFile));
  ok('启动后可访问 /api/ping', (await probe(46150)) === 200);

  // 第二个 Runtime 必须被锁挡住，而不是落到别的端口
  let secondErr = null;
  try {
    await openRuntime({ dataDir: tmp, port: 46151, startOptions: { ports: [46151] }, log: () => {} });
  } catch (e) { secondErr = e; }
  ok('同目录第二个 Runtime 被拒绝', !!secondErr && secondErr.code === 'ELOCKED', secondErr && secondErr.message);

  await rt1.stop();
  rt1 = null;
  ok('停止后锁被释放', !fs.existsSync(lockFile));
  ok('停止后端口关闭', (await probe(46150)) === null);
} finally {
  if (rt1) { try { await rt1.stop(); } catch {} }
}

// 停止后可重开（锁没有残留）
{
  const rt2 = await openRuntime({ dataDir: tmp, port: 46150, startOptions: { ports: [46150] }, log: () => {} });
  ok('停止后可以重新启动', rt2.port === 46150);
  await rt2.stop();
}

// 端口全被占：启动失败但必须释放锁，不能留下自己的过期锁
{
  const busy = http.createServer(() => {});
  await new Promise((r) => busy.listen(46151, '127.0.0.1', r));
  let portErr = null;
  try {
    await openRuntime({ dataDir: tmp, port: 46151, startOptions: { ports: [46151] }, log: () => {} });
  } catch (e) { portErr = e; }
  await new Promise((r) => busy.close(r));
  ok('端口被占时启动失败', !!portErr && portErr.code === 'EPORTS', portErr && portErr.message);
  ok('启动失败后不留下锁', !fs.existsSync(lockFile));
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
