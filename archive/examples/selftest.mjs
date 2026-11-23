// Cabinet 自测脚本：不依赖网络/额度，用 examples/fake-agent.mjs 把所有分支跑一遍。
// 用法: node examples/selftest.mjs
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import assert from 'node:assert';
import { loadConfig, prepareDirs } from '../src/config.mjs';
import { createStore, openDb } from '../src/db.mjs';
import { RuleStore, parseRules, matchEvent, findRule } from '../src/rules.mjs';
import { createQueue } from '../src/queue.mjs';
import { createRunner, buildCommand } from '../src/runner.mjs';
import { createNotifier, shouldNotify } from '../src/notify.mjs';
import { parseEvery, parseAt, createCronSource } from '../src/sources/cron.mjs';
import { createWatchSource } from '../src/sources/watch.mjs';
import { checkToken, validateEvent } from '../src/sources/http.mjs';
import { matchAnyGlob, globToRegExp } from '../src/util.mjs';

let pass = 0;
let fail = 0;
const failures = [];

function t(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      throw new Error('同步用例不要返回 promise（用 at 前缀）');
    }
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

async function ta(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

/* ============================== 1. 规则匹配 ============================== */
section('1. 规则匹配 (src/rules.mjs)');

t('catch-all（空 match）命中一切', () => {
  assert.ok(matchEvent({ match: {} }, { source: 'x', type: 'y' }));
  assert.ok(matchEvent({}, { source: 'x' }));
});

t('source/type/subject 必须全部匹配', () => {
  const rule = { match: { source: 'cron', type: 'schedule.daily', subject: 'brief' } };
  assert.ok(matchEvent(rule, { source: 'cron', type: 'schedule.daily', subject: 'brief' }));
  assert.ok(!matchEvent(rule, { source: 'cron', type: 'schedule.daily', subject: 'other' }));
  assert.ok(!matchEvent(rule, { source: 'http', type: 'schedule.daily', subject: 'brief' }));
  assert.ok(!matchEvent(rule, { source: 'cron', type: 'other', subject: 'brief' }));
});

t('"*" 表示任意值', () => {
  assert.ok(matchEvent({ match: { source: 'http', subject: '*' } }, { source: 'http', subject: 'whatever' }));
  assert.ok(matchEvent({ match: { subject: '*' } }, { source: 'x' }));
});

t('空数组 / undefined 表示不限制', () => {
  assert.ok(matchEvent({ match: { source: [], type: 'x' } }, { source: 'any', type: 'x' }));
  assert.ok(matchEvent({ match: { source: undefined, type: 'x' } }, { source: 'any', type: 'x' }));
});

t('subject 尾部 * 前缀匹配', () => {
  const rule = { match: { source: 'watch', subject: 'han_kl/*' } };
  assert.ok(matchEvent(rule, { source: 'watch', subject: 'han_kl/00_Inbox' }));
  assert.ok(matchEvent(rule, { source: 'watch', subject: 'han_kl/10_Projects' }));
  assert.ok(!matchEvent(rule, { source: 'watch', subject: 'other/00_Inbox' }));
});

t('数组值命中任一即可', () => {
  const rule = { match: { type: ['file.created', 'file.changed'] } };
  assert.ok(matchEvent(rule, { type: 'file.changed' }));
  assert.ok(!matchEvent(rule, { type: 'file.deleted' }));
});

t('findRule 从上往下第一条胜出', () => {
  const rules = [
    { id: 'a', match: { source: 'x' } },
    { id: 'b', match: {} },
  ];
  assert.strictEqual(findRule(rules, { source: 'x' }).id, 'a');
  assert.strictEqual(findRule(rules, { source: 'y' }).id, 'b');
  assert.strictEqual(findRule([], { source: 'y' }), null);
});

t('parseRules 支持注释与尾逗号', () => {
  const { rules, errors } = parseRules(`{
    // 这是注释
    "rules": [
      { "id": "a", "agent": "codex", "prompt": "x", "match": {} }, /* 行尾注释 */
    ]
  }`);
  assert.strictEqual(rules.length, 1);
  assert.strictEqual(errors.length, 0);
});

t('parseRules 校验出缺字段', () => {
  const { errors } = parseRules(`{"rules":[{"id":"a"}]}`);
  assert.ok(errors.length >= 2, '应该报缺 agent / prompt');
});

t('RuleStore 坏文件保留旧规则', () => {
  const tmp = path.join(os.tmpdir(), `ah-rules-${process.pid}.json`);
  fs.writeFileSync(tmp, '{"rules":[{"id":"good","agent":"x","prompt":"p","match":{}}]}');
  const rs = new RuleStore(tmp);
  rs.load();
  assert.strictEqual(rs.get().length, 1);
  fs.writeFileSync(tmp, '{ broken json ,,,');
  rs.load();
  assert.strictEqual(rs.get().length, 1, '坏文件不应清空规则');
  assert.ok(rs.error, '应该记录错误');
  fs.rmSync(tmp, { force: true });
});

/* ============================== 2. 命令拼装 ============================== */
section('2. 命令拼装 (src/runner.mjs buildCommand)');

const codexAgent = {
  command: 'node',
  args: ['codex.js', 'exec', '--json', '-C', '{cwd}', '-s', '{sandbox}', '-m', '{model}', '-o', '{lastMessageFile}'],
  promptViaStdin: true,
};
const baseJob = {
  agent: 'codex',
  cwd: 'D:/work',
  sandbox: 'read-only',
  model: null,
  prompt: 'do it',
  last_message_file: 'C:/tmp/last.txt',
};

t('model=null 时 -m 和它的值整对剔除', () => {
  const b = buildCommand(codexAgent, baseJob);
  assert.ok(!b.args.includes('-m'), '-m 应被剔除');
  assert.ok(!b.args.includes('null'), '不能留下字面 null');
  assert.deepStrictEqual(b.args, ['codex.js', 'exec', '--json', '-C', 'D:/work', '-s', 'read-only', '-o', 'C:/tmp/last.txt']);
});

t('model 有值时正常保留', () => {
  const b = buildCommand(codexAgent, { ...baseJob, model: 'gpt-5' });
  const i = b.args.indexOf('-m');
  assert.ok(i > 0);
  assert.strictEqual(b.args[i + 1], 'gpt-5');
});

t('sandbox=null 同样整对剔除', () => {
  const b = buildCommand(codexAgent, { ...baseJob, sandbox: null });
  assert.ok(!b.args.includes('-s'));
  assert.ok(!b.args.includes('-m'));
});

t('占位符不会残留花括号', () => {
  const b = buildCommand(codexAgent, { ...baseJob, model: 'x' });
  for (const a of b.args) assert.ok(!/\{[A-Za-z0-9_]+\}/.test(a), `残留占位符: ${a}`);
});

t('--flag={model} 内联形式且 model 为 null → 整条剔除', () => {
  const b = buildCommand({ command: 'node', args: ['exec', '--model={model}', '--cd={cwd}'] }, baseJob);
  assert.deepStrictEqual(b.args, ['exec', '--cd=D:/work']);
});

t('promptViaStdin=false → prompt 作为位置参数', () => {
  const b = buildCommand({ command: 'opencode', args: ['run', '{prompt}'], promptViaStdin: false }, baseJob);
  assert.deepStrictEqual(b.args, ['run', 'do it']);
  assert.strictEqual(b.promptViaStdin, false);
});

t('promptViaStdin 默认 true，prompt 不进 args', () => {
  const b = buildCommand({ command: 'codex', args: ['exec'], prompt: undefined }, baseJob);
  assert.strictEqual(b.promptViaStdin, true);
  assert.deepStrictEqual(b.args, ['exec']);
});

/* ============================== 3. util ============================== */
section('3. 工具函数 (src/util.mjs)');

t('glob 前缀通配', () => {
  assert.ok(matchAnyGlob('a/b/c.md', ['a/**']));
  assert.ok(!matchAnyGlob('x/b/c.md', ['a/**']));
});

t('ignore 能挡住目录本身', () => {
  assert.ok(matchAnyGlob('.git/config', ['**/.git/**']), '**/.git/** 应挡住 .git 下的文件');
  assert.ok(matchAnyGlob('.git', ['**/.git/**']), '**/.git/** 应挡住 .git 目录本身');
  assert.ok(matchAnyGlob('a/.git/hooks/x', ['**/.git/**']));
});

t('**/README.md 挡住任意层级的 README', () => {
  assert.ok(matchAnyGlob('README.md', ['**/README.md']));
  assert.ok(matchAnyGlob('a/b/README.md', ['**/README.md']));
  assert.ok(!matchAnyGlob('a/b/README.txt', ['**/README.md']));
});

/* ============================== 4. cron ============================== */
section('4. 定时源 (src/sources/cron.mjs)');

t('parseEvery 各种单位', () => {
  assert.strictEqual(parseEvery('15m'), 900000);
  assert.strictEqual(parseEvery('30s'), 30000);
  assert.strictEqual(parseEvery('2h'), 7200000);
  assert.strictEqual(parseEvery('1d'), 86400000);
  assert.strictEqual(parseEvery(5), 300000);
});

t('parseAt 校验格式与越界', () => {
  assert.deepStrictEqual(parseAt('08:30'), { hour: 8, minute: 30 });
  assert.throws(() => parseAt('25:00'));
  assert.throws(() => parseAt('8点半'));
});

t('同一分钟内只触发一次（防重复）', () => {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const events = [];
  const src = createCronSource(
    { sources: { cron: [{ id: 'x', type: 't', at: `${hh}:${mm}` }] } },
    (ev) => events.push(ev),
  );
  src._check();
  src._check();
  src._check();
  assert.strictEqual(events.length, 1, `同一分钟应只发一次，实际 ${events.length}`);
  assert.strictEqual(events[0].source, 'cron');
});

t('every 间隔：启动后一个周期才触发，不补跑', () => {
  const events = [];
  const src = createCronSource({ sources: { cron: [{ id: 'e', type: 't', every: '15m' }] } }, (ev) => events.push(ev));
  src._check();
  assert.strictEqual(events.length, 0, '启动时不该立刻触发');
  // 手动把 nextAt 拨到过去，模拟到期
  src._defs[0].nextAt = Date.now() - 1000;
  src._check();
  assert.strictEqual(events.length, 1);
  assert.strictEqual(src._defs[0].nextAt > Date.now(), true, '触发后应推进 nextAt');
});

/* ============================== 5. HTTP 校验 ============================== */
section('5. HTTP 源 (src/sources/http.mjs)');

t('没配 token 时放行', () => {
  assert.ok(checkToken({}, { headers: {} }));
});

t('配了 token 必须带对的 Bearer', () => {
  const cfg = { httpToken: 'secret' };
  assert.ok(checkToken(cfg, { headers: { authorization: 'Bearer secret' } }));
  assert.ok(!checkToken(cfg, { headers: { authorization: 'Bearer wrong' } }));
  assert.ok(!checkToken(cfg, { headers: {} }));
  assert.ok(!checkToken(cfg, { headers: { authorization: 'secret' } }));
});

t('事件必填字段校验', () => {
  assert.strictEqual(validateEvent({ source: 'a', type: 'b' }), null);
  assert.ok(validateEvent({ type: 'b' }));
  assert.ok(validateEvent({ source: 'a' }));
  assert.ok(validateEvent(null));
  assert.ok(validateEvent({ source: 'a', type: 'b', payload: 'not-object' }));
});

/* ============================== 6. 通知 ============================== */
section('6. 通知 (src/notify.mjs)');

t('notifyWhen 精确命中', () => {
  assert.ok(shouldNotify(['failed', 'done'], 'failed'));
  assert.ok(!shouldNotify(['done'], 'failed'));
  assert.ok(!shouldNotify([], 'done'));
  assert.ok(shouldNotify(['*'], 'anything'));
  // 从 db 里读出来是 JSON 字符串
  assert.ok(shouldNotify('["failed"]', 'failed'));
});

/* ============================== 7. 端到端状态机 ============================== */
section('7. 端到端状态机（假 agent，真进程）');

const CFG_PATH = path.resolve(import.meta.dirname, 'cabinet.test.config.json');
const cfg = loadConfig(CFG_PATH);
prepareDirs(cfg);
// 每轮用干净的库，避免互相干扰
const dbFile = cfg._meta.dbPath;
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });

