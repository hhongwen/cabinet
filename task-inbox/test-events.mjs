// test-events.mjs —— Turn 终态事件（桌面通知的数据来源）
//
// 约束：事件只读；监听器抛错不能影响这一轮的落库。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createCore } from './core.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-events-'));
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

const core = createCore(tmp);
core.init();
const task = core.add({ title: '事件冒烟任务' });
const session = core.createSession({
  taskId: task.id, role: 'dev', agent: 'opencode', workingDirectory: tmp
});

const fired = [];
const off = core.onTurnFinished((e) => fired.push(e));

const t1 = core.startTurn(session.id, '第一轮');
ok('执行中的 Turn 计入 open 数', core.countOpenTurns() === 1, String(core.countOpenTurns()));
core.finishTurn(t1.id, { status: 'completed', resultText: '完成' });
ok('结束后 open 数归零', core.countOpenTurns() === 0, String(core.countOpenTurns()));
ok('一轮结束触发一次事件', fired.length === 1, String(fired.length));
ok('事件带 Turn 终态', fired[0] && fired[0].turn.status === 'completed');
ok('事件带会话与任务', fired[0] && fired[0].session.task_id === task.id && fired[0].task.title === '事件冒烟任务');

off();
const t2 = core.startTurn(session.id, '第二轮');
core.finishTurn(t2.id, { status: 'failed', resultText: '', error: '假失败' });
ok('取消订阅后不再触发', fired.length === 1, String(fired.length));

// 监听器抛错不能影响落库
core.onTurnFinished(() => { throw new Error('监听器炸了'); });
const t3 = core.startTurn(session.id, '第三轮');
let threw = null;
try { core.finishTurn(t3.id, { status: 'completed', resultText: 'ok' }); } catch (e) { threw = e; }
ok('监听器抛错不冒泡到 finishTurn', !threw, threw && threw.message);
ok('监听器抛错时 Turn 仍然落库', core.getTurn(t3.id).status === 'completed');

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} 通过，${fail} 失败`);
process.exit(fail ? 1 : 0);
