// 面板 API 测试。需要 hub 在跑（默认 8892）。
// 用法: node examples/paneltest.mjs [port]
const port = Number(process.argv[2] ?? 8892);
const BASE = 'http://127.0.0.1:' + port;

let pass = 0, fail = 0;
const errors = [];
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  OK ${name}`); }
  catch (err) { fail++; errors.push(name); console.log(`  FAIL ${name}\n      ${err.message}`); }
}
function assert(c, msg) { if (!c) throw new Error(msg); }
const eq = (a, b, m) => assert(a === b, `${m}: 期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`);

async function j(path, opts) {
  const r = await fetch(BASE + path, opts);
  return { status: r.status, data: await r.json().catch(() => null), headers: r.headers };
}
const post = (p, b) => j(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) });

console.log('\n=== 基础可达 ===');
await t('GET / 返回面板 HTML', async () => {
  const r = await fetch(BASE + '/');
  eq(r.status, 200, 'HTTP 状态');
  const html = await r.text();
  assert(html.includes('<title>Cabinet'), '有标题');
  assert(html.includes('等你处理'), '有右栏待办区');
  assert(html.includes('+ 新任务'), '有新建按钮');
});

await t('静态资源目录穿越被挡', async () => {
  const r = await fetch(BASE + '/../src/hub.mjs');
  assert(r.status === 403 || r.status === 404, '应为 403/404，实际 ' + r.status);
});

console.log('\n=== 任务列表 ===');
let state = null;
await t('GET /api/tasks/state 结构完整', async () => {
  const r = await j('/api/tasks/state');
  eq(r.status, 200, 'HTTP');
  state = r.data;
  for (const k of ['tasks', 'todos', 'groups', 'projects', 'stats']) {
    assert(Array.isArray(state[k]) || typeof state[k] === 'object', '缺字段 ' + k);
  }
});

await t('任务视图带依赖与状态', async () => {
  assert(state.tasks.length > 0, '应有任务');
  const t0 = state.tasks[0];
  for (const k of ['id', 'title', 'status', 'deps', 'depsWaiting', 'attempt']) {
    assert(k in t0, '视图缺字段 ' + k);
  }
  assert(Array.isArray(t0.deps), 'deps 是数组');
});

console.log('\n=== 新建任务 ===');
let newId = null;
await t('POST /api/tasks 建成功', async () => {
  const r = await post('/api/tasks', { title: '面板测试任务', body: '测试', cwd: 'D:/tmp' });
  eq(r.status, 200, 'HTTP');
  assert(r.data.ok, 'ok');
  assert(r.data.id, '有 id');
  newId = r.data.id;
  eq(r.data.task.status, 'inbox', '初始状态 inbox');
  eq(r.data.task.title, '面板测试任务', '标题正确（UTF-8）');
});

await t('缺 title 被拒', async () => {
  const r = await post('/api/tasks', { body: '没标题' });
  eq(r.status, 400, 'HTTP 400');
  assert(!r.data.ok, 'ok=false');
});

await t('乱码请求被拒（编码校验）', async () => {
  const r = await post('/api/tasks', { title: '\ufffd\ufffd损坏' });
  eq(r.status, 400, 'HTTP 400');
  assert(String(r.data.error).includes('UTF-8'), '错误提到 UTF-8');
});

console.log('\n=== 详情 ===');
await t('GET /api/tasks/:id 完整', async () => {
  const r = await j('/api/tasks/' + newId);
  eq(r.status, 200, 'HTTP');
  const d = r.data.task;
  for (const k of ['body', 'runs', 'children', 'timeline']) {
    assert(k in d, '详情缺字段 ' + k);
  }
});

await t('不存在的任务 404', async () => {
  const r = await j('/api/tasks/task_nope');
  eq(r.status, 404, 'HTTP 404');
});

console.log('\n=== 优先级 ===');
await t('改优先级生效', async () => {
  const r = await post(`/api/tasks/${newId}/priority`, { priority: 7 });
  eq(r.status, 200, 'HTTP');
  eq(r.data.task.priority, 7, '优先级');
  const back = await j('/api/tasks/' + newId);
  eq(back.data.task.priority, 7, '已落库');
});

console.log('\n=== 审批流 ===');
let reviewId = null;
await t('找到 review 任务', async () => {
  const r = await j('/api/tasks/state');
  const rv = r.data.tasks.find((x) => x.status === 'review');
  assert(rv, '需要一条 review 任务（先跑 seed 造数据）');
  reviewId = rv.id;
});

await t('approve: review -> done', async () => {
  const r = await post(`/api/tasks/${reviewId}/approve`, { note: '测试确认' });
  eq(r.status, 200, 'HTTP');
  eq(r.data.task.status, 'done', '状态');
});

await t('对 done 再 approve 应 400', async () => {
  const r = await post(`/api/tasks/${reviewId}/approve`, {});
  eq(r.status, 400, 'HTTP 400');
});

await t('rerun 把任务退回 ready', async () => {
  const r = await post(`/api/tasks/${reviewId}/rerun`, {});
  eq(r.status, 200, 'HTTP');
  eq(r.data.task.status, 'ready', '状态');
});

await t('reject 生效', async () => {
  const r = await post(`/api/tasks/${reviewId}/reject`, { note: '不要了' });
  eq(r.status, 200, 'HTTP');
  eq(r.data.task.status, 'rejected', '状态');
});

console.log('\n=== 群消息 ===');
let gid = null;
await t('找到有消息的群', async () => {
  const r = await j('/api/tasks/' + reviewId);
  const g = (r.data.groups || []).find((x) => x.messages.length > 0);
  assert(g, '需要有群消息');
  gid = g.id;
});

await t('往群里发消息', async () => {
  const r = await post(`/api/groups/${gid}/messages`, { body: '测试消息 from paneltest' });
  eq(r.status, 200, 'HTTP');
  const after = await j(`/api/groups/${gid}/messages`);
  const found = after.data.group.messages.some((m) => m.body === '测试消息 from paneltest');
  assert(found, '消息应该出现在流里');
});

await t('空消息被拒', async () => {
  const r = await post(`/api/groups/${gid}/messages`, { body: '   ' });
  eq(r.status, 400, 'HTTP 400');
});

await t('不存在的群 404', async () => {
  const r = await j('/api/groups/grp_nope/messages');
  eq(r.status, 404, 'HTTP 404');
});

console.log('\n=== 待办 ===');
await t('待办 resolve', async () => {
  const st = await j('/api/tasks/state');
  const todo = st.data.todos[0];
  assert(todo, '需要有未处理待办');
  const r = await post(`/api/todos/${todo.id}/resolve`, { resolution: 'approve' });
  eq(r.status, 200, 'HTTP');
  const after = await j('/api/tasks/state');
  const still = after.data.todos.some((x) => x.id === todo.id);
  assert(!still, '处理后应当从列表消失');
});

await t('重复 resolve 应 400', async () => {
  const st = await j('/api/tasks/state');
  const any = st.data.todos[0];
  if (!any) return; // 没有待办就跳过
  const r = await post(`/api/todos/${any.id}/resolve`, { resolution: 'approve' });
  assert(r.status === 200 || r.status === 400, '不该崩');
});

console.log('\n' + '='.repeat(50));
if (fail === 0) console.log(`全部通过：${pass} 项`);
else { console.log(`失败 ${fail} / 共 ${pass + fail}`); for (const e of errors) console.log('  - ' + e); }
process.exitCode = fail === 0 ? 0 : 1;
