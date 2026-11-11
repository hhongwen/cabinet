// 飞书长连接联调测试（需要真账号）。
//
// 用法：node examples/feishucli-test.mjs [等待秒数]
// 会：发一条消息给自己 → 挂长连接 → 等你回复 → 验证收到并建任务
//
// 注意：同一时刻只能有一个消费者。跑之前先停掉 hub。
import { openDb } from '../src/db.mjs';
import { ensureTaskSchema, createTaskStore } from '../src/tasks.mjs';
import { createFeishuBridge } from '../src/feishu-bridge.mjs';
import { loadConfig } from '../src/config.mjs';

const WAIT_SEC = Number(process.argv[2] ?? 90);
const cfg = loadConfig();

let pass = 0, fail = 0;
const ok = (c, l, d = '') => {
  if (c) { pass++; console.log('  OK ' + l); }
  else { fail++; console.log('  FAIL ' + l + (d ? ' -- ' + d : '')); }
};

const db = openDb(':memory:');
ensureTaskSchema(db);
const tasks = createTaskStore(db);
const accepted = [];
const ingest = {
  accept: (a) => { accepted.push(a); console.log('  [建任务] ' + a.title); return { id: 'task_x', status: 'inbox' }; },
  approvePlan: () => 1,
  rejectPlan: () => 1,
};

const bridge = createFeishuBridge({
  tasks, ingest, sched: null,
  cfg: cfg.feishu ?? {},
});

console.log('\n=== 1. 发送测试 ===');
const sent = await bridge.notify('Cabinet 联调测试：收到这条说明发送通了');
ok(sent?.ok === true, '消息发送成功', JSON.stringify(sent?.error));

console.log('\n=== 2. 长连接 ===');
console.log(`挂上监听，请给你的机器人发一条消息（${WAIT_SEC} 秒内）`);
const started = Date.now();
bridge.start();

// 等第一条事件，或超时
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (accepted.length > 0 || Date.now() - started > WAIT_SEC * 1000) {
      clearInterval(timer);
      resolve();
    }
  }, 500);
});

const stats = bridge.stats;
console.log('\n=== 3. 结果 ===');
console.log('收到事件:', stats.eventsSeen, '| 建任务:', accepted.length, '| 重连:', stats.restarts);
ok(stats.eventsSeen > 0, '长连接收到事件');
ok(accepted.length > 0, '消息被转成了任务');
if (accepted.length > 0) {
  console.log('  任务标题:', accepted[0].title);
  console.log('  来源:', accepted[0].source);
  ok(accepted[0].source === 'feishu', '来源标为 feishu');
}

bridge.stop();
tasks.close(); db.close();
await new Promise((r) => setTimeout(r, 500));

console.log('\n' + '='.repeat(50));
console.log(fail === 0 ? `全部通过：${pass} 项` : `失败 ${fail} / 共 ${pass + fail}`);
process.exitCode = fail === 0 ? 0 : 1;
process.exit(fail === 0 ? 0 : 1);
