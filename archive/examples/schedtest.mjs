// 调度器端到端测试：用假 agent 跑通 ready → running → 终结态。
// 不联网、不花额度，每次改调度逻辑都该跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { ensureTaskSchema, createTaskStore } from '../src/tasks.mjs';
import { createTaskRunner } from '../src/runner-task.mjs';
import { createScheduler } from '../src/scheduler.mjs';

let pass = 0, fail = 0;
const errors = [];
function ok(c, l, d = '') {
  if (c) { pass++; console.log(`  OK ${l}`); }
  else { fail++; errors.push(l); console.log(`  FAIL ${l}${d ? ` -- ${d}` : ''}`); }
}
function eq(a, b, l) { ok(a === b, l, `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`); }

// 临时 logs 目录
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cab-sched-'));
const logsDir = path.join(tmpRoot, 'logs');
fs.mkdirSync(logsDir, { recursive: true });

const FAKE = path.resolve('examples/fake-agent-task.mjs');
const cfg = {
  workers: 2,
  defaultTimeoutMs: 30_000,
  _meta: { baseDir: process.cwd(), logsDir },
  agents: {
    fake: {
      command: process.execPath,
      args: [FAKE, 'exec', '--json', '-C', '{cwd}', '-s', '{sandbox}',
             '-m', '{model}', '-o', '{lastMessageFile}'],
      promptViaStdin: true,
    },
  },
};

const db = openDb(':memory:');
ensureTaskSchema(db);
const tasks = createTaskStore(db);
const runner = createTaskRunner(cfg);

// 群助手：项目群 / 任务群
const groups = {
  project(task) {
    return tasks.upsertGroup({
      kind: 'project', scope_id: task.project_id ?? 'noproj', name: '测试项目群',
    });
  },
  task(task) {
    return tasks.upsertGroup({ kind: 'task', scope_id: task.root_id ?? task.id, name: task.title });
  },
};

const sched = createScheduler({ tasks, runner, cfg, magpie: null, groups });

const proj = tasks.upsertProject({ name: '测试', cwd: tmpRoot });
function mkTask(o = {}) {
  return tasks.insertTask({
    project_id: proj.id, cwd: tmpRoot, agent: 'fake', status: 'ready',
    done_when: '输出里有「已处理」', ...o,
  });
}

console.log('\n=== 1. 单任务跑通 ===');
const t1 = mkTask({ title: '简单任务' });
sched.tick();
await sched.drain();
let row = tasks.getTask(t1);
eq(row.status, 'done', '任务完成');
const run1 = tasks.latestRun(t1);
eq(run1.status, 'done', 'run 状态 done');
ok(!!run1.last_message, '有结论');
ok(row.session_id, `session id 落库: ${row.session_id}`);
ok(fs.existsSync(run1.log_path), '日志文件存在');
ok(fs.existsSync(run1.transcript_path), 'transcript 存在');

console.log('\n=== 2. 依赖：前置没完成不跑 ===');
const a = mkTask({ title: 'A 前置' });
const b = mkTask({ title: 'B 依赖A' });
tasks.addDep(b, a);
sched.tick();
await sched.drain();
eq(tasks.getTask(a).status, 'done', 'A 完成');
eq(tasks.getTask(b).status, 'ready', 'B 还在 ready（依赖没满足时没被拉起）');
// 下一轮应该能跑 B
sched.tick();
await sched.drain();
eq(tasks.getTask(b).status, 'done', '第二轮 B 跑起来了');

console.log('\n=== 3. 需要决策 → review + 待办 ===');
const d1 = mkTask({ title: '要拍板的任务', body: '#DECIDE' });
sched.tick();
await sched.drain();
row = tasks.getTask(d1);
eq(row.status, 'review', '状态 review');
const todos = tasks.listTodos({ status: 'open' });
ok(todos.some((t) => t.task_id === d1 && t.kind === 'decision'),
  '生成了 decision 待办');

console.log('\n=== 4. 审批后 review → done ===');
sched.approve(d1, '删掉就行');
eq(tasks.getTask(d1).status, 'done', 'approve 后 done');
const runD = tasks.latestRun(d1);
eq(runD.needs_attention, 0, '待留意标记清掉');

console.log('\n=== 5. 驳回 ===');
const r1 = mkTask({ title: '会被驳回', body: '#DECIDE' });
sched.tick();
await sched.drain();
eq(tasks.getTask(r1).status, 'review', '停在 review');
sched.reject(r1, '不需要');
eq(tasks.getTask(r1).status, 'rejected', 'reject 后 rejected');
let threw = false;
try { sched.approve(r1, 'x'); } catch { threw = true; }
ok(threw, '已 rejected 的任务不能再 approve');

console.log('\n=== 6. 失败重试 ===');
const f1 = mkTask({ title: '重试到成功', body: '#FAIL2', max_attempts: 3 });
for (let i = 0; i < 4; i++) {
  sched.tick();
  await sched.drain();
}
row = tasks.getTask(f1);
eq(row.status, 'done', '两次失败后第三次成功');
eq(tasks.listRuns(f1).length, 3, '总共 3 次 run');
ok(tasks.listRuns(f1).some((r) => r.attempt === 1 && r.status === 'failed'),
  '第 1 次失败记录保留（不是覆盖）');

