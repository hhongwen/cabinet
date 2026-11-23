// 消息幂等测试。
// 目标：飞书重推同一条消息时，不能建出重复任务，也不能重复回复。
import { openDb } from '../src/db.mjs';
import { ensureTaskSchema, createTaskStore } from '../src/tasks.mjs';
import { createIngest } from '../src/ingest.mjs';
import { createFeishuBridge } from '../src/feishu-bridge.mjs';

let pass = 0, fail = 0;
const errors = [];
const ok = (c, l, d = '') => {
  if (c) { pass++; console.log('  OK ' + l); }
  else { fail++; errors.push(l); console.log('  FAIL ' + l + (d ? ' -- ' + d : '')); }
};
const eq = (a, b, l) => ok(a === b, l, `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`);

function mk() {
  const db = openDb(':memory:');
  ensureTaskSchema(db);
  const tasks = createTaskStore(db);
  const ingest = createIngest({
    tasks, magpie: { async listModels() { return null; } },
    planner: null, sched: null,
  });
  return { db, tasks, ingest };
}

console.log('\n=== 应用层：同一条消息只建一次 ===');
{
  const { tasks, ingest } = mk();
  const a = ingest.accept({ title: '整理笔记', source: 'feishu', sourceRef: 'om_abc' });
  const b = ingest.accept({ title: '整理笔记', source: 'feishu', sourceRef: 'om_abc' });
  eq(b.id, a.id, '第二次返回同一个任务 id');
  eq(b.duplicate, true, '标记为 duplicate');
  eq(tasks.listTasks({ limit: 10 }).length, 1, '库里只有一个任务');
}

console.log('\n=== 不同消息建不同任务 ===');
{
  const { tasks, ingest } = mk();
  const a = ingest.accept({ title: 'A', source: 'feishu', sourceRef: 'om_1' });
  const b = ingest.accept({ title: 'B', source: 'feishu', sourceRef: 'om_2' });
  ok(a.id !== b.id, '两条不同消息建两个任务');
  eq(tasks.listTasks({ limit: 10 }).length, 2, '库里两个任务');
}

console.log('\n=== 不同来源的同名 ref 不冲突 ===');
{
  const { tasks, ingest } = mk();
  const a = ingest.accept({ title: 'A', source: 'feishu', sourceRef: 'ref_1' });
  const b = ingest.accept({ title: 'B', source: 'github', sourceRef: 'ref_1' });
  ok(a.id !== b.id, 'source 不同 → 各自建任务');
  eq(tasks.listTasks({ limit: 10 }).length, 2, '两个任务');
}

console.log('\n=== 没有 sourceRef 时不参与幂等 ===');
{
  const { tasks, ingest } = mk();
  const a = ingest.accept({ title: '面板建的', source: 'panel' });
  const b = ingest.accept({ title: '面板建的', source: 'panel' });
  ok(a.id !== b.id, '没有 sourceRef → 允许重复（面板手动建两次是合法的）');
  eq(tasks.listTasks({ limit: 10 }).length, 2, '两个任务');
}

console.log('\n=== 数据库唯一索引兜底 ===');
{
  const { tasks, db } = mk();
  tasks.insertTask({ title: 'x', source: 'feishu', source_ref: 'om_uniq' });
  let threw = false;
  try {
    tasks.insertTask({ title: 'y', source: 'feishu', source_ref: 'om_uniq' });
  } catch (err) {
    threw = /UNIQUE constraint/i.test(err.message);
  }
  ok(threw, '绕过应用层直接插也会被索引挡住');
}

console.log('\n=== findBySourceRef ===');
{
  const { tasks, ingest } = mk();
  const a = ingest.accept({ title: 'X', source: 'feishu', sourceRef: 'om_find' });
  eq(tasks.findBySourceRef('feishu', 'om_find')?.id, a.id, '能按来源查到');
  eq(tasks.findBySourceRef('feishu', 'om_nope'), null, '查不到返回 null');
  eq(tasks.findBySourceRef('feishu', null), null, 'null ref 返回 null');
}

console.log('\n=== 桥：重复投递不重复回复 ===');
{
  const { tasks, ingest } = mk();
  const sent = [];
  const bridge = createFeishuBridge({
    tasks, ingest, sched: null,
    cfg: { openId: 'ou_owner', allowedOpenIds: ['ou_owner'] },
  });
  bridge._setSender({
    sendText: async (t) => { sent.push(t); return { ok: true }; },
    sendCard: async () => ({ ok: true }),
    patchCard: async () => ({ ok: true }),
  });

  const evt = {
    type: 'im.message.receive_v1',
    sender_type: 'user', message_type: 'text',
    sender_id: 'ou_owner', chat_id: 'oc_1',
    message_id: 'om_dup_msg',
    content: JSON.stringify({ text: '同一条消息' }),
  };

  bridge._handleMessageEvent(evt);
  const firstCount = sent.filter((s) => s.includes('收到，开始拆解')).length;
  eq(firstCount, 1, '第一次回复了');

  // 飞书重推同一条
  bridge._handleMessageEvent(evt);
  const secondCount = sent.filter((s) => s.includes('收到，开始拆解')).length;
  eq(secondCount, 1, '重推时没有再回复一遍');
  eq(tasks.listTasks({ limit: 10 }).length, 1, '只建了一个任务');
}

console.log('\n=== 老库已有重复数据时不能崩 ===');
{
  const db = openDb(':memory:');
  // 先建表但不建唯一索引，塞入重复数据
  const { TASK_SCHEMA } = await import('../src/schema-tasks.mjs');
  db.exec(TASK_SCHEMA);
  db.prepare(`INSERT INTO tasks (id, title, status, created_at, source, source_ref)
    VALUES (?,?,?,?,?,?)`).run('t1', 'dup', 'inbox', new Date().toISOString(), 'feishu', 'om_old');
  db.prepare(`INSERT INTO tasks (id, title, status, created_at, source, source_ref)
    VALUES (?,?,?,?,?,?)`).run('t2', 'dup2', 'inbox', new Date().toISOString(), 'feishu', 'om_old');

  // 现在建索引：应该失败但不抛
  let crashed = false;
  try {
    ensureTaskSchema(db);
  } catch {
    crashed = true;
  }
  ok(!crashed, '老库有重复数据时建索引失败，但启动不崩');

  const t = createTaskStore(db);
  eq(t.findBySourceRef('feishu', 'om_old').id, 't1', '应用层仍能查到最早那条');
  t.close(); db.close();
}

console.log('\n' + '='.repeat(50));
if (fail === 0) console.log(`全部通过：${pass} 项`);
else { console.log(`失败 ${fail} / 共 ${pass + fail}`); for (const e of errors) console.log('  - ' + e); }
process.exitCode = fail === 0 ? 0 : 1;