function mkRuntime() {
  const store = createStore(openDb(cfg._meta.dbPath));
  const ruleStore = new RuleStore(cfg._meta.rulesPath);
  ruleStore.load();
  const runner = createRunner(cfg, store);
  const notifier = createNotifier(cfg);
  const queue = createQueue({ cfg, store, ruleStore, runner, notifier });
  return { store, ruleStore, runner, notifier, queue };
}

const rt = mkRuntime();

await ta('approval=before → 停在 awaiting_approval，不执行', async () => {
  const r = rt.queue.ingest({ source: 'test', type: 'before', subject: 'b1', summary: '事前审批' });
  assert.strictEqual(r.action, 'awaiting_approval');
  const job = rt.store.getJob(r.jobId);
  assert.strictEqual(job.status, 'awaiting_approval');
  assert.strictEqual(job.needs_attention, 1);
  // tick 不应拉起它
  rt.queue.tick();
  assert.strictEqual(rt.store.getJob(r.jobId).status, 'awaiting_approval');
});

await ta('approve 后能真的跑完 → done', async () => {
  const r = rt.queue.ingest({ source: 'test', type: 'before', subject: 'b2', summary: '批了要能跑完' });
  rt.queue.approve(r.jobId, '测试');
  assert.strictEqual(rt.store.getJob(r.jobId).status, 'queued');
  await rt.queue.runUntilIdle();
  const job = rt.store.getJob(r.jobId);
  assert.strictEqual(job.status, 'done', `期望 done，实际 ${job.status}: ${job.error ?? ''}`);
  assert.strictEqual(job.exit_code, 0);
  assert.match(job.last_message, /收到/, '结论里应该有「收到」');
  assert.ok(fs.existsSync(job.log_path), '日志文件应存在');
  assert.ok(fs.existsSync(job.transcript_path), 'JSONL transcript 应存在');
});

