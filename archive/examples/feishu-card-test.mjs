// 卡片按钮回调的端到端验证（需要真账号 + 你在飞书点一下）。
//
// 流程：发一张带按钮的卡片 → 监听 card.action.trigger → 你点按钮 → 验证收到
// 用法：node examples/feishu-card-test.mjs [等待秒数]
import { loadConfig } from '../src/config.mjs';
import { createFeishuCliSender, createFeishuLongConn, EVENT_CARD } from '../src/feishu-cli.mjs';
import { buildCard } from '../src/feishu-bridge.mjs';

const WAIT_SEC = Number(process.argv[2] ?? 120);
const cfg = loadConfig();
const fcfg = cfg.feishu ?? {};
const openId = fcfg.openId;

if (!openId) {
  console.error('配置里没有 feishu.openId，无法测试');
  process.exit(2);
}

let pass = 0, fail = 0;
const ok = (c, l, d = '') => {
  if (c) { pass++; console.log('  OK ' + l); }
  else { fail++; console.log('  FAIL ' + l + (d ? ' -- ' + d : '')); }
};

const sender = createFeishuCliSender({ cliPath: fcfg.cliPath, profile: fcfg.profile });
const received = [];

const conn = createFeishuLongConn({
  cliPath: fcfg.cliPath,
  profile: fcfg.profile,
  onEvent: (evt) => {
    const type = evt.type ?? evt.event_type;
    console.log('\n[收到事件]', type);
    console.log(JSON.stringify(evt).slice(0, 600));
    if (type === EVENT_CARD || evt.action_value) received.push(evt);
  },
  onError: (e) => console.log('[WARN]', e),
});

console.log('\n=== 1. 起回调查听 ===');
const p = conn.start(EVENT_CARD);
await new Promise((r) => setTimeout(r, 8000));
console.log('监听状态:', JSON.stringify(conn.stats));

console.log('\n=== 2. 发一张测试卡片 ===');
const taskId = 'task_cardtest_' + Date.now();
const card = buildCard({
  title: '按钮回调测试',
  body: '这是 Cabinet 的自测卡片。请点「通过」或「驳回」，用来验证按钮回调链路。',
  taskId,
  todoId: 'todo_cardtest',
});
const sent = await sender.sendCard(card, openId);
console.log('发送结果:', JSON.stringify(sent).slice(0, 300));
ok(sent?.ok === true, '卡片发送成功');

console.log(`\n=== 3. 等你在飞书点按钮（${WAIT_SEC} 秒） ===`);
const started = Date.now();
await new Promise((resolve) => {
  const timer = setInterval(() => {
    if (received.length > 0 || Date.now() - started > WAIT_SEC * 1000) {
      clearInterval(timer);
      resolve();
    }
  }, 500);
});

console.log('\n=== 4. 结果 ===');
ok(received.length > 0, '收到按钮回调事件');
if (received.length > 0) {
  const evt = received[0];
  let value = evt.action_value;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { value = null; }
  }
  console.log('  action_value 解析后:', JSON.stringify(value));
  ok(!!value, 'action_value 能解析成 JSON');
  ok(value?.taskId === taskId, `携带的 taskId 正确（${value?.taskId}）`);
  ok(['approve', 'reject'].includes(value?.action), `action 是 approve/reject（${value?.action}）`);
  ok(!!evt.operator_id, `带 operator_id（${evt.operator_id}）`);
  ok(!!evt.message_id, '带 message_id');
}

conn.stop();
await new Promise((r) => setTimeout(r, 500));
console.log('\n' + '='.repeat(50));
console.log(fail === 0 ? `全部通过：${pass} 项` : `失败 ${fail} / 共 ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
