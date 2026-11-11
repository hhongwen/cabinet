// 事件源验证：watch（真实文件变化）+ 规则热加载 + HTTP token 鉴权。
// 用法: node examples/sourcetest.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { loadConfig, prepareDirs } from '../src/config.mjs';
import { createStore, openDb } from '../src/db.mjs';
import { RuleStore } from '../src/rules.mjs';
import { createRunner } from '../src/runner.mjs';
import { createQueue } from '../src/queue.mjs';
import { createNotifier } from '../src/notify.mjs';
import { createWatchSource } from '../src/sources/watch.mjs';
import { startHub } from '../src/hub.mjs';

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

/* ---------------- 1. watch 真实文件变化 ---------------- */
console.log('\n1. watch 源（真实文件系统）\n');

const watchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ah-watch-'));
const events = [];
const ws = createWatchSource(
  {
    sources: {
      watch: [
        { subject: 'test/inbox', path: watchDir, ignore: ['**/README.md', '**/.git/**'] },
      ],
      watchDebounceMs: 200,
    },
  },
  (ev) => events.push(ev),
);
ws.start();
await sleep(300);

fs.writeFileSync(path.join(watchDir, 'note1.md'), 'hello');
await sleep(900);
check(events.length >= 1, '新文件产生事件', `实际 ${events.length} 条`);
const ev1 = events[0];
check(ev1?.source === 'watch', 'source=watch');
check(/^file\.(created|changed)$/.test(ev1?.type ?? ''), `type 是 file.created/changed（${ev1?.type}）`);
check(ev1?.subject === 'test/inbox', `subject 用配置里的逻辑名（${ev1?.subject}）`);
check(/note1\.md/.test(ev1?.payload?.path ?? ''), `payload 带相对路径（${ev1?.payload?.path}）`);

// debounce：短时间内多次写应被合并（5 次 append → 1~2 条）
events.length = 0;
for (let i = 0; i < 5; i++) {
  fs.appendFileSync(path.join(watchDir, 'note1.md'), `x${i}`);
  await sleep(40);
}
await sleep(1000);
check(events.length <= 2, `debounce 合并多次写（5 次 append → ${events.length} 条，应 ≤2）`);
check(events.length >= 1, `append 有事件产生（实际 ${events.length}）`);

// ignore 生效
events.length = 0;
fs.writeFileSync(path.join(watchDir, 'README.md'), 'ignored');
await sleep(900);
check(events.length === 0, `ignore 挡住 README.md（实际 ${events.length} 条）`);

// 子目录也能监控（recursive）
events.length = 0;
const sub = path.join(watchDir, 'sub');
fs.mkdirSync(sub, { recursive: true });
await sleep(300);
fs.writeFileSync(path.join(sub, 'deep.md'), 'deep');
await sleep(1000);
check(
  events.some((e) => /sub[\\/]deep\.md/.test(e.payload?.path ?? '')),
  'recursive 能收到子目录变化',
  JSON.stringify(events.map((e) => e.payload?.path)),
);

ws.stop();
fs.rmSync(watchDir, { recursive: true, force: true });

/* ---------------- 2. 规则热加载 ---------------- */
console.log('\n2. 规则热加载\n');

const rulesFile = path.join(os.tmpdir(), `ah-hot-${process.pid}.json`);
fs.writeFileSync(rulesFile, JSON.stringify({ rules: [{ id: 'r1', agent: 'x', prompt: 'p', match: {} }] }));
const rs = new RuleStore(rulesFile);
rs.load();
check(rs.get().length === 1, '初始加载 1 条');

// 改文件（等一下让 mtime 变化）
await sleep(60);
fs.writeFileSync(
  rulesFile,
  JSON.stringify({
    rules: [
      { id: 'r1', agent: 'x', prompt: 'p', match: {} },
      { id: 'r2', agent: 'y', prompt: 'q', match: { source: 'z' } },
    ],
  }),
);
const r = rs.maybeReload();
check(r.reloaded === true, 'mtime 变了触发重载');
check(rs.get().length === 2, `重载后 2 条（实际 ${rs.get().length}）`);

const r2 = rs.maybeReload();
check(r2.reloaded === false, 'mtime 没变不重载');

// 坏文件保留旧规则
await sleep(60);
fs.writeFileSync(rulesFile, '{ 这不是 json');
const r3 = rs.maybeReload();
check(r3.reloaded === true, '坏文件也触发了重载尝试');
check(rs.get().length === 2, `坏文件保留旧规则（实际 ${rs.get().length} 条）`);
check(!!rs.error, '记录了错误');
fs.rmSync(rulesFile, { force: true });

/* ---------------- 3. HTTP token ---------------- */
console.log('\n3. HTTP token 鉴权\n');

const CFG = path.resolve(import.meta.dirname, 'cabinet.test.config.json');
const cfg = loadConfig(CFG);
prepareDirs(cfg);
cfg.port = 8898;
cfg.httpToken = 'test-token-123';
cfg.sources.watch = [];
cfg.sources.cron = [];

const dbFile = cfg._meta.dbPath;
for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile + s, { force: true });

const hub = await startHub(cfg, { port: 8898 });

const noAuth = await fetch('http://127.0.0.1:8898/api/events', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ source: 'test', type: 'never', subject: 'auth-1', summary: 'x' }),
});
check(noAuth.status === 401, `没带 token → 401（实际 ${noAuth.status}）`);

const badAuth = await fetch('http://127.0.0.1:8898/api/events', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
  body: JSON.stringify({ source: 'test', type: 'never', subject: 'auth-2', summary: 'x' }),
});
check(badAuth.status === 401, `token 错 → 401（实际 ${badAuth.status}）`);

const goodAuth = await fetch('http://127.0.0.1:8898/api/events', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer test-token-123' },
  body: JSON.stringify({ source: 'test', type: 'never', subject: 'auth-3', summary: 'x' }),
});
check(goodAuth.status === 200, `token 对 → 200（实际 ${goodAuth.status}）`);
const goodData = await goodAuth.json();
check(goodData.ok === true, '带对 token 的响应 ok=true', JSON.stringify(goodData));

// GET /api/state 不需要 token（读面板用）
const state = await fetch('http://127.0.0.1:8898/api/state');
check(state.status === 200, 'GET /api/state 不要求 token');

await hub.close('test');
for (const s of ['', '-wal', '-shm']) fs.rmSync(dbFile + s, { force: true });

console.log(`\n${fail === 0 ? `全部通过：${pass} 项` : `${pass} 通过，${fail} 失败`}`);
process.exitCode = fail === 0 ? 0 : 1;