await ta('reject 后 → rejected，不执行', async () => {
  const r = rt.queue.ingest({ source: 'test', type: 'before', subject: 'b3', summary: '要拒绝' });
  rt.queue.reject(r.jobId, '不需要');
  const job = rt.store.getJob(r.jobId);
  assert.strictEqual(job.status, 'rejected');
  assert.strictEqual(job.decision, 'rejected');
  assert.strictEqual(job.decision_note, '不需要');
});

await ta('approval=never → 直接 queued 并跑完 done', async () => {
  const r = rt.queue.ingest({ source: 'test', type: 'never', subject: 'n1', summary: '不用批' });
  assert.strictEqual(r.action, 'queued');
  await rt.queue.runUntilIdle();
  assert.strictEqual(rt.store.getJob(r.jobId).status, 'done');
});

await ta('agent 说「需要决策：」+ approval=review → review', async () => {
  const r = rt.queue.ingest({ source: 'test', type: 'review', subject: 'r1', summary: '#DECIDE 需要决策' });
  await rt.queue.runUntilIdle();
  const job = rt.store.getJob(r.jobId);
  assert.strictEqual(job.status, 'review', `期望 review，实际 ${job.status}`);
  assert.strictEqual(job.needs_attention, 1);
  assert.match(job.last_message, /需要决策：/);
});

