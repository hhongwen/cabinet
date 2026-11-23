// 优雅退出验证：直接调用 startHub + hub.close()，验证收尾逻辑
// （子进程 killAll、running 标记 interrupted、server 关闭、库关闭）。
//
// 注意：不用「给子进程发 SIGINT」来测。Windows 上 child.kill('SIGINT') 是
// TerminateProcess，JS 层的 SIGINT 处理器根本不会跑；真实 Ctrl+C 才会。
// SIGINT/SIGTERM handler 本身在 bin/cabinet.mjs 里，Windows/macOS 的真实
// 控制台中断都能触发，这里只测它调用的 close()。
//
// 用法: node examples/shutdowntest.mjs
import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, prepareDirs } from '../src/config.mjs';
import { createStore, openDb } from '../src/db.mjs';
import { startHub } from '../src/hub.mjs';

const CFG = path.resolve(import.meta.dirname, 'cabinet.test.config.json');
const cfg = loadConfig(CFG);
prepareDirs(cfg);
const port = 8897;

let pass = 0;
let fail = 0;
const check = (cond, name, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ''}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 干净库
const dbFile = cfg._meta.dbPath;
for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile + s, { force: true });

console.log('\n优雅退出验证（直接调用 close）\n');

cfg.port = port;
const hub = await startHub(cfg, { port });
check(true, 'hub 启动成功');

// 塞一个长任务（slow 规则跑 60s，timeoutMs 2000 会先自杀，所以直接改 job 的 timeout 不现实；
// 这里用 fake-slow agent，趁着 running 窗口发 close）
const res = await fetch(`http://127.0.0.1:${port}/api/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'test', type: 'slow', subject: 'shutdown-1', summary: '跑到一半被中断' }),
});
const ingest = await res.json();
check(ingest.ok, '投递长任务成功', JSON.stringify(ingest));

// 等它进 running
let running = false;
for (let i = 0; i < 25; i++) {
  await sleep(150);
  const j = hub.store.getJob(ingest.jobId);
  if (j?.status === 'running') {
    running = true;
    break;
  }
}
check(running, '任务进入 running', `实际 ${hub.store.getJob(ingest.jobId)?.status}`);

// 直接调用 close（等价于收到 SIGINT 后 handler 做的事）
const t0 = Date.now();
await hub.close('SIGINT');
const elapsed = Date.now() - t0;
check(elapsed < 5000, `close() 在 5s 内完成（实际 ${elapsed}ms）`);

// close 之后跑着的子进程应该已经被杀掉、job 已经不在 running
// 注意：close 里先 killAll 再标 interrupted，所以最终状态是 interrupted
const store2 = createStore(openDb(cfg._meta.dbPath));
const job = store2.getJob(ingest.jobId);
store2.close();
check(!!job, 'job 还在库里（关库前已持久化）');
check(job?.status !== 'running', `job 已离开 running（实际 ${job?.status}）`);
check(job?.status === 'interrupted', `job 被标为 interrupted（实际 ${job?.status}）`, job?.error ?? '');
check(/hub 退出/.test(job?.error ?? ''), '记录了中断原因', job?.error ?? '');
check(job?.ended_at != null, '有 ended_at');

// server 应该已经关了
let refused = false;
try {
  await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
} catch {
  refused = true;
}
check(refused, 'server 已关闭（连接被拒）');

// 库已关闭：再操作应抛错或被 isClosed 挡下
check(hub.store.isClosed() === true, 'store.isClosed() 为 true');

// 二次 close 应该是幂等的
await hub.close('SIGINT again');
check(true, '重复 close 幂等不抛错');

for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile + s, { force: true });

console.log(`\n${fail === 0 ? `全部通过：${pass} 项` : `${pass} 通过，${fail} 失败`}`);
process.exitCode = fail === 0 ? 0 : 1;
