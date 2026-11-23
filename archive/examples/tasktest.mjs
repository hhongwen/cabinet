// 任务层测试。用内存库跑，不碰真实数据。
import { openDb } from '../src/db.mjs';
import { ensureTaskSchema, createTaskStore } from '../src/tasks.mjs';

let pass = 0;
let fail = 0;
const errors = [];

function ok(cond, label, detail = '') {
  if (cond) { pass++; console.log(`  OK ${label}`); }
  else { fail++; errors.push(label); console.log(`  FAIL ${label}${detail ? ` -- ${detail}` : ''}`); }
}
function eq(a, b, label) {
  ok(a === b, label, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
}

const db = openDb(':memory:');
ensureTaskSchema(db);
const store = createTaskStore(db);

console.log('\n=== 项目 ===');
const p = store.upsertProject({ name: 'han_kl', cwd: 'D:/WorkFiles/code/04_own_github/han_kl' });
ok(!!p.id, `建项目 ${p.id}`);
const p2 = store.upsertProject({ name: '重名', cwd: 'D:/WorkFiles/code/04_own_github/han_kl' });
eq(p2.id, p.id, 'cwd 相同 -> 复用同一个项目');

console.log('\n=== 任务创建与嵌套 ===');
const root = store.insertTask({
  project_id: p.id, title: '整理这周笔记', body: '把 00_Inbox 里的东西归位',
  status: 'ready', cwd: p.cwd, priority: 5,
});
const t1 = store.insertTask({ project_id: p.id, parent_id: root, title: '子任务A', status: 'ready' });
const t2 = store.insertTask({ project_id: p.id, parent_id: root, title: '子任务B', status: 'ready' });

eq(store.getTask(root).root_id, root, '根任务的 root_id 指向自己');
eq(store.getTask(t1).root_id, root, '子任务的 root_id 指向根');
eq(store.listChildren(root).length, 2, '两个子任务');

console.log('\n=== 依赖 ===');
store.addDep(t2, t1);
eq(store.listDeps(t2).length, 1, 'B 依赖 A');
ok(store.depsSatisfied(root).ok, '根任务无依赖 -> 满足');
ok(!store.depsSatisfied(t2).ok, 'B 的前置没 done -> 不满足');
eq(store.depsSatisfied(t2).waiting.length, 1, '等 1 个前置');
store.updateTask(t1, { status: 'done' });
ok(store.depsSatisfied(t2).ok, 'A 完成后 B 依赖满足');

console.log('\n=== 前置失败不算满足 ===');
const t3 = store.insertTask({ project_id: p.id, title: 'C', status: 'ready' });
store.updateTask(t3, { status: 'failed' });
const t4 = store.insertTask({ project_id: p.id, title: 'D', status: 'ready' });
store.addDep(t4, t3);
ok(!store.depsSatisfied(t4).ok, '前置 failed -> 下游不满足');

console.log('\n=== 防环 ===');
ok(store.wouldCycle(t1, t2), 'B 依赖 A，A 再依赖 B -> 有环');
const before = store.listDeps(t1).length;
store.addDep(t1, t1);
eq(store.listDeps(t1).length, before, '自己依赖自己被拒');
const x = store.insertTask({ title: 'X', status: 'ready' });
const y = store.insertTask({ title: 'Y', status: 'ready' });
const z = store.insertTask({ title: 'Z', status: 'ready' });
store.addDep(y, x);
store.addDep(z, y);
ok(store.wouldCycle(x, z), 'X->Y->Z，Z 再依赖 X -> 有环');

console.log('\n=== 抢占式迁态 ===');
const t5 = store.insertTask({ title: 'E', status: 'ready' });
ok(store.claimTask(t5, 'ready', 'running'), '第一次 claim 成功');
ok(!store.claimTask(t5, 'ready', 'running'), '第二次 claim 失败');
eq(store.getTask(t5).status, 'running', '状态 running');
ok(store.getTask(t5).started_at !== null, 'started_at 已写');

console.log('\n=== 调度排序 ===');
const lo = store.insertTask({ title: '低', status: 'ready', priority: 1 });
const hi = store.insertTask({ title: '高', status: 'ready', priority: 9 });
const ready = store.listReady();
const hiIdx = ready.findIndex((r) => r.id === hi);
const loIdx = ready.findIndex((r) => r.id === lo);
ok(hiIdx >= 0 && loIdx >= 0, '两个任务都在 ready 列表');
ok(hiIdx < loIdx, '高优先级排在前面');

console.log('\n=== runs ===');
const r1 = store.insertRun({ task_id: t1, attempt: 1, agent: 'codex', status: 'queued' });
store.updateRun(r1, { status: 'running', started_at: new Date().toISOString() });
eq(store.countRunning(), 1, '一个 running');
store.updateRun(r1, { status: 'done', ended_at: new Date().toISOString(),
  agent_session_id: 'thread-abc', last_message: '完成' });
eq(store.countRunning(), 0, '跑完 -> 无 running');
eq(store.getRun(r1).agent_session_id, 'thread-abc', 'session id 落库（续轮要用）');
store.insertRun({ task_id: t1, attempt: 2, agent: 'codex' });
eq(store.listRuns(t1).length, 2, '同一任务两次 run');
eq(store.latestRun(t1).attempt, 2, 'latestRun 取 attempt 最大');

console.log('\n=== 群与消息 ===');
const gProj = store.upsertGroup({ kind: 'project', scope_id: p.id, name: 'han_kl 项目群' });
eq(store.upsertGroup({ kind: 'project', scope_id: p.id, name: '重复' }), gProj,
  '同 kind+scope 复用同一个群');
const gTask = store.upsertGroup({ kind: 'task', scope_id: root, name: '整理笔记' });
ok(gTask !== gProj, '任务群和项目群是不同群');

const m1 = store.addMessage({ group_id: gTask, sender_kind: 'human', body: '先看 README' });
const m2 = store.addMessage({ group_id: gTask, sender_kind: 'session',
  sender_id: 'thread-abc', body: '看完了' });
eq(store.listMessages(gTask).length, 2, '群里两条消息');

console.log('\n=== 未读水位 ===');
eq(store.unreadMessages(gTask, 'sess-1').length, 2, '新 session 有 2 条未读');
store.setReadWatermark(gTask, 'sess-1', m2);
eq(store.unreadMessages(gTask, 'sess-1').length, 0, '读完水位后 0 条未读');
await new Promise((r) => setTimeout(r, 5));
store.addMessage({ group_id: gTask, sender_kind: 'human', body: '新的' });
eq(store.unreadMessages(gTask, 'sess-1').length, 1, '水位之后的新消息算未读');
eq(store.unreadMessages(gTask, 'sess-2').length, 3, '另一个 session 各自独立计数');

console.log('\n=== 待办 ===');
const todo = store.addTodo({ kind: 'plan_review', task_id: root,
  title: '拆解结果需要确认', options: ['approve', 'reject'] });
eq(store.countOpenTodos(), 1, '一个待办');
eq(store.getTodo(todo).options, '["approve","reject"]', 'options 存成 JSON');
ok(store.resolveTodo(todo, 'approve'), 'resolve 成功');
eq(store.countOpenTodos(), 0, 'resolve 后无 open');
ok(!store.resolveTodo(todo, 'again'), '重复 resolve 被拒');

console.log('\n=== timeline ===');
store.logEvent({ task_id: root, actor: 'human', action: 'created', detail: '来自飞书' });
store.logEvent({ task_id: root, actor: 'system', action: 'planned', detail: '拆成 2 个子任务' });
const tl = store.listTimeline(root);
eq(tl.length, 2, '两条记录');
ok(tl[0].seq < tl[1].seq, 'seq 递增，顺序即时间');
eq(tl[1].action, 'planned', '第二条是 planned');

console.log('\n=== 任务链时间线 ===');
store.logEvent({ task_id: t1, actor: 'system', action: 'sub.done' });
const tree = store.listTimelineTree(root);
ok(tree.length >= 3, '整条链的时间线汇总了子任务（' + tree.length + ' 条）');
ok(tree.some((e) => e.action === 'sub.done'), '含子任务的事件');
ok(tree.some((e) => e.action === 'created'), '含根任务的事件');
const rootOnly = store.listTimeline(root);
ok(rootOnly.length < tree.length, '只看根任务会漏掉子任务的事件');

console.log('\n=== 统计 ===');
const st = store.stats();
ok(st.total > 0, `总任务 ${st.total}`);
ok(st.byStatus.ready > 0, '有 ready 状态');
eq(st.openTodos, 0, 'open 待办 0');
ok(st.byProject.length >= 1, '按项目分组有数据');

store.close();
db.close();

console.log('\n' + '='.repeat(50));
if (fail === 0) console.log(`全部通过：${pass} 项`);
else { console.log(`失败 ${fail} 项 / 共 ${pass + fail} 项`); for (const e of errors) console.log(`  - ${e}`); }
process.exitCode = fail === 0 ? 0 : 1;