await ta('review 状态 approve → accepted', async () => {
  const r = rt.queue.ingest({ source: 'test', type: 'review', subject: 'r2', summary: '#DECIDE 决策一下' });
  await rt.queue.runUntilIdle();
  assert.strictEqual(rt.store.getJob(r.jobId).status, 'review');
  rt.queue.approve(r.jobId, '选 A');
  const job = rt.store.getJob(r.jobId);
  assert.strictEqual(job.status, 'accepted');
  assert.strictEqual(job.needs_attention, 0);
});

await ta('approval=after → 无论结论都停 review', async () => {
  const r = rt.queue.ingest({ source: 'test', type: 'after', subject: 'a1', summary: '干完等确认' });
  await rt.queue.runUntilIdle();
  assert.strictEqual(rt.store.getJob(r.jobId).status, 'review');
});

await ta('退出码非 0 → failed，needs_attention=1', async () => {
  const r = rt.queue.ingest({ source: 'test', type: 'fail', subject: 'f1', summary: '故意失败' });
  await rt.queue.runUntilIdle();
  const job = rt.store.getJob(r.jobId);
  assert.strictEqual(job.status, 'failed');
  assert.strictEqual(job.exit_code, 3);
  assert.strictEqual(job.needs_attention, 1);
  assert.match(job.error, /退出码 3/);
});