console.log('\n=== 7. 重试到上限 → failed + 待办 ===');
const f2 = mkTask({ title: '永远失败', body: '#FAIL', max_attempts: 2 });
for (let i = 0; i < 4; i++) {
  sched.tick();
  await sched.drain();
}
row = tasks.getTask(f2);
eq(row.status, 'failed', '到上限后 failed');
eq(tasks.listRuns(f2).length, 2, '只跑 max_attempts 次');
const failTodos = tasks.listTodos({ status: 'open' }).filter((t) => t.task_id === f2);
ok(failTodos.some((t) => t.kind === 'failed'), '生成了 failed 待办');

console.log('\n=== 8. 并发限制 ===');
const conc = [];
for (let i = 0; i < 5; i++) conc.push(mkTask({ title: `并发${i}` }));
const r = sched.tick();
ok(r.started <= cfg.workers, `一轮最多起 ${cfg.workers} 个，实际 ${r.started}`);
await sched.drain();

// 清掉这一组，避免后续测试被并发额度卡住
for (const id of conc) tasks.updateTask(id, { status: 'done' });
console.log('\n=== 9. 群消息 ===');
const gm = mkTask({ title: '带群消息的任务' });
// 先建群并投一条人发的消息
const gid = groups.task(tasks.getTask(gm));
tasks.addMessage({ group_id: gid, sender_kind: 'human', body: '顺便看看日志' });
sched.tick();
await sched.drain();
eq(tasks.getTask(gm).status, 'done', '任务完成');
const lastMsg = tasks.latestRun(gm).last_message;
const msgs = tasks.listMessages(gid);
ok(msgs.length >= 3, `群里有执行过程消息（${msgs.length} 条）`);
ok(msgs.some((m) => m.body.includes('开始执行')), '有「开始执行」');
ok(msgs.some((m) => m.body.includes('完成')), '有「完成」');

console.log('\n=== 10. 续轮用 resume ===');
const rr = mkTask({ title: '第二轮' });
sched.tick();
await sched.drain();
const firstSession = tasks.getTask(rr).session_id;
ok(!!firstSession, '首轮拿到 session id');

// 再投一条消息，重置成 ready 让它再跑一轮
const gid2 = groups.task(tasks.getTask(rr));
tasks.addMessage({ group_id: gid2, sender_kind: 'human', body: '再补一句' });
tasks.updateTask(rr, { status: 'ready' });
sched.tick();
await sched.drain();
const runs2 = tasks.listRuns(rr);
eq(runs2.length, 2, '两次 run');
const secondLog = fs.readFileSync(runs2[0].log_path, 'utf8');
ok(secondLog.includes('mode=resume'), '第二轮确实走了 resume');
ok(secondLog.includes(`resume(${firstSession})`), 'resume 用的是同一个 session id');
ok(secondLog.includes('再补一句'), '第二轮 prompt 带了新消息');

console.log('\n=== 10b. 前置结论传给下游 ===');
const up = mkTask({ title: '上游产出', body: '算出来是 42' });
const down = mkTask({ title: '下游消费', body: '把上游结果写进文件' });
tasks.addDep(down, up);
sched.tick();
await sched.drain();
eq(tasks.getTask(up).status, 'done', '上游完成');
sched.tick();
await sched.drain();
eq(tasks.getTask(down).status, 'done', '下游完成');
const downLog = fs.readFileSync(tasks.latestRun(down).log_path, 'utf8');
const promptSection = downLog.split('# --- output ---')[0];
ok(promptSection.includes('前置任务的结果'), '下游 prompt 里有「前置任务的结果」段');
ok(promptSection.includes('上游产出'), '带上了前置任务的标题');

console.log('\n=== 11. 顺序保证（同优先级按创建先后） ===');
const ord = [];
for (let i = 0; i < 3; i++) {
  ord.push(mkTask({ title: `顺序${i}`, priority: 0 }));
  await new Promise((r2) => setTimeout(r2, 2));
}
const readyList = tasks.listReady();
const idxs = ord.map((id) => readyList.findIndex((t) => t.id === id));
ok(idxs[0] < idxs[1] && idxs[1] < idxs[2], `同优先级按创建时间排序 ${JSON.stringify(idxs)}`);

console.log('\n=== 12. 中断标记 ===');
const intTask = mkTask({ title: '被中断的' });
tasks.updateTask(intTask, { status: 'running' });
const n = sched.markInterrupted('测试退出');
ok(n >= 1, `标记了 ${n} 个 running`);
eq(tasks.getTask(intTask).status, 'interrupted', '状态是 interrupted');

// 清理
try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
tasks.close();
db.close();

console.log('\n' + '='.repeat(50));
if (fail === 0) console.log(`全部通过：${pass} 项`);
else { console.log(`失败 ${fail} / 共 ${pass + fail}`); for (const e of errors) console.log(`  - ${e}`); }
process.exitCode = fail === 0 ? 0 : 1;
