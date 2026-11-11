// 端到端：真实链路跑一遍。
//   建任务 → 拆解器(真 LLM 经 Magpie) → 调度器 → 真 codex 执行 → 结论回群
// 会消耗真实额度，单次一到两分钟。不要频繁跑。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { ensureTaskSchema, createTaskStore } from '../src/tasks.mjs';
import { createTaskRunner } from '../src/runner-task.mjs';
import { createScheduler } from '../src/scheduler.mjs';
import { createMagpie, findMagpieExe } from '../src/magpie.mjs';
import { createPlanner } from '../src/planner.mjs';
import { expandAgentArgs, loadConfig } from '../src/config.mjs';

const SANDBOX = path.resolve('examples/e2e-workspace');

const cfg = loadConfig();
const logsDir = path.join(os.tmpdir(), 'cabinet-e2e-logs');
fs.mkdirSync(logsDir, { recursive: true });

// 沙箱目录：让 codex 在这里干活，别碰真项目
fs.mkdirSync(SANDBOX, { recursive: true });

const cfg2 = {
  workers: 1,
  defaultTimeoutMs: 240_000,
  _meta: { baseDir: SANDBOX, logsDir },
  agents: {
    codex: {
      ...expandAgentArgs(cfg.agents).codex,
      defaultSandbox: 'workspace-write',
    },
  },
};

const db = openDb(':memory:');
ensureTaskSchema(db);
const tasks = createTaskStore(db);
const runner = createTaskRunner(cfg2);
const magpie = createMagpie({ gateway: cfg.magpie?.gateway, cliPath: findMagpieExe() });

const groups = {
  project: (t) => tasks.upsertGroup({ kind: 'project', scope_id: t.project_id ?? 'e2e', name: 'E2E 项目群' }),
  task: (t) => tasks.upsertGroup({ kind: 'task', scope_id: t.root_id ?? t.id, name: t.title }),
};

const sched = createScheduler({ tasks, runner, cfg: cfg2, magpie, groups });

console.log('=== 准备 ===');
const models = await magpie.listModels();
console.log('可用模型:', models ? models.models.length + models.groups.length : '取不到');
const planner = createPlanner({ magpie, model: 'group/smart-split', timeoutMs: 180_000 });
console.log('默认拆解模型:', magpie.pickDefaultModel());

const proj = tasks.upsertProject({ name: 'e2e', cwd: SANDBOX });

// 一个简单、可验证、只读的原子任务
const TITLE = '数一下这个目录里有多少个文件，把数量写进 answer.txt';
const taskId = tasks.insertTask({
  project_id: proj.id, cwd: SANDBOX, agent: 'codex', status: 'inbox',
  title: TITLE,
  body: '统计当前目录下（不含子目录）的文件个数，把数字写到 answer.txt 里。',
  source: 'cli',
});
tasks.logEvent({ task_id: taskId, actor: 'human', action: 'created', detail: 'e2e' });
console.log('任务:', taskId);

console.log('\n=== 拆解 ===');
const t0 = Date.now();
const planRes = await planner.plan(tasks.getTask(taskId), {
  project: proj,
  agents: Object.keys(cfg2.agents),
  models: models?.groups?.map((g) => g.id).slice(0, 5) ?? [],
});
console.log(`耗时 ${Date.now() - t0}ms | kind=${planRes.plan?.kind} 子任务=${planRes.plan?.tasks?.length} 需人审=${planRes.needsReview}`);
for (const [i, s] of (planRes.plan?.tasks ?? []).entries()) {
  console.log(`  [${i}] ${s.title} | effect=${s.effect}`);
  console.log(`      done_when=${String(s.done_when).slice(0, 70)}`);
}
if (!planRes.ok) {
  console.log('拆解失败:', planRes.error);
  process.exit(1);
}

// 落库：原子任务就用原始那条，plan 就建子任务
console.log('\n=== 落库 ===');
const plan = planRes.plan;
let execTasks = [];
if (plan.kind === 'atomic') {
  tasks.updateTask(taskId, {
    status: 'ready', agent: plan.tasks[0].agent ?? 'codex',
    done_when: plan.tasks[0].done_when, effect: plan.tasks[0].effect ?? 'read_only',
  });
  execTasks.push(taskId);
} else {
  tasks.updateTask(taskId, { status: 'done', ended_at: new Date().toISOString() });
  for (const [i, s] of plan.tasks.entries()) {
    const id = tasks.insertTask({
      project_id: proj.id, parent_id: taskId, root_id: taskId,
      title: s.title, body: s.body, cwd: SANDBOX,
      agent: s.agent ?? 'codex', model: s.model ?? null,
      done_when: s.done_when, effect: s.effect ?? 'read_only',
      status: 'ready', priority: 0,
    });
    execTasks.push(id);
  }
  for (const s of plan.tasks) {
    for (const d of s.deps ?? []) {
      if (execTasks[d] && execTasks[d] !== execTasks[plan.tasks.indexOf(s)]) {
        tasks.addDep(execTasks[plan.tasks.indexOf(s)], execTasks[d]);
      }
    }
  }
}
console.log('待执行任务:', execTasks.length);

console.log('\n=== 调度执行（真实 codex，可能要 1~2 分钟） ===');
const t1 = Date.now();
for (let round = 0; round < 6; round++) {
  const r = sched.tick();
  if (r.started === 0) {
    await new Promise((res) => setTimeout(res, 300));
    if (tasks.countRunning() === 0) {
      const stillReady = tasks.listReady().filter((t) => tasks.depsSatisfied(t.id).ok);
      if (stillReady.length === 0) break;
    }
    continue;
  }
  await sched.drain();
}
console.log(`总耗时 ${Math.round((Date.now() - t1) / 1000)}s`);

console.log('\n=== 结果 ===');
let allDone = true;
for (const id of execTasks) {
  const t = tasks.getTask(id);
  const run = tasks.latestRun(id);
  console.log(`\n${t.title}`);
  console.log(`  状态: ${t.status} | attempt=${t.attempt} | session=${t.session_id ?? '-'}`);
  if (run) {
    console.log(`  run: ${run.status} exit=${run.exit_code}`);
    console.log(`  结论: ${String(run.last_message ?? '').slice(0, 200)}`);
    if (run.error) console.log(`  错误: ${String(run.error).slice(0, 200)}`);
  }
  if (t.status !== 'done') allDone = false;
}

console.log('\n=== 群消息 ===');
const gid = groups.task(tasks.getTask(execTasks[0]));
for (const m of tasks.listMessages(gid)) {
  console.log(`  [${m.sender_kind}] ${String(m.body).replace(/\n/g, ' ').slice(0, 90)}`);
}

console.log('\n=== 产出 ===');
const answer = path.join(SANDBOX, 'answer.txt');
if (fs.existsSync(answer)) {
  console.log('answer.txt:', fs.readFileSync(answer, 'utf8').trim());
} else {
  console.log('answer.txt 不存在');
}

const tl = tasks.listTimeline(taskId);
console.log(`\n=== 时间线 (${tl.length} 条) ===`);
for (const e of tl.slice(0, 8)) console.log(`  ${e.action}: ${String(e.detail ?? '').slice(0, 70)}`);

console.log('\n' + '='.repeat(50));
console.log(allDone ? '端到端通过' : '端到端未全部完成');
process.exitCode = allDone ? 0 : 1;