await ta('超时 → 被 kill 并标 failed', async () => {
  const r = rt.queue.ingest({ source: 'test', type: 'slow', subject: 's1', summary: '睡很久' });
  await rt.queue.runUntilIdle();
  const job = rt.store.getJob(r.jobId);
  assert.strictEqual(job.status, 'failed', `期望 failed，实际 ${job.status}`);
  assert.match(job.error, /超时/, `错误信息应提到超时: ${job.error}`);
});

await ta('去重：同 subject 未终结时合并，duplicate_count 递增', async () => {
  // before 规则的 job 会停在 awaiting_approval（未终结），正好用来测去重
  const a = rt.queue.ingest({ source: 'test', type: 'before', subject: 'dedupe-x', summary: '第一次' });
  assert.strictEqual(a.action, 'awaiting_approval');
  const b = rt.queue.ingest({ source: 'test', type: 'before', subject: 'dedupe-x', summary: '第二次' });
  assert.strictEqual(b.action, 'duplicate');
  assert.strictEqual(b.jobId, a.jobId, '应合并到同一个 job');
  const c = rt.queue.ingest({ source: 'test', type: 'before', subject: 'dedupe-x', summary: '第三次' });
  assert.strictEqual(c.action, 'duplicate');
  const job = rt.store.getJob(a.jobId);
  assert.strictEqual(job.duplicate_count, 2, `期望 2，实际 ${job.duplicate_count}`);
  // 事件也要留底
  const evs = rt.store.listEvents(50).filter((e) => e.job_id === a.jobId);
  assert.strictEqual(evs.length, 3, '三个事件都应落库');
});

await ta('去重：job 终结后同一 dedupe_key 可以再建新 job', async () => {
  const a = rt.queue.ingest({ source: 'test', type: 'never', subject: 'dedupe-y', summary: '第一次' });
  await rt.queue.runUntilIdle();
  assert.strictEqual(rt.store.getJob(a.jobId).status, 'done');
  const b = rt.queue.ingest({ source: 'test', type: 'never', subject: 'dedupe-y', summary: '第二次' });
  assert.strictEqual(b.action, 'queued', '终结后应能重新入队');
  assert.notStrictEqual(b.jobId, a.jobId);
});

