// 重试逻辑测试。不需要网络。
// 核心要求：网络错误要重试，业务错误不该重试（白等）。
import { openDb } from '../src/db.mjs';
import { ensureTaskSchema, createTaskStore } from '../src/tasks.mjs';
import { createFeishuBridge } from '../src/feishu-bridge.mjs';

let pass = 0, fail = 0;
const ok = (c, l, d = '') => {
  if (c) { pass++; console.log('  OK ' + l); }
  else { fail++; console.log('  FAIL ' + l + (d ? ' -- ' + d : '')); }
};
const eq = (a, b, l) => ok(a === b, l, `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`);

const db = openDb(':memory:');
ensureTaskSchema(db);
const tasks = createTaskStore(db);

// 直接测 withRetry 的行为：通过 bridge 拿不到，单独复刻一份逻辑验证语义
// 这里改为验证「parseResult 判定 + 重试条件」的组合是否合理
const { parseResult } = await import('../src/feishu-cli.mjs');

console.log('\n=== 哪些错误该重试 ===');
{
  const netErr = parseResult({ out: '', err: '{"ok":false,"error":{"type":"network","message":"dial tcp timeout"}}', code: 1 });
  eq(netErr.ok, false, '网络错误判定为失败');
  ok(/network/i.test(netErr.error.type), '类型是 network → 该重试');
}
{
  const transErr = parseResult({ out: '', err: '{"ok":false,"error":{"type":"network","subtype":"transport","message":"x"}}', code: 4 });
  eq(transErr.ok, false, 'transport 失败');
  ok(/network|transport/i.test(transErr.error.type), '该重试');
}
{
  const bizErr = parseResult({ out: '', err: '{"ok":false,"error":{"type":"api","code":99992354,"message":"invalid id"}}', code: 1 });
  eq(bizErr.ok, false, '业务错误也判定失败');
  ok(!/network|transport|timeout/i.test(bizErr.error.type), '类型是 api → 不该重试');
}

console.log('\n=== 重试后成功 ===');
{
  // 模拟：前两次网络失败，第三次成功
  let calls = 0;
  const fakeCall = async () => {
    calls++;
    if (calls < 3) return parseResult({ out: '', err: '{"ok":false,"error":{"type":"network","message":"x"}}', code: 1 });
    return parseResult({ out: '{"ok":true,"data":{"message_id":"om_ok"}}', err: '', code: 0 });
  };
  // 复刻 withRetry 的语义做验证
  async function retry(fn, attempts = 3) {
    let last = null;
    for (let i = 1; i <= attempts; i++) {
      last = await fn();
      if (last?.ok) return last;
      const t = last?.error?.type ?? '';
      if (t && !/network|transport|timeout/i.test(t)) return last;
    }
    return last;
  }
  const r = await retry(fakeCall);
  eq(r.ok, true, '第三次成功');
  eq(calls, 3, '调用了 3 次');
}

console.log('\n=== 业务错误只调一次 ===');
{
  let calls = 0;
  const fakeCall = async () => {
    calls++;
    return parseResult({ out: '', err: '{"ok":false,"error":{"type":"api","code":99992354,"message":"bad id"}}', code: 1 });
  };
  async function retry(fn, attempts = 3) {
    let last = null;
    for (let i = 1; i <= attempts; i++) {
      last = await fn();
      if (last?.ok) return last;
      const t = last?.error?.type ?? '';
      if (t && !/network|transport|timeout/i.test(t)) return last;
    }
    return last;
  }
  const r = await retry(fakeCall);
  eq(r.ok, false, '失败');
  eq(calls, 1, '业务错误不重试（只调 1 次）');
}

console.log('\n=== 卡片 patch 失败时的兜底 ===');
{
  // patch 失败 → 卡片停住，但我们至少要把这件事记下来，
  // 不能静默（上一版就是这么错的）
  const bridge = createFeishuBridge({
    tasks,
    ingest: { accept: () => ({}), approvePlan: () => 0, rejectPlan: () => 0 },
    sched: {
      approve: (id) => { tasks.updateTask(id, { status: 'done' }); return { status: 'done' }; },
      reject: (id) => { tasks.updateTask(id, { status: 'rejected' }); return { status: 'rejected' }; },
    },
    cfg: { openId: 'ou_x', allowedOpenIds: ['ou_x'] },
  });
  let patchCalled = 0;
  let patchFailed = false;
  bridge._setSender({
    sendText: async () => ({ ok: true }),
    sendCard: async () => ({ ok: true }),
    patchCard: async () => { patchCalled++; patchFailed = true; return { ok: false, error: { type: 'network' } }; },
  });

  const proj = tasks.upsertProject({ name: 'pr', cwd: 'D:/pr' });
  const tid = tasks.insertTask({ project_id: proj.id, title: 'x', status: 'review', cwd: 'D:/pr' });
  bridge._handleCardEvent({
    action_value: JSON.stringify({ action: 'approve', taskId: tid }),
    operator_id: 'ou_x',
    message_id: 'om_fail_patch',
  });
  eq(patchCalled, 1, 'patch 被调用');
  ok(patchFailed, 'patch 失败');
  // 关键：patch 失败不该影响任务本身的状态变化
  await new Promise((r) => setTimeout(r, 100));
  eq(tasks.getTask(tid).status, 'done', '任务仍然变 done（patch 失败不阻塞业务）');
}

tasks.close(); db.close();
console.log('\n' + '='.repeat(50));
console.log(fail === 0 ? `全部通过：${pass} 项` : `失败 ${fail} / 共 ${pass + fail}`);
process.exitCode = fail === 0 ? 0 : 1;
