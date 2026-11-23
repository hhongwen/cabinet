// 飞书桥的离线测试：消息解析、命令词、白名单、卡片动作。
// 不需要网络，不需要真账号。
import { openDb } from '../src/db.mjs';
import { ensureTaskSchema, createTaskStore } from '../src/tasks.mjs';
import { createFeishuBridge, buildCard, settledCard } from '../src/feishu-bridge.mjs';

let pass = 0, fail = 0;
const errors = [];
function ok(c, l, d = '') {
  if (c) { pass++; console.log('  OK ' + l); }
  else { fail++; errors.push(l); console.log('  FAIL ' + l + (d ? ' -- ' + d : '')); }
}
const eq = (a, b, l) => ok(a === b, l, `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`);

const db = openDb(':memory:');
ensureTaskSchema(db);
const tasks = createTaskStore(db);

function mkBridge(over = {}) {
  const accepted = [];
  const sent = [];
  const actions = [];
  const b = createFeishuBridge({
    tasks,
    ingest: {
      accept: (a) => { accepted.push(a); return { id: 'task_new', status: 'inbox' }; },
      approvePlan: (id) => { actions.push(['approvePlan', id]); return 3; },
      rejectPlan: (id) => { actions.push(['rejectPlan', id]); return 2; },
    },
    sched: {
      approve: (id, note) => { actions.push(['approve', id, note]); return { status: 'done' }; },
      reject: (id, note) => { actions.push(['reject', id, note]); return { status: 'rejected' }; },
    },
    cfg: { allowedOpenIds: [], ...over.cfg },
  });
  // 注入假 sender，走桥内部路径（而不是替换外部方法）
  b._setSender({
    sendText: async (text, openId) => { sent.push({ kind: 'text', text, openId }); return { ok: true }; },
    sendCard: async (card, openId) => { sent.push({ kind: 'card', card, openId }); return { ok: true }; },
  });
  return { b, accepted, sent, actions };
}

const msgEvt = (text, openId = 'ou_owner', extra = {}) => ({
  type: 'im.message.receive_v1',
  sender_type: 'user',
  message_type: 'text',
  sender_id: openId,
  chat_id: 'oc_test',
  message_id: 'om_1',
  content: JSON.stringify({ text }),
  ...extra,
});

console.log('\n=== 普通消息 → 任务 ===');
{
  const { b, accepted } = mkBridge();
  b._handleMessageEvent(msgEvt('整理这周的会议记录'));
  eq(accepted.length, 1, '建了一个任务');
  eq(accepted[0].title, '整理这周的会议记录', '标题来自消息');
  eq(accepted[0].source, 'feishu', '来源标 feishu');
  eq(accepted[0].sourceRef, 'om_1', '带 message_id');
}

console.log('\n=== 命令词不建任务 ===');
{
  const { b, accepted, sent } = mkBridge();
  b._handleMessageEvent(msgEvt('帮助'));
  eq(accepted.length, 0, '「帮助」不建任务');
  ok(sent.some((s) => s.text.includes('发一句话就是要建的任务')), '回了帮助');

  b._handleMessageEvent(msgEvt('状态'));
  eq(accepted.length, 0, '「状态」不建任务');
  ok(sent.some((s) => s.text.includes('个任务')), '回了状态');

  b._handleMessageEvent(msgEvt('待办'));
  eq(accepted.length, 0, '「待办」不建任务');
}

console.log('\n=== 过滤 ===');
{
  const { b, accepted } = mkBridge();
  b._handleMessageEvent(msgEvt('x', 'ou_a', { sender_type: 'app' }));
  eq(accepted.length, 0, '忽略非用户消息');

  b._handleMessageEvent(msgEvt('x', 'ou_a', { message_type: 'image' }));
  eq(accepted.length, 0, '忽略非文本消息');

  b._handleMessageEvent(msgEvt('   '));
  eq(accepted.length, 0, '忽略空白消息');
}

console.log('\n=== 白名单 ===');
{
  const { b, accepted } = mkBridge({ cfg: { allowedOpenIds: ['ou_owner'] } });
  b._handleMessageEvent(msgEvt('合法', 'ou_owner'));
  eq(accepted.length, 1, '白名单内放行');
  b._handleMessageEvent(msgEvt('恶意', 'ou_stranger'));
  eq(accepted.length, 1, '白名单外拒绝');
}

console.log('\n=== @机器人 ===');
{
  const { b, accepted } = mkBridge();
  b._handleMessageEvent(msgEvt('@_user_1 做点事'));
  eq(accepted.length, 1, '建任务');
  eq(accepted[0].title, '做点事', '@ 被去掉');
}

