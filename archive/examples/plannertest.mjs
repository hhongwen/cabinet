// 拆解器的纯逻辑测试：判模糊、JSON 抽取、完备性校验。
// 不碰网络，跑得快，适合每次改动都跑。
import { assessPlan, extractPlanJson, validateSubtask, buildPlannerPrompt } from '../src/planner.mjs';

let pass = 0, fail = 0;
const errors = [];
function ok(c, l, d = '') {
  if (c) { pass++; console.log(`  OK ${l}`); }
  else { fail++; errors.push(l); console.log(`  FAIL ${l}${d ? ` -- ${d}` : ''}`); }
}
function eq(a, b, l) { ok(a === b, l, `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`); }

const good = {
  title: '归位笔记', body: '把文件移到 10_Projects', cwd: 'D:/kb',
  agent: 'codex', done_when: '文件已在目标目录且 frontmatter 完整',
  effect: 'write', deps: [],
};

console.log('\n=== 单个子任务校验 ===');
eq(validateSubtask(good).length, 0, '完整子任务无问题');
eq(validateSubtask({ ...good, cwd: '' }).length, 1, 'cwd 空 -> 1 个问题');
eq(validateSubtask({ ...good, done_when: undefined }).length, 1, 'done_when 缺失 -> 1 个问题');
ok(validateSubtask({ ...good, agent: 'TBD' }).length > 0, 'agent 写占位符 TBD -> 有问题');
ok(validateSubtask({ ...good, cwd: '<路径>' }).length > 0, 'cwd 是尖括号占位符 -> 有问题');
ok(validateSubtask({ ...good, effect: '发送' }).length > 0, 'effect 非法值 -> 有问题');
eq(validateSubtask({ ...good, model: null }).length, 0, 'model 可以为 null（用默认）');

console.log('\n=== 整体判定：atomic ===');
eq(assessPlan({ kind: 'atomic', tasks: [good] }).needsReview, false, '原子任务 + 完整 -> 自动放行');
ok(assessPlan({ kind: 'atomic', tasks: [good, good] }).needsReview,
  'atomic 却给两个 -> 要人审');

console.log('\n=== 整体判定：plan ===');
eq(assessPlan({ kind: 'plan', tasks: [good, good] }).needsReview, false,
  'plan + 全部完整 + 无 external -> 自动放行');
ok(assessPlan({ kind: 'plan', tasks: [{ ...good, cwd: '' }] }).needsReview,
  '有一个子任务不完整 -> 要人审');
ok(assessPlan({ kind: 'plan', tasks: [{ ...good, effect: 'external' }] }).needsReview,
  '有 external -> 必须人审');
ok(assessPlan({ kind: 'plan', tasks: [] }).needsReview, 'plan 但空数组 -> 要人审');
ok(assessPlan(null).needsReview, 'null -> 要人审');
ok(assessPlan({ kind: 'plan' }).needsReview, '没有 tasks 字段 -> 要人审');

console.log('\n=== external 的理由要说清楚 ===');
const ext = assessPlan({ kind: 'plan', tasks: [{ ...good, effect: 'external' }] });
ok(ext.reasons.some((r) => r.includes('外部副作用')), '理由里点名外部副作用');

console.log('\n=== JSON 抽取 ===');
eq(extractPlanJson('{"kind":"atomic","tasks":[]}').kind, 'atomic', '纯 JSON');
eq(extractPlanJson('```json\n{"kind":"atomic","tasks":[]}\n```').kind, 'atomic', '剥 markdown 代码块');
eq(extractPlanJson('好的，结果如下：\n{"kind":"plan","tasks":[]}\n以上。').kind, 'plan', '剥前后废话');
eq(extractPlanJson('{"kind":"atomic","tasks":[],}').kind, 'atomic', '容忍尾逗号');
ok(extractPlanJson('{"a":1,}') !== null, '任意 JSON 对象都抽得出（结构校验交给 assessPlan）');
eq(extractPlanJson('完全不是 JSON'), null, '非 JSON -> null');
eq(extractPlanJson(''), null, '空串 -> null');
eq(extractPlanJson(null), null, 'null -> null');
const nested = extractPlanJson('前缀 {"tasks":[{"deps":[0,1]}]} 后缀');
ok(nested && Array.isArray(nested.tasks), '嵌套花括号能正确切出来');

console.log('\n=== prompt 构建 ===');
const pr = buildPlannerPrompt({ title: '整理笔记', body: '归位', cwd: 'D:/kb' },
  { project: { name: 'kb', cwd: 'D:/kb' }, agents: ['codex', 'opencode'],
    models: ['group/smart-split'], siblings: [{ title: '旧任务', status: 'done' }] });
ok(pr.includes('整理笔记'), '含标题');
ok(pr.includes('D:/kb'), '含 cwd');
ok(pr.includes('codex, opencode'), '含可用 agent');
ok(pr.includes('旧任务'), '含同级任务');
ok(pr.includes('group/smart-split'), '含推荐模型');

const pr2 = buildPlannerPrompt({ title: 'x' }, {});
ok(!pr2.includes('可用 agent'), '没有 agent 时不留空标题');

console.log('\n' + '='.repeat(50));
if (fail === 0) console.log(`全部通过：${pass} 项`);
else { console.log(`失败 ${fail} / 共 ${pass + fail}`); for (const e of errors) console.log(`  - ${e}`); }
process.exitCode = fail === 0 ? 0 : 1;
