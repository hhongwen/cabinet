// 入口层测试：收任务 → 拆解 → 落库 → 人审放行。
// 用假 planner，不联网，跑得快。
import { openDb } from '../src/db.mjs';
import { ensureTaskSchema, createTaskStore } from '../src/tasks.mjs';
import { createIngest } from '../src/ingest.mjs';

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
const magpie = { async listModels() { return null; } };

function mkIngest(planResult) {
  return createIngest({
    tasks,
    magpie,
    sched: null,
    planner: { async plan() { return planResult; } },
  });
}

function planOf(tasks_, needsReview, extraReasons = []) {
  return {
    ok: true, needsReview, attempts: 1,
    reasons: needsReview ? (extraReasons.length ? extraReasons : ['有不确定项']) : [],
    plan: { kind: 'plan', reason: '测试', tasks: tasks_ },
  };
}

const sub = (title, effect = 'read_only', deps = []) =>
  ({ title, cwd: 'D:/p', agent: 'codex', done_when: '做完了', effect, deps });

console.log('\n=== 原子任务 ===');
{
  const ing = mkIngest({
    ok: true, needsReview: false, attempts: 1, reasons: [],
    plan: { kind: 'atomic', reason: '一件事', tasks: [sub('读一下 README')] },
  });
  const p = tasks.upsertProject({ name: 'p1', cwd: 'D:/p' });
  const id = tasks.insertTask({ project_id: p.id, title: '读 README', cwd: 'D:/p', status: 'inbox' });
  await ing.planTask(id, { project: p });
  const row = tasks.getTask(id);
  eq(row.status, 'ready', '原子任务直接 ready');
  eq(row.effect, 'read_only', 'effect 落库');
  eq(row.done_when, '做完了', 'done_when 落库');
  eq(tasks.listChildren(id).length, 0, '不应建子任务');
  eq(tasks.listTodos({ status: 'open' }).length, 0, '无人审待办');
}

console.log('\n=== 确定的计划：自动放行 ===');
{
  const ing = mkIngest(planOf([sub('A'), sub('B', 'write', [0])], false));
  const p = tasks.upsertProject({ name: 'p2', cwd: 'D:/p2' });
  const id = tasks.insertTask({ project_id: p.id, title: '两件事', cwd: 'D:/p2', status: 'inbox' });
  await ing.planTask(id, { project: p });

  const kids = tasks.listChildren(id);
  eq(kids.length, 2, '两个子任务');
  ok(kids.every((k) => k.status === 'ready'), '全部直接 ready');
  eq(tasks.getTask(id).status, 'done', '父任务标 done（它的价值是图）');
  eq(tasks.listTodos({ status: 'open' }).length, 0, '无需人审');

  const b = kids.find((k) => k.title === 'B');
  eq(tasks.listDeps(b.id).length, 1, 'B 依赖 A');
  ok(!tasks.depsSatisfied(b.id).ok, 'A 没 done，B 依赖不满足');
}

console.log('\n=== 含 external：必须人审 ===');
{
  const ing = mkIngest(planOf([sub('改代码', 'write'), sub('推送', 'external', [0])], true,
    ['有 1 个子任务带外部副作用（发送/发布），必须人审']));
  const p = tasks.upsertProject({ name: 'p3', cwd: 'D:/p3' });
  const id = tasks.insertTask({ project_id: p.id, title: '改完推', cwd: 'D:/p3', status: 'inbox' });
  await ing.planTask(id, { project: p });

  const kids = tasks.listChildren(id);
  ok(kids.every((k) => k.status === 'awaiting_plan'), '全部卡在 awaiting_plan，不自动跑');
  const todos = tasks.listTodos({ status: 'open' });
  eq(todos.length, 1, '生成一条待办');
  eq(todos[0].kind, 'plan_review', '待办类型是 plan_review');

  const n = ing.approvePlan(id);
  eq(n, 2, '放行 2 个');
  ok(tasks.listChildren(id).every((k) => k.status === 'ready'), '放行后全 ready');
}

console.log('\n=== 驳回拆解：整条链作废 ===');
{
  const ing = mkIngest(planOf([sub('X'), sub('Y')], true));
  const p = tasks.upsertProject({ name: 'p4', cwd: 'D:/p4' });
  const id = tasks.insertTask({ project_id: p.id, title: '要驳回的', cwd: 'D:/p4', status: 'inbox' });
  await ing.planTask(id, { project: p });
  const n = ing.rejectPlan(id);
  eq(n, 2, '驳回了 2 个子任务');
  ok(tasks.listChildren(id).every((k) => k.status === 'rejected'), '子任务全 rejected');
}

console.log('\n=== 拆解失败：不静默，进待办 ===');
{
  const ing = mkIngest({ ok: false, needsReview: true, reasons: ['拆解失败：超时'], error: '超时', attempts: 2 });
  const p = tasks.upsertProject({ name: 'p5', cwd: 'D:/p5' });
  const id = tasks.insertTask({ project_id: p.id, title: '拆不出来的', cwd: 'D:/p5', status: 'inbox' });
  await ing.planTask(id, { project: p });
  eq(tasks.getTask(id).status, 'awaiting_plan', '停在 awaiting_plan');
  const todo = tasks.listTodos({ status: 'open' }).find((t) => t.task_id === id);
  ok(!!todo, '有失败待办');
  ok(String(todo.title).includes('拆解失败'), '待办标题说明是拆解失败');
}

console.log('\n=== 已有子任务不重复拆 ===');
{
  const ing = mkIngest(planOf([sub('不该被建')], false));
  const p = tasks.upsertProject({ name: 'p6', cwd: 'D:/p6' });
  const id = tasks.insertTask({ project_id: p.id, title: '已有子任务', cwd: 'D:/p6', status: 'inbox' });
  tasks.insertTask({ project_id: p.id, parent_id: id, root_id: id, title: '手工建的', status: 'ready' });
  await ing.planTask(id, { project: p });
  eq(tasks.listChildren(id).length, 1, '没有多建');
  eq(tasks.getTask(id).status, 'done', '父任务标 done');
}

console.log('\n=== accept 立刻返回 ===');
{
  const ing = mkIngest(planOf([sub('异步的')], false));
  const t0 = Date.now();
  const r = ing.accept({ title: '新任务', cwd: 'D:/p7' });
  const ms = Date.now() - t0;
  ok(ms < 500, `accept 立刻返回（${ms}ms）`);
  eq(r.status, 'inbox', '初始 inbox');
  ok(!!tasks.getTask(r.id), '任务已落库');
}

tasks.close(); db.close();
console.log('\n' + '='.repeat(50));
if (fail === 0) console.log(`全部通过：${pass} 项`);
else { console.log(`失败 ${fail} / 共 ${pass + fail}`); for (const e of errors) console.log('  - ' + e); }
process.exitCode = fail === 0 ? 0 : 1;
