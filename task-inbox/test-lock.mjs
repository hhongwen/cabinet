// test-lock.mjs —— 数据目录锁的原子性与所有权
//
// D1A Instance Contract 的最小验证：
//   - 抢锁必须原子（先检查再写会有两个实例同时成功的窗口）
//   - 过期锁可以安全回收，但只能回收确认已死的那个
//   - 释放只删自己写的锁，不能把别人刚建的锁删掉
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { acquireDataLock } from './server.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-lock-'));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};
const lockFile = path.join(tmp, 'server.lock');
const readLock = () => {
  try { return JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch { return null; }
};
const writeLock = (obj) => fs.writeFileSync(lockFile, JSON.stringify(obj) + '\n');

// 1. 正常抢锁
const first = acquireDataLock(tmp);
const info1 = readLock();
ok('抢锁后文件存在', !!info1);
ok('锁里记录了自己的 pid', info1 && info1.pid === process.pid, JSON.stringify(info1));
ok('锁里有唯一所有权 id', !!(info1 && info1.id));
ok('返回值带同一个 id', first.id === (info1 && info1.id));

// 2. 同目录第二个实例被拒
let secondErr = null;
try { acquireDataLock(tmp); } catch (e) { secondErr = e; }
ok('第二个实例被拒（ELOCKED）', !!secondErr && secondErr.code === 'ELOCKED', secondErr && secondErr.message);

// 3. 释放只删自己的锁：锁被别的实例覆盖后，旧持有者不能删掉它
first.release();
writeLock({ pid: process.pid, id: 'someone-else', started_at: new Date().toISOString() });
first.release();   // 重复调用
ok('重复 release 不报错', true);
ok('不是自己的锁不会被删掉', fs.existsSync(lockFile) && (readLock() || {}).id === 'someone-else');

// 4. 过期锁（进程已死）可以回收
writeLock({ pid: 99999999, id: 'dead', started_at: '2025-01-01T00:00:00.000Z' });
let reclaimed = null;
try { reclaimed = acquireDataLock(tmp); } catch (e) { reclaimed = e; }
ok('过期锁可以回收', !!(reclaimed && reclaimed.id), String(reclaimed));
if (reclaimed && reclaimed.id) {
  ok('回收后写入的是新所有者', (readLock() || {}).pid === process.pid);
  reclaimed.release();
  ok('回收者释放后锁文件消失', !fs.existsSync(lockFile));
}

// 5. 坏锁文件（JSON 损坏）按过期锁处理
fs.writeFileSync(lockFile, 'not-json');
const broken = acquireDataLock(tmp);
ok('坏锁文件可以回收', !!(broken && broken.id));
broken.release();

// 6. 回收过程不留 .stale-* 垃圾
const leftovers = fs.readdirSync(tmp).filter((n) => n.includes('.stale-'));
ok('回收后没有残留 stale 文件', leftovers.length === 0, leftovers.join(','));

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