await ta('并发限制：同 key max=1 时不会同时跑两个', async () => {
  const ids = [];
  for (let i = 0; i < 3; i++) {
    ids.push(rt.queue.ingest({ source: 'test', type: 'conc', subject: `conc-${i}`, summary: `并发 ${i}` }).jobId);
  }
  // tick 一次：最多拉起 1 个（max=1）
  rt.queue.tick();
  const runningNow = ids.filter((id) => rt.store.getJob(id).status === 'running').length;
  assert.ok(runningNow <= 1, `应最多 1 个 running，实际 ${runningNow}`);
  await rt.queue.runUntilIdle();
  for (const id of ids) assert.strictEqual(rt.store.getJob(id).status, 'done');
});

await ta('无规则命中 → no_rule，不建 job', async () => {
  const store2 = createStore(openDb(cfg._meta.dbPath));
  const ruleStore2 = new RuleStore(cfg._meta.rulesPath);
  ruleStore2.load();
  // 临时清空规则，模拟没有 catch-all
  ruleStore2.rules = ruleStore2.get().filter((r) => r.id !== 'fake-all');
  const q2 = createQueue({ cfg, store: store2, ruleStore: ruleStore2, runner: rt.runner, notifier: rt.notifier });
  const before = store2.stats().total;
  const r = q2.ingest({ source: 'nobody', type: 'nothing', subject: 'z' });
  assert.strictEqual(r.action, 'no_rule');
  assert.strictEqual(store2.stats().total, before, '不该建 job');
  const ev = store2.getEvent(r.eventId);
  assert.strictEqual(ev.status, 'no_rule');
  store2.close();
});

await ta('JSONL 兜底：没有 -o 文件时从 transcript 提取结论', async () => {
  const r = rt.queue.ingest({ source: 'test', type: 'never', subject: 'jsonl-only', summary: '#JSONL 只走 stdout' });
  await rt.queue.runUntilIdle();
  const job = rt.store.getJob(r.jobId);
  assert.strictEqual(job.status, 'done');
  assert.ok(job.last_message, '应从 JSONL 提取到结论');
  assert.match(job.last_message, /收到/);
});

await ta('stats 能统计各状态与按规则耗时', async () => {
  const s = rt.store.stats();
  assert.ok(s.total > 0);
  assert.ok(s.byStatus.done > 0);
  assert.ok(s.byStatus.failed > 0);
  assert.ok(Array.isArray(s.byRule) && s.byRule.length > 0);
  const doneRule = s.byRule.find((r) => r.rule_id === 'fake-never');
  assert.ok(doneRule, '应有 fake-never 的统计');
  assert.ok(doneRule.avgMs == null || doneRule.avgMs >= 0);
});

await ta('markRunningInterrupted 只清 running', async () => {
  const a = rt.queue.ingest({ source: 'test', type: 'before', subject: 'int-1', summary: 'x' });
  rt.queue.approve(a.jobId);
  rt.queue.tick();
  // 手动把它标 running（上面 tick 可能已跑完，直接改状态更稳）
  rt.store.updateJob(a.jobId, { status: 'running' });
  const n = rt.store.markRunningInterrupted('测试中断');
  assert.ok(n >= 1);
  const job = rt.store.getJob(a.jobId);
  assert.strictEqual(job.status, 'interrupted');
  assert.match(job.error, /测试中断/);
});

// 有的用例用 tick() 起了子进程，关库前先等它们落地
rt.runner.killAll();
await rt.queue.drain();
rt.store.close();
for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });

/* ============================== 汇总 ============================== */
console.log(`\n${'='.repeat(52)}`);
if (fail === 0) {
  console.log(`全部通过：${pass} 项`);
} else {
  console.log(`${pass} 通过，${fail} 失败\n`);
  for (const f of failures) {
    console.log(`✗ ${f.name}`);
    console.log(`  ${f.err.stack?.split('\n').slice(0, 4).join('\n  ') ?? f.err.message}`);
  }
}
process.exitCode = fail === 0 ? 0 : 1;