console.log('\n=== 卡片动作 ===');
{
  const { b, actions } = mkBridge();
  const proj = tasks.upsertProject({ name: 'p', cwd: 'D:/p' });
  const tid = tasks.insertTask({ project_id: proj.id, title: '待确认', status: 'review', cwd: 'D:/p' });
  const todo = tasks.addTodo({ kind: 'decision', task_id: tid, title: 'x', detail: 'y' });

  b._handleCardEvent({
    action_value: JSON.stringify({ action: 'approve', taskId: tid, todoId: todo }),
    operator_id: 'ou_owner',
  });
  ok(actions.some((a) => a[0] === 'approve' && a[1] === tid), '调了 sched.approve');
  eq(tasks.getTodo(todo).status, 'resolved', '待办已处理');

  const tid2 = tasks.insertTask({ project_id: proj.id, title: '待驳回', status: 'review', cwd: 'D:/p' });
  const todo2 = tasks.addTodo({ kind: 'decision', task_id: tid2, title: 'x', detail: 'y' });
  b._handleCardEvent({
    action_value: { action: 'reject', taskId: tid2, todoId: todo2 },
    operator_id: 'ou_owner',
  });
  ok(actions.some((a) => a[0] === 'reject' && a[1] === tid2), '调了 sched.reject');
  eq(tasks.getTodo(todo2).status, 'dismissed', '待办已驳回');
}

console.log('\n=== 拆解审批复用卡片 ===');
{
  const { b, actions } = mkBridge();
  const proj = tasks.upsertProject({ name: 'p2', cwd: 'D:/p2' });
  const tid = tasks.insertTask({ project_id: proj.id, title: '待放行', status: 'awaiting_plan', cwd: 'D:/p2' });
  b._handleCardEvent({
    action_value: { action: 'approve', taskId: tid },
    operator_id: 'ou_owner',
  });
  ok(actions.some((a) => a[0] === 'approvePlan' && a[1] === tid), 'awaiting_plan 走 approvePlan');
}

console.log('\n=== 重复点击被忽略 ===');
{
  const { b, actions } = mkBridge();
  const proj = tasks.upsertProject({ name: 'pdup', cwd: 'D:/pdup' });
  const tid = tasks.insertTask({ project_id: proj.id, title: '防连点', status: 'review', cwd: 'D:/pdup' });
  const evt = {
    action_value: JSON.stringify({ action: 'approve', taskId: tid }),
    operator_id: 'ou_owner',
    message_id: 'om_same_message',
  };
  b._handleCardEvent(evt);
  const first = actions.filter((a) => a[0] === 'approve').length;
  b._handleCardEvent(evt);
  const second = actions.filter((a) => a[0] === 'approve').length;
  eq(first, 1, '第一次点击触发一次');
  eq(second, 1, '重复点击被忽略');
}

console.log('\n=== 已完成的任务不重复动作 ===');
{
  const { b, actions } = mkBridge();
  const proj = tasks.upsertProject({ name: 'pdone', cwd: 'D:/pdone' });
  const tid = tasks.insertTask({ project_id: proj.id, title: '已完成的', status: 'done', cwd: 'D:/pdone' });
  const before = actions.length;
  b._handleCardEvent({ action_value: { action: 'approve', taskId: tid }, operator_id: 'ou_owner', message_id: 'om_done' });
  eq(actions.length, before, '已完成任务不再调 approve');
}

console.log('\n=== 已处理卡片没有按钮 ===');
{
  const c = settledCard({ title: '原标题', result: '已通过', ok: true });
  eq(c.header.title.content, '原标题', '保留原标题');
  eq(c.header.template, 'green', '成功用绿色');
  ok(!JSON.stringify(c).includes('button'), '结果卡片里没有按钮');
  eq(settledCard({ title: 'x', result: 'y', ok: false }).header.template, 'grey', '失败用灰色');
}

console.log('\n=== 卡片结构 ===');
{
  const c = buildCard({ title: '要拍板', body: '选 A 还是 B', taskId: 't1', todoId: 'd1' });
  eq(c.header.title.content, '要拍板', '标题');
  eq(c.elements[2].actions.length, 2, '两个按钮');
  eq(c.elements[2].actions[0].value.action, 'approve', '第一个通过');
  eq(c.elements[2].actions[1].value.action, 'reject', '第二个驳回');
  eq(c.elements[2].actions[0].value.taskId, 't1', '带 taskId');
}

console.log('\n=== 无 owner 时不炸 ===');
{
  const b = createFeishuBridge({
    tasks,
    ingest: { accept: () => ({}), approvePlan: () => 0, rejectPlan: () => 0 },
    sched: null,
    cfg: {},
  });
  const r = await b.notify('hi');
  ok(r.ok === false, '没有 owner 时返回失败而不是抛错');
}

tasks.close(); db.close();
console.log('\n' + '='.repeat(50));
if (fail === 0) console.log(`全部通过：${pass} 项`);
else { console.log(`失败 ${fail} / 共 ${pass + fail}`); for (const e of errors) console.log('  - ' + e); }
process.exitCode = fail === 0 ? 0 : 1;
